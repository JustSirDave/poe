// cspell:ignore describedby
import { harnessClass, harnessLabel, harnessMark, harnessSortRank, sourceHarnessNames, sourceLabel } from '../core/sources';
import type { CoachReport, Finding } from './analysis';
import type { ReviewEvent } from './reviews';
import { IDEA_COPY, projectName, reviewPrompt } from './presentation';
interface Snapshot { report?: CoachReport; error?: string; history: ReviewEvent[]; config: { lookbackDays: number; refreshSeconds: number; includeExcerpts: boolean } }
const ICONS: Record<string, string[]> = {
  overview: ['M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z'],
  usage: ['M4 19V9m5 10V5m5 14v-7m5 7V3'],
  spark: ['m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z'],
  skill: ['M4 5h6a3 3 0 0 1 3 3v13a4 4 0 0 0-4-3H4V5Zm9 3a3 3 0 0 1 3-3h5v13h-4a4 4 0 0 0-4 3'],
  memory: ['M8 3H5v18h14V6l-3-3H8Zm0 0v6h8V3M8 21v-7h8v7'],
  workflow: ['M3 3h6v6H3zM15 15h6v6h-6zM6 9v9h9M9 6h9v9'],
  history: ['M3 11a9 9 0 1 1 2 7M3 4v7h7M12 7v5l3 2'],
  sources: ['M3 7h7l2-3h8v15H3V7Z'],
  refresh: ['M20 7a8 8 0 0 0-14-2L3 8m0-5v5h5M4 17a8 8 0 0 0 14 2l3-3m0 5v-5h-5'],
  sessions: ['M4 4h16v12H9l-5 4V4ZM8 8h8M8 12h5'],
  input: ['M12 3v12m-5-5 5 5 5-5M4 15v6h16v-6'],
  output: ['M12 16V4m-5 5 5-5 5 5M4 15v6h16v-6'],
  info: ['M12 11v6M12 7h.01', 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0'],
  shield: ['m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z'],
  eye: ['M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z', 'M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0'],
  check: ['m5 12 4 4L19 6'], close: ['m6 6 12 12M6 18 18 6'], arrow: ['M4 12h16m-6-6 6 6-6 6'],
};
const get = (id: string) => document.getElementById(id)!;
const text = (id: string, value: string) => { get(id).textContent = value; };
function element<K extends keyof HTMLElementTagNameMap>(tag: K, value = '', className = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.textContent = value; node.className = className; return node;
}
function icon(name: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('class', 'icon'); svg.setAttribute('aria-hidden', 'true');
  for (const d of ICONS[name] || ICONS.spark) { const p = document.createElementNS(svg.namespaceURI, 'path'); p.setAttribute('d', d); svg.append(p); }
  return svg;
}
for (const holder of document.querySelectorAll<HTMLElement>('[data-icon]')) holder.replaceChildren(icon(holder.dataset.icon!));
const dialog = get('idea-dialog') as HTMLDialogElement;
let snapshot: Snapshot | undefined;
let view = 'overview';
let kind = 'all';
let usageRange = '30';
let loading = false;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let lastRendered = '';
function notify(message: string): void {
  clearTimeout(toastTimer);
  (dialog.open ? dialog : document.body).append(get('toast'));
  text('toast', message); get('toast').hidden = false;
  toastTimer = setTimeout(() => { get('toast').hidden = true; }, 5500);
}
function showError(error: unknown): void { text('error', error instanceof Error ? error.message : 'Unable to connect. Try refreshing sessions.'); get('error').hidden = false; }
async function post(route: string, data: unknown): Promise<void> {
  const response = await fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  if (!response.ok) throw new Error('Your action could not be saved. Please try again.');
}
function action(label: string, run: () => Promise<void> | void, style = 'button-secondary'): HTMLButtonElement {
  const button = element('button', label, `button ${style}`);
  button.addEventListener('click', () => {
    const failed = (error: unknown) => { showError(error); notify('The action failed. Please try again.'); };
    try {
      const result = run();
      if (result) { button.disabled = true; void result.catch(failed).finally(() => { button.disabled = false; }); }
    } catch (error) { failed(error); }
  });
  return button;
}
function reviewStates(): Map<string, string> { return new Map(snapshot?.history.map(event => [event.id, event.action]) || []); }
function activeFindings(): Finding[] { const states = reviewStates(); return snapshot?.report?.findings.filter(f => states.get(f.id) !== 'dismissed') || []; }
function kindIcon(finding: Finding): HTMLElement { const holder = element('span', '', `kind-icon ${finding.kind}`); holder.append(icon(finding.kind)); return holder; }
function findingTitle(finding: Finding): string { return finding.kind === 'session' || finding.kind === 'memory' ? finding.title : IDEA_COPY[finding.kind].title; }
function meta(finding: Finding): HTMLElement {
  const node = element('div', '', 'idea-meta');
  if (finding.lastSeen) {
    const hours = Math.max(0, (Date.now() - finding.lastSeen) / 3600000);
    node.append(element('span', hours < 1 ? 'Seen within the past hour' : hours < 24 ? `Last seen ${Math.floor(hours)} hours ago` : `Last seen ${Math.floor(hours / 24)} days ago`));
  }
  node.append(element('span', `${finding.occurrences} occurrences`), element('span', `${finding.sessionCount} sessions`));
  const names = [...new Set(finding.evidence.map(e => projectName(e.workspace)))];
  if (names.length) node.append(element('span', names.length === 1 ? names[0] : `${names.length} example projects`));
  return node;
}
function card(finding: Finding): HTMLElement {
  const copy = IDEA_COPY[finding.kind];
  const node = element('article', '', 'idea-card'); const top = element('div', '', 'idea-card-top');
  top.append(kindIcon(finding), element('span', copy.label, 'badge'));
  node.append(top, element('h2', finding.responseIntent === 'unclassified' ? 'Long messages with unclear intent' : findingTitle(finding)), element('p', finding.responseIntent === 'unclassified' ? 'These are unclassified observations, not evidence of waste.' : finding.kind === 'session' || finding.kind === 'memory' ? finding.explanation : copy.benefit), meta(finding));
  const footer = element('div', '', 'card-footer');
  footer.append(element('span', 'Suggested · ready to review'), action('Review idea →', () => openIdea(finding), 'button-primary'));
  node.append(footer); return node;
}
function preview(finding: Finding): HTMLElement {
  const row = element('article', '', 'preview-row'); const copy = element('div', '', 'row-copy');
  copy.append(element('h3', findingTitle(finding)), element('p', `${finding.occurrences} occurrences · ${finding.sessionCount} sessions`));
  const button = action('', () => openIdea(finding)); button.setAttribute('aria-label', `Review ${IDEA_COPY[finding.kind].label.toLowerCase()} idea`); button.append(icon('arrow'));
  row.append(kindIcon(finding), copy, button); return row;
}
function step(title: string, description: string, number: string, recommended = false): HTMLElement {
  const section = element('section', '', `review-section${recommended ? ' recommended' : ''}`);
  const heading = element('h3'); heading.append(element('span', number, 'step-number'), document.createTextNode(title));
  section.append(heading, element('p', description)); return section;
}
function openIdea(finding: Finding): void {
  const copy = IDEA_COPY[finding.kind]; const body = get('idea-body'); body.replaceChildren();
  text('idea-kind', copy.label); const title = element('h2', finding.responseIntent === 'unclassified' ? 'Long messages with unclear intent' : findingTitle(finding)); title.id = 'idea-title';
  body.append(title, meta(finding), step('What Poe noticed', finding.explanation, '1'), step('Why it may help', copy.benefit, '2'), step('What to try', finding.suggestion || copy.next, '3', true));
  const examples = element('section', '', 'review-section'); examples.append(element('h3', 'Session examples'));
  examples.append(element('p', `Showing ${finding.evidence.length} latest matching examples within the active ${snapshot?.report?.activeWindowDays || 5}-day window. Older sessions can explain task context but do not count toward recommendations.`));
  if (!finding.evidence.some(item => item.excerpt)) examples.append(element('p', 'Prompt and recorded-reasoning previews are off. In poe.local.json, set "includeExcerpts": true, then restart Poe with --config poe.local.json. Previews are short and secret masking is best effort.'));
  for (const item of finding.evidence) {
    const row = element('div', '', 'evidence-row');
    const date = item.timestamp ? new Date(item.timestamp).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Date unavailable';
    const ageHours = item.timestamp ? Math.max(0, (Date.now() - item.timestamp) / 3600000) : null;
    const age = ageHours === null ? '' : ageHours < 1 ? ' · Within the past hour' : ageHours < 24 ? ` · ${Math.floor(ageHours)} hours ago` : ` · ${Math.floor(ageHours / 24)} days ago`;
    row.append(element('strong', `${item.harness === 'Claude' ? 'Claude Code' : item.harness} · ${projectName(item.workspace)}`), element('p', date + age));
    if (item.details?.length) { const details = element('div', '', 'signal-details'); for (const detail of item.details) details.append(element('span', detail)); row.append(details); }
    if (item.excerpt) row.append(element('blockquote', item.excerpt));
    const refs = element('details', '', 'technical'); refs.append(element('summary', 'Session reference'), element('code', `Project: ${item.workspace}\nSession: ${item.sessionId}\nRequest: ${item.requestId}\nTask context: ${item.contextRequestId || item.requestId}${item.toolCallIds?.length ? '\nTool calls: ' + item.toolCallIds.join(', ') : ''}${item.reasoningIds?.length ? '\nRecorded reasoning: ' + item.reasoningIds.join(', ') : ''}`)); row.append(refs); examples.append(row);
  }
  body.append(examples, step('Before making a change', finding.caution, '4'));
  body.append(element('p', 'Copy the review prompt and paste it into Claude Code or Codex. It asks your assistant to inspect the evidence and propose a small change.', 'dialog-help'));
  const actions = get('idea-actions'); actions.replaceChildren();
  const reason = element('select');
  reason.id = 'feedback-reason'; reason.setAttribute('aria-label', 'Reason for dismissing this idea');
  for (const [value, label] of [['not-now', 'Not now'], ['useful', 'Useful — reviewed'], ['expected', 'Expected behavior'], ['incorrect', 'Incorrect suggestion']]) {
    const option = element('option', label); option.value = value; reason.append(option);
  }
  const feedback = element('div', '', 'feedback-field');
  const label = element('label', 'Reason for dismissal'); label.htmlFor = reason.id;
  const help = element('small', 'Saved only when you click Dismiss idea. All reasons hide this idea until you reopen it.'); help.id = 'feedback-help'; reason.setAttribute('aria-describedby', help.id);
  feedback.append(label, reason, help); actions.append(feedback);
  actions.append(action('Copy review prompt', async () => { await navigator.clipboard.writeText(reviewPrompt(finding)); notify('Review prompt copied. Paste it into Claude Code or Codex.'); }, 'button-primary'), action('Dismiss idea', async () => {
    await post('/api/review', { id: finding.id, action: 'dismissed', reason: reason.value }); dialog.close(); await load(true); notify('Idea dismissed. You can reopen it in Review history.');
  }, 'button-quiet'));
  if (!dialog.open) dialog.showModal();
}
function emptyState(title: string, description: string): HTMLElement {
  const node = element('div', '', 'empty'); node.append(element('h2', title), element('p', description)); return node;
}
const compact = (value: number) => Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
const assistantName = harnessLabel;
const assistantClass = harnessClass;
const assistantMark = harnessMark;
function localDateKey(timestamp = Date.now()): string {
  const date = new Date(timestamp); const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
function activityAge(timestamp?: number): string {
  if (!timestamp) return 'No dated activity';
  const hours = Math.max(0, (Date.now() - timestamp) / 3600000);
  return hours < 1 ? 'Active within the past hour' : hours < 24 ? `Active ${Math.floor(hours)} hours ago` : `Active ${Math.floor(hours / 24)} days ago`;
}
function usagePoints(): NonNullable<CoachReport['usageHistory']>['days'] {
  const points = snapshot?.report?.usageHistory.days || [];
  if (usageRange === 'all') return points;
  if (usageRange === 'today') return points.filter(point => point.date === localDateKey());
  const cutoff = new Date(); cutoff.setHours(0, 0, 0, 0); cutoff.setDate(cutoff.getDate() - Number(usageRange) + 1);
  const key = localDateKey(cutoff.getTime());
  return points.filter(point => point.date >= key);
}
function svgNode<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string> = {}): SVGElementTagNameMap[K] {
  const node = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}
function renderUsageChart(points: ReturnType<typeof usagePoints>): void {
  const holder = get('usage-chart'); holder.replaceChildren(); get('chart-legend').replaceChildren();
  if (!points.length) { holder.append(emptyState('No token records in this range', 'Try a wider range or check Connected sources.')); return; }
  const dates = [...new Set(points.map(point => point.date))].sort();
  const start = Date.parse(`${dates[0]}T00:00:00`); const end = Math.max(start + 86400000, Date.parse(`${dates.at(-1)}T00:00:00`));
  const totals = new Map(points.map(point => [`${point.date}:${point.harness}`, point.input + point.output]));
  const max = Math.max(1, ...totals.values()); const width = 920; const height = 286; const left = 62; const right = 18; const top = 20; const bottom = 42;
  const x = (date: string) => left + (Date.parse(`${date}T00:00:00`) - start) / (end - start) * (width - left - right);
  const y = (value: number) => top + (1 - value / max) * (height - top - bottom);
  const svg = svgNode('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'Daily recorded token usage across coding assistants' });
  for (let i = 0; i <= 4; i++) {
    const value = max * (4 - i) / 4; const yy = top + i * (height - top - bottom) / 4;
    svg.append(svgNode('line', { x1: String(left), y1: String(yy), x2: String(width - right), y2: String(yy), class: 'chart-grid' }));
    const label = svgNode('text', { x: String(left - 10), y: String(yy + 4), class: 'chart-axis', 'text-anchor': 'end' }); label.textContent = compact(Math.round(value)); svg.append(label);
  }
  const labelDates = dates.filter((_, index) => index === 0 || index === dates.length - 1 || index % Math.max(1, Math.floor(dates.length / 4)) === 0).slice(0, 6);
  for (const date of labelDates) { const label = svgNode('text', { x: String(x(date)), y: String(height - 13), class: 'chart-axis', 'text-anchor': 'middle' }); label.textContent = new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); svg.append(label); }
  const harnesses = [...new Set(points.map(point => point.harness))].sort((a, b) => harnessSortRank(a) - harnessSortRank(b));
  const legend = get('chart-legend'); legend.replaceChildren();
  for (const harness of harnesses) {
    const className = assistantClass(harness); const item = element('span', assistantName(harness), className); item.prepend(element('i')); legend.append(item);
    const series = dates.map(date => ({ date, value: totals.get(`${date}:${harness}`) || 0 }));
    const line = svgNode('polyline', { points: series.map(point => `${x(point.date)},${y(point.value)}`).join(' '), class: `usage-line ${className}` }); svg.append(line);
    for (const point of series.filter(point => point.value > 0)) {
      const circle = svgNode('circle', { cx: String(x(point.date)), cy: String(y(point.value)), r: '4', class: `usage-point ${className}` });
      const title = svgNode('title'); title.textContent = `${assistantName(harness)} · ${point.date}: ${point.value.toLocaleString()} recorded tokens`; circle.append(title); svg.append(circle);
    }
  }
  holder.append(svg);
}
type AssistantSummary = { name: string; sessions: number; turns: number; input: number; output: number };
function overviewPoints(): CoachReport['usageHistory']['days'] {
  const days = snapshot?.report?.activeWindowDays || 5; const cutoff = new Date(); cutoff.setHours(0, 0, 0, 0); cutoff.setDate(cutoff.getDate() - days + 1);
  const key = localDateKey(cutoff.getTime()); return (snapshot?.report?.usageHistory.days || []).filter(point => point.date >= key);
}
function summarizeAssistants(points: CoachReport['usageHistory']['days']): AssistantSummary[] {
  const names = Object.keys(snapshot?.report?.usageHistory.byHarness || {});
  return names.map(name => {
    const rows = points.filter(point => point.harness === name);
    return { name, sessions: rows.reduce((sum, point) => sum + point.sessions, 0), turns: rows.reduce((sum, point) => sum + point.turns, 0), input: rows.reduce((sum, point) => sum + point.input, 0), output: rows.reduce((sum, point) => sum + point.output, 0) };
  }).sort((a, b) => b.turns - a.turns || harnessSortRank(a.name) - harnessSortRank(b.name));
}
function assistantIdentity(name: string): HTMLElement {
  const identity = element('div', '', 'chart-assistant'); identity.append(element('span', assistantMark(name), 'assistant-mark'), element('strong', assistantName(name))); return identity;
}
function renderActivityBars(rows: AssistantSummary[]): void {
  const holder = get('overview-activity-chart'); holder.replaceChildren(); const max = Math.max(1, ...rows.map(row => row.turns));
  if (!rows.some(row => row.turns)) { holder.append(emptyState('No recent activity recorded', 'Refresh sessions or open the full history for older activity.')); return; }
  for (const row of rows) {
    const item = element('article', '', `assistant-chart-row ${assistantClass(row.name)}`); item.setAttribute('aria-label', `${assistantName(row.name)}: ${row.turns} turns`);
    const header = element('div', '', 'assistant-chart-label'); header.append(assistantIdentity(row.name), element('span', `${row.turns.toLocaleString()} turns`));
    const track = element('div', '', 'assistant-bar-track'); const fill = element('span', '', 'assistant-bar-fill'); fill.style.width = `${row.turns / max * 100}%`; track.append(fill); item.append(header, track); holder.append(item);
  }
}
function renderTokenBars(rows: AssistantSummary[]): void {
  const holder = get('overview-token-chart'); holder.replaceChildren();
  // One shared scale across every assistant and both series, so bar height is a direct,
  // honest comparison -- both input vs. output within a row and assistant vs. assistant.
  const max = Math.max(1, ...rows.flatMap(row => [row.input, row.output]));
  if (!rows.some(row => row.input || row.output)) { holder.append(emptyState('No recent token fields recorded', 'The session logs in this window do not expose token values.')); return; }
  for (const row of rows) {
    const item = element('article', '', `token-compare-row ${assistantClass(row.name)}`); const header = element('div', '', 'token-row-head'); header.append(assistantIdentity(row.name), element('strong', compact(row.input + row.output)));
    const bars = element('div', '', 'token-compare-bars');
    for (const [label, value, className] of [['Input', row.input, 'input'], ['Output', row.output, 'output']] as const) {
      const bar = element('div', '', `token-bar ${className}`);
      bar.style.height = `${value ? Math.max(3, value / max * 100) : 0}%`;
      bar.title = `${assistantName(row.name)} ${label.toLowerCase()}: ${value.toLocaleString()} tokens`;
      bar.append(element('span', value ? compact(value) : '0', 'token-bar-value'));
      bars.append(bar);
    }
    item.append(header, bars); holder.append(item);
  }
}
function renderOverviewAnalysis(): void {
  if (!snapshot?.report) return;
  const points = overviewPoints(); const rows = summarizeAssistants(points); const days = snapshot.report.activeWindowDays || 5;
  const sessions = snapshot.report.sessionCount; const turns = points.reduce((sum, point) => sum + point.turns, 0); const input = points.reduce((sum, point) => sum + point.input, 0); const output = points.reduce((sum, point) => sum + point.output, 0); const total = input + output;
  const active = rows.filter(row => row.turns > 0); const leader = active[0];
  text('overview-analysis-title', turns ? `${turns.toLocaleString()} turns across ${active.length} ${active.length === 1 ? 'assistant' : 'assistants'}.` : 'No recent assistant activity recorded yet.');
  text('overview-analysis-copy', leader ? `${assistantName(leader.name)} handled the most turns in the latest ${days}-day activity window.` : `Poe will compare your assistants across the latest ${days} days as sessions appear.`);
  const stats = get('overview-analysis-stats'); stats.replaceChildren();
  const inputShare = total ? Math.round(input / total * 1000) / 10 : 0;
  for (const [label, value, detail, iconName] of [['Processed tokens', total ? compact(total) : 'Unknown', total ? `${inputShare}% input` : 'No token fields', 'usage'], ['Input tokens', input ? compact(input) : 'Unknown', `${points.reduce((sum, point) => sum + point.turnsWithInput, 0)} turns measured`, 'input'], ['Output tokens', output ? compact(output) : 'Unknown', `${points.reduce((sum, point) => sum + point.turnsWithOutput, 0)} turns measured`, 'output'], ['Sessions', sessions.toLocaleString(), `${turns.toLocaleString()} turns`, 'sessions']] as const) {
    const card = element('article'); const chip = element('span', '', 'overview-kpi-chip'); chip.append(icon(iconName));
    const top = element('div', '', 'overview-kpi-label'); top.append(element('span', label), element('i'));
    card.append(chip, top, element('strong', value), element('small', detail)); stats.append(card);
  }
  renderActivityBars(rows); renderTokenBars(rows);
}
function renderUsage(): void {
  if (!snapshot?.report) return;
  const points = usagePoints(); const input = points.reduce((sum, point) => sum + point.input, 0); const output = points.reduce((sum, point) => sum + point.output, 0); const cacheRead = points.reduce((sum, point) => sum + point.cacheRead, 0); const turns = points.reduce((sum, point) => sum + point.turns, 0); const inputTurns = points.reduce((sum, point) => sum + point.turnsWithInput, 0); const outputTurns = points.reduce((sum, point) => sum + point.turnsWithOutput, 0);
  text('usage-total', compact(input + output)); text('usage-input', compact(input)); text('usage-output', compact(output));
  text('usage-total-detail', `${turns.toLocaleString()} turns in the selected range`); text('usage-input-coverage', `${inputTurns} of ${turns} turns · ${compact(cacheRead)} cache-read`); text('usage-output-coverage', `${outputTurns} of ${turns} turns include output data`);
  const dates = points.map(point => point.date).sort(); text('usage-chart-summary', dates.length ? `${dates[0]} to ${dates.at(-1)} · recorded fields only` : 'No records in this range');
  renderUsageChart(points);
  const breakdown = get('usage-breakdown'); breakdown.replaceChildren();
  const names = Object.keys(snapshot.report.usageHistory.byHarness).sort((a, b) => harnessSortRank(a) - harnessSortRank(b));
  for (const name of names) {
    const rows = points.filter(point => point.harness === name); const row = element('article', '', `usage-breakdown-row ${assistantClass(name)}`);
    const total = rows.reduce((sum, point) => sum + point.input + point.output, 0); const rowInput = rows.reduce((sum, point) => sum + point.input, 0); const rowCache = rows.reduce((sum, point) => sum + point.cacheRead, 0); const rowTurns = rows.reduce((sum, point) => sum + point.turns, 0); const known = rows.reduce((sum, point) => sum + Math.max(point.turnsWithInput, point.turnsWithOutput), 0);
    const identity = element('div', '', 'usage-assistant'); identity.append(element('span', assistantMark(name), 'assistant-mark'), element('strong', assistantName(name)));
    const coverage = rowTurns ? `${Math.min(100, Math.round(known / rowTurns * 100))}% coverage` : 'No turns'; const cache = rowInput && rowCache ? ` · ${Math.round(rowCache / rowInput * 100)}% cache-read` : '';
    row.append(identity, element('span', `${rowTurns.toLocaleString()} turns`, 'usage-cell'), element('span', total ? compact(total) : 'Unknown', 'usage-cell strong'), element('span', coverage + cache, 'usage-cell muted')); breakdown.append(row);
  }
  if (view === 'usage') text('period', usageRange === 'all' ? 'All loaded history' : usageRange === 'today' ? 'Today · since 12:00 AM' : `Last ${usageRange} days`);
}
function renderFindings(): void {
  const active = activeFindings(); text('nav-count', String(active.length));
  const short = get('overview-list'); short.replaceChildren(...active.slice(0, 3).map(preview));
  const list = get('findings'); const selected = active.filter(f => kind === 'all' || f.kind === kind); list.replaceChildren(...selected.map(card));
  text('result-count', `${selected.length} ${selected.length === 1 ? 'idea' : 'ideas'} to review`);
  if (!active.length) {
    const title = !snapshot?.report ? 'Reading your sessions' : snapshot.report.requestCount ? 'No matching patterns detected' : 'No recent sessions found';
    const description = snapshot?.report?.requestCount ? 'No current activity matches the supported rules. This does not mean the session is error-free; some tool formats and instruction problems cannot be detected.' : 'Check Connected sources to see which session folders are available.';
    short.append(emptyState(title, description));
    list.append(emptyState(title, description));
  } else if (!selected.length) list.append(emptyState('No ideas in this category', 'Try another filter to explore the other patterns in your sessions.'));
  const filters = get('kind-filters'); filters.replaceChildren();
  const labels: [string, string][] = [['all', 'All ideas'], ['skill', 'Skills'], ['memory', 'Memory'], ['workflow', 'Workflows'], ['output', 'Response length'], ['session', 'Session signals']];
  for (const [value, label] of labels) {
    const count = value === 'all' ? active.length : active.filter(f => f.kind === value).length;
    const button = action(`${label} (${count})`, () => { kind = value; renderFindings(); get('kind-filters').querySelector<HTMLButtonElement>('[aria-pressed=true]')?.focus(); }, 'filter');
    button.setAttribute('aria-pressed', String(kind === value)); filters.append(button);
  }
}
function renderMetrics(): void {
  if (!snapshot?.report) return;
  const { report, config } = snapshot;
  const reviewed = report.responseReview;
  text('response-context-summary', reviewed ? `Long messages: ${reviewed.requestedDetail} matched requests for detail · ${reviewed.unclassified} unclassified · ${reviewed.brevityConflict} with brevity signals. These are local text rules, not quality scores.` : '');
  text('period', `Active: last ${report.activeWindowDays || 5} days`);
  const count = activeFindings().length;
  text('hero-title', count ? `${count} ${count === 1 ? 'idea' : 'ideas'} for a better next session.` : 'Good habits start with observation.');
  text('hero-description', count ? 'A few patterns in your sessions are worth a closer look. Pick one idea, review the examples, and try a small change.' : 'Keep working as usual. Poe will surface ideas when enough evidence appears in your sessions.');
  text('status', `Updated ${new Date(report.generatedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} · Checks every ${config.refreshSeconds < 60 ? `${config.refreshSeconds}s` : `${Math.round(config.refreshSeconds / 60)} min`}`);
}
function renderHistory(): void {
  const list = get('history-list'); list.replaceChildren(); const seen = new Set<string>();
  for (const event of snapshot?.history.slice().reverse().slice(0, 100) || []) {
    const latest = !seen.has(event.id); seen.add(event.id);
    const finding = snapshot?.report?.findings.find(f => f.id === event.id);
    const row = element('article', '', 'history-row'); const copy = element('div', '', 'row-copy');
    copy.append(element('strong', finding ? findingTitle(finding) : 'Previously reviewed idea'), element('p', `${event.action === 'dismissed' ? 'Dismissed' : 'Reopened'}${event.reason ? ' · ' + ({ useful: 'Useful — reviewed', expected: 'Expected behavior', incorrect: 'Incorrect suggestion', 'not-now': 'Not now' }[event.reason]) : ''} · ${new Date(event.at).toLocaleString()}`));
    row.append(icon(event.action === 'dismissed' ? 'check' : 'history'), copy);
    if (latest && event.action === 'dismissed') row.append(action('Reopen idea', async () => { await post('/api/review', { id: event.id, action: 'reopened' }); await load(true); notify(finding ? 'Idea reopened. Find it in Findings.' : 'Decision reopened. The idea will appear if it is detected again.'); }));
    list.append(row);
  }
  if (!snapshot?.history.length) list.append(emptyState('A fresh start', 'Your review decisions will appear here. Dismiss an idea from its review panel when it is not useful to you.'));
}
function renderSources(): void {
  const report = snapshot?.report; if (!report) return;
  const list = get('source-list'); list.replaceChildren();
  for (const source of report.sources) {
    const row = element('article', '', 'source-row'); const copy = element('div', '', 'source-copy');
    const label = sourceLabel(source.harness); const activity = sourceHarnessNames(source.harness).map(name => report.usageHistory.byHarness[name]).find(Boolean);
    copy.append(element('strong', label), element('code', source.root));
    if (activity) copy.append(element('p', `${activity.sessions.toLocaleString()} sessions · ${activity.turns.toLocaleString()} turns · ${activityAge(activity.lastActivity)}`, 'source-activity'));
    row.append(icon('sources'), copy, element('span', source.exists ? 'Available' : 'Folder not found', 'source-status')); list.append(row);
  }
  if (!report.sources.length) list.append(emptyState('No sources enabled', 'Enable Claude Code or Codex in your local configuration to begin observing sessions.'));
  text('scan-details', `${report.toolSignalCoverage?.retained || 0} tool-call records and ${report.reasoningSignalCoverage?.retained || 0} recorded-reasoning passages available for session signals; ${(report.toolSignalCoverage?.dropped || 0) + (report.reasoningSignalCoverage?.dropped || 0)} older records omitted by per-session limits. Reasoning previews are ${report.reasoningSignalCoverage?.previews ? 'enabled' : 'off'}; hidden or encrypted thinking is unavailable. Unsupported formats may be absent. Latest recorded session activity: ${report.latestSessionActivity ? new Date(report.latestSessionActivity).toLocaleString() : 'unavailable'}. ${report.excludedInternalSessions || 0} internal approval-review sessions excluded from coaching. ${report.scan.incremental || 0} logs updated incrementally · ${(report.scan.bytesRead || 0).toLocaleString()} bytes read. ${report.responseReview?.requestedDetail || 0} long messages matched requested detail; ${report.responseReview?.unclassified || 0} remain unclassified. ${report.scan.files} files discovered · ${report.scan.parsed} parsed on this scan · ${report.scan.reused} reused · ${report.scan.skipped} skipped. Skips can include empty, unsupported, or oversized files.`);
  get('scan-warnings').replaceChildren(...report.scan.warnings.map(warning => element('p', warning)));
  text('excerpt-setting', snapshot?.config.includeExcerpts ? 'Short prompt and recorded-reasoning previews are enabled. Secret masking is best effort.' : 'Prompt and recorded-reasoning previews are off. Set "includeExcerpts": true in poe.local.json and restart Poe to show short, masked excerpts.');
}
function render(): void { renderMetrics(); renderOverviewAnalysis(); renderUsage(); renderFindings(); renderHistory(); renderSources(); }
const PAGES: Record<string, [string, string, string]> = {
  overview: ['Overview', 'Your workflow, at a glance.', 'See what repeats. Choose what to improve.'],
  usage: ['Token usage', 'See how your AI usage changes.', 'Compare recorded activity across your coding assistants.'],
  findings: ['Findings', 'Find your next improvement.', 'Review a pattern, check the examples, then decide what to try.'],
  history: ['Review history', 'Your decisions, in one place.', 'Keep a record of the ideas you have reviewed.'],
  sources: ['Connected sources', 'Connected to the way you work.', 'A transparent view of what Poe can observe.'],
};
function navigate(): void {
  const target = location.hash.slice(1); view = Object.hasOwn(PAGES, target) ? target : 'overview';
  const [label, title, description] = PAGES[view];
  text('breadcrumb', `Workspace / ${label}`); text('page-eyebrow', label.toUpperCase()); text('page-title', title); text('page-description', description);
  for (const [page, section] of [['overview', 'overview'], ['usage', 'usage'], ['findings', 'opportunities'], ['history', 'history'], ['sources', 'sources']]) get(section).hidden = page !== view;
  for (const link of document.querySelectorAll<HTMLAnchorElement>('nav a')) { if (link.dataset.view === view) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); }
  render();
  if (view !== 'usage' && snapshot?.report) text('period', `Active: last ${snapshot.report.activeWindowDays || 5} days`);
}
async function load(force = false): Promise<void> {
  if (loading) return; loading = true;
  try {
    const response = await fetch('/api/report'); if (!response.ok) throw new Error('Cannot reach Poe. Check that it is running, then refresh.');
    snapshot = await response.json() as Snapshot;
    if (snapshot.error) showError(new Error(snapshot.error)); else get('error').hidden = true;
    const signature = JSON.stringify([snapshot.report?.generatedAt, snapshot.history]);
    if (force || signature !== lastRendered) { lastRendered = signature; render(); }
  } finally { loading = false; }
}
dialog.addEventListener('close', () => { document.body.append(get('toast')); });
get('close-dialog').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } });
window.addEventListener('hashchange', navigate);
document.querySelector<HTMLAnchorElement>('.skip-link')?.addEventListener('click', event => { event.preventDefault(); get('main').focus(); });
get('refresh').addEventListener('click', () => {
  const button = get('refresh') as HTMLButtonElement; button.disabled = true; button.setAttribute('aria-busy', 'true');
  void post('/api/refresh', {}).then(() => { notify('Checking your sessions. Results will update shortly.'); return load(); }).catch(showError).finally(() => { button.disabled = false; button.removeAttribute('aria-busy'); });
});
(get('usage-range') as HTMLSelectElement).addEventListener('change', event => { usageRange = (event.currentTarget as HTMLSelectElement).value; renderUsage(); });
navigate(); void load().catch(showError);
setInterval(() => { if (!document.hidden && !dialog.open && !document.querySelector('details[open]') && !get('main').contains(document.activeElement)) void load().catch(showError); }, 5000);
