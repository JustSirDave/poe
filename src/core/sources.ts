/**
 * Single source of truth for the identity of each observed assistant: which exact harness
 * strings the parsers emit for it, its display label, dashboard styling, sort order, and token
 * counter scope. Previously this mapping was re-derived independently (with slightly different,
 * loosely-matching logic) in dashboard.ts, analysis-dataset.ts, and elsewhere; adding a source
 * meant hand-editing several string-keyed maps in sync. Add a new source here once instead.
 */
export type SourceKind = 'claude' | 'codex' | 'vscode' | 'copilot';
export type CounterScope = 'turn-delta' | 'turn-aggregate' | 'last-agentic-round' | 'session-total' | 'unavailable' | 'unknown';
interface HarnessIdentity { name: string; label: string }
export interface SourceDescriptor {
  kind: SourceKind;
  cssClass: string;
  mark: string;
  sortRank: number;
  /** Exact harness strings a parser for this source can emit (a source may emit more than one). */
  harnesses: HarnessIdentity[];
  counterScope: { inputScope: CounterScope; outputScope: CounterScope };
}

export const SOURCE_REGISTRY: readonly SourceDescriptor[] = [
  { kind: 'claude', cssClass: 'claude', mark: 'C', sortRank: 1, harnesses: [{ name: 'Claude', label: 'Claude Code' }], counterScope: { inputScope: 'turn-aggregate', outputScope: 'turn-aggregate' } },
  { kind: 'codex', cssClass: 'codex', mark: 'Cdx', sortRank: 2, harnesses: [{ name: 'Codex', label: 'Codex' }], counterScope: { inputScope: 'turn-delta', outputScope: 'turn-delta' } },
  { kind: 'vscode', cssClass: 'vscode', mark: 'VS', sortRank: 3, harnesses: [{ name: 'VS Code Copilot', label: 'VS Code Copilot' }], counterScope: { inputScope: 'last-agentic-round', outputScope: 'turn-aggregate' } },
  { kind: 'copilot', cssClass: 'copilot', mark: 'GH', sortRank: 4, harnesses: [{ name: 'GitHub Copilot CLI', label: 'GitHub Copilot CLI' }, { name: 'GitHub Copilot App', label: 'GitHub Copilot App' }], counterScope: { inputScope: 'unavailable', outputScope: 'turn-aggregate' } },
];

function sourceForHarness(harness: string): SourceDescriptor | undefined {
  return SOURCE_REGISTRY.find(source => source.harnesses.some(h => h.name === harness));
}
/** Display label for an exact harness string, e.g. 'Claude' -> 'Claude Code'. Unknown harnesses pass through unchanged. */
export function harnessLabel(harness: string): string {
  for (const source of SOURCE_REGISTRY) { const match = source.harnesses.find(h => h.name === harness); if (match) return match.label; }
  return harness;
}
export function harnessClass(harness: string): string { return sourceForHarness(harness)?.cssClass ?? 'copilot'; }
export function harnessMark(harness: string): string { return sourceForHarness(harness)?.mark ?? 'GH'; }
/** Lower sorts first; an unrecognized harness sorts last. */
export function harnessSortRank(harness: string): number { return sourceForHarness(harness)?.sortRank ?? 99; }
export function harnessCounterScope(harness: string): { inputScope: CounterScope; outputScope: CounterScope } {
  return sourceForHarness(harness)?.counterScope ?? { inputScope: 'unknown', outputScope: 'unknown' };
}
/** Display label for a configured source kind (e.g. connected-sources list), not a specific harness string. */
export function sourceLabel(kind: string): string {
  return SOURCE_REGISTRY.find(source => source.kind === kind)?.harnesses[0]?.label ?? kind;
}
/** Every exact harness string a configured source kind's parsers can emit. */
export function sourceHarnessNames(kind: string): string[] {
  return SOURCE_REGISTRY.find(source => source.kind === kind)?.harnesses.map(h => h.name) ?? [];
}
