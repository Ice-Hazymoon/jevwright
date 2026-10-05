/* eslint-disable no-console -- a measurement script whose output is its report */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

// Compare archived source trees without changing either checkout; use identical pages and fresh contexts.
const baseline = resolve(process.argv[2] ?? '/tmp/jevwright-hardening-main');
const candidate = resolve(process.argv[3] ?? '.');
const samples = Number(process.argv[4] ?? 3);
const table = Array.from({ length: 2000 }, (_, i) => `<tr>${Array.from({ length: 5 }, (_, c) => `<td>${c ? `${i}.${c}0` : `Item ${i}`}</td>`).join('')}</tr>`).join('');
const html = `<header><nav><a href="/a">Settings</a><a href="/b">Billing</a></nav></header><main><button><span>Save</span></button><p>Processing fee</p><progress value="40" max="100"></progress><table>${table}</table></main>`;
const browser = await chromium.launch();
const results: Record<string, { observe: number[]; settle: number[] }> = {};
try {
    for (const [name, root] of [['main', baseline], ['candidate', candidate]] as const) {
        const { newTestContext, settle } = await import(`${root}/src/browser.ts`);
        const { observe } = await import(`${root}/src/observe.ts`);
        const durations = { observe: [] as number[], settle: [] as number[] };
        for (let i = 0; i < samples; i++) {
            const context = await newTestContext(browser, { viewport: { width: 1280, height: 900 }, dialogs: 'accept' });
            try {
                const page = await context.newPage(); await page.setContent(html);
                let start = performance.now(); await settle(page, { pendingRequests: () => 0 }); durations.settle.push(performance.now() - start);
                start = performance.now(); await observe(page); durations.observe.push(performance.now() - start);
            } finally { await context.close(); }
        }
        results[name] = durations;
    }
} finally { await browser.close(); }
const median = (values: number[]) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]!;
const ratios = Object.fromEntries((['observe', 'settle'] as const).map(key => [key, median(results.candidate![key]) / median(results.main![key])]));
console.log(JSON.stringify({ samples, results, ratios }, null, 2));
for (const [key, ratio] of Object.entries(ratios)) { assert(ratio <= 1.5, `${key}: candidate/main ${ratio.toFixed(3)} exceeds 1.5`); }
