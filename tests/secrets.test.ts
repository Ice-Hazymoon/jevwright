import type { TestSpec } from '../src/index.ts';
import { unzipSync, zipSync } from 'fflate';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { redactTrace, writeArtifact } from '../src/artifacts.ts';
import { act, check, reveal, run, runSuite, secret, verify } from '../src/index.ts';
import { createRedactor } from '../src/secrets.ts';
import { assertValidTests } from '../src/select.ts';
import { startFixtureApp } from './fixtures/app.ts';
import { is, scriptedModels } from './support/scripted-models.ts';

const failure = vi.hoisted(() => ({ rename: false }));
vi.mock('node:fs/promises', async (importOriginal) => {
    const original = await importOriginal<typeof import('node:fs/promises')>();
    return { ...original, rename: async (...args: Parameters<typeof original.rename>) => {
        if (failure.rename) { throw new Error('injected atomic rewrite failure'); }
        return original.rename(...args);
    } };
});

let app: Awaited<ReturnType<typeof startFixtureApp>>;
let root: string;
beforeAll(async () => { app = await startFixtureApp(); root = await mkdtemp(join(tmpdir(), 'jevwright-secrets-')); });
afterAll(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
const plaintext = `Api<&"'\\Key/Ω-42`;
const handle = secret(plaintext, { purpose: 'any' });
function spec(): TestSpec<void> {
    return { id: 'secret-entry', title: 'Save API key', risk: 'Secrets leak from browser tests', start: '/secret', secrets: { apiKey: handle }, ignoreConsole: [/Echo key/], steps: () => [
        act('Enter {apiKey} in API key'),
        act('Save key'),
        act('Click the echoed key'),
        verify('exact key saved', async ({ page, secrets, data }) => ({ passed: await page.locator('output').textContent() === reveal(secrets.apiKey!) && !('apiKey' in data), evidence: { raw: reveal(secrets.apiKey!) } })),
    ] };
}
async function files(directory: string): Promise<string[]> {
    return (await Promise.all((await readdir(directory, { withFileTypes: true })).map(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]))).flat();
}
function mock() {
    const scripted = scriptedModels((view) => {
        if (view.step?.startsWith('Enter')) {
            if (view.entered.apiKey) { return { done: 0.95 }; }
            return view.history.some(entry => entry.action === 'click') ? { tool: 'none', done: 0.95 } : { tool: 'click', target: is('button', 'Show hint') };
        }
        if (view.step === 'Save key') { return view.url.includes('?key=') ? { done: 0.95 } : { tool: 'click', target: is('button', 'Save key') }; }
        return view.text.includes('Echo confirmed') ? { done: 0.95 } : { tool: 'click', target: is('button', '{secret}') };
    }, view => ({ outcome: 'act', tool: 'type', element: view.elements.find(is('textbox', 'API key'))!.i, value_key: 'apiKey', text: null, reason: 'Enter the declared opaque key' }));
    const requests: unknown[] = [];
    const models = scripted.settings.models!;
    const evaluate = models.evaluation.doEvaluate.bind(models.evaluation);
    const generate = models.language.doGenerate.bind(models.language);
    models.evaluation.doEvaluate = async (options) => { requests.push(options); return evaluate(options); };
    models.language.doGenerate = async (options) => { requests.push(options); return generate(options); };
    return { ...scripted, requests };
}

describe('secret boundaries', () => {
    it('withholds model payloads, artifacts and recordings while entering the exact value', async () => {
        const scripted = mock(); const logs: string[] = [];
        const summary = await runSuite([spec()], { baseURL: app.origin, outputDir: join(root, 'runs'), recordingsDir: join(root, 'recordings'), models: scripted.settings, retries: 0, log: line => logs.push(line) });
        expect(summary.results[0]?.status, summary.results[0]?.summary).toBe('passed');
        expect(summary.totals.models.llmCalls).toBeGreaterThan(0);
        const attempt = summary.results[0]!.attempts[0]!;
        expect(attempt.screenshotsWithheld).toBe(true);
        expect(attempt.steps.every(step => !step.screenshot)).toBe(true);
        expect(attempt.steps[2]?.notRecorded).toMatch(/target text contains a secret/);
        expect(JSON.stringify(scripted.requests)).toContain('apiKey is not on the page');
        const redact = createRedactor([handle]);
        const forms = [plaintext, encodeURIComponent(plaintext), new URL(`http://example.invalid/?key=${encodeURIComponent(plaintext)}`).search.slice(5), JSON.stringify(plaintext).slice(1, -1), Buffer.from(plaintext).toString('base64'), plaintext.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll('\'', '&#39;')];
        await writeArtifact(join(summary.directory, 'server.log'), forms.join('\n'), redact);
        const allFiles = await files(root);
        const outputs = [...logs, JSON.stringify(summary), ...scripted.requests.map(request => JSON.stringify(request))];
        for (const path of allFiles) {
            const bytes = await readFile(path);
            if (path.endsWith('.zip')) {
                const entries = unzipSync(bytes);
                expect(Object.keys(entries).some(name => name.endsWith('.jpeg'))).toBe(false);
                outputs.push(...Object.entries(entries).flatMap(([name, content]) => [name, Buffer.from(content).toString('utf8')]));
            } else { outputs.push(bytes.toString('utf8')); }
        }
        for (const output of outputs) { for (const form of forms) { expect(output).not.toContain(form); } }
        const recording = JSON.parse(await readFile(join(root, 'recordings/secret-entry.json'), 'utf8'));
        expect(recording.steps).toHaveLength(2);
        expect(recording.steps[0].actions.some((entry: { valueKey?: string }) => entry.valueKey === 'apiKey')).toBe(true);
    });

    it('marks a withheld trace without changing the test result, and preserves ordinary screenshots', async () => {
        const test = { ...spec(), steps: () => [verify('page ready', () => true)] };
        failure.rename = true;
        let summary;
        try { summary = await runSuite([test], { baseURL: app.origin, outputDir: join(root, 'trace-failure'), mode: 'replay', log: () => undefined }); } finally { failure.rename = false; }
        const attempt = summary.results[0]!.attempts[0]!;
        expect(attempt.status).toBe('passed');
        expect(attempt.traceWithheld).toBe(true);
        expect(attempt.trace).toBeUndefined();
        await expect(readFile(join(attempt.directory, 'trace.zip'))).rejects.toMatchObject({ code: 'ENOENT' });
        const ordinary = await runSuite([{ ...test, secrets: undefined }], { baseURL: app.origin, outputDir: join(root, 'ordinary'), mode: 'replay', log: () => undefined });
        const control = ordinary.results[0]!.attempts[0]!;
        expect(control.steps[0]!.screenshot).toBeDefined();
        expect(control.screenshotsWithheld).toBeUndefined();
        expect(Object.keys(unzipSync(await readFile(control.trace!))).some(name => name.endsWith('.jpeg'))).toBe(true);
    });

    it('rejects ambiguous data and semantic secret assertions before a run', () => {
        expect(() => secret('短😀值')).toThrow(/6/);
        expect(() => assertValidTests([{ ...spec(), data: { apiKey: 'ordinary' } }])).toThrow(/both define/);
        expect(() => assertValidTests([{ ...spec(), steps: () => [check('The key is {apiKey}')] }])).toThrow(/check cannot reference/);
    });

    it('deletes the original trace when rewriting fails', async () => {
        const path = join(root, 'broken.zip');
        await writeFile(path, zipSync({ 'secret.trace': new TextEncoder().encode(plaintext) }));
        const redact = createRedactor([handle]);
        redact.text = (text) => { if (text.includes(plaintext)) { throw new Error('injected rewrite failure'); } return text; };
        expect(await redactTrace(path, redact)).toBe(false);
        await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    });
});

it('redacts long, whitespace-normalized and nested-JSON values before observation clipping', async () => {
    const { fixturePolicy } = await import('./support/fixture-policy.ts');
    for (const raw of [`long-credential-prefix-${'x'.repeat(350)}"tail`, 'alpha  beta', 'abc"def']) {
        const payload = secret(raw);
        const scripted = scriptedModels(fixturePolicy);
        const requests: unknown[] = [];
        const model = scripted.settings.models!.evaluation;
        const evaluate = model.doEvaluate.bind(model);
        model.doEvaluate = async (options) => { requests.push(options); return evaluate(options); };
        const summary = await runSuite([{ id: 'secret-clipping', title: 'Enter text', risk: 'Truncated secrets leak', start: '/profile', secrets: { bio: payload }, steps: () => [
            act('Set the Bio to exactly {bio}'),
            verify('exact field', async ({ page, secrets }) => ({ passed: await page.getByLabel('Bio').inputValue() === reveal(secrets.bio!), evidence: JSON.stringify(JSON.stringify(reveal(secrets.bio!))) })),
        ] }], { baseURL: app.origin, outputDir: join(root, 'clipping'), models: scripted.settings, retries: 0, log: () => undefined });
        expect(summary.results[0]?.status, summary.results[0]?.summary).toBe('passed');
        const artifacts = (await files(summary.directory)).filter(path => !path.endsWith('.zip')).map(path => readFile(path, 'utf8'));
        const outputs = [JSON.stringify(requests), ...await Promise.all(artifacts)];
        const normalized = raw.replace(/\s+/g, ' ');
        const prefix = raw.startsWith('long-') ? raw.slice(0, 40) : normalized;
        for (const output of outputs) {
            expect(output).not.toContain(prefix);
            let encoded = raw;
            for (let index = 0; index < 4; index++) { expect(output).not.toContain(encoded); encoded = JSON.stringify(encoded).slice(1, -1); }
        }
    }
});

it('keeps fixed result grammar intact when a secret coincides with it', async () => {
    const summary = await runSuite([{ ...spec(), secrets: { state: secret('passed'), key: secret('models') }, steps: () => [verify('passes', () => true)] }], { baseURL: app.origin, outputDir: join(root, 'grammar'), mode: 'replay', retries: 1, log: () => undefined });
    expect(summary.results[0]?.status).toBe('passed');
    expect(summary.results[0]?.attempts).toHaveLength(1);
    const saved = JSON.parse(await readFile(join(summary.directory, 'summary.json'), 'utf8'));
    expect(saved.results[0].status).toBe('passed');
    expect(saved.results[0].attempts[0].models.jevCalls).toBe(0);
});

it('deletes trace output when tracing.stop fails after writing it', async () => {
    const summary = await runSuite([{ ...spec(), fixture: async ({ context }) => {
        const stop = context.tracing.stop.bind(context.tracing);
        context.tracing.stop = async (options) => { await stop(options); throw new Error('stop failed after saving'); };
    }, steps: () => [verify('passes', () => true)] }], { baseURL: app.origin, outputDir: join(root, 'stop-failure'), mode: 'replay', log: () => undefined });
    const attempt = summary.results[0]!.attempts[0]!;
    expect(attempt.status).toBe('passed');
    expect(attempt.traceWithheld).toBe(true);
    await expect(readFile(join(attempt.directory, 'trace.zip'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('preserves usage errors from fixture-dependent secret assertions', async () => {
    const dynamic: TestSpec<{ ready: boolean }> = { id: 'dynamic-secret', title: 'Dynamic definition', risk: 'Invalid assertion', start: '/secret', secrets: { apiKey: handle }, fixture: async () => ({ ready: true }), steps: fixture => fixture.ready ? [check('The field is {apiKey}')] : [] };
    await expect(runSuite([dynamic], { baseURL: app.origin, outputDir: join(root, 'dynamic'), mode: 'replay', log: () => undefined })).rejects.toMatchObject({ name: 'JevwrightError', message: expect.stringContaining('check cannot reference') });
});

it('redacts evidence keys and grammar-shaped user data while preserving engine failure codes', async () => {
    const handles = { a: secret('passed'), b: secret('private-id'), c: secret('not-recorded') };
    const redact = createRedactor(Object.values(handles));
    expect(redact.value({ reference: { 'status': 'passed', 'private-id': 'value' } })).toEqual({ reference: { 'status': '{secret}', '{secret}': 'value' } });
    const summary = await runSuite([{ ...spec(), secrets: handles, steps: () => [verify('evidence', () => ({ passed: true, evidence: { 'status': 'passed', 'private-id': 'value' } })), act('Save key')] }], { baseURL: app.origin, outputDir: join(root, 'grammar-evidence'), mode: 'replay', log: () => undefined });
    expect(summary.results[0]?.attempts[0]?.steps[1]?.failure).toBe('not-recorded');
    expect(summary.results[0]?.attempts[0]?.steps[0]?.evidence).toEqual({ 'status': '{secret}', '{secret}': 'value' });
    const { runFailureExitCode } = await import('../src/cli.ts');
    expect(runFailureExitCode(summary, true)).toBe(4);
});

it('redacts multiline text before scanning separate lines for anomalies', async () => {
    const raw = 'NaN private\nsecondline';
    const summary = await runSuite([{ ...spec(), secrets: { key: secret(raw) }, fixture: async ({ context }) => { await context.addInitScript(value => addEventListener('DOMContentLoaded', () => { const p = document.createElement('p'); p.textContent = value; document.body.append(p); }), raw); }, steps: () => [verify('ready', () => true)] }], { baseURL: app.origin, outputDir: join(root, 'multiline'), mode: 'replay', log: () => undefined });
    expect(JSON.stringify(summary)).not.toContain('NaN private');
});

it('redacts setup and translation callback errors at the CLI boundary', async () => {
    const config = await import('../src/config.ts');
    const { main } = await import('../src/cli.ts');
    const raw = 'private-cli-token';
    for (const translation of [false, true]) {
        const error = () => { throw new Error(`authentication failed for ${raw}`); };
        const load = vi.spyOn(config, 'loadConfig').mockResolvedValue({ file: join(root, 'config.ts'), outputDir: join(root, 'cli'), recordingsDir: join(root, 'recordings'), config: { tests: [{ ...spec(), secrets: { token: secret(raw) } }], setup: error, ...(translation ? { translationKeys: error } : {}) } });
        const stderr: string[] = [];
        try {
            expect(await main(['run', '--mode', 'replay'], { cwd: root, env: {}, stdout: () => undefined, stderr: text => stderr.push(text) })).toBe(2);
            expect(stderr.join('')).toContain('{secret}');
            expect(stderr.join('')).not.toContain(raw);
        } finally { load.mockRestore(); }
    }
});

it('redacts the actual CLI server log and regenerated JUnit output', async () => {
    const config = await import('../src/config.ts');
    const { main } = await import('../src/cli.ts');
    const raw = 'private-server-log-value';
    const outputDir = join(root, raw);
    const load = vi.spyOn(config, 'loadConfig').mockResolvedValue({ file: join(root, 'config.ts'), outputDir, recordingsDir: join(root, 'recordings'), config: { tests: [{ ...spec(), secrets: { token: secret(raw) }, steps: () => [verify('evidence', () => ({ passed: true, evidence: raw }))] }], setup: async () => ({ baseURL: app.origin, serverLog: () => raw }) } });
    const io = { cwd: root, env: {}, stdout: () => undefined, stderr: () => undefined };
    try { expect(await main(['run', '--mode', 'replay'], io)).toBe(0); } finally { load.mockRestore(); }
    const directory = join(outputDir, (await readdir(outputDir))[0]!);
    expect(await readFile(join(directory, 'server.log'), 'utf8')).toBe('{secret}');
    expect(await main(['report', directory], io)).toBe(0);
    const junit = await readFile(join(directory, 'junit.xml'), 'utf8');
    expect(junit).toContain('<testcase'); expect(junit).not.toContain(raw);
    for (const file of ['summary.json', 'report.md', 'report.html']) { expect(await readFile(join(directory, file), 'utf8')).not.toContain(raw); }
});

it('keeps model protocol identities intact when secrets match schema words', async () => {
    const { createModels } = await import('../src/models.ts');
    const scripted = scriptedModels(() => ({ tool: 'click', target: is('button', 'Save') }));
    const model = createModels(scripted.settings, undefined, createRedactor(['choice', 'target', 'elements'].map(value => secret(value))));
    const result = await model.judge({ task: { step: 'Save' }, page: { elements: [{ i: 0, role: 'button', name: 'Save' }] }, reference: { status: 'choice' } }, { target: { type: 'choice', instructions: 'Choose the target element', criteria: { 0: null } } }, AbortSignal.timeout(5000), 'test');
    expect(result.target).toMatchObject({ type: 'choice', choice: '0' });
    expect(scripted.calls[0]?.view.elements[0]?.name).toBe('Save');
});

it('writes reports to the actual directory when its name contains a secret', async () => {
    const outputDir = join(root, 'jevwright-output');
    const summary = await runSuite([{ ...spec(), secrets: { token: secret('jevwright') }, steps: () => [verify('ready', () => true)] }], { baseURL: app.origin, outputDir, mode: 'replay', log: () => undefined });
    expect(summary.totals.passed).toBe(1);
    const directory = join(outputDir, (await readdir(outputDir))[0]!);
    expect(await readFile(join(directory, 'junit.xml'), 'utf8')).toContain('<testcase');
});

it('selects a failed test whose public id was redacted', async () => {
    const config = await import('../src/config.ts');
    const { main } = await import('../src/cli.ts');
    const raw = 'account-secret';
    const outputDir = join(root, 'redacted-id');
    const test = { ...spec(), id: raw, secrets: { token: secret(raw) }, steps: () => [act('Save key')] };
    await runSuite([test], { baseURL: app.origin, outputDir, mode: 'replay', log: () => undefined });
    const load = vi.spyOn(config, 'loadConfig').mockResolvedValue({ file: join(root, 'config.ts'), outputDir, recordingsDir: join(root, 'recordings'), config: { tests: [test], baseURL: app.origin } });
    const stdout: string[] = [];
    try { expect(await main(['list', '--last-failed'], { cwd: root, env: {}, stdout: line => stdout.push(line), stderr: () => undefined })).toBe(0); } finally { load.mockRestore(); }
    expect(stdout.join('')).toContain('1 test');
    expect(stdout.join('')).not.toContain(raw);
});

it('aliases secret-bearing data keys for Jev and the helper and resolves their answers', async () => {
    for (const raw of ['customer_token', 'value_']) {
        for (const helper of [false, true]) {
            const scripted = scriptedModels(view => Object.keys(view.entered).length ? { done: 0.95 } : helper ? { tool: 'none' } : { tool: 'type', target: is('textbox', 'Nickname'), value: Object.keys(view.values).find(key => view.values[key] === 'Alice') }, view => ({ outcome: 'act', tool: 'type', element: view.elements.find(is('textbox', 'Nickname'))!.i, value_key: Object.keys(view.values).find(key => view.values[key] === 'Alice'), text: null, reason: 'Use the declared value' }));
            const requests: unknown[] = [];
            const models = scripted.settings.models!;
            const evaluate = models.evaluation.doEvaluate.bind(models.evaluation);
            const generate = models.language.doGenerate.bind(models.language);
            models.evaluation.doEvaluate = async (options) => { requests.push(options); return evaluate(options); };
            models.language.doGenerate = async (options) => { requests.push(options); return generate(options); };
            const summary = await runSuite([{ ...spec(), id: `dynamic-key-${helper}`, start: '/profile', data: { [raw]: 'Alice' }, secrets: { token: secret(raw) }, steps: () => [act(`Enter {${raw}} in Nickname`), verify('entered exactly', async ({ page }) => await page.getByRole('textbox', { name: 'Nickname', exact: true }).inputValue() === 'Alice')] }], { baseURL: app.origin, outputDir: join(root, `dynamic-key-${helper}`), mode: 'ai', models: scripted.settings, log: () => undefined });
            expect(summary.results[0]?.status, JSON.stringify(scripted.calls.slice(0, 3))).toBe('passed');
            // The helper's fixed schema field is protocol, not a user value key.
            expect(JSON.stringify(requests).replaceAll('value_key', 'protocolKey')).not.toContain(raw);
            if (helper) { expect(summary.totals.models.llmCalls).toBeGreaterThan(0); }
        }
    }
});

it('redacts browser URL spellings, overlapping secrets, short folds, byte arrays and embedded base64', () => {
    const urlSecret = 'P@ss"w0rd{x}';
    const redact = createRedactor([secret(urlSecret), secret('abcdef'), secret('defghi'), secret('      a')]);
    const href = new URL(`http://app.invalid/keys/${urlSecret}?k=${urlSecret}#${urlSecret}`).href;
    expect(redact.text(href)).toBe('http://app.invalid/keys/{secret}?k={secret}#{secret}');
    expect(redact.text('abcdefghi')).toBe('{secret}');
    expect(redact.text('banana passed')).toBe('banana passed');
    expect(redact.value({ bytes: Buffer.from(`x${urlSecret}`) })).toEqual({ bytes: '{secret}' });
    expect(redact.text(`it&#x27;s ${'P@ss"w0rd{x}'.replace(/[^\w ]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}`)).toBe('it&#x27;s {secret}');
    const basic = Buffer.from(`user:${urlSecret}`).toString('base64');
    expect(redact.contains(basic)).toBe(true);
});

it('keeps another test\'s secret out of a later test\'s trace and screenshots', async () => {
    const shared = secret('Shared-Key-9137');
    const owner: TestSpec<void> = { id: 'secret-owner', title: 'Declares the key', risk: 'Key leaks', start: '/secret', secrets: { key: shared }, steps: () => [verify('ready', () => true)] };
    const viewer: TestSpec<void> = { id: 'secret-viewer', title: 'Shows the key', risk: 'Key leaks', start: '/secret', steps: () => [
        run('show the key', async ({ page }) => { await page.fill('#key', reveal(shared)); await page.click('#save'); }),
        verify('shown', async ({ page }) => (await page.locator('output').textContent()) === reveal(shared)),
    ] };
    const summary = await runSuite([owner, viewer], { baseURL: app.origin, outputDir: join(root, 'cross-test'), retries: 0, mode: 'replay', log: () => undefined });
    const result = summary.results.find(entry => entry.id === 'secret-viewer')!;
    expect(result.status, result.summary).toBe('passed');
    const attempt = result.attempts[0]!;
    expect(attempt.steps.every(step => !step.screenshot)).toBe(true);
    const entries = unzipSync(await readFile(attempt.trace!));
    expect(Object.keys(entries).some(name => name.endsWith('.jpeg'))).toBe(false);
    const text = Object.values(entries).map(bytes => Buffer.from(bytes).toString('utf8')).join('\n');
    for (const form of ['Shared-Key-9137', encodeURIComponent('Shared-Key-9137')]) { expect(text).not.toContain(form); }
});
