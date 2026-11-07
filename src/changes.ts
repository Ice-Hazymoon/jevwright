import type { Models, Question } from './models.ts';
import type { TestSpec } from './spec.ts';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { JevwrightError } from './errors.ts';
import { probabilityOf } from './models.ts';
import { describeStep } from './spec.ts';

/**
 * Selecting tests by what a change can affect (`--changed-since <ref>`), modeled on tester-army/e2e's decision
 * filter (docs/filters.mdx): rule-based keeps first, then one Jev boolean per test over the committed diff.
 * It fails open everywhere: any doubt, error or missing model keeps the test.
 */

/** Below this probability that the change affects a test, the test is left out. */
export const AFFECTED_BELOW = 0.2;
/** A larger committed diff cannot be judged in one request; every test runs. */
const MAX_DIFF_BYTES = 60_000;
/** Tests per Jev request: one boolean question each over the same diff. */
const BATCH = 8;
const LOCKFILES = new Set(['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb']);

export interface ChangeSet {
    ref: string;
    base: string;
    /** Changed paths relative to the repository root: committed, uncommitted and untracked. */
    files: string[];
    /** The committed diff since the merge base; uncommitted work is known by name only. */
    diff: string;
    root: string;
}

export interface ChangeDecision {
    id: string;
    run: boolean;
    reason: string;
    /** Jev's probability that the change affects the test, when it was asked. */
    affected?: number;
}

const git = async (cwd: string, args: string[]) => (await promisify(execFile)('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 })).stdout;

/** What changed between the merge base of `ref` and `HEAD`, plus the working tree. Unmeasurable is an error, not "nothing changed". */
export async function changesSince(ref: string, cwd: string): Promise<ChangeSet> {
    try {
        const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
        const base = (await git(cwd, ['merge-base', ref, 'HEAD'])).trim();
        const names = (args: string[]) => git(root, args).then(out => out.split('\n').filter(Boolean));
        const files = [...new Set([...await names(['diff', '--name-only', base]), ...await names(['ls-files', '--others', '--exclude-standard'])])];
        const diff = await git(root, ['diff', '--no-color', `${base}...HEAD`]);
        return { ref, base, files, diff, root };
    } catch (error) {
        throw new JevwrightError(`--changed-since ${ref}: git cannot measure the change (${error instanceof Error ? error.message.split('\n')[0] : String(error)}). Fetch the base branch with full history (actions/checkout fetch-depth: 0).`);
    }
}

/**
 * Which tests the change can affect. Kept without asking a model: everything when nothing or the config,
 * a manifest or a lockfile changed, or the diff is too large; a test whose id appears in a changed file
 * (its definition or recording). The rest are asked of Jev; a failed call keeps its tests.
 */
export async function decideChanged(tests: ReadonlyArray<TestSpec<unknown>>, changes: ChangeSet, options: { configFile: string; models?: Models; signal: AbortSignal }): Promise<ChangeDecision[]> {
    const all = (reason: string) => tests.map(test => ({ id: test.id, run: true, reason }));
    if (!changes.files.length) { return all('no change detected since the merge base'); }
    const config = relative(changes.root, resolve(options.configFile));
    const global = changes.files.find(file => file === config || LOCKFILES.has(basename(file)) || /^jevwright\.config\.[mc]?[jt]s$/.test(basename(file)));
    if (global) { return all(`${global} changed`); }
    if (Buffer.byteLength(changes.diff) > MAX_DIFF_BYTES) { return all(`the diff is over ${MAX_DIFF_BYTES / 1000} kB`); }
    if (!options.models) { return all('no model key to judge the change'); }
    const named = await namedInChanges(tests, changes);
    const decisions = new Map<string, ChangeDecision>(tests.filter(test => named.has(test.id)).map(test => [test.id, { id: test.id, run: true, reason: `named in ${named.get(test.id)}` }]));
    const asked = tests.filter(test => !decisions.has(test.id));
    for (let start = 0; start < asked.length; start += BATCH) {
        const batch = asked.slice(start, start + BATCH);
        for (const decision of await judgeBatch(batch, changes, options.models, options.signal)) { decisions.set(decision.id, decision); }
    }
    return tests.map(test => decisions.get(test.id)!);
}

/** Tests whose id a changed file mentions as a literal: the test file or its recording changed. */
async function namedInChanges(tests: ReadonlyArray<TestSpec<unknown>>, changes: ChangeSet): Promise<Map<string, string>> {
    const named = new Map<string, string>();
    for (const file of changes.files) {
        const text = await readFile(resolve(changes.root, file), 'utf8').catch(() => '');
        for (const test of tests) {
            if (!named.has(test.id) && (basename(file) === `${test.id}.json` || new RegExp(`['"\`]${test.id}['"\`]`).test(text))) { named.set(test.id, file); }
        }
    }
    return named;
}

async function judgeBatch(batch: ReadonlyArray<TestSpec<unknown>>, changes: ChangeSet, models: Models, signal: AbortSignal): Promise<ChangeDecision[]> {
    const questions: Record<string, Question> = Object.fromEntries(batch.map((test, index) => [`affected_${index}`, {
        type: 'boolean',
        instructions: `Could the code change in \`change.diff\` alter what test \`tests.t${index}\` does on screen or what it checks (its pages, flows, requests and stored data)? Changes to unrelated features, docs, tooling or other tests do not count. Answer true when unsure.`,
    } satisfies Question]));
    const state = {
        change: { changed_files: changes.files.slice(0, 200), diff: changes.diff },
        tests: Object.fromEntries(batch.map((test, index) => [`t${index}`, { title: test.title, risk: test.risk, module: test.module ?? null, start: test.start, steps: stepsOf(test) }])),
    };
    try {
        const answers = await models.judge(state, questions, signal, 'change selection');
        return batch.map((test, index) => {
            const affected = probabilityOf(answers[`affected_${index}`]);
            return affected < AFFECTED_BELOW
                ? { id: test.id, run: false, reason: `Jev judged the change unlikely to affect it (p=${affected.toFixed(2)})`, affected }
                : { id: test.id, run: true, reason: `Jev judged the change may affect it (p=${affected.toFixed(2)})`, affected };
        });
    } catch (error) {
        return batch.map(test => ({ id: test.id, run: true, reason: `could not judge the change (${error instanceof Error ? error.message.slice(0, 120) : String(error)})` }));
    }
}

/** Step wording without data values or secrets; fixture-dependent steps are left out. */
function stepsOf(test: TestSpec<unknown>): string[] {
    try { return test.steps(undefined as never).map(step => describeStep(step)); } catch { return []; }
}
