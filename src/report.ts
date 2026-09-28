import type { Issue } from './monitor.ts';
import type { RunSummary, TestResult } from './suite.ts';
import { readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const CAUSE_LABEL: Record<string, string> = {
    product: 'Suspected product defect',
    agent: 'Agent could not drive the UI',
    environment: 'Environment / test code',
    model: 'Model service',
    timeout: 'Timeout',
};

export async function writeReports(summary: RunSummary): Promise<void> {
    await writeFile(join(summary.directory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    await writeFile(join(summary.directory, 'report.md'), markdownReport(summary));
    await writeFile(join(summary.directory, 'report.html'), await htmlReport(summary));
}

export async function loadSummary(directory: string): Promise<RunSummary> {
    return JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8')) as RunSummary;
}

function statusIcon(status: string): string {
    return ({ passed: '✓', failed: '✗', flaky: '≈', known: '!', skipped: '–' } as Record<string, string>)[status] ?? '?';
}

function seconds(ms: number): string {
    return `${(ms / 1000).toFixed(1)}s`;
}

export function markdownReport(summary: RunSummary): string {
    const { manifest, totals, results } = summary;
    const lines: string[] = [];
    lines.push(`# jevwright run ${manifest.runId}`, '');
    lines.push(`${manifest.mode} mode${manifest.dryRun ? ' (dry run)' : ''} · ${manifest.engine} · git ${manifest.git ? `${manifest.git.sha.slice(0, 10)}${manifest.git.dirty ? ' (dirty)' : ''}` : 'unknown'} · started ${manifest.startedAt}${manifest.finishedAt ? ` · finished ${manifest.finishedAt}` : ' · running'}`);
    if (manifest.command) { lines.push('', `Command: \`${manifest.command}\``); }
    lines.push('');
    lines.push(`**${totals.tests} tests**: ${totals.passed} passed, ${totals.failed} failed, ${totals.flaky} flaky, ${totals.known ?? 0} known, ${totals.skipped} skipped · ${totals.issues} implicit issues · model calls ${totals.models.jevCalls} Jev / ${totals.models.llmCalls} LLM · ${totals.models.inputTokens.toLocaleString('en-US')} input tokens${totals.models.cost ? ` · $${totals.models.cost.toFixed(4)}` : ''} · test time ${seconds(totals.durationMs)}`);
    lines.push('');
    lines.push(...budgetLines(manifest, totals));
    lines.push(...failuresSection(results, manifest));
    lines.push(...knownIssuesSection(results));
    lines.push(...resolvedIssuesSection(results));
    lines.push(...issuesTableSection(results));
    lines.push(...testsTableSection(results));
    return `${lines.join('\n')}\n`;
}

/** The run-budget note, once the shared cost ceiling stopped the run early. */
function budgetLines(manifest: RunSummary['manifest'], totals: RunSummary['totals']): string[] {
    if (manifest.maxCostUsd === undefined || totals.models.cost < manifest.maxCostUsd) { return []; }
    return [`**Run budget of $${manifest.maxCostUsd} reached** — tests not yet started did not run, and a test in progress failed at its next model call. Raise \`--max-cost\` to run them.`, ''];
}

function failuresSection(results: TestResult[], manifest: RunSummary['manifest']): string[] {
    const failing = results.filter(result => result.status === 'failed' || result.status === 'flaky');
    if (!failing.length) { return []; }
    const lines: string[] = ['## Failures', ''];
    for (const cause of ['product', 'agent', 'environment', 'model', 'timeout']) {
        const group = failing.filter(result => result.cause === cause || (result.status === 'flaky' && cause === 'agent' && !result.cause));
        if (!group.length) { continue; }
        lines.push(`### ${CAUSE_LABEL[cause]}`, '');
        for (const result of group) { lines.push(...failureEntryLines(result, manifest)); }
        lines.push('');
    }
    return lines;
}

/** One failure's bullet: its outcome, then whichever of risk/evidence/decision/reproduce/artifacts apply. */
function failureEntryLines(result: TestResult, manifest: RunSummary['manifest']): string[] {
    const attempt = result.attempts.find(entry => entry.status === 'failed') ?? result.attempts.at(-1);
    const step = attempt?.failedStep !== undefined ? attempt.steps[attempt.failedStep] : undefined;
    const lines: string[] = [
        `- **${result.id}** (${result.status}${result.reproduced ? `, failed ${result.reproduced} attempts` : ''}) — ${result.summary}`,
        `  - Risk: ${result.risk}`,
    ];
    if (step?.evidence !== undefined) { lines.push(`  - Evidence: \`${truncate(JSON.stringify(step.evidence), 400)}\``); }
    if (step?.rounds?.length) {
        const last = step.rounds.at(-1)!;
        lines.push(`  - Last decision: ${last.source} ${last.tool}${last.target ? ` → ${last.target}` : ''}${last.note ? ` (${last.note})` : ''}; candidates ${last.candidates?.map(candidate => `${candidate.element} ${candidate.p}`).join(', ') ?? 'n/a'}`);
    }
    if (manifest.command) { lines.push(`  - Reproduce: \`${reproduceCommand(manifest.command, result.id)}\``); }
    if (attempt) {
        lines.push(`  - Artifacts: \`${relative(process.cwd(), attempt.directory)}\`${attempt.trace ? ` · trace: \`npx playwright show-trace ${relative(process.cwd(), attempt.trace)}\`` : ''}`);
    }
    return lines;
}

function knownIssuesSection(results: TestResult[]): string[] {
    const known = results.filter(result => result.status === 'known');
    if (!known.length) { return []; }
    const lines: string[] = ['## Known product issues', '', 'Confirmed defects these tests still reproduce; they do not fail the run.', ''];
    for (const result of known) { lines.push(`- **${result.id}** — ${result.knownIssue ?? ''} · this run: ${result.summary}`); }
    lines.push('');
    return lines;
}

function resolvedIssuesSection(results: TestResult[]): string[] {
    const resolved = results.filter(result => result.knownIssue && (result.status === 'passed' || result.status === 'flaky'));
    if (!resolved.length) { return []; }
    const lines: string[] = ['## Known issues that no longer reproduce', '', 'Remove `knownIssue` from these tests once the fix is confirmed.', ''];
    for (const result of resolved) { lines.push(`- **${result.id}** (${result.status}) — ${result.knownIssue ?? ''}`); }
    lines.push('');
    return lines;
}

function issuesTableSection(results: TestResult[]): string[] {
    const issues = collectIssues(results);
    if (!issues.length) { return []; }
    const lines: string[] = ['## Potential product issues (implicit oracles)', '', '| Severity | Kind | Message | Tests |', '| --- | --- | --- | --- |'];
    for (const issue of issues) {
        const detail = issue.detail ? ` — ${truncate(issue.detail.replaceAll('\n', ' / '), 300)}` : '';
        lines.push(`| ${issue.severity} | ${issue.kind} | ${escapeCell(issue.message + detail)} | ${issue.tests.join(', ')} |`);
    }
    lines.push('');
    return lines;
}

function testsTableSection(results: TestResult[]): string[] {
    const lines: string[] = ['## Tests', '', '| | Test | Module | Steps (replay / AI / healed) | Model calls | Time | Summary |', '| --- | --- | --- | --- | --- | --- | --- |'];
    for (const result of results) {
        const last = result.attempts.at(-1);
        const recording = last ? `${last.recording.replayed} / ${last.recording.ai} / ${last.recording.healed}` : '–';
        lines.push(`| ${statusIcon(result.status)} | ${result.id} | ${result.module ?? ''} | ${recording} | ${result.models.jevCalls}+${result.models.llmCalls} | ${seconds(result.durationMs)} | ${escapeCell(truncate(result.summary, 140))} |`);
    }
    lines.push('');
    return lines;
}

interface IssueRow extends Issue {
    tests: string[];
}

function collectIssues(results: TestResult[]): IssueRow[] {
    const rows = new Map<string, IssueRow>();
    for (const result of results) {
        for (const issue of result.issues) {
            const key = `${issue.kind}|${issue.message}`;
            const row = rows.get(key) ?? { ...issue, count: 0, tests: [] };
            row.count += issue.count;
            if (!row.tests.includes(result.id)) { row.tests.push(result.id); }
            rows.set(key, row);
        }
    }
    const order = { high: 0, medium: 1, low: 2 };
    return [...rows.values()].toSorted((a, b) => order[a.severity] - order[b.severity] || b.tests.length - a.tests.length);
}

/** The run's own command narrowed to one test. */
export function reproduceCommand(command: string, id: string): string {
    return `${command.replace(/\s--(?:test|module|tag)(?:=|\s+)\S+/g, '')} --test ${id}`;
}

function escapeCell(text: string): string {
    return text.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function truncate(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Self-contained page: data is embedded, screenshots are referenced relative to the run directory. */
export async function htmlReport(summary: RunSummary): Promise<string> {
    const data = {
        ...summary,
        results: summary.results.map(result => ({
            ...result,
            attempts: result.attempts.map(attempt => ({ ...attempt, directory: relative(summary.directory, attempt.directory), trace: attempt.trace ? relative(summary.directory, attempt.trace) : undefined })),
        })),
        issues: collectIssues(summary.results),
        live: !summary.manifest.finishedAt,
    };
    const json = JSON.stringify(data).replaceAll('<', '\\u003c');
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>jevwright ${summary.manifest.runId}</title>
${data.live ? '<meta http-equiv="refresh" content="10">' : ''}
<style>
:root { --bg:#f7f7f5; --panel:#fff; --text:#1d1d1b; --muted:#6b6b66; --line:#e3e3de; --pass:#1f8a4c; --fail:#c9372c; --flaky:#b7791f; --skip:#8a8a85; --accent:#2b6cb0; --code:#f0f0ec; }
@media (prefers-color-scheme: dark) { :root { --bg:#141413; --panel:#1d1d1b; --text:#ecece8; --muted:#a3a39c; --line:#33332f; --pass:#4cc38a; --fail:#f2766b; --flaky:#e0b050; --skip:#8a8a85; --accent:#6aa8f0; --code:#262624; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
header { padding:20px 24px 12px; border-bottom:1px solid var(--line); background:var(--panel); position:sticky; top:0; z-index:2; }
h1 { font-size:18px; margin:0 0 4px; } h2 { font-size:15px; margin:24px 0 8px; }
.meta { color:var(--muted); font-size:12px; word-break:break-all; }
.totals { display:flex; flex-wrap:wrap; gap:8px; margin-top:10px; }
.chip { border:1px solid var(--line); border-radius:999px; padding:2px 10px; font-size:12px; background:var(--panel); cursor:pointer; color:var(--text); }
.chip[aria-pressed="true"] { border-color:var(--accent); color:var(--accent); }
main { padding:8px 24px 40px; max-width:1200px; margin:0 auto; }
.s-passed { color:var(--pass); } .s-failed { color:var(--fail); } .s-flaky { color:var(--flaky); } .s-known { color:var(--flaky); } .s-skipped { color:var(--skip); }
details.test { background:var(--panel); border:1px solid var(--line); border-radius:10px; margin:8px 0; }
details.test > summary { padding:10px 14px; cursor:pointer; display:grid; grid-template-columns:20px 1fr auto; gap:10px; align-items:baseline; list-style:none; }
details.test > summary::-webkit-details-marker { display:none; }
.tid { font-weight:600; } .sum { color:var(--muted); font-size:12px; grid-column:2 / 4; }
.body { padding:0 14px 14px; border-top:1px solid var(--line); }
.step { display:grid; grid-template-columns:minmax(0,1fr) 200px; gap:12px; padding:10px 0; border-bottom:1px dashed var(--line); }
.step:last-child { border-bottom:0; }
.step img { width:200px; border:1px solid var(--line); border-radius:6px; cursor:zoom-in; }
.label { font-weight:600; } .tag { font-size:11px; padding:1px 6px; border-radius:4px; background:var(--code); color:var(--muted); margin-left:6px; }
.err { color:var(--fail); white-space:pre-wrap; word-break:break-word; }
pre, code { background:var(--code); border-radius:6px; font:12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
pre { padding:8px; overflow:auto; max-height:260px; white-space:pre-wrap; word-break:break-word; }
table { width:100%; border-collapse:collapse; background:var(--panel); border:1px solid var(--line); border-radius:8px; overflow:hidden; }
th, td { text-align:left; padding:6px 10px; border-bottom:1px solid var(--line); font-size:13px; vertical-align:top; word-break:break-word; }
.small { font-size:12px; color:var(--muted); }
.hidden { display:none; }
dialog { border:0; padding:0; background:transparent; max-width:95vw; } dialog img { max-width:95vw; max-height:90vh; }
@media (max-width: 640px) { header, main { padding-left:16px; padding-right:16px; } .step { grid-template-columns:1fr; } .step img { width:100%; } }
</style>
</head>
<body>
<header><h1 id="title"></h1><div class="meta" id="meta"></div><div class="totals" id="totals"></div></header>
<main><div id="issues"></div><h2>Tests</h2><div id="tests"></div></main>
<dialog id="zoom"><img alt="Step screenshot"></dialog>
<script type="application/json" id="data">${json}</script>
<script>
const data = JSON.parse(document.getElementById('data').textContent);
const el = (tag, attrs = {}, ...children) => { const node = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (v === undefined || v === false) continue; if (k === 'class') node.className = v; else if (k.startsWith('on')) node.addEventListener(k.slice(2), v); else node.setAttribute(k, v); } for (const child of children.flat()) { if (child == null || child === false) continue; node.append(child instanceof Node ? child : document.createTextNode(String(child))); } return node; };
const icon = s => ({ passed: '✓', failed: '✗', flaky: '≈', known: '!', skipped: '–' })[s] || '?';
const secs = ms => (ms / 1000).toFixed(1) + 's';
const m = data.manifest, t = data.totals;
document.getElementById('title').textContent = 'jevwright · ' + m.runId + (data.live ? ' · running' : '');
document.getElementById('meta').textContent = [m.mode + ' mode' + (m.dryRun ? ' (dry run)' : ''), m.engine, m.git ? 'git ' + m.git.sha.slice(0, 10) + (m.git.dirty ? ' (dirty)' : '') : '', m.models ? m.models.jev + ' + ' + m.models.llm : 'no models', 'origin ' + m.origin, 'started ' + m.startedAt].filter(Boolean).join(' · ');
let filter = 'all';
const totals = document.getElementById('totals');
for (const [key, label] of [['all', t.tests + ' tests'], ['passed', t.passed + ' passed'], ['failed', t.failed + ' failed'], ['flaky', t.flaky + ' flaky'], ['known', (t.known || 0) + ' known'], ['skipped', t.skipped + ' skipped']]) {
  totals.append(el('button', { class: 'chip', 'aria-pressed': String(key === 'all'), onclick: e => { filter = key; for (const c of totals.querySelectorAll('.chip')) c.setAttribute('aria-pressed', String(c === e.currentTarget)); render(); } }, label));
}
totals.append(el('span', { class: 'chip' }, t.models.jevCalls + ' Jev / ' + t.models.llmCalls + ' LLM calls · ' + t.models.inputTokens.toLocaleString() + ' input tokens' + (t.models.cost ? ' · $' + t.models.cost.toFixed(4) : '')));
if (m.maxCostUsd !== undefined && t.models.cost >= m.maxCostUsd) totals.append(el('span', { class: 'chip s-failed' }, 'Run budget of $' + m.maxCostUsd + ' reached'));
if (data.issues.length) {
  const box = document.getElementById('issues');
  box.append(el('h2', {}, 'Potential product issues (implicit oracles)'));
  const table = el('table', {}, el('tr', {}, el('th', {}, 'Severity'), el('th', {}, 'Kind'), el('th', {}, 'Message'), el('th', {}, 'Tests')));
  for (const issue of data.issues) table.append(el('tr', {}, el('td', { class: issue.severity === 'high' ? 's-failed' : issue.severity === 'medium' ? 's-flaky' : '' }, issue.severity), el('td', {}, issue.kind), el('td', {}, issue.message, issue.detail ? el('div', { class: 'small' }, issue.detail) : null), el('td', {}, issue.tests.join(', '))));
  box.append(table);
}
const zoom = document.getElementById('zoom');
zoom.addEventListener('click', () => zoom.close());
function stepView(attempt, step) {
  const head = el('div', {}, el('span', { class: 'label s-' + step.status }, icon(step.status) + ' ' + (step.index + 1) + '. ' + step.label), step.source ? el('span', { class: 'tag' }, step.source) : null, step.likely ? el('span', { class: 'tag' }, 'likely') : null, el('span', { class: 'tag' }, secs(step.durationMs)), el('span', { class: 'tag' }, step.url));
  const body = [head];
  if (step.error) body.push(el('div', { class: 'err' }, step.error));
  if (step.replayMiss) body.push(el('div', { class: 'small' }, 'Recording no longer matched: ' + step.replayMiss));
  if (step.actions && step.actions.length) body.push(el('div', { class: 'small' }, 'Actions: ' + step.actions.map(a => (a.ok ? '' : '✗ ') + a.tool + (a.element ? ' ' + a.element : '') + (a.value ? ' ← ' + a.value : '') + ' [' + a.source + ']' + (a.error ? ' (' + a.error + ')' : '')).join(' → ')));
  if (step.rounds && step.rounds.length) body.push(el('details', {}, el('summary', { class: 'small' }, step.rounds.length + ' decision rounds'), el('pre', {}, step.rounds.map(r => 'r' + r.round + ' ' + r.source + ': ' + r.tool + (r.pTool !== undefined ? '(' + r.pTool + ')' : '') + (r.target ? ' → ' + r.target + ' (' + r.pTarget + ')' : '') + (r.value ? ' value=' + r.value : '') + (r.done !== undefined ? ' done=' + r.done : '') + (r.confirm !== undefined ? ' confirm=' + r.confirm : '') + (r.error !== undefined ? ' error=' + r.error : '') + (r.note ? ' — ' + r.note : '') + (r.candidates ? '\\n    candidates: ' + r.candidates.map(c => c.element + ' ' + c.p).join(' | ') : '')).join('\\n'))));
  if (step.busy && step.busy.length) body.push(el('div', { class: 'small' }, 'Slow to settle: ' + step.busy.join('; ')));
  if (step.writes && step.writes.length) body.push(el('div', { class: 'small' }, 'Writes: ' + step.writes.map(w => w.method + ' ' + w.path + ' → ' + w.status).join(', ')));
  if (step.evidence !== undefined) body.push(el('details', {}, el('summary', { class: 'small' }, 'Evidence'), el('pre', {}, JSON.stringify(step.evidence, null, 2))));
  const src = step.screenshot ? attempt.directory + '/' + step.screenshot : null;
  return el('div', { class: 'step' }, el('div', {}, body), src ? el('img', { src, loading: 'lazy', alt: 'After step ' + (step.index + 1), onclick: () => { zoom.querySelector('img').src = src; zoom.showModal(); } }) : el('div'));
}
function render() {
  const box = document.getElementById('tests');
  box.replaceChildren();
  for (const r of data.results) {
    if (filter !== 'all' && r.status !== filter) continue;
    const d = el('details', { class: 'test', open: r.status === 'failed' ? '' : undefined });
    d.append(el('summary', {}, el('span', { class: 's-' + r.status }, icon(r.status)), el('span', {}, el('span', { class: 'tid' }, r.id), r.module ? el('span', { class: 'tag' }, r.module) : null, r.cause ? el('span', { class: 'tag' }, r.cause) : null, r.reproduced ? el('span', { class: 'tag' }, 'failed ' + r.reproduced) : null), el('span', { class: 'small' }, secs(r.durationMs) + ' · ' + r.models.jevCalls + '+' + r.models.llmCalls + ' calls'), el('span', { class: 'sum' }, r.title + ' — ' + r.summary)));
    const body = el('div', { class: 'body' }, el('p', { class: 'small' }, 'Risk: ' + r.risk), r.knownIssue ? el('p', { class: 'small' }, (r.status === 'known' ? 'Known product issue: ' : 'Marked as a known issue, but it did not reproduce: ') + r.knownIssue) : null);
    if (r.issues.length) body.append(el('p', { class: 'small' }, 'Issues: ' + r.issues.map(i => i.severity + ' ' + i.kind + ': ' + i.message).join(' · ')));
    for (const a of r.attempts) {
      body.append(el('h2', {}, 'Attempt ' + a.attempt + ' · ' + a.status + (a.cause ? ' (' + a.cause + ')' : '') + ' · ' + secs(a.durationMs)), el('p', { class: 'small' }, a.summary + (a.trace ? ' · trace: ' + a.trace : '') + (a.events.length ? ' · events: ' + a.events.join('; ') : '')));
      for (const s of a.steps) body.append(stepView(a, s));
      if (a.invariants.length) body.append(el('p', { class: 'small' }, 'Invariants: ' + a.invariants.map(i => (i.passed ? '✓ ' : '✗ ') + i.name + ' @' + (i.step + 1)).join(', ')));
    }
    d.append(body);
    box.append(d);
  }
}
render();
</script>
</body>
</html>
`;
}
