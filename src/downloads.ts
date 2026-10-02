import type { Download } from 'playwright';
import type { DownloadRecord, Expectation } from './spec.ts';
import type { Redactor } from './secrets.ts';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_BYTES = 20 * 1024 * 1024;
/** Downloads belong to the step that started them, even when transfer finishes later. */
export function createDownloads(directory: string, signal: AbortSignal, redact?: Redactor) {
    const records: DownloadRecord[] = [];
    const byStep = new Map<number, DownloadRecord[]>();
    const errors = new Map<number, string>();
    const pending = new Set<Promise<void>>();
    const active = new Set<Download>();
    let step = -1;
    let expected: Expectation['download'];
    let sequence = 0;
    let closing = false;
    const cancel = () => { for (const download of active) { void download.cancel().catch(() => undefined); } };
    signal.addEventListener('abort', cancel, { once: true });
    return {
        records,
        setStep(index: number, rule?: Expectation['download']) { step = index; expected = rule; },
        forStep(index: number) { return byStep.get(index) ?? []; },
        receive(download: Download) {
            const index = step;
            if (closing || !expected || signal.aborted) { void download.cancel().catch(() => undefined); return; }
            const number = ++sequence;
            const filename = download.suggestedFilename();
            active.add(download);
            const timer = setTimeout(() => { errors.set(index, 'Download did not finish within 30 seconds'); void download.cancel().catch(() => undefined); }, 30_000);
            const job = (async () => {
                const folder = join(directory, 'downloads');
                // The suggested name is untrusted; never use it as an output path.
                const path = join(folder, `${number}.download`);
                try {
                    await mkdir(folder, { recursive: true });
                    await download.saveAs(path);
                    const bytes = (await stat(path)).size;
                    if (bytes > MAX_BYTES) { throw new Error('Download exceeds the 20 MiB limit'); }
                    if (errors.has(index)) { throw new Error(errors.get(index)); }
                    const record = { filename, path, bytes };
                    records.push(record);
                    byStep.set(index, [...(byStep.get(index) ?? []), record]);
                } catch (error) {
                    errors.set(index, error instanceof Error ? error.message : 'Download failed');
                    await rm(path, { force: true });
                } finally {
                    clearTimeout(timer);
                    active.delete(download);
                }
            })();
            pending.add(job);
            void job.then(() => pending.delete(job), () => pending.delete(job));
        },
        state() {
            const error = errors.get(step);
            if (error) { return { ok: false, violated: true, reason: error }; }
            const downloaded = byStep.get(step) ?? [];
            const pattern = expected?.filename;
            const matched = downloaded.some(record => { if (!pattern) { return true; } pattern.lastIndex = 0; return pattern.test(record.filename); });
            return matched ? { ok: true } : { ok: false, reason: pattern ? `No download matched ${String(pattern)}` : 'No download completed during this step' };
        },
        async flush() { await Promise.all(pending); },
        async close() {
            closing = true;
            signal.removeEventListener('abort', cancel); cancel(); await Promise.all(pending);
            if (redact?.active) {
                for (const record of records) {
                    let withhold = true;
                    try { withhold = redact.contains((await readFile(record.path)).toString('utf8')); } catch { /* Unreadable files cannot be verified safe. */ }
                    if (withhold) { await rm(record.path, { force: true }); record.withheld = true; }
                }
            }
        },
    };
}
