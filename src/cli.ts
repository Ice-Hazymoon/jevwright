import type { LoadedConfig, SetupResult } from './config.ts';
import type { RunMode, RunSummary, SuiteOptions } from './suite.ts';
import { existsSync, readFileSync } from 'node:fs';
import { writeArtifact } from './artifacts.ts';
import { createRedactor } from './secrets.ts';
import { appendFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { parseArgs, parseEnv } from 'node:util';
import { loadConfig } from './config.ts';
import { JevwrightError } from './errors.ts';
import { lastFailedIds } from './last-failed.ts';
import { gatewayFromEnv } from './models.ts';
import { checkedOrigin } from './origin.ts';
import { loadSummary, writeReports } from './report.ts';
import { selectTests } from './select.ts';
import { serveReport } from './serve.ts';
import { bindCancellationSignals } from './signals.ts';
import { resolveDevice } from './devices.ts';
import { dirname } from 'node:path';
import { runSuite } from './suite.ts';
import { VERSION } from './version.ts';

const HELP = `jevwright ${VERSION} — natural-language browser tests for business flows

Usage: jevwright <command> [options]

Commands:
  run [filters]        Run tests. Default mode "auto" replays recordings and heals stale steps with AI
  list [filters]       List the selected tests; starts nothing and needs no key
  init                 Create jevwright.config.ts and an example test
  report <run-dir>     Rebuild report.md, report.html and junit.xml from a run's summary.json
  serve [run-dir]      Serve a run's HTML report on 127.0.0.1 and print its URL (default: the latest run)

Filters:
  --test <ids>         Comma-separated test ids; "prefix*" matches by prefix
  --module <names>     Comma-separated modules
  --tag <names>        Comma-separated tags
  --shard <i/n>        Select a stable hash partition (also supported by list)
  --last-failed        Select failed and flaky tests from the latest completed run

Run options:
  --mode <mode>        auto (default) | replay: recordings only, no model calls, checks skipped
                       | ai: ignore recordings and ground every step fresh
  --new                Author new tests: an AI run that records (no retries), then a replay of that
                       recording in the same environment. Needs --test
  --retries <n>        Extra attempts for a failed test (config default 1)
  --concurrency <n>    Tests in parallel (config default 2)
  --max-cost <usd>     Stop once the run's model cost reaches this (config default 1)
  --dry-run            Run fixtures, open start pages and check initial invariants only
  --no-record          Do not write recordings
  --base-url <origin>  Test an app already running here instead of calling the config's setup
  --device <desktop|mobile>  Override test and config device
  --headed             Show the browser
  --probe              Also ask on every decision whether the page looks broken

Global options:
  --config <file>      Config file (default: jevwright.config.ts in the current directory)
  --env-file <file>    Load environment variables, such as model keys, from a file
  --port <n>           serve: port to listen on (default: any free port)
  -h, --help           Show this help
  -v, --version        Show the version

Exit codes: 0 no test failed, 1 a test failed, 2 usage, config or setup error, 3 internal error,
            4 replay failed only because recordings are missing, 130 interrupted.
Docs: https://github.com/Ice-Hazymoon/jevwright#readme
`;

const OPTIONS = {
    device: { type: 'string' },
    'test': { type: 'string' },
    'module': { type: 'string' },
    'tag': { type: 'string' },
    'shard': { type: 'string' },
    'last-failed': { type: 'boolean' },
    'mode': { type: 'string' },
    'new': { type: 'boolean' },
    'retries': { type: 'string' },
    'concurrency': { type: 'string' },
    'max-cost': { type: 'string' },
    'dry-run': { type: 'boolean' },
    'no-record': { type: 'boolean' },
    'base-url': { type: 'string' },
    'headed': { type: 'boolean' },
    'probe': { type: 'boolean' },
    'config': { type: 'string' },
    'env-file': { type: 'string' },
    'port': { type: 'string' },
    'help': { type: 'boolean', short: 'h' },
    'version': { type: 'boolean', short: 'v' },
} as const;

type Flags = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>['values'];

export interface CliIO {
    cwd: string;
    env: Record<string, string | undefined>;
    stdout: (text: string) => void;
    stderr: (text: string) => void;
}

const defaultIO = (): CliIO => ({ cwd: process.cwd(), env: process.env, stdout: text => process.stdout.write(text), stderr: text => process.stderr.write(text) });

/** Runs one CLI invocation and returns its exit code. */
export async function main(argv: readonly string[], io: CliIO = defaultIO()): Promise<number> {
    try {
        const { values: flags, positionals } = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
        if (flags.version) { io.stdout(`${VERSION}\n`); return 0; }
        const [command, ...rest] = positionals;
        if (flags.help) { io.stdout(HELP); return 0; }
        if (!command) { io.stderr(HELP); return 2; }
        if (flags['env-file']) { loadEnvFile(resolve(io.cwd, flags['env-file']), io.env); }
        switch (command) {
            case 'run': return await runCommand(flags, io);
            case 'list': return await listCommand(flags, io);
            case 'init': return await initCommand(io);
            case 'report': return await reportCommand(rest[0], io);
            case 'serve': return await serveCommand(rest[0], flags, io);
            default: throw new JevwrightError(`Unknown command "${command}". Run \`jevwright --help\`.`);
        }
    } catch (error) {
        if (error instanceof JevwrightError) {
            io.stderr(`jevwright: ${error.message}\n`);
            return 2;
        }
        if (error instanceof TypeError && 'code' in error && String(error.code).startsWith('ERR_PARSE_ARGS')) {
            io.stderr(`jevwright: ${error.message.split('. ')[0]!.replace(/\.$/, '')}. Run \`jevwright --help\` for the options.\n`);
            return 2;
        }
        throw error;
    }
}

/** Adds the file's variables to `env`; variables already set keep their value, as with `node --env-file`. */
function loadEnvFile(file: string, env: CliIO['env']): void {
    if (!existsSync(file)) { throw new JevwrightError(`--env-file not found: ${file}`); }
    for (const [key, value] of Object.entries(parseEnv(readFileSync(file, 'utf8')))) { env[key] ??= value; }
}

async function listCommand(flags: Flags, io: CliIO): Promise<number> {
    const loaded = await loadConfig({ cwd: io.cwd, path: flags.config });
    const tests = await selectedTests(loaded, flags);
    const rows = tests.map(test => [test.id, test.module ?? '', (test.tags ?? []).join(','), test.title]);
    // Only columns some test fills, each as wide as its longest cell.
    const widths = [0, 1, 2].map(column => Math.max(...rows.map(row => row[column]!.length)));
    for (const row of rows) {
        io.stdout(`${row.map((cell, column) => column < 3 ? (widths[column] ? `${cell.padEnd(widths[column]!)}  ` : '') : cell).join('')}\n`);
    }
    io.stdout(`${tests.length} test${tests.length === 1 ? '' : 's'}\n`);
    return 0;
}

interface Pass { mode: RunMode; retries: number; record: boolean }

async function runCommand(flags: Flags, io: CliIO): Promise<number> {
    const loaded = await loadConfig({ cwd: io.cwd, path: flags.config });
    const passes = passesFor(flags, parseMode(flags.mode), loaded.config.retries ?? 1);
    const tests = await selectedTests(loaded, flags);
    if (!tests.length) { io.stdout('0 tests selected\n'); return 0; }
    const models = requiredModels(loaded, flags, passes, io.env);
    const redact = createRedactor(tests.flatMap(test => Object.values(test.secrets ?? {})));
    const log = (line: string) => io.stderr(`${redact.text(line)}\n`);
    const controller = new AbortController();
    const unbind = bindCancellationSignals(controller, log);
    let teardown: SetupResult['teardown'];
    try {
        const translationKeys = await loadTranslationKeys(loaded);
        const app = await startApp(loaded, flags, tests, controller.signal, log, (stop) => { teardown = stop; });
        if (controller.signal.aborted) { return 130; }
        const options = suiteOptions(loaded, flags, app, { ...(models ? { models } : {}), translationKeys, signal: controller.signal, log });
        return await runPasses(tests, passes, options, app, io);
    } catch (error) {
        if (controller.signal.aborted) { return 130; }
        throw error;
    } finally {
        if (teardown) { await runTeardown(teardown, log); }
        unbind();
    }
}

/** The model settings a run needs: none when every pass replays or it is a dry run; otherwise a missing key is an error. */
function requiredModels(loaded: LoadedConfig, flags: Flags, passes: readonly Pass[], env: CliIO['env']): SuiteOptions['models'] {
    if (flags['dry-run'] || passes.every(pass => pass.mode === 'replay')) { return undefined; }
    const models = modelOptions(loaded, env);
    if (!models) {
        throw new JevwrightError('No model key found. Set OPENROUTER_API_KEY (or VERCEL_AI_GATEWAY_API_KEY), or pass one with --env-file. '
            + 'Without a key, --mode replay runs recordings only and --dry-run checks fixtures and start pages.');
    }
    return models;
}

/** Runs the passes in order and returns the exit code. A failed pass ends the run: replaying the recording of a failed first run proves nothing. */
async function runPasses(tests: LoadedConfig['config']['tests'], passes: readonly Pass[], options: Omit<SuiteOptions, 'mode' | 'retries' | 'updateRecordings'>, app: Omit<SetupResult, 'teardown'>, io: CliIO): Promise<number> {
    for (const [index, pass] of passes.entries()) {
        // Replay never calls the models it is given; the engine drops them for that mode.
        const summary = await runSuite(tests, { ...options, mode: pass.mode, retries: pass.retries, updateRecordings: pass.record });
        if (app.serverLog) { await writeArtifact(join(summary.directory, 'server.log'), await app.serverLog(), createRedactor(tests.flatMap(test => Object.values(test.secrets ?? {})))).catch(() => undefined); }
        io.stdout(summaryLine(summary, passes.length > 1 ? `pass ${index + 1}/${passes.length} (${pass.mode}${pass.record ? ', recording' : ''}): ` : '', io.cwd));
        if (options.signal?.aborted) { return 130; }
        if (summary.totals.failed > 0) { return runFailureExitCode(summary, passes.length === 1); }
    }
    return 0;
}

/** What every pass of `run` shares: the config and flags, resolved against the started app. */
function suiteOptions(loaded: LoadedConfig, flags: Flags, app: Omit<SetupResult, 'teardown'>, run: Pick<SuiteOptions, 'models' | 'translationKeys' | 'signal' | 'log'>): Omit<SuiteOptions, 'mode' | 'retries' | 'updateRecordings'> {
    const { config } = loaded;
    return {
        ...run,
        baseURL: app.baseURL,
        allowedOrigins: config.allowedOrigins,
        outputDir: loaded.outputDir,
        recordingsDir: loaded.recordingsDir,
        concurrency: parseCount(flags.concurrency, '--concurrency', 1) ?? config.concurrency,
        maxCostUsd: parseCost(flags['max-cost']) ?? config.maxCostUsd ?? 1,
        headless: !flags.headed,
        probe: flags.probe,
        dryRun: flags['dry-run'],
        failOnIssues: config.failOnIssues,
        viewport: config.viewport,
        rootDir: dirname(loaded.file),
        device: config.device,
        deviceOverride: flags.device ? cliDevice(flags.device) : undefined,
        locale: config.locale,
        timezone: config.timezone,
        env: app.env,
        command: `${config.command ?? 'npx jevwright'} run ${reproducibleArgs(flags)}`.trim(),
        ...(app.metadata ? { metadata: app.metadata } : {}),
    };
}

/** How long teardown may take before the CLI stops waiting; a hung stop must not hang the run. */
const TEARDOWN_MS = 30_000;

/**
 * `--base-url`, else the config's `setup`, else its `baseURL`. A teardown is handed to `onTeardown` as soon as
 * setup returns, so it runs even when the rest of setup's result is invalid.
 */
async function startApp(loaded: LoadedConfig, flags: Flags, tests: LoadedConfig['config']['tests'], signal: AbortSignal, log: (line: string) => void, onTeardown: (teardown: SetupResult['teardown']) => void): Promise<Omit<SetupResult, 'teardown'>> {
    const { config } = loaded;
    if (flags['base-url']) { return { baseURL: checkedOrigin(flags['base-url'], '--base-url') }; }
    if (config.setup) {
        log('Starting the app (config setup)…');
        let result: SetupResult | undefined;
        try {
            result = await config.setup({ tests, signal, log });
        } catch (error) {
            if (signal.aborted) { throw error; }
            throw new JevwrightError(`setup failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (typeof result?.teardown === 'function') { onTeardown(result.teardown); }
        return { baseURL: checkedOrigin(result?.baseURL, 'setup() baseURL'), env: result?.env, serverLog: result?.serverLog, metadata: result?.metadata };
    }
    if (config.baseURL) { return { baseURL: config.baseURL }; }
    throw new JevwrightError(`${basename(loaded.file)} needs a baseURL (an app that is already running) or a setup function that starts one; or pass --base-url.`);
}

async function runTeardown(teardown: NonNullable<SetupResult['teardown']>, log: (line: string) => void): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => { timer = setTimeout(resolve, TEARDOWN_MS, 'timeout'); });
    try {
        const outcome = await Promise.race([Promise.resolve().then(teardown), timeout]);
        if (outcome === 'timeout') { log(`teardown did not finish within ${TEARDOWN_MS / 1000} s; continuing without it`); }
    } catch (error) {
        log(`teardown failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
        clearTimeout(timer);
    }
}

async function loadTranslationKeys(loaded: LoadedConfig): Promise<Iterable<string> | undefined> {
    const source = loaded.config.translationKeys;
    if (typeof source !== 'function') { return source; }
    let keys: unknown;
    try {
        keys = await source();
    } catch (error) {
        throw new JevwrightError(`translationKeys() in ${basename(loaded.file)} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (typeof keys !== 'object' || keys === null || !(Symbol.iterator in keys)) {
        throw new JevwrightError(`translationKeys() in ${basename(loaded.file)} must return an iterable of strings, such as an array or a Set`);
    }
    return keys as Iterable<string>;
}

function modelOptions(loaded: LoadedConfig, env: CliIO['env']): SuiteOptions['models'] {
    const models = loaded.config.models ?? {};
    const fromEnv = gatewayFromEnv(env, models.provider);
    const apiKey = models.apiKey ?? fromEnv?.apiKey;
    if (!apiKey) { return undefined; }
    return {
        apiKey,
        provider: models.provider ?? fromEnv?.provider ?? 'openrouter',
        ...(models.jevModel ? { jevModel: models.jevModel } : {}),
        ...(models.llmModel ? { llmModel: models.llmModel } : {}),
        ...(models.maxCallsPerTest ? { maxCallsPerTest: models.maxCallsPerTest } : {}),
        ...(models.timeoutMs ? { timeoutMs: models.timeoutMs } : {}),
    };
}

function parseMode(raw: string | undefined): RunMode {
    const mode = raw ?? 'auto';
    if (mode !== 'auto' && mode !== 'replay' && mode !== 'ai') { throw new JevwrightError(`--mode must be auto, replay or ai, got "${mode}"`); }
    return mode;
}

/**
 * `--new` authors a test in one environment: AI grounds and records every step with no retries, then the
 * recording alone must reproduce the result. Otherwise one pass in the requested mode.
 */
function passesFor(flags: Flags, mode: RunMode, configRetries: number): Pass[] {
    // A dry run checks fixtures and start pages; retrying would only hide a flaky fixture.
    const retries = flags['dry-run'] ? 0 : parseCount(flags.retries, '--retries', 0) ?? configRetries;
    if (!flags.new) { return [{ mode, retries, record: !flags['no-record'] }]; }
    if (!flags.test) { throw new JevwrightError('--new needs --test <id> naming the test being written'); }
    if (flags.mode || flags['no-record'] || flags['dry-run']) { throw new JevwrightError('--new sets its own mode and recording; drop --mode, --no-record and --dry-run'); }
    return [{ mode: 'ai', retries: 0, record: true }, { mode: 'replay', retries: 0, record: false }];
}

function parseCount(raw: string | undefined, flag: string, min: number): number | undefined {
    if (raw === undefined) { return undefined; }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min) { throw new JevwrightError(`${flag} must be a whole number ≥ ${min}, got "${raw}"`); }
    return value;
}

function parseCost(raw: string | undefined): number | undefined {
    if (raw === undefined) { return undefined; }
    const value = Number(raw);
    if (!(value > 0) || !Number.isFinite(value)) { throw new JevwrightError(`--max-cost must be a positive number of US dollars, got "${raw}"`); }
    return value;
}

/** The flags that shape a run, so a report's reproduce command runs the same way (minus the selection). */
function reproducibleArgs(flags: Flags): string {
    const parts: string[] = [];
    for (const name of ['test', 'module', 'tag', 'shard', 'mode', 'config', 'base-url', 'env-file', 'device'] as const) {
        if (flags[name]) { parts.push(`--${name} ${flags[name]}`); }
    }
    if (flags['dry-run']) { parts.push('--dry-run'); }
    if (flags['last-failed']) { parts.push('--last-failed'); }
    return parts.join(' ');
}

function summaryLine(summary: RunSummary, label: string, cwd: string): string {
    const { totals, manifest } = summary;
    const budget = manifest.maxCostUsd !== undefined && totals.models.cost >= manifest.maxCostUsd ? ` · run budget of $${manifest.maxCostUsd} reached` : '';
    const counts = [`${totals.passed} passed`, `${totals.failed} failed`, totals.flaky && `${totals.flaky} flaky`, totals.known && `${totals.known} known`, totals.skipped && `${totals.skipped} skipped`].filter(Boolean).join(', ');
    const models = totals.models.jevCalls + totals.models.llmCalls ? ` · ${totals.models.jevCalls} Jev / ${totals.models.llmCalls} LLM calls · $${totals.models.cost.toFixed(4)}` : '';
    return `\n${label}${counts} · ${totals.issues} issue${totals.issues === 1 ? '' : 's'}${models}${budget}\nReport: ${relative(cwd, join(summary.directory, 'report.html'))}\n`;
}

async function reportCommand(directory: string | undefined, io: CliIO): Promise<number> {
    if (!directory) { throw new JevwrightError('Usage: jevwright report <run-dir>'); }
    const dir = resolve(io.cwd, directory);
    const summary = await loadSummary(dir).catch(() => { throw new JevwrightError(`${directory} has no readable summary.json`); });
    await writeReports({ ...summary, directory: dir });
    io.stdout(`${relative(io.cwd, join(dir, 'report.md'))}\n${relative(io.cwd, join(dir, 'report.html'))}\n`);
    return 0;
}

async function serveCommand(directory: string | undefined, flags: Flags, io: CliIO): Promise<number> {
    const dir = directory ? resolve(io.cwd, directory) : await latestRun(flags, io);
    if (!existsSync(join(dir, 'report.html'))) { throw new JevwrightError(`${relative(io.cwd, dir) || '.'} has no report.html`); }
    const server = await serveReport(dir, parseCount(flags.port, '--port', 0) ?? 0);
    io.stdout(`Serving ${relative(io.cwd, dir)} at ${server.url}\nPress Ctrl-C to stop.\n`);
    await new Promise<void>((done) => {
        const stop = () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); void server.close().then(done); };
        process.on('SIGINT', stop);
        process.on('SIGTERM', stop);
    });
    return 0;
}

async function latestRun(flags: Flags, io: CliIO): Promise<string> {
    const outputDir = await loadConfig({ cwd: io.cwd, path: flags.config }).then(loaded => loaded.outputDir, () => resolve(io.cwd, '.jevwright/runs'));
    const runs = await readdir(outputDir).catch(() => [] as string[]);
    const dated = await Promise.all(runs.map(async name => ({ name, mtime: (await stat(join(outputDir, name)).catch(() => undefined))?.mtimeMs ?? 0 })));
    const latest = dated.filter(run => run.mtime).sort((a, b) => b.mtime - a.mtime)[0];
    if (!latest) { throw new JevwrightError(`No runs in ${relative(io.cwd, outputDir)} yet. Run \`jevwright run\` first, or pass a run directory.`); }
    return join(outputDir, latest.name);
}

const CONFIG_TEMPLATE = `import { defineConfig } from '@hazymoon/jevwright';
import { exampleTests } from './jevwright/example.js';

export default defineConfig({
    // The app under test. Start it yourself, or replace this with \`setup\` to start a fresh one per run.
    baseURL: 'http://localhost:3000',
    tests: [...exampleTests],
});
`;

const EXAMPLE_TEMPLATE = `import { act, check, defineTest, reload } from '@hazymoon/jevwright';

// One test per business rule a user would notice breaking. Steps use the words on the screen,
// never selectors; the model finds the controls, and your code and the reloaded page decide the verdict.
export const exampleTests = [
    defineTest({
        id: 'profile-save',
        title: 'Edit the display name, save, and still see it after a reload',
        risk: 'A saved profile change is lost after a reload',
        start: '/settings/profile',
        data: { name: 'Ada Lovelace' },
        steps: () => [
            act('Change Display name to {name}'),
            // The step is done when this request succeeds; a failed save fails the test as a product bug.
            act('Save the profile', { expect: { write: { method: 'PATCH', path: '/api/profile' } } }),
            reload(),
            check('The Display name field shows {name}'),
        ],
    }),
];
`;

async function initCommand(io: CliIO): Promise<number> {
    const files = [
        { path: resolve(io.cwd, 'jevwright.config.ts'), text: CONFIG_TEMPLATE },
        { path: resolve(io.cwd, 'jevwright/example.ts'), text: EXAMPLE_TEMPLATE },
    ];
    const existing = files.filter(file => existsSync(file.path));
    if (existing.length) { throw new JevwrightError(`Not overwriting ${existing.map(file => relative(io.cwd, file.path)).join(', ')}`); }
    await mkdir(resolve(io.cwd, 'jevwright'), { recursive: true });
    for (const file of files) { await writeFile(file.path, file.text); }
    const gitignore = resolve(io.cwd, '.gitignore');
    const ignored = existsSync(gitignore) && (await readFile(gitignore, 'utf8')).split('\n').some(line => line.trim().replace(/\/$/, '') === '.jevwright');
    if (existsSync(gitignore) && !ignored) { await appendFile(gitignore, '\n# jevwright run reports\n.jevwright/\n'); }
    io.stdout(`Created jevwright.config.ts and jevwright/example.ts${existsSync(gitignore) && !ignored ? ', and ignored .jevwright/ in .gitignore' : ''}.

Next:
  1. Point baseURL at your app and rewrite the example test for a real page.
  2. npx playwright install chromium        (once per machine)
  3. export OPENROUTER_API_KEY=...          (or VERCEL_AI_GATEWAY_API_KEY)
  4. npx jevwright run --test profile-save --new
`);
    return 0;
}

async function selectedTests(loaded: LoadedConfig, flags: Flags) {
    const tests = selectTests(loaded.config.tests, flags);
    if (!flags['last-failed']) { return tests; }
    const ids = await lastFailedIds(loaded.outputDir);
    return tests.filter(test => ids.has(test.id));
}

/** Missing recordings alone are a maintenance outcome; missing targets can be real regressions. */
export function runFailureExitCode(summary: RunSummary, standalone = true): number {
    const failed = summary.results.filter(result => result.status === 'failed');
    if (!failed.length) { return 0; }
    return standalone && summary.manifest.mode === 'replay' && !summary.results.some(result => result.attempts.some(attempt => attempt.steps.some(step => step.endMismatch))) && failed.every(result => result.attempts.length > 0 && result.attempts.every(attempt => attempt.steps.some(step => step.failure === 'not-recorded') && attempt.steps.filter(step => step.status === 'failed').every(step => step.failure === 'not-recorded')))
        ? 4 : 1;
}

function cliDevice(value: string): 'desktop' | 'mobile' {
    if (value !== 'desktop' && value !== 'mobile') { throw new JevwrightError('--device must be desktop or mobile'); }
    resolveDevice(value);
    return value;
}
