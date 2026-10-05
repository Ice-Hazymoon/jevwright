import type { TestSpec } from '../src/index.ts';
import type { RunSummary, SuiteOptions } from '../src/suite.ts';
import type { View, ViewElement } from './support/scripted-models.ts';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssertionError } from 'node:assert';
import { expect as playwrightExpect } from 'playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runFailureExitCode } from '../src/cli.ts';
import { act, check, reload, run, runSuite, secret, verify } from '../src/index.ts';
import { describePageValue, pageValueChoices, readPageValue } from '../src/page-values.ts';
import { createRedactor } from '../src/secrets.ts';
import { startFixtureApp } from './fixtures/app.ts';
import { deferredPolicy, fixturePolicy, gestureNavigationPolicy, integrityPolicy, reservationPolicy, reservationScopePolicy, savedViewPolicy, singlePageSearchPolicy } from './support/fixture-policy.ts';
import { scriptedModels } from './support/scripted-models.ts';

type App = Awaited<ReturnType<typeof startFixtureApp>>;

let app: App;
let root: string;

beforeAll(async () => {
    app = await startFixtureApp();
    root = await mkdtemp(join(tmpdir(), 'jevwright-engine-'));
});
afterAll(async () => {
    await app?.close();
    if (root) { await rm(root, { recursive: true, force: true }); }
});

function profileTest(start = '/profile'): TestSpec<void> {
    return {
        id: 'profile-save',
        module: 'fixture',
        title: 'Edit and save the profile',
        risk: 'Saved profile changes are lost',
        start,
        data: { nickname: 'Grace Hopper', bio: 'Compilers and COBOL' },
        fixture: async () => { app.reset(); },
        steps: () => [
            act('Change Nickname to {nickname} and Bio to {bio}'),
            act('Save the profile', { expect: { write: { method: 'POST', path: '/api/profile', status: 200 } } }),
            reload(),
            check('The Nickname field shows {nickname}'),
            verify('profile persisted', () => Promise.resolve({ passed: app.state.profile.nickname === 'Grace Hopper' && app.state.profile.bio === 'Compilers and COBOL', evidence: app.state.profile })),
        ],
    };
}

function suite(specs: Array<TestSpec<void>>, options: Partial<SuiteOptions> & { policy?: typeof fixturePolicy; helper?: Parameters<typeof scriptedModels>[1]; costPerCall?: number } = {}) {
    const scripted = scriptedModels(options.policy ?? fixturePolicy, options.helper, { costPerCall: options.costPerCall });
    const run = runSuite(specs, {
        baseURL: app.origin,
        outputDir: join(root, 'runs'),
        recordingsDir: join(root, 'recordings'),
        concurrency: 1,
        retries: 0,
        models: scripted.settings,
        log: () => undefined,
        ...options,
    });
    return { run, calls: scripted.calls };
}

const statusOf = (summary: RunSummary) => Object.fromEntries(summary.results.map(result => [result.id, result.status === 'passed' ? 'passed' : `${result.status}:${result.cause}`]));

describe('integrity regression paths', () => {
    const base = { id: 'integrity-save', title: 'Store a draft', risk: 'A receipt is missing', start: '/integrity', ready: async ({ page }: { page: import('playwright').Page }) => { await page.evaluate(() => { history.replaceState({}, '', '/integrity'); }); } };
    const policy = integrityPolicy;
    it('omits unused proof selection when recording updates are disabled', async () => {
        const execution = suite([profileTest()], { updateRecordings: false });
        expect((await execution.run).totals.passed).toBe(1);
        const judgments = execution.calls.filter(call => call.questions.includes('holds'));
        expect(judgments).not.toHaveLength(0);
        expect(judgments.every(call => !call.questions.includes('evidence'))).toBe(true);
    });
    it('does not request replay proof for a trusted-reference check', async () => {
        const spec = { ...profileTest(), steps: () => [check('The Nickname field shows "Ada"', { reference: async () => ({ nickname: 'Ada' }) })] };
        const execution = suite([spec]);
        expect((await execution.run).totals.passed).toBe(1);
        expect(execution.calls.filter(call => call.questions.includes('holds')).every(call => !call.questions.includes('evidence'))).toBe(true);
    });
    it.each(['missing', 'half', 'query', 'alert', 'invalid', '500', 'shadow-alert', 'frame-alert'])('fails replay when the recorded effect drifts: %s', async bug => {
        const recordingsDir = join(root, 'integrity-drift-' + bug);
        const spec = { ...base, steps: () => [act('Save draft')] };
        expect((await suite([spec], { policy, recordingsDir }).run).totals.passed).toBe(1);
        const result = await suite([{ ...spec, start: '/integrity?bug=' + bug }], { mode: 'replay', recordingsDir }).run;
        expect(result.results[0]?.status).toBe('failed');
        expect(runFailureExitCode(result)).toBe(1);
    });
    it('does not treat a hidden error as a newly visible replay error', async () => {
        const recordingsDir = join(root, 'integrity-hidden-error');
        const spec = { ...base, steps: () => [act('Save draft')] };
        expect((await suite([spec], { policy, recordingsDir }).run).totals.passed).toBe(1);
        expect((await suite([{ ...spec, start: '/integrity?bug=hidden-alert' }], { mode: 'replay', recordingsDir }).run).totals.passed).toBe(1);
    });
    it('reports legacy checks as unverified and preserves the exit override separately', async () => {
        const summary = await suite([{ ...base, steps: () => [check('Draft stored')] }], { mode: 'replay' }).run;
        expect(summary.results[0]?.status).toBe('unverified');
        expect(summary.results[0]?.attempts[0]?.steps[0]?.status).toBe('unverified');
        expect(runFailureExitCode(summary)).toBe(1);
        expect(runFailureExitCode(summary, true, true)).toBe(0);
    });
    it('attributes thrown assertions to product and ordinary exceptions to environment', async () => {
        const assertions = await suite([{ ...base, steps: () => [verify('receipt', () => { throw new AssertionError({ actual: false, expected: true, operator: 'strictEqual' }); })] }], { mode: 'replay' }).run;
        expect(assertions.results[0]?.cause).toBe('product');
        const exceptions = await suite([{ ...base, steps: () => [verify('broken helper', () => { throw new TypeError('bad test code'); })] }], { mode: 'replay' }).run;
        expect(exceptions.results[0]?.cause).toBe('environment');
    });
    it('recognizes a Playwright matcher error as a product assertion', async () => {
        const result = await suite([{ ...base, steps: () => [verify('receipt', async ({ page }) => { await playwrightExpect(page.getByRole('heading', { name: 'Absent receipt' })).toBeVisible({ timeout: 50 }); return true; })] }], { mode: 'replay' }).run;
        expect(result.results[0]?.cause).toBe('product');
    });
    it('saves only verified prefixes of failed attempts as partial recordings', async () => {
        const recordingsDir = join(root, 'integrity-partial');
        const spec = { ...base, steps: () => [act('Save draft'), verify('receipt', () => true), verify('later failure', () => false, { timeoutMs: 1 })] };
        expect((await suite([spec], { policy, recordingsDir }).run).results[0]?.status).toBe('failed');
        const recording = JSON.parse(await readFile(join(recordingsDir, base.id + '.json'), 'utf8'));
        expect(recording.partial).toBe(true);
        expect(recording.steps).toHaveLength(1);
        const next = await suite([spec], { policy, recordingsDir }).run;
        expect(next.results[0]?.attempts[0]?.steps[0]?.source).toBe('replay');
    });
    it('retains a complete recording when a later auto attempt fails', async () => {
        const recordingsDir = join(root, 'complete-prefix-preserved');
        const steps = (passed: boolean) => [act('Save draft'), check('The Draft field shows "Original"'), verify('later assertion', () => passed, { timeoutMs: 1 }), act('Open Details')];
        const policy = (view: View) => view.claim ? { holds: 0.99, support: 'supports' as const, region: 'open' as const } : view.step === 'Open Details' && !view.history.length ? { tool: 'click' as const, target: (element: ViewElement) => element.name === 'Details' } : integrityPolicy(view);
        const spec = { ...base, steps: () => steps(true) };
        expect((await suite([spec], { policy, recordingsDir }).run).totals.passed).toBe(1);
        const file = join(recordingsDir, base.id + '.json');
        const legacy = JSON.parse(await readFile(file, 'utf8'));
        delete legacy.steps.find((step: { checkEvidence?: unknown }) => step.checkEvidence)?.checkEvidence;
        await writeFile(file, JSON.stringify(legacy));
        expect((await suite([{ ...spec, steps: () => steps(false) }], { policy, recordingsDir }).run).results[0]?.status).toBe('failed');
        expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(legacy);
        expect((await suite([spec], { mode: 'replay', recordingsDir }).run).totals.failed).toBe(0);
    });
    it('rechecks replay proof after a dialog finishes leaving the snapshot', async () => {
        const recordingsDir = join(root, 'check-dialog-exit');
        const ready = async ({ page }: { page: import('playwright').Page }) => { await page.getByRole('dialog').evaluate(node => node.remove()); };
        const spec = { ...base, id: 'check-dialog-exit', start: '/proof-dialog-exit', ready, steps: () => [check('The Draft field shows "Original"')] };
        const policy = () => ({ holds: 0.99, support: 'supports' as const, region: 'open' as const });
        expect((await suite([spec], { policy, recordingsDir }).run).totals.passed).toBe(1);
        const exiting = { ...spec, ready: async ({ page }: { page: import('playwright').Page }) => {
            const snapshot = page.ariaSnapshotJSON.bind(page);
            const stale = await snapshot({ mode: 'ai', boxes: true });
            await ready({ page });
            let reads = 0;
            page.ariaSnapshotJSON = options => ++reads === 1 ? Promise.resolve(stale) : snapshot(options);
        } };
        expect((await suite([exiting], { recordingsDir, mode: 'replay' }).run).totals.passed).toBe(1);
    });
    it('reports cancelled running tests as interrupted', async () => {
        const controller = new AbortController();
        const result = await suite([{ ...base, steps: () => [run('interrupt', () => controller.abort()), verify('unreached', () => true)] }], { mode: 'replay', signal: controller.signal }).run;
        expect(result.results[0]?.status).toBe('interrupted');
        expect(result.totals.interrupted).toBe(1);
        const xml = await readFile(join(result.directory, 'junit.xml'), 'utf8');
        expect(xml).toContain('type="interrupted"');
    });
    it('rechecks recorded check quotes and rejects a changed field value', async () => {
        const spec = { ...profileTest(), id: 'integrity-check-evidence', steps: () => [check('The Nickname field shows "Ada"')] };
        const recordingsDir = join(root, 'integrity-check-evidence');
        expect((await suite([spec], { recordingsDir }).run).totals.passed).toBe(1);
        const healthy = await suite([spec], { recordingsDir, mode: 'replay' }).run;
        expect(healthy.results[0]?.attempts[0]?.steps[0]).toMatchObject({ status: 'passed', source: 'replay' });
        const drift = await suite([{ ...spec, ready: async ({ page }) => { await page.getByLabel('Nickname').fill('Wrong'); } }], { recordingsDir, mode: 'replay' }).run;
        expect(drift.results[0]?.status).toBe('failed');
    });
    it('records every field in a compound factual check', async () => {
        const recordingsDir = join(root, 'compound-check-evidence');
        const spec = { ...base, id: 'compound-check', ready: async ({ page }: { page: import('playwright').Page }) => { await page.goto(app.origin + '/profile'); }, steps: () => [check('The Nickname field shows "Ada" and the Bio field shows "Notes"')] };
        const prepared = { ...spec, ready: async ({ page }: { page: import('playwright').Page }) => { await spec.ready({ page }); await page.getByLabel('Nickname').fill('Ada'); await page.getByLabel('Bio').fill('Notes'); } };
        const policy = () => ({ holds: 0.99, support: 'supports' as const, region: 'open' as const });
        expect((await suite([prepared], { recordingsDir, policy }).run).totals.passed).toBe(1);
        const recording = JSON.parse(await readFile(join(recordingsDir, spec.id + '.json'), 'utf8'));
        expect(recording.steps[0].checkEvidence.map((entry: { target?: { name: string } }) => entry.target?.name)).toEqual(['Nickname', 'Bio']);
        const drift = { ...prepared, ready: async ({ page }: { page: import('playwright').Page }) => { await prepared.ready({ page }); await page.getByLabel('Bio').fill('Wrong'); } };
        expect((await suite([drift], { recordingsDir, mode: 'replay' }).run).results[0]?.status).toBe('failed');
    });
    it('keeps check evidence in its recorded region', async () => {
        const recordingsDir = join(root, 'integrity-evidence-region');
        const spec = { ...base, id: 'region-bound-check', start: '/integrity-region', ready: undefined, steps: () => [check('The Draft field in Draft area shows "Original"')] };
        const policy = () => ({ holds: 0.99, support: 'supports' as const, region: 'open' as const });
        expect((await suite([spec], { recordingsDir, policy }).run).totals.passed).toBe(1);
        expect((await suite([spec], { recordingsDir, mode: 'replay' }).run).totals.passed).toBe(1);
        const moved = { ...spec, start: '/integrity-region?bug=moved', ready: async ({ page }: { page: import('playwright').Page }) => { await page.evaluate(() => history.replaceState({}, '', '/integrity-region')); } };
        expect((await suite([moved], { recordingsDir, mode: 'replay' }).run).results[0]?.status).toBe('failed');
    });
    it('reports clipped recorded check evidence as unverified', async () => {
        const recordingsDir = join(root, 'integrity-clipped-evidence');
        const spec = { ...base, id: 'clipped-check', steps: () => [check('The Draft field shows "Original"')] };
        expect((await suite([spec], { recordingsDir, policy: () => ({ holds: 0.99, support: 'supports', region: 'open' }) }).run).totals.passed).toBe(1);
        const path = join(recordingsDir, 'clipped-check.json');
        const recording = JSON.parse(await readFile(path, 'utf8'));
        recording.steps[0].checkEvidence[0].value = 'Orig…';
        await writeFile(path, JSON.stringify(recording));
        expect((await suite([spec], { recordingsDir, mode: 'replay' }).run).results[0]?.status).toBe('unverified');
    });
    it('uses each occurrence of an identical instruction for its own control', async () => {
        const recordingsDir = join(root, 'integrity-occurrences');
        const spec = { ...base, id: 'integrity-repeated', steps: () => [act('Activate current control'), act('Activate current control')] };
        const repeated = (view: View) => view.history.some(entry => entry.action === 'click') ? { done: 0.99 } : { tool: 'click', target: (element: { name?: string }) => element.name === (view.text.includes('Draft stored') ? 'Details' : 'Save draft') };
        expect((await suite([spec], { recordingsDir, policy: repeated }).run).totals.passed).toBe(1);
        const result = await suite([spec], { recordingsDir, mode: 'replay' }).run;
        expect(result.results[0]?.status).toBe('passed');
        expect(result.results[0]?.attempts[0]?.steps[1]?.actions?.[0]?.element).toBe('button "Details"');
    });
    it('lets declared request evidence retain legacy precedence over cached end anchors', async () => {
        const recordingsDir = join(root, 'legacy-request-precedence');
        const spec = { ...base, steps: () => [act('Save draft', { expect: { write: { method: 'POST', path: '/api/integrity', status: 500 } }, expectError: true })], start: '/integrity?bug=500' };
        expect((await suite([spec], { recordingsDir, policy }).run).totals.passed).toBe(1);
        const path = join(recordingsDir, base.id + '.json');
        const recording = JSON.parse(await readFile(path, 'utf8'));
        recording.steps[0].end = { appeared: [{ kind: 'heading', text: 'Old cached heading' }] };
        await writeFile(path, JSON.stringify(recording));
        expect((await suite([spec], { recordingsDir, mode: 'replay' }).run).totals.passed).toBe(1);
    });
    it('reports legacy end drift while allowing later code checks to judge it', async () => {
        const recordingsDir = join(root, 'legacy-replay-drift');
        const spec = { ...base, steps: () => [act('Save draft'), verify('receipt visible', ({ page }) => page.getByRole('heading', { name: 'Draft stored', exact: true }).isVisible())] };
        expect((await suite([spec], { recordingsDir, policy }).run).totals.passed).toBe(1);
        const path = join(recordingsDir, base.id + '.json');
        const recording = JSON.parse(await readFile(path, 'utf8'));
        recording.steps[0].end = { appeared: [{ kind: 'heading', text: 'Old cached heading' }] };
        await writeFile(path, JSON.stringify(recording));
        const result = await suite([spec], { recordingsDir, mode: 'replay' }).run;
        expect(result.totals.passed).toBe(1);
        expect(result.results[0]?.attempts[0]?.steps[0]?.endMismatch).toBe(true);
    });
    it('reuses an unnumbered legacy recipe for repeated instructions after reload', async () => {
        const recordingsDir = join(root, 'legacy-occurrences');
        const spec = { ...base, id: 'legacy-repeated', steps: () => [act('Save draft'), reload(), act('Save draft')] };
        expect((await suite([spec], { recordingsDir, policy }).run).totals.passed).toBe(1);
        const path = join(recordingsDir, spec.id + '.json');
        const recording = JSON.parse(await readFile(path, 'utf8'));
        for (const entry of recording.steps) { entry.key = recording.steps[0].key; delete entry.occurrence; delete entry.end.strict; }
        await writeFile(path, JSON.stringify(recording));
        expect((await suite([spec], { recordingsDir, mode: 'replay' }).run).totals.passed).toBe(1);
    });
    it.each(['info', 'warning', 'status'])('ignores informational or transient replay notices: %s', async bug => {
        const recordingsDir = join(root, 'notice-' + bug);
        const spec = { ...base, steps: () => [act('Save draft')] };
        expect((await suite([spec], { recordingsDir, policy }).run).totals.passed).toBe(1);
        expect((await suite([{ ...spec, start: '/integrity?bug=' + bug }], { recordingsDir, mode: 'replay' }).run).totals.passed).toBe(1);
    });
    it('does not call an existing notice new when its error role changes', async () => {
        const recordingsDir = join(root, 'existing-notice');
        const spec = { ...base, steps: () => [act('Save draft')] };
        expect((await suite([spec], { recordingsDir, policy }).run).totals.passed).toBe(1);
        expect((await suite([{ ...spec, start: '/integrity?bug=existing-notice' }], { recordingsDir, mode: 'replay' }).run).totals.passed).toBe(1);
    });
    it('accepts an error already visible at the recorded end of this step', async () => {
        const recordingsDir = join(root, 'recorded-error');
        const spec = { ...base, start: '/integrity?bug=alert', steps: () => [act('Save draft')] };
        expect((await suite([spec], { recordingsDir, policy }).run).totals.passed).toBe(1);
        expect((await suite([spec], { recordingsDir, mode: 'replay' }).run).totals.passed).toBe(1);
    });
    it('does not apply new error checks to unmarked legacy recordings', async () => {
        const recordingsDir = join(root, 'legacy-errors');
        const spec = { ...base, steps: () => [act('Save draft')] };
        expect((await suite([spec], { recordingsDir, policy }).run).totals.passed).toBe(1);
        const path = join(recordingsDir, base.id + '.json');
        const recording = JSON.parse(await readFile(path, 'utf8'));
        delete recording.steps[0].end.strict;
        await writeFile(path, JSON.stringify(recording));
        expect((await suite([{ ...spec, start: '/integrity?bug=alert' }], { recordingsDir, mode: 'replay' }).run).totals.passed).toBe(1);
    });
    it('rejects a result that was already present before replay', async () => {
        const recordingsDir = join(root, 'integrity-preexisting');
        const spec = { ...base, steps: () => [act('Save draft')] };
        expect((await suite([spec], { recordingsDir, policy }).run).totals.passed).toBe(1);
        const replay = await suite([{ ...spec, ready: async ({ page }) => { await page.getByRole('button', { name: 'Save draft' }).click(); } }], { recordingsDir, mode: 'replay' }).run;
        expect(replay.results[0]?.status).toBe('failed');
        expect(replay.results[0]?.summary).toContain('already present before replay');
    });
    it('does not call a route-only replay mismatch a missing product effect', async () => {
        const recordingsDir = join(root, 'integrity-route-attribution');
        const spec = { ...base, steps: () => [act('Save draft', { maxActions: 1 })] };
        expect((await suite([spec], { recordingsDir, policy }).run).totals.passed).toBe(1);
        const path = join(recordingsDir, base.id + '.json');
        const recording = JSON.parse(await readFile(path, 'utf8'));
        recording.steps[0].end.route = 'http://127.0.0.1:1/integrity';
        recording.steps[0].end.base = false;
        await writeFile(path, JSON.stringify(recording));
        const auto = await suite([spec], { recordingsDir, policy: () => ({ done: 0.01, tool: 'none', onTarget: 0.99 }) }).run;
        expect(auto.results[0]?.cause).toBe('agent');
        const replay = await suite([spec], { recordingsDir, mode: 'replay' }).run;
        expect(replay.results[0]?.status).toBe('failed');
        expect(replay.results[0]?.attempts[0]?.steps[0]?.failure).toBe('end-mismatch');
    });
    it('tells healing which end condition mismatched instead of claiming all effects are missing', async () => {
        const recordingsDir = join(root, 'integrity-route-history');
        const spec = { ...base, steps: () => [act('Save draft'), verify('receipt', ({ page }) => page.getByRole('heading', { name: 'Draft stored', exact: true }).isVisible())] };
        expect((await suite([spec], { recordingsDir, policy }).run).totals.passed).toBe(1);
        const path = join(recordingsDir, base.id + '.json');
        const recording = JSON.parse(await readFile(path, 'utf8'));
        recording.steps[0].end.route = 'http://127.0.0.1:1/integrity';
        recording.steps[0].end.base = false;
        await writeFile(path, JSON.stringify(recording));
        const informed = (view: View) => view.history.some(entry => entry.event?.includes('recorded end state missing: route ')) ? { done: 0.99 } : { done: 0.01, tool: 'none' };
        const auto = await suite([spec], { recordingsDir, policy: informed }).run;
        expect(auto.results[0]?.status).toBe('passed');
        expect(auto.results[0]?.attempts[0]?.steps[0]?.endMismatch).toBe(true);
        expect(await readFile(path, 'utf8')).toBe(JSON.stringify(recording));
    });
    it.each(['replay', 'auto'] as const)('retains replay validation as agent with a validation body in %s', async mode => {
        const recordingsDir = join(root, 'integrity-replay-validation');
        const spec = { ...base, steps: () => [act('Save draft')] };
        expect((await suite([spec], { recordingsDir, policy }).run).totals.passed).toBe(1);
        const replay = await suite([{ ...spec, start: '/integrity?bug=validation' }], { recordingsDir, mode }).run;
        expect(replay.results[0]?.cause).toBe('agent');
        expect(replay.results[0]?.attempts[0]?.steps[0]?.failure).toBe('error-shown');
    });
    it('keeps an observed rejected declared write ahead of a replay validation error', async () => {
        const recordingsDir = join(root, 'integrity-declared-validation');
        const spec = { ...base, steps: () => [act('Save draft')] };
        expect((await suite([spec], { recordingsDir, policy }).run).totals.passed).toBe(1);
        const replay = await suite([{ ...spec, start: '/integrity?bug=validation', steps: () => [act('Save draft', { expect: { write: { path: '/api/integrity-validation', status: 200 } } })] }], { recordingsDir, mode: 'replay' }).run;
        expect(replay.results[0]?.cause).toBe('product');
        expect(replay.results[0]?.attempts[0]?.steps[0]?.failure).toBe('expectation');
    });
    it.each([{ wrong: true, status: '422' }, { wrong: false, status: '422' }, { wrong: true, status: '500' }, { wrong: false, status: '500' }])('audits rejected writes without blaming product for the wrong field: $wrong/$status', async ({ wrong, status }) => {
        const driver = (view: View) => ({ onTarget: wrong ? 0.02 : 0.98, ...(view.history.some(entry => entry.action === 'click') ? { done: 0.01, tool: 'none' } : view.history.some(entry => entry.action === 'type') ? { tool: 'click', target: (element: { name?: string }) => element.name === 'Store draft' } : { tool: 'type', value: 'draft', target: (element: { name?: string }) => element.name === (wrong ? 'Reference' : 'Draft') }) });
        const spec = { ...base, id: 'request-audit-' + wrong + status, start: '/integrity-audit?bug=' + status, ready: undefined, data: { draft: 'Stored content' }, steps: () => [act('Enter {draft} in Draft and store the draft', { maxActions: 2 })] };
        const result = (await suite([spec], { policy: driver, failOnIssues: false }).run).results[0]!;
        expect(result.cause).toBe(wrong ? 'agent' : 'product');
        if (wrong) { expect(result.attempts[0]?.steps[0]?.misstep).toContain('Reference'); }
    });
    it.each(['500', '422', 'validation'])('audits agent failures against request evidence: %s', async bug => {
        const unfinished = (view: View) => view.history.some(entry => entry.action === 'click') ? { done: 0.01, tool: 'none', ...(bug === 'validation' ? { error: 0.99 } : {}) } : { tool: 'click', target: (element: { name?: string }) => element.name === 'Save draft' };
        const result = await suite([{ ...base, start: '/integrity?bug=' + bug, steps: () => [act('Save draft')] }], { policy: unfinished, failOnIssues: false }).run;
        expect(result.results[0]?.cause).toBe(bug === 'validation' ? 'agent' : 'product');
        if (bug !== 'validation') { expect(result.results[0]?.summary).toContain('Request evidence:'); }
    });
});

describe('record, replay and heal', () => {
    it('grounds steps with Jev on first run and records a replayable path', async () => {
        const { run, calls } = suite([profileTest()], { mode: 'auto' });
        const summary = await run;
        const [result] = summary.results;
        expect(result!.status, result!.summary).toBe('passed');
        const attempt = result!.attempts[0]!;
        // Checks are judged by Jev, so they report as ai, not code.
        expect(attempt.steps.map(step => step.source)).toEqual(['ai', 'ai', 'code', 'ai', 'code']);
        expect(attempt.steps[0]!.actions!.map(action => `${action.tool} ${action.value}`)).toEqual(['type nickname', 'type bio']);
        expect(attempt.steps[1]!.writes).toMatchObject([{ method: 'POST', path: '/api/profile', status: 200 }]);
        expect(result!.recordingUpdated).toBe(true);
        expect(calls.length).toBeGreaterThan(3);

        const recording = JSON.parse(await readFile(join(root, 'recordings', 'profile-save.json'), 'utf8')) as { steps: Array<{ actions: Array<{ target: { role: string; name: string } }> }> };
        expect(recording.steps[1]!.actions[0]!.target).toMatchObject({ role: 'button', name: 'Save profile' });
    });

    it('replays the recording with no model calls for actions', async () => {
        await suite([profileTest()]).run;
        const { run, calls } = suite([profileTest()], { mode: 'replay' });
        const summary = await run;
        const [result] = summary.results;
        expect(result!.status, result!.summary).toBe('passed');
        expect(result!.attempts[0]!.steps.slice(0, 2).map(step => step.source)).toEqual(['replay', 'replay']);
        // Replay checks use recorded evidence and never load models.
        expect(calls).toHaveLength(0);
        expect(result!.attempts[0]!.steps[3]).toMatchObject({ status: 'passed', source: 'replay' });
    });

    it('heals a step whose recorded control was renamed, then updates the recording', async () => {
        const { run } = suite([profileTest('/profile?bug=relabel')], { mode: 'auto' });
        const summary = await run;
        const [result] = summary.results;
        expect(result!.status, result!.summary).toBe('passed');
        const [change, save] = result!.attempts[0]!.steps;
        expect(change!.source).toBe('replay');
        expect(save!.source).toBe('healed');
        expect(save!.replayMiss).toMatch(/Save profile/);
        expect(result!.recordingUpdated).toBe(true);
        const recording = JSON.parse(await readFile(join(root, 'recordings', 'profile-save.json'), 'utf8')) as { steps: Array<{ actions: Array<{ target: { name: string } }> }> };
        expect(recording.steps[1]!.actions[0]!.target.name).toBe('Update profile');
    });

    it('fails, without retrying, a test whose steps were never recorded when replay mode may not call models', async () => {
        const { run } = suite([{ ...profileTest(), id: 'never-recorded' }], { mode: 'replay', retries: 1 });
        const summary = await run;
        const [result] = summary.results;
        // A green CI run must not hide a test that never ran.
        expect(result!.status).toBe('failed');
        expect(result!.cause).toBe('agent');
        expect(result!.summary).toMatch(/Replay cannot run step 1 .*no recording/);
        expect(result!.attempts).toHaveLength(1);
        expect(result!.attempts[0]!.steps[0]!.failure).toBe('not-recorded');
        expect(summary.totals.failed).toBe(1);
    });

    it('fails only the test whose recording file is corrupt, as an environment problem', async () => {
        await mkdir(join(root, 'recordings'), { recursive: true });
        await writeFile(join(root, 'recordings', 'corrupt-recording.json'), '{"version": 1, "test": "corrupt-recording"');
        const { run } = suite([{ ...profileTest(), id: 'corrupt-recording' }, { ...profileTest(), id: 'unrecorded-start' }], { mode: 'replay', dryRun: true });
        const summary = await run;
        expect(statusOf(summary)).toEqual({ 'corrupt-recording': 'failed:environment', 'unrecorded-start': 'passed' });
        expect(summary.results[0]!.summary).toMatch(/^Invalid recording .*corrupt-recording\.json .*Fix or delete the file/);
    });

    it('fails replay mode with an agent cause when the recording is stale and no model may heal it', async () => {
        const { run } = suite([{ ...profileTest('/profile'), id: 'profile-save' }], { mode: 'replay' });
        const summary = await run;
        const [result] = summary.results;
        expect(result!.status).toBe('failed');
        expect(result!.cause).toBe('agent');
        expect(result!.attempts[0]!.steps[1]!.replayMiss).toMatch(/Update profile/);
    });
});

describe('dry run', () => {
    it('checks fixture, start page and invariants without running steps or models', async () => {
        const { run, calls } = suite([{ ...profileTest(), id: 'dry-profile', invariants: [{ name: 'seeded', check: async () => app.state.profile.nickname === 'Ada' }] }], { mode: 'ai', dryRun: true });
        const [result] = (await run).results;
        expect(result!.status, result!.summary).toBe('passed');
        expect(result!.summary).toMatch(/^Dry run: .*1 invariant.*5 steps not run/);
        expect(result!.attempts[0]!.steps).toEqual([]);
        expect(calls).toHaveLength(0);
        const observation = JSON.parse(await readFile(join(result!.attempts[0]!.directory, 'start-observation.json'), 'utf8')) as { elements: Array<{ name: string }> };
        expect(observation.elements.map(element => element.name)).toContain('Nickname');
    });

    it('fails a dry run when the start page throws on load', async () => {
        const { run } = suite([{ id: 'dry-broken', module: 'fixture', title: 'Broken', risk: 'Crash', start: '/broken', steps: () => [] }], { dryRun: true });
        const [result] = (await run).results;
        expect(result!.cause).toBe('product');
    });
});

describe('expected errors', () => {
    const rejectedSave = (id: string, expectError: boolean): TestSpec<void> => ({
        ...profileTest('/profile?bug=500'),
        id,
        steps: () => [
            act('Change Nickname to {nickname} and Bio to {bio}'),
            act('Save the profile', expectError
                ? { expectError, expect: { write: { method: 'POST', path: '/api/profile', status: 500 } } }
                : { expect: { write: { method: 'POST', path: '/api/profile' } } }),
            verify('nothing stored', () => Promise.resolve({ passed: app.state.profile.nickname === 'Ada', evidence: app.state.profile })),
        ],
    });

    it('accepts the failure an expectError step declares, but not the same failure in an ordinary step', async () => {
        const { run } = suite([rejectedSave('save-rejected-as-expected', true), rejectedSave('save-rejected-unexpectedly', false)], { mode: 'ai' });
        expect(statusOf(await run)).toEqual({ 'save-rejected-as-expected': 'passed', 'save-rejected-unexpectedly': 'failed:product' });
    }, 120_000);
});

describe('defect attribution', () => {
    const variants = (): Array<TestSpec<void>> => [
        { ...profileTest('/profile?bug=nosave'), id: 'profile-lost' },
        { ...profileTest('/profile?bug=500'), id: 'profile-500' },
        { ...profileTest('/profile?bug=truncate'), id: 'profile-truncated', data: { nickname: 'Grace Hopper', bio: 'Compilers and COBOL' } },
        ...(['', 'sticky'] as const).map((bug): TestSpec<void> => ({
            id: `settings${bug ? `-${bug}` : ''}`,
            module: 'fixture',
            title: 'Toggle email preferences',
            risk: 'A preference does not persist',
            start: `/settings${bug ? `?bug=${bug}` : ''}`,
            fixture: async () => { app.reset(); },
            steps: () => [
                act('Turn on the Weekly digest emails', { expect: { write: { path: '/api/settings', status: 200 } } }),
                act('Turn off the Product news emails', { expect: { write: { path: '/api/settings', status: 200 } } }),
                verify('stored', () => Promise.resolve({ passed: app.state.settings.digest === true && app.state.settings.news === false, evidence: app.state.settings })),
            ],
        })),
        ...(['', 'wrong-row'] as const).map((bug): TestSpec<void> => ({
            id: `archive${bug ? `-${bug}` : ''}`,
            module: 'fixture',
            title: 'Archive one plan',
            risk: 'The wrong plan is archived',
            start: `/items${bug ? `?bug=${bug}` : ''}`,
            fixture: async () => { app.reset(); },
            invariants: [{ name: 'Alpha and Gamma stay active', check: () => Promise.resolve(app.state.items.filter(item => item.id !== 'b').every(item => !item.archived)) }],
            steps: () => [
                act('Start archiving the Beta plan'),
                act('Confirm archiving in the dialog', { expect: { write: { path: /\/archive$/, status: 200 } } }),
                check('The Beta plan is shown as Archived'),
            ],
        })),
        ...(['', 'nan'] as const).map((bug): TestSpec<void> => ({
            id: `currency${bug ? `-${bug}` : ''}`,
            module: 'fixture',
            title: 'Switch currency',
            risk: 'Prices render as NaN',
            start: `/currency${bug ? `?bug=${bug}` : ''}`,
            data: { currency: 'Euro' },
            fixture: async () => { app.reset(); },
            steps: () => [
                act('Choose {currency} as the display currency'),
                act('Save the currency', { expect: { write: { path: '/api/currency', status: 200 } } }),
                reload(),
                check('The price preview shows an amount in euros'),
            ],
        })),
        { id: 'broken', module: 'fixture', title: 'Crashing page', risk: 'Crash', start: '/broken', steps: () => [check('The page shows a total')] },
    ];

    it('blames the environment, not the product, when the app fails to download its own code', async () => {
        const stale: TestSpec<void> = { id: 'stale-chunk', module: 'fixture', title: 'Stale build', risk: 'Editor never loads', start: '/stale-chunk', knownIssue: 'A product defect on another step', steps: () => [check('The editor is shown')] };
        const summary = await suite([stale], { mode: 'ai' }).run;
        expect(statusOf(summary)).toEqual({ 'stale-chunk': 'failed:environment' });
        expect(summary.results[0]!.summary).toMatch(/asset-load while loading \/stale-chunk/);
    }, 60_000);

    it('passes healthy flows and blames the product for every seeded defect', async () => {
        const { run } = suite(variants(), { mode: 'ai', translationKeys: ['settings.profile.title'] });
        const summary = await run;
        expect(statusOf(summary)).toEqual({
            'profile-lost': 'failed:product',
            'profile-500': 'failed:product',
            'profile-truncated': 'failed:product',
            'settings': 'passed',
            'settings-sticky': 'failed:product',
            'archive': 'passed',
            'archive-wrong-row': 'failed:product',
            'currency': 'passed',
            'currency-nan': 'failed:product',
            'broken': 'failed:product',
        });
        const byId = Object.fromEntries(summary.results.map(result => [result.id, result]));
        expect(byId['profile-lost']!.summary).toMatch(/UI check failed/);
        expect(byId['profile-500']!.issues.map(issue => issue.kind)).toContain('http-5xx');
        expect(byId['profile-truncated']!.summary).toMatch(/Business verification failed/);
        expect(byId['archive-wrong-row']!.summary).toMatch(/Invariant "Alpha and Gamma stay active"/);
        expect(byId.broken!.summary).toMatch(/page-error/);
        expect(byId.broken!.issues.map(issue => issue.kind)).toEqual(expect.arrayContaining(['page-error', 'text-anomaly', 'raw-i18n-key']));
        expect(byId['currency-nan']!.issues.some(issue => /NaN/.test(issue.message))).toBe(true);

        const markdown = await readFile(join(summary.directory, 'report.md'), 'utf8');
        expect(markdown).toMatch(/product/);
        const saved = JSON.parse(await readFile(join(summary.directory, 'summary.json'), 'utf8')) as RunSummary;
        expect(saved.totals).toMatchObject({ tests: 10, passed: 3, failed: 7 });
        expect((await readFile(join(summary.directory, 'report.html'), 'utf8')).length).toBeGreaterThan(1000);
    }, 240_000);

    it('re-runs a product failure to show it reproduces', async () => {
        const { run } = suite([{ ...profileTest('/profile?bug=nosave'), id: 'profile-lost-twice' }], { mode: 'ai', retries: 1 });
        const [result] = (await run).results;
        expect(result!.status).toBe('failed');
        expect(result!.reproduced).toBe('2/2');
    }, 90_000);
});

describe('known product issues', () => {
    const saveProfile = (id: string, start: string, knownIssue: string): TestSpec<void> => ({
        ...profileTest(start),
        id,
        knownIssue,
    });

    it('reports a confirmed product defect as known, once, without failing the run', async () => {
        const { run } = suite([saveProfile('known-save-500', '/profile?bug=500', 'Profile save returns 500 (tracked)')], { mode: 'ai', retries: 1 });
        const summary = await run;
        const [result] = summary.results;
        expect(result!.status).toBe('known');
        expect(result!.cause).toBe('product');
        expect(result!.attempts).toHaveLength(1);
        expect(summary.totals).toMatchObject({ known: 1, failed: 0 });
        const markdown = await readFile(join(summary.directory, 'report.md'), 'utf8');
        expect(markdown).toContain('Profile save returns 500 (tracked)');
    });

    it('flags a known issue that no longer reproduces', async () => {
        const { run } = suite([saveProfile('known-but-fixed', '/profile', 'Profile save used to fail')], { mode: 'ai' });
        const summary = await run;
        expect(summary.results[0]!.status).toBe('passed');
        expect(await readFile(join(summary.directory, 'report.md'), 'utf8')).toMatch(/no longer reproduce[\s\S]*known-but-fixed/);
    });

    it('still fails a known-issue test that breaks for another reason', async () => {
        const { run } = suite([{ ...saveProfile('known-but-agent', '/profile', 'Profile save returns 500'), steps: () => [act('Download the latest invoice as PDF')] }], { mode: 'ai', retries: 0 });
        const [result] = (await run).results;
        expect(result!.status).toBe('failed');
        expect(result!.cause).toBe('agent');
    });
});

describe('agent failures', () => {
    it('blames the agent, not the product, when a step names a control that does not exist', async () => {
        const helperCalls: string[] = [];
        const { run } = suite([{
            id: 'missing-control',
            module: 'fixture',
            title: 'Download an invoice',
            risk: 'n/a',
            start: '/profile',
            fixture: async () => { app.reset(); },
            steps: () => [act('Download the latest invoice as PDF')],
        }], {
            mode: 'ai',
            helper: (_view, why) => {
                helperCalls.push(why);
                return { outcome: 'impossible', tool: null, element: null, value_key: null, text: null, reason: 'There is no invoice control on this page' };
            },
        });
        const [result] = (await run).results;
        expect(result!.status).toBe('failed');
        expect(result!.cause).toBe('agent');
        expect(result!.attempts[0]!.steps[0]!.failure).toBe('not-found');
        expect(helperCalls).toEqual(['Jev proposed no action']);
    });

    it('blames the agent when a failed business check follows actions on a control the step did not name', async () => {
        const { run } = suite([{
            id: 'wrong-field',
            module: 'fixture',
            title: 'Set the nickname',
            risk: 'n/a',
            start: '/profile',
            data: { nickname: 'Grace Hopper' },
            fixture: async () => { app.reset(); },
            steps: () => [
                act('Put {nickname} in the Nickname field'),
                act('Save the profile', { expect: { write: { method: 'POST', path: '/api/profile' } } }),
                verify('nickname stored', () => Promise.resolve({ passed: app.state.profile.nickname === 'Grace Hopper', evidence: app.state.profile })),
            ],
        }], { mode: 'ai', retries: 0 });
        const [result] = (await run).results;
        expect(result!.status).toBe('failed');
        expect(result!.cause).toBe('agent');
        expect(result!.summary).toContain('textbox "Bio"');
    });

    it('blames the model service, not the environment, when a check cannot get an answer', async () => {
        const { run } = suite([{
            id: 'check-model-down',
            module: 'fixture',
            title: 'Judge the page',
            risk: 'n/a',
            start: '/profile',
            fixture: async () => { app.reset(); },
            // Jev cannot decide this claim, so it goes to the helper, which times out.
            steps: () => [check('The page is written in iambic pentameter')],
        }], { mode: 'ai', retries: 0, policy: () => ({ holds: 0.5, support: 'not_shown', pSupport: 0.5 }), helper: () => { throw new Error('The operation timed out.'); } });
        const [result] = (await run).results;
        expect(result!.status).toBe('failed');
        expect(result!.cause).toBe('model');
    });

    it('lets the helper model unstick a step Jev cannot ground', async () => {
        const { run } = suite([{
            id: 'helper-unsticks',
            module: 'fixture',
            title: 'Open plans',
            risk: 'n/a',
            start: '/profile',
            steps: () => [act('Go to the Plans section', { expect: { url: /^\/items/ } })],
        }], {
            mode: 'ai',
            policy: view => view.url.startsWith('/items') ? { done: 0.95 } : { done: 0.02, tool: 'none' },
            helper: (view) => {
                const link = view.elements.find(element => element.role === 'link' && element.name === 'Plans')!;
                return { outcome: 'act', tool: 'click', element: link.i, value_key: null, text: null, reason: 'The Plans link opens the section' };
            },
        });
        const [result] = (await run).results;
        expect(result!.status, result!.summary).toBe('passed');
        expect(result!.attempts[0]!.steps[0]!.actions!.map(action => action.source)).toEqual(['llm']);
    });
});

describe('gaps found on real apps', () => {
    const base = { module: 'fixture', title: 'Fixture', risk: 'n/a', fixture: async () => { app.reset(); } };

    it('completes a step once its declared write succeeds, even while an earlier error is still shown', async () => {
        const { run } = suite([{
            ...base,
            id: 'save-after-failure',
            start: '/profile?bug=fail-once',
            data: { nickname: 'Grace Hopper', bio: 'Compilers and COBOL' },
            steps: () => [
                act('Change Nickname to {nickname} and Bio to {bio}'),
                act('Save the profile', { expectError: true, expect: { write: { method: 'POST', path: '/api/profile', status: 503 } } }),
                // The failure alert stays on screen and the successful retry shows no toast.
                act('Save the profile again', { expect: { write: { method: 'POST', path: '/api/profile' } } }),
                verify('stored', () => Promise.resolve({ passed: app.state.profile.nickname === 'Grace Hopper', evidence: app.state.profile })),
            ],
        }], { mode: 'ai' });
        const [result] = (await run).results;
        expect(result!.status, result!.summary).toBe('passed');
    });

    it('clears a field when the step names no value to type, and saves what each check judged', async () => {
        const { run } = suite([{
            ...base,
            id: 'clear-bio',
            start: '/profile',
            steps: () => [
                act('Delete all text from the Bio field, leaving it empty'),
                act('Save the profile', { expect: { write: { method: 'POST', path: '/api/profile' } } }),
                verify('bio is empty', () => Promise.resolve({ passed: app.state.profile.bio === '', evidence: app.state.profile })),
                reload(),
                check('The Nickname field shows "Ada"'),
            ],
        }], { mode: 'ai' });
        const [result] = (await run).results;
        expect(result!.status, result!.summary).toBe('passed');
        const attempt = result!.attempts[0]!;
        expect(attempt.steps[0]!.actions!.map(action => `${action.tool} ${action.value}`)).toContain('type ""');
        const observation = JSON.parse(await readFile(join(attempt.directory, attempt.steps[4]!.observation!), 'utf8')) as { elements: Array<{ name: string; value?: string }> };
        expect(observation.elements).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Nickname', value: 'Ada' })]));
    });

    it('adds a second typed part to the same field instead of replacing the first', async () => {
        const { run } = suite([{
            ...base,
            id: 'two-part-bio',
            start: '/profile',
            data: { first: 'Line one', second: 'Line two' },
            steps: () => [
                act('Write {first} and {second} on two lines in the Bio'),
                act('Save the profile', { expect: { write: { method: 'POST', path: '/api/profile' } } }),
                verify('both lines stored', () => Promise.resolve({ passed: app.state.profile.bio === 'Line one\nLine two', evidence: app.state.profile })),
            ],
        }], { mode: 'ai' });
        const [result] = (await run).results;
        expect(result!.status, result!.summary).toBe('passed');
    });

    it('replays a multi-part typing path with its append flag', async () => {
        const spec: TestSpec<void> = {
            ...base,
            id: 'two-part-bio-replay',
            start: '/profile',
            data: { first: 'Line one', second: 'Line two' },
            steps: () => [
                act('Write {first} and {second} on two lines in the Bio'),
                act('Save the profile', { expect: { write: { method: 'POST', path: '/api/profile' } } }),
                verify('both lines stored', () => Promise.resolve({ passed: app.state.profile.bio === 'Line one\nLine two', evidence: app.state.profile })),
            ],
        };
        const recorded = (await suite([spec], { mode: 'ai' }).run).results[0]!;
        expect(recorded.status, recorded.summary).toBe('passed');
        const replayed = (await suite([spec], { mode: 'replay' }).run).results[0]!;
        expect(replayed.status, replayed.summary).toBe('passed');
        expect(replayed.attempts[0]!.steps[0]!.source).toBe('replay');
    });

    it('replaces, not appends, when the same value is typed into a field again', async () => {
        const { run } = suite([{
            ...base,
            id: 'retype-same-bio',
            start: '/profile',
            data: { bio: 'Typed once' },
            steps: () => [
                act('Set the Bio to {bio} and make sure it took'),
                act('Save the profile', { expect: { write: { method: 'POST', path: '/api/profile' } } }),
                verify('bio stored once', () => Promise.resolve({ passed: app.state.profile.bio === 'Typed once', evidence: app.state.profile })),
            ],
        }], { mode: 'ai' });
        const [result] = (await run).results;
        expect(result!.status, result!.summary).toBe('passed');
    });

    it('tells Jev which values code confirmed are exactly in a field', async () => {
        const { run } = suite([{
            ...base,
            id: 'exact-bio',
            start: '/profile',
            data: { bio: '東京で制作\nDesign for everyone — 欢迎' },
            steps: () => [act('Set the Bio to exactly {bio}')],
        }], { mode: 'ai' });
        const [result] = (await run).results;
        expect(result!.status, result!.summary).toBe('passed');
        expect(result!.attempts[0]!.steps[0]!.actions!.map(action => action.tool)).toEqual(['type']);
    });

    it('does not accept the helper\'s "done" while Jev sees the step unfinished', async () => {
        const { run } = suite([{ ...base, id: 'helper-claims-done', start: '/profile', steps: () => [act('Make the profile famous')] }], {
            mode: 'ai',
            helper: () => ({ outcome: 'step_already_done', tool: null, element: null, value_key: null, text: null, reason: 'It is already famous' }),
        });
        const [result] = (await run).results;
        expect(result!.status).toBe('failed');
        expect(result!.cause).toBe('agent');
    });

    it('clicks a control that only takes pointer events while its card is hovered', async () => {
        const { run } = suite([{
            ...base,
            id: 'hover-toolbar',
            start: '/cards',
            steps: () => [act('Customize the Alpha card', { expect: { write: { method: 'POST', path: '/api/cards/alpha/customize' } } })],
        }], { mode: 'ai' });
        const [result] = (await run).results;
        expect(result!.status, result!.summary).toBe('passed');
        expect(app.state.customizing).toBe('alpha');
    });

    it('reveals a hover toolbar that hangs outside its card by hovering the card itself', async () => {
        const { run } = suite([{
            ...base,
            id: 'hanging-toolbar',
            start: '/cards',
            steps: () => [act('Customize the Beta card', { expect: { write: { method: 'POST', path: '/api/cards/beta/customize' } } })],
        }], { mode: 'ai' });
        const [result] = (await run).results;
        expect(result!.status, result!.summary).toBe('passed');
        expect(app.state.customizing).toBe('beta');
    });

    it('keeps a step open after its declared write while a value it names was never entered', async () => {
        const { run } = suite([{
            ...base,
            id: 'edit-not-add',
            start: '/board',
            data: { text: 'Revision B' },
            steps: () => [
                act('Open the Note card and replace its text with {text}', { expect: { write: { method: 'POST', path: '/api/board' } } }),
                verify('the Note card holds the text', () => Promise.resolve({ passed: app.state.board.find(card => card.title === 'Note')?.text === 'Revision B', evidence: app.state.board })),
            ],
        }], { mode: 'ai' });
        const [result] = (await run).results;
        expect(result!.status, result!.summary).toBe('passed');
    });

    it('lets the helper enter the step\'s own values joined by line breaks as one replacement', async () => {
        const { run } = suite([{
            ...base,
            id: 'blank-line-bio',
            start: '/profile',
            data: { first: 'Line one', second: 'Line two' },
            steps: () => [
                act('Write {first}, then a blank line, then {second} in the Bio'),
                act('Save the profile', { expect: { write: { method: 'POST', path: '/api/profile' } } }),
                verify('bio stored exactly', () => Promise.resolve({ passed: app.state.profile.bio === 'Line one\n\nLine two', evidence: app.state.profile })),
            ],
        }], {
            mode: 'ai',
            helper: (view) => {
                const bio = view.elements.find(element => element.role === 'textbox' && element.name === 'Bio');
                return { outcome: 'act', tool: 'type', element: bio?.i ?? null, value_key: null, text: `${view.values.first}\n\n${view.values.second}`, reason: 'Both paragraphs go in as one replacement' };
            },
        });
        const [result] = (await run).results;
        expect(result!.status, result!.summary).toBe('passed');
    });

    it('asks the helper as soon as a click is blocked, naming what covers the target', async () => {
        const { run } = suite([{
            ...base,
            id: 'covered-publish',
            start: '/drawer',
            steps: () => [act('Publish the page', { expect: { write: { method: 'POST', path: '/api/publish' } } })],
        }], {
            mode: 'ai',
            helper: (view) => {
                const close = view.elements.find(element => element.role === 'button' && element.name === 'Close drawer');
                return close
                    ? { outcome: 'act', tool: 'click', element: close.i, value_key: null, text: null, reason: 'The open drawer covers Publish' }
                    : { outcome: 'impossible', tool: null, element: null, value_key: null, text: null, reason: 'no drawer' };
            },
        });
        const [result] = (await run).results;
        expect(result!.status, result!.summary).toBe('passed');
        expect(app.state.published).toBe(1);
        const actions = result!.attempts[0]!.steps[0]!.actions!;
        expect(actions.map(action => `${action.source} ${action.ok} ${action.element}`)).toEqual([
            expect.stringMatching(/^jev false button "Publish"/),
            expect.stringMatching(/^llm true button "Close drawer"/),
            expect.stringMatching(/^jev true button "Publish"/),
        ]);
        expect(actions[0]!.error).toContain('Text settings');
    });

    it('does not treat an error shown before the step began as caused by it', async () => {
        const { run } = suite([{
            ...base,
            id: 'stale-alert',
            start: '/profile?bug=500',
            data: { nickname: 'Grace Hopper', bio: 'Compilers', first: 'Line one', second: 'Line two' },
            steps: () => [
                act('Change Nickname to {nickname} and Bio to {bio}'),
                act('Save the profile', { expectError: true, expect: { write: { method: 'POST', path: '/api/profile', status: 500 } } }),
                // The failure alert from the save stays on screen while the next step types.
                act('Write {first} and {second} on two lines in the Bio'),
                verify('both lines are in the Bio field', async ({ page }) => {
                    const bio = await page.getByRole('textbox', { name: 'Bio' }).inputValue();
                    return { passed: bio === 'Line one\nLine two', evidence: { bio } };
                }),
            ],
        }], { mode: 'ai' });
        const [result] = (await run).results;
        expect(result!.status, result!.summary).toBe('passed');
    });

    it('asks the helper how to commit a change Jev still considers done after being told it is not saved', async () => {
        const whys: string[] = [];
        const { run } = suite([{
            ...base,
            id: 'inline-title-helper',
            start: '/title',
            data: { title: 'Launch notes' },
            steps: () => [act('Retitle the page to {title}', { expect: { write: { method: 'POST', path: '/api/title' }, timeoutMs: 1500 } })],
        }], {
            mode: 'ai',
            helper: (view, why) => {
                whys.push(why);
                const field = view.elements.find(element => element.role === 'textbox' && element.name === 'Page title')!;
                return { outcome: 'act', tool: 'press_enter', element: field.i, value_key: null, text: null, reason: 'The title commits on Enter' };
            },
        });
        const [result] = (await run).results;
        expect(result!.status, result!.summary).toBe('passed');
        expect(app.state.title).toBe('Launch notes');
        expect(whys).toEqual([expect.stringContaining('not been saved')]);
    });

    it('tells Jev the declared save has not happened instead of accepting "done" on sight', async () => {
        const { run } = suite([{
            ...base,
            id: 'inline-title',
            start: '/title',
            data: { title: 'Launch notes' },
            steps: () => [act('Rename the page to {title}', { expect: { write: { method: 'POST', path: '/api/title' }, timeoutMs: 1500 } })],
        }], { mode: 'ai' });
        const [result] = (await run).results;
        expect(result!.status, result!.summary).toBe('passed');
        expect(app.state.title).toBe('Launch notes');
    });
});

describe('run budget', () => {
    // Any step is "already achieved" on the first question asked, at a fixed cost per call; no helper escalation.
    const alreadyDone = () => ({ done: 0.95 });
    const twoStepTest = (id: string): TestSpec<void> => ({
        id,
        module: 'fixture',
        title: 'Two no-op steps',
        risk: 'n/a',
        start: '/profile',
        fixture: async () => { app.reset(); },
        steps: () => [act('First step, already done'), act('Second step, already done')],
    });

    it('fails a test in progress at its next model call once the shared budget is reached, and fails tests not yet started without spending more', async () => {
        const { run, calls } = suite([twoStepTest('budget-first'), twoStepTest('budget-second')], {
            mode: 'ai',
            policy: alreadyDone,
            retries: 1,
            maxCostUsd: 0.5,
            costPerCall: 0.5,
        });
        const summary = await run;
        const [first, second] = summary.results;

        // The first step's single call spends the entire $0.50 budget; the second step's call is refused
        // before it is made, so the test fails there instead of completing.
        expect(first!.status).toBe('failed');
        expect(first!.cause).toBe('model');
        expect(first!.summary).toMatch(/Run budget of \$0\.5 reached/);
        expect(first!.attempts).toHaveLength(1); // not retried, though retries: 1 was configured

        // Not a pass: a run that stopped early must not look green.
        expect(second!.status).toBe('failed');
        expect(second!.cause).toBe('model');
        expect(second!.summary).toBe('Not run: Run budget of $0.5 reached');
        expect(second!.attempts).toHaveLength(0);

        // Exactly the one call the first step's first (and only affordable) round made.
        expect(calls).toHaveLength(1);

        const markdown = await readFile(join(summary.directory, 'report.md'), 'utf8');
        expect(markdown).toMatch(/Run budget of \$0\.5 reached/);
    });

    it('does not check the run budget in replay mode, which makes no model calls', async () => {
        const spec = { ...profileTest(), id: 'budget-replay' };
        const recorded = (await suite([spec], { mode: 'ai' }).run).results[0]!;
        expect(recorded.status, recorded.summary).toBe('passed');
        // A cap far below one call's cost would fail an auto/ai run immediately; replay must still pass.
        const { run, calls } = suite([spec], { mode: 'replay', maxCostUsd: 0.0000001 });
        const [result] = (await run).results;
        expect(result!.status, result!.summary).toBe('passed');
        expect(calls).toHaveLength(0);
    });
});

describe('replay effects', () => {
    it('attributes a failed replay expectation to the product', async () => {
        const recordingsDir = join(root, 'replay-expectation');
        const initial = await suite([profileTest()], { recordingsDir }).run;
        expect(initial.totals.passed).toBe(1);
        const replay = await suite([{ ...profileTest(), ready: async ({ page }) => { await page.route('**/api/profile', route => route.fulfill({ status: 500, body: 'Storage unavailable' })); } }], { recordingsDir, mode: 'replay' }).run;
        expect(replay.results[0]?.cause).toBe('product');
        expect(runFailureExitCode(replay)).toBe(1);
        expect(replay.results[0]?.attempts[0]?.steps.find(step => step.status === 'failed')?.failure).toBe('expectation');
    });
});

describe('recorded effects and fresh retries', () => {
    it('keeps an unmatched end state when healing performs no new action', async () => {
        const recordingsDir = join(root, 'end-mismatch');
        const spec = { ...profileTest(), steps: () => [act('Change Nickname to {nickname} and Bio to {bio}'), act('Save the profile'), verify('saved', () => true)] };
        expect((await suite([spec], { recordingsDir }).run).totals.passed).toBe(1);
        const path = join(recordingsDir, 'profile-save.json');
        const recording = JSON.parse(await readFile(path, 'utf8'));
        recording.steps[1].end = { strict: true, appeared: [{ kind: 'heading', text: 'Recorded completion' }] };
        await writeFile(path, JSON.stringify(recording));
        const before = await readFile(path, 'utf8');
        const summary = await suite([spec], { recordingsDir, policy: view => view.step === 'Save the profile' ? { done: 0.99, tool: 'none' } : fixturePolicy(view) }).run;
        expect(summary.results[0]?.status).toBe('passed');
        expect(summary.results[0]?.attempts[0]?.steps[1]?.endMismatch).toBe(true);
        expect(summary.results[0]?.attempts[0]?.steps[1]?.source).toBe('replay');
        expect(summary.results[0]?.recordingUpdated).toBe(false);
        expect(await readFile(path, 'utf8')).toBe(before);
        const replay = await suite([spec], { recordingsDir, mode: 'replay' }).run;
        expect(replay.results[0]?.summary).toContain('step 2\'s replay missed its recorded end state');
        expect(replay.results[0]?.attempts[0]?.steps[1]?.endMismatch).toBe(true);
    });

    it('backfills legacy ends only when a later deterministic check passed, and then stops rewriting', async () => {
        const recordingsDir = join(root, 'legacy-end');
        const spec = profileTest();
        await suite([spec], { recordingsDir }).run;
        const path = join(recordingsDir, 'profile-save.json');
        const recording = JSON.parse(await readFile(path, 'utf8'));
        for (const step of recording.steps) { delete step.end; }
        await writeFile(path, JSON.stringify(recording));
        expect((await suite([spec], { recordingsDir }).run).results[0]?.recordingUpdated).toBe(true);
        const backfilled = await readFile(path, 'utf8');
        expect(JSON.parse(backfilled).steps.filter((step: { actions: unknown[] }) => step.actions.length).every((step: { end?: unknown }) => step.end !== undefined)).toBe(true);
        const stable = await suite([spec], { recordingsDir }).run;
        expect(stable.results[0]?.recordingUpdated).toBe(false);
        expect(await readFile(path, 'utf8')).toBe(backfilled);
        for (const step of recording.steps) { delete step.end; }
        recording.steps = recording.steps.filter((step: { actions: unknown[] }) => step.actions.length);
        await writeFile(path, JSON.stringify(recording));
        const unchecked = { ...spec, steps: () => [act('Change Nickname to {nickname} and Bio to {bio}'), act('Save the profile')], invariants: [{ name: 'always', check: () => true }] };
        expect((await suite([unchecked], { recordingsDir }).run).results[0]?.recordingUpdated).toBe(false);
        expect(await readFile(path, 'utf8')).toBe(JSON.stringify(recording));
    });

    it('uses fresh grounding after replay wrote the wrong field without washing away the first failure', async () => {
        const recordingsDir = join(root, 'fresh-retry');
        const spec = profileTest();
        await suite([spec], { recordingsDir }).run;
        const path = join(recordingsDir, 'profile-save.json');
        const recording = JSON.parse(await readFile(path, 'utf8'));
        const actions = recording.steps[0].actions;
        [actions[0].target, actions[1].target] = [actions[1].target, actions[0].target];
        await writeFile(path, JSON.stringify(recording));
        const summary = await suite([spec], { recordingsDir, retries: 1 }).run;
        const result = summary.results[0]!;
        expect(result.status).toBe('flaky');
        expect(result.attempts[0]?.cause).toBe('product');
        expect(result.attempts[1]?.fresh).toBe(true);
        expect(result.rerouted?.steps).toEqual([1]);
        expect(result.recordingUpdated).toBe(true);
    });
});

function effectTest(start = '/effects'): TestSpec<void> {
    return { id: 'choose-entry', title: 'Choose the entry dated 2026-01-01', risk: 'The wrong dated row is selected', start, ready: async ({ page }) => { await page.evaluate(() => { const url = new URL(location.href); url.searchParams.delete('bug'); history.replaceState({}, '', url); }); }, steps: () => [act('Choose the entry dated 2026-01-01', { maxActions: 2 }), verify('Alpha selected', async ({ page }) => page.getByRole('heading', { name: 'Alpha chosen', exact: true }).isVisible())] };
}
const effectPolicy = (view: View) => view.text.includes('Alpha chosen') ? { done: 0.99, tool: 'none' } : { tool: 'click', target: (element: { name?: string; in?: string }) => element.name === 'Choose' && Boolean(element.in?.includes('2026-01-01')) };

describe('end state attribution', () => {
    it('heals a duplicate control that changed row order, while replay exposes the mismatch', async () => {
        const recordingsDir = join(root, 'swapped-effects');
        const seed = (await suite([effectTest()], { recordingsDir, policy: effectPolicy }).run).results[0]!;
        expect(seed.status, seed.summary).toBe('passed');
        const replay = (await suite([effectTest('/effects?bug=swapped')], { recordingsDir, mode: 'replay' }).run).results[0]!;
        expect(replay.status).toBe('failed');
        expect(replay.cause).toBe('agent');
        expect(replay.summary).toContain('step 1\'s replay missed its recorded end state');
        const healed = (await suite([effectTest('/effects?bug=swapped')], { recordingsDir, policy: effectPolicy }).run).results[0]!;
        expect(healed.status).toBe('passed');
        expect(healed.attempts[0]?.steps[0]?.source).toBe('healed');
        expect(healed.recordingUpdated).toBe(true);
    });

    it('keeps failed duplicate-control healing attributed to the agent', async () => {
        const recordingsDir = join(root, 'ambiguous-effects');
        const seed = (await suite([effectTest()], { recordingsDir, policy: effectPolicy }).run).results[0]!;
        expect(seed.status, seed.summary).toBe('passed');
        const result = (await suite([effectTest('/effects?bug=swapped')], { recordingsDir, policy: () => ({ tool: 'none', done: 0 }) }).run).results[0]!;
        expect(result.status).toBe('failed');
        expect(result.cause).toBe('agent');
    });

    it('attributes a uniquely identified control with no effect to the product', async () => {
        const recordingsDir = join(root, 'unique-effects');
        const seed = (await suite([effectTest('/effects?single=1')], { recordingsDir, policy: effectPolicy }).run).results[0]!;
        expect(seed.status, seed.summary).toBe('passed');
        const result = (await suite([effectTest('/effects?single=1&bug=no-effect')], { recordingsDir, policy: () => ({ tool: 'none', done: 0 }) }).run).results[0]!;
        expect(result.status).toBe('failed');
        expect(result.cause).toBe('product');
        expect(result.summary).toContain('the recorded control was used and the step still had no effect');
    });
});

describe('reviewed acceptance cases', () => {
    const confirmTest = (start: string): TestSpec<void> => ({ id: 'choose-confirm', title: 'Choose and confirm the entry', risk: 'The choice is not confirmed', start, steps: () => [act('Choose the entry dated 2026-01-01', { maxActions: 2 }), act('Confirm the choice', { maxActions: 2 }), verify('confirmed', async ({ page }) => page.getByRole('heading', { name: 'Alpha chosen and confirmed', exact: true }).isVisible())] });
    const confirmPolicy = (view: View) => view.step === 'Confirm the choice'
        ? view.text.includes('confirmed') ? { done: 0.99, tool: 'none' } : { tool: 'click', target: (element: { name?: string }) => element.name === 'Confirm choice' }
        : effectPolicy(view);

    it('drops a healed path that started from a misfired replay, then records the current page from its start', async () => {
        const recordingsDir = join(root, 'healed-discard');
        expect((await suite([effectTest()], { recordingsDir, policy: effectPolicy }).run).results[0]?.status).toBe('passed');
        const healed = (await suite([effectTest('/effects?bug=swapped')], { recordingsDir, policy: effectPolicy }).run).results[0]!;
        expect(healed.status, healed.summary).toBe('passed');
        expect(healed.attempts[0]?.steps[0]?.notRecorded).toContain('missed its end state');
        const path = join(recordingsDir, 'choose-entry.json');
        expect(JSON.parse(await readFile(path, 'utf8')).steps).toEqual([]);
        const regrounded = (await suite([effectTest('/effects?bug=swapped')], { recordingsDir, policy: effectPolicy }).run).results[0]!;
        expect(regrounded.attempts[0]?.steps[0]?.source).toBe('ai');
        const actions = JSON.parse(await readFile(path, 'utf8')).steps[0].actions;
        expect(actions).toHaveLength(1);
        const replay = (await suite([effectTest('/effects?bug=swapped')], { recordingsDir, mode: 'replay' }).run).results[0]!;
        expect(replay.status, replay.summary).toBe('passed');
        expect(replay.attempts[0]?.steps[0]?.endMismatch).toBeUndefined();
    });

    it('stops at a no-effect replay before later verification or replay actions', async () => {
        const recordingsDir = join(root, 'replay-no-effect');
        const seed = (await suite([confirmTest('/effects?single=1&confirm=1')], { recordingsDir, policy: confirmPolicy }).run).results[0]!;
        expect(seed.status, seed.summary).toBe('passed');
        const verifyDir = join(root, 'replay-no-effect-verify');
        expect((await suite([effectTest('/effects?single=1')], { recordingsDir: verifyDir, policy: effectPolicy }).run).results[0]?.status).toBe('passed');
        const product = await suite([effectTest('/effects?single=1&bug=no-effect')], { recordingsDir: verifyDir, mode: 'replay' }).run;
        expect(product.results[0]?.cause).toBe('agent');
        expect(product.results[0]?.summary).toContain('step 1\'s replay missed its recorded end state');
        expect(runFailureExitCode(product)).toBe(1);
        const missed = await suite([confirmTest('/effects?single=1&confirm=1&bug=no-effect')], { recordingsDir, mode: 'replay' }).run;
        expect(missed.results[0]?.cause).toBe('agent');
        expect(missed.results[0]?.attempts[0]?.steps).toHaveLength(1);
        expect(missed.results[0]?.attempts[0]?.steps[0]?.failure).toBe('end-mismatch');
        expect(missed.results[0]?.summary).toContain('step 1\'s replay missed its recorded end state');
        expect(runFailureExitCode(missed)).toBe(1);
    });

    it('keeps a same-path intermittent failure flaky without rerouting or rewriting the recording', async () => {
        const recordingsDir = join(root, 'same-path-flaky');
        let attempts = 0;
        const spec = { ...profileTest(), steps: () => [...profileTest().steps().slice(0, 2), run('count the attempt', () => { attempts++; }), verify('passes after the first try', () => attempts > 1, { timeoutMs: 300 })] };
        expect((await suite([{ ...profileTest(), steps: () => [...profileTest().steps().slice(0, 2), verify('saved', () => true)] }], { recordingsDir }).run).results[0]?.status).toBe('passed');
        const path = join(recordingsDir, 'profile-save.json');
        const before = await readFile(path, 'utf8');
        const result = (await suite([spec], { recordingsDir, retries: 1 }).run).results[0]!;
        expect(result.status).toBe('flaky');
        expect(result.attempts[1]?.fresh).toBe(true);
        expect(result.rerouted).toBeUndefined();
        expect(result.recordingUpdated).toBe(false);
        expect(await readFile(path, 'utf8')).toBe(before);
    });

    it('replays a 0.1.0 recording without end states unchanged in replay mode', async () => {
        const recordingsDir = join(root, 'legacy-replay');
        await suite([profileTest()], { recordingsDir }).run;
        const path = join(recordingsDir, 'profile-save.json');
        const recording = JSON.parse(await readFile(path, 'utf8'));
        for (const step of recording.steps) { delete step.end; }
        await writeFile(path, JSON.stringify(recording));
        const replay = (await suite([profileTest()], { recordingsDir, mode: 'replay' }).run).results[0]!;
        expect(replay.status, replay.summary).toBe('passed');
        expect(await readFile(path, 'utf8')).toBe(JSON.stringify(recording));
    });

    it('exits 1 when a recorded target was removed, and 4 only for a failed test that is solely unrecorded', async () => {
        const recordingsDir = join(root, 'exit-table');
        await suite([profileTest()], { recordingsDir }).run;
        const path = join(recordingsDir, 'profile-save.json');
        const recipe = JSON.parse(await readFile(path, 'utf8'));
        delete recipe.steps[0].end;
        await writeFile(path, JSON.stringify(recipe));
        const removed = await suite([profileTest('/profile?bug=relabel')], { recordingsDir, mode: 'replay' }).run;
        expect(removed.results[0]?.attempts[0]?.steps.find(step => step.status === 'failed')?.failure).toBe('not-found');
        expect(runFailureExitCode(removed)).toBe(1);
        const mismatchDir = join(root, 'exit-table-mismatch');
        expect((await suite([effectTest('/effects?single=1')], { recordingsDir: mismatchDir, policy: effectPolicy }).run).results[0]?.status).toBe('passed');
        const passingMismatch = { ...effectTest('/effects?single=1&bug=no-effect'), steps: () => [act('Choose the entry dated 2026-01-01', { maxActions: 2 })] };
        const unrecorded = { ...profileTest(), id: 'unrecorded-beside-mismatch' };
        const mixed = await suite([passingMismatch, unrecorded], { recordingsDir: mismatchDir, mode: 'replay' }).run;
        expect(mixed.results[0]?.status).toBe('failed');
        expect(mixed.results[0]?.attempts[0]?.steps[0]?.endMismatch).toBe(true);
        expect(runFailureExitCode(mixed)).toBe(1);
    });

    it('uses at most one fresh attempt when more retries are allowed', async () => {
        const recordingsDir = join(root, 'one-fresh');
        await suite([profileTest()], { recordingsDir }).run;
        const spec = { ...profileTest(), steps: () => [...profileTest().steps().slice(0, 2), verify('always fails', () => false, { timeoutMs: 300 })] };
        const result = (await suite([spec], { recordingsDir, retries: 2 }).run).results[0]!;
        expect(result.attempts.map(attempt => attempt.fresh === true)).toEqual([false, true, false]);
        expect(result.cause).toBe('product');
    });
});

describe('replay exit codes', () => {
    it('uses 4 only for standalone replay failures entirely caused by missing recordings', async () => {
        const missing = { ...profileTest(), id: 'never-recorded-exit-code' };
        const summary = await suite([missing], { mode: 'replay' }).run;
        expect(summary.results[0]?.attempts[0]?.steps[0]?.failure).toBe('not-recorded');
        expect(runFailureExitCode(summary)).toBe(4);
        expect(runFailureExitCode(summary, false)).toBe(1);
        const broken = { ...missing, id: 'broken-without-recording', start: '/broken' };
        const mixed = await suite([missing, broken], { mode: 'replay' }).run;
        expect(runFailureExitCode(mixed)).toBe(1);
    });
});

describe('fresh retry limits', () => {
    it('retains the replay cause when fresh driving fails, and skips fresh when the budget is low', async () => {
        const recordingsDir = join(root, 'fresh-limits');
        const spec = profileTest();
        const seed = (await suite([spec], { recordingsDir }).run).results[0]!;
        expect(seed.status, seed.summary).toBe('passed');
        const path = join(recordingsDir, 'profile-save.json');
        const recording = JSON.parse(await readFile(path, 'utf8'));
        const actions = recording.steps[0].actions;
        [actions[0].target, actions[1].target] = [actions[1].target, actions[0].target];
        await writeFile(path, JSON.stringify(recording));
        delete recording.steps[0].end;
        await writeFile(path, JSON.stringify(recording));
        const freshFailed = (await suite([spec], { recordingsDir, retries: 1, policy: view => view.step ? { tool: 'none', done: 0 } : fixturePolicy(view) }).run).results[0]!;
        expect(freshFailed.attempts[0]?.cause).toBe('product');
        expect(freshFailed.attempts[1]?.cause).toBe('agent');
        expect(freshFailed.cause).toBe('product');
        const limited = (await suite([spec], { recordingsDir, retries: 1, maxCostUsd: 1, costPerCall: 0.9 }).run).results[0]!;
        expect(limited.freshRetrySkipped).toBe('fresh retry skipped: run budget');
        expect(limited.attempts[1]?.fresh).toBeUndefined();
    });
});

describe('reviewed replay boundaries', () => {
    it('keeps exit 1 when missing recording follows an end mismatch', async () => {
        const recordingsDir = join(root, 'mismatch-then-missing');
        const spec = profileTest();
        expect((await suite([spec], { recordingsDir }).run).totals.passed).toBe(1);
        const path = join(recordingsDir, 'profile-save.json');
        const recording = JSON.parse(await readFile(path, 'utf8'));
        recording.steps = recording.steps.slice(0, 1);
        recording.steps[0].end = { strict: true, appeared: [{ kind: 'heading', text: 'Missing effect' }] };
        await writeFile(path, JSON.stringify(recording));
        const summary = await suite([spec], { recordingsDir, mode: 'replay' }).run;
        expect(summary.results[0]?.attempts[0]?.steps[0]?.endMismatch).toBe(true);
        expect(summary.results[0]?.attempts[0]?.steps).toHaveLength(1);
        expect(summary.results[0]?.attempts[0]?.steps[0]?.failure).toBe('end-mismatch');
        expect(runFailureExitCode(summary)).toBe(1);
    });

    it('recovers from an unreadable recording in AI mode', async () => {
        const recordingsDir = join(root, 'invalid-ai-recording');
        await mkdir(recordingsDir);
        await writeFile(join(recordingsDir, 'profile-save.json'), '{broken');
        const result = (await suite([profileTest()], { recordingsDir, mode: 'ai' }).run).results[0]!;
        expect(result.status, result.summary).toBe('passed');
        expect(result.recordingUpdated).toBe(true);
        expect(JSON.parse(await readFile(join(recordingsDir, 'profile-save.json'), 'utf8')).steps.length).toBeGreaterThan(0);
    });
});

describe('unchanged check observations', () => {
    it('skips a second certain verdict only when the observed page stayed unchanged', async () => {
        for (const changes of [false, true]) {
            let checks = 0;
            const models = scriptedModels((view) => {
                if (view.claim) { checks++; return checks > 1 ? { holds: 0.99, support: 'supports' } : { holds: 0.01, support: 'contradicts' }; }
                return {};
            });
            const test: TestSpec<void> = { id: changes ? 'check-changed' : 'check-unchanged', title: 'Check delayed text', risk: 'Repeated verdict changes certainty', start: '/profile', steps: () => [verify('start delayed render', async ({ page }) => { if (changes) { await page.evaluate(() => { setTimeout(() => { const p = document.createElement('p'); p.textContent = 'Saved marker'; document.body.append(p); }, 700); }); } return true; }), check('The saved marker is visible')] };
            const result = await runSuite([test], { baseURL: app.origin, outputDir: join(root, 'check-dedup'), models: models.settings, retries: 0, log: () => undefined });
            expect(checks).toBe(changes ? 2 : 1);
            expect(result.results[0]?.status).toBe(changes ? 'passed' : 'failed');
        }
    });
    it('sends an unchanged uncertain first judgment to the helper', async () => {
        const models = scriptedModels(() => ({ holds: 0.45, support: 'supports' }), () => ({ verdict: 'true', reason: 'Trusted evidence supports it' }));
        const result = await runSuite([{ id: 'check-uncertain', title: 'Adjudicate uncertain check', risk: 'Repeated uncertainty', start: '/profile', steps: () => [check('The profile is visible')] }], { baseURL: app.origin, outputDir: join(root, 'check-dedup'), models: models.settings, retries: 0, log: () => undefined });
        expect(result.results[0]?.status, result.results[0]?.summary).toBe('passed');
        expect(result.totals.models.jevCalls).toBe(1);
        expect(result.totals.models.llmCalls).toBe(1);
    });
});

it('waits for deferred controls before accepting a no-action plan', async () => {
    const spec: TestSpec<void> = { id: 'deferred-controls', title: 'Open a deferred workspace', risk: 'Controls are declared absent before loading finishes', start: '/reach-loading', steps: () => [act('Wait for the workspace, then open it'), verify('workspace opened', ({ page }) => page.locator('#status').textContent().then(text => text === 'Workspace ready'))] };
    const result = await runSuite([spec], { baseURL: app.origin, outputDir: join(root, 'deferred'), retries: 0, models: scriptedModels(deferredPolicy).settings, log: () => undefined });
    expect(result.results[0]?.status, result.results[0]?.summary).toBe('passed');
});

describe('page values and complete intentions', () => {
    const tokenTest = (id: string, token: string): TestSpec<void> => ({
        id, title: 'Apply a live page value', risk: 'A stale token is entered', start: `/page-entry?token=${token}`,
        steps: () => [act('Enter the access token shown on the page and apply it'), verify('accepted', async ({ page }) => page.getByRole('status').textContent().then(text => text === 'Access accepted'))],
    });

    it('lets Jev enter a page value and re-reads it on replay', async () => {
        const id = 'live-page-token';
        const first = (await suite([tokenTest(id, 'AR-7285')], { mode: 'auto' }).run).results[0]!;
        expect(first.status, first.summary).toBe('passed');
        const path = join(root, 'recordings', `${id}.json`);
        const stored = JSON.parse(await readFile(path, 'utf8'));
        expect(stored.steps[0].actions[0].pageValue).toBeDefined();
        expect(stored.steps[0].actions[0].value).toBeUndefined();
        expect(JSON.stringify(stored.steps[0].actions)).not.toContain('AR-7285');
        expect(stored.steps[0].end.route).toContain('token=AR-7285');
        const replay = await suite([tokenTest(id, 'BX-9164')], { mode: 'replay' }).run;
        expect(replay.results[0]!.status).toBe('failed');
        expect(replay.results[0]!.summary).toContain('route');
        expect(replay.results[0]!.attempts[0]!.steps[0]!.actions![0]!.value).toMatch(/^page:/);
    });

    it('lets the helper enter an observed span after folding whitespace', async () => {
        const result = (await suite([tokenTest('helper-page-token', 'AR-7285')], {
            policy: view => view.text.includes('Access accepted') ? { done: 0.98 } : { tool: 'none' },
            helper: view => ({ outcome: 'act', tool: view.history.some(entry => entry.action === 'type') ? 'click' : 'type', element: view.elements.find(element => element.name === (view.history.some(entry => entry.action === 'type') ? 'Apply token' : 'Token'))!.i, value_key: null, text: ' \nAR-7285\t ', reason: 'Read the displayed token' }),
        }).run).results[0]!;
        expect(result.status, result.summary).toBe('passed');
        expect(result.attempts[0]!.steps[0]!.actions![0]!.value).toMatch(/^page:/);
    });

    it('requires grounding after page value context changes, and heals in auto mode', async () => {
        const spec = tokenTest('moved-page-token', 'AR-7285');
        expect((await suite([spec], { mode: 'auto' }).run).results[0]!.status).toBe('passed');
        const moved = { ...spec, start: '/page-entry?token=CY-1369&bug=relabeled' };
        const replay = (await suite([moved], { mode: 'replay' }).run).results[0]!;
        expect(replay.cause).toBe('agent');
        expect(replay.summary).toContain('Page value needs model grounding');
        expect(replay.attempts[0]!.steps[0]!.actions).toHaveLength(0);
        const healed = (await suite([moved], { mode: 'auto' }).run).results[0]!;
        expect(healed.status, healed.summary).toBe('passed');
        expect(healed.attempts[0]!.steps[0]!.source).toBe('healed');
    });

    it('explains a missing page source even when the target label also changed', async () => {
        const spec = tokenTest('missing-page-and-target', 'AR-7285');
        expect((await suite([spec], { mode: 'auto' }).run).results[0]!.status).toBe('passed');
        const path = join(root, 'recordings', `${spec.id}.json`);
        const stored = JSON.parse(await readFile(path, 'utf8'));
        stored.steps[0].actions[0].target.name = 'Missing {page value}';
        stored.steps[0].actions[0].pageValue.before = 'Missing source';
        await writeFile(path, JSON.stringify(stored));
        const result = (await suite([spec], { mode: 'replay' }).run).results[0]!;
        expect(result.cause).toBe('agent');
        expect(result.summary).toContain('Page value needs model grounding');
    });

    it.each(['invented-9231', 'ar-7285', 'hidden-3179'])('rejects helper text absent from the current observation: %s', async value => {
        const spec = tokenTest(`reject-page-${value.toLowerCase()}`, 'AR-7285');
        if (value === 'hidden-3179') { spec.secrets = { credential: secret(value) }; spec.start = `/page-entry?token=${value}`; }
        const result = (await suite([spec], {
            policy: () => ({ tool: 'none' }),
            helper: view => ({ outcome: 'act', tool: 'type', element: view.elements.find(element => element.name === 'Token')!.i, value_key: null, text: value, reason: 'Propose a text value' }),
        }).run).results[0]!;
        expect(result.cause).toBe('agent');
        expect(result.attempts[0]!.steps[0]!.actions).toHaveLength(0);
        expect(result.summary).toMatch(/not in the step or current page/);
    });

    it.each([0.2, 0.5])('keeps an explicit next-step boundary when remaining work is %s', async (remaining) => {
        const spec: TestSpec<void> = {
            id: 'explicit-next-boundary', title: 'Open, then confirm', risk: 'The first step performs the next step', start: '/items', fixture: async () => { app.reset(); },
            steps: () => [act('Start archiving the Beta plan'), act('Confirm archiving in the dialog', { expect: { write: { path: /\/api\/items\/\w+\/archive/ } } }), verify('archived', () => app.state.items.find(item => item.id === 'b')?.archived === true)],
        };
        const result = (await suite([spec], { mode: 'ai', policy: view => view.step?.startsWith('Start archiving') && view.dialog ? { done: 0.85, remaining, complete: remaining === 0.5 ? 0.9 : 0.26 } : fixturePolicy(view) }).run).results[0]!;
        expect(result.status, result.summary).toBe('passed');
        expect(result.attempts[0]!.steps[0]!.actions).toHaveLength(1);
    });

    it('lets a declared single submission reach code checks despite a conflicting model outcome', async () => {
        const spec = { ...profileTest('/profile?bug=nosave'), id: 'declared-submit-evidence' };
        const result = (await suite([spec], { mode: 'ai', policy: view => view.step === 'Save the profile' ? { ...fixturePolicy(view), remaining: 0.95 } : fixturePolicy(view) }).run).results[0]!;
        expect(result.cause).toBe('product');
        expect(result.attempts[0]!.steps[1]!.status).toBe('passed');
        expect(result.attempts[0]!.steps[3]!.failure).toBe('assertion');
    });

    it('finishes every clause even when done is confident after the first action', async () => {
        const spec: TestSpec<void> = { id: 'complete-clauses', title: 'Save and open', risk: 'The list is not opened', start: '/collection', steps: () => [act('Save the essay, then open the reading list'), verify('list opened', async ({ page }) => page.getByRole('heading', { name: 'Reading list', exact: true }).count().then(count => count === 2))] };
        const result = (await suite([spec]).run).results[0]!;
        expect(result.status, result.summary).toBe('passed');
        expect(result.attempts[0]!.steps[0]!.actions).toHaveLength(2);
    });

    it.each(['Save the essay, then open the reading list', 'Save the essay and open the reading list', 'Save the essay; open the reading list', 'Save the essay, open the reading list', '收藏文章，然后打开阅读列表'].map((instruction, index) => ({ instruction, index })))('does not let the first declared write end a compound instruction: $instruction', async ({ instruction, index }) => {
        const spec: TestSpec<void> = {
            id: `compound-submit-evidence-${index}`, title: 'Save and open', risk: 'A successful request hides a missing action', start: '/collection',
            steps: () => [act(instruction, { expect: { write: { path: '/api/profile' } } }), verify('list opened', async ({ page }) => (await page.getByRole('heading', { name: 'Reading list', exact: true }).count()) === 2)],
        };
        const result = (await suite([spec], { policy: view => fixturePolicy({ ...view, step: 'Save the essay, then open the reading list' }) }).run).results[0]!;
        expect(result.status, result.summary).toBe('passed');
        expect(result.attempts[0]!.steps[0]!.actions).toHaveLength(2);
    });

    it('grounds mixed public and secret values against the selected field', async () => {
        const spec: TestSpec<void> = {
            id: 'mixed-credentials', title: 'Enter an account', risk: 'A secret is entered in the public member field', start: '/credential-form',
            data: { account: 'marble@example.test' }, secrets: { password: secret('Private-Key-7312') },
            steps: () => [act('Sign in using account {account} with password {password}'), verify('account opened', async ({ page }) => page.getByRole('heading', { name: 'Signed in as marble@example.test', exact: true }).isVisible())],
        };
        const result = (await suite([spec]).run).results[0]!;
        expect(result.status, result.summary).toBe('passed');
        expect(result.attempts[0]!.steps[0]!.actions![0]!.value).toBe('account');
    });

    it.each([{ name: 'transaction', start: '/effects?single=1&confirm=1', step: 'Finalize the choice of the entry dated 2026-01-01', target: 'Confirm choice', result: 'Alpha chosen and confirmed' }, { name: 'destination', start: '/collection', step: 'Save the essay, then open the reading list', target: 'Reading list (1)', result: 'Reading list' }].flatMap(test => ['none', 'click'].map(tool => ({ ...test, tool }))))('reviews the selected control when all completion judgments agree incorrectly: $name / $tool', async ({ name, start, step, target, result: heading, tool }) => {
        const spec: TestSpec<void> = { id: `specific-control-${name}-${tool}`, title: 'Finish the whole step', risk: 'Global completion hides an unactivated control', start, steps: () => [act(step), verify('final action performed', async ({ page }) => name === 'transaction' ? page.getByRole('heading', { name: heading, exact: true }).isVisible() : (await page.getByRole('heading', { name: heading, exact: true }).count()) === 2)] };
        const result = (await suite([spec], { policy: view => {
            if (view.control) { return { needed: view.text || view.history.some(entry => entry.element?.includes(target)) ? 0.02 : 0.99 }; }
            const ready = view.text.includes('Alpha chosen') || view.elements.some(element => element.name === 'Saved');
            if (ready) { return { done: 0.99, achieved: 0.99, remaining: 0.02, tool, target: element => element.name === target }; }
            return { tool: 'click', target: element => element.name === (name === 'transaction' ? 'Choose' : 'Save essay') };
        } }).run).results[0]!;
        expect(result.status, result.summary).toBe('passed');
        expect(result.attempts[0]!.steps[0]!.actions).toHaveLength(2);
    });

    it('keeps a completed action when a stage review is only uncertain', async () => {
        const spec = { ...profileTest(), steps: () => [act('Change Nickname to {nickname} and Bio to {bio}'), act('Save the profile'), verify('saved', () => app.state.requests.some(request => request.path === '/api/profile'))] };
        const result = (await suite([spec], { policy: view => view.review && view.notices.includes('Profile saved') ? { done: 0.88, achieved: 0.42, remaining: 0.35 } : fixturePolicy(view) }).run).results[0]!;
        expect(result.status, result.summary).toBe('passed');
        expect(result.attempts[0]!.steps[1]!.actions).toHaveLength(1);
    });

    it('lets a content check evaluate an empty destination after all requested actions', async () => {
        const spec: TestSpec<void> = { id: 'opened-empty-view', title: 'Save then inspect', risk: 'Empty destination content is hidden by an agent failure', start: '/collection?bug=empty', steps: () => [act('Save the essay, then open the reading list'), check('The reading list view displays the saved essay', { reference: () => ({ savedEssay: 'An essay' }) })] };
        const result = (await suite([spec], { policy: view => view.step && !view.text.includes('Catalog') ? { done: 0.15, achieved: 0.84, remaining: 0.53, navigation: 0.25 } : fixturePolicy(view) }).run).results[0]!;
        expect(result.cause, result.summary).toBe('product');
        expect(result.attempts[0]!.steps[0]!.actions).toHaveLength(2);
    });

    it('asks the helper to resolve an uncertain control activation before accepting done', async () => {
        const spec: TestSpec<void> = { id: 'uncertain-control', title: 'Finalize a choice', risk: 'An uncertain activation is mistaken for completion', start: '/effects?single=1&confirm=1', steps: () => [act('Finalize the choice of the entry dated 2026-01-01'), verify('confirmed', async ({ page }) => page.getByRole('heading', { name: 'Alpha chosen and confirmed', exact: true }).isVisible())] };
        const result = (await suite([spec], { policy: view => {
            if (view.control) { return { needed: 0.32 }; }
            if (view.text.includes('Alpha chosen and confirmed')) { return { done: 0.99, achieved: 0.99 }; }
            if (view.text.includes('Alpha chosen')) { return { done: 0.93, achieved: 0.64, remaining: 0.45, tool: 'none', target: element => element.name === 'Confirm choice' }; }
            return { tool: 'click', target: element => element.name === 'Choose' };
        }, helper: view => view.control ? { activation: 'activate', reason: 'The final confirmation is absent from the history' } : { outcome: 'impossible', tool: null, element: null, value_key: null, text: null, reason: 'Unexpected helper request' } }).run).results[0]!;
        expect(result.status, result.summary).toBe('passed');
        expect(result.attempts[0]!.steps[0]!.actions).toHaveLength(2);
    });

    it('requires destination activation even when summary-based completion judgments agree', async () => {
        const spec: TestSpec<void> = { id: 'destination-activation', title: 'Save then inspect', risk: 'A global heading masks unopened destination content', start: '/collection', steps: () => [act('Save the essay, then open the reading list'), verify('list opened', async ({ page }) => (await page.getByRole('heading', { name: 'Reading list', exact: true }).count()) === 2)] };
        const result = (await suite([spec], {
            policy: view => view.text.includes('Catalog') && view.elements.some(element => element.name === 'Saved') ? { done: 0.99, achieved: 0.99, remaining: 0.02, navigation: 0.99 } : fixturePolicy(view),
            helper: view => ({ outcome: 'act', tool: 'click', element: view.elements.find(element => element.role === 'tab')!.i, value_key: null, text: null, reason: 'The destination has not been activated' }),
        }).run).results[0]!;
        expect(result.status, result.summary).toBe('passed');
        expect(result.attempts[0]!.steps[0]!.actions).toHaveLength(2);
    });

    it('rejects a stage-review action on an unrelated navigation link', async () => {
        const spec: TestSpec<void> = {
            id: 'unrelated-stage-action', title: 'Commit a choice', risk: 'An unrelated route is mistaken for the requested final action', start: '/effects?single=1&confirm=1',
            steps: () => [act('Finalize the choice of the entry dated 2026-01-01'), verify('confirmed', async ({ page }) => page.getByRole('heading', { name: 'Alpha chosen and confirmed', exact: true }).isVisible())],
        };
        const result = (await suite([spec], { policy: view => {
            if (view.proposal?.element === 'link "Profile"' || view.history.some(entry => entry.element === 'link "Profile"')) { return { done: 0.99, achieved: 0.99, onTarget: 0.02 }; }
            if (view.text.includes('Alpha chosen')) { return view.review ? { achieved: 0.02, tool: 'click', target: element => element.role === 'link' && element.name === 'Profile' } : { done: 0.98, remaining: 0.98 }; }
            return { tool: 'click', target: element => element.name === 'Choose' };
        } }).run).results[0]!;
        expect(result.cause, result.summary).toBe('agent');
        expect(result.attempts[0]!.steps[0]!.actions?.some(action => action.element === 'link "Profile"')).toBe(false);
    });

    it('distinguishes a prepared value from the committed result even when both done judgments agree', async () => {
        const spec: TestSpec<void> = {
            id: 'prepare-then-commit', title: 'Finalize a choice', risk: 'Selecting a value is mistaken for committing it', start: '/effects?single=1&confirm=1',
            steps: () => [act('Finalize the choice of the entry dated 2026-01-01'), verify('confirmed', async ({ page }) => page.getByRole('heading', { name: 'Alpha chosen and confirmed', exact: true }).isVisible())],
        };
        const result = (await suite([spec], {
            helper: view => ({ outcome: 'act', tool: 'click', element: view.elements.find(element => element.name === 'Confirm choice')!.i, value_key: null, text: null, reason: 'The value was prepared, but final confirmation is still needed' }),
        }).run).results[0]!;
        expect(result.status, result.summary).toBe('passed');
        expect(result.attempts[0]!.steps[0]!.actions).toHaveLength(2);
    });

    it('attributes a validation error caused by premature submission to the agent', async () => {
        const spec: TestSpec<void> = { id: 'premature-submit', title: 'Delivery', risk: 'Incomplete form', start: '/required-form', steps: () => [act('Set the destination and confirm delivery')] };
        const result = (await suite([spec]).run).results[0]!;
        expect(result.cause).toBe('agent');
        expect(result.attempts[0]!.steps[0]!.failure).toBe('error-shown');
    });

    it('retains monitored product evidence when an action also shows a validation error', async () => {
        const spec: TestSpec<void> = { id: 'submit-crash', title: 'Delivery crash', risk: 'App crashes', start: '/required-form?bug=crash', steps: () => [act('Set the destination and confirm delivery')] };
        const result = (await suite([spec]).run).results[0]!;
        expect(result.cause).toBe('product');
        expect(result.summary).toMatch(/Delivery crashed/);
    });

    it('rejects a high holds score when the asserted content is not shown', async () => {
        const spec: TestSpec<void> = { id: 'direct-content-check', title: 'Read the list', risk: 'Summary masks missing content', start: '/collection', steps: () => [run('save without opening', async ({ page }) => { await page.getByRole('button', { name: 'Save essay' }).click(); }), check('The reading list displays the saved essay')] };
        const result = (await suite([spec], { policy: () => ({ holds: 0.98, support: 'not_shown' }), helper: () => ({ verdict: 'not_shown', reason: 'The requested view is absent' }) }).run).results[0]!;
        expect(result.status).toBe('failed');
        expect(result.cause).toBe('agent');
        expect(result.attempts[0]!.steps[1]!.evidence).toMatchObject({ verdicts: [{ passed: false, support: 'not_shown', uncertain: true }, { adjudicated: { passed: false, support: 'not_shown' } }] });
    });
});


describe('page value sources', () => {
    const observation = (text = '') => ({ url: '/', title: '', text, notices: [], headings: [], elements: [], omitted: 0, signature: '' });

    it('compares exact spans after folding whitespace without folding case', () => {
        const page = observation('Pickup phrase: Red   River; use it.');
        const source = describePageValue(page, 'Red\nRiver')!;
        expect(source).toBeDefined();
        expect(readPageValue(observation('Pickup phrase: Blue Lake; use it.'), source)).toBe('Blue Lake');
        expect(describePageValue(page, 'red river')).toBeUndefined();
        expect(describePageValue(page, 'invented phrase')).toBeUndefined();
    });

    it('accepts notice and element content values without joining unrelated sources', () => {
        const page = { ...observation(), notices: ['Reference: AC-37; continue.'], elements: [{ i: 0, role: 'button', name: 'Label', content: 'Pickup: Red River; ready.' }] };
        expect(describePageValue(page, 'AC-37')!.source).toBe('notice');
        expect(describePageValue(page, 'Red River')!.source).toBe('content');
        expect(describePageValue(page, 'continue. Label')).toBeUndefined();
    });

    it('allows an observed value with ambiguous context but requires a model on replay', () => {
        const page = { ...observation(), elements: [{ i: 0, role: 'button', name: 'Alpha' }, { i: 1, role: 'button', name: 'Beta' }] };
        const source = describePageValue(page, 'Alpha')!;
        expect(source.requiresModel).toBe(true);
        expect(readPageValue(page, source)).toBeUndefined();
    });

    it('cannot read values from inside a redaction marker', () => {
        const redact = createRedactor([secret('Hidden-Key-7301')]);
        expect(describePageValue(observation('Reference: Hidden-Key-7301; use it.'), 'secret', redact)).toBeUndefined();
        expect(readPageValue(observation('{secret}'), { source: 'text', before: '{', after: '}' })).toBeUndefined();
        expect(describePageValue(observation('{secret}'), '{', createRedactor([secret('secret')]))).toBeUndefined();
    });

    it('never offers normalized secret originals or redacted markers as page values', () => {
        const redact = createRedactor([secret('Secret\tRiver')]);
        const page = observation('Phrase: Secret River; ready.');
        expect(describePageValue(page, 'Secret River', redact)).toBeUndefined();
        expect(pageValueChoices(page, redact)).not.toContain('Secret River');
        expect(describePageValue(observation('{secret}'), '{secret}', redact)).toBeUndefined();
    });
});


describe('integration secret purposes', () => {
    it('rejects a default password secret in a public field even when both models choose it', async () => {
        const spec: TestSpec<void> = { id: 'password-in-public-field', title: 'Credential guard', risk: 'A password reaches the public field', start: '/integration-secrets', secrets: { password: secret('Protected-5921') }, steps: () => [act('Enter {password} in Email', { maxActions: 2 })] };
        const result = (await suite([spec], { mode: 'ai', policy: () => ({ tool: 'type', target: element => element.name === 'Email', value: 'password' }), helper: view => ({ outcome: 'act', tool: 'type', element: view.elements.find(element => element.name === 'Email')!.i, value_key: 'password', text: null, reason: 'Use the secret in Email' }) }).run).results[0]!;
        expect(result.cause, result.summary).toBe('agent');
        expect(result.attempts[0]!.steps[0]!.actions?.some(action => action.ok && action.tool === 'type')).toBe(false);
        expect(result.attempts[0]!.steps[0]!.actions?.[0]?.error).toMatch(/password.*purpose|purpose.*password/i);
    });
    it('does not offer a password secret to the value model for an unrelated field', async () => {
        const spec: TestSpec<void> = { id: 'purpose-value-options', title: 'Credential matching', risk: 'The model can select a password for Email', start: '/integration-secrets', data: { email: 'person@example.test' }, secrets: { password: secret('Protected-5921') }, steps: () => [act('Enter email {email} and password {password}', { maxActions: 1 })] };
        const test = suite([spec], { mode: 'ai', policy: view => ({ tool: 'type', target: element => element.name === 'Email', value: view.field ? 'email' : 'password' }) });
        await test.run;
        const selected = test.calls.find(call => call.view.field?.includes('Email'))!;
        expect(selected.view.values).toEqual({ email: 'person@example.test' });
    });
    it.each(['Password', 'API key'])('allows the declared purpose in %s', async name => {
        const spec: TestSpec<void> = { id: `purpose-${name.toLowerCase().replaceAll(' ', '-')}`, title: 'Valid secret purpose', risk: 'An authorized credential is blocked', start: '/integration-secrets', secrets: { credential: secret('Protected-5921', { purpose: name === 'API key' ? 'any' : 'password' }) }, steps: () => [act('Enter {credential} in ' + name), verify('entered', async ({ page }) => name === 'API key' ? (await page.getByRole('textbox', { name, exact: true }).textContent()) === 'Protected-5921' : (await page.getByRole('textbox', { name, exact: true }).inputValue()) === 'Protected-5921')] };
        const result = (await suite([spec], { mode: 'ai', policy: view => view.history.some(entry => entry.action === 'type' && !entry.error) ? { done: 0.99 } : { tool: 'type', target: element => element.name === name, value: 'credential' } }).run).results[0]!;
        expect(result.status, result.summary).toBe('passed');
    });
});


it('integration preserves the explicit next-step boundary at observed confidence 0.64', async () => {
    const spec: TestSpec<void> = { id: 'borderline-next-stage', title: 'Prepare and confirm separately', risk: 'A prepared dialog is rejected before the defect check', start: '/items?bug=wrong-row', fixture: async () => { app.reset(); }, invariants: [{ name: 'Other entries stay active', check: () => app.state.items.filter(item => item.id !== 'b').every(item => !item.archived) }], steps: () => [act('Start archiving the Beta plan'), act('Confirm archiving in the dialog', { expect: { write: { path: /\/archive$/ } } })] };
    const result = (await suite([spec], { mode: 'ai', policy: view => view.step === 'Start archiving the Beta plan' && view.dialog ? { done: 0.65, remaining: 0.51, achieved: 0.64, navigation: 0.03, tool: 'none' } : fixturePolicy(view), helper: view => view.control ? { reason: 'The required dialog is already open; the next step reserves confirmation', activation: 'finished' } : { outcome: 'step_already_done', tool: null, element: null, value_key: null, text: null, reason: 'The current action opened the confirmation dialog; confirmation is the next step' } }).run).results[0]!;
    expect(result.cause, result.summary).toBe('product');
    expect(result.attempts[0]!.steps[0]!.status).toBe('passed');
    expect(result.attempts[0]!.steps[1]!.failure).toBe('invariant');
});


it('integration reaches direct content checks after button-based navigation to an empty destination', async () => {
    const spec: TestSpec<void> = { id: 'button-destination-empty', title: 'Save and inspect a destination', risk: 'Empty content is hidden by an agent failure', start: '/collection?bug=empty&buttons=1', steps: () => [act('Save the essay, then open the reading list'), check('The reading list view displays the saved essay')] };
    const result = (await suite([spec], { mode: 'ai', policy: view => {
        if (view.claim) { return { holds: 0.03, support: 'contradicts' }; }
        if (!view.text.includes('Catalog')) { return { done: 0.15, achieved: 0.84, remaining: 0.53, navigation: 0.25, tool: 'none' }; }
        return view.elements.some(element => element.name === 'Saved') ? { done: 0.76, remaining: 0.8, navigation: 0.57, tool: 'click', target: element => element.name === 'Reading list (1)' } : { tool: 'click', target: element => element.name === 'Save essay' };
    } }).run).results[0]!;
    expect(result.cause, result.summary).toBe('product');
    expect(result.attempts[0]!.steps[0]!.status).toBe('passed');
    expect(result.attempts[0]!.steps[0]!.actions).toHaveLength(2);
    expect(result.attempts[0]!.steps[1]!.failure).toBe('assertion');
});


it('reviews a submitted form with the same code-observed transition as the action decision', async () => {
    const spec: TestSpec<void> = { id: 'submitted-form-transition', title: 'Sign in and leave the form', risk: 'Disappearing inputs obscure a completed submission', start: '/credential-form', data: { account: 'marble@example.test' }, secrets: { password: secret('Private-Key-7312') }, steps: () => [act('Sign in using account {account} with password {password}'), verify('account opened', async ({ page }) => page.getByRole('heading', { name: 'Signed in as marble@example.test', exact: true }).isVisible())] };
    const result = (await suite([spec], { mode: 'ai', policy: view => {
        if (!view.text.includes('Signed in as')) { return fixturePolicy(view); }
        const changed = String(view.change?.new_text ?? '').includes('Signed') && (view.change?.removed as string[] | undefined)?.some(element => element.includes('Password'));
        return { done: 0.53, remaining: 0.75, achieved: changed ? 0.99 : 0.37, navigation: 0.03, tool: 'none' };
    }, helper: () => ({ outcome: 'step_already_done', tool: null, element: null, value_key: null, text: null, reason: 'The form was submitted and replaced by the account view' }) }).run).results[0]!;
    expect(result.status, result.summary).toBe('passed');
    expect(result.attempts[0]!.steps[0]!.actions?.map(action => action.tool)).toEqual(['type', 'type', 'click']);
});


it('retains successful supplied-value evidence after submission removes credential fields', async () => {
    const spec: TestSpec<void> = { id: 'submitted-secret-evidence', title: 'Submit supplied credentials', risk: 'Masked input evidence is lost when fields disappear', start: '/credential-form', data: { account: 'marble@example.test' }, secrets: { password: secret('Private-Key-7312') }, steps: () => [act('Sign in using account {account} with password {password}'), verify('account opened', async ({ page }) => page.getByRole('heading', { name: 'Signed in as marble@example.test', exact: true }).isVisible())] };
    const result = (await suite([spec], { mode: 'ai', policy: view => {
        if (!view.text.includes('Signed in as')) { return fixturePolicy(view); }
        const supplied = view.supplied.account?.includes('Account email') && view.supplied.password?.includes('Password');
        return { done: 0.52, remaining: 0.72, achieved: supplied ? 0.99 : 0.46, navigation: 0.05, tool: 'none' };
    }, helper: () => ({ outcome: 'step_already_done', tool: null, element: null, value_key: null, text: null, reason: 'Input and submission are finished' }) }).run).results[0]!;
    expect(result.status, result.summary).toBe('passed');
    expect(result.attempts[0]!.steps[0]!.actions?.map(action => action.tool)).toEqual(['type', 'type', 'click']);
});


it('uses stable control identity when its nearby count changes between required activations', async () => {
    const spec: TestSpec<void> = { id: 'changing-count-control', title: 'Increase a batch count', risk: 'A changing nearby count makes a completed increment look unperformed', start: '/integration-counter?bug=total', steps: () => [act('Increase the first batch count by two'), verify('total reflects the new count', async ({ page }) => (await page.locator('output').textContent()) === '21')] };
    const result = (await suite([spec], { mode: 'ai', policy: view => {
        const clicks = view.history.filter(entry => entry.action === 'click' && !entry.error).length;
        if (view.control) { return { needed: 0.31 }; }
        return clicks < 2 ? { done: 0.03, remaining: 0.99, tool: 'click', target: element => element.name === '+' } : { done: 0.67, remaining: 0.11, achieved: 0.93, navigation: 0, tool: 'none', target: element => element.name === '+' };
    }, helper: view => view.control ? { activation: view.controlActivations.length === 2 ? 'finished' : 'activate', reason: 'The control must have two successful activations, even when the nearby count changes' } : { outcome: 'step_already_done', tool: null, element: null, value_key: null, text: null, reason: 'Both increments were performed' } }).run).results[0]!;
    expect(result.cause, result.summary).toBe('product');
    expect(result.attempts[0]!.steps[0]!.actions?.filter(action => action.ok)).toHaveLength(2);
    expect(result.attempts[0]!.steps[1]!.failure).toBe('assertion');
});


describe('hardening instruction and evidence boundaries', () => {
    it('describes page key input that can advance across segmented fields', async () => {
        const spec: TestSpec<void> = { id: 'segmented-input-history', title: 'Enter a sequence across fields', risk: 'The starting field is mistaken for the entire input destination', start: '/attribution-segments', steps: () => [act('Enter the six-digit access sequence displayed on the page across the segmented inputs and verify access'), verify('access granted', async ({ page }) => (await page.locator('output').textContent()) === 'Access granted')] };
        const result = (await suite([spec], { mode: 'ai', policy: view => view.text.includes('Access granted') ? view.history.some(entry => entry.input_method?.includes('focus')) ? { done: 0.98 } : { done: 0.59, achieved: 0.35, remaining: 0.74, tool: 'none' } : fixturePolicy(view), helper: () => ({ outcome: 'step_already_done', tool: null, element: null, value_key: null, text: null, reason: 'The input was completed' }) }).run).results[0]!;
        expect(result.status, result.summary).toBe('passed');
    });
    it('reviews a completed activation before repeating it to fix product content', async () => {
        const spec: TestSpec<void> = { id: 'completed-removal-action', title: 'Remove an entry once', risk: 'Repeating a completed action hides a retained record', start: '/attribution-retained-entry', steps: () => [act('Remove the Retired entry'), check('The removed entry is absent from the directory')] };
        const result = (await suite([spec], { mode: 'ai', policy: view => view.claim ? { holds: 0.02, support: 'contradicts', region: 'open' } : fixturePolicy(view), helper: () => ({ outcome: 'step_already_done', tool: null, element: null, value_key: null, text: null, reason: 'The Remove activation was performed' }) }).run).results[0]!;
        expect(result.cause, result.summary).toBe('product');
        expect(result.attempts[0]!.steps[0]!.actions).toHaveLength(1);
    });
    it('rechecks loading content before attributing an absent record to the product', async () => {
        const spec: TestSpec<void> = { id: 'resolved-region', title: 'Load delivery records', risk: 'A transient missing record is called a defect', start: '/attribution-regions?region=loading&resolve=1', steps: () => [check('The delivery records show Record ZX-71')] };
        const result = (await suite([spec], { mode: 'ai', policy: view => ({ holds: view.text.includes('Record ZX-71') ? 0.98 : 0.02, support: view.text.includes('Record ZX-71') ? 'supports' : 'not_shown', region: 'open' }) }).run).results[0]!;
        expect(result.status, result.summary).toBe('passed');
        expect(result.attempts[0]!.steps[0]!.evidence).toMatchObject({ verdicts: expect.arrayContaining([expect.objectContaining({ passed: false }), expect.objectContaining({ passed: true })]) });
    });
    it.each(['closed', 'unknown'])('keeps uncertain location evidence away from product attribution (%s)', async region => {
        const spec: TestSpec<void> = { id: 'uncertain-region-' + region, title: 'Locate delivery records', risk: 'A guessed region becomes product evidence', start: '/attribution-regions?region=unselected', steps: () => [check('The delivery records show Record ZX-71')] };
        const result = (await suite([spec], { mode: 'ai', policy: () => ({ holds: 0.02, support: 'not_shown', region: 'unknown' }), helper: () => ({ verdict: 'not_shown', region, reason: 'The content location is not established' }) }).run).results[0]!;
        expect(result.cause, result.summary).toBe('agent');
    });
    it.each(['loading', 'empty', 'collapsed', 'unselected'])('attributes absent content from its relevant region (%s)', async region => {
        const open = region === 'loading' || region === 'empty';
        const spec: TestSpec<void> = { id: 'region-' + region, title: 'Inspect delivery records', risk: 'Absent content is charged to the wrong actor', start: '/attribution-regions?region=' + region, steps: () => [check('The delivery records show Record ZX-71')] };
        const result = (await suite([spec], { mode: 'ai', policy: () => ({ holds: 0.02, support: 'not_shown', region: open ? 'open' : 'closed' }), helper: () => ({ verdict: 'not_shown', region: open ? 'open' : 'closed', reason: 'The requested record is absent' }) }).run).results[0]!;
        expect(result.cause, result.summary).toBe(open ? 'product' : 'agent');
        expect(result.attempts[0]!.steps[0]!.evidence).toMatchObject({ verdicts: expect.arrayContaining([expect.objectContaining({ region: open ? 'open' : 'closed' })]) });
        if (!open) { expect(result.summary).toMatch(/relevant region is not open/i); }
    });
    it('grounds a requested page sequence before spending helpers on individual segments', async () => {
        const spec: TestSpec<void> = { id: 'segmented-page-sequence', title: 'Enter an observed sequence', risk: 'Per-character helper calls exhaust the step budget', start: '/attribution-segments', steps: () => [act('Enter the six-digit access sequence displayed on the page across the segmented inputs and verify access'), verify('challenge accepted', async ({ page }) => (await page.locator('output').textContent()) === 'Access granted')] };
        const test = suite([spec], { mode: 'ai', helper: view => ({ outcome: 'act', tool: 'type', element: view.elements.find(element => element.name === 'Segment ' + (view.history.filter(entry => entry.action === 'type').length + 1))!.i, text: '681942'[view.history.filter(entry => entry.action === 'type').length], value_key: null, reason: 'Enter the next displayed character' }) });
        const result = (await test.run).results[0]!;
        expect(result.status, result.summary).toBe('passed');
        expect(result.models.llmCalls).toBe(0);
        expect(result.attempts[0]!.steps[0]!.actions).toHaveLength(1);
    });
    it('lets completed selection reach an independent check of the broken result', async () => {
        const spec: TestSpec<void> = { id: 'sorted-amounts', title: 'Order amounts', risk: 'The action stage hides a product defect', start: '/attribution-sort', steps: () => [act('Sort the entries by amount ascending'), check('The entry amounts are ascending')] };
        const result = (await suite([spec], { mode: 'ai', policy: view => view.claim ? { holds: 0.02, support: 'contradicts', region: 'open' } : fixturePolicy(view), helper: () => ({ outcome: 'step_already_done', tool: null, element: null, value_key: null, text: null, reason: 'The requested selection was made' }) }).run).results[0]!;
        expect(result.cause, result.summary).toBe('product');
        expect(result.attempts[0]!.steps[0]!.actions?.map(action => action.tool)).toEqual(['select']);
        expect(result.attempts[0]!.steps[1]!.failure).toBe('assertion');
    });
    it('binds a removed-item claim to the actual earlier action rather than a toast', async () => {
        const spec: TestSpec<void> = { id: 'retained-entry', title: 'Remove a directory entry', risk: 'A confirmation hides a retained record', start: '/attribution-retained-entry', steps: () => [act('Remove the Retired entry'), check('The removed entry is absent from the directory')] };
        const result = (await suite([spec], { mode: 'ai', policy: view => view.claim ? view.priorActions.some(step => step.history.some(action => action.element?.includes('Retired entry'))) ? { holds: 0.02, support: 'contradicts', region: 'open' } : { holds: 0.3, support: 'not_shown', region: 'unknown' } : view.history.some(entry => entry.action === 'click') ? { done: 0.98 } : { tool: 'click', target: element => element.name === 'Remove' }, helper: () => ({ verdict: 'true', reason: 'Removal requested proves the record is absent' }) }).run).results[0]!;
        expect(result.cause, result.summary).toBe('product');
    });
    it.each(['jev', 'helper'])('separates actual page input from its human provenance label (%s)', async (source) => {
        const spec: TestSpec<void> = { id: 'page-history-' + source, title: 'Enter observed token', risk: 'A provenance prefix is mistaken for actual field input', start: '/hardening-page-history?token=HS-4127', steps: () => [act('Read the token from the page and enter it in Code'), verify('exact token', async ({ page }) => (await page.getByRole('textbox', { name: 'Code', exact: true }).inputValue()) === 'HS-4127')] };
        const test = suite([spec], { mode: 'ai', policy: view => {
            // Reproduce a real helper mistaking the log prefix for malformed input despite a correct field value.
            if (view.history.some(entry => entry.value?.startsWith('page: '))) { return { tool: 'type', inputSource: 'step', target: element => element.name === 'Code' }; }
            if (view.history.some(entry => entry.action === 'type')) { return { done: 0.98 }; }
            return { tool: 'type', target: element => element.name === 'Code', ...(source === 'jev' ? { pageValue: 'HS-4127' } : { inputSource: 'step' as const }) };
        }, helper: view => ({ outcome: 'act', tool: 'type', element: view.elements.find(element => element.name === 'Code')!.i, text: 'HS-4127', value_key: null, reason: 'Enter the exact observed token' }) });
        const result = (await test.run).results[0]!;
        expect(result.status, result.summary).toBe('passed');
        expect(result.attempts[0]!.steps[0]!.actions?.map(action => action.tool)).toEqual(['type']);
        expect(result.attempts[0]!.steps[0]!.actions?.[0]?.value).toBe('page: "HS-4127"');
        expect(test.calls.some(call => call.view.history.some(entry => entry.value === 'HS-4127' && entry.input_source === 'page'))).toBe(true);
    });
    it('authorizes the final control needed for a requested committed result', async () => {
        const spec: TestSpec<void> = { id: 'public-deployment', title: 'Enable deployment', risk: 'A selected value is mistaken for a committed result', start: '/hardening-commit', steps: () => [act('Enable the public deployment'), verify('deployment public', async ({ page }) => (await page.locator('#result').textContent()) === 'Deployment public')] };
        const result = (await suite([spec], { mode: 'ai' }).run).results[0]!;
        expect(result.status, result.summary).toBe('passed');
        expect(result.attempts[0]!.steps[0]!.actions?.map(action => action.tool)).toEqual(['select', 'click']);
    });
    it('grounds an instruction literal immediately instead of repeatedly focusing its field', async () => {
        const spec: TestSpec<void> = { id: 'instruction-literal', title: 'Enter contact address', risk: 'A missing data key converts typing to repeated focus', start: '/hardening-literal', steps: () => [act('Enter fern@example.test in Contact address'), verify('contact entered', async ({ page }) => (await page.locator('#contact').inputValue()) === 'fern@example.test')] };
        const result = (await suite([spec], { mode: 'ai', policy: view => view.history.some(entry => entry.action === 'type') ? { done: 0.98 } : { tool: 'type', target: element => element.name === 'Contact address', inputSource: 'step' }, helper: view => ({ outcome: 'act', tool: 'type', element: view.elements.find(element => element.name === 'Contact address')!.i, text: 'fern@example.test', value_key: null, reason: 'The instruction supplies this exact literal' }) }).run).results[0]!;
        expect(result.status, result.summary).toBe('passed');
        expect(result.attempts[0]!.steps[0]!.actions?.map(action => action.tool)).toEqual(['type']);
    });
    it('does not finish while requested submission and target reviews remain uncertain', async () => {
        const spec: TestSpec<void> = { id: 'uncertain-required-submit', title: 'Submit a prepared form', risk: 'Conflicting reviews accept preparation as submission', start: '/credential-form', data: { account: 'marble@example.test' }, secrets: { password: secret('Private-Key-7312') }, steps: () => [act('Sign in using account {account} with password {password}'), verify('account opened', async ({ page }) => page.getByRole('heading', { name: 'Signed in as marble@example.test', exact: true }).isVisible())] };
        const result = (await suite([spec], { mode: 'ai', policy: view => {
            if (view.control) { return { needed: 0.68 }; }
            if (view.field) { return fixturePolicy(view); }
            if (!view.elements.length) { return { onTarget: 0.68 }; }
            if (view.history.some(entry => entry.action === 'click') || view.history.filter(entry => entry.action === 'type').length < 2) { return fixturePolicy(view); }
            return { done: 0.69, achieved: 0.7, remaining: 0.68, navigation: 0.03, tool: 'click', target: element => element.name === 'Sign in', onTarget: 0.68 };
        } }).run).results[0]!;
        expect(result.status, result.summary).toBe('passed');
        expect(result.attempts[0]!.steps[0]!.actions?.map(action => action.tool)).toEqual(['type', 'type', 'click']);
    });
    it('selects shipping without placing an unrequested order', async () => {
        const spec: TestSpec<void> = { id: 'shipping-selection', title: 'Select shipping', risk: 'Selection causes an unwanted purchase', start: '/hardening-shipping', steps: () => [act('Select Express shipping'), verify('selection only', async ({ page }) => (await page.locator('#shipping').inputValue()) === 'Express' && (await page.locator('#orders').textContent()) === '0')] };
        const result = (await suite([spec], { mode: 'ai' }).run).results[0]!;
        expect(result.status, result.summary).toBe('passed');
        expect(result.attempts[0]!.steps[0]!.actions?.map(action => action.tool)).toEqual(['select']);
    });
    it('adjudicates missing evidence instead of charging it to the product', async () => {
        const spec: TestSpec<void> = { id: 'uncertain-cart-evidence', title: 'Cart evidence', risk: 'A toast is treated as a product defect', start: '/hardening-cart', steps: () => [check('the item was added to the cart')] };
        const test = suite([spec], { mode: 'ai', policy: () => ({ holds: 0.98, support: 'not_shown' }), helper: () => ({ verdict: 'true', reason: 'Added to cart directly confirms the asserted action' }) });
        const result = (await test.run).results[0]!;
        expect(result.status, result.summary).toBe('passed');
        expect(result.attempts[0]!.steps[0]!.evidence).toMatchObject({ verdicts: [{ uncertain: true }, { adjudicated: { passed: true } }] });
    });
    it('reports unresolved missing evidence as agent rather than product', async () => {
        const spec: TestSpec<void> = { id: 'missing-record-evidence', title: 'Record evidence', risk: 'An absent view becomes a product defect', start: '/hardening-cart', steps: () => [check('The receipts view lists this purchase')] };
        const result = (await suite([spec], { mode: 'ai', policy: () => ({ holds: 0.02, support: 'not_shown' }), helper: () => ({ verdict: 'not_shown', reason: 'The receipts view is not open' }) }).run).results[0]!;
        expect(result.cause, result.summary).toBe('agent');
    });
    it('does not treat a thousands separator as a compound step', async () => {
        const spec: TestSpec<void> = { id: 'numeric-comma-submit', title: 'Save amount', risk: 'A numeric comma adds phantom clauses', start: '/profile', fixture: async () => { app.reset(); }, ready: async ({ page }) => { await page.getByRole('textbox', { name: 'Nickname', exact: true }).fill('New name'); }, steps: () => [act('Save the profile with 1,000 credits', { expect: { write: { path: '/api/profile' } }, maxActions: 1 })] };
        const result = (await suite([spec], { mode: 'ai', policy: view => view.history.some(entry => entry.action === 'click') ? { done: 0.03, remaining: 0.98 } : { tool: 'click', target: element => element.name === 'Save profile' }, helper: () => ({ outcome: 'impossible', reason: 'No remaining action', tool: null, element: null, value_key: null, text: null }) }).run).results[0]!;
        expect(result.status, result.summary).toBe('passed');
    });
    it.each(['2', 'ABC123'])('preserves field tokens when recording page input %s', async token => {
        const spec: TestSpec<void> = { id: 'page-target-' + token.toLowerCase(), title: 'Enter page token', risk: 'A substring corrupts a recorded field name', start: '/hardening-page-input?token=' + token, steps: () => [act('Read the token from the page and enter it in ' + (token === '2' ? 'Address line 2' : 'ABC1234'))] };
        const result = (await suite([spec], { mode: 'ai', policy: view => view.history.some(entry => entry.action === 'type') ? { done: 0.99 } : { tool: 'type', target: element => element.name === (token === '2' ? 'Address line 2' : 'ABC1234'), pageValue: token } }).run).results[0]!;
        expect(result.status, result.summary).toBe('passed');
        const stored = JSON.parse(await readFile(join(root, 'recordings', spec.id + '.json'), 'utf8'));
        expect(stored.steps[0].actions[0].target.name).toBe(token === '2' ? 'Address line 2' : 'ABC1234');
    });
});


it('hardening waits before completion review instead of reviewing each idle polling round', async () => {
    const spec: TestSpec<void> = { id: 'review-after-wait', title: 'Deferred action', risk: 'Each wait duplicates review calls', start: '/reach-actions', steps: () => [act('Wait for the control, then double-click Open twice'), verify('double-clicked', ({ page }) => page.locator('#events').textContent().then(text => text?.includes('twice') === true))] };
    const test = suite([spec], { mode: 'ai', policy: view => {
        if (view.history.filter(entry => entry.action === 'wait').length < 3) { return { done: 0.4, tool: 'wait' }; }
        return view.text.includes('twice|') ? { done: 0.99 } : { tool: 'double_click', target: element => element.name === 'Open twice' };
    } });
    const result = (await test.run).results[0]!;
    expect(result.status, result.summary).toBe('passed');
    expect(test.calls.filter(call => call.view.review && call.view.history.filter(entry => entry.action === 'wait').length < 3)).toHaveLength(0);
});

it('reach2 performs a pending high-confidence activation before finishing across a next-step boundary', async () => {
    const { pendingActionPolicy } = await import('./support/fixture-policy.ts');
    const spec: TestSpec<void> = { id: 'pending-final-action', title: 'Finish the current entry', risk: 'Completion skips the final action', start: '/surface-replacement', steps: () => [act('Hover Add entry, then add the entry'), act('Leave the entry unchanged'), verify('added once', ({ page }) => page.locator('#count').textContent().then(value => value === '1'))] };
    const summary = await suite([spec], { policy: pendingActionPolicy }).run;
    expect(summary.results[0]?.status, summary.results[0]?.summary).toBe('passed');
    expect(summary.results[0]?.attempts[0]?.steps[0]?.actions?.map(action => action.tool)).toEqual(['hover', 'click']);
});

it('reach2 rejects a helper back proposal carrying authorized input and retries the coherent type decision', async () => {
    const spec: TestSpec<void> = { id: 'helper-input-tool', title: 'Filter entries', risk: 'Helper selects navigation while describing input', start: '/surface-labels', steps: () => [act('Filter entries to Notebook'), verify('query', ({ page }) => page.url().endsWith('?q=Notebook'))] };
    const { run, calls } = suite([spec], {
        policy: view => view.url.includes('q=Notebook') ? { done: 0.99 } : { tool: 'type', target: element => element.name === 'Filter entries', inputSource: 'step' },
        helper: view => ({ outcome: 'act', tool: 'back', element: view.elements.find(element => element.name === 'Filter entries')!.i, value_key: null, text: 'Notebook', reason: 'Type the literal Notebook into the filter field' }),
    });
    const summary = await run;
    expect(summary.results[0]?.status, summary.results[0]?.summary).toBe('passed');
    expect(summary.results[0]?.attempts[0]?.steps[0]?.actions?.map(action => action.tool)).toEqual(['type']);
    expect(calls.length).toBeGreaterThan(1);
});

it('reach2 preserves helper text selection when Jev proposes typing into the same field', async () => {
    const spec: TestSpec<void> = { id: 'helper-selection-tool', title: 'Format existing text', risk: 'Selection is mistaken for replacement input', start: '/surface-editor', ready: async ({ page }) => { await page.locator('#editor').fill('ship confirmed'); }, steps: () => [act('Make exactly confirmed bold', { maxActions: 3 }), verify('word formatting', ({ page }) => page.locator('#editor').innerHTML().then(html => html === 'ship <b>confirmed</b>'))] };
    const { run } = suite([spec], {
        mode: 'ai',
        policy: view => view.history.some(entry => entry.action === 'press') ? { done: 0.99 } : view.history.some(entry => entry.action === 'select_text') ? { tool: 'press', key: 'ControlOrMeta+b' } : { tool: 'type', target: element => element.name === 'Document', inputSource: 'step' },
        helper: view => ({ outcome: 'act', tool: 'select_text', element: view.elements.find(element => element.name === 'Document')!.i, value_key: null, text: 'confirmed', reason: 'Select the existing word before formatting it' }),
    });
    const result = (await run).results[0]!;
    expect(result.status, result.summary).toBe('passed');
    expect(result.attempts[0]?.steps[0]?.actions?.map(action => action.tool)).toEqual(['select_text', 'press']);
});

it('reach2 audits a pending activation independently from corrected earlier input', async () => {
    const spec: TestSpec<void> = { id: 'corrected-input-commit', title: 'Correct and store a cost', risk: 'An earlier input mistake suppresses the required commit', start: '/surface-labels', data: { cost: '17.25', mistake: '9.00' }, steps: () => [act('Correct Cost to {cost}, then Store entry'), verify('stored', ({ page }) => page.locator('#status').textContent().then(text => text === 'Entry stored'), { timeoutMs: 500 })] };
    const result = (await suite([spec], { mode: 'ai', policy: view => {
        if (!view.url && !view.control && (view.proposal || view.history.length)) { return { onTarget: (view.proposal ? [view.proposal] : view.history).some(entry => entry.action === 'type') ? 0.01 : 0.99 }; }
        if (view.notices.includes('Entry stored')) { return { done: 0.99 }; }
        const types = view.history.filter(entry => entry.action === 'type').length;
        return types < 3 ? { tool: 'type', target: element => element.name === 'Cost', value: types ? 'cost' : 'mistake' } : { tool: 'click', target: element => element.name === 'Store entry', done: 0.9, achieved: 0.7, remaining: 0.1, needed: 0.95 };
    } }).run).results[0]!;
    expect(result.status, result.summary).toBe('passed');
    expect(result.attempts[0]?.steps[0]?.actions?.map(action => action.tool)).toEqual(['type', 'type', 'type', 'click']);
});

it('reach2 refuses helper keyboard text absent from the step and observed page', async () => {
    const spec: TestSpec<void> = { id: 'keyboard-text-authorization', title: 'Focus a message', risk: 'Keyboard text bypasses input authorization', start: '/surface-editor', steps: () => [act('Focus Message', { maxActions: 1 })] };
    const result = (await suite([spec], { mode: 'ai', policy: () => ({ tool: 'none' }), helper: view => ({ outcome: 'act', tool: 'press', element: view.elements.find(element => element.role === 'textbox' && element.name?.startsWith('Message'))!.i, key: 'z', times: 1, value_key: null, text: null, reason: 'Insert an undeclared character' }) }).run).results[0]!;
    expect(result.status, result.summary).toBe('failed');
    expect(result.cause).toBe('agent');
    expect(JSON.stringify(result)).toContain('Keyboard text requires an authorized literal');
});

it('reach2 keeps unobserved clipboard contents outside keyboard input authorization', async () => {
    const spec: TestSpec<void> = { id: 'keyboard-clipboard-authorization', title: 'Focus a message', risk: 'Paste inserts a value absent from authorized inputs', start: '/surface-editor', ready: async ({ page }) => { await page.context().grantPermissions(['clipboard-read', 'clipboard-write']); await page.evaluate(() => navigator.clipboard.writeText('Undeclared-clipboard-6249')); }, steps: () => [act('Focus Message', { maxActions: 1 })] };
    const result = (await suite([spec], { mode: 'ai', policy: () => ({ tool: 'none' }), helper: view => ({ outcome: 'act', tool: 'press', element: view.elements.find(element => element.role === 'textbox' && element.name === 'Message')!.i, key: 'ControlOrMeta+v', times: 1, value_key: null, text: null, reason: 'Paste clipboard contents' }) }).run).results[0]!;
    expect(result.cause).toBe('agent');
    expect(JSON.stringify(result)).toContain('Clipboard input requires the type tool and an authorized value');
});


describe('merge completion regressions', () => {
    it.each(['healthy', 'missing'])('executes the necessary reservation confirmation before verifying: %s', async bug => {
        const spec: TestSpec<void> = { id: 'reservation-flow', title: 'Reserve a date', risk: 'Selection is mistaken for a reservation', start: '/completion-calendar?bug=' + bug, steps: () => [act('Reserve the date requested on the page'), verify('reservation committed', ({ page }) => page.locator('#receipt').textContent().then(text => text === 'Reservation confirmed'), { timeoutMs: 1 })] };
        const result = (await suite([spec], { mode: 'ai', policy: reservationPolicy, helper: () => ({ activation: 'activate', reason: 'The reservation requires its final confirmation' }) }).run).results[0]!;
        expect(result.status, result.summary).toBe(bug === 'healthy' ? 'passed' : 'failed');
        if (bug === 'missing') { expect(result.cause).toBe('product'); }
        expect(result.attempts[0]?.steps[0]?.actions?.map(action => action.element)).toEqual(['button "Open calendar"', 'button "4" near "August 2027"', 'button "Confirm reservation"']);
    });
    it.each(['healthy', 'missing'])('uses shared authorization before accepting a strong selection-only completion: %s', async bug => {
        const spec: TestSpec<void> = { id: 'reservation-scope', title: 'Commit the requested reservation', risk: 'Completion and control reviews disagree about necessary final actions', start: '/completion-calendar?bug=' + bug, steps: () => [act('Reserve the date requested on the page'), verify('reservation committed', ({ page }) => page.locator('#receipt').textContent().then(text => text === 'Reservation confirmed'), { timeoutMs: 1 })] };
        const result = (await suite([spec], { mode: 'ai', policy: reservationScopePolicy }).run).results[0]!;
        expect(result.status, result.summary).toBe(bug === 'healthy' ? 'passed' : 'failed');
        if (bug === 'missing') { expect(result.cause).toBe('product'); }
        expect(result.attempts[0]?.steps[0]?.actions?.map(action => action.element)).toEqual(['button "Open calendar"', 'button "4" near "August 2027"', 'button "Confirm reservation"']);
    });
    it.each(['healthy', 'missing'])('reviews an unactivated confident candidate despite a low necessity guess: %s', async bug => {
        const spec: TestSpec<void> = { id: 'reservation-low-necessity', title: 'Commit a reservation', risk: 'A confident target conflicts with selection-only completion', start: '/completion-calendar?bug=' + bug, steps: () => [act('Reserve the date requested on the page'), verify('reservation committed', ({ page }) => page.locator('#receipt').textContent().then(text => text === 'Reservation confirmed'), { timeoutMs: 1 })] };
        const policy = (view: Parameters<typeof reservationPolicy>[0]) => view.control ? { needed: 0.06 } : { ...reservationPolicy(view), pTarget: 0.69 };
        const result = (await suite([spec], { mode: 'ai', policy, helper: () => ({ activation: 'activate', reason: 'The requested reservation requires its unperformed final confirmation' }) }).run).results[0]!;
        expect(result.status, result.summary).toBe(bug === 'healthy' ? 'passed' : 'failed');
        if (bug === 'missing') { expect(result.cause).toBe('product'); }
        expect(result.attempts[0]?.steps[0]?.actions?.map(action => action.element)).toEqual(['button "Open calendar"', 'button "4" near "August 2027"', 'button "Confirm reservation"']);
    });
    it('accepts a complete control judgment with a long explanation before auditing its action', async () => {
        const spec: TestSpec<void> = { id: 'reservation-control-reason', title: 'Confirm a reservation', risk: 'A valid activation is rejected because its explanation is verbose', start: '/completion-calendar', steps: () => [act('Reserve the date requested on the page'), verify('reservation committed', ({ page }) => page.locator('#receipt').textContent().then(text => text === 'Reservation confirmed'), { timeoutMs: 1 })] };
        const result = (await suite([spec], { mode: 'ai', policy: reservationPolicy, helper: () => ({ reason: 'The requested final confirmation is still pending. '.repeat(12), activation: 'activate' }) }).run).results[0]!;
        expect(result.status, result.summary).toBe('passed');
        expect(result.attempts[0]?.steps[0]?.actions?.map(action => action.element)).toEqual(['button "Open calendar"', 'button "4" near "August 2027"', 'button "Confirm reservation"']);
    });
    it.each(['healthy', 'missing'])('states that no later action step reserves the necessary confirmation: %s', async bug => {
        const spec: TestSpec<void> = { id: 'reservation-no-next', title: 'Reserve without a later action', risk: 'An invented later step forbids the necessary confirmation', start: '/completion-calendar?bug=' + bug, steps: () => [act('Reserve the date requested on the page'), verify('reservation committed', ({ page }) => page.locator('#receipt').textContent().then(text => text === 'Reservation confirmed'), { timeoutMs: 1 })] };
        const policy = (view: Parameters<typeof reservationPolicy>[0]) => {
            if (view.next !== null && !view.history.some(entry => entry.element?.includes('Confirm reservation'))) {
                if (view.control) { return { needed: 0.02 }; }
                if (view.history.some(entry => entry.element?.includes('button "4"'))) { return { done: 0.96, achieved: 0.98, remaining: 0.02, tool: 'none' as const, target: (element: import('./support/scripted-models.ts').ViewElement) => element.name === 'Confirm reservation' }; }
            }
            return reservationPolicy(view);
        };
        const result = (await suite([spec], { mode: 'ai', policy, helper: view => ({ reason: view.next === null ? 'No later action reserves the required final confirmation' : 'A presumed later action reserves confirmation', activation: view.next === null ? 'activate' : 'finished' }) }).run).results[0]!;
        expect(result.status, result.summary).toBe(bug === 'healthy' ? 'passed' : 'failed');
        if (bug === 'missing') { expect(result.cause).toBe('product'); }
        expect(result.attempts[0]?.steps[0]?.actions?.map(action => action.element)).toEqual(['button "Open calendar"', 'button "4" near "August 2027"', 'button "Confirm reservation"']);
    });
    it.each(['healthy', 'missing'])('audits necessary unnamed final controls as authorized actions: %s', async bug => {
        const spec: TestSpec<void> = { id: 'reservation-authorized-audit', title: 'Authorize final reservation control', risk: 'Literal target naming conflicts with the authorized requested outcome', start: '/completion-calendar?bug=' + bug, steps: () => [act('Reserve the date requested on the page'), verify('reservation committed', ({ page }) => page.locator('#receipt').textContent().then(text => text === 'Reservation confirmed'), { timeoutMs: 1 })] };
        const policy = (view: View) => !view.url && !view.control ? { onTarget: /"authorized":/.test(view.instructions ?? '') ? 0.98 : 0.68 } : reservationPolicy(view);
        const result = (await suite([spec], { mode: 'ai', policy, helper: () => ({ reason: 'The final confirmation is required by the requested result', activation: 'activate' }) }).run).results[0]!;
        expect(result.status, result.summary).toBe(bug === 'healthy' ? 'passed' : 'failed');
        if (bug === 'missing') { expect(result.cause).toBe('product'); }
        expect(result.attempts[0]?.steps[0]?.actions?.map(action => action.element)).toEqual(['button "Open calendar"', 'button "4" near "August 2027"', 'button "Confirm reservation"']);
    });
    it.each(['healthy', 'missing'])('keeps a proposed confirmation separate from delivered history: %s', async bug => {
        const spec: TestSpec<void> = { id: 'reservation-pending-proposal', title: 'Review a pending confirmation', risk: 'The audit treats its own proposed click as already delivered', start: '/completion-calendar?bug=' + bug, steps: () => [act('Reserve the date requested on the page'), verify('reservation committed', ({ page }) => page.locator('#receipt').textContent().then(text => text === 'Reservation confirmed'), { timeoutMs: 1 })] };
        const policy = (view: View) => !view.url && !view.control ? { onTarget: view.proposal ? /Otherwise audit/.test(view.instructions ?? '') ? 0.48 : 0.98 : !view.history.some(entry => entry.element?.includes('Confirm reservation')) ? 0.98 : 0.25 } : reservationPolicy(view);
        const result = (await suite([spec], { mode: 'ai', policy, helper: () => ({ reason: 'The final confirmation is pending', activation: 'activate' }) }).run).results[0]!;
        expect(result.status, result.summary).toBe(bug === 'healthy' ? 'passed' : 'failed');
        if (bug === 'missing') { expect(result.cause).toBe('product'); }
        expect(result.attempts[0]?.steps[0]?.actions?.map(action => action.element)).toEqual(['button "Open calendar"', 'button "4" near "August 2027"', 'button "Confirm reservation"']);
    });
    it.each(['healthy', 'missing'])('does not require a destination view after delivered compound gestures: %s', async bug => {
        const spec: TestSpec<void> = { id: 'gesture-navigation', title: 'Hold and inspect an item', risk: 'Navigation review blocks a completed action without a requested view', start: '/completion-gestures?bug=' + bug, steps: () => [act('Long-press Hold item, then double-click Inspect item'), verify('gestures applied', async ({ page }) => await page.locator('#held').textContent() === 'Held' && await page.locator('#inspected').textContent() === 'Inspected', { timeoutMs: 1 })] };
        const result = (await suite([spec], { mode: 'ai', policy: gestureNavigationPolicy }).run).results[0]!;
        expect(result.status, result.summary).toBe(bug === 'healthy' ? 'passed' : 'failed');
        if (bug === 'missing') { expect(result.cause).toBe('product'); }
        expect(result.attempts[0]?.steps[0]?.actions?.map(action => action.tool)).toEqual(['long_press', 'double_click']);
    });
    it.each(['healthy', 'empty'])('opens the requested list after saving before checking content: %s', async bug => {
        const spec: TestSpec<void> = { id: 'saved-view-flow', title: 'Save and open a list', risk: 'A badge hides unopened content', start: '/completion-list?bug=' + bug, steps: () => [act('Save the entry, then open the Saved entries view'), verify('list contains the entry', ({ page }) => page.locator('#panel').textContent().then(text => text === 'Saved entriesField notes'), { timeoutMs: 1 })] };
        const result = (await suite([spec], { mode: 'ai', policy: savedViewPolicy }).run).results[0]!;
        expect(result.status, result.summary).toBe(bug === 'healthy' ? 'passed' : 'failed');
        if (bug === 'empty') { expect(result.cause).toBe('product'); }
        expect(result.attempts[0]?.steps[0]?.actions?.map(action => action.element)).toEqual(['button "Save entry"', 'button "Saved entries (1)"']);
    });
    it.each(['scroll', 'scroll_to'])('switches from two single-page scrolls to an instruction entity search despite %s', async tool => {
        const spec: TestSpec<void> = { id: 'search-after-scrolls', title: 'Find an archive entity', risk: 'Single pages exhaust the action budget', start: '/surface-search', steps: () => [act('Find Special entry (record 812), then open the entry', { maxActions: 5 }), verify('entry opened', ({ page }) => page.getByRole('status').textContent().then(text => text === 'Entry opened'), { timeoutMs: 1 })] };
        const recordingsDir = join(root, 'search-after-scrolls-' + tool);
        const policy = (view: Parameters<typeof singlePageSearchPolicy>[0]) => { const decision = singlePageSearchPolicy(view); return tool === 'scroll_to' && decision.tool === 'scroll' && view.history.filter(entry => entry.action === 'scroll').length >= 2 ? { ...decision, tool: 'scroll_to' as const } : decision; };
        const result = (await suite([spec], { policy, recordingsDir }).run).results[0]!;
        expect(result.status, result.summary).toBe('passed');
        const stored = JSON.parse(await readFile(join(recordingsDir, spec.id + '.json'), 'utf8'));
        expect(stored.steps[0].actions[2]).toMatchObject({ tool: 'scroll', scrollText: 'record 812' });
        expect((await suite([spec], { mode: 'replay', recordingsDir }).run).totals.passed).toBe(1);
    }, 90_000);
});

describe('merge origin binding', () => {
    it('replays base routes on a different port and rejects a different active origin', async () => {
        const other = await startFixtureApp();
        try {
            const spec: TestSpec<void> = { id: 'base-port-route', title: 'Save at the configured app', risk: 'An absolute cached port hides effects', start: '/integrity', steps: () => [act('Save draft')] };
            const recordingsDir = join(root, 'base-port-route');
            expect((await suite([spec], { policy: integrityPolicy, recordingsDir }).run).totals.passed).toBe(1);
            const stored = JSON.parse(await readFile(join(recordingsDir, spec.id + '.json'), 'utf8'));
            expect(stored.steps[0].end).toMatchObject({ base: true, route: '/integrity' });
            expect((await suite([spec], { baseURL: other.origin, mode: 'replay', recordingsDir }).run).totals.passed).toBe(1);
            const drift = await suite([{ ...spec, ready: async ({ page }) => { await page.goto(other.origin + '/integrity'); } }], { allowedOrigins: [other.origin], mode: 'replay', recordingsDir }).run;
            expect(drift.results[0]?.status).toBe('failed');
            expect(drift.results[0]?.summary).toContain('route');
            delete stored.steps[0].end.base;
            stored.steps[0].end.route = app.origin + '/integrity?legacy=1';
            await writeFile(join(recordingsDir, spec.id + '.json'), JSON.stringify(stored));
            expect((await suite([spec], { baseURL: other.origin, mode: 'replay', recordingsDir }).run).totals.passed).toBe(1);
        } finally { await other.close(); }
    });
});


it('merge audits contradictory repeat proposals with prior activations before proceeding to the defect check', async () => {
    const spec: TestSpec<void> = { id: 'repeat-proposal-context', title: 'Increase a count', risk: 'An extra increment hides a broken total', start: '/integration-counter?bug=total', steps: () => [act('Increase the first batch count by two'), verify('total reflects the new count', ({ page }) => page.locator('output').textContent().then(text => text === '21'), { timeoutMs: 1 })] };
    const result = (await suite([spec], { mode: 'ai', policy: view => {
        const count = view.history.filter(entry => entry.action === 'click').length;
        if (!view.url && !view.control) { return { onTarget: (view.auditContext?.control_activations?.length ?? 0) >= 2 || view.history.length >= 3 ? 0.01 : 0.99 }; }
        if (view.control) { return { needed: count >= 2 ? 0.28 : 0.98 }; }
        return count >= 2 ? { done: 0.72, achieved: 0.85, remaining: 0.08, tool: 'none', target: element => element.name === '+' }
            : { tool: 'click', target: element => element.name === '+' };
    }, helper: view => view.control ? { activation: 'activate', reason: 'The two increments were performed; do not increment again' } : { outcome: 'step_already_done', tool: null, element: null, value_key: null, text: null, reason: 'Both requested increments were performed' } }).run).results[0]!;
    expect(result.cause, result.summary).toBe('product');
    expect(result.attempts[0]?.steps[0]?.actions?.filter(action => action.ok)).toHaveLength(2);
    expect(result.attempts[0]?.steps[1]?.failure).toBe('assertion');
});


describe('merge delivery boundary regressions', () => {
    it('names the reserved next action before auditing a premature confirmation', async () => {
        const spec: TestSpec<void> = { id: 'reserved-confirmation', title: 'Prepare before confirming', risk: 'A permissive candidate audit crosses a next-step boundary', start: '/items?bug=wrong-row', fixture: async () => { app.reset(); }, invariants: [{ name: 'Other entries stay active', check: () => app.state.items.filter(item => item.id !== 'b').every(item => !item.archived) }], steps: () => [act('Start archiving the Beta plan'), act('Confirm archiving in the dialog', { expect: { write: { path: /\/archive$/ } } })] };
        const result = (await suite([spec], { mode: 'ai', policy: view => {
            if (!view.url && !view.control) { return { onTarget: 0.85 }; }
            if (view.step === 'Start archiving the Beta plan' && (view.dialog || view.control)) {
                const boundary = view.instructions?.includes('Confirm archiving in the dialog');
                return view.control ? { needed: boundary ? 0.02 : 0.5 } : { done: 0.84, remaining: 0.25, achieved: boundary ? 0.64 : 0.2, tool: 'none', target: element => element.name === 'Archive plan' };
            }
            return fixturePolicy(view);
        }, helper: view => view.control ? { reason: 'The next step reserves this confirmation', activation: 'finished' } : { outcome: 'step_already_done', tool: null, element: null, value_key: null, text: null, reason: 'The dialog is ready for the next step' } }).run).results[0]!;
        expect(result.cause, result.summary).toBe('product');
        expect(result.attempts[0]?.steps[0]?.actions?.map(action => action.element)).toEqual(['button "Archive"']);
        expect(result.attempts[0]?.steps[1]?.failure).toBe('invariant');
    });
    it.each(['healthy', 'missing'])('reviews successful delivery separately from missing reservation effects: %s', async bug => {
        const spec: TestSpec<void> = { id: 'delivered-reservation', title: 'Commit a reservation once', risk: 'Missing content prevents checking a delivered confirmation', start: '/completion-calendar?bug=' + bug, steps: () => [act('Reserve the date requested on the page'), verify('reservation committed', ({ page }) => page.locator('#receipt').textContent().then(text => text === 'Reservation confirmed'), { timeoutMs: 1 })] };
        const result = (await suite([spec], { mode: 'ai', policy: view => {
            if (view.url && !view.control && view.history.some(entry => entry.element?.includes('Confirm reservation'))) {
                const instructions = JSON.parse(view.instructions ?? '{}').complete?.instructions ?? '';
                return { done: 0.45, remaining: 0.5, achieved: instructions.includes('Absent product effects') ? 0.99 : 0.61, tool: 'none', target: element => element.name === 'Confirm reservation' };
            }
            return reservationPolicy(view);
        }, helper: view => view.control ? { reason: 'The final confirmation is still pending', activation: 'activate' } : { outcome: 'impossible', tool: null, element: null, value_key: null, text: null, reason: 'The requested actions are already delivered; there is no extra action to propose' } }).run).results[0]!;
        expect(result.status, result.summary).toBe(bug === 'healthy' ? 'passed' : 'failed');
        if (bug === 'missing') { expect(result.cause).toBe('product'); }
        expect(result.attempts[0]?.steps[0]?.actions?.filter(action => action.ok && action.element === 'button "Confirm reservation"')).toHaveLength(1);
    });
});


it('merge accepts corrected failed attempts when all formatting actions were later delivered', async () => {
    const spec: TestSpec<void> = { id: 'corrected-formatting-delivery', title: 'Recover then format a word', risk: 'A corrected selection failure prevents checking delivered formatting', start: '/surface-editor', data: { text: 'ship confirmed' }, steps: () => [act('Type {text} in Document and make exactly confirmed bold'), verify('exact formatting', ({ page }) => page.locator('#editor').innerHTML().then(html => html === 'ship <b>confirmed</b>'), { timeoutMs: 1 })] };
    const result = (await suite([spec], { mode: 'ai', policy: view => {
        const typed = view.history.some(entry => entry.action === 'type' && !entry.error);
        const selected = view.history.some(entry => entry.action === 'select_text' && !entry.error);
        const formatted = view.history.some(entry => entry.action === 'click' && entry.element === 'button "Bold"');
        if (formatted) { return { done: 0.23, achieved: view.history.some(entry => entry.error) ? 0.42 : 0.99, remaining: 0.8, tool: 'none' }; }
        if (!typed && view.history.some(entry => entry.error)) { return { tool: 'type', target: element => element.name === 'Document', value: 'text' }; }
        return selected ? { tool: 'click', target: element => element.name === 'Bold' } : { tool: 'select_text', target: element => element.name === 'Document', selectText: 'confirmed' };
    } }).run).results[0]!;
    expect(result.status, result.summary).toBe('passed');
    expect(result.attempts[0]?.steps[0]?.actions?.map(action => [action.tool, action.ok])).toEqual([['select_text', false], ['type', true], ['select_text', true], ['click', true]]);
});


it.each(['healthy', 'missing'])('merge recognizes a requested date through its editor and visible month context: %s', async bug => {
    const spec: TestSpec<void> = { id: 'value-target-context', title: 'Reserve a named value', risk: 'Literal button-label matching rejects the named date', start: '/completion-calendar?bug=' + bug, steps: () => [act('Reserve August 4, 2027'), verify('reservation committed', ({ page }) => page.locator('#receipt').textContent().then(text => text === 'Reservation confirmed'), { timeoutMs: 1 })] };
    const result = (await suite([spec], { mode: 'ai', policy: view => !view.url && !view.control ? { onTarget: view.instructions?.includes('Resolve requested entities or values') ? 0.98 : 0.11 } : reservationPolicy(view), helper: () => ({ reason: 'The named date requires its pending confirmation', activation: 'activate' }) }).run).results[0]!;
    expect(result.status, result.summary).toBe(bug === 'healthy' ? 'passed' : 'failed');
    if (bug === 'missing') { expect(result.cause).toBe('product'); }
    expect(result.attempts[0]?.steps[0]?.actions?.map(action => action.element)).toEqual(['button "Open calendar"', 'button "4" near "August 2027"', 'button "Confirm reservation"']);
});


it('merge audits delivered targets without requiring the product effect to have succeeded', async () => {
    const spec: TestSpec<void> = { id: 'historical-target-scope', title: 'Check a delivered reservation', risk: 'An absent receipt retroactively makes the correct controls unrelated', start: '/completion-calendar?bug=missing', steps: () => [act('Reserve August 4, 2027'), verify('reservation committed', ({ page }) => page.locator('#receipt').textContent().then(text => text === 'Reservation confirmed'), { timeoutMs: 1 })] };
    const result = (await suite([spec], { mode: 'ai', policy: view => {
        if (!view.url && !view.control && !view.proposal) { const question = JSON.parse(view.instructions ?? '{}').on_target_0; return { onTarget: question?.criteria?.authorized?.includes('Actual product success is irrelevant') ? 0.95 : 0.11 }; }
        return reservationPolicy(view);
    }, helper: () => ({ reason: 'The required confirmation is pending', activation: 'activate' }) }).run).results[0]!;
    expect(result.cause, result.summary).toBe('product');
    expect(result.attempts[0]?.steps[1]?.failure).toBe('assertion');
    expect(result.attempts[0]?.steps[0]?.actions?.map(action => action.element)).toEqual(['button "Open calendar"', 'button "4" near "August 2027"', 'button "Confirm reservation"']);
});


it.each(['healthy', 'missing-format'])('merge requires requested formatting actions rather than all permitted editor actions: %s', async bug => {
    const spec: TestSpec<void> = { id: 'required-editor-actions', title: 'Format without extra editor work', risk: 'Permitted editor actions become mandatory completion work', start: '/surface-editor?bug=' + bug, data: { text: 'ship confirmed' }, steps: () => [act('Type {text} in Document and make exactly confirmed bold'), verify('exact formatting', ({ page }) => page.locator('#editor').innerHTML().then(html => html === 'ship <b>confirmed</b>'), { timeoutMs: 1 })] };
    const result = (await suite([spec], { mode: 'ai', policy: view => {
        if (!view.url && !view.control) { return { onTarget: view.proposal?.element === 'button "Inspect document"' ? 0.01 : 0.98 }; }
        if (view.control) { return { needed: 0.02 }; }
        if (view.history.some(entry => entry.action === 'click' && entry.element === 'button "Bold"')) {
            const question = JSON.parse(view.instructions ?? '{}').complete;
            return { done: 0.29, remaining: 0.69, achieved: question?.criteria?.achieved?.includes('All authorized') ? 0.42 : 0.99, tool: 'none', target: element => element.name === 'Inspect document' };
        }
        if (!view.history.some(entry => entry.action === 'type')) { return { tool: 'type', target: element => element.name === 'Document', value: 'text' }; }
        return view.history.some(entry => entry.action === 'select_text') ? { tool: 'click', target: element => element.name === 'Bold' } : { tool: 'select_text', target: element => element.name === 'Document', selectText: 'confirmed' };
    } }).run).results[0]!;
    expect(result.status, result.summary).toBe(bug === 'healthy' ? 'passed' : 'failed');
    if (bug === 'missing-format') { expect(result.cause).toBe('product'); }
    expect(result.attempts[0]?.steps[0]?.actions?.map(action => action.tool)).toEqual(['type', 'select_text', 'click']);
    expect(result.attempts[0]?.steps[0]?.actions?.some(action => action.element === 'button "Inspect document"')).toBe(false);
});


it.each(['healthy', 'missing'])('merge permits the date editor prerequisite before its final control becomes visible: %s', async bug => {
    const spec: TestSpec<void> = { id: 'editor-prerequisite', title: 'Select before committing', risk: 'A primitive selection is rejected because it does not complete the whole reservation', start: '/completion-calendar?bug=' + bug, steps: () => [act('Reserve August 4, 2027'), verify('reservation committed', ({ page }) => page.locator('#receipt').textContent().then(text => text === 'Reservation confirmed'), { timeoutMs: 1 })] };
    const result = (await suite([spec], { mode: 'ai', policy: view => {
        if (!view.url && !view.control && view.proposal?.element?.includes('button "4"')) { return { onTarget: view.instructions?.includes('need not complete the whole step') ? 0.98 : 0.66 }; }
        if (view.control?.includes('button "4"')) { return { needed: 0.1 }; }
        if (view.dialog?.includes('August 2027')) { return { done: 0.11, achieved: 0.2, remaining: 0.88, tool: view.instructions?.includes('need not complete the whole step') ? 'click' : 'none', target: element => element.name === '4' }; }
        return reservationPolicy(view);
    }, helper: view => view.control ? { reason: 'The required date selection is pending', activation: 'activate' } : { outcome: 'impossible', tool: null, element: null, value_key: null, text: null, reason: 'Only a date button is visible; it cannot complete the reservation by itself' } }).run).results[0]!;
    expect(result.status, result.summary).toBe(bug === 'healthy' ? 'passed' : 'failed');
    if (bug === 'missing') { expect(result.cause).toBe('product'); }
    expect(result.attempts[0]?.steps[0]?.actions?.map(action => action.element)).toEqual(['button "Open calendar"', 'button "4" near "August 2027"', 'button "Confirm reservation"']);
});

it.each(['healthy', 'missing', 'selection-only'])('merge reviews pending controls independently of a completed field target: %s', async variant => {
    const selection = variant === 'selection-only';
    const spec: TestSpec<void> = { id: 'completed-field-target', title: 'Review a pending activation after selection', risk: 'A completed textbox hides the pending confirmation from control review', start: '/completion-picker?bug=' + variant, steps: () => [act(selection ? 'Select the date requested on this page using its calendar' : 'Follow the current page instructions to reserve its requested date'), verify('requested result', async ({ page }) => await page.locator('#date').inputValue() === '2027-08-04' && (selection ? await page.locator('#activations').textContent() === '0' : await page.locator('#receipt').textContent() === 'Reservation confirmed'), { timeoutMs: 1 })] };
    const result = (await suite([spec], { mode: 'ai', policy: view => {
        if (!view.url && !view.control) { return { onTarget: selection && view.proposal?.element?.includes('Confirm reservation') ? 0.01 : 0.98 }; }
        if (view.control) { return { needed: 0.04 }; }
        if (view.history.some(entry => entry.element?.includes('Confirm reservation'))) { return { done: 0.97, achieved: 0.99, remaining: 0.02, tool: 'none' }; }
        if (view.history.some(entry => entry.element?.includes('button "4"'))) {
            return { done: 0.89, achieved: 0.92, remaining: 0.15, tool: 'none', targetProbability: element => element.name === 'Selected date' ? 0.58 : element.name === 'Confirm reservation' ? 0.4 : element.name === 'Plans' ? 0.02 : 0 };
        }
        if (!view.dialog) { return { tool: 'click', target: element => element.name === 'Choose date' }; }
        return view.text.includes('August 2027') ? { tool: 'click', target: element => element.name === '4' } : { tool: 'click', target: element => element.name === 'Next month' };
    }, helper: view => view.control ? { reason: 'The reservation still needs its final confirmation', activation: 'activate' } : { outcome: 'impossible', tool: null, element: null, value_key: null, text: null, reason: 'No recovery action was scripted' } }).run).results[0]!;
    expect(result.status, result.summary).toBe(variant === 'missing' ? 'failed' : 'passed');
    if (variant === 'missing') { expect(result.cause).toBe('product'); }
    expect(result.attempts[0]?.steps[0]?.actions?.filter(action => action.element === 'button "Confirm reservation"' && action.ok)).toHaveLength(selection ? 0 : 1);
});

it('waits for visible loading content before judging a factual check', async () => {
    const spec: TestSpec<void> = { id: 'slow-visible-record', title: 'Read the delivery record', risk: 'Loading content is mistaken for a missing product result', start: '/attribution-regions?region=loading&resolve=slow', steps: () => [check('The delivery records show Record ZX-71')] };
    const policy = (view: View) => view.text.includes('Record ZX-71') ? { holds: 0.99, support: 'supports' as const, region: 'open' as const } : { holds: 0.01, support: 'not_shown' as const, region: 'open' as const };
    const result = (await suite([spec], { policy }).run).results[0]!;
    expect(result.status, result.summary).toBe('passed');
});

it('preserves a check loading timeout through step exception handling', async () => {
    const spec: TestSpec<void> = { id: 'stuck-visible-record', title: 'Read pending content', risk: 'Loading timeout loses its cause', start: '/attribution-regions?region=loading&resolve=stuck', steps: () => [check('The delivery records show Record ZX-71')] };
    const execution = suite([spec]);
    const result = (await execution.run).results[0]!;
    expect(result.status).toBe('failed');
    expect(result.cause, result.summary).toBe('timeout');
    expect(result.attempts[0]?.steps[0]?.failure).toBe('timeout');
    expect(execution.calls).toHaveLength(0);
});

it('keeps field proof in the recording without duplicating values in evidence choices', async () => {
    const spec = profileTest();
    const execution = suite([spec], { recordingsDir: join(root, 'compact-proof') });
    const result = (await execution.run).results[0]!;
    expect(result.status, result.summary).toBe('passed');
    const call = execution.calls.find(call => call.questions.includes('evidence'))!;
    expect(call.view.instructions).not.toContain('Grace Hopper');
    const stored = JSON.parse(await readFile(join(root, 'compact-proof/profile-save.json'), 'utf8'));
    expect(stored.steps.find((entry: { checkEvidence?: unknown[] }) => entry.checkEvidence)?.checkEvidence[0].value).toBe('Grace Hopper');
});

it('does not replay positive fragments as proof of a negative clause', async () => {
    const directory = join(root, 'negative-proof');
    const spec = (reveal: boolean): TestSpec<void> => ({ id: 'negative-control', title: 'Check the available actions', risk: 'A newly visible forbidden action escapes replay', start: '/integrity?bug=negative-control', ready: async ({ page }) => { if (reveal) await page.locator('#forbidden').evaluate(element => (element as HTMLElement).hidden = false); }, steps: () => [check('The page offers "Save draft", not "Delete draft"')] });
    const seeded = (await suite([spec(false)], { recordingsDir: directory, policy: () => ({ holds: 0.99, support: 'supports', region: 'open' }) }).run).results[0]!;
    expect(seeded.status, seeded.summary).toBe('passed');
    const replayed = (await suite([spec(true)], { recordingsDir: directory, mode: 'replay' }).run).results[0]!;
    expect(replayed.status, replayed.summary).toBe('unverified');
});
