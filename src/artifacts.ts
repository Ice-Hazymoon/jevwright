import type { Redactor } from './secrets.ts';
import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { unzipSync, zipSync } from 'fflate';

/** The sole text-artifact write boundary. Callers pass the run's complete redactor. */
export async function writeArtifact(path: string, contents: string, redact: Redactor): Promise<void> {
    await writeFile(path, redact.text(contents));
}

/** Text resources are redacted; binary resources containing a secret are discarded. Fail closed. */
export async function redactTrace(path: string, redact: Redactor): Promise<boolean> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
        const entries = unzipSync(await readFile(path));
        const decoder = new TextDecoder('utf-8', { fatal: true });
        for (const [originalName, bytes] of Object.entries(entries)) {
            const name = redact.text(originalName);
            if (name !== originalName) { delete entries[originalName]; }
            let text: string;
            try { text = decoder.decode(bytes); }
            catch {
                if (redact.contains(Buffer.from(bytes).toString('utf8'))) { delete entries[name]; }
                else { entries[name] = bytes; }
                continue;
            }
            entries[name] = new TextEncoder().encode(redact.text(text));
        }
        await writeFile(temporary, zipSync(entries));
        await rename(temporary, path);
        return true;
    } catch {
        await rm(path, { force: true });
        return false;
    } finally { await rm(temporary, { force: true }); }
}
