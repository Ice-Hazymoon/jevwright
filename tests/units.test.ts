import type { MonitorOptions } from '../src/monitor.ts';
import type { Observation, PageElement } from '../src/observe.ts';
import type { AddressInfo } from 'node:net';
import type { Browser, Page } from 'playwright';
import { Experimental_EvaluationMockModelV4, MockLanguageModelV4 } from 'ai/test';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { insertedText, pageChange, repeatsBlock } from '../src/act.ts';
import { launchBrowser, newTestContext, perform, settle } from '../src/browser.ts';
import { main } from '../src/cli.ts';
import { createModels, gatewayFromEnv } from '../src/models.ts';
import { createMonitor, matchesWrite } from '../src/monitor.ts';
import { buildObservation, observe } from '../src/observe.ts';
import { describeTarget, resolveTarget } from '../src/recording.ts';
import { serveReport } from '../src/serve.ts';
import { fillTemplate, templateKeys } from '../src/spec.ts';
import { VERSION } from '../src/version.ts';
import { startFixtureApp } from './fixtures/app.ts';

let app: Awaited<ReturnType<typeof startFixtureApp>>;
let browser: Browser;
let closeBrowser: () => Promise<void>;

beforeAll(async () => {
    app = await startFixtureApp();
    ({ browser, close: closeBrowser } = await launchBrowser({ allowedOrigins: [app.origin] }));
});
afterAll(async () => {
    await closeBrowser?.();
    await app?.close();
});

async function open(path: string, run?: (page: Page) => Promise<void>, monitorOptions: Partial<MonitorOptions> = {}) {
    const context = await newTestContext(browser, { viewport: { width: 1280, height: 900 }, dialogs: 'accept' });
    const monitor = createMonitor(context, { origin: app.origin, i18nKeys: new Set(['settings.profile.title']), ...monitorOptions });
    const page = await context.newPage();
    await page.goto(new URL(path, app.origin).toString());
    await settle(page, monitor);
    await run?.(page);
    if (run) { await settle(page, monitor); }
    const observation = await observe(page);
    await monitor.scanText(page);
    const issues = monitor.issues();
    const writes = [...monitor.writes];
    await context.close();
    return { observation, issues, writes };
}

const named = (observation: Observation, role: string, name: string) => observation.elements.filter(element => element.role === role && element.name === name);

describe('observe', () => {
    it('labels generically named switches with their visible row text', async () => {
        const { observation } = await open('/settings');
        const switches = named(observation, 'switch', 'Toggle setting');
        expect(switches.map(element => [element.near, element.states])).toEqual([
            ['Product news', ['checked']],
            ['Weekly digest', ['unchecked']],
            ['Security alerts', ['checked']],
        ]);
    });

    it('distinguishes same-named row actions by row context', async () => {
        const { observation } = await open('/items');
        const buttons = named(observation, 'button', 'Archive');
        expect(buttons).toHaveLength(3);
        expect(buttons.map(button => button.context)).toEqual([
            expect.stringContaining('Alpha plan'),
            expect.stringContaining('Beta plan'),
            expect.stringContaining('Gamma plan'),
        ]);
    });

    it('restricts the observation to an open modal dialog', async () => {
        const { observation } = await open('/items', page => page.getByRole('button', { name: 'Archive' }).nth(1).click());
        expect(observation.dialog).toBe('alertdialog "Archive plan?"');
        expect(observation.text).toContain('Archive Beta plan?');
        expect(observation.elements.filter(element => element.role === 'button').map(element => element.name).sort()).toEqual(['Archive plan', 'Cancel']);
    });

    it('reports field values, disabled state and select options', async () => {
        const profile = (await open('/profile')).observation;
        expect(named(profile, 'textbox', 'Nickname')[0]).toMatchObject({ value: 'Ada' });
        expect(named(profile, 'button', 'Save profile')[0]).toMatchObject({ disabled: true });
        expect(named(profile, 'button', 'Save profile')[0]!.ref).toBeUndefined();
        const currency = (await open('/currency')).observation;
        expect(named(currency, 'combobox', 'Display currency')[0]).toMatchObject({ value: 'US dollar', options: ['US dollar', 'Euro', 'Japanese yen'] });
    });

    it('keeps line breaks in field values', () => {
        const observation = buildObservation([{ role: 'textbox', name: 'Bio', ref: 'e1', text: '東京で制作\n  Design for everyone' }], { url: 'http://fixture.test/p', title: '', viewport: { width: 1280, height: 900 } });
        expect(observation.elements[0]).toMatchObject({ name: 'Bio', value: '東京で制作\nDesign for everyone' });
    });

    it('ignores a route announcer that repeats the page title', () => {
        const observation = buildObservation([
            { role: 'main', children: ['Your orders'] },
            { role: 'status', children: ['Your orders · Shop'] },
            { role: 'status', children: ['Order refunded'] },
        ], { url: 'http://fixture.test/orders', title: 'Your orders · Shop', viewport: { width: 1280, height: 900 } });
        expect(observation.notices).toEqual(['Order refunded']);
        expect(observation.text).not.toContain('· Shop');
    });

    it('lists controls that only take pointer events on hover as targetable', async () => {
        const { observation } = await open('/cards');
        const [customize] = named(observation, 'button', 'Customize Alpha card');
        expect(customize).toMatchObject({ reveal: true, context: expect.stringContaining('Tools for Alpha card') });
        expect(customize!.ref).toBeUndefined();
    });

    it('keeps the exact text of a text field, line breaks included', async () => {
        const { observation } = await open('/profile', page => page.getByRole('textbox', { name: 'Bio' }).fill('東京で制作\nDesign for everyone — 欢迎'));
        expect(named(observation, 'textbox', 'Bio')[0]).toMatchObject({ value: '東京で制作\nDesign for everyone — 欢迎' });
    });

    it('keeps the visible content of a hover card whose aria-label hides it', async () => {
        const { observation } = await open('/cards');
        expect(named(observation, 'button', 'Alpha widget')[0]).toMatchObject({ content: 'Alpha content lives here' });
        expect(observation.text).toContain('Alpha content lives here');
    });

    it('never reports a form field\'s markup (textarea text, select options) as hidden content', async () => {
        const { observation } = await open('/cards', page => page.getByRole('textbox', { name: 'Card note' }).fill('Changed note'));
        const [note] = named(observation, 'textbox', 'Card note');
        expect(note).toMatchObject({ value: 'Changed note' });
        expect(note!.content).toBeUndefined();
        const [size] = named(observation, 'combobox', 'Card size');
        expect(size).toMatchObject({ value: 'Large' });
        expect(size!.content).toBeUndefined();
        expect(observation.text).not.toContain('Small Large');
    });

    it('does not offer the controls of a collapsed, inert panel until it is expanded', async () => {
        const collapsed = await open('/sections');
        expect(named(collapsed.observation, 'button', 'Add a price')).toEqual([]);
        const expanded = await open('/sections', page => page.getByRole('button', { name: 'Pricing' }).click());
        expect(named(expanded.observation, 'button', 'Add a price')).toHaveLength(1);
    });

    it('keeps offering a card whose face is an inert preview of the same size', async () => {
        const { observation } = await open('/sections');
        expect(named(observation, 'button', 'Cover')).toHaveLength(1);
    });

    it('surfaces status notices', async () => {
        const { observation, writes } = await open('/currency', page => page.getByRole('button', { name: 'Save currency' }).click());
        expect(observation.notices).toContain('Currency saved');
        expect(writes).toMatchObject([{ method: 'POST', path: '/api/currency', status: 200, step: -1 }]);
    });
});

describe('settle', () => {
    it('treats continuous style and SVG animation as quiet', async () => {
        const context = await newTestContext(browser, { viewport: { width: 1280, height: 900 }, dialogs: 'accept' });
        const monitor = createMonitor(context, { origin: app.origin });
        const page = await context.newPage();
        await page.goto(new URL('/animated', app.origin).toString());
        const waited = await settle(page, monitor, { maxMs: 4000 });
        await context.close();
        expect(waited).toBeLessThan(2000);
        expect(monitor.settleCaps).toEqual([]);
    });

    it('waits for the page\'s own code that is still downloading before calling the page ready', async () => {
        const { observation } = await open('/board');
        expect(named(observation, 'button', 'Note')).toHaveLength(1);
    });
});

describe('monitor', () => {
    it('reports uncaught errors, broken text and raw translation keys', async () => {
        const { issues } = await open('/broken');
        expect(issues.map(issue => [issue.kind, issue.severity])).toEqual(expect.arrayContaining([
            ['page-error', 'high'],
            ['text-anomaly', 'medium'],
            ['raw-i18n-key', 'medium'],
        ]));
    });

    it('reports Vue hydration mismatches with the server and client values', async () => {
        const { issues } = await open('/profile', page => page.evaluate(() => {
            // Shape of Vue's dev warning for an SSR/client text mismatch.
            Reflect.get(console, 'warn').call(console, '[Vue warn]: Hydration text content mismatch on <span>\n  - rendered on server: 10:00 AM\n  - expected on client: 2:00 PM');
        }));
        expect(issues).toEqual(expect.arrayContaining([expect.objectContaining({
            kind: 'hydration-mismatch',
            message: 'Hydration text content mismatch on <span> on /profile',
            detail: expect.stringContaining('rendered on server: 10:00 AM'),
        })]));
    });

    it('names the mismatched element and folds Vue\'s hydration summary error into the mismatch', async () => {
        const { issues } = await open('/profile', page => page.evaluate(() => {
            // Vue passes the DOM node as its own argument; Playwright's message text shows it as JSHandle@node.
            Reflect.get(console, 'warn').call(console, '[Vue warn]: Hydration class mismatch on', document.getElementById('save'), '\n  - rendered on server: class="a"\n  - expected on client: class="a b"');
            Reflect.get(console, 'error').call(console, 'Hydration completed but contains mismatches.');
        }));
        const hydration = issues.filter(issue => issue.kind === 'hydration-mismatch');
        expect(hydration.map(issue => issue.message)).toEqual(['Hydration class mismatch on <button#save> on /profile']);
        expect(issues.filter(issue => issue.kind === 'console-error')).toEqual([]);
    });

    it('treats a host network change as environment noise, not a console error', async () => {
        const { issues } = await open('/profile', page => page.evaluate(() => {
            Reflect.get(console, 'error').call(console, 'Failed to load resource: net::ERR_NETWORK_CHANGED');
        }));
        expect(issues.filter(issue => issue.kind === 'console-error')).toEqual([]);
    });

    it('reports the app failing to download its own code as asset-load, not a page error', async () => {
        const { issues } = await open('/stale-chunk');
        expect(issues).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'asset-load', severity: 'high', message: expect.stringContaining('/_nuxt/missing.js') })]));
        expect(issues.filter(issue => issue.kind === 'page-error')).toEqual([]);
    });

    it('reports a full-page server error screen even without a failed request', async () => {
        const { issues } = await open('/crash-screen');
        expect(issues).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'ui-error', severity: 'high' })]));
    });

    it('reports server errors on writes', async () => {
        const { issues, writes } = await open('/profile?bug=500', async (page) => {
            await page.getByRole('textbox', { name: 'Nickname' }).fill('X');
            await page.getByRole('button', { name: 'Save profile' }).click();
        });
        expect(writes).toMatchObject([{ path: '/api/profile', status: 500 }]);
        expect(issues).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'http-5xx', message: 'POST /api/profile → 500' })]));
    });

    it('reports a request the app did not answer as app-unreachable, not as a server error', async () => {
        // An app of its own, stopped under an open page: the browser's proxy answers 594 Connection Refused.
        const down = await startFixtureApp();
        const own = await launchBrowser({ allowedOrigins: [down.origin] });
        try {
            const context = await newTestContext(own.browser, { viewport: { width: 1280, height: 900 }, dialogs: 'accept' });
            const monitor = createMonitor(context, { origin: down.origin });
            const page = await context.newPage();
            await page.goto(new URL('/profile', down.origin).toString());
            await settle(page, monitor);
            await down.close();
            await page.getByRole('textbox', { name: 'Nickname' }).fill('X');
            await page.getByRole('button', { name: 'Save profile' }).click();
            await settle(page, monitor);
            expect(monitor.issues()).toEqual([expect.objectContaining({ kind: 'app-unreachable', severity: 'high', message: 'POST /api/profile → 594: the app did not answer (Connection Refused)' })]);
        } finally {
            await own.close();
        }
    });

    it('tracks writes and server errors on the app\'s other origins, and only on those', async () => {
        const api = `http://localhost:${new URL(app.origin).port}`;
        const postToApi = async (page: Page) => {
            await page.context().route(`${api}/api/**`, route => route.fulfill({ status: 500, body: '' }));
            await page.evaluate(url => fetch(url, { method: 'POST', mode: 'no-cors', body: 'x' }).catch(() => undefined), `${api}/api/orders`);
        };
        const allowed = await open('/profile', postToApi, { allowedOrigins: [api] });
        expect(allowed.writes).toMatchObject([{ method: 'POST', path: '/api/orders', status: 500 }]);
        expect(allowed.issues).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'http-5xx', message: `POST ${new URL(api).host}/api/orders → 500` })]));
        const other = await open('/profile', postToApi);
        expect(other.writes).toEqual([]);
        expect(other.issues.filter(issue => issue.kind === 'http-5xx')).toEqual([]);
    });

    it('does not report a request the test declares it aborts, nor its console line, but still reports an undeclared one', async () => {
        const abortSave = async (page: Page) => {
            await page.context().route('**/api/profile', route => route.abort('failed'));
            await page.getByRole('textbox', { name: 'Nickname' }).fill('X');
            await page.getByRole('button', { name: 'Save profile' }).click();
            await page.waitForTimeout(300); // Chromium's "Failed to load resource" console line arrives async
        };
        const declared = await open('/profile', abortSave, { expectedAborts: [{ method: 'POST', path: '/api/profile' }] });
        expect(declared.issues.filter(issue => issue.kind === 'request-failed' || issue.kind === 'console-error')).toEqual([]);

        const undeclared = await open('/profile', abortSave);
        expect(undeclared.issues).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'request-failed', message: 'POST /api/profile: net::ERR_FAILED' }),
            expect.objectContaining({ kind: 'console-error', message: 'Failed to load resource: net::ERR_FAILED' }),
        ]));
    });

    it('records the status of a write that is followed by an immediate reload', async () => {
        const { writes, observation } = await open('/items', async (page) => {
            await page.getByRole('button', { name: 'Archive' }).nth(1).click();
            await Promise.all([page.waitForEvent('load'), page.getByRole('button', { name: 'Archive plan' }).click()]);
        });
        expect(writes).toMatchObject([{ method: 'POST', path: '/api/items/b/archive', status: 200 }]);
        // Table cells expose their content as accessible names; it must reach the page text.
        expect(observation.text.replace(/ · /g, ' ')).toContain('Beta plan Archived');
    });

    it('matches write expectations by method, path and status', () => {
        // Without a declared status a write must succeed; 200, 201 and 204 are all success.
        expect(matchesWrite({ method: 'post', path: '/api/a' }, 'POST', '/api/a', 204)).toBe(true);
        expect(matchesWrite({ method: 'post', path: '/api/a' }, 'POST', '/api/a', 409)).toBe(false);
        expect(matchesWrite({ method: 'post', path: '/api/a' }, 'POST', '/api/a', 500)).toBe(false);
        expect(matchesWrite({ path: /\/archive$/, status: [200, 204] }, 'POST', '/api/items/b/archive', 204)).toBe(true);
        expect(matchesWrite({ path: '/api/a', status: 200 }, 'POST', '/api/a', 409)).toBe(false);
        expect(matchesWrite({ method: 'PUT', path: '/api/a' }, 'POST', '/api/a')).toBe(false);
    });
});

describe('recording targets', () => {
    const element = (i: number, fields: Partial<PageElement>): PageElement => ({ i, ref: `e${i}`, role: 'button', name: 'Archive', ...fields });
    const observation = (elements: PageElement[]) => ({ url: '/', title: '', notices: [], headings: [], text: '', elements, omitted: 0, signature: '' }) as Observation;
    const rows = [element(0, { context: 'row "Alpha plan"' }), element(1, { context: 'row "Beta plan"' }), element(2, { context: 'row "Gamma plan"' })];

    it('resolves by row context even after rows are reordered', () => {
        const target = describeTarget(rows[1]!, observation(rows));
        const reordered = observation([rows[2]!, rows[1]!, rows[0]!].map((row, i) => ({ ...row, i })));
        expect(resolveTarget(target, reordered)?.context).toBe('row "Beta plan"');
    });

    it('matches a recorded row whose text carries per-run URLs and ids', () => {
        const links = (port: number, codes: [string, string]) => [
            element(0, { name: 'Archive link', context: `row "Launch link http://127.0.0.1:${port}/r/${codes[0]} Copy link" › table "Short links"` }),
            element(1, { name: 'Archive link', context: `row "Spring link http://127.0.0.1:${port}/r/${codes[1]} Copy link" › table "Short links"` }),
        ];
        const recorded = links(38289, ['57g467f99g', 'k2m8q4w7zz']);
        const target = describeTarget(recorded[0]!, observation(recorded));
        const next = links(41777, ['x9p3v6b2nn', 'h4d7s1r8tt']);
        expect(resolveTarget(target, observation([next[1]!, next[0]!]))?.context).toContain('Launch link');
    });

    it('matches a recorded row whose text carries the date or time it was recorded', () => {
        const campaigns = (when: string, first = 'Existing campaign', second = 'Autumn launch') => [
            element(0, { name: 'Rename campaign', context: `row "${first} 1 0 ${when} Rename campaign…" › table "Campaigns"` }),
            element(1, { name: 'Rename campaign', context: `row "${second} 1 1 ${when} Rename campaign…" › table "Campaigns"` }),
        ];
        const replays: Array<[recorded: string, today: string]> = [
            ['2026-09-27', '2026-09-28'],
            ['Sep 27, 2026', 'Sep 28, 2026'],
            ['27 September 2026', '28 September 2026'],
            ['9/27/2026', '9/28/2026'],
            ['2026年9月27日', '2026年9月28日'],
            ['10:15 AM', '9:02 PM'],
            ['3 minutes ago', '2 hours ago'],
        ];
        for (const [recorded, today] of replays) {
            const target = describeTarget(campaigns(recorded)[1]!, observation(campaigns(recorded)));
            expect(resolveTarget(target, observation(campaigns(today)))?.context, recorded).toContain('Autumn launch');
        }
        // Numbers that are not dates still tell rows apart.
        const markets = campaigns('', 'Market 12', 'Market 13');
        expect(resolveTarget(describeTarget(markets[1]!, observation(markets)), observation([markets[1]!, markets[0]!]))?.context).toContain('Market 13');
    });

    it('refuses to guess among look-alikes when the recorded context is gone', () => {
        const target = describeTarget(rows[1]!, observation(rows));
        expect(resolveTarget(target, observation([rows[0]!, rows[2]!]))).toBeUndefined();
    });

    it('falls back to a unique role and name when surrounding text changed', () => {
        const save = element(0, { name: 'Save profile', near: 'Bio' });
        expect(resolveTarget(describeTarget(save, observation([save])), observation([{ ...save, near: 'About you' }]))?.name).toBe('Save profile');
    });
});

describe('spec templates and loop helpers', () => {
    it('quotes data values and rejects unknown keys', () => {
        expect(fillTemplate('Set Bio to {bio}', { bio: 'a "b"\nc' })).toBe('Set Bio to "a \\"b\\"\\nc"');
        expect(() => fillTemplate('Set {missing}', {})).toThrow(/Unknown data key/);
        expect(templateKeys('{a} then {b} and {a}')).toEqual(['a', 'b']);
    });

    it('detects repeated action blocks but not progress', () => {
        const click = (element: string) => ({ action: 'click', element });
        expect(repeatsBlock([click('A'), click('B'), click('A'), click('B'), click('A'), click('B')], 2, 3)).toBe(true);
        expect(repeatsBlock([click('A'), click('B'), click('C'), click('D'), click('E'), click('F')], 2, 3)).toBe(false);
        expect(repeatsBlock([click('A'), click('A'), click('A'), click('A'), click('A'), click('A')], 2, 3)).toBe(false);
    });

    it('describes what an action changed', () => {
        expect(insertedText('Profile Nickname Bio', 'Profile Nickname Bio Profile saved')).toBe('Profile saved');
        const before = { url: '/p', title: '', notices: [], headings: [], text: 'a', omitted: 0, signature: '1', elements: [{ i: 0, ref: 'e1', role: 'switch', name: 'Toggle', near: 'Weekly digest', states: ['unchecked'] }] } as Observation;
        const after = { ...before, notices: ['Preferences updated'], signature: '2', elements: [{ ...before.elements[0]!, states: ['checked'] }] } as Observation;
        expect(pageChange(before, after)).toEqual({
            changed: ['switch "Toggle" near "Weekly digest": unchecked -> checked'],
            new_notices: ['Preferences updated'],
        });
    });
});

describe('models', () => {
    it('prefers the OpenRouter key and falls back to the Vercel AI Gateway', () => {
        expect(gatewayFromEnv({ OPENROUTER_API_KEY: 'or', VERCEL_AI_GATEWAY_API_KEY: 'v' })).toEqual({ provider: 'openrouter', apiKey: 'or' });
        expect(gatewayFromEnv({ VERCEL_AI_GATEWAY_API_KEY: 'v' })).toEqual({ provider: 'vercel', apiKey: 'v' });
        expect(gatewayFromEnv({ AI_GATEWAY_API_KEY: 'v2', OPENROUTER_API_KEY: ' ' })).toEqual({ provider: 'vercel', apiKey: 'v2' });
        expect(gatewayFromEnv({})).toBeUndefined();
    });

    it('reads choice confidence and request cost from OpenRouter metadata', async () => {
        const evaluation = new Experimental_EvaluationMockModelV4({
            doEvaluate: async () => ({
                answers: { pick: { type: 'choice', choice: 'a', probabilities: { a: 0.8, b: 0.2 } } },
                usage: { inputTokens: 10, outputTokens: 1 },
                warnings: [],
                providerMetadata: { openrouter: { answers: { pick: { confidence: 0.7 } }, usage: { cost: 0.0004 } } },
            }),
        });
        const language = new MockLanguageModelV4({
            doGenerate: async () => ({
                content: [{ type: 'text', text: '{"ok":true}' }],
                finishReason: { unified: 'stop', raw: 'stop' },
                usage: { inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } },
                warnings: [],
                providerMetadata: { openrouter: { usage: { cost: 0.0001 } } },
            }),
        });
        const models = createModels({ apiKey: 'offline', models: { evaluation, language } });
        const signal = new AbortController().signal;
        const answers = await models.judge({ text: 'x' }, { pick: { type: 'choice', instructions: 'Pick', criteria: { a: 'A', b: 'B' } } }, signal, 'test');
        expect(answers.pick).toMatchObject({ type: 'choice', choice: 'a', confidence: 0.7 });
        await models.generate('system', 'prompt', z.object({ ok: z.boolean() }), signal, 'test');
        expect(models.usage.cost).toBeCloseTo(0.0005, 10);
        expect(models.calls.map(call => call.cost)).toEqual([0.0004, 0.0001]);
    });
});

describe('model answers', () => {
    const signal = new AbortController().signal;
    const choice = { pick: { type: 'choice', instructions: 'Pick', criteria: { a: 'A', b: 'B', c: 'C' } } } as const;
    const language = (texts: string[]) => {
        let call = 0;
        return new MockLanguageModelV4({
            doGenerate: async () => ({
                content: [{ type: 'text', text: texts[Math.min(call++, texts.length - 1)]! }],
                finishReason: { unified: 'stop', raw: 'stop' },
                usage: { inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } },
                warnings: [],
            }),
        });
    };

    it('accepts a choice that ties the top option within the provider rounding', async () => {
        const evaluation = new Experimental_EvaluationMockModelV4({
            doEvaluate: async () => ({
                answers: { pick: { type: 'choice', choice: 'a', probabilities: { a: 0.49, b: 0.5, c: 0.01 } } },
                rounding: { probabilityDecimals: 2 },
                warnings: [],
            }),
        });
        const models = createModels({ apiKey: 'offline', models: { evaluation, language: language(['{}']) } });
        const answers = await models.judge({ text: 'x' }, choice, signal, 'test');
        expect(answers.pick).toMatchObject({ type: 'choice', choice: 'b' });
    });

    it('retries helper output that does not parse once, and reports the raw text when it never does', async () => {
        const evaluation = new Experimental_EvaluationMockModelV4({ doEvaluate: async () => ({ answers: {}, warnings: [] }) });
        const schema = z.object({ ok: z.boolean() });
        const recovered = createModels({ apiKey: 'offline', models: { evaluation, language: language(['Sure! {"ok": tr', '{"ok":true}']) } });
        await expect(recovered.generate('system', 'prompt', schema, signal, 'test')).resolves.toEqual({ ok: true });
        const broken = createModels({ apiKey: 'offline', models: { evaluation, language: language(['Sure! {"ok": tr']) } });
        await expect(broken.generate('system', 'prompt', schema, signal, 'test')).rejects.toThrow(/Sure! \{"ok": tr/);
    });

    it('retries a helper call that ends without any output once', async () => {
        const evaluation = new Experimental_EvaluationMockModelV4({ doEvaluate: async () => ({ answers: {}, warnings: [] }) });
        let calls = 0;
        const empty = new MockLanguageModelV4({
            doGenerate: async () => {
                const first = calls++ === 0;
                return {
                    content: first ? [] : [{ type: 'text', text: '{"ok":true}' }],
                    finishReason: first ? { unified: 'length', raw: 'length' } : { unified: 'stop', raw: 'stop' },
                    usage: { inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } },
                    warnings: [],
                };
            },
        });
        const models = createModels({ apiKey: 'offline', models: { evaluation, language: empty } });
        await expect(models.generate('system', 'prompt', z.object({ ok: z.boolean() }), signal, 'test')).resolves.toEqual({ ok: true });
        expect(calls).toBe(2);
    });
});

const ROOT = join(import.meta.dirname, '..');
const SRC = JSON.stringify(join(ROOT, 'src/index.ts'));
const FIXTURE_APP = JSON.stringify(join(ROOT, 'tests/fixtures/app.ts'));
const projects: string[] = [];
afterAll(async () => { await Promise.all(projects.map(dir => rm(dir, { recursive: true, force: true }))); });

/** A throwaway project directory holding the given files. */
async function project(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'jevwright-cli-'));
    projects.push(dir);
    for (const [path, text] of Object.entries(files)) {
        await mkdir(dirname(join(dir, path)), { recursive: true });
        await writeFile(join(dir, path), text);
    }
    return dir;
}

async function cli(dir: string, argv: string[], env: Record<string, string | undefined> = {}) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(argv, { cwd: dir, env, stdout: text => stdout.push(text), stderr: text => stderr.push(text) });
    return { code, stdout: stdout.join(''), stderr: stderr.join(''), env };
}

const profileTests = `
const saveTest = (id: string, extra: Record<string, unknown> = {}) => defineTest({
    id, title: 'Save the profile', risk: 'Saved changes are lost', start: '/profile', data: { nickname: 'Ada' },
    steps: () => [act('Change Nickname to {nickname}'), reload(), check('The Nickname field shows {nickname}')],
    ...extra,
});`;

describe('cli', () => {
    it('lists the tests a TypeScript config defines, narrowed by the filters', async () => {
        const dir = await project({ 'jevwright.config.ts': `import { act, check, defineConfig, defineTest, reload } from ${SRC};${profileTests}
export default defineConfig({ baseURL: 'http://localhost:3000', tests: [saveTest('profile-save', { module: 'profile' }), saveTest('profile-clear', { module: 'profile', tags: ['smoke'] }), saveTest('billing-pay', { module: 'billing' })] });` });
        const byPrefix = await cli(dir, ['list', '--test', 'profile-*']);
        expect(byPrefix).toMatchObject({ code: 0, stdout: expect.stringContaining('2 tests') });
        expect(byPrefix.stdout).not.toContain('billing-pay');
        const byTag = await cli(dir, ['list', '--tag', 'smoke']);
        expect(byTag.stdout).toMatch(/^profile-clear\s+profile\s+smoke\s+Save the profile\n1 test\n$/);
    });

    it('names a requested test id that matches nothing', async () => {
        const dir = await project({ 'jevwright.config.ts': `import { act, check, defineConfig, defineTest, reload } from ${SRC};${profileTests}
export default defineConfig({ baseURL: 'http://localhost:3000', tests: [saveTest('profile-save')] });` });
        expect(await cli(dir, ['list', '--test', 'profile-save,prfile-typo'])).toMatchObject({ code: 2, stderr: expect.stringContaining('"prfile-typo"') });
    });

    it('lists every authoring mistake before anything starts', async () => {
        const dir = await project({ 'jevwright.config.ts': `import { act, check, defineConfig, defineTest, reload } from ${SRC};${profileTests}
export default defineConfig({ baseURL: 'http://localhost:3000', tests: [saveTest('profile-save'), saveTest('profile-save'), saveTest('no-risk', { risk: '' }), saveTest('no-data', { data: {} })] });` });
        const { code, stderr } = await cli(dir, ['list']);
        expect(code).toBe(2);
        expect(stderr).toContain('"profile-save": another test has the same id');
        expect(stderr).toContain('"no-risk": risk is required');
        expect(stderr).toContain('"no-data": a step uses {nickname}, but data has no "nickname"');
    });

    it('points at each config field that is wrong', async () => {
        const dir = await project({ 'jevwright.config.ts': `import { defineConfig } from ${SRC};
export default defineConfig({ baseURL: 'http://localhost:3000/app', tests: [], retries: -1, concurency: 2 } as never);` });
        const { code, stderr } = await cli(dir, ['list']);
        expect(code).toBe(2);
        expect(stderr).toMatch(/baseURL: expected an origin such as http:\/\/localhost:3000, without a path/);
        expect(stderr).toMatch(/retries: .*>=0/);
        expect(stderr).toContain('concurency');
    });

    it('asks for a default export when the config file has none', async () => {
        const dir = await project({ 'jevwright.config.ts': `export const config = { tests: [] };` });
        expect(await cli(dir, ['list'])).toMatchObject({ code: 2, stderr: expect.stringContaining('has no default export') });
    });

    it('stops before the browser starts when nothing answers at the base URL', async () => {
        const closed = await new Promise<number>((resolvePort) => {
            const server = createServer().listen(0, '127.0.0.1', () => {
                const { port } = server.address() as AddressInfo;
                server.close(() => resolvePort(port));
            });
        });
        const dir = await project({ 'jevwright.config.ts': `import { act, check, defineConfig, defineTest, reload } from ${SRC};${profileTests}
export default defineConfig({ tests: [saveTest('profile-save')] });` });
        const { code, stderr } = await cli(dir, ['run', '--dry-run', '--base-url', `http://127.0.0.1:${closed}`]);
        expect(code).toBe(2);
        expect(stderr).toContain(`Nothing answers at http://127.0.0.1:${closed} (ECONNREFUSED)`);
        expect(existsSync(join(dir, '.jevwright'))).toBe(false);
    });

    it('tears down what setup started even when the base URL it returns is unusable', async () => {
        const dir = await project({ 'jevwright.config.ts': `import { writeFileSync } from 'node:fs';
import { act, check, defineConfig, defineTest, reload } from ${SRC};${profileTests}
export default defineConfig({
    setup: async () => ({ baseURL: 'http://127.0.0.1:4173/app', teardown: () => writeFileSync(new URL('torn-down', import.meta.url), 'yes') }),
    tests: [saveTest('profile-save')],
});` });
        const { code, stderr } = await cli(dir, ['run', '--dry-run']);
        expect(code).toBe(2);
        expect(stderr).toContain('setup() baseURL: expected an origin such as http://127.0.0.1:4173, without a path');
        expect(existsSync(join(dir, 'torn-down'))).toBe(true);
    });

    it('refuses an AI run without a model key and names the runs that need none', async () => {
        const dir = await project({ 'jevwright.config.ts': `import { act, check, defineConfig, defineTest, reload } from ${SRC};${profileTests}
export default defineConfig({ baseURL: 'http://localhost:3000', tests: [saveTest('profile-save')] });` });
        const { code, stderr } = await cli(dir, ['run']);
        expect(code).toBe(2);
        expect(stderr).toMatch(/OPENROUTER_API_KEY.*--mode replay.*--dry-run/s);
    });

    it('takes model keys from --env-file without overriding a variable already set', async () => {
        const dir = await project({ '.env': 'OPENROUTER_API_KEY="from-file"\nREGION=file\n', 'jevwright.config.ts': `import { act, check, defineConfig, defineTest, reload } from ${SRC};${profileTests}
export default defineConfig({ baseURL: 'http://localhost:3000', tests: [saveTest('profile-save')] });` });
        const { env } = await cli(dir, ['list', '--env-file', '.env'], { REGION: 'shell' });
        expect(env).toMatchObject({ OPENROUTER_API_KEY: 'from-file', REGION: 'shell' });
    });

    it('needs --test to author with --new', async () => {
        const dir = await project({ 'jevwright.config.ts': `import { act, check, defineConfig, defineTest, reload } from ${SRC};${profileTests}
export default defineConfig({ baseURL: 'http://localhost:3000', tests: [saveTest('profile-save')] });` });
        expect(await cli(dir, ['run', '--new'], { OPENROUTER_API_KEY: 'key' })).toMatchObject({ code: 2, stderr: expect.stringContaining('--new needs --test') });
    });

    it('starts the app with setup, hands its env to fixtures, keeps its server log and tears it down', async () => {
        const dir = await project({ 'jevwright.config.ts': `import { writeFileSync } from 'node:fs';
import { act, check, defineConfig, defineTest, reload } from ${SRC};
import { startFixtureApp } from ${FIXTURE_APP};
export default defineConfig({
    async setup() {
        const app = await startFixtureApp();
        return { baseURL: app.origin, env: { marker: 'from-setup' }, serverLog: () => 'server says hi', teardown: async () => { await app.close(); writeFileSync(new URL('torn-down', import.meta.url), 'yes'); } };
    },
    tests: [defineTest({
        id: 'profile-open', title: 'Open the profile', risk: 'The profile page does not load', start: '/profile',
        fixture: async ({ env }) => { if ((env as { marker?: string }).marker !== 'from-setup') { throw new Error('env missing'); } },
        steps: () => [reload()],
    })],
});` });
        const result = await cli(dir, ['run', '--dry-run']);
        expect(result).toMatchObject({ code: 0, stdout: expect.stringContaining('1 passed') });
        const [run] = readdirSync(join(dir, '.jevwright/runs'));
        expect(readFileSync(join(dir, '.jevwright/runs', run!, 'server.log'), 'utf8')).toBe('server says hi');
        expect(existsSync(join(dir, 'torn-down'))).toBe(true);
    }, 60_000);

    it('scaffolds a config and an example test once, and ignores run reports in .gitignore', async () => {
        const dir = await project({ '.gitignore': 'node_modules\n' });
        expect(await cli(dir, ['init'])).toMatchObject({ code: 0 });
        expect(existsSync(join(dir, 'jevwright.config.ts')) && existsSync(join(dir, 'jevwright/example.ts'))).toBe(true);
        expect(await cli(dir, ['init'])).toMatchObject({ code: 2, stderr: expect.stringContaining('Not overwriting') });
        expect(readFileSync(join(dir, '.gitignore'), 'utf8').match(/^\.jevwright\/$/gm)).toHaveLength(1);
    });
});

describe('report server', () => {
    it('serves the run directory only to the token holder, and nothing outside it', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'jevwright-serve-'));
        await mkdir(join(dir, 'run'));
        await writeFile(join(dir, 'run', 'report.html'), '<h1>report</h1>');
        await writeFile(join(dir, 'secret.txt'), 'outside the run');
        const server = await serveReport(join(dir, 'run'));
        try {
            const base = new URL(server.url);
            const opened = await fetch(server.url);
            expect([opened.status, await opened.text()]).toEqual([200, '<h1>report</h1>']);
            // The token is traded for a cookie, so links inside the report work without it.
            const cookie = opened.headers.get('set-cookie')!.split(';')[0]!;
            const status = async (path: string, init: RequestInit = { headers: { cookie } }) => (await fetch(new URL(path, base), init)).status;
            expect(await status('/report.html')).toBe(200);
            expect(await status('/report.html', {})).toBe(401);
            expect(await status('/..%2Fsecret.txt')).toBe(404);
            expect(await status('/%E0%A4%A')).toBe(404);
            expect(await status('/', { method: 'POST', headers: { cookie } })).toBe(405);
            await expect(serveReport(join(dir, 'run'), Number(base.port))).rejects.toThrow(/already in use/);
        } finally {
            await server.close();
            await rm(dir, { recursive: true, force: true });
        }
    });
});

describe('package', () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string; name: string; dependencies: Record<string, string>; peerDependencies: Record<string, string> };

    it('reports the version package.json declares', () => {
        expect(VERSION).toBe(manifest.version);
    });

    it('imports only Node built-ins, its declared dependencies and its own files', () => {
        // The package's own name appears in the config that `jevwright init` writes.
        const declared = new Set([manifest.name, ...Object.keys(manifest.dependencies), ...Object.keys(manifest.peerDependencies)]);
        const files = ['src', 'bin'].flatMap(dir => readdirSync(join(ROOT, dir)).filter(name => name.endsWith('.ts')).map(name => join(ROOT, dir, name)));
        const outside = files.flatMap(file => [...readFileSync(file, 'utf8').matchAll(/\bfrom\s+'([^']+)'|\bimport\(\s*'([^']+)'\s*\)/g)]
            .map(match => (match[1] ?? match[2])!)
            .filter(specifier => specifier.startsWith('.') ? !resolve(dirname(file), specifier).startsWith(ROOT) : !specifier.startsWith('node:') && !declared.has(specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/')))
            .map(specifier => `${relative(ROOT, file)} → ${specifier}`));
        expect(outside).toEqual([]);
    });

    it('packs only the build, readme, changelog and license, and nothing in the repository holds a credential', () => {
        const packed = (JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })) as Array<{ files: Array<{ path: string }> }>)[0]!.files.map(file => file.path);
        expect(packed.filter(path => !/^(?:package\.json|README\.md|CHANGELOG\.md|LICENSE|dist\/[\w.-]+\.(?:mjs|d\.mts))$/.test(path))).toEqual([]);
        // Maintainers can forbid private terms without committing them: one regular expression per line.
        const terms = process.env.JEVWRIGHT_FORBIDDEN_TERMS ? readFileSync(process.env.JEVWRIGHT_FORBIDDEN_TERMS, 'utf8').split('\n').filter(Boolean).map(line => new RegExp(line, 'i')) : [];
        const patterns = [/\bsk-[\w-]{16,}/, /\bsk-or-v1-\w{16,}/, /\bghp_\w{20,}/, /\bAKIA[0-9A-Z]{16}\b/, /api[_-]?key\s*[:=]\s*['"][^'"]{12,}/i, /Bearer [A-Za-z0-9]{12,}/, ...terms];
        const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => ['node_modules', '.git', '.jevwright'].includes(name) ? [] : statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)]);
        const self = join(ROOT, 'tests/units.test.ts');
        const leaks = walk(ROOT).filter(file => file !== self && !file.endsWith('.tgz')).flatMap(file => patterns.filter(pattern => pattern.test(readFileSync(file, 'utf8'))).map(pattern => `${relative(ROOT, file)} matches ${pattern}`));
        expect(leaks).toEqual([]);
    });
});

describe('stable CI selection', () => {
    it('partitions ids without moving existing tests when another is added', async () => {
        const { selectTests } = await import('../src/select.ts');
        const tests = Array.from({ length: 20 }, (_, index) => ({ id: `case-${index}`, title: 'case', risk: 'case', start: '/', steps: () => [] }));
        const shards = [1, 2, 3].map(index => selectTests(tests, { shard: `${index}/3` }).map(test => test.id));
        expect(shards.flat().toSorted()).toEqual(tests.map(test => test.id).toSorted());
        expect(new Set(shards.flat()).size).toBe(20);
        expect(() => selectTests(tests, { shard: '' })).toThrow('--shard');
        const extended = [...tests, { ...tests[0]!, id: 'new-case' }];
        expect([1, 2, 3].map(index => selectTests(extended, { shard: `${index}/3` }).filter(test => test.id !== 'new-case').map(test => test.id))).toEqual(shards);
    });
});

describe('cI reports', () => {
    it('reads failed and flaky ids only from the latest completed publication', async () => {
        const { lastFailedIds } = await import('../src/last-failed.ts');
        const directory = await mkdtemp(join(tmpdir(), 'jevwright-last-failed-'));
        try {
            await expect(lastFailedIds(directory)).rejects.toThrow('No completed run');
            const completed = join(directory, 'older-name');
            const running = join(directory, 'newer-name');
            await mkdir(completed);
            await mkdir(running);
            const manifest = { finishedAt: '2026-01-01T00:00:00.000Z' };
            await writeFile(join(completed, 'run.json'), JSON.stringify(manifest));
            await writeFile(join(completed, 'summary.json'), JSON.stringify({ manifest, results: [{ id: 'failed-case', status: 'failed' }, { id: 'flaky-case', status: 'flaky' }, { id: 'passed-case', status: 'passed' }] }));
            await writeFile(join(running, 'run.json'), JSON.stringify({ startedAt: '2026-01-02T00:00:00.000Z' }));
            await writeFile(join(running, 'summary.json'), JSON.stringify({ manifest: {}, results: [{ id: 'still-running', status: 'failed' }] }));
            expect([...await lastFailedIds(directory)]).toEqual(['failed-case', 'flaky-case']);
            const interrupted = join(directory, 'interrupted');
            await mkdir(interrupted);
            const cancelled = { finishedAt: '2026-01-03T00:00:00.000Z', cancelled: true };
            await writeFile(join(interrupted, 'run.json'), JSON.stringify(cancelled));
            await writeFile(join(interrupted, 'summary.json'), JSON.stringify({ manifest: cancelled, results: [{ id: 'unstarted', status: 'skipped' }] }));
            expect([...await lastFailedIds(directory)]).toEqual(['failed-case', 'flaky-case']);
        } finally { await rm(directory, { recursive: true, force: true }); }
    });

    it('produces parseable JUnit with failures, errors, known issues and flaky notes', async () => {
        const { junitReport } = await import('../src/junit.ts');
        const { emptyUsage } = await import('../src/models.ts');
        const base = { id: 'plain', title: 'Example', risk: 'Example', tags: [], summary: 'quote " < & \u0001', attempts: [], issues: [], models: emptyUsage(), durationMs: 1200, recordingUpdated: false };
        const results: import('../src/suite.ts').TestResult[] = [
            { ...base, id: 'pass', status: 'passed' },
            { ...base, id: 'flaky', status: 'flaky', reproduced: '1/2' },
            { ...base, id: 'defect', status: 'failed', cause: 'product' },
            { ...base, id: 'infra', status: 'failed', cause: 'environment' },
            { ...base, id: 'model', status: 'failed', cause: 'model' },
            { ...base, id: 'known', status: 'known', knownIssue: 'tracked issue' },
            { ...base, id: 'skip', status: 'skipped', skipReason: 'explicit skip' },
        ];
        const summary: import('../src/suite.ts').RunSummary = {
            manifest: { runId: 'fixture', engine: 'fixture', startedAt: '2026-01-01T00:00:00Z', mode: 'auto', git: null, models: null, origin: app.origin, concurrency: 1, retries: 1, tests: results.map(result => result.id), command: 'jevwright run --shard 1/3' },
            results,
            directory: '.',
            totals: { tests: 7, passed: 1, flaky: 1, failed: 3, known: 1, skipped: 1, issues: 0, models: emptyUsage(), durationMs: 8400 },
        };
        const page = await browser.newPage();
        try {
            const parsed = await page.evaluate((xml) => {
                const document = new DOMParser().parseFromString(xml, 'application/xml');
                return { errors: document.querySelectorAll('parsererror').length, cases: document.querySelectorAll('testcase').length, failures: document.querySelectorAll('failure').length, infrastructure: document.querySelectorAll('error').length, skipped: document.querySelectorAll('skipped').length, note: document.querySelector('system-out')?.textContent, message: document.querySelector('failure')?.getAttribute('message'), classname: document.querySelector('testcase')?.getAttribute('classname') };
            }, junitReport(summary));
            expect(parsed).toEqual({ errors: 0, cases: 7, failures: 1, infrastructure: 2, skipped: 2, note: 'Flaky: failed 1/2 attempts; quote " < & \u0001'.replace('\u0001', '\uFFFD'), message: 'quote " < & \uFFFD', classname: 'default' });
        } finally { await page.close(); }
    });
});

it('rebuilds JUnit through the report command and removes stale selection from reproduce commands', async () => {
    const { writeReports, reproduceCommand } = await import('../src/report.ts');
    const { emptyUsage } = await import('../src/models.ts');
    const directory = await mkdtemp(join(tmpdir(), 'jevwright-rebuild-'));
    const summary: import('../src/suite.ts').RunSummary = { manifest: { runId: 'rebuild', engine: 'fixture', startedAt: '2026-01-01T00:00:00Z', mode: 'replay', git: null, models: null, origin: app.origin, concurrency: 1, retries: 0, tests: [] }, results: [], directory, totals: { tests: 0, passed: 0, failed: 0, flaky: 0, known: 0, skipped: 0, issues: 0, models: emptyUsage(), durationMs: 0 } };
    try {
        await writeReports(summary);
        await rm(join(directory, 'junit.xml'));
        expect(await cli(directory, ['report', directory])).toMatchObject({ code: 0 });
        expect(readFileSync(join(directory, 'junit.xml'), 'utf8')).toContain('<testsuites tests="0">');
        expect(reproduceCommand('jevwright run --last-failed --shard 1/3 --tag smoke', 'chosen')).toBe('jevwright run --test chosen');
    } finally { await rm(directory, { recursive: true, force: true }); }
});

describe('recorded end states', () => {
    it('normalizes dynamic paths and requires half the appeared anchors', async () => {
        const { endMatches, normalizedPath } = await import('../src/end-state.ts');
        expect(normalizedPath('/items/123/ab12cd34')).toBe('/items/:id/:id');
        const observation: Observation = { url: 'http://localhost/items/456/ef56gh78', title: '', notices: [], headings: ['Saved', 'Ready'], text: '', elements: [], omitted: 0, signature: '' };
        const end = { path: '/items/:id/:id', appeared: ['Saved', 'Ready', 'Done', 'Complete'].map(text => ({ kind: 'heading' as const, text })) };
        expect(endMatches(end, observation).matched).toBe(true);
        expect(endMatches(end, { ...observation, headings: ['Saved'] }).matched).toBe(false);
    });
});

describe('secret values', () => {
    it('keeps accidental conversions opaque and redacts encoded appearances', async () => {
        const { secret, reveal, createRedactor } = await import('../src/secrets.ts');
        const raw = 'test-secret-<&"é';
        const handle = secret(raw);
        expect(String(handle)).toBe('{secret}');
        expect(JSON.stringify(handle)).toBe('"{secret}"');
        expect(`${handle}`).toBe('{secret}');
        expect(reveal(handle)).toBe(raw);
        const redact = createRedactor([handle]);
        for (const encoded of [raw, encodeURIComponent(raw), JSON.stringify(raw).slice(1, -1), Buffer.from(raw).toString('base64'), raw.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;')]) {
            expect(redact.text(encoded)).toBe('{secret}');
        }
        expect(() => secret('short')).toThrow('6');
    });
});

it('guards the redacted artifact boundary and its narrowly scoped filesystem owners (FW01)', async () => {
    const { artifactBoundaryViolations: scan } = await import('./support/artifact-boundary.ts');
    expect(scan('report.ts', 'import { writeFile as save } from \'node:fs/promises\'; async function report() { await save(\'result.json\', raw); }')).toHaveLength(1);
    expect(scan('cli.ts', 'import { writeFile } from \'node:fs/promises\'; async function runPasses() { await writeFile(\'server.log\', raw); }')).toHaveLength(1);
    expect(scan('models.ts', 'redact.value(questions);')).toHaveLength(1);
    expect(scan('models.ts', 'import { forResults as unsafe } from \'./secrets.ts\';')).toHaveLength(1);
    expect(scan('cli.ts', 'writeReports({ ...summary, directory: dir });')).toHaveLength(1);
    expect(scan('report.ts', 'import * as fs from \'node:fs/promises\'; fs.writeFile(\'report.md\', raw);')).toHaveLength(1);
    expect(scan('cli.ts', 'import { writeFile } from \'node:fs/promises\'; async function initCommand() { await writeFile(\'config.ts\', template); }')).toEqual([]);
    const files = readdirSync(join(ROOT, 'src')).filter(name => name.endsWith('.ts'));
    expect(files.flatMap(name => scan(name, readFileSync(join(ROOT, 'src', name), 'utf8')))).toEqual([]);
});

it('keeps the configured viewport for an explicit desktop device', async () => {
    const { resolveDevice } = await import('../src/devices.ts');
    expect(resolveDevice('desktop', { width: 1440, height: 900 }).viewport).toEqual({ width: 1440, height: 900 });
});

describe('paired calibration', () => {
    it('detects repeated correctness regressions even when aggregate metrics improve', async () => {
        const { comparePairs } = await import('../scripts/calibration-stats.ts');
        const baseline = { matched: { save: true }, metrics: { jev: 10, llm: 0, cost: 0.1, duration: 100, healed: 0, rerouted: 0 } };
        const candidate = { matched: { save: false }, metrics: { ...baseline.metrics, jev: 1 } };
        const result = comparePairs(Array.from({ length: 6 }, () => ({ baseline, candidate })));
        expect(result.regression).toBe(true);
        expect(result.flips).toEqual([{ id: 'save', b: 6, c: 0 }]);
    });

    it('keeps identical paired metrics at zero and excludes unsupported tests', async () => {
        const { comparePairs, applicableTests } = await import('../scripts/calibration-stats.ts');
        const sample = { matched: { save: true }, metrics: { jev: 10, llm: 0, cost: 0.1, duration: 100, healed: 0, rerouted: 0 } };
        const result = comparePairs(Array.from({ length: 6 }, () => ({ baseline: sample, candidate: sample })));
        expect(result.regression).toBe(false);
        expect(result.resolved).toBe(true);
        expect(result.intervals.jev).toEqual({ mean: 0, low: 0, high: 0, relativeLow: 0, relativeHigh: 0 });
        expect(applicableTests([{ id: 'old' }, { id: 'upload', requiredApis: ['file'] }], {})).toEqual({ supported: [{ id: 'old' }], unsupported: [{ id: 'upload', missing: ['file'] }] });
    });

    it('stops once each metric is either within noise or clearly changed', async () => {
        const { comparePairs } = await import('../scripts/calibration-stats.ts');
        const baseline = { matched: { save: true }, metrics: { jev: 10, llm: 0, cost: 0.1, duration: 100, healed: 0, rerouted: 0 } };
        const candidate = { matched: { save: true }, metrics: { ...baseline.metrics, jev: 6 } };
        expect(comparePairs(Array.from({ length: 6 }, () => ({ baseline, candidate }))).resolved).toBe(true);
    });
});

it('calibration removes a baseline registered through a symlinked parent', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { symlink, realpath } = await import('node:fs/promises');
    const { removeOwnedWorktree } = await import('../scripts/calibration-ab.ts');
    const root = await realpath(await mkdtemp(join(tmpdir(), 'jevwright-link-')));
    const link = `${root}-link`;
    const git = (...args: string[]) => promisify(execFile)('git', args, { cwd: root });
    try {
        await git('init');
        await git('-c', 'user.name=Probe', '-c', 'user.email=probe@example.invalid', 'commit', '--allow-empty', '-m', 'probe');
        await symlink(root, link);
        const baseline = join(link, 'baseline');
        await git('worktree', 'add', '--detach', baseline, 'HEAD');
        expect((await git('worktree', 'list', '--porcelain')).stdout).toContain(join(root, 'baseline'));
        await removeOwnedWorktree(root, baseline);
        expect((await git('worktree', 'list', '--porcelain')).stdout).not.toContain(join(root, 'baseline'));
    } finally {
        await rm(link, { force: true });
        await rm(root, { recursive: true, force: true });
    }
});

it('calibration removes a registered baseline after a failing checkout hook', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { chmod } = await import('node:fs/promises');
    const { removeOwnedWorktree } = await import('../scripts/calibration-ab.ts');
    const root = await mkdtemp(join(tmpdir(), 'jevwright-hook-'));
    const baseline = join(root, 'baseline');
    const git = (...args: string[]) => promisify(execFile)('git', args, { cwd: root });
    try {
        await git('init');
        await git('-c', 'user.name=Probe', '-c', 'user.email=probe@example.invalid', 'commit', '--allow-empty', '-m', 'probe');
        const hook = join(root, '.git/hooks/post-checkout');
        await writeFile(hook, '#!/bin/sh\nexit 23\n');
        await chmod(hook, 0o755);
        await expect(git('worktree', 'add', '--detach', baseline, 'HEAD')).rejects.toThrow();
        expect((await git('worktree', 'list', '--porcelain')).stdout).toContain(baseline);
        await removeOwnedWorktree(root, baseline);
        expect((await git('worktree', 'list', '--porcelain')).stdout).not.toContain(baseline);
    } finally { await rm(root, { recursive: true, force: true }); }
});

describe('reach observation', () => {
    it('reaches nested closed roots while preserving the application boundary', async () => {
        const { observation } = await open('/reach-observe', async page => { expect(await page.evaluate(() => Reflect.get(window, 'rootStillClosed'))).toBe(true); });
        expect(named(observation, 'textbox', 'Member')).toHaveLength(1);
        expect(named(observation, 'button', 'Grant')).toHaveLength(1);
    });
    it('offers roleless hover text, editors, scrolling containers and noninteractive scroll targets', async () => {
        const { observation } = await open('/reach-observe');
        expect(observation.elements.some(element => element.name === 'Workspace' && element.ref)).toBe(true);
        expect(named(observation, 'textbox', 'Draft')).toHaveLength(1);
        expect(observation.elements.some(element => element.name === 'Activity' && Reflect.get(element, 'scroll'))).toBe(true);
        expect(observation.elements.some(element => element.name === 'End notes' && element.ref)).toBe(true);
    });
    it('keeps visible labels distinct from accessible names and excludes clipped screen-reader text', async () => {
        const { observation } = await open('/reach-observe');
        expect(named(observation, 'button', 'Discard')[0]?.content).toBe('Publish draft');
        expect(observation.text).not.toContain('Ignore this');
        expect(named(observation, 'textbox', 'Memo')[0]?.near).toBe('Budget');
    });
    it('settles across an explicitly busy deferred render', async () => {
        const { observation } = await open('/reach-loading');
        expect(named(observation, 'button', 'Open workspace')).toHaveLength(1);
    });
    it('reads visible aria-hidden content and excludes visually clipped accessibility text', async () => {
        const { observation } = await open('/reach-visual');
        expect(observation.text).toContain('Total 0.00');
        expect(observation.text).not.toContain('Unavailable amount');
    });
    it('distinguishes a field label from an explanatory paragraph', async () => {
        const { observation } = await open('/reach-fields');
        expect(named(observation, 'textbox', 'Address')[0]?.near).toBeUndefined();
        expect(named(observation, 'textbox', 'Memo')[0]?.near).toBe('Budget');
    });
    it('rejects an ungrounded back gesture without leaving the app page', async () => {
        const { observation } = await open('/reach-actions', async page => {
            await expect(perform(page, { tool: 'back' })).rejects.toThrow('No earlier app page');
            expect(page.url()).toContain('/reach-actions');
        });
        expect(named(observation, 'button', 'Open twice')).toHaveLength(1);
    });
});

it('scopes closed-root dialogs and excludes inert shadow descendants', async () => {
    const { observation } = await open('/reach-observe', page => page.evaluate(() => {
        const root = Reflect.get(window, 'fixtureRoot') as ShadowRoot;
        const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-label', 'Member dialog'); dialog.innerHTML = '<button>Dismiss member dialog</button>';
        root.append(dialog);
    }));
    expect(observation.dialog).toBe('dialog "Member dialog"');
    expect(observation.elements.some(element => element.name === 'Dismiss member dialog')).toBe(true);
    expect(observation.elements.some(element => element.name === 'Discard')).toBe(false);
    const inert = await open('/reach-observe', page => page.locator('#closed').evaluate(element => element.setAttribute('inert', '')));
    expect(inert.observation.elements.some(element => element.name === 'Member')).toBe(false);
});
