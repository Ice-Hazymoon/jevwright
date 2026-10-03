import type { Device } from './devices.ts';
import type { ModelSettings, ModelUsage, RunBudget } from './models.ts';
import type { Issue } from './monitor.ts';
import type { TestRecording } from './recording.ts';
import type { Env, TestSpec } from './spec.ts';
import type { AttemptResult, Cause } from './test-runner.ts';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { writeArtifact } from './artifacts.ts';
import { launchBrowser } from './browser.ts';
import { resolveDevice } from './devices.ts';
import { JevwrightError } from './errors.ts';
import { resolveFiles } from './files.ts';
import { addUsage, createRunBudget, emptyUsage, modelIds, runBudgetMessage } from './models.ts';
import { assertReachable, checkedOrigin } from './origin.ts';
import { changedActionSteps, createRecordingStore, learnedRecording } from './recording.ts';
import { writeReports } from './report.ts';
import { createRedactor, forResults } from './secrets.ts';
import { assertValidTests, testSelectionKey } from './select.ts';
import { runTestAttempt } from './test-runner.ts';
import { VERSION } from './version.ts';

const artifactDirectories = new WeakMap<RunSummary, string>();

/** `known`: failed on the product the way the test's `knownIssue` describes; it does not fail the run. */
export type TestStatus = 'passed' | 'failed' | 'flaky' | 'known' | 'skipped';

export interface TestResult {
    id: string;
    selectionKey?: string;
    module?: string;
    title: string;
    risk: string;
    tags: readonly string[];
    status: TestStatus;
    cause?: Cause;
    summary: string;
    /** Failures reproduced / attempts, for failed and flaky tests. */
    reproduced?: string;
    attempts: AttemptResult[];
    issues: Issue[];
    models: ModelUsage;
    durationMs: number;
    recordingUpdated: boolean;
    rerouted?: { steps: number[] };
    freshRetrySkipped?: string;
    skipReason?: string;
    knownIssue?: string;
}

export interface RunManifest {
    runId: string;
    engine: string;
    startedAt: string;
    finishedAt?: string;
    /** Interrupted: its unstarted tests are skipped, so it says nothing about which tests fail. */
    cancelled?: true;
    git: { sha: string; dirty: boolean } | null;
    mode: RunMode;
    /** Fixtures, start pages and initial invariants only. */
    dryRun?: true;
    models: ReturnType<typeof modelIds> | null;
    origin: string;
    concurrency: number;
    retries: number;
    /** Shared cost ceiling for the whole run, when one was configured; omitted in replay mode (no calls). */
    maxCostUsd?: number;
    tests: string[];
    command?: string;
    /** Requests the browser tried to make outside the allowed origins. */
    blockedRequests?: string[];
    metadata?: Record<string, unknown>;
}

export interface RunSummary {
    manifest: RunManifest;
    results: TestResult[];
    totals: Record<TestStatus, number> & { tests: number; issues: number; models: ModelUsage; durationMs: number };
    directory: string;
}

/**
 * auto: replay recordings, heal stale steps with AI, record new paths.
 * replay: recordings only; any stale step fails (no model calls, CI-friendly).
 * ai: ignore recordings; ground every step fresh (measures the AI itself).
 */
export type RunMode = 'auto' | 'replay' | 'ai';

export interface SuiteOptions {
    /** The app under test, e.g. `http://127.0.0.1:3000`. Each test opens its `start` path here. */
    baseURL: string;
    /** Further origins the browser may reach (an auth server on another port); every other origin is blocked. */
    allowedOrigins?: readonly string[];
    /** Each run writes its reports, screenshots and traces to a new directory here. */
    outputDir: string;
    /** Where recordings are read and written; omit to run without them. */
    recordingsDir?: string;
    mode?: RunMode;
    /** Write recordings for passing tests. Defaults to true in auto/ai mode. */
    updateRecordings?: boolean;
    /** Tests run in parallel, each in its own browser context. Default 2. */
    concurrency?: number;
    /** Extra attempts for a failed test; later passes mark it flaky, repeated failures mark it reproduced. Default 1. */
    retries?: number;
    headless?: boolean;
    signal?: AbortSignal;
    /** Required in auto and ai mode; replay and dry runs make no model calls. */
    models?: ModelSettings;
    /**
     * Ceiling on the whole run's accumulated gateway cost, shared across every concurrently running test.
     * Once reached, tests not yet started fail without running and a test in progress fails at its next model
     * call, all with cause `model`; neither is retried. Unbounded when omitted (the CLI defaults to $1); replay mode makes no calls.
     */
    maxCostUsd?: number;
    /** Also ask Jev on every decision whether the page looks broken. */
    probe?: boolean;
    /** Validate fixtures and start pages only; no steps, no model calls, no recordings. */
    dryRun?: boolean;
    /**
     * Fail a test when a high-severity issue appears: an uncaught page error, a 5xx response, a server error
     * screen, or the app not loading its own code. Default true; false only reports them.
     */
    failOnIssues?: boolean;
    /** The app's translation keys; one rendered verbatim on a page is reported as untranslated. */
    translationKeys?: Iterable<string>;
    /** Default 1280×900. */
    rootDir?: string;
    device?: Device;
    deviceOverride?: Device;
    viewport?: { width: number; height: number };
    /** Browser locale. Default `en-US`. */
    locale?: string;
    /** Browser time zone. Default `UTC`. */
    timezone?: string;
    /** Handed to fixtures and steps as `env`. */
    env?: Env;
    /** How this run was started; reports derive per-test reproduce commands from it. */
    command?: string;
    /** Extra facts recorded in run.json, e.g. which database the run owned. */
    metadata?: Record<string, unknown>;
    /** Progress lines; defaults to stderr. */
    log?: (line: string) => void;
    /** Called as each test finishes. */
    onResult?: (result: TestResult) => void;
}

/**
 * Runs the tests and writes one run directory (report.md, report.html, summary.json, run.json, per-attempt
 * screenshots and traces) under `outputDir`. Never throws for a failing test; read `totals` and `results`.
 * Throws a JevwrightError before anything runs for invalid tests or options, an app that does not answer at
 * `baseURL`, missing models in auto or ai mode, or a missing or outdated Playwright browser.
 */
export async function runSuite(specs: ReadonlyArray<TestSpec<unknown>>, options: SuiteOptions): Promise<RunSummary> {
    assertValidTests(specs);
    const redact = createRedactor(specs.flatMap(spec => Object.values(spec.secrets ?? {})));
    const files = new Map(await Promise.all(specs.map(async spec => [spec.id, await resolveFiles(spec.files, options.rootDir)] as const)));
    const devices = new Map(specs.map(spec => [spec.id, resolveDevice(options.deviceOverride ?? spec.device ?? options.device, options.viewport)]));
    const mode = options.mode ?? 'auto';
    if (mode !== 'replay' && !options.dryRun && !options.models) {
        throw new JevwrightError(`Mode "${mode}" needs \`models\`; use mode "replay" or \`dryRun\` to run without a model`);
    }
    const origin = checkedOrigin(options.baseURL, 'baseURL');
    const allowedOrigins = (options.allowedOrigins ?? []).map(value => checkedOrigin(value, 'allowedOrigins entry'));
    await assertReachable(origin);
    const runId = `${new Date().toISOString().slice(0, 19).replaceAll(':', '').replace('T', '-')}-${randomUUID().slice(0, 6)}`;
    const directory = join(options.outputDir, runId);
    await mkdir(directory, { recursive: true });
    const models = mode === 'replay' || options.dryRun ? undefined : options.models;
    // Replay makes no model calls, so it never checks the budget; auto/ai share one pool across concurrent tests.
    const runBudget = models && options.maxCostUsd !== undefined ? createRunBudget(options.maxCostUsd) : undefined;
    const store = createRecordingStore(options.recordingsDir);
    const output = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
    const log = (line: string) => output(redact.text(line));
    const signal = options.signal ?? new AbortController().signal;
    const startedAt = new Date().toISOString();
    const git = await gitState();
    const manifest = buildManifest({ runId, startedAt, git, mode, models, runBudget, specs, origin, options });
    const translationKeys = options.translationKeys ? new Set(options.translationKeys) : undefined;
    await writeArtifact(join(directory, 'run.json'), manifest, forResults(redact));
    log(`jevwright run ${runId} (${mode}, ${specs.length} tests) → ${relative(process.cwd(), directory)}`);

    const blocked: string[] = [];
    const { browser, close } = await launchBrowser({ allowedOrigins: [origin, ...allowedOrigins], headless: options.headless, onBlocked: url => blocked.push(url) });
    const results: TestResult[] = [];
    const summary = (): RunSummary => ({ manifest, results: [...results], totals: totals(results), directory });
    let reporting = Promise.resolve();
    const publish = () => {
        reporting = reporting.then(() => writeReports(summary(), redact)).catch((error: unknown) => log(`report write failed: ${String(error)}`));
        return reporting;
    };
    try {
        const queue = [...specs];
        const worker = async () => {
            for (let spec = queue.shift(); spec; spec = queue.shift()) {
                if (signal.aborted) {
                    results.push(skipped(spec, 'Run cancelled before this test started'));
                    continue;
                }
                // Not a pass: the run did not test it. Charged to the model budget like a test it stopped mid-way.
                const result = runBudget?.reached() ? notRun(spec, 'model', `Not run: ${runBudgetMessage(runBudget)}`) : await runTest(spec);
                if (!result.attempts.length && result.status === 'failed') { log(`✗ ${spec.id} failed (${result.cause}) — ${result.summary}`); }
                results.push(result);
                options.onResult?.(redact.result(result));
                await publish();
            }
        };
        await Promise.all(Array.from({ length: Math.max(1, Math.min(manifest.concurrency, specs.length)) }, worker));
    } finally {
        await close();
        manifest.finishedAt = new Date().toISOString();
        if (signal.aborted) { manifest.cancelled = true; }
        if (blocked.length) { manifest.blockedRequests = [...new Set(blocked)].slice(0, 50); }
        await writeArtifact(join(directory, 'run.json'), manifest, forResults(redact));
        await publish();
    }
    // Stable order for reports: definition order, not completion order.
    results.sort((a, b) => manifest.tests.indexOf(a.id) - manifest.tests.indexOf(b.id));
    await writeReports(summary(), redact);
    const publicSummary = redact.result(summary());
    artifactDirectories.set(publicSummary, directory);
    return publicSummary;

    async function runTest(spec: TestSpec<unknown>): Promise<TestResult> {
        if (spec.skip) { return skipped(spec, spec.skip); }
        let recording: TestRecording | undefined;
        try {
            recording = await store.load(spec.id, devices.get(spec.id)!.key);
        } catch (error) {
            if (mode !== 'ai') { return notRun(spec, 'environment', `${error instanceof Error ? error.message : String(error)}. Fix or delete the file; the next auto run records the test again`); }
            log(`Ignoring unreadable recording for ${spec.id}; AI mode will record a new path`);
        }
        const attempts: AttemptResult[] = [];
        let recordingUpdated = false;
        let freshUsed = false;
        let freshRetrySkipped: string | undefined;
        let rerouted: { steps: number[] } | undefined;
        const maxAttempts = 1 + Math.max(0, manifest.retries);
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            if (signal.aborted) { break; }
            const previous = attempts.at(-1);
            const canFresh = mode === 'auto' && !freshUsed && previous?.cause === 'product' && previous.steps.some(step => step.source === 'replay');
            const affordable = !runBudget || runBudget.remaining() >= runBudget.capUsd * 0.2;
            if (canFresh && !affordable) { freshRetrySkipped = 'fresh retry skipped: run budget'; }
            const fresh = mode === 'ai' || (canFresh && affordable);
            if (fresh && mode === 'auto') { freshUsed = true; }
            const { result, saved, changed } = await runAttempt(spec, recording, attempt, fresh);
            if (fresh && mode === 'auto' && result.status === 'passed' && changed.length) { rerouted = { steps: changed.map(index => index + 1) }; }
            attempts.push(result);
            recordingUpdated ||= saved;
            if (isFinalAttempt(result, spec, runBudget)) { break; }
        }
        // Cancelled while the recording loaded, before any attempt started.
        if (!attempts.length) { return skipped(spec, 'Run cancelled before this test started'); }
        const result = testResult(spec, attempts, recordingUpdated);
        if (rerouted) { result.rerouted = rerouted; result.summary += `; attempt ${attempts.length} took a different path at step ${rerouted.steps.join(', ')}${recordingUpdated ? '; the recording was updated' : '; recording updates were disabled'}`; }
        if (freshRetrySkipped) { result.freshRetrySkipped = freshRetrySkipped; result.summary += `; ${freshRetrySkipped}`; }
        return result;
    }

    /** One logged attempt; whatever it learned (AI or healed steps) is saved to the recording. */
    async function runAttempt(spec: TestSpec<unknown>, recording: TestRecording | undefined, attempt: number, fresh: boolean): Promise<{ result: AttemptResult; saved: boolean; changed: number[] }> {
        log(`▶ ${spec.id}${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
        const { result, recording: steps, recordedSteps } = await runTestAttempt(spec, {
            browser,
            redact,
            origin,
            allowedOrigins,
            env: options.env,
            runId,
            directory,
            attempt,
            signal,
            models,
            runBudget,
            recording,
            fresh,
            probe: options.probe,
            dryRun: options.dryRun,
            translationKeys,
            viewport: options.viewport,
            device: devices.get(spec.id),
            files: files.get(spec.id),
            locale: options.locale,
            timezone: options.timezone,
            failOnIssues: options.failOnIssues,
            log: line => log(`[${spec.id}] ${line}`),
        });
        log(`${result.status === 'passed' ? '✓' : '✗'} ${spec.id} ${result.status}${result.cause ? ` (${result.cause})` : ''} ${(result.durationMs / 1000).toFixed(1)}s — ${result.summary}`);
        // Step indices, not recording positions: unrecorded steps leave gaps in the recording.
        const changed = steps ? changedActionSteps(recording, steps).map(position => recordedSteps![position]!) : [];
        const learned = steps && (learnedRecording(recording, steps) || recording?.steps.some(entry => redact.contains(JSON.stringify(entry))));
        const keep = options.updateRecordings ?? mode !== 'replay';
        if (!steps || !learned || options.dryRun || !keep || !store.enabled) { return { result, saved: false, changed }; }
        await store.save({ version: 1, test: spec.id, updatedAt: new Date().toISOString(), steps }, devices.get(spec.id)!.key);
        return { result, saved: true, changed };
    }
}

/** A test's outcome over its attempts (at least one). */
function testResult(spec: TestSpec<unknown>, attempts: AttemptResult[], recordingUpdated: boolean): TestResult {
    const last = attempts.at(-1)!;
    const failures = attempts.filter(attempt => attempt.status === 'failed' && !isCancelled(attempt));
    const status = finalStatus(last, failures, spec);
    const lastFailure = failures.at(-1) ?? last;
    const attributed = lastFailure.fresh && lastFailure.cause === 'agent'
        ? failures.findLast(attempt => !attempt.fresh && attempt.steps.some(step => step.source === 'replay')) ?? lastFailure
        : lastFailure;
    const usage = emptyUsage();
    for (const attempt of attempts) { addUsage(usage, attempt.models); }
    return {
        id: spec.id,
        selectionKey: testSelectionKey(spec.id),
        module: spec.module,
        title: spec.title,
        risk: spec.risk,
        tags: spec.tags ?? [],
        status,
        ...(status === 'passed' || status === 'skipped' ? {} : { cause: attributed.cause }),
        ...(status === 'skipped' ? { skipReason: last.summary } : {}),
        summary: status === 'flaky' ? `Passed on attempt ${attempts.length} after: ${failures[0]!.summary}` : last.summary,
        ...(failures.length ? { reproduced: `${failures.length}/${attempts.length}` } : {}),
        attempts,
        issues: mergeIssues(attempts.flatMap(attempt => attempt.issues)),
        models: usage,
        durationMs: attempts.reduce((sum, attempt) => sum + attempt.durationMs, 0),
        recordingUpdated,
        ...(spec.knownIssue ? { knownIssue: spec.knownIssue } : {}),
    };
}

/** Stopped by Ctrl-C: not a failure of the test, so it never counts as a flaky retry. */
function isCancelled(attempt: AttemptResult): boolean {
    return attempt.cancelled === true;
}

/** True once another attempt cannot change the outcome, so the retry loop should stop. */
function isFinalAttempt(result: AttemptResult, spec: TestSpec<unknown>, runBudget: RunBudget | undefined): boolean {
    if (result.status === 'passed') { return true; }
    // A known defect that reproduces needs no retry to prove it.
    if (spec.knownIssue && result.cause === 'product') { return true; }
    // Stopped by Ctrl-C; another attempt would be cancelled too.
    if (isCancelled(result)) { return true; }
    // Replay cannot run a step it has no recording for, however often it tries.
    if (result.steps.some(step => step.failure === 'not-recorded')) { return true; }
    // The run budget will not un-reach itself; retrying would just fail the same way again.
    return result.cause === 'model' && !!runBudget?.reached();
}

/** A test's overall status from its last attempt and how many attempts before it failed. */
function finalStatus(last: AttemptResult, failures: AttemptResult[], spec: TestSpec<unknown>): TestStatus {
    // Stopped by Ctrl-C: nothing was learned about the app.
    if (isCancelled(last)) { return 'skipped'; }
    if (last.status === 'passed') { return failures.length ? 'flaky' : 'passed'; }
    return spec.knownIssue && last.cause === 'product' ? 'known' : 'failed';
}

interface BuildManifestArgs {
    runId: string;
    startedAt: string;
    git: RunManifest['git'];
    mode: RunMode;
    models: SuiteOptions['models'];
    runBudget: RunBudget | undefined;
    specs: ReadonlyArray<TestSpec<unknown>>;
    origin: string;
    options: SuiteOptions;
}

function buildManifest({ runId, startedAt, git, mode, models, runBudget, specs, origin, options }: BuildManifestArgs): RunManifest {
    return {
        runId,
        engine: `jevwright/${VERSION}`,
        startedAt,
        git,
        mode,
        models: models ? modelIds(models) : null,
        origin,
        concurrency: options.concurrency ?? 2,
        // A dry run checks fixtures and start pages; a retry would only hide a flaky fixture.
        retries: options.dryRun ? 0 : options.retries ?? 1,
        ...(options.dryRun ? { dryRun: true } : {}),
        ...(runBudget ? { maxCostUsd: runBudget.capUsd } : {}),
        tests: specs.map(spec => spec.id),
        ...(options.command ? { command: options.command } : {}),
        ...(options.metadata ? { metadata: options.metadata } : {}),
    };
}

function skipped(spec: TestSpec<unknown>, reason: string): TestResult {
    return { ...unrun(spec), status: 'skipped', summary: reason, skipReason: reason };
}

/** A test that could not start: it fails the run, with the cause that stopped it. */
function notRun(spec: TestSpec<unknown>, cause: Cause, summary: string): TestResult {
    return { ...unrun(spec), status: 'failed', cause, summary };
}

function unrun(spec: TestSpec<unknown>): Omit<TestResult, 'status' | 'summary'> {
    return { id: spec.id, selectionKey: testSelectionKey(spec.id), module: spec.module, title: spec.title, risk: spec.risk, tags: spec.tags ?? [], attempts: [], issues: [], models: emptyUsage(), durationMs: 0, recordingUpdated: false };
}

function mergeIssues(issues: Issue[]): Issue[] {
    const merged = new Map<string, Issue>();
    for (const issue of issues) {
        const key = `${issue.kind}|${issue.message}`;
        const existing = merged.get(key);
        if (existing) { existing.count += issue.count; } else { merged.set(key, { ...issue }); }
    }
    return [...merged.values()];
}

function totals(results: TestResult[]): RunSummary['totals'] {
    const usage = emptyUsage();
    for (const result of results) { addUsage(usage, result.models); }
    return {
        tests: results.length,
        passed: results.filter(result => result.status === 'passed').length,
        failed: results.filter(result => result.status === 'failed').length,
        flaky: results.filter(result => result.status === 'flaky').length,
        known: results.filter(result => result.status === 'known').length,
        skipped: results.filter(result => result.status === 'skipped').length,
        issues: results.reduce((sum, result) => sum + result.issues.length, 0),
        models: usage,
        durationMs: results.reduce((sum, result) => sum + result.durationMs, 0),
    };
}

async function gitState(): Promise<RunManifest['git']> {
    const run = promisify(execFile);
    try {
        const sha = (await run('git', ['rev-parse', 'HEAD'])).stdout.trim();
        const dirty = (await run('git', ['status', '--porcelain', '--untracked-files=no'])).stdout.trim().length > 0;
        return { sha, dirty };
    } catch {
        return null;
    }
}

/** Internal consumers write with the physical path, never a redacted display value. */
export function artifactDirectory(summary: RunSummary): string { return artifactDirectories.get(summary) ?? summary.directory; }
