import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { act, check, file, run, runSuite, secret, verify, type TestSpec } from '../src/index.ts';
import { resolveFiles } from '../src/files.ts';
import { startFixtureApp } from './fixtures/app.ts';
import { is, scriptedModels } from './support/scripted-models.ts';

let app: Awaited<ReturnType<typeof startFixtureApp>>;
let root: string;
beforeAll(async () => { app = await startFixtureApp(); root = await mkdtemp(join(tmpdir(), 'jev-coverage-')); await writeFile(join(root, 'avatar.txt'), 'avatar content'); });
afterAll(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
const base = { id: 'coverage', title: 'Action coverage', risk: 'Unsupported browser actions', start: '/upload' };
const options = () => ({ baseURL: app.origin, rootDir: root, outputDir: join(root, 'runs'), recordingsDir: join(root, 'recordings'), retries: 0, log: () => undefined });

describe('action coverage', () => {
    it('records upload file keys and replays three times without treating files as missing values', async () => {
        const spec: TestSpec = { ...base, files: { avatar: file('avatar.txt') }, steps: () => [act('Upload {avatar} with Upload avatar'), check('Uploaded file is {avatar}'), verify('content', async ({ page }) => (await page.locator('output').textContent())?.includes('avatar content') === true)] };
        const models = scriptedModels(view => view.claim ? { holds: 0.99, support: 'supports' } : view.text.includes('Uploaded avatar.txt') ? { done: 0.95 } : { tool: 'upload', target: is('button', 'Upload avatar'), value: 'avatar' });
        const first = await runSuite([spec], { ...options(), models: models.settings });
        expect(first.results[0]?.status, first.results[0]?.summary).toBe('passed');
        const recording = await readFile(join(root, 'recordings/coverage.json'), 'utf8');
        expect(recording).toContain('"upload"'); expect(recording).toContain('"valueKey": "avatar"'); expect(recording).not.toContain(root);
        for (let n = 0; n < 3; n++) { const replay = await runSuite([spec], { ...options(), mode: 'replay' }); expect(replay.results[0]?.status, replay.results[0]?.summary).toBe('passed'); expect(replay.totals.models.jevCalls).toBe(0); }
    });
    it('uploads through a native input and reports a missing chooser within the action deadline', async () => {
        for (const absent of [false, true]) {
            const label = absent ? 'No chooser' : 'Visible file';
            const spec: TestSpec = { ...base, id: absent ? 'no-chooser' : 'native-upload', files: { avatar: file('avatar.txt') }, steps: () => [act(`Upload {avatar} with ${label}`, { maxActions: 1 })] };
            const models = scriptedModels(view => view.text.includes('Uploaded avatar.txt') ? { done: 0.95 } : { tool: 'upload', target: is('button', label), value: 'avatar' });
            const result = (await runSuite([spec], { ...options(), models: models.settings })).results[0]!;
            expect(result.status, result.summary).toBe(absent ? 'failed' : 'passed');
            if (absent) { expect(JSON.stringify(result)).toContain('did not open a file chooser'); expect(result.durationMs).toBeLessThan(15000); }
        }
    });
    it('reveals hover controls while using a touch device', async () => {
        app.reset();
        const spec: TestSpec = { ...base, id: 'mobile-hover', start: '/cards', device: 'mobile', steps: () => [act('Customize Beta card', { expect: { write: { method: 'POST', path: '/api/cards/beta/customize' } } }), verify('Beta customized', () => app.state.customizing === 'beta')] };
        const models = scriptedModels(view => view.text.includes('Customizing: beta') ? { done: 0.95 } : { tool: 'click', target: is('button', 'Customize Beta card') });
        const result = (await runSuite([spec], { ...options(), models: models.settings })).results[0]!;
        expect(result.status, result.summary).toBe('passed');
    });
    it('rejects traversal and symlinks outside rootDir before starting a browser', async () => {
        const outside = join(root, '..', `outside-${Date.now()}.txt`); await writeFile(outside, 'outside');
        try {
            await symlink(outside, join(root, 'escape.txt'));
            for (const path of [outside, 'escape.txt']) { await expect(resolveFiles({ avatar: file(path) }, root)).rejects.toThrow(/inside rootDir/); }
        } finally { await rm(outside, { force: true }); }
    });
    it('uses touch and mobile UA, opens the collapsed menu and separates recordings', async () => {
        const spec: TestSpec = { ...base, id: 'device', start: '/device', steps: () => [act('Choose plan'), verify('chosen', async ({ page }) => page.locator('#status').textContent().then(text => text === 'Plan chosen'))] };
        const models = scriptedModels(view => view.text.includes('Plan chosen') ? { done: 0.95 } : { tool: 'click', target: is('button', view.elements.some(is('button', 'Choose plan')) ? 'Choose plan' : 'Open menu') });
        expect((await runSuite([spec], { ...options(), models: models.settings })).results[0]?.status).toBe('passed');
        const desktop = await readFile(join(root, 'recordings/device.json'), 'utf8');
        const mobile: TestSpec = { ...spec, device: 'mobile', steps: () => [...spec.steps(undefined), verify('mobile', async ({ page }) => (await page.locator('body').textContent())!.includes('Android') && (await page.locator('#events').textContent()) === 'Touch received')] };
        const result = await runSuite([mobile], { ...options(), models: models.settings });
        expect(result.results[0]?.status, result.results[0]?.summary).toBe('passed');
        expect(await readFile(join(root, 'recordings/device.json'), 'utf8')).toBe(desktop);
        expect(await readdir(join(root, 'recordings'))).toContain('device.mobile.json');
    });
    it('downloads blob CSV, makes raw content available to verify, and rejects large downloads', async () => {
        for (const large of [false, true]) {
            const label = large ? 'Export large' : 'Export CSV';
            const spec: TestSpec = { ...base, id: large ? 'large' : 'csv', start: '/downloads', steps: () => [act(label, { expect: { download: { filename: /\.csv$/ }, timeoutMs: 2000 } }), verify('CSV content', async ({ downloads }) => ({ passed: await readFile(downloads[0]!.path, 'utf8') === 'name,value\nAda,42' }))] };
            const models = scriptedModels(view => view.history.length ? { done: 0.95 } : { tool: 'click', target: is('button', label) });
            const summary = await runSuite([spec], { ...options(), models: models.settings });
            expect(summary.results[0]?.status, summary.results[0]?.summary).toBe(large ? 'failed' : 'passed');
            if (large) { expect(summary.results[0]?.attempts[0]?.steps[0]?.failure).toBe('expectation'); expect(await readdir(join(summary.results[0]!.attempts[0]!.directory, 'downloads'))).toEqual([]); }
        }
    });
    it('cancels undeclared downloads and resumes the parent after the child closes', async () => {
        const cancelled: TestSpec = { ...base, id: 'cancel', start: '/downloads', steps: () => [run('download without expectation', async ({ page }) => { const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export CSV' }).click(); expect(await (await download).failure()).not.toBeNull(); }), verify('no saved downloads', ({ downloads }) => downloads.length === 0)] };
        expect((await runSuite([cancelled], { ...options(), mode: 'replay' })).results[0]?.status).toBe('passed');
        const popup: TestSpec = { ...base, id: 'popup', start: '/popup-parent', steps: () => [act('Open child'), act('Close child'), act('Save parent'), verify('parent saved', async ({ page }) => (await page.locator('#status').textContent()) === 'Parent saved')] };
        const models = scriptedModels(view => {
            if (view.step === 'Open child') { return view.url.includes('popup-child') ? { done: 0.95 } : { tool: 'click', target: is('button', 'Open child') }; }
            if (view.step === 'Close child') { return view.url.includes('popup-parent') ? { done: 0.95 } : { tool: 'click', target: is('button', 'Close child') }; }
            return view.text.includes('Parent saved') ? { done: 0.95 } : { tool: 'click', target: is('button', 'Save parent') };
        });
        const summary = await runSuite([popup], { ...options(), models: models.settings });
        expect(summary.results[0]?.status, summary.results[0]?.summary).toBe('passed');
        expect(summary.results[0]?.attempts[0]?.events).toContain('tab closed');
    });
});


it('waits for all downloads and rejects a late oversized second file', async () => {
    const spec: TestSpec = { ...base, id: 'late-large', start: '/downloads', fixture: async ({ context }) => {
        context.on('page', page => page.on('download', download => { if (download.suggestedFilename() === 'large.csv') { const save = download.saveAs.bind(download); download.saveAs = async path => { await new Promise(resolve => setTimeout(resolve, 1500)); return save(path); }; } }));
    }, ready: async ({ page }) => page.evaluate(() => { const button = document.createElement('button'); button.textContent = 'Export both'; button.onclick = () => { document.getElementById('csv')!.click(); document.getElementById('large')!.click(); }; document.body.append(button); }), steps: () => [act('Export both', { expect: { download: { filename: /csv/ } } })] };
    const models = scriptedModels(view => view.history.length ? { done: 0.95 } : { tool: 'click', target: is('button', 'Export both') });
    const result = (await runSuite([spec], { ...options(), models: models.settings })).results[0]!;
    expect(result.status, result.summary).toBe('failed');
    expect(result.attempts[0]?.steps[0]?.failure).toBe('expectation');
    expect(result.summary).toContain('20 MiB');
});

it('enables fixture-dependent downloads and withholds secret files after raw verification', async () => {
    const raw = 'download-private-token';
    const spec: TestSpec<boolean> = { ...base, id: 'private-download', start: '/downloads', secrets: { token: secret(raw) }, fixture: async () => true,
        ready: async ({ page }) => page.evaluate(value => { document.getElementById('csv')!.onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([value])); a.download = 'private.csv'; a.click(); }; }, raw),
        steps: enabled => enabled ? [act('Export CSV', { expect: { download: {} } }), verify('raw content', async ({ downloads }) => await readFile(downloads[0]!.path, 'utf8') === raw)] : [],
    };
    const models = scriptedModels(view => view.history.length ? { done: 0.95 } : { tool: 'click', target: is('button', 'Export CSV') });
    const result = (await runSuite([spec], { ...options(), models: models.settings })).results[0]!;
    expect(result.status, result.summary).toBe('passed');
    const download = result.attempts[0]!.steps[0]!.downloads![0]!;
    expect(download.withheld).toBe(true);
    await expect(readFile(download.path)).rejects.toMatchObject({ code: 'ENOENT' });
});
