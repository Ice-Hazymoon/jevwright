import { resolve } from 'node:path';
import { act, check, gatewayFromEnv, runSuite, verify } from '../src/index.ts';
import { bindCancellationSignals } from '../src/signals.ts';
import { startFixtureApp } from '../tests/fixtures/app.ts';

const controller = new AbortController();
const unbind = bindCancellationSignals(controller);
const app = await startFixtureApp();
try {
    const tests = [
        ...(['loading', 'empty', 'collapsed', 'unselected'] as const).map(region => ({ id: `attribution-${region}`, title: 'Inspect delivery records', risk: 'Missing content is attributed to the wrong actor', start: `/attribution-regions?region=${region}`, expected: region === 'loading' || region === 'empty' ? 'product' : 'agent', steps: () => [check('The delivery records show Record ZX-71')] })),
        { id: 'attribution-resolved', title: 'Wait for delivery records', risk: 'Transient loading is reported as a defect', start: '/attribution-regions?region=loading&resolve=1', expected: 'passed', steps: () => [check('The delivery records show Record ZX-71')] },
        { id: 'attribution-sequence', title: 'Enter an observed sequence', risk: 'Segmented input exhausts the helper budget', start: '/attribution-segments', expected: 'passed', steps: () => [act('Enter the six-digit access sequence displayed on the page across the segmented inputs and verify access'), verify('access granted', async ({ page }) => (await page.locator('output').textContent()) === 'Access granted')] },
        { id: 'attribution-sort', title: 'Inspect ordering', risk: 'An action stage hides broken ordering', start: '/attribution-sort', expected: 'product', steps: () => [act('Sort the entries by amount ascending'), check('The entry amounts are ascending')] },
        { id: 'attribution-removal', title: 'Inspect removed entry', risk: 'A toast hides a retained entry', start: '/attribution-retained-entry', expected: 'product', steps: () => [act('Remove the Retired entry'), check('The removed entry is absent from the directory')] },
    ] satisfies Array<import('../src/index.ts').TestSpec<void> & { expected: string }>;
    const summary = await runSuite(tests, { baseURL: app.origin, mode: 'ai', concurrency: 1, retries: 0, recordingsDir: resolve('.jevwright/attribution-recordings'), outputDir: resolve('.jevwright/attribution-calibration'), models: gatewayFromEnv(), signal: controller.signal });
    let matched = 0;
    for (const result of summary.results) {
        const expected = tests.find(test => test.id === result.id)!.expected;
        const actual = result.status === 'passed' ? 'passed' : result.cause;
        const ok = actual === expected;
        if (ok) { matched++; }
        process.stdout.write(`${ok ? 'OK' : 'BAD'} ${result.id}: expected ${expected}, got ${actual} — ${result.summary}\n`);
    }
    process.stdout.write(`${matched}/${tests.length} matched expectations · report ${summary.directory}/report.html\n`);
    process.exitCode = controller.signal.aborted ? 130 : matched === tests.length ? 0 : 1;
} finally {
    await app.close();
    unbind();
}
