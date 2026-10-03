import type { TestSpec } from '../src/index.ts';
import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveFiles } from '../src/files.ts';
import { act, check, file, run, runSuite, secret, verify } from '../src/index.ts';
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
        const seen = new Set<string>();
        const models = scriptedModels((view) => {
            for (const entry of view.history) { if (entry.event) { seen.add(entry.event); } }
            if (view.step === 'Open child') { return view.url.includes('popup-child') ? { done: 0.95 } : { tool: 'click', target: is('button', 'Open child') }; }
            if (view.step === 'Close child') { return view.url.includes('popup-parent') ? { done: 0.95 } : { tool: 'click', target: is('button', 'Close child') }; }
            return view.text.includes('Parent saved') ? { done: 0.95 } : { tool: 'click', target: is('button', 'Save parent') };
        });
        const summary = await runSuite([popup], { ...options(), models: models.settings });
        expect(summary.results[0]?.status, summary.results[0]?.summary).toBe('passed');
        // The engine hands the app's close to the model; cleanup closing the last page is not another event.
        expect(seen).toContain('tab closed');
        expect(summary.results[0]!.attempts[0]!.events).not.toContain('tab closed');
    });
});

it('waits for all downloads and rejects a late oversized second file', async () => {
    const spec: TestSpec = { ...base, id: 'late-large', start: '/downloads', fixture: async ({ context }) => {
        context.on('page', page => page.on('download', (download) => { if (download.suggestedFilename() === 'large.csv') { const save = download.saveAs.bind(download); download.saveAs = async (path) => { await new Promise(resolve => setTimeout(resolve, 1500)); return save(path); }; } }));
    }, ready: async ({ page }) => page.evaluate(() => { const button = document.createElement('button'); button.textContent = 'Export both'; button.onclick = () => { document.getElementById('csv')!.click(); document.getElementById('large')!.click(); }; document.body.append(button); }), steps: () => [act('Export both', { expect: { download: { filename: /csv/ } } })] };
    const models = scriptedModels(view => view.history.length ? { done: 0.95 } : { tool: 'click', target: is('button', 'Export both') });
    const result = (await runSuite([spec], { ...options(), models: models.settings })).results[0]!;
    expect(result.status, result.summary).toBe('failed');
    expect(result.attempts[0]?.steps[0]?.failure).toBe('expectation');
    expect(result.summary).toContain('20 MiB');
});

it('enables fixture-dependent downloads and withholds secret files after raw verification', async () => {
    const raw = 'download-private-token';
    const spec: TestSpec<boolean> = { ...base, id: 'private-download', start: '/downloads', secrets: { token: secret(raw) }, fixture: async () => true, ready: async ({ page }) => page.evaluate((value) => { document.getElementById('csv')!.onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([value])); a.download = 'private.csv'; a.click(); }; }, raw), steps: enabled => enabled ? [act('Export CSV', { expect: { download: {} } }), verify('raw content', async ({ downloads }) => await readFile(downloads[0]!.path, 'utf8') === raw)] : [] };
    const models = scriptedModels(view => view.history.length ? { done: 0.95 } : { tool: 'click', target: is('button', 'Export CSV') });
    const result = (await runSuite([spec], { ...options(), models: models.settings })).results[0]!;
    expect(result.status, result.summary).toBe('passed');
    const download = result.attempts[0]!.steps[0]!.downloads![0]!;
    expect(download.withheld).toBe(true);
    await expect(readFile(download.path)).rejects.toMatchObject({ code: 'ENOENT' });
});

describe('reach actions', () => {
    async function runAndReplay(id: string, start: string, instruction: string, models: ReturnType<typeof scriptedModels>, validate: TestSpec['steps'], extra: Partial<TestSpec> = {}) {
        const spec: TestSpec = { ...base, id, start, ...extra, steps: () => [act(instruction, { maxActions: 12 }), ...validate(undefined)] };
        const result = (await runSuite([spec], { ...options(), models: models.settings })).results[0]!;
        expect(result.status, result.summary).toBe('passed');
        const replay = (await runSuite([spec], { ...options(), mode: 'replay' })).results[0]!;
        expect(replay.status, replay.summary).toBe('passed');
        expect(replay.attempts[0]?.models.jevCalls).toBe(0);
        return JSON.parse(await readFile(join(root, `recordings/${id}.json`), 'utf8'));
    }
    const shows = (text: string) => () => [verify(text, async ({ page }) => (await page.locator('#events').textContent())!.includes(text), { timeoutMs: 500 })];
    it('chooses double-click independently of the legacy double flag', async () => {
        const models = scriptedModels(view => view.text.includes('twice|') ? { done: 0.95 } : { tool: 'double_click', target: is('button', 'Open twice') });
        await runAndReplay('chosen-double', '/reach-actions', 'Open twice with a double-click', models, shows('twice'));
    });
    it('records pointer-only dragging independently of HTML draggable', async () => {
        const models = scriptedModels(view => view.text.includes('moved|') ? { done: 0.95 } : { tool: 'drag', target: element => element.name === 'Task', destination: element => element.name === 'Finished' });
        await runAndReplay('pointer-drag', '/reach-actions', 'Move Task to Finished', models, shows('moved'));
    });
    it('brings static paragraphs into view without an interactive role', async () => {
        const models = scriptedModels(view => view.text.includes('end visible') ? { done: 0.95 } : { tool: 'scroll_to', target: element => element.name === 'End notes' });
        await runAndReplay('paragraph-scroll', '/reach-actions', 'Bring End notes into view', models, shows('end visible'));
    });
    it('clicks custom listbox options independently of native selects', async () => {
        const models = scriptedModels(view => view.notices.includes('Category chosen') ? { done: 0.95 } : view.history.some(entry => entry.action === 'type') ? { tool: 'select', target: is('listbox', 'Matches'), option: 'Office supplies' } : { tool: 'type', target: is('combobox', 'Category'), value: 'query' });
        await runAndReplay('custom-option', '/reach-select?duplicates', 'Search {query} and choose Office supplies', models, () => [verify('category', ({ page }) => page.locator('#status').textContent().then(value => value === 'Category chosen'))], { data: { query: 'Office' } });
    });
    it('records long press and double click as chosen tools', async () => {
        const models = scriptedModels(view => view.text.includes('held|twice') ? { done: 0.95 } : view.text.includes('held|') ? { tool: 'double_click', target: is('button', 'Open twice') } : { tool: 'long_press', target: is('button', 'Hold action') });
        await runAndReplay('gestures', '/reach-actions', 'Hold action, then open twice', models, shows('held|twice'));
    });
    it('uses visible totals after choosing among identical accessible button names', async () => {
        const models = scriptedModels(view => view.notices.includes('Summary confirmed') ? { done: 0.95 } : view.text.includes('Total 5.00') ? { tool: 'click', target: is('button', 'Finish') } : { tool: 'click', target: element => element.name === 'Choose amount' && Reflect.get(element, 'content') === '5' });
        await runAndReplay('visible-summary', '/reach-visual', 'Choose 5, then Finish the summary', models, () => [verify('summary', ({ page }) => page.locator('#status').textContent().then(text => text === 'Summary confirmed'))]);
    });
    it('records context menus on text without a role', async () => {
        const models = scriptedModels(view => view.text.includes('renamed|') ? { done: 0.95 } : view.elements.some(is('button', 'Rename file')) ? { tool: 'click', target: is('button', 'Rename file') } : { tool: 'right_click', target: element => element.name === 'notes.txt' });
        await runAndReplay('context', '/reach-actions', 'Rename notes.txt through its context menu', models, shows('renamed'));
    });
    it('records HTML drag and pointer drag with both semantic targets', async () => {
        const models = scriptedModels(view => view.text.includes('delivered|moved|') ? { done: 0.95 } : view.text.includes('delivered|') ? { tool: 'drag', target: element => element.name === 'Task', destination: element => element.name === 'Finished' } : { tool: 'drag', target: element => element.name === 'Parcel', destination: element => element.name === 'Receiving area' });
        const recipe = await runAndReplay('drag', '/reach-actions', 'Deliver Parcel to Receiving area and move Task to Finished', models, shows('delivered|moved'));
        expect(recipe.steps[0].actions.filter((action: { tool: string }) => action.tool === 'drag').every((action: { destination?: unknown }) => action.destination)).toBe(true);
    });
    it('returns through history and scrolls to static text during replay', async () => {
        const models = scriptedModels(view => view.url.includes('reach-details') ? { tool: 'back' } : view.history.some(entry => entry.action === 'back') ? { done: 0.95 } : { tool: 'click', target: is('link', 'View details') });
        await runAndReplay('history', '/reach-actions', 'View details, then return through history', models, () => [verify('returned', ({ page }) => page.url().endsWith('/reach-actions'))]);
        const scroll = scriptedModels(view => view.text.includes('end visible') ? { done: 0.95 } : { tool: 'scroll_to', target: element => element.name === 'End notes' });
        await runAndReplay('scroll-target', '/reach-actions', 'Bring End notes into view', scroll, shows('end visible'));
    });
    it('does not offer back when the only earlier history entry is a blank page', async () => {
        let backAvailable = false;
        const models = scriptedModels(view => view.text.includes('twice|') ? { done: 0.95 } : { tool: backAvailable ? 'back' : 'double_click', target: is('button', 'Open twice') });
        const evaluate = models.settings.models!.evaluation as unknown as { doEvaluate: (...args: any[]) => Promise<any> };
        const original = evaluate.doEvaluate.bind(evaluate);
        evaluate.doEvaluate = async (...args) => { backAvailable = Boolean(args[0].questions.tool?.criteria.back); return original(...args); };
        await runAndReplay('history-boundary', '/reach-actions', 'Open twice with a double-click', models, shows('twice'));
    });
    it('uploads every declared file together into a multiple input', async () => {
        await writeFile(join(root, 'invoice.txt'), 'invoice');
        const models = scriptedModels(view => view.text.includes('avatar.txt,invoice.txt') ? { done: 0.95 } : { tool: 'upload', target: is('button', 'Documents'), value: 'avatar' });
        const recipe = await runAndReplay('multi-upload', '/reach-actions', 'Attach {avatar} and {invoice} through Documents', models, shows('avatar.txt,invoice.txt'), { files: { avatar: file('avatar.txt'), invoice: file('invoice.txt') } });
        expect(recipe.steps[0].actions[0].fileKeys).toEqual(['avatar', 'invoice']);
    });
    it('keeps a selected single-file upload separate from other step file references', async () => {
        await writeFile(join(root, 'invoice.txt'), 'invoice');
        const models = scriptedModels(view => view.text.includes('avatar.txt|') ? { done: 0.95 } : { tool: 'upload', target: is('button', 'Documents'), value: 'avatar', fileGroup: 'selected' });
        await runAndReplay('selected-file', '/reach-actions', 'Attach {avatar} only; leave {invoice} for a later upload', models, () => [verify('one file', ({ page }) => page.locator('#files').evaluate(element => (element as HTMLInputElement).files?.length === 1))], { files: { avatar: file('avatar.txt'), invoice: file('invoice.txt') } });
    });
    it('selects a literal native option and clicks an ARIA option after debounce', async () => {
        const native = scriptedModels(view => view.notices.includes('Order chosen') ? { done: 0.95 } : { tool: 'select', target: is('combobox', 'Order'), option: 'Oldest first' });
        await runAndReplay('native-option', '/reach-select', 'Choose Oldest first', native, () => [verify('order', ({ page }) => page.locator('#order').inputValue().then(value => value === 'Oldest first'))]);
        const aria = scriptedModels(view => view.notices.includes('Category chosen') ? { done: 0.95 } : view.history.some(entry => entry.action === 'type') ? { tool: 'select', target: is('listbox', 'Matches'), option: 'Office supplies' } : { tool: 'type', target: is('combobox', 'Category'), value: 'query' });
        await runAndReplay('aria-option', '/reach-select', 'Search {query} and choose Office supplies', aria, () => [verify('category', ({ page }) => page.locator('#status').textContent().then(value => value === 'Category chosen'))], { data: { query: 'Office' } });
    });
    it('holds hover through observation and records editable text', async () => {
        const models = scriptedModels(view => view.elements.some(is('button', 'Invite member')) ? { done: 0.95 } : { tool: 'hover', target: element => element.name === 'Workspace' });
        await runAndReplay('hover-menu', '/reach-observe', 'Hover Workspace to reveal Invite member', models, () => [verify('revealed', ({ page }) => page.getByRole('button', { name: 'Invite member' }).isVisible())]);
        const editor = scriptedModels(view => view.elements.some(element => element.name === 'Draft' && element.value === view.values.text) ? { done: 0.95 } : { tool: 'type', target: is('textbox', 'Draft'), value: 'text' });
        await runAndReplay('editable', '/reach-observe', 'Set Draft to {text}', editor, () => [verify('draft', ({ page }) => page.locator('[contenteditable]').textContent().then(value => value === 'Ready to ship'))], { data: { text: 'Ready to ship' } });
    });
    it('searches windowed and growing containers with bounded scrolling and records the search', async () => {
        for (const [id, start, target, button, done] of [['windowed', '/reach-scroll', 'Record 154', 'Open record', 'Record opened'], ['growing', '/reach-feed', 'Update 39', 'Open update', 'Update opened']]) {
            const models = scriptedModels(view => view.notices.includes(done!) ? { done: 0.95 } : view.elements.some(is('button', button!)) ? { tool: 'click', target: is('button', button!) } : { tool: 'scroll', target: element => Boolean(element.scroll), scrollText: target });
            await runAndReplay(id!, start!, `Scroll until ${target} appears, then ${button}`, models, () => [verify(done!, ({ page }) => page.locator('#status').textContent().then(text => text === done))]);
        }
    }, 90000);
    it('scrolls a windowed container upward and records the direction', async () => {
        const models = scriptedModels(view => /(?:^|\s)Record 1(?:\s|$)/.test(view.text) ? { done: 0.95 } : { tool: 'scroll', target: element => Boolean(element.scroll), scrollText: 'Record 1', scrollDirection: 'up' });
        const recipe = await runAndReplay('scroll-up', '/reach-scroll', 'Scroll up until Record 1 appears', models, () => [verify('top', ({ page }) => page.locator('#results').evaluate(element => element.scrollTop < 80))], { ready: ({ page }) => page.locator('#results').evaluate(element => { element.scrollTop = element.scrollHeight; }) });
        expect(recipe.steps[0].actions[0].scrollDirection).toBe('up');
    });
    it('offers the named unseen scroll goal without generic instruction fragments', async () => {
        const models = scriptedModels(view => view.notices.includes('Record opened') ? { done: 0.95 } : view.elements.some(is('button', 'Open record')) ? { tool: 'click', target: is('button', 'Open record') } : { tool: 'scroll', target: element => Boolean(element.scroll), scrollText: 'Record 154' });
        const evaluate = models.settings.models!.evaluation as unknown as { doEvaluate: (...args: any[]) => Promise<any> };
        const original = evaluate.doEvaluate.bind(evaluate);
        evaluate.doEvaluate = async (...args) => {
            if (args[0].questions.scroll_start) { expect(args[0].questions.scroll_text).toBeUndefined(); expect(Object.values(args[0].questions.scroll_start.criteria)).toContain('Record (word 9)'); }
            return original(...args);
        };
        await runAndReplay('named-search', '/reach-scroll?hint', 'Follow the archive instructions: scroll the windowed results until Record 154 appears, then Open record', models, () => [verify('record', ({ page }) => page.locator('#status').textContent().then(text => text === 'Record opened'))]);
    });
    it('scrolls the sole movable container when the model targets its content', async () => {
        const models = scriptedModels(view => view.notices.includes('Record opened') ? { done: 0.95 } : view.elements.some(is('button', 'Open record')) ? { tool: 'click', target: is('button', 'Open record') } : { tool: 'scroll', target: is('link', 'Profile'), scrollText: 'Record 154' });
        await runAndReplay('content-scroll', '/reach-scroll', 'Scroll until Record 154 appears, then Open record', models, () => [verify('record', ({ page }) => page.locator('#status').textContent().then(text => text === 'Record opened'))]);
    });
    it('relocates a semantic target when model latency spans DOM replacement', async () => {
        const models = scriptedModels(view => view.notices.includes('Count 3') ? { done: 0.95 } : { tool: 'click', target: is('button', 'Increment') });
        const evaluate = models.settings.models!.evaluation as unknown as { doEvaluate: (...args: any[]) => Promise<any> };
        const original = evaluate.doEvaluate.bind(evaluate); evaluate.doEvaluate = async (...args) => { await new Promise(resolve => setTimeout(resolve, 550)); return original(...args); };
        await runAndReplay('rebuild', '/reach-rebuild', 'Increment three times', models, () => [verify('three', ({ page }) => page.locator('#status').textContent().then(text => text === 'Count 3'))]);
    }, 40000);
});

it('withholds screenshots when a secret appears in a closed root or editor', async () => {
    for (const closed of [true, false]) {
        const value = secret('private-shadow-text');
        const spec: TestSpec = { ...base, id: closed ? 'closed-private' : 'editor-private', start: '/reach-observe', ready: async ({ page }) => page.evaluate(({ closed, text }) => {
            const editor = closed ? (Reflect.get(window, 'fixtureRoot') as ShadowRoot).appendChild(document.createElement('p')) : document.querySelector('[contenteditable]')!;
            editor.textContent = text;
        }, { closed, text: 'private-shadow-text' }), steps: () => [verify('displayed', () => true)] };
        const carrier: TestSpec = { ...base, id: closed ? 'closed-carrier' : 'editor-carrier', secrets: { value }, steps: () => [] };
        const summary = await runSuite([spec, carrier], { ...options(), mode: 'replay' });
        const attempt = summary.results[0]!.attempts[0]!;
        expect(attempt.status).toBe('passed'); expect(attempt.screenshotsWithheld).toBe(true);
        expect(attempt.steps[0]!.screenshot).toBeUndefined();
    }
});

it('refuses page-option selection when the option contains a declared secret', async () => {
    const spec: TestSpec = { ...base, id: 'private-option', start: '/reach-select', secrets: { token: secret('private-option-value') }, ready: ({ page }) => page.locator('#order').evaluate(element => { const option = document.createElement('option'); option.textContent = 'private-option-value'; element.append(option); }), steps: () => [act('Choose the private option in Order', { maxActions: 1 })] };
    const models = scriptedModels(() => ({ tool: 'select', target: is('combobox', 'Order'), option: '{secret}' }));
    const result = (await runSuite([spec], { ...options(), models: models.settings })).results[0]!;
    expect(result.status).toBe('failed');
    expect(JSON.stringify(result)).toContain('Secret input cannot use the select tool');
    expect(JSON.stringify(result)).not.toContain('private-option-value');
});


it('integration reports a missing scroll search instead of succeeding silently', async () => {
    const spec: TestSpec = { ...base, id: 'missing-scroll-search', start: '/reach-feed', steps: () => [act('Scroll until Update 90 appears', { maxActions: 2 })] };
    const models = scriptedModels(() => ({ tool: 'scroll', target: element => Boolean(element.scroll), scrollText: 'Update 90' }));
    const result = (await runSuite([spec], { ...options(), models: models.settings })).results[0]!;
    expect(result.attempts[0]!.steps[0]!.actions?.[0]).toMatchObject({ ok: false, error: expect.stringMatching(/not found after \d+ viewports/) });
});

it('integration keeps a connected original ref when an identical sibling is inserted during model latency', async () => {
    let inserted = false;
    const models = scriptedModels(view => view.notices.includes('Summary confirmed') ? { done: 0.95 } : view.text.includes('Total 5.00') ? { tool: 'click', target: is('button', 'Finish') } : { tool: 'click', target: element => element.name === 'Choose amount' && Reflect.get(element, 'content') === '5' });
    const evaluate = models.settings.models!.evaluation as unknown as { doEvaluate: (...args: any[]) => Promise<any> };
    const original = evaluate.doEvaluate.bind(evaluate);
    const spec: TestSpec = { ...base, id: 'connected-ref', start: '/reach-visual', ready: async ({ page }) => {
        evaluate.doEvaluate = async (...args) => { const result = await original(...args); if (!inserted && args[0].questions.tool) { inserted = true; await page.locator('[data-amount="5"]').evaluate(element => { const clone = element.cloneNode(true) as HTMLElement; clone.onclick = () => { throw new Error('Wrong duplicate selected'); }; element.before(clone); }); } return result; };
    }, steps: () => [act('Choose 5, then Finish the summary'), verify('summary', ({ page }) => page.locator('#status').textContent().then(text => text === 'Summary confirmed'))] };
    const result = (await runSuite([spec], { ...options(), models: models.settings })).results[0]!;
    expect(result.status, result.summary).toBe('passed');
});


it('integration searches a model-selected literal after until you see and preserves parentheses', async () => {
    const models = scriptedModels(view => view.notices.includes('Record opened') ? { done: 0.95 } : view.elements.some(is('button', 'Open record')) ? { tool: 'click', target: is('button', 'Open record') } : { tool: 'scroll', target: element => Boolean(element.scroll), scrollText: 'Record 154' });
    const spec: TestSpec = { ...base, id: 'model-search-phrase', start: '/reach-scroll', steps: () => [act('Scroll until you see Record 154 (in the list), then Open record'), verify('record', ({ page }) => page.locator('#status').textContent().then(text => text === 'Record opened'))] };
    const result = (await runSuite([spec], { ...options(), models: models.settings })).results[0]!;
    expect(result.status, result.summary).toBe('passed');
    const recipe = JSON.parse(await readFile(join(root, 'recordings/model-search-phrase.json'), 'utf8'));
    expect(recipe.steps[0].actions[0].scrollText).toBe('Record 154');
});

it('integration does not record a helper wait action', async () => {
    const models = scriptedModels(view => view.text.includes('twice|') ? { done: 0.95 } : view.history.some(entry => entry.action === 'wait') ? { tool: 'double_click', target: is('button', 'Open twice') } : { tool: 'none' }, () => ({ outcome: 'act', tool: 'wait', element: null, value_key: null, text: null, reason: 'Wait for the next render' }));
    const spec: TestSpec = { ...base, id: 'helper-wait', start: '/reach-actions', steps: () => [act('Open twice with a double-click'), verify('twice', ({ page }) => page.locator('#events').textContent().then(text => text?.includes('twice') === true))] };
    const result = (await runSuite([spec], { ...options(), models: models.settings })).results[0]!;
    expect(result.status, result.summary).toBe('passed');
    const recipe = JSON.parse(await readFile(join(root, 'recordings/helper-wait.json'), 'utf8'));
    expect(recipe.steps[0].actions.some((action: { tool: string }) => action.tool === 'wait')).toBe(false);
});

it('integration keeps bounded busy waits outside the action budget', async () => {
    const models = scriptedModels(view => view.text.includes('twice|') ? { done: 0.99 } : view.history.filter(entry => entry.action === 'wait').length < 3 ? { tool: 'wait' } : { tool: 'double_click', target: is('button', 'Open twice') });
    const spec: TestSpec = { ...base, id: 'independent-busy-waits', start: '/reach-actions', steps: () => [act('Wait for the control, then Open twice with a double-click', { maxActions: 1 }), verify('twice', ({ page }) => page.locator('#events').textContent().then(text => text?.includes('twice') === true))] };
    const result = (await runSuite([spec], { ...options(), models: models.settings })).results[0]!;
    expect(result.status, result.summary).toBe('passed');
});

it('integration searches quoted instruction text without including quotation delimiters', async () => {
    const models = scriptedModels(view => view.notices.includes('Record opened') ? { done: 0.95 } : view.elements.some(is('button', 'Open record')) ? { tool: 'click', target: is('button', 'Open record') } : { tool: 'scroll', target: element => Boolean(element.scroll), scrollText: 'Record 154' });
    const spec: TestSpec = { ...base, id: 'quoted-search', start: '/reach-scroll', steps: () => [act('Scroll until "Record 154" appears, then Open record'), verify('record', ({ page }) => page.locator('#status').textContent().then(text => text === 'Record opened'))] };
    const result = (await runSuite([spec], { ...options(), models: models.settings })).results[0]!;
    expect(result.status, result.summary).toBe('passed');
});


it('rejects a drag whose source and destination are the same element', async () => {
    const spec: TestSpec = { ...base, id: 'self-drag', start: '/reach-actions', steps: () => [act('Deliver Parcel to Receiving area'), verify('delivered', async ({ page }) => (await page.locator('output').textContent())?.includes('delivered') === true)] };
    const models = scriptedModels(view => view.history.some(entry => entry.action === 'drag' && !entry.error) ? { done: 0.95 } : { tool: 'drag', target: is('generic', 'Parcel'), destination: is('generic', 'Parcel') });
    const result = (await runSuite([spec], { ...options(), mode: 'ai', models: models.settings })).results[0]!;
    expect(result.cause, result.summary).toBe('agent');
    expect(result.attempts[0]!.steps[0]!.actions?.[0]?.ok).toBe(false);
    expect(result.attempts[0]!.steps[0]!.actions?.[0]?.error).toMatch(/different elements/);
    expect(result.attempts[0]!.steps).toHaveLength(1);
});
