import type { Device } from './devices.ts';
import type { ModelProvider } from './models.ts';
import type { Env, TestSpec } from './spec.ts';
import { createJiti } from 'jiti';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { deviceSchema } from './devices.ts';
import { JevwrightError } from './errors.ts';
import { originProblem } from './origin.ts';
import { assertValidTests } from './select.ts';

export interface SetupContext {
    /** The tests this run selected, e.g. to open their start pages once before they run. */
    readonly tests: ReadonlyArray<TestSpec<unknown>>;
    /** Aborted on Ctrl-C; long setup work should stop when it fires. */
    readonly signal: AbortSignal;
    /** Writes a progress line to stderr. */
    log: (line: string) => void;
}

export interface SetupResult {
    /** Where the app under test is served: an origin such as `http://127.0.0.1:4173`. */
    baseURL: string;
    /** Handed to fixtures and steps as `env`: database URLs, API clients, seeding credentials. */
    env?: Env;
    /** The app server's output; saved as `server.log` next to each report. */
    serverLog?: () => string | Promise<string>;
    /** Extra facts recorded in run.json, e.g. which database the run owned. */
    metadata?: Record<string, unknown>;
    /** Stops what setup started. Runs after the tests, including after a failure or Ctrl-C; given 30 s. */
    teardown?: () => void | Promise<void>;
}

export interface ModelConfig {
    /** `openrouter` or `vercel` (AI Gateway). Defaults to whichever key the environment has. */
    provider?: ModelProvider;
    /** Defaults to `OPENROUTER_API_KEY`, then `VERCEL_AI_GATEWAY_API_KEY` / `AI_GATEWAY_API_KEY`. */
    apiKey?: string;
    /** Jev model id on the gateway. */
    jevModel?: string;
    /** Helper model id for steps Jev cannot resolve alone. */
    llmModel?: string;
    /** Ceiling on model calls per test attempt. Default 80. */
    maxCallsPerTest?: number;
    /** Per-request timeout in milliseconds. Default 45 000. */
    timeoutMs?: number;
    /** Proposed-action confidence before independent remaining-work review. Default 0.75. */
    actionPriorityThreshold?: number;
}

export interface JevwrightConfig {
    /** The tests, in report order. */
    tests: ReadonlyArray<TestSpec<unknown>>;
    /** The origin of an app that is already running, e.g. `http://localhost:3000`. Use `setup` instead to start a fresh one for each run. */
    baseURL?: string;
    /** Starts the app for a run (and seeds or warms it up). Takes precedence over `baseURL`. */
    setup?: (context: SetupContext) => Promise<SetupResult>;
    /**
     * Further origins of the app, such as an API or auth server on another port. The browser may reach them, and
     * their requests are monitored like the app's own. Every other origin is blocked.
     */
    allowedOrigins?: readonly string[];
    /** Recordings to commit, one JSON file per test. Default `jevwright/recordings`, relative to this config file. */
    recordingsDir?: string;
    /** Run directories with reports, screenshots and traces. Default `.jevwright/runs`, relative to this config file. */
    outputDir?: string;
    /** Tests run in parallel, each in its own browser context. Default 2. */
    concurrency?: number;
    /** Extra attempts for a failed test. Default 1. */
    retries?: number;
    /** Stop a run once its model cost reaches this many US dollars. Default 1. */
    maxCostUsd?: number;
    /** Default 1280×900. */
    viewport?: { width: number; height: number };
    device?: Device;
    /** Browser locale. Default `en-US`. */
    locale?: string;
    /** Browser time zone. Default `UTC`. */
    timezone?: string;
    /**
     * Fail a test when a high-severity issue appears: an uncaught page error, a 5xx response, a server error
     * screen, or the app not loading its own code. Default true; false only reports them.
     */
    failOnIssues?: boolean;
    /** The app's translation keys; one rendered verbatim on a page is reported as untranslated. */
    translationKeys?: Iterable<string> | (() => Iterable<string> | Promise<Iterable<string>>);
    models?: ModelConfig;
    /** How this project invokes jevwright, used in the reproduce commands of reports. Default `npx jevwright`. */
    command?: string;
}

/** Typed identity helper for `jevwright.config.ts`. */
export function defineConfig(config: JevwrightConfig): JevwrightConfig {
    return config;
}

export const CONFIG_FILES = ['jevwright.config.ts', 'jevwright.config.mts', 'jevwright.config.js', 'jevwright.config.mjs'] as const;

export interface LoadedConfig {
    config: JevwrightConfig;
    /** Absolute path of the config file. */
    file: string;
    /** Resolved `recordingsDir` and `outputDir`. */
    recordingsDir: string;
    outputDir: string;
}

const positiveInt = z.number().int().positive();
const origin = z.string().superRefine((value, context) => {
    const problem = originProblem(value);
    if (problem) { context.addIssue({ code: 'custom', message: problem }); }
});
const fn = z.custom<(...args: never[]) => unknown>(value => typeof value === 'function', 'expected a function');
const schema = z.object({
    tests: z.array(z.unknown(), 'expected an array of tests (`tests: [...]`)'),
    baseURL: origin.optional(),
    setup: fn.optional(),
    allowedOrigins: z.array(origin).optional(),
    recordingsDir: z.string().min(1).optional(),
    outputDir: z.string().min(1).optional(),
    concurrency: positiveInt.optional(),
    retries: z.number().int().min(0).optional(),
    maxCostUsd: z.number().positive().optional(),
    viewport: z.object({ width: positiveInt, height: positiveInt }).optional(),
    device: deviceSchema.optional(),
    locale: z.string().min(1).optional(),
    timezone: z.string().min(1).optional(),
    failOnIssues: z.boolean().optional(),
    translationKeys: z.union([fn, z.custom<Iterable<string>>(value => typeof value === 'object' && value !== null && Symbol.iterator in value, 'expected an iterable of strings')]).optional(),
    models: z.object({
        provider: z.enum(['openrouter', 'vercel']).optional(),
        apiKey: z.string().optional(),
        jevModel: z.string().min(1).optional(),
        llmModel: z.string().min(1).optional(),
        maxCallsPerTest: positiveInt.optional(),
        timeoutMs: positiveInt.optional(),
        actionPriorityThreshold: z.number().min(0.5).max(1).optional(),
    }).strict().optional(),
    command: z.string().min(1).optional(),
}).strict();

/**
 * Bun runs TypeScript itself and honours tsconfig `paths`, so under Bun the config loads through Bun; elsewhere
 * jiti transpiles it.
 */
async function importConfig(file: string): Promise<object> {
    if (process.versions.bun) { return await import(pathToFileURL(file).href) as object; }
    return createJiti(import.meta.url, { interopDefault: true, moduleCache: false }).import<object>(file);
}

/**
 * Finds and loads the config: `path` when given, else the first `jevwright.config.{ts,mts,js,mjs}` in `cwd`.
 * TypeScript configs and the test files they import load without a build step.
 */
export async function loadConfig(options: { cwd?: string; path?: string } = {}): Promise<LoadedConfig> {
    const cwd = options.cwd ?? process.cwd();
    const file = options.path ? resolve(cwd, options.path) : CONFIG_FILES.map(name => resolve(cwd, name)).find(existsSync);
    if (!file) { throw new JevwrightError(`No jevwright.config.ts in ${cwd}. Create one with \`npx jevwright init\`, or pass --config <file>.`); }
    if (!existsSync(file)) { throw new JevwrightError(`Config file not found: ${file}`); }
    let module: object;
    try {
        module = await importConfig(file);
    } catch (error) {
        throw new JevwrightError(`Could not load ${file}:\n  ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!('default' in module)) { throw new JevwrightError(`${file} has no default export. Write \`export default defineConfig({ ... })\`.`); }
    const loaded = module.default;
    const parsed = schema.safeParse(loaded);
    if (!parsed.success) {
        const problems = parsed.error.issues.map(issue => `${issue.path.length ? issue.path.join('.') : 'config'}: ${issue.message}`);
        throw new JevwrightError(`Invalid config in ${file}:\n  ${problems.join('\n  ')}\nThe config file must \`export default defineConfig({ ... })\`.`);
    }
    const config = loaded as JevwrightConfig;
    assertValidTests(config.tests);
    const root = dirname(file);
    const within = (path: string) => isAbsolute(path) ? path : resolve(root, path);
    return { config, file, recordingsDir: within(config.recordingsDir ?? 'jevwright/recordings'), outputDir: within(config.outputDir ?? '.jevwright/runs') };
}
