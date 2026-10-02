import { realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { JevwrightError } from './errors.ts';

const paths = new WeakMap<FileRef, string>();
class FileValue { readonly kind = 'file' as const; }
export type FileRef = FileValue;
export function file(path: string): FileRef {
    if (typeof path !== 'string' || !path.trim()) { throw new JevwrightError('file() needs a nonempty path'); }
    const handle = Object.freeze(new FileValue()); paths.set(handle, path); return handle;
}
export interface ResolvedFile { path: string; name: string }
export async function resolveFiles(files: Readonly<Record<string, FileRef>> = {}, rootDir = process.cwd()): Promise<Record<string, ResolvedFile>> {
    const root = await realpath(rootDir).catch(() => { throw new JevwrightError('rootDir does not exist'); });
    const result: Record<string, ResolvedFile> = Object.create(null);
    for (const [key, handle] of Object.entries(files)) {
        const declared = paths.get(handle);
        if (declared === undefined) { throw new JevwrightError(`files.${key} must be a file() handle`); }
        const path = await realpath(resolve(root, declared)).catch(() => { throw new JevwrightError(`files.${key} does not exist`); });
        const inside = relative(root, path);
        if (inside === '..' || inside.startsWith('../') || isAbsolute(inside) || !(await stat(path)).isFile()) { throw new JevwrightError(`files.${key} must be a regular file inside rootDir`); }
        result[key] = { path, name: basename(path) };
    }
    return result;
}
