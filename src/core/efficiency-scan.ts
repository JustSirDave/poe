import * as fs from 'node:fs';
import * as path from 'node:path';
import { analyzeEfficiency, type CoachReport } from '../standalone/analysis';
import { coachConfigSchema, type CoachConfig } from '../standalone/config';
import { createClaudeAccumulator } from './parser-claude';
import { createCodexAccumulator } from './parser-codex';
import { parseCLIEventsFile } from './parser-vscode-cli';
import { parseSessionFile } from './parser-vscode';
import { parseCLIWorkspaceName, parseWorkspaceName } from './parser-vscode-files';
import { assertTrustedPath } from './parser-shared';
import { observeTools } from './tool-activity';
import { IncrementalLog } from './incremental-log';
import type { Session } from './types';

type SourceKind = keyof CoachConfig['sources'];
interface FileEntry { file: string; root: string; source: SourceKind; parser: 'session-log' | 'vscode-chat' | 'copilot-events'; workspaceId?: string; workspaceName?: string; fingerprint: string; modified: number; size: number }
const cache = new Map<string, { fingerprint: string; session: Session | null; reader?: IncrementalLog }>();

function inside(file: string, root: string): boolean {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function discover(config: CoachConfig): { files: FileEntry[]; sources: CoachReport['sources']; warnings: string[] } {
  const files: FileEntry[] = [];
  const sources: CoachReport['sources'] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const source of ['claude', 'codex', 'vscode', 'copilot'] as const) {
    if (!config.sources[source].enabled) continue;
    for (const configured of config.sources[source].roots) {
      let root: string;
      try { root = fs.realpathSync(configured); if (!fs.statSync(root).isDirectory()) throw new Error('Not a directory'); }
      catch { sources.push({ harness: source, root: configured, exists: false }); continue; }
      sources.push({ harness: source, root, exists: true });
      const pending = [root];
      let visited = 0;
      while (pending.length && visited < 50000) {
        const dir = pending.pop()!;
        visited++;
        try {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            // Never follow links out of a configured log source.
            if (entry.isSymbolicLink()) continue;
            const file = path.join(dir, entry.name);
            if (entry.isDirectory()) { pending.push(file); continue; }
            if (!entry.isFile() || seen.has(file)) continue;
            const relative = path.relative(root, file).split(path.sep);
            let parser: FileEntry['parser']; let workspaceId: string | undefined; let workspaceName: string | undefined;
            if (source === 'vscode') {
              if (!['.json', '.jsonl'].includes(path.extname(entry.name)) || relative[1] !== 'chatSessions') continue;
              parser = 'vscode-chat'; workspaceId = relative[0]; workspaceName = parseWorkspaceName(path.join(root, workspaceId, 'workspace.json'));
            } else if (source === 'copilot') {
              if (entry.name !== 'events.jsonl') continue;
              parser = 'copilot-events'; workspaceId = path.basename(path.dirname(file)); workspaceName = parseCLIWorkspaceName(path.join(path.dirname(file), 'workspace.yaml'));
            } else {
              if (!entry.name.endsWith('.jsonl')) continue;
              parser = 'session-log';
            }
            const stat = fs.statSync(file);
            seen.add(file);
            files.push({ file, root, source, parser, workspaceId, workspaceName, fingerprint: `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`, modified: stat.mtimeMs, size: stat.size });
          }
        } catch { if (warnings.length < 20) warnings.push(`Could not completely scan ${dir}`); }
      }
      if (pending.length) warnings.push('Directory scan limit reached; narrow your source roots.');
    }
  }
  files.sort((a, b) => b.modified - a.modified || a.file.localeCompare(b.file));
  return { files, sources, warnings };
}

export function scanEfficiency(input: unknown): CoachReport {
  const config = coachConfigSchema.parse(input);
  const { files, sources, warnings } = discover(config);
  const selected = files.slice(0, config.maxFiles);
  const retained = new Set(selected.map(entry => entry.file));
  for (const key of cache.keys()) if (!retained.has(key)) cache.delete(key);
  const sessions: Session[] = [];
  const sessionKeys = new Set<string>();
  let parsed = 0; let reused = 0; let incremental = 0; let bytesRead = 0; let skipped = files.length - selected.length;
  for (const entry of selected) {
    if (entry.size > config.maxFileMB * 1024 * 1024) { skipped++; cache.delete(entry.file); continue; }
    let item = cache.get(entry.file);
    if (item?.fingerprint === entry.fingerprint) reused++;
    else {
      try {
        // A cursor retains parser state; only new records enter the parser on normal appends.
        assertTrustedPath(entry.file, [entry.root]);
        if (entry.parser === 'session-log') {
          const harness = entry.source === 'codex' ? 'codex' : 'claude';
          const reader = item?.reader || new IncrementalLog(() => observeTools(harness === 'codex'
            ? createCodexAccumulator(entry.file)
            : createClaudeAccumulator(entry.file, path.dirname(entry.file), path.basename(path.dirname(entry.file))), harness, config.includeExcerpts));
          const result = reader.read(entry.file);
          bytesRead += result.bytesRead;
          if (result.incremental) incremental++;
          item = { fingerprint: entry.fingerprint, session: result.session, reader };
        } else {
          const session = entry.parser === 'vscode-chat'
            ? parseSessionFile(entry.file, entry.workspaceId!, entry.workspaceName || entry.workspaceId!, 'VS Code Copilot')
            : parseCLIEventsFile(entry.file, entry.workspaceId!, entry.workspaceName || entry.workspaceId!);
          bytesRead += entry.size;
          item = { fingerprint: entry.fingerprint, session };
        }
        cache.set(entry.file, item); parsed++;
      } catch { cache.delete(entry.file); skipped++; if (warnings.length < 20) warnings.push(`Could not parse ${entry.file}`); continue; }
    }
    if (!item.session) { skipped++; continue; }
    const session = item.session;
    if (config.workspaceRoots.length && (!session.workspaceRootPath || !config.workspaceRoots.some(root => inside(path.resolve(session.workspaceRootPath!), root)))) continue;
    const key = `${session.harness}:${session.sessionId}`;
    if (sessionKeys.has(key)) continue;
    sessionKeys.add(key); sessions.push(session);
  }
  const report = analyzeEfficiency(sessions, config);
  report.sources = sources;
  report.scan = { files: files.length, parsed, reused, skipped, warnings, incremental, bytesRead };
  return report;
}
