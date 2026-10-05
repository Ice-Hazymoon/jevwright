/** Maintainer drift probes: seed a healthy recipe, then exercise the public CLI in replay mode without models. */
import type { TestSpec } from '../src/index.ts';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { main } from '../src/cli.ts';
import { act, check, runSuite } from '../src/index.ts';
import { startFixtureApp } from '../tests/fixtures/app.ts';
import { integrityPolicy } from '../tests/support/fixture-policy.ts';
import { scriptedModels } from '../tests/support/scripted-models.ts';

async function runProbes() {
    const directory = resolve(process.argv[2] ?? '.jevwright/integrity-probes');
    await mkdir(directory, { recursive: true });
    const app = await startFixtureApp();
    try {
        const recordingsDir = await mkdtemp(join(directory, 'recordings-'));
        const spec: TestSpec<void> = { id: 'draft-receipt', title: 'Store a draft', risk: 'Receipt is missing', start: '/integrity', steps: () => [act('Save draft')] };
        const models = scriptedModels(integrityPolicy);
        const seed = await runSuite([spec], { baseURL: app.origin, recordingsDir, outputDir: join(directory, 'seed'), models: models.settings, retries: 0, log: () => undefined });
        if (seed.results[0]?.status !== 'passed') { throw new Error(`Healthy seed failed: ${seed.results[0]?.summary}`); }
        const results: Array<Record<string, unknown>> = [];
        for (const bug of ['healthy', 'missing', 'half', 'query', 'alert', 'invalid', '500']) {
            const outputDir = join(directory, bug);
            const config = join(directory, `${bug}.config.mjs`);
            const settings = { baseURL: app.origin, recordingsDir, outputDir, retries: 0 };
            const definition = { id: spec.id, title: spec.title, risk: spec.risk, start: bug === 'healthy' ? '/integrity' : `/integrity?bug=${bug}` };
            await writeFile(config, `export default {...${JSON.stringify(settings)},tests:[{...${JSON.stringify(definition)},ready:async ({page})=>{await page.evaluate(()=>history.replaceState({},"","/integrity"))},steps:()=>[{kind:"act",instruction:"Save draft"}]}]};\n`);
            const exit = await main(['run', '--config', config, '--mode', 'replay'], { cwd: process.cwd(), env: {}, stdout: () => undefined, stderr: text => process.stderr.write(text) });
            const runs = (await readdir(outputDir)).sort();
            const report = JSON.parse(await readFile(join(outputDir, runs.at(-1)!, 'summary.json'), 'utf8'));
            const result = report.results[0];
            const row = { bug, exit, status: result.status, cause: result.cause, failure: result.attempts[0]?.steps[0]?.failure, summary: result.summary, jevCalls: report.totals.models.jevCalls, llmCalls: report.totals.models.llmCalls };
            results.push(row);
            process.stdout.write(`${JSON.stringify(row)}\n`);
        }
        const claim = 'The Draft field shows "Original"';
        const regionClaim = 'The Draft field in Draft area shows "Original"';
        const quoted: TestSpec<void> = { id: 'quoted-field', title: 'Read the draft', risk: 'The value changed', start: '/integrity', steps: () => [check(claim)] };
        const regional: TestSpec<void> = { ...quoted, id: 'region-quoted-field', start: '/integrity-region', steps: () => [check(regionClaim)] };
        const judges = scriptedModels(() => ({ holds: 0.99, support: 'supports', region: 'open' }));
        await runSuite([quoted, regional], { baseURL: app.origin, recordingsDir, outputDir: join(directory, 'check-seed'), models: judges.settings, retries: 0, log: () => undefined });
        let help = '';
        await main(['--help'], { cwd: process.cwd(), env: {}, stdout: (text) => { help += text; }, stderr: () => undefined });
        for (const probe of ['check-evidence', 'check-drift', 'check-region', 'check-legacy', ...(help.includes('--allow-unverified') ? ['check-allow'] : [])]) {
            const outputDir = join(directory, probe);
            const config = join(directory, `${probe}.config.mjs`);
            const settings = { baseURL: app.origin, recordingsDir, outputDir, retries: 0 };
            const region = probe === 'check-region';
            const definition = { id: region ? regional.id : probe === 'check-legacy' || probe === 'check-allow' ? 'unrecorded-check' : quoted.id, title: quoted.title, risk: quoted.risk, start: region ? '/integrity-region?bug=moved' : quoted.start };
            await writeFile(config, `export default {...${JSON.stringify(settings)},tests:[{...${JSON.stringify(definition)},${region ? 'ready:async ({page})=>{await page.evaluate(()=>history.replaceState({},"","/integrity-region"))},' : probe === 'check-drift' ? 'ready:async ({page})=>{await page.getByLabel("Draft").fill("Changed")},' : ''}steps:()=>[{kind:"check",assertion:${JSON.stringify(region ? regionClaim : claim)}}]}]};\n`);
            const exit = await main(['run', '--config', config, '--mode', 'replay', ...(probe === 'check-allow' ? ['--allow-unverified'] : [])], { cwd: process.cwd(), env: {}, stdout: () => undefined, stderr: text => process.stderr.write(text) });
            const runs = (await readdir(outputDir)).sort();
            const report = JSON.parse(await readFile(join(outputDir, runs.at(-1)!, 'summary.json'), 'utf8'));
            const result = report.results[0];
            const steps = result.attempts.flatMap((attempt: { steps: Array<{ kind: string; status: string; source?: string }> }) => attempt.steps).filter((step: { kind: string }) => step.kind === 'check');
            const row = { bug: probe, exit, status: result.status, cause: result.cause, checks: steps.map((step: { status: string; source?: string }) => ({ status: step.status, source: step.source })), jevCalls: report.totals.models.jevCalls, llmCalls: report.totals.models.llmCalls };
            results.push(row);
            process.stdout.write(`${JSON.stringify(row)}\n`);
        }
        await writeFile(join(directory, 'probes.json'), `${JSON.stringify(results, null, 2)}\n`);
    } finally { await app.close(); }
}

void runProbes().catch((error: unknown) => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; });
