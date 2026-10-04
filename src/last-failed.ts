import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { JevwrightError } from './errors.ts';

const manifestSchema = z.object({ finishedAt: z.iso.datetime(), cancelled: z.literal(true).optional(), carriedFailures: z.array(z.string()).optional() });
const summarySchema = z.object({
    manifest: manifestSchema,
    results: z.array(z.object({ id: z.string(), selectionKey: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(), status: z.enum(['failed', 'flaky', 'passed', 'known', 'skipped', 'unverified', 'interrupted']) })),
});

/** Ignore running, interrupted, corrupt and partially published runs. Directory names do not establish completion order. */
export async function lastFailedIds(outputDir: string): Promise<Set<string>> {
    const entries = await readdir(outputDir, { withFileTypes: true }).catch((error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') { return []; }
        throw error;
    });
    const completed: Array<{ finishedAt: string; results: z.infer<typeof summarySchema>['results']; carriedFailures?: string[] }> = [];
    for (const entry of entries.filter(entry => entry.isDirectory())) {
        try {
            const directory = join(outputDir, entry.name);
            const manifest = manifestSchema.parse(JSON.parse(await readFile(join(directory, 'run.json'), 'utf8')));
            const summary = summarySchema.parse(JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8')));
            if (summary.manifest.finishedAt !== manifest.finishedAt || manifest.cancelled) { continue; }
            completed.push({ finishedAt: manifest.finishedAt, results: summary.results, carriedFailures: manifest.carriedFailures });
        } catch { /* A running or partially written directory is not a completed run. */ }
    }
    if (!completed.length) { throw new JevwrightError('No completed run found for --last-failed'); }
    const ids = new Set<string>();
    for (const run of completed.toSorted((a, b) => Date.parse(a.finishedAt) - Date.parse(b.finishedAt))) {
        for (const key of run.carriedFailures ?? []) { ids.add(key); }
        for (const test of run.results) {
            const key = test.selectionKey ?? test.id;
            if (test.status === 'failed' || test.status === 'flaky' || test.status === 'unverified') { ids.add(key); }
            else if (test.status === 'passed' || test.status === 'known') { ids.delete(key); ids.delete(test.id); }
        }
    }
    return ids;
}
