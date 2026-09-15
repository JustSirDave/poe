import type { CoachReport, Finding } from './analysis';
import type { ReviewEvent } from './reviews';
import { IDEA_COPY, projectName, reviewPrompt } from './presentation';
interface Snapshot { report?: CoachReport; error?: string; history: ReviewEvent[]; config: { lookbackDays: number; refreshSeconds: number; includeExcerpts: boolean } }
const ICONS: Record<string, string[]> = {
  overview: ['M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z'],
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
function meta(finding: Finding): HTMLElement {
  const node = element('div', '', 'idea-meta');
  node.append(element('span', `${finding.occurrences} occurrences`), element('span', `${finding.sessionCount} sessions`));
  const names = [...new Set(finding.evidence.map(e => projectName(e.workspace)))];
  if (names.length) node.append(element('span', names.length === 1 ? names[0] : `${names.length} example projects`));
  return node;
}
function card(finding: Finding): HTMLElement {
  const copy = IDEA_COPY[finding.kind];
  const node = element('article', '', 'idea-card'); const top = element('div', '', 'idea-card-top');
  top.append(kindIcon(finding), element('span', copy.label, 'badge'));
  node.append(top, element('h2', copy.title), element('p', copy.benefit), meta(finding));
  const footer = element('div', '', 'card-footer');
  footer.append(element('span', 'Suggested · ready to review'), action('Review idea →', () => openIdea(finding), 'button-primary'));
  node.append(footer); return node;
}
function preview(finding: Finding): HTMLElement {
  const row = element('article', '', 'preview-row'); const copy = element('div', '', 'row-copy');
  copy.append(element('h3', IDEA_COPY[finding.kind].title), element('p', `${finding.occurrences} occurrences · ${finding.sessionCount} sessions`));
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
  text('idea-kind', copy.label); const title = element('h2', copy.title); title.id = 'idea-title';
  body.append(title, meta(finding), step('What the coach noticed', finding.explanation, '1'), step('Why it may help', copy.benefit, '2'), step('What to try', copy.next, '3', true));
  const examples = element('section', '', 'review-section'); examples.append(element('h3', 'Session examples'));
  if (!finding.evidence.some(item => item.excerpt)) examples.append(element('p', 'Prompt previews are off. In coach.local.json, set "includeExcerpts": true, then restart the coach with --config coach.local.json. Previews are short and secret masking is best effort.'));
  for (const item of finding.evidence) {
    const row = element('div', '', 'evidence-row');
    const date = item.timestamp ? new Date(item.timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : 'Date unavailable';
    row.append(element('strong', `${item.harness === 'Claude' ? 'Claude Code' : item.harness} · ${projectName(item.workspace)}`), element('p', date));
    if (item.excerpt) row.append(element('blockquote', item.excerpt));
    const refs = element('details', '', 'technical'); refs.append(element('summary', 'Session reference'), element('code', `Project: ${item.workspace}\nSession: ${item.sessionId}\nRequest: ${item.requestId}`)); row.append(refs); examples.append(row);
  }
  body.append(examples, step('Before making a change', finding.caution, '4'));
  body.append(element('p', 'Copy the review prompt and paste it into Claude Code or Codex. It asks your assistant to inspect the evidence and propose a small change.', 'dialog-help'));
  const actions = get('idea-actions'); actions.replaceChildren();
  actions.append(action('Copy review prompt', async () => { await navigator.clipboard.writeText(reviewPrompt(finding)); notify('Review prompt copied. Paste it into Claude Code or Codex.'); }, 'button-primary'), action('Dismiss idea', async () => {
    await post('/api/review', { id: finding.id, action: 'dismissed' }); dialog.close(); await load(true); notify('Idea dismissed. You can reopen it in Review history.');
  }, 'button-quiet'));
  if (!dialog.open) dialog.showModal();
}
function emptyState(title: string, description: string): HTMLElement {
  const node = element('div', '', 'empty'); node.append(element('h2', title), element('p', description)); return node;
}
function renderFindings(): void {
  const active = activeFindings(); text('nav-count', String(active.length));
  const short = get('overview-list'); short.replaceChildren(...active.slice(0, 3).map(preview));
  const list = get('findings'); const selected = active.filter(f => kind === 'all' || f.kind === kind); list.replaceChildren(...selected.map(card));
  text('result-count', `${selected.length} ${selected.length === 1 ? 'idea' : 'ideas'} to review`);
  if (!active.length) {
    const title = !snapshot?.report ? 'Reading your sessions' : snapshot.report.requestCount ? 'Nothing needs a closer look yet' : 'No recent sessions found';
    const description = snapshot?.report?.requestCount ? 'No active ideas meet the evidence threshold. Keep working; the coach checks automatically.' : 'Check Connected sources to see which session folders are available.';
    short.append(emptyState(title, description));
    list.append(emptyState(title, description));
  } else if (!selected.length) list.append(emptyState('No ideas in this category', 'Try another filter to explore the other patterns in your sessions.'));
  const filters = get('kind-filters'); filters.replaceChildren();
  const labels: [string, string][] = [['all', 'All ideas'], ['skill', 'Skills'], ['memory', 'Memory'], ['workflow', 'Workflows'], ['output', 'Response length']];
  for (const [value, label] of labels) {
    const count = value === 'all' ? active.length : active.filter(f => f.kind === value).length;
    const button = action(`${label} (${count})`, () => { kind = value; renderFindings(); get('kind-filters').querySelector<HTMLButtonElement>('[aria-pressed=true]')?.focus(); }, 'filter');
    button.setAttribute('aria-pressed', String(kind === value)); filters.append(button);
  }
}
function renderMetrics(): void {
  if (!snapshot?.report) return;
  const { report, config } = snapshot; const tokens = report.recordedTokens;
  const format = (value: number) => Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  text('sessions', report.sessionCount.toLocaleString()); text('window', `${report.requestCount.toLocaleString()} recorded turns`);
  text('input', tokens.turnsWithInput ? format(tokens.input) : 'Unknown'); get('input').title = tokens.input.toLocaleString();
  text('output', tokens.turnsWithOutput ? format(tokens.output) : 'Unknown'); get('output').title = tokens.output.toLocaleString();
  text('coverage', `${tokens.turnsWithInput} of ${report.requestCount} turns include input data`);
  text('output-coverage', `${tokens.turnsWithOutput} of ${report.requestCount} turns include output data`);
  text('period', `Last ${config.lookbackDays} days`);
  const count = activeFindings().length;
  text('hero-title', count ? `${count} ${count === 1 ? 'idea' : 'ideas'} for a better next session.` : 'Good habits start with observation.');
  text('hero-description', count ? 'A few patterns in your sessions are worth a closer look. Pick one idea, review the examples, and try a small change.' : 'Keep working as usual. The coach will surface ideas when enough evidence appears in your sessions.');
  text('status', `Updated ${new Date(report.generatedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} · Checks every ${config.refreshSeconds < 60 ? `${config.refreshSeconds}s` : `${Math.round(config.refreshSeconds / 60)} min`}`);
}
function renderHistory(): void {
  const list = get('history-list'); list.replaceChildren(); const seen = new Set<string>();
  for (const event of snapshot?.history.slice().reverse().slice(0, 100) || []) {
    const latest = !seen.has(event.id); seen.add(event.id);
    const finding = snapshot?.report?.findings.find(f => f.id === event.id);
    const row = element('article', '', 'history-row'); const copy = element('div', '', 'row-copy');
    copy.append(element('strong', finding ? IDEA_COPY[finding.kind].title : 'Previously reviewed idea'), element('p', `${event.action === 'dismissed' ? 'Dismissed' : 'Reopened'} · ${new Date(event.at).toLocaleString()}`));
    row.append(icon(event.action === 'dismissed' ? 'check' : 'history'), copy);
    if (latest && event.action === 'dismissed') row.append(action('Reopen idea', async () => { await post('/api/review', { id: event.id, action: 'reopened' }); await load(true); notify(finding ? 'Idea reopened. Find it in Opportunities.' : 'Decision reopened. The idea will appear if it is detected again.'); }));
    list.append(row);
  }
  if (!snapshot?.history.length) list.append(emptyState('A fresh start', 'Your review decisions will appear here. Dismiss an idea from its review panel when it is not useful to you.'));
}
function renderSources(): void {
  const report = snapshot?.report; if (!report) return;
  const list = get('source-list'); list.replaceChildren();
  for (const source of report.sources) {
    const row = element('article', '', 'source-row'); const copy = element('div', '', 'source-copy');
    copy.append(element('strong', source.harness === 'claude' ? 'Claude Code' : 'Codex'), element('code', source.root));
    row.append(icon('sources'), copy, element('span', source.exists ? 'Available' : 'Folder not found', 'source-status')); list.append(row);
  }
  if (!report.sources.length) list.append(emptyState('No sources enabled', 'Enable Claude Code or Codex in your local configuration to begin observing sessions.'));
  text('scan-details', `${report.excludedInternalSessions || 0} internal approval-review sessions excluded from coaching. ${report.scan.files} files discovered · ${report.scan.parsed} parsed on this scan · ${report.scan.reused} reused · ${report.scan.skipped} skipped. Skips can include empty, unsupported, or oversized files.`);
  get('scan-warnings').replaceChildren(...report.scan.warnings.map(warning => element('p', warning)));
  text('excerpt-setting', snapshot?.config.includeExcerpts ? 'Short prompt previews are enabled. Secret masking is best effort.' : 'Prompt previews are off. Set "includeExcerpts": true in coach.local.json and restart with --config coach.local.json to show short, masked excerpts.');
}
function render(): void { renderMetrics(); renderFindings(); renderHistory(); renderSources(); }
const PAGES: Record<string, [string, string, string]> = {
  overview: ['Overview', 'Your workflow, at a glance.', 'See what repeats. Choose what to improve.'],
  findings: ['Opportunities', 'Find your next improvement.', 'Review a pattern, check the examples, then decide what to try.'],
  history: ['Review history', 'Your decisions, in one place.', 'Keep a record of the ideas you have reviewed.'],
  sources: ['Connected sources', 'Connected to the way you work.', 'A transparent view of what the coach can observe.'],
};
function navigate(): void {
  const target = location.hash.slice(1); view = Object.hasOwn(PAGES, target) ? target : 'overview';
  const [label, title, description] = PAGES[view];
  text('breadcrumb', `Workspace / ${label}`); text('page-eyebrow', label.toUpperCase()); text('page-title', title); text('page-description', description);
  for (const [page, section] of [['overview', 'overview'], ['findings', 'opportunities'], ['history', 'history'], ['sources', 'sources']]) get(section).hidden = page !== view;
  for (const link of document.querySelectorAll<HTMLAnchorElement>('nav a')) { if (link.dataset.view === view) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); }
  render();
}
async function load(force = false): Promise<void> {
  if (loading) return; loading = true;
  try {
    const response = await fetch('/api/report'); if (!response.ok) throw new Error('Cannot reach the local coach. Check that it is running, then refresh.');
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
navigate(); void load().catch(showError);
setInterval(() => { if (!document.hidden && !dialog.open && !document.querySelector('details[open]') && !get('main').contains(document.activeElement)) void load().catch(showError); }, 5000);
