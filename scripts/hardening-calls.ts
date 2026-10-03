import assert from 'node:assert/strict';
import { resolve } from 'node:path';
const root = resolve(process.argv[2] ?? '.');
const rows = Number(process.argv[3] ?? 120);
const { chromium } = await import(`${root}/node_modules/playwright/index.mjs`);
const { newTestContext } = await import(`${root}/src/browser.ts`);
const { runAct } = await import(`${root}/src/act.ts`);
const tag = root.includes('worktrees') ? 'HEAD' : 'main';
const browser = await chromium.launch();
const context = await newTestContext(browser, { viewport: { width: 1280, height: 900 }, dialogs: 'accept' });
const page = await context.newPage();
const table = Array.from({ length: rows }, (_, i) => `<tr><td>Order ${1000 + i}</td><td>Shipped</td><td>$${i}.50</td></tr>`).join('');
await page.setContent(`<header><nav><a href="#a">Home</a><a href="#b">Orders</a></nav></header><main><h1>Profile</h1><label>Name <input id="n"></label><button id="s">Save</button><p id="out"></p><table>${table}</table></main><script>document.getElementById('s').onclick=()=>{document.getElementById('out').textContent='Saved'}</script>`);
const calls: Array<{ purpose: string; chars: number; questions: number }> = [];
const els = (state: any) => state.page?.elements ?? [];
const models = {
  async judge(state: any, questions: any, _signal: unknown, purpose: string) {
    calls.push({ purpose, chars: JSON.stringify(state).length + JSON.stringify(questions).length, questions: Object.keys(questions).length }); if (calls.length === 1) console.log("   state", JSON.stringify(state).length, "page_values", JSON.stringify(state.task?.page_values ?? []).length, Object.entries<any>(questions).map(([k, q]) => `${k}=${JSON.stringify(q).length}`).join(" "));
    const typed = (state.task?.history ?? []).some((h: any) => h.action === 'type');
    const saved = String(state.page?.text ?? '').includes('Saved');
    const out: Record<string, any> = {};
    for (const [id, q] of Object.entries<any>(questions)) {
      if (q.type === 'boolean') { out[id] = { type: 'boolean', probability: id === 'done' || id === 'done_change' || id === 'complete' ? (saved ? 0.95 : 0.05) : 0.02 }; continue; }
      const keys = Object.keys(q.criteria);
      let choice = keys[0];
      if (id === 'tool') choice = saved ? 'none' : typed ? 'click' : 'type';
      if (id === 'target') { const want = saved ? 'Save' : typed ? 'Save' : 'Name'; choice = String(els(state).find((e: any) => e.name === want)?.i ?? keys[0]); }
      if (id === 'remaining') choice = saved ? 'complete' : 'unfinished';
      if (id === 'navigation') choice = 'not_required';
      if (id === 'complete') choice = saved ? 'achieved' : 'pending';
      if (id === 'needed') choice = 'finished';
      if (id === 'input_source') choice = 'step';
      const probabilities = Object.fromEntries(keys.map(k => [k, k === choice ? 0.95 : 0.05 / Math.max(1, keys.length - 1)]));
      out[id] = { type: 'choice', choice, probabilities };
    }
    return out;
  },
  async generate() { calls.push({ purpose: 'llm', chars: 0, questions: 0 }); return { outcome: 'impossible', tool: null, element: null, value_key: null, text: null, reason: 'x' }; },
};
const monitor = { pendingRequests: () => 0, noteSettleCap: () => {}, issues: () => [], writes: () => [], requests: () => [], since: () => [], mark: () => 0 } as any;
const t = Date.now();
const result = await runAct({ page, monitor, models, signal: new AbortController().signal, stepIndex: 0, test: 't', instruction: 'Enter {name} in the Name field and save', values: { name: 'Ada' }, events: [] } as any);
console.log(`[${tag}] rows=${rows} status=${result.status} ${result.reason ?? ''} actions=${result.actions.map((a: any) => a.tool).join(',')} wall=${Date.now() - t}ms`);
for (const c of calls) console.log(`   ${c.purpose}: ${c.chars} chars, ${c.questions} questions`);
console.log(`   total Jev calls=${calls.length} total chars=${calls.reduce((s, c) => s + c.chars, 0)}`);
await browser.close();
const chars = calls.reduce((sum, call) => sum + call.chars, 0);
console.log(JSON.stringify({ status: result.status, calls: calls.length, chars, limits: { calls: 4.5, chars: 28453.5 } }));
assert.equal(result.status, 'done');
assert(calls.length <= 4.5, 'calls exceed main +50%');
assert(chars <= 28453.5, 'characters exceed main +50%');
