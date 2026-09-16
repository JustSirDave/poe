import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';

const source = z.object({ enabled: z.boolean().default(true), roots: z.array(z.string().min(1)).default([]) }).strict();
const defaultSources = {
  claude: { enabled: true, roots: [] as string[] },
  codex: { enabled: true, roots: [] as string[] },
  vscode: { enabled: true, roots: [] as string[] },
  copilot: { enabled: true, roots: [] as string[] },
};
export const coachConfigSchema = z.object({
  sources: z.object({
    claude: source.default(defaultSources.claude), codex: source.default(defaultSources.codex),
    vscode: source.default(defaultSources.vscode), copilot: source.default(defaultSources.copilot),
  }).strict().default(defaultSources),
  workspaceRoots: z.array(z.string().min(1)).default([]),
  lookbackDays: z.number().int().min(1).max(365).default(5),
  refreshSeconds: z.number().int().min(15).max(3600).default(30),
  maxFiles: z.number().int().min(1).max(20000).default(2000),
  maxFileMB: z.number().min(1).max(50).default(20),
  includeExcerpts: z.boolean().default(false),
  minOccurrences: z.number().int().min(3).max(100).default(3),
  largeResponseChars: z.number().int().min(2000).max(100000).default(12000),
  port: z.number().int().min(0).max(65535).default(4317),
  stateDir: z.string().min(1).default(path.join(os.homedir(), '.poe', 'standalone')),
}).strict();
export type CoachConfig = z.infer<typeof coachConfigSchema>;

export function resolveConfig(input: unknown, baseDir: string): CoachConfig {
  const config = coachConfigSchema.parse(input);
  const resolve = (value: string) => path.resolve(baseDir, value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value);
  const defaults = {
    claude: [path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects')],
    codex: ['sessions', 'archived_sessions', 'archived-sessions'].map(name => path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), name)),
    vscode: process.platform === 'win32'
      ? ['Code', 'Code - Insiders'].map(name => path.join(process.env.APPDATA || '', name, 'User', 'workspaceStorage'))
      : process.platform === 'darwin'
        ? ['Code', 'Code - Insiders'].map(name => path.join(os.homedir(), 'Library', 'Application Support', name, 'User', 'workspaceStorage'))
        : ['Code', 'Code - Insiders'].map(name => path.join(os.homedir(), '.config', name, 'User', 'workspaceStorage')),
    copilot: ['session-state', 'history-session-state'].map(name => path.join(os.homedir(), '.copilot', name)),
  };
  for (const key of ['claude', 'codex', 'vscode', 'copilot'] as const) {
    config.sources[key].roots = (config.sources[key].roots.length ? config.sources[key].roots : defaults[key]).map(resolve);
  }
  config.workspaceRoots = config.workspaceRoots.map(resolve);
  config.stateDir = resolve(config.stateDir);
  return config;
}
