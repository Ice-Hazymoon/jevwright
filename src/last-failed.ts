import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { JevwrightError } from './errors.ts';

const manifestSchema = z.object({ finishedAt: z.iso.datetime(), cancelled: z.literal(true).optional() });
const summarySchema = z.object({
    manifest: manifestSchema,
    results: z.array(z.object({ id: z.string(), selectionKey: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(), status: z.enum(['failed', 'flaky', 'passed', 'known', 'skipped']) })),
});

/** Ignore running, interrupted, corrupt and partially published runs. Directory names do not establish completion order. */
export async function lastFailedIds(outputDir: string): Promise<Set<string>> {
    const entries = await readdir(outputDir, { withFileTypes: true }).catch((error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') { return []; }
        throw error;
    });
    let latest: { finishedAt: string; ids: Set<string> } | undefined;
    for (const entry of entries.filter(entry => entry.isDirectory())) {
        try {
            const directory = join(outputDir, entry.name);
            const manifest = manifestSchema.parse(JSON.parse(await readFile(join(directory, 'run.json'), 'utf8')));
            const summary = summarySchema.parse(JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8')));
            if (summary.manifest.finishedAt !== manifest.finishedAt || manifest.cancelled) { continue; }
            if (!latest || Date.parse(manifest.finishedAt) > Date.parse(latest.finishedAt)) {
                latest = { finishedAt: manifest.finishedAt, ids: new Set(summary.results.filter(test => test.status === 'failed' || test.status === 'flaky').map(test => test.selectionKey ?? test.id)) };
            }
        } catch { /* A running or partially written directory is not a completed run. */ }
    }
    if (!latest) { throw new JevwrightError('No completed run found for --last-failed'); }
    return latest.ids;
}
