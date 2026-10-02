/**
 * Maintainer calibration against the fixture app with real models: healthy flows must pass and every seeded
 * defect must fail with cause "product". Needs OPENROUTER_API_KEY or VERCEL_AI_GATEWAY_API_KEY; costs a few cents.
 *
 *   npm run calibrate -- [--mode ai|auto|replay] [--grep id] [--headed]
 */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { gatewayFromEnv, runSuite } from '../src/index.ts';
import { bindCancellationSignals } from '../src/signals.ts';
import { startFixtureApp } from '../tests/fixtures/app.ts';
import { runCalibrationAB } from './calibration-ab.ts';
import { fixtureTests } from './calibration-fixtures.ts';

async function main() {
    const { values } = parseArgs({ options: { mode: { type: 'string', default: process.argv.includes('--ab') || process.argv.some(arg => arg.startsWith('--ab=')) ? 'auto' : 'ai' }, grep: { type: 'string' }, headed: { type: 'boolean' }, ab: { type: 'string' }, pairs: { type: 'string' }, retries: { type: 'string' } } });
    const mode = values.mode as 'ai' | 'auto' | 'replay';
    if (!['ai', 'auto', 'replay'].includes(mode)) { throw new Error('mode must be ai, auto or replay'); }
    const pairs = Number(values.pairs ?? 20);
    const retries = Number(values.retries ?? (values.ab ? 1 : 0));
    if (!Number.isInteger(retries) || retries < 0) { throw new Error('retries must be a nonnegative integer'); }
    if (values.ab && (!Number.isInteger(pairs) || pairs < 6 || pairs > 20 || mode === 'replay')) { throw new Error('A/B needs 6–20 pairs and mode auto or ai'); }
    const gateway = gatewayFromEnv(process.env);
    const controller = new AbortController();
    const unbind = bindCancellationSignals(controller);
    const app = await startFixtureApp();
    try {
        const tests = fixtureTests(app).filter(test => !values.grep || test.id.includes(values.grep));
        if (values.ab) {
            const result = await runCalibrationAB(tests, app, { ref: values.ab, pairs, retries, mode: mode as 'auto' | 'ai', headless: !values.headed, models: gateway, signal: controller.signal });
            process.exitCode = controller.signal.aborted ? 130 : result.regression ? 1 : 0;
            return;
        }
        const summary = await runSuite(tests, {
            baseURL: app.origin,
            outputDir: resolve('.jevwright/calibration'),
            recordingsDir: resolve('.jevwright/calibration-recordings'),
            mode,
            // The fixture app shares state between tests; run serially.
            concurrency: 1,
            retries,
            headless: !values.headed,
            signal: controller.signal,
            models: gateway,
            probe: true,
            translationKeys: ['settings.profile.title'],
        });
        let matched = 0;
        for (const result of summary.results) {
            const expected = tests.find(test => test.id === result.id)!.expected;
            const actual = result.status === 'passed' ? 'passed' : result.cause;
            const ok = actual === expected;
            if (ok) { matched++; }
            process.stdout.write(`${ok ? 'OK ' : 'BAD'} ${result.id}: expected ${expected}, got ${actual} — ${result.summary}\n`);
        }
        process.stdout.write(`${matched}/${summary.results.length} matched expectations · ${summary.totals.models.jevCalls} Jev / ${summary.totals.models.llmCalls} LLM calls · $${summary.totals.models.cost.toFixed(4)} · report ${summary.directory}/report.html\n`);
        process.exitCode = controller.signal.aborted ? 130 : matched === summary.results.length ? 0 : 1;
    } catch (error) {
        if (!controller.signal.aborted) { throw error; }
        process.exitCode = 130;
    } finally {
        await app.close();
        unbind();
    }
}

void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
});
