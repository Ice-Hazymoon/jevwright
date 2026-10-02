import type { EndCheck } from './end-state.ts';
import type { ActFailure, ActionRecord, Round } from './act.ts';
import type { ModelCall, Models, ModelSettings, ModelUsage, RunBudget } from './models.ts';
import type { Issue } from './monitor.ts';
import type { RecordedAction, StepRecording, TestRecording } from './recording.ts';
import type { CheckOutcome, Env, FixtureContext, MaybePromise, RunContext, Step, TestSpec, Values, WriteRecord } from './spec.ts';
import type { Browser, Page } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { writeArtifact, redactTrace } from './artifacts.ts';
import { createRedactor, reveal, type Redactor } from './secrets.ts';
import { secretCheckProblems } from './select.ts';
import { pageState, runAct } from './act.ts';
import { newTestContext, settle } from './browser.ts';
import { actedOnTarget, adjudicateClaim, judgeClaim } from './judge.ts';
import { createModels, emptyUsage, ModelError } from './models.ts';
import { createMonitor } from './monitor.ts';
import { observe, shortUrl } from './observe.ts';
import { stepKey } from './recording.ts';
import { describeStep, fillTemplate, templateKeys, writeRules } from './spec.ts';

export type StepStatus = 'passed' | 'failed' | 'skipped';
export type StepFailure = ActFailure | 'assertion' | 'invariant' | 'exception' | 'blocking-issue' | 'not-recorded' | 'timeout';

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

const STEP_MARK: Record<StepStatus, string> = { passed: '✓', failed: '✗', skipped: '–' };

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
    status: 'passed' | 'failed';
    /** Stopped by Ctrl-C; the test is reported as skipped. */
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
    /** Ignore recordings and ground every step with the model. */
    fresh?: boolean;
    probe?: boolean;
    /** Stop after fixture, start page and initial invariants; saves the start observation. */
    dryRun?: boolean;
    translationKeys?: ReadonlySet<string>;
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
export async function runTestAttempt<F>(spec: TestSpec<F>, options: AttemptOptions): Promise<{ result: AttemptResult; recording?: StepRecording[] }> {
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
    let screenshotsWithheld = false;
    let traceWithheld = false;
    const models: Models | undefined = options.models ? createModels(options.models, options.runBudget, redact) : undefined;
    const timeout = AbortSignal.timeout(spec.timeoutMs ?? 240_000);
    const signal = AbortSignal.any([options.signal, timeout]);
    const data: Values = spec.data ?? {};
    const values = { ...data, ...Object.fromEntries(Object.entries(secrets).map(([key, handle]) => [key, reveal(handle)])) };
    const secretKeys = new Set(Object.keys(secrets));
    const viewport = options.viewport ?? { width: 1280, height: 900 };
    const newRecording: StepRecording[] = [];
    const pendingEnds: Array<{ entry: StepRecording; index: number; end: NonNullable<StepRecording['end']> }> = [];
    const deterministicChecks: number[] = [];
    const counts = { total: 0, replayed: 0, healed: 0, ai: 0 };
    let page: Page | undefined;
    let trace: string | undefined;
    let cause: Cause | undefined;
    let summary = 'All steps passed';
    let failedStep: number | undefined;

    const context = await newTestContext(options.browser, { viewport, baseURL: options.origin, locale: options.locale, timezone: options.timezone, dialogs: spec.dialogs ?? 'accept', onDialog: detail => events.push(`dialog ${detail}`) });
    cleanups.push(async () => context.close());
    const monitor = createMonitor(context, { origin: options.origin, allowedOrigins: options.allowedOrigins, expectedHttp: spec.expectedHttp, ignoreConsole: spec.ignoreConsole, i18nKeys: options.translationKeys, expectedAborts: spec.expectedAborts });
    await context.tracing.start({ screenshots: !secretKeys.size, snapshots: true, title: spec.id }).catch(() => undefined);
    context.on('page', (opened) => {
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
        const secretProblems = secretCheckProblems(definition, secrets);
        if (secretProblems.length) { throw new Error(secretProblems.join("; ")); }
        for (const [index, step] of definition.entries()) {
            if (step.kind === 'act' && step.expectError) { monitor.expectDuring(index, writeRules(step.expect)); }
        }
        if (options.dryRun) {
            const observation = await observe(page);
            await writeArtifact(join(directory, 'start-observation.json'), `${JSON.stringify(observation, null, 2)}\n`, redact);
            await page.screenshot({ path: join(directory, 'start.jpg'), type: 'jpeg', quality: 60 }).catch(() => undefined);
            summary = `Dry run: fixture, start page and ${spec.invariants?.length ?? 0} invariant(s) OK; ${definition.length} steps not run`;
            throw new DryRunComplete();
        }
        nextAct = (index: number) => {
            const following = definition[index + 1];
            return following?.kind === 'act' ? describeStep(following as Step<unknown>, data, secrets) : undefined;
        };
        /** A product-looking failure after AI-driven steps: the agent's, when a step acted on something it did not name. */
        const misstep = async (upTo: number): Promise<string | undefined> => {
            const acts = steps.filter(entry => entry.index <= upTo && entry.kind === 'act' && (entry.source === 'ai' || entry.source === 'healed') && entry.actions?.some(action => action.ok));
            if (!models || !acts.length) { return undefined; }
            const done = (entry: StepResult) => entry.actions!.filter(action => action.ok);
            const history = (entry: StepResult) => done(entry).map(action => ({ action: action.tool, ...(action.element ? { element: action.element } : {}), ...(action.value ? { value: action.value } : {}) }));
            const verdicts = await actedOnTarget(models, acts.map(entry => ({ step: entry.label, history: history(entry) })), signal).catch(() => undefined);
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
            const label = describeStep(step as Step<unknown>, data, secrets);
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
                result.failure = error instanceof ModelError ? 'model' : 'exception';
                result.error = message(error);
            }
            await settle(page, monitor, { maxMs: 3000 }).catch(() => 0);
            await monitor.scanText(page);
            result.url = shortUrl(page.url());
            result.writes = monitor.writes.slice(writesBefore).map(write => ({ ...write }));
            const busy = [...new Set(monitor.settleCaps.filter(cap => cap.step === index).map(cap => cap.reason))];
            if (busy.length) { result.busy = busy.slice(0, 5); }
            result.durationMs = Math.round(performance.now() - stepStarted);
            result.screenshot = screenshotsWithheld ? undefined : await screenshot(page, directory, index);
            steps.push(result);
            if (result.status === 'passed' && (step.kind === 'verify' || (step.kind === 'act' && (step.expect?.write || step.expect?.url)))) { deterministicChecks.push(index); }
            log(`     ${STEP_MARK[result.status]} ${result.source ? `[${result.source}] ` : ''}${result.durationMs}ms${result.error ? ` — ${result.error}` : ''}`);
            if (result.status === 'failed') {
                failedStep = index;
                ({ cause, summary } = attribute(result));
                if (cause === 'product' && result.failure === 'assertion') {
                    result.misstep = await misstep(index);
                    if (result.misstep) {
                        cause = 'agent';
                        summary = `${summary}. Not counted against the product: ${result.misstep}`;
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
            previousLabel = label;
        }
    } catch (error) {
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
        await context.tracing.stop({ path: trace }).catch(() => { trace = undefined; });
        if (trace && secretKeys.size && !await redactTrace(trace, redact)) { trace = undefined; traceWithheld = true; }
        for (const cleanup of cleanups.reverse()) {
            await Promise.race([Promise.resolve().then(cleanup), new Promise(resolve => setTimeout(resolve, 5000))]).catch((error: unknown) => events.push(`cleanup failed: ${message(error)}`));
        }
    }

    // Stopped by Ctrl-C: whatever the attempt ran into while stopping says nothing about the app.
    const cancelled = Boolean(cause) && options.signal.aborted;
    if (cancelled) {
        cause = 'environment';
        if (summary !== 'Run cancelled') { summary = `Run cancelled (${summary})`; }
    }
    const status = cause ? 'failed' : 'passed';
    if (status === 'passed') {
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
        ...(screenshotsWithheld ? { screenshotsWithheld: true } : {}),
        ...(traceWithheld ? { traceWithheld: true } : {}),
    };
    await writeArtifact(join(directory, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, redact);
    return { result: redact.value(result), ...(status === 'passed' && counts.total ? { recording: newRecording } : {}) };

    async function runStep(step: Step<F>, index: number, result: StepResult, previousLabel: string | undefined): Promise<void> {
        switch (step.kind) {
            case 'act': {
                const keys = templateKeys(step.instruction);
                const stepValues = Object.fromEntries(keys.map(key => [key, values[key]!]));
                const key = stepKey(step);
                const recorded = options.fresh ? undefined : options.recording?.steps.find(entry => entry.key === key);
                if (!models && !recorded?.actions.length) {
                    // Replay has no model to fall back on. A new test, or a step reworded since it was recorded.
                    result.status = 'failed';
                    result.failure = 'not-recorded';
                    result.error = 'this step has no recording; record it with an auto run (or --new for a new test)';
                    return;
                }
                counts.total++;
                const outcome = await runAct({
                    page: page!,
                    monitor,
                    models,
                    signal,
                    stepIndex: index,
                    test: spec.title,
                    instruction: fillTemplate(step.instruction, data, secrets),
                    values: stepValues,
                    secretKeys,
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
                    const entry: StepRecording = { key, instruction: step.instruction, actions: outcome.source === 'replay' && recorded ? recorded.actions : outcome.recording as RecordedAction[] };
                    if (outcome.recordedEnd !== undefined) {
                        if (outcome.source === 'replay' && recorded?.end === undefined) { pendingEnds.push({ entry, index, end: outcome.recordedEnd }); }
                        else { entry.end = outcome.recordedEnd; }
                    }
                    if (redact.contains(JSON.stringify(entry))) { result.notRecorded = 'not recorded: target text contains a secret'; }
                    else { newRecording.push(entry); }
                }
                if (outcome.rounds.some(round => (round.anomaly ?? 0) >= 0.8)) {
                    monitor.report({ kind: 'semantic', severity: 'low', message: `Jev flagged broken-looking content on ${shortUrl(page!.url())}` });
                }
                return;
            }
            case 'check': {
                if (!models) {
                    result.status = 'skipped';
                    result.error = 'Semantic checks need a model; replay mode makes no model calls';
                    return;
                }
                result.source = 'ai';
                const claim = fillTemplate(step.assertion, data);
                const reference = step.reference ? await step.reference(runContext(index)) : undefined;
                let observed = await observe(page!);
                let verdict = await judgeClaim(models, observed, claim, reference, signal);
                const attempts: unknown[] = [verdict];
                if (!verdict.passed || verdict.uncertain) {
                    // A second look after the page settles; UI updates can trail the data.
                    await page!.waitForTimeout(1500);
                    await settle(page!, monitor);
                    observed = await observe(page!);
                    verdict = await judgeClaim(models, observed, claim, reference, signal);
                    attempts.push(verdict);
                }
                if (verdict.uncertain) {
                    observed = await observe(page!);
                    const tie = await adjudicateClaim(models, observed, claim, reference, signal);
                    attempts.push({ adjudicated: tie });
                    verdict = { ...verdict, passed: tie.passed, note: tie.reason };
                }
                // Exactly what the claim was judged against, so a verdict can be audited without re-running.
                result.observation = `step-${String(index + 1).padStart(2, '0')}-observation.json`;
                await writeArtifact(join(directory, result.observation), `${JSON.stringify(pageState(observed), null, 2)}\n`, redact);
                result.evidence = { claim, ...(reference !== undefined ? { reference } : {}), verdicts: attempts };
                if (!verdict.passed) {
                    result.status = 'failed';
                    result.failure = 'assertion';
                    result.error = `Claim not shown on the page: ${claim} (holds=${verdict.holds}, ${verdict.support} ${verdict.pSupport})`;
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
            return { cause: 'product', summary: `The page showed an error at ${at}: ${step.error}` };
        case 'model':
            return { cause: 'model', summary: `Model service failed at ${at}: ${step.error}` };
        case 'exception':
            return { cause: 'environment', summary: `Test code threw at ${at}: ${step.error}` };
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
    return error instanceof Error ? error.message.split('\n')[0]!.slice(0, 400) : String(error);
}
