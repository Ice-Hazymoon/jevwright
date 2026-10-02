/* eslint-disable ts/method-signature-style -- fixture callbacks stay methods for parameter bivariance, see below */
import type { Browser, BrowserContext, Page } from 'playwright';
import type { Secret } from './secrets.ts';

/**
 * Authoring API. A test is an ordered list of natural-language steps plus trusted checks.
 * Code owns the order of steps; the model only grounds one step at a time on the live page.
 *
 * Callbacks that receive the fixture use method signatures on purpose: method parameters are
 * bivariant, so a `TestSpec<Account>` fits a `TestSpec<unknown>` list without `any`.
 */

/**
 * Register your project's types once, and every test sees them:
 *
 * ```ts
 * declare module '@hazymoon/jevwright' {
 *     interface Register { env: { databaseUrl: string } }
 * }
 * ```
 */
export interface Register {}

/** What the config's `setup` returned as `env` (`unknown` until `Register` declares it). */
export type Env = Register extends { env: infer E } ? E : unknown;

/** Test data: `{key}` in a step inserts the value. */
export type Values = Readonly<Record<string, string>>;

export interface Verdict {
    passed: boolean;
    /** Serializable evidence shown in reports. */
    evidence?: unknown;
}
export type CheckOutcome = boolean | Verdict;

/** Callbacks may be synchronous or async. */
export type MaybePromise<T> = T | Promise<T>;

/** A non-GET fetch or XHR to the app's origins, observed while the test ran. */
export interface WriteRecord {
    id: number;
    /** Index of the step that started the request. */
    step: number;
    method: string;
    path: string;
    status: number | 'pending' | 'failed';
    durationMs?: number;
}

export interface RunContext<F> {
    readonly page: Page;
    readonly context: BrowserContext;
    readonly fixture: F;
    readonly data: Values;
    readonly secrets: Readonly<Record<string, Secret>>;
    /** The app's origin, e.g. `http://127.0.0.1:3000`. */
    readonly origin: string;
    /** What the config's `setup` returned as `env`. */
    readonly env: Env;
    readonly signal: AbortSignal;
    /** Every same-origin write so far, in request start order. */
    readonly writes: readonly WriteRecord[];
    /** Index of the step being run. */
    readonly step: number;
}

export interface WriteExpectation {
    method?: string;
    path: string | RegExp;
    /** Allowed response statuses; omitted means any 2xx. */
    status?: number | readonly number[];
}

/** The write rules an expectation declares, as a list. */
export function writeRules(expectation: Expectation | undefined): readonly WriteExpectation[] {
    const write = expectation?.write;
    if (!write) { return []; }
    return 'path' in write ? [write] : write;
}

export interface Expectation {
    /** Each listed write must start during the step and complete with an allowed status. */
    write?: WriteExpectation | readonly WriteExpectation[];
    /** The page URL (path + search) must match once the step ends. */
    url?: RegExp;
    timeoutMs?: number;
}

export interface ActStep {
    kind: 'act';
    /** What a user does, e.g. "Change Nickname to {nickname}". `{key}` inserts a data value. */
    instruction: string;
    expect?: Expectation;
    maxActions?: number;
    /** Perform clicks as rapid double clicks, to probe duplicate submission. */
    double?: boolean;
    /** The step is expected to end on an error/rejection message (validation, injected failure). */
    expectError?: boolean;
}
export interface CheckStep<F> {
    kind: 'check';
    /** A statement about the visible page, e.g. "The Bio field shows {bio}". */
    assertion: string;
    /** Trusted ground truth handed to the judge, e.g. amounts read from the database. */
    reference?(context: RunContext<F>): MaybePromise<unknown>;
}
export interface VerifyStep<F> {
    kind: 'verify';
    name: string;
    /** Polled until it passes or the timeout elapses; must not change application state. */
    check(context: RunContext<F>): MaybePromise<CheckOutcome>;
    timeoutMs?: number;
}
export interface NavigationStep {
    kind: 'reload' | 'back';
}
export interface GotoStep {
    kind: 'goto';
    path: string;
}
export interface RunStep<F> {
    kind: 'run';
    name: string;
    /** Trusted code between steps, e.g. arming a one-shot fault. Never performs the tested user action. */
    run(context: RunContext<F>): MaybePromise<void>;
}
export type Step<F = unknown> = ActStep | CheckStep<F> | VerifyStep<F> | NavigationStep | GotoStep | RunStep<F>;

export interface FixtureContext {
    readonly browser: Browser;
    /** The browser context the test will use; add cookies or init scripts here. */
    readonly context: BrowserContext;
    /** The app's origin, e.g. `http://127.0.0.1:3000`. */
    readonly origin: string;
    /** What the config's `setup` returned as `env`. */
    readonly env: Env;
    readonly signal: AbortSignal;
    readonly runId: string;
    /** Register cleanup immediately after acquiring a resource; runs in reverse order. */
    defer: (cleanup: () => MaybePromise<void>) => void;
}

export interface Invariant<F> {
    name: string;
    check(context: RunContext<F>): MaybePromise<CheckOutcome>;
}

export interface TestSpec<F = unknown> {
    /** Unique kebab-case id; also names the recording file. */
    id: string;
    /** Feature area, used to group and select tests (`--module`). */
    module?: string;
    title: string;
    /** The concrete business failure this test protects against. */
    risk: string;
    tags?: readonly string[];
    /** Path the test opens first, e.g. `/settings/profile`. */
    start: string;
    /** Values the steps refer to as `{key}`. */
    data?: Values;
    /** Opaque values entered by code, withheld from models and artifacts. */
    secrets?: Readonly<Record<string, Secret>>;
    /** Prepares this test's own data and session (accounts, seed rows, cookies). Runs before the start page opens. */
    fixture?: (context: FixtureContext) => MaybePromise<F>;
    /** Wait until the application is interactive after the first navigation. */
    ready?(context: RunContext<F>): MaybePromise<void>;
    steps(fixture: F): ReadonlyArray<Step<F>>;
    /** Must hold before the first step and after every step; a violation is a product finding. */
    invariants?: ReadonlyArray<Invariant<F>>;
    /**
     * Non-2xx responses expected anywhere in the test. A step with `expectError` already expects the
     * non-2xx statuses its own `expect.write` declares, only while that step runs.
     */
    expectedHttp?: ReadonlyArray<WriteExpectation & { status: number | readonly number[] }>;
    /** Console errors that are known and accepted for this test. */
    ignoreConsole?: readonly RegExp[];
    /**
     * Requests the test itself aborts in the browser (e.g. `route.abort('failed')`) to simulate a lost
     * response. The monitor does not report the resulting `request-failed`, nor the matching
     * "Failed to load resource" console line, as an issue; an aborted request it does not match still is.
     */
    expectedAborts?: readonly WriteExpectation[];
    /** Native dialogs (confirm/alert/beforeunload). Defaults to accept. */
    dialogs?: 'accept' | 'dismiss';
    timeoutMs?: number;
    /** Reason to skip; skipped tests are reported, never silently dropped. */
    skip?: string;
    /**
     * A confirmed product defect this test reproduces: what fails, where, and its tracking reference. The test
     * still runs; a product failure is reported as `known` instead of `failed` and is not retried, any other
     * failure stays `failed`, and a pass is listed so the mark gets removed.
     */
    knownIssue?: string;
}

export function act(instruction: string, options: Omit<ActStep, 'kind' | 'instruction'> = {}): ActStep {
    return { kind: 'act', instruction, ...options };
}
export function check<F>(assertion: string, options: Omit<CheckStep<F>, 'kind' | 'assertion'> = {}): CheckStep<F> {
    return { kind: 'check', assertion, ...options };
}
export function verify<F>(name: string, check: VerifyStep<F>['check'], options: { timeoutMs?: number } = {}): VerifyStep<F> {
    return { kind: 'verify', name, check, ...options };
}
export function reload(): NavigationStep {
    return { kind: 'reload' };
}
export function back(): NavigationStep {
    return { kind: 'back' };
}
export function goto(path: string): GotoStep {
    return { kind: 'goto', path };
}
export function run<F>(name: string, fn: RunStep<F>['run']): RunStep<F> {
    return { kind: 'run', name, run: fn };
}
export function defineTest<F>(spec: TestSpec<F>): TestSpec<F> {
    return spec;
}

/** Replace `{key}` with the quoted data value; unknown keys are an authoring error. */
export function fillTemplate(template: string, data: Values, secrets: Readonly<Record<string, Secret>> = {}): string {
    return template.replace(/\{(\w+)\}/g, (_, key: string) => {
        if (key in secrets) { return `{${key}}`; }
        const value = data[key];
        if (value === undefined) {
            throw new Error(`Unknown data key {${key}} in "${template}"`);
        }
        return JSON.stringify(value);
    });
}

/** Data keys referenced by a template, in order of appearance. */
export function templateKeys(template: string): string[] {
    return [...new Set(Array.from(template.matchAll(/\{(\w+)\}/g), match => match[1]!))];
}

export function describeStep(step: Step<unknown>, data: Values = {}, secrets: Readonly<Record<string, Secret>> = {}): string {
    switch (step.kind) {
        case 'act': return safeTemplate(step.instruction, data, secrets) + (step.double ? ' (double click)' : '');
        case 'check': return `Check: ${safeTemplate(step.assertion, data, secrets)}`;
        case 'verify': return `Verify: ${step.name}`;
        case 'run': return `Run: ${step.name}`;
        case 'goto': return `Go to ${step.path}`;
        case 'reload': return 'Reload the page';
        case 'back': return 'Go back';
    }
}

function safeTemplate(template: string, data: Values, secrets: Readonly<Record<string, Secret>>): string {
    try {
        return fillTemplate(template, data, secrets);
    } catch {
        return template;
    }
}
