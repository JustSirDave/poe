import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';

const source = z.object({ enabled: z.boolean().default(true), roots: z.array(z.string().min(1)).default([]) }).strict();
export const coachConfigSchema = z.object({
  sources: z.object({ claude: source.default({ enabled: true, roots: [] }), codex: source.default({ enabled: true, roots: [] }) }).strict().default({ claude: { enabled: true, roots: [] }, codex: { enabled: true, roots: [] } }),
  workspaceRoots: z.array(z.string().min(1)).default([]),
  lookbackDays: z.number().int().min(1).max(365).default(30),
  refreshSeconds: z.number().int().min(15).max(3600).default(120),
  maxFiles: z.number().int().min(1).max(20000).default(2000),
  maxFileMB: z.number().min(1).max(50).default(20),
  includeExcerpts: z.boolean().default(false),
  minOccurrences: z.number().int().min(3).max(100).default(3),
  largeResponseChars: z.number().int().min(2000).max(100000).default(12000),
  port: z.number().int().min(0).max(65535).default(4317),
  stateDir: z.string().min(1).default(path.join(os.homedir(), '.ai-engineer-coach', 'standalone')),
}).strict();
export type CoachConfig = z.infer<typeof coachConfigSchema>;

export function resolveConfig(input: unknown, baseDir: string): CoachConfig {
  const config = coachConfigSchema.parse(input);
  const resolve = (value: string) => path.resolve(baseDir, value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value);
  const defaults = {
    claude: [path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects')],
    codex: ['sessions', 'archived_sessions', 'archived-sessions'].map(name => path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), name)),
  };
  for (const key of ['claude', 'codex'] as const) {
    config.sources[key].roots = (config.sources[key].roots.length ? config.sources[key].roots : defaults[key]).map(resolve);
  }
  config.workspaceRoots = config.workspaceRoots.map(resolve);
  config.stateDir = resolve(config.stateDir);
  return config;
}
