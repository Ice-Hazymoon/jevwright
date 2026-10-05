import type { ActFailure, ActionRecord, Round } from './act.ts';
import type { EndCheck } from './end-state.ts';
import type { ModelCall, Models, ModelSettings, ModelUsage, RunBudget } from './models.ts';
import type { Issue } from './monitor.ts';
import type { RecordedAction, StepRecording, TestRecording } from './recording.ts';
import type { Redactor } from './secrets.ts';
import type { CheckOutcome, Env, FixtureContext, MaybePromise, RunContext, Step, TestSpec, Values, WriteRecord } from './spec.ts';
import type { Browser, Page } from 'playwright';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { AssertionError } from 'node:assert';
import { pageState, runAct } from './act.ts';
import { redactTrace, writeArtifact } from './artifacts.ts';
import { newTestContext, settle } from './browser.ts';
import { createDownloads } from './downloads.ts';
import { JevwrightError } from './errors.ts';
import { secretSurface } from './dom.ts';
import { actedOnTarget, adjudicateClaim, checkEvidenceMatches, judgeClaim, replayableCheckClaim, replayableCheckEvidence } from './judge.ts';
import { createModels, emptyUsage, ModelError } from './models.ts';
import { createMonitor } from './monitor.ts';
import { observe, shortUrl } from './observe.ts';
import { findStepRecording, stepKey } from './recording.ts';
import { createRedactor, forResults, reveal, secretPurpose } from './secrets.ts';
import { secretCheckProblems } from './select.ts';
import { describeStep, fillTemplate, templateKeys, writeRules } from './spec.ts';

export type StepStatus = 'passed' | 'failed' | 'skipped' | 'unverified' | 'interrupted';
export type StepFailure = ActFailure | 'assertion' | 'invariant' | 'exception' | 'blocking-issue' | 'not-recorded' | 'not-shown' | 'timeout';

export interface StepResult {
    index: number;
    kind: Step['kind'];
    label: string;
    status: StepStatus;
    /** How an act step was resolved: recorded path, fresh AI grounding, or AI after a stale recording. */
    source?: 'replay' | 'ai' | 'healed' | 'code';
    likely?: boolean;
    durationMs: number;
    url: string;
    actions?: ActionRecord[];
    rounds?: Round[];
    writes: WriteRecord[];
    downloads?: import('./spec.ts').DownloadRecord[];
    evidence?: unknown;
    error?: string;
    failure?: StepFailure;
    /** Why a product-looking failure here was attributed to the agent instead. */
    misstep?: string;
    replayMiss?: string;
    end?: EndCheck;
    endMismatch?: true;
    replayOnTarget?: true;
    screenshot?: string;
    notRecorded?: string;
    /** What kept the page from settling when a wait hit its cap (slow-step diagnostics). */
    busy?: string[];
    /** File in the attempt directory with the page state a check judged. */
    observation?: string;
}

export type Cause = 'product' | 'agent' | 'environment' | 'model' | 'timeout';

const STEP_MARK: Record<StepStatus, string> = { passed: '✓', failed: '✗', skipped: '–', unverified: '?', interrupted: '⏹' };

/**
 * Who a blocking issue is charged to. The app failing to download its own code, or not answering at all, is the
 * environment's; the rest the product's.
 */
const issueCause = (issue: Issue): Cause => issue.kind === 'asset-load' || issue.kind === 'app-unreachable' ? 'environment' : 'product';

export interface InvariantResult {
    name: string;
    step: number;
    passed: boolean;
    evidence?: unknown;
}

export interface AttemptResult {
    id: string;
    attempt: number;
    fresh?: true;
    status: 'passed' | 'failed' | 'unverified' | 'interrupted';
    /** Stopped by Ctrl-C; no conclusion about the product. */
    cancelled?: true;
    cause?: Cause;
    summary: string;
    failedStep?: number;
    steps: StepResult[];
    issues: Issue[];
    invariants: InvariantResult[];
    durationMs: number;
    models: ModelUsage;
    modelCalls: ModelCall[];
    recording: { total: number; replayed: number; healed: number; ai: number };
    directory: string;
    trace?: string;
    screenshotsWithheld?: true;
    traceWithheld?: true;
    events: string[];
}

export interface AttemptOptions {
    browser: Browser;
    redact?: Redactor;
    origin: string;
    /** Further origins of the app, monitored like `origin`. */
    allowedOrigins?: readonly string[];
    env?: Env;
    runId: string;
    directory: string;
    attempt: number;
    signal: AbortSignal;
    models?: ModelSettings;
    /** Shared across every concurrently running attempt in the run; checked ahead of the per-attempt call cap. */
    runBudget?: RunBudget;
    recording?: TestRecording;
    /** Omit replay-proof selection when this attempt cannot persist it; verdict evidence remains. */
    collectCheckEvidence?: boolean;
    /** Ignore recordings and ground every step with the model. */
    fresh?: boolean;
    probe?: boolean;
    /** Stop after fixture, start page and initial invariants; saves the start observation. */
    dryRun?: boolean;
    translationKeys?: ReadonlySet<string>;
    device?: import('./devices.ts').ResolvedDevice;
    files?: Record<string, import('./files.ts').ResolvedFile>;
    viewport?: { width: number; height: number };
    locale?: string;
    timezone?: string;
    /** Fail the test on a high-severity issue (uncaught page error, 5xx, error screen). Default true. */
    failOnIssues?: boolean;
    log: (line: string) => void;
}

/** Below this, Jev judges an AI-driven step to have acted on something other than what it names. */
const MISSTEP = 0.25;

/** One attempt of one test. Never throws for product/agent failures; the result carries them. */
export async function runTestAttempt<F>(spec: TestSpec<F>, options: AttemptOptions): Promise<{ result: AttemptResult; recording?: StepRecording[]; recordedSteps?: number[] }> {
    const started = performance.now();
    const directory = join(options.directory, spec.id, `attempt-${options.attempt}`);
    await mkdir(directory, { recursive: true });
    const steps: StepResult[] = [];
    const invariants: InvariantResult[] = [];
    const events: string[] = [];
    const cleanups: Array<() => MaybePromise<void>> = [];
    const secrets = spec.secrets ?? {};
    const redact = options.redact ?? createRedactor(Object.values(secrets));
    const log = (line: string) => options.log(redact.text(line));
    let screenshotsWithheld = Object.keys(secrets).length > 0;
    let traceWithheld = false;
    /** Cleanup closes every page; those closes are not the app closing a tab. */
    let closing = false;
    /** A step screenshot skipped because the page showed a secret declared elsewhere in the run. */
    let secretShown = false;
    const models: Models | undefined = options.models ? createModels(options.models, options.runBudget, redact) : undefined;
    const timeout = AbortSignal.timeout(spec.timeoutMs ?? 240_000);
    const signal = AbortSignal.any([options.signal, timeout]);
    const data: Values = spec.data ?? {};
    const displayData = { ...data, ...Object.fromEntries(Object.entries(options.files ?? {}).map(([key, file]) => [key, file.name])) };
    const values = { ...data, ...Object.fromEntries(Object.entries(secrets).map(([key, handle]) => [key, reveal(handle)])) };
    const secretKeys = new Set(Object.keys(secrets));
    const viewport = options.viewport ?? { width: 1280, height: 900 };
    const newRecording: StepRecording[] = [];
    /** Step index of each `newRecording` entry; unrecorded steps would otherwise shift positions. */
    const recordedSteps: number[] = [];
    const pendingEnds: Array<{ entry: StepRecording; index: number; end: NonNullable<StepRecording['end']> }> = [];
    const deterministicChecks: number[] = [];
    const occurrences = new Map<string, number>();
    const keysByIndex = new Map<number, { key: string; occurrence: number }>();
    const counts = { total: 0, replayed: 0, healed: 0, ai: 0 };
    let page: Page | undefined;
    let trace: string | undefined;
    let cause: Cause | undefined;
    let summary = 'All steps passed';
    let failedStep: number | undefined;

    const downloads = createDownloads(directory, signal, redact);
    let acceptDownloads = true;
    try { acceptDownloads = !!spec.fixture || spec.steps(undefined as F).some(step => step.kind === 'act' && !!step.expect?.download); } catch { /* Fixture-dependent declarations are known after fixture setup. */ }
    const context = await newTestContext(options.browser, { viewport, device: options.device, acceptDownloads, onDownload: downloads.receive, baseURL: options.origin, locale: options.locale, timezone: options.timezone, dialogs: spec.dialogs ?? 'accept', onDialog: detail => events.push(`dialog ${detail}`) });
    cleanups.push(async () => context.close());
    const monitor = createMonitor(context, { redact, origin: options.origin, allowedOrigins: options.allowedOrigins, expectedHttp: spec.expectedHttp, ignoreConsole: spec.ignoreConsole, i18nKeys: options.translationKeys, expectedAborts: spec.expectedAborts });
    // Another test's secret can appear on this page too, and trace frames cannot be redacted afterwards.
    await context.tracing.start({ screenshots: !redact.active, snapshots: true, title: spec.id }).catch(() => undefined);
    const openedPages: Page[] = [];
    context.on('page', (opened) => {
        openedPages.push(opened);
        opened.on('close', () => {
            if (closing) { return; }
            events.push('tab closed');
            if (page === opened) { page = openedPages.findLast(candidate => !candidate.isClosed()); }
        });
        if (page && opened !== page) {
            events.push(`new tab opened: ${shortUrl(opened.url())}`);
            page = opened;
        }
    });

    let fixture: F | undefined;
    let nextAct: (index: number) => string | undefined = () => undefined;
    const runContext = (stepIndex: number): RunContext<F> => ({
        get page() { return page!; },
        context,
        fixture: fixture as F,
        data,
        secrets,
        origin: options.origin,
        env: options.env as Env,
        signal,
        writes: monitor.writes,
        downloads: downloads.records,
        step: stepIndex,
    });

    try {
        const fixtureContext: FixtureContext = { browser: options.browser, context, origin: options.origin, env: options.env as Env, signal, runId: options.runId, defer: cleanup => cleanups.push(cleanup) };
        try {
            fixture = spec.fixture ? await spec.fixture(fixtureContext) : undefined as F;
        } catch (error) {
            throw new AttemptError('environment', `Fixture setup failed: ${message(error)}`);
        }
        page = await context.newPage();
        monitor.setStep(-1);
        try {
            await page.goto(new URL(spec.start, options.origin).toString(), { waitUntil: 'domcontentloaded', timeout: 60_000 });
            if (spec.ready) { await spec.ready(runContext(-1)); }
            await settle(page, monitor);
        } catch (error) {
            throw new AttemptError('environment', `Start page did not become ready: ${message(error)}`);
        }
        await monitor.scanText(page);
        const loadIssue = monitor.issues().find(issue => issue.severity === 'high');
        if (loadIssue && options.failOnIssues !== false) {
            throw new AttemptError(issueCause(loadIssue), `${loadIssue.kind} while loading ${spec.start}: ${loadIssue.message}`);
        }
        for (const invariant of spec.invariants ?? []) {
            const outcome = await evaluateCheck(() => invariant.check(runContext(-1)));
            invariants.push({ name: invariant.name, step: -1, passed: outcome.passed, evidence: outcome.evidence });
            if (!outcome.passed) { throw new AttemptError('environment', `Invariant "${invariant.name}" does not hold before the test starts`); }
        }

        const definition = spec.steps(fixture as F);
        for (const [index, step] of definition.entries()) {
            if (step.kind !== 'act' && step.kind !== 'check') { continue; }
            const identity = step.kind === 'act' ? step : { instruction: `check:${step.assertion}` };
            const base = stepKey(identity);
            const occurrence = (occurrences.get(base) ?? 0) + 1;
            occurrences.set(base, occurrence);
            keysByIndex.set(index, { key: stepKey(identity, occurrence), occurrence });
        }
        const secretProblems = secretCheckProblems(definition, secrets);
        if (secretProblems.length) { throw new JevwrightError(secretProblems.join('; ')); }
        for (const [index, step] of definition.entries()) {
            if (step.kind === 'act' && step.expectError) { monitor.expectDuring(index, writeRules(step.expect)); }
        }
        if (options.dryRun) {
            const observation = await observe(page, { redact });
            // The signature hashes raw page content; beside redacted text it would allow guessing a short secret.
            const { signature, ...withoutSignature } = observation;
            await writeArtifact(join(directory, 'start-observation.json'), redact.active ? withoutSignature : { ...withoutSignature, signature }, redact);
            if (!screenshotsWithheld && !await showsSecret(page, redact)) { await page.screenshot({ path: join(directory, 'start.jpg'), type: 'jpeg', quality: 60 }).catch(() => undefined); }
            summary = `Dry run: fixture, start page and ${spec.invariants?.length ?? 0} invariant(s) OK; ${definition.length} steps not run`;
            throw new DryRunComplete();
        }
        nextAct = (index: number) => {
            const following = definition[index + 1];
            return following?.kind === 'act' ? describeStep(following as Step<unknown>, displayData, secrets) : undefined;
        };
        /** A product-looking failure after AI-driven steps: the agent's, when a step acted on something it did not name. */
        const misstep = async (upTo: number): Promise<string | undefined> => {
            const acts = steps.filter(entry => entry.index <= upTo && entry.kind === 'act' && (entry.source === 'ai' || entry.source === 'healed') && entry.actions?.some(action => action.ok));
            if (!models || !acts.length) { return undefined; }
            const done = (entry: StepResult) => entry.actions!.filter(action => action.ok);
            const history = (entry: StepResult) => done(entry).map(action => ({ action: action.tool, ...(action.element ? { element: action.element } : {}), ...(action.value ? { value: action.value } : {}) }));
            const verdicts = await actedOnTarget(models, acts.map(entry => ({ step: entry.label, history: history(entry), next_step: nextAct(entry.index) ?? null })), signal).catch(() => undefined);
            const miss = verdicts?.findIndex(p => p < MISSTEP) ?? -1;
            if (!verdicts || miss < 0) { return undefined; }
            const entry = acts[miss]!;
            const touched = [...new Set(done(entry).flatMap(action => action.element ? [action.element] : []))].join(', ');
            return `step ${entry.index + 1} (${entry.label}) acted on ${touched}, which Jev judged not to be what the step names (p=${verdicts[miss]!.toFixed(2)})`;
        };
        let previousLabel: string | undefined;
        for (const [index, step] of definition.entries()) {
            signal.throwIfAborted();
            monitor.setStep(index);
            downloads.setStep(index, step.kind === 'act' ? step.expect?.download : undefined);
            const label = describeStep(step as Step<unknown>, displayData, secrets);
            const stepStarted = performance.now();
            const writesBefore = monitor.writes.length;
            const result: StepResult = { index, kind: step.kind, label, status: 'passed', durationMs: 0, url: shortUrl(page.url()), writes: [] };
            log(`  ${index + 1}. ${label}`);
            try {
                await runStep(step, index, result, previousLabel);
            } catch (error) {
                if (signal.aborted) { throw error; }
                result.status = 'failed';
                // A check or verify that could not get a model answer is a model-service failure, not test code.
                result.failure = error instanceof AttemptError && error.cause === 'timeout' ? 'timeout' : error instanceof ModelError ? 'model' : step.kind === 'verify' && isAssertionError(error) ? 'assertion' : 'exception';
                result.error = message(error);
            }
            await settle(page, monitor, { maxMs: 3000 }).catch(() => 0);
            await monitor.scanText(page);
            await monitor.flushEvidence();
            result.url = shortUrl(page.url());
            await downloads.flush();
            if (step.kind === 'act' && step.expect?.download && result.status === 'passed') {
                const state = downloads.state();
                if (!state.ok) { result.status = 'failed'; result.failure = 'expectation'; result.error = state.reason; }
            }
            result.downloads = downloads.forStep(index);
            result.writes = monitor.writes.slice(writesBefore).map(write => ({ ...write }));
            const busy = [...new Set(monitor.settleCaps.filter(cap => cap.step === index).map(cap => cap.reason))];
            if (busy.length) { result.busy = busy.slice(0, 5); }
            result.durationMs = Math.round(performance.now() - stepStarted);
            result.screenshot = screenshotsWithheld || await showsSecret(page, redact) ? undefined : await screenshot(page, directory, index);
            if (!result.screenshot && !screenshotsWithheld && redact.active) { secretShown = true; }
            steps.push(result);
            log(`     ${STEP_MARK[result.status]} ${result.source ? `[${result.source}] ` : ''}${result.durationMs}ms${result.error ? ` — ${result.error}` : ''}`);
            if (result.status === 'failed') {
                failedStep = index;
                ({ cause, summary } = attribute(result));
                const blocking = options.failOnIssues !== false && result.failure === 'error-shown' ? monitor.issues().find(issue => issue.severity === 'high' && issue.step === index) : undefined;
                if (blocking) { cause = issueCause(blocking); summary = `${blocking.kind} during step ${index + 1}: ${blocking.message}`; }
                if (cause === 'product' && result.failure === 'assertion') {
                    result.misstep = await misstep(index);
                    if (result.misstep) {
                        cause = 'agent';
                        summary = `${summary}. Not counted against the product: ${result.misstep}`;
                    }
                }
                if (cause === 'agent' && result.failure !== 'error-shown' && !result.misstep && !(step.kind === 'act' && step.expectError)) {
                    const server = monitor.issues().find(issue => issue.step === index && issue.kind === 'http-5xx');
                    const rejected = result.writes.find(write => write.validationError);
                    if (server || rejected) {
                        result.misstep = await misstep(index);
                        if (result.misstep) { summary += `. Not counted against the product: ${result.misstep}`; }
                        else if (server) { cause = 'product'; summary += `. Request evidence: ${server.message}`; }
                        else if (rejected) { cause = 'product'; summary += `. Request evidence: ${rejected.method} ${rejected.path} → ${rejected.status}: ${rejected.validationError}`; }
                    }
                }
                break;
            }
            // Invariants after every step: a violation is a finding, whatever the step did.
            for (const invariant of spec.invariants ?? []) {
                const outcome = await evaluateCheck(() => invariant.check(runContext(index)));
                if (!outcome.passed || index === definition.length - 1) { invariants.push({ name: invariant.name, step: index, passed: outcome.passed, evidence: outcome.evidence }); }
                if (!outcome.passed) {
                    failedStep = index;
                    cause = 'product';
                    summary = `Invariant "${invariant.name}" broke after step ${index + 1}`;
                    result.status = 'failed';
                    result.failure = 'invariant';
                    result.error = summary;
                    result.misstep = await misstep(index);
                    if (result.misstep) {
                        cause = 'agent';
                        summary = `${summary}. Not counted against the product: ${result.misstep}`;
                    }
                    break;
                }
            }
            if (result.status === 'failed') { break; }
            const blocking = monitor.issues().filter(issue => issue.severity === 'high' && issue.step === index);
            if (options.failOnIssues !== false && blocking.length) {
                failedStep = index;
                cause = issueCause(blocking[0]!);
                summary = `${blocking[0]!.kind} during step ${index + 1}: ${blocking[0]!.message}`;
                result.status = 'failed';
                result.failure = 'blocking-issue';
                result.error = summary;
                break;
            }
            if (result.status === 'passed' && (step.kind === 'verify' || step.kind === 'check' || (step.kind === 'act' && (step.expect?.write || step.expect?.url || step.expect?.download)))) { deterministicChecks.push(index); }
            previousLabel = label;
        }
    } catch (error) {
        if (error instanceof JevwrightError) { throw error; }
        if (error instanceof DryRunComplete) {
            // Not a failure: the requested part of the test ran.
        } else if (error instanceof AttemptError) {
            cause = error.cause;
            summary = error.message;
        } else if (timeout.aborted) {
            cause = 'timeout';
            summary = `Test exceeded ${Math.round((spec.timeoutMs ?? 240_000) / 1000)}s`;
        } else if (options.signal.aborted) {
            cause = 'environment';
            summary = 'Run cancelled';
        } else {
            cause = 'environment';
            summary = `Runner error: ${message(error)}`;
        }
        failedStep ??= steps.length;
    } finally {
        trace = join(directory, 'trace.zip');
        await context.tracing.stop({ path: trace }).catch(async () => {
            await rm(trace!, { force: true });
            trace = undefined;
            if (redact.active) { traceWithheld = true; }
        });
        if (trace && redact.active && !await redactTrace(trace, redact)) { trace = undefined; traceWithheld = true; }
        closing = true;
        for (const cleanup of cleanups.reverse()) {
            await Promise.race([Promise.resolve().then(cleanup), new Promise(resolve => setTimeout(resolve, 5000))]).catch((error: unknown) => events.push(`cleanup failed: ${message(error)}`));
        }
        await downloads.close();
    }

    // Stopped by Ctrl-C: whatever the attempt ran into while stopping says nothing about the app.
    const cancelled = Boolean(cause) && options.signal.aborted;
    if (cancelled) {
        cause = 'environment';
        if (summary !== 'Run cancelled') { summary = `Run cancelled (${summary})`; }
    }
    const status = cancelled ? 'interrupted' : cause ? 'failed' : steps.some(step => step.status === 'unverified') ? 'unverified' : 'passed';
    if (status === 'unverified') { summary = `${steps.filter(step => step.status === 'unverified').length} check(s) lack replayable evidence`; }
    if (status === 'passed' || status === 'failed') {
        for (const pending of pendingEnds) {
            if (deterministicChecks.some(index => index > pending.index)) { pending.entry.end = pending.end; }
        }
    }
    const mismatches = steps.filter(step => step.endMismatch || (step.source === 'replay' && step.failure === 'expectation'));
    if (mismatches.length) {
        summary += `. ${mismatches.map(step => `step ${step.index + 1}'s replay missed its recorded end state`).join('; ')}; ${status === 'passed' ? 'refresh the recording with an auto run' : 'confirm with an auto run'}`;
    }
    const result: AttemptResult = {
        id: spec.id,
        attempt: options.attempt,
        ...(options.fresh ? { fresh: true as const } : {}),
        status,
        ...(cancelled ? { cancelled: true } : {}),
        ...(cause ? { cause } : {}),
        summary,
        ...(failedStep !== undefined ? { failedStep } : {}),
        steps,
        issues: monitor.issues(),
        invariants,
        durationMs: Math.round(performance.now() - started),
        models: models?.usage ?? emptyUsage(),
        modelCalls: models?.calls ?? [],
        recording: counts,
        directory,
        ...(trace ? { trace } : {}),
        events,
        ...(screenshotsWithheld || secretShown ? { screenshotsWithheld: true } : {}),
        ...(traceWithheld ? { traceWithheld: true } : {}),
    };
    await writeArtifact(join(directory, 'result.json'), result, forResults(redact));
    const verified = newRecording.flatMap((entry, position) => status === 'passed' || (status === 'failed' && deterministicChecks.some(index => index >= recordedSteps[position]!) && recordedSteps[position]! < (failedStep ?? Infinity)) ? [{ entry, index: recordedSteps[position]! }] : []);
    return { result, ...((status === 'passed' && (counts.total || newRecording.length)) || verified.length ? { recording: verified.map(item => item.entry), recordedSteps: verified.map(item => item.index) } : {}) };

    async function runStep(step: Step<F>, index: number, result: StepResult, previousLabel: string | undefined): Promise<void> {
        switch (step.kind) {
            case 'act': {
                const keys = templateKeys(step.instruction);
                const stepValues = Object.fromEntries(keys.filter(key => Object.hasOwn(values, key)).map(key => [key, values[key]!]));
                const { key, occurrence } = keysByIndex.get(index)!;
                const recorded = options.fresh ? undefined : options.recording && findStepRecording(options.recording.steps, step, occurrence);
                if (!models && recorded === undefined) {
                    // Replay has no model to fall back on. A new test, or a step reworded since it was recorded.
                    result.status = 'failed';
                    result.failure = 'not-recorded';
                    result.error = 'this step has no recording; record it with an auto run (or --new for a new test)';
                    return;
                }
                counts.total++;
                const outcome = await runAct({
                    get page() { return page!; },
                    baseURL: options.origin,
                    files: Object.fromEntries(Object.entries(options.files ?? {}).filter(([key]) => keys.includes(key))),
                    hasTouch: options.device?.hasTouch,
                    downloadState: downloads.state,
                    monitor,
                    models,
                    signal,
                    stepIndex: index,
                    test: spec.title,
                    instruction: fillTemplate(step.instruction, displayData, secrets),
                    values: stepValues,
                    secretKeys,
                    secretPurposes: Object.fromEntries(Object.entries(secrets).map(([key, handle]) => [key, secretPurpose(handle)])),
                    redact,
                    onSecretInput: () => { screenshotsWithheld = true; },
                    previous: previousLabel,
                    next: nextAct(index),
                    expect: step.expect,
                    maxActions: step.maxActions,
                    double: step.double,
                    expectError: step.expectError,
                    recorded,
                    probe: options.probe,
                    events,
                    log,
                });
                counts[outcome.source === 'replay' ? 'replayed' : outcome.source]++;
                result.source = outcome.source;
                result.actions = outcome.actions;
                result.rounds = outcome.rounds;
                result.end = outcome.end;
                if (outcome.endMismatch) { result.endMismatch = true; }
                if (outcome.replayOnTarget) { result.replayOnTarget = true; }
                if (outcome.replayMiss) { result.replayMiss = outcome.replayMiss; }
                if (outcome.status === 'likely-done') { result.likely = true; }
                if (outcome.status === 'failed') {
                    result.status = 'failed';
                    result.failure = outcome.failure;
                    result.error = outcome.reason;
                } else {
                    const entry: StepRecording = { key, occurrence, instruction: step.instruction, actions: outcome.source === 'replay' && recorded ? recorded.actions : outcome.recording as RecordedAction[] };
                    if (outcome.recordedEnd !== undefined) {
                        if (outcome.source === 'replay' && recorded?.end === undefined) { pendingEnds.push({ entry, index, end: outcome.recordedEnd }); } else { entry.end = outcome.recordedEnd; }
                    }
                    if (outcome.discardRecording) {
                        result.notRecorded = 'not recorded: the replayed path missed its end state; the next auto run grounds the step from its start';
                    } else if (redact.contains(JSON.stringify(entry))) {
                        result.notRecorded = 'not recorded: target text contains a secret';
                    } else {
                        newRecording.push(entry);
                        recordedSteps.push(index);
                    }
                }
                if (outcome.rounds.some(round => (round.anomaly ?? 0) >= 0.8)) {
                    monitor.report({ kind: 'semantic', severity: 'low', message: `Jev flagged broken-looking content on ${shortUrl(page!.url())}` });
                }
                return;
            }
            case 'check': {
                const { key, occurrence } = keysByIndex.get(index)!;
                const claim = fillTemplate(step.assertion, displayData);
                const observeReady = async () => {
                    let observed = await observe(page!, { redact });
                    const deadline = Date.now() + 15000;
                    while (observed.busy && Date.now() < deadline) {
                        signal.throwIfAborted();
                        await settle(page!, monitor, { maxMs: Math.min(8000, deadline - Date.now()) });
                        observed = await observe(page!, { redact });
                    }
                    if (observed.busy) { throw new AttemptError('timeout', `Visible content remained loading before checking: ${claim}`); }
                    return observed;
                };
                if (!models) {
                    result.source = 'replay';
                    const recorded = options.recording && findStepRecording(options.recording.steps, { instruction: `check:${step.assertion}` }, occurrence);
                    if (!replayableCheckClaim(claim) || !recorded?.checkEvidence?.length || !replayableCheckEvidence(recorded.checkEvidence) || recorded.checkClaim !== claim || step.reference) {
                        result.status = 'unverified';
                        result.error = 'Check has no directly recheckable evidence for this claim; record it with an auto run';
                    } else {
                        let observed = await observeReady();
                        if (!checkEvidenceMatches(recorded.checkEvidence, observed)) {
                            // An exiting dialog can outlive the action in the accessibility snapshot, as in auto checks.
                            await page!.waitForTimeout(1500);
                            await settle(page!, monitor);
                            observed = await observeReady();
                        }
                        result.evidence = { claim, checked: recorded.checkEvidence };
                        result.observation = `step-${String(index + 1).padStart(2, '0')}-observation.json`;
                        await writeArtifact(join(directory, result.observation), pageState(observed), redact);
                        if (!checkEvidenceMatches(recorded.checkEvidence, observed)) {
                            result.status = 'failed'; result.failure = 'assertion'; result.error = `Recorded check evidence is no longer visible: ${claim}`;
                        }
                    }
                    return;
                }
                result.source = 'ai';
                const reference = step.reference ? await step.reference(runContext(index)) : undefined;
                const priorActions = steps.filter(entry => entry.kind === 'act' && entry.status === 'passed' && entry.actions?.some(action => action.ok)).slice(-3).map(entry => ({ step: entry.label, history: entry.actions!.filter(action => action.ok).slice(-12).map(action => ({ action: action.tool, ...(action.element ? { element: action.element } : {}), ...(action.destination ? { destination: action.destination } : {}) })) }));
                let observed = await observeReady();
                let verdict = await judgeClaim(models, observed, claim, reference, signal, priorActions, options.collectCheckEvidence);
                const attempts: unknown[] = [verdict];
                if (!verdict.passed || verdict.uncertain) {
                    // A second look after the page settles; UI updates can trail the data.
                    await page!.waitForTimeout(1500);
                    await settle(page!, monitor);
                    const next = await observeReady();
                    if (next.signature !== observed.signature) {
                        observed = next;
                        verdict = await judgeClaim(models, observed, claim, reference, signal, priorActions, options.collectCheckEvidence);
                        attempts.push(verdict);
                    }
                }
                if (verdict.uncertain) {
                    observed = await observeReady();
                    const tie = await adjudicateClaim(models, observed, claim, reference, signal, priorActions);
                    attempts.push({ adjudicated: tie });
                    verdict = { ...verdict, evidence: undefined, passed: tie.passed, support: tie.support, note: tie.reason, ...(tie.region ? { region: tie.region, pRegion: 1 } : {}) };
                }
                // Exactly what the claim was judged against, so a verdict can be audited without re-running.
                result.observation = `step-${String(index + 1).padStart(2, '0')}-observation.json`;
                await writeArtifact(join(directory, result.observation), pageState(observed), redact);
                result.evidence = { claim, ...(reference !== undefined ? { reference } : {}), ...(priorActions.length ? { prior_actions: priorActions } : {}), verdicts: attempts };
                if (!verdict.passed) {
                    result.status = 'failed';
                    const openMissing = verdict.support === 'not_shown' && verdict.region === 'open' && verdict.pRegion >= 0.7;
                    result.failure = verdict.support === 'contradicts' || openMissing ? 'assertion' : 'not-shown';
                    const location = verdict.support === 'contradicts' ? 'Visible evidence contradicts the claim' : verdict.region === 'closed' ? 'Relevant region is not open in the current view' : openMissing ? 'Expected content is missing from the open visible region' : 'Claim not shown on the page';
                    result.error = `${location}: ${claim} (holds=${verdict.holds}, ${verdict.support} ${verdict.pSupport}, region=${verdict.region})`;
                } else {
                    const evidence = verdict.evidence?.filter(entry => !redact.contains(JSON.stringify(entry)) && !JSON.stringify(entry).includes('{secret}'));
                    const entry: StepRecording = { key, occurrence, instruction: step.assertion, actions: [], checkClaim: claim, ...(evidence?.length && !step.reference ? { checkEvidence: evidence } : {}) };
                    if (!redact.contains(JSON.stringify(entry))) { newRecording.push(entry); recordedSteps.push(index); }
                }
                return;
            }
            case 'verify': {
                result.source = 'code';
                const deadline = Date.now() + (step.timeoutMs ?? 8000);
                let outcome: { passed: boolean; evidence?: unknown };
                for (;;) {
                    outcome = normalize(await step.check(runContext(index)));
                    if (outcome.passed || Date.now() >= deadline) { break; }
                    await new Promise(resolve => setTimeout(resolve, 300));
                }
                result.evidence = outcome.evidence;
                if (!outcome.passed) {
                    result.status = 'failed';
                    result.failure = 'assertion';
                    result.error = `Verification "${step.name}" failed`;
                }
                return;
            }
            case 'run':
                result.source = 'code';
                await step.run(runContext(index));
                return;
            case 'goto':
                result.source = 'code';
                await page!.goto(new URL(step.path, options.origin).toString(), { waitUntil: 'domcontentloaded' });
                if (spec.ready) { await spec.ready(runContext(index)); }
                return;
            case 'reload':
                result.source = 'code';
                await page!.reload({ waitUntil: 'domcontentloaded' });
                if (spec.ready) { await spec.ready(runContext(index)); }
                return;
            case 'back':
                result.source = 'code';
                await page!.goBack({ waitUntil: 'domcontentloaded' });
                if (spec.ready) { await spec.ready(runContext(index)); }
        }
    }
}

class DryRunComplete extends Error {}

/** Matcher metadata distinguishes assertion failures from unrelated Playwright or user-code exceptions. */
function isAssertionError(error: unknown): boolean {
    return error instanceof AssertionError || (error instanceof Error && (error.name === 'AssertionError' || ('matcherResult' in error && typeof error.matcherResult === 'object' && error.matcherResult !== null)));
}

class AttemptError extends Error {
    constructor(override readonly cause: Cause, message: string) {
        super(message);
    }
}

/** Separate "the product misbehaved" from "the agent could not drive the UI". */
function attribute(step: StepResult): { cause: Cause; summary: string } {
    const at = `step ${step.index + 1} (${step.label})`;
    if (step.replayOnTarget) { return { cause: 'product', summary: `Expected effect missing at ${at}: ${step.error}` }; }
    switch (step.failure) {
        case 'assertion':
            return { cause: 'product', summary: `${step.kind === 'check' ? 'UI check' : 'Business verification'} failed at ${at}: ${step.error}` };
        case 'expectation': {
            // The intended request ran but was rejected, or a recorded path executed without sending it.
            const rejected = /returned/.test(step.error ?? '');
            return { cause: rejected || step.source === 'replay' ? 'product' : 'agent', summary: `Expected effect missing at ${at}: ${step.error}` };
        }
        case 'error-shown':
            return { cause: 'agent', summary: `The step's actions triggered an error before its goal was achieved at ${at}: ${step.error}` };
        case 'model':
            return { cause: 'model', summary: `Model service failed at ${at}: ${step.error}` };
        case 'exception':
            return { cause: 'environment', summary: `Test code threw at ${at}: ${step.error}` };
        case 'timeout':
            return { cause: 'timeout', summary: `Timed out at ${at}: ${step.error}` };
        case 'not-shown':
            return { cause: 'agent', summary: `Insufficient visible evidence at ${at}: ${step.error}` };
        case 'not-recorded':
            return { cause: 'agent', summary: `Replay cannot run ${at}: ${step.error}` };
        default:
            return { cause: 'agent', summary: `Could not carry out ${at}: ${step.error}` };
    }
}

async function evaluateCheck(check: () => MaybePromise<CheckOutcome>): Promise<{ passed: boolean; evidence?: unknown }> {
    try {
        return normalize(await check());
    } catch (error) {
        return { passed: false, evidence: `threw: ${message(error)}` };
    }
}

function normalize(outcome: CheckOutcome): { passed: boolean; evidence?: unknown } {
    return typeof outcome === 'boolean' ? { passed: outcome } : outcome;
}

/** Pixels cannot be redacted: skip a screenshot whenever the visible text or a field value shows a declared secret. */
async function showsSecret(page: Page, redact: Redactor): Promise<boolean> {
    if (!redact.active) { return false; }
    // eslint-disable-next-line unicorn/prefer-dom-node-text-content -- only rendered text reaches the pixels
    const shown = await secretSurface(page).catch(() => undefined);
    return shown === undefined || redact.contains(shown);
}

async function screenshot(page: Page, directory: string, index: number): Promise<string | undefined> {
    const file = `step-${String(index + 1).padStart(2, '0')}.jpg`;
    try {
        await page.screenshot({ path: join(directory, file), type: 'jpeg', quality: 60, timeout: 5000 });
        return file;
    } catch {
        return undefined;
    }
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
