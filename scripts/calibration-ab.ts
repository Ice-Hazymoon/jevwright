import type { ModelSettings, RunSummary } from '../src/index.ts';
import type { startFixtureApp } from '../tests/fixtures/app.ts';
import type { CalibrationTest } from './calibration-fixtures.ts';
import type { Pair, Sample } from './calibration-stats.ts';
import { execFile, spawn } from 'node:child_process';
import { randomInt, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import * as candidate from '../src/index.ts';
import { addUsage, emptyUsage } from '../src/models.ts';
import { applicableTests, comparePairs, metricNames } from './calibration-stats.ts';

interface Options {
    ref: string;
    pairs: number;
    retries: number;
    mode: 'auto' | 'ai';
    headless: boolean;
    models?: ModelSettings;
    signal: AbortSignal;
}

/** Run without a shell. Cancellation waits for process termination before worktree cleanup. */
async function command(command: string, args: string[], cwd: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
        const child = spawn(command, args, { cwd, stdio: 'inherit', detached: true });
        let timer: ReturnType<typeof setTimeout> | undefined;
        const kill = (signal: NodeJS.Signals) => { try { process.kill(-child.pid!, signal); } catch { /* Already exited. */ } };
        const cancel = () => { kill('SIGTERM'); timer = setTimeout(kill, 3000, 'SIGKILL'); };
        signal?.addEventListener('abort', cancel, { once: true });
        child.once('error', reject);
        child.once('close', (code) => {
            signal?.removeEventListener('abort', cancel);
            clearTimeout(timer);
            if (signal?.aborted) { reject(signal.reason); } else if (code === 0) { resolve(); } else { reject(new Error(`${command} exited ${code}`)); }
        });
    });
}

function sample(summary: RunSummary, ids: Set<string>, expectations: Record<string, string>): Sample {
    const results = summary.results.filter(result => ids.has(result.id));
    const usage = emptyUsage();
    for (const result of results) { addUsage(usage, result.models); }
    const matched: Record<string, boolean> = {};
    for (const result of results) {
        matched[result.id] = expectations[result.id] === 'passed'
            ? result.status === 'passed'
            : result.status === 'failed' && result.cause === 'product';
    }
    return {
        matched,
        metrics: {
            jev: usage.jevCalls,
            llm: usage.llmCalls,
            cost: usage.cost,
            duration: results.reduce((total, result) => total + result.durationMs, 0),
            healed: results.flatMap(result => result.attempts.flatMap(attempt => attempt.steps)).filter(step => step.source === 'healed').length,
            rerouted: results.filter(result => 'rerouted' in result && result.rerouted).length,
        },
    };
}

export async function runCalibrationAB(tests: CalibrationTest[], app: Awaited<ReturnType<typeof startFixtureApp>>, options: Options) {
    if (tests.some(test => !['passed', 'product'].includes(test.expected))) { throw new Error('Each calibration fixture must declare expected: passed or product'); }
    const expectations = Object.fromEntries(tests.map(test => [test.id, test.expected]));
    if (!options.models) { throw new Error('A/B calibration needs a model gateway'); }
    // Git lists worktrees by real path; a symlinked tmpdir (macOS /var) would otherwise never match.
    const temporary = await realpath(await mkdtemp(join(tmpdir(), 'jevwright-ab-')));
    const worktree = join(temporary, 'baseline');
    const root = resolve('.');
    const output = resolve('.jevwright/calibration', `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`);
    await mkdir(output, { recursive: true });
    const pairs: Pair[] = [];
    const orders: string[][] = [];
    const directories: string[] = [];
    let runFailure: unknown;
    try {
        // Do not interrupt Git while it changes registration; even a failing hook can leave a registered tree.
        await command('git', ['worktree', 'add', '--detach', worktree, options.ref], root);
        await command('npm', ['ci', '--ignore-scripts'], worktree, options.signal);
        await command('npm', ['run', 'build'], worktree, options.signal);
        const baseline = await import(pathToFileURL(join(worktree, 'dist/index.mjs')).href) as typeof candidate;
        const baselineSelection = applicableTests(tests, baseline);
        const candidateSelection = applicableTests(tests, candidate);
        if (candidateSelection.unsupported.length) { throw new Error(`Candidate fixtures require unavailable APIs: ${JSON.stringify(candidateSelection.unsupported)}`); }
        const common = baselineSelection.supported;
        if (!common.length) { throw new Error('No fixture tests are applicable to both engines'); }
        const commonIds = new Set(common.map(test => test.id));
        const run = async (side: 'baseline' | 'candidate', mode: 'ai' | 'auto') => {
            options.signal.throwIfAborted();
            const engine = side === 'baseline' ? baseline : candidate;
            // Secret handles belong to their engine module; each side needs its own opaque handles.
            const selected = side === 'baseline' ? common.map(test => ({ ...test, ...(test.secrets ? { secrets: Object.fromEntries(Object.entries(test.secrets).map(([key, value]) => [key, baseline.secret(candidate.reveal(value))])) } : {}) })) : tests;
            const summary = await engine.runSuite(selected, {
                baseURL: app.origin,
                outputDir: join(output, side),
                recordingsDir: join(output, `${side}-recordings`),
                mode,
                concurrency: 1,
                retries: options.retries,
                headless: options.headless,
                signal: options.signal,
                models: options.models,
                probe: true,
                translationKeys: ['settings.profile.title'],
            });
            options.signal.throwIfAborted();
            directories.push(summary.directory);
            return sample(summary, commonIds, expectations);
        };
        if (options.mode === 'auto') {
            for (const side of ['baseline', 'candidate'] as const) { await run(side, 'ai'); }
        }
        for (let index = 0; index < options.pairs; index++) {
            const order: Array<'baseline' | 'candidate'> = randomInt(2) === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
            orders.push(order);
            const first = await run(order[0]!, options.mode);
            const second = await run(order[1]!, options.mode);
            pairs.push(order[0] === 'baseline' ? { baseline: first, candidate: second } : { baseline: second, candidate: first });
            const comparison = comparePairs(pairs);
            await writeFile(join(output, 'pairs.json'), JSON.stringify({ ref: options.ref, mode: options.mode, retries: options.retries, orders, pairs, unsupported: baselineSelection.unsupported, directories }, null, 2));
            process.stdout.write(`A/B pair ${pairs.length}/${options.pairs}: ${comparison.regression ? 'REGRESSION' : 'no correctness regression'}\n`);
            if (pairs.length >= 6 && pairs.length % 2 === 0 && comparison.resolved) { break; }
        }
        const comparison = comparePairs(pairs);
        const report = [
            '# Paired calibration',
            '',
            `Baseline: ${options.ref}; candidate: current workspace. Mode: ${options.mode}; retries: ${options.retries}; pairs: ${pairs.length}.`,
            '',
            `Correctness: **${comparison.regression ? 'REGRESSION' : 'no regression detected'}**. Secondary intervals: ${comparison.resolved ? 'resolved' : 'unresolved at pair limit'}.`,
            '',
            '| Test | Baseline only correct (b) | Candidate only correct (c) |',
            '| --- | ---: | ---: |',
            ...comparison.flips.map(flip => `| ${flip.id} | ${flip.b} | ${flip.c} |`),
            '',
            '| Metric | Mean candidate − baseline | 95% paired bootstrap interval |',
            '| --- | ---: | --- |',
            ...metricNames.map(name => `| ${name} | ${comparison.intervals[name].mean} | [${comparison.intervals[name].low}, ${comparison.intervals[name].high}] |`),
            '',
            `Absolute matched outcomes: baseline ${pairs.reduce((count, pair) => count + Object.values(pair.baseline.matched).filter(Boolean).length, 0)}/${pairs.length * common.length}; candidate ${pairs.reduce((count, pair) => count + Object.values(pair.candidate.matched).filter(Boolean).length, 0)}/${pairs.length * common.length}. Both sides failing the same case is not evidence of correctness.`,
            '',
            'Baseline not applicable (candidate results remain in its run reports):',
            ...baselineSelection.unsupported.map(test => `- ${test.id}: missing ${test.missing.join(', ')}`),
            '',
            `Raw pairs, execution order and run directories: ${join(output, 'pairs.json')}`,
            '',
        ].join('\n');
        await writeFile(`${output}.md`, report);
        process.stdout.write(`A/B report: ${output}.md\n`);
        return comparison;
    } catch (error) {
        runFailure = error;
        throw error;
    } finally {
        await cleanupCalibration(root, worktree, temporary, runFailure);
    }
}

/** A post-checkout hook can fail after registration, so inspect Git even when add rejected. */
export async function removeOwnedWorktree(root: string, worktree: string): Promise<void> {
    const { stdout } = await promisify(execFile)('git', ['worktree', 'list', '--porcelain', '-z'], { cwd: root });
    // Git lists the real path; a symlinked parent would hide the entry from a literal comparison.
    const real = await realpath(worktree).catch(() => worktree);
    const listed = stdout.split('\0');
    if (listed.includes(`worktree ${worktree}`) || listed.includes(`worktree ${real}`)) {
        await command('git', ['worktree', 'remove', '--force', worktree], root);
    }
}

async function cleanupCalibration(root: string, worktree: string, temporary: string, runFailure: unknown): Promise<void> {
    try {
        await removeOwnedWorktree(root, worktree);
        await rm(temporary, { recursive: true, force: true });
        await command('git', ['worktree', 'prune'], root);
    } catch (error) {
        process.stderr.write(`Calibration cleanup failed for ${worktree}: ${String(error)}\n`);
        throw runFailure === undefined ? error : new AggregateError([runFailure, error], 'Calibration and cleanup both failed');
    }
}
