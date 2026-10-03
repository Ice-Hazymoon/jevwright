import type { TestSpec } from '../src/index.ts';
import type { RunSummary, SuiteOptions } from '../src/suite.ts';
import type { View } from './support/scripted-models.ts';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runFailureExitCode } from '../src/cli.ts';
import { act, check, reload, run, runSuite, secret, verify } from '../src/index.ts';
import { describePageValue, pageValueChoices, readPageValue } from '../src/page-values.ts';
import { createRedactor } from '../src/secrets.ts';
import { startFixtureApp } from './fixtures/app.ts';
import { fixturePolicy } from './support/fixture-policy.ts';
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
        const { run, calls } = suite([profileTest()], { mode: 'replay' });
        const summary = await run;
        const [result] = summary.results;
        expect(result!.status, result!.summary).toBe('passed');
        expect(result!.attempts[0]!.steps.slice(0, 2).map(step => step.source)).toEqual(['replay', 'replay']);
        // Replay mode never loads models; the semantic check is reported as skipped.
        expect(calls).toHaveLength(0);
        expect(result!.attempts[0]!.steps[3]!.status).toBe('skipped');
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
        const replay = await suite([profileTest('/profile?bug=500')], { recordingsDir, mode: 'replay' }).run;
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
        recording.steps[1].end = { appeared: [{ kind: 'heading', text: 'Recorded completion' }] };
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
        expect(JSON.parse(backfilled).steps.every((step: { end?: unknown }) => step.end !== undefined)).toBe(true);
        expect((await suite([spec], { recordingsDir }).run).results[0]?.recordingUpdated).toBe(false);
        expect(await readFile(path, 'utf8')).toBe(backfilled);
        for (const step of recording.steps) { delete step.end; }
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
    return { id: 'choose-entry', title: 'Choose the entry dated 2026-01-01', risk: 'The wrong dated row is selected', start, steps: () => [act('Choose the entry dated 2026-01-01', { maxActions: 2 }), verify('Alpha selected', async ({ page }) => page.getByRole('heading', { name: 'Alpha chosen', exact: true }).isVisible())] };
}
const effectPolicy = (view: View) => view.text.includes('Alpha chosen') ? { done: 0.99, tool: 'none' } : { tool: 'click', target: (element: { name?: string; in?: string }) => element.name === 'Choose' && Boolean(element.in?.includes('2026-01-01')) };

describe('end state attribution', () => {
    it('heals a duplicate control that changed row order, while replay exposes the mismatch', async () => {
        const recordingsDir = join(root, 'swapped-effects');
        const seed = (await suite([effectTest()], { recordingsDir, policy: effectPolicy }).run).results[0]!;
        expect(seed.status, seed.summary).toBe('passed');
        const replay = (await suite([effectTest('/effects?bug=swapped')], { recordingsDir, mode: 'replay' }).run).results[0]!;
        expect(replay.status).toBe('failed');
        expect(replay.cause).toBe('product');
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

    it('charges a no-effect replay to the product when a later verify fails, and names it before a replay miss', async () => {
        const recordingsDir = join(root, 'replay-no-effect');
        const seed = (await suite([confirmTest('/effects?single=1&confirm=1')], { recordingsDir, policy: confirmPolicy }).run).results[0]!;
        expect(seed.status, seed.summary).toBe('passed');
        const verifyDir = join(root, 'replay-no-effect-verify');
        expect((await suite([effectTest('/effects?single=1')], { recordingsDir: verifyDir, policy: effectPolicy }).run).results[0]?.status).toBe('passed');
        const product = await suite([effectTest('/effects?single=1&bug=no-effect')], { recordingsDir: verifyDir, mode: 'replay' }).run;
        expect(product.results[0]?.cause).toBe('product');
        expect(product.results[0]?.summary).toContain('step 1\'s replay missed its recorded end state');
        expect(runFailureExitCode(product)).toBe(1);
        const missed = await suite([confirmTest('/effects?single=1&confirm=1&bug=no-effect')], { recordingsDir, mode: 'replay' }).run;
        expect(missed.results[0]?.cause).toBe('agent');
        expect(missed.results[0]?.attempts[0]?.steps[1]?.failure).toBe('not-found');
        expect(missed.results[0]?.summary).toContain('step 1\'s replay missed its recorded end state');
        expect(runFailureExitCode(missed)).toBe(1);
    });

    it('keeps a same-path intermittent failure flaky without rerouting or rewriting the recording', async () => {
        const recordingsDir = join(root, 'same-path-flaky');
        let attempts = 0;
        const spec = { ...profileTest(), steps: () => [...profileTest().steps().slice(0, 2), run('count the attempt', () => { attempts++; }), verify('passes after the first try', () => attempts > 1, { timeoutMs: 300 })] };
        expect((await suite([profileTest()], { recordingsDir }).run).results[0]?.status).toBe('passed');
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
        const removed = await suite([profileTest('/profile?bug=relabel')], { recordingsDir, mode: 'replay' }).run;
        expect(removed.results[0]?.attempts[0]?.steps.find(step => step.status === 'failed')?.failure).toBe('not-found');
        expect(runFailureExitCode(removed)).toBe(1);
        const mismatchDir = join(root, 'exit-table-mismatch');
        expect((await suite([effectTest('/effects?single=1')], { recordingsDir: mismatchDir, policy: effectPolicy }).run).results[0]?.status).toBe('passed');
        const passingMismatch = { ...effectTest('/effects?single=1&bug=no-effect'), steps: () => [act('Choose the entry dated 2026-01-01', { maxActions: 2 })] };
        const unrecorded = { ...profileTest(), id: 'unrecorded-beside-mismatch' };
        const mixed = await suite([passingMismatch, unrecorded], { recordingsDir: mismatchDir, mode: 'replay' }).run;
        expect(mixed.results[0]?.status).toBe('passed');
        expect(mixed.results[0]?.attempts[0]?.steps[0]?.endMismatch).toBe(true);
        expect(runFailureExitCode(mixed)).toBe(4);
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
        recording.steps[0].end = { appeared: [{ kind: 'heading', text: 'Missing effect' }] };
        await writeFile(path, JSON.stringify(recording));
        const summary = await suite([spec], { recordingsDir, mode: 'replay' }).run;
        expect(summary.results[0]?.attempts[0]?.steps[0]?.endMismatch).toBe(true);
        expect(summary.results[0]?.attempts[0]?.steps[1]?.failure).toBe('not-recorded');
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
        expect(JSON.stringify(stored)).not.toContain('AR-7285');
        const replay = await suite([tokenTest(id, 'BX-9164')], { mode: 'replay' }).run;
        expect(replay.results[0]!.status, replay.results[0]!.summary).toBe('passed');
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
        expect(replay.summary).toContain('需要模型重新读取页面值');
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
        expect(result.summary).toContain('需要模型重新读取页面值');
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
            if (view.history.some(entry => entry.element === 'link "Profile"')) { return { done: 0.99, achieved: 0.99, onTarget: 0.02 }; }
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
        const result = (await suite([spec], { policy: () => ({ holds: 0.98, support: 'not_shown' }) }).run).results[0]!;
        expect(result.status).toBe('failed');
        expect(result.cause).toBe('product');
        expect(result.attempts[0]!.steps[1]!.evidence).toMatchObject({ verdicts: [{ passed: false, support: 'not_shown' }] });
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
