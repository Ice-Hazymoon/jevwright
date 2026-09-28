import type { TestSpec } from './spec.ts';
import { JevwrightError } from './errors.ts';
import { templateKeys } from './spec.ts';

/** Which tests to run. Every field narrows the selection; each takes a comma-separated list. */
export interface TestFilter {
    /** Test ids; `prefix*` matches every id with that prefix. */
    test?: string;
    /** Modules (`TestSpec.module`). */
    module?: string;
    /** Tags; a test needs any one of them. */
    tag?: string;
}

const list = (value: string | undefined) => value?.split(',').map(item => item.trim()).filter(Boolean) ?? [];
const matchesId = (id: string, pattern: string) => pattern.endsWith('*') ? id.startsWith(pattern.slice(0, -1)) : id === pattern;

/** The tests a filter selects, in their defined order. A filter that selects nothing is an error, not an empty run. */
export function selectTests<T extends TestSpec<unknown>>(tests: readonly T[], filter: TestFilter = {}): T[] {
    const ids = list(filter.test);
    const modules = list(filter.module);
    const tags = list(filter.tag);
    const unknown = ids.filter(pattern => !tests.some(test => matchesId(test.id, pattern)));
    if (unknown.length) { throw new JevwrightError(`No test matches ${unknown.map(id => `"${id}"`).join(', ')}. Run \`jevwright list\` to see the test ids.`); }
    const selected = tests.filter(test => (!ids.length || ids.some(pattern => matchesId(test.id, pattern)))
        && (!modules.length || modules.includes(test.module ?? ''))
        && (!tags.length || tags.some(tag => test.tags?.includes(tag))));
    if (!selected.length) { throw new JevwrightError('No tests match the selection. Run `jevwright list` to see what is defined.'); }
    return selected;
}

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Catches authoring mistakes before anything starts: missing fields, duplicate or unsafe ids (an id names its
 * recording file), start paths that are not paths, and `{key}` references to data the test does not define.
 */
export function assertValidTests(tests: ReadonlyArray<TestSpec<unknown>>): void {
    const problems: string[] = [];
    const seen = new Set<string>();
    for (const [index, test] of tests.entries()) {
        if (!test || typeof test !== 'object') {
            problems.push(`Entry ${index + 1} is not a test. Did you pass a list of tests where a test was expected, or forget to spread one?`);
            continue;
        }
        const where = typeof test.id === 'string' && test.id ? `"${test.id}"` : `Test ${index + 1}`;
        if (isId(test.id) && seen.has(test.id)) { problems.push(`${where}: another test has the same id`); }
        seen.add(test.id);
        problems.push(...fieldProblems(test).map(problem => `${where}: ${problem}`));
    }
    if (problems.length) { throw new JevwrightError(`Invalid tests:\n  ${problems.join('\n  ')}`); }
}

const isId = (value: unknown): value is string => typeof value === 'string' && ID.test(value);
const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

/** What is wrong with one test's own fields, each phrased to follow the test's name. */
function fieldProblems(test: TestSpec<unknown>): string[] {
    const problems: string[] = [];
    if (!isId(test.id)) { problems.push('id must be lowercase kebab-case, e.g. "profile-save"'); }
    if (!isText(test.title)) { problems.push('title is required'); }
    if (!isText(test.risk)) { problems.push('risk is required (the business failure this test guards against)'); }
    if (typeof test.start !== 'string' || !test.start.startsWith('/')) { problems.push('start must be a path beginning with "/", e.g. "/settings"'); }
    if (typeof test.steps !== 'function') { problems.push('steps must be a function returning the steps'); }
    for (const [key, value] of Object.entries(test.data ?? {})) {
        if (typeof value !== 'string') { problems.push(`data.${key} must be a string`); }
    }
    problems.push(...undefinedKeys(test).map(key => `a step uses {${key}}, but data has no "${key}"`));
    return problems;
}

/**
 * `{key}` references in act and check steps that the test's data lacks. Steps usually do not touch the fixture
 * when they are built; when they do, this check is skipped and a bad key fails the step at run time instead.
 */
function undefinedKeys(test: TestSpec<unknown>): string[] {
    let steps: ReturnType<TestSpec<unknown>['steps']>;
    try {
        steps = test.steps(undefined);
    } catch {
        return [];
    }
    if (!Array.isArray(steps)) { return []; }
    const templates = steps.flatMap(step => step?.kind === 'act' ? [step.instruction] : step?.kind === 'check' ? [step.assertion] : []);
    return [...new Set(templates.flatMap(templateKeys))].filter(key => test.data?.[key] === undefined);
}
