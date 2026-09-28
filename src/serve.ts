import { randomBytes } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { JevwrightError } from './errors.ts';

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.md': 'text/markdown; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.zip': 'application/zip' };

/**
 * Serves one run directory read-only on 127.0.0.1; `port` 0 picks a free one. The returned URL carries a random
 * token, which the first request trades for an HttpOnly cookie; requests without either are refused.
 */
export async function serveReport(directory: string, port = 0): Promise<{ url: string; close: () => Promise<void> }> {
    const root = await realpath(resolve(directory));
    const token = randomBytes(18).toString('hex');
    const server = createServer(async (request, response) => {
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Referrer-Policy', 'no-referrer');
        if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405).end(); return; }
        const url = new URL(request.url ?? '/', 'http://localhost');
        const authorized = url.searchParams.get('token') === token || (request.headers.cookie ?? '').split(/;\s*/).includes(`jevwright=${token}`);
        if (!authorized) { response.writeHead(401).end('Unauthorized'); return; }
        if (url.searchParams.has('token')) { response.setHeader('Set-Cookie', `jevwright=${token}; HttpOnly; SameSite=Strict; Path=/`); }
        const relative = decodeURIComponent(url.pathname === '/' ? '/report.html' : url.pathname);
        try {
            const file = await realpath(join(root, relative));
            if (file !== root && !file.startsWith(root + sep)) { response.writeHead(404).end(); return; }
            response.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(await readFile(file));
        } catch {
            response.writeHead(404).end();
        }
    });
    await new Promise<void>((resolveListen, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolveListen); }).catch((error: NodeJS.ErrnoException) => {
        throw error.code === 'EADDRINUSE' || error.code === 'EACCES'
            ? new JevwrightError(`Cannot serve on port ${port} (${error.code === 'EADDRINUSE' ? 'already in use' : 'permission denied'}); pick another with --port, or leave it out for a free one`)
            : error;
    });
    const address = server.address();
    if (!address || typeof address === 'string') { throw new Error('Report server did not bind'); }
    return {
        url: `http://127.0.0.1:${address.port}/?token=${token}`,
        close: () => new Promise<void>((resolveClose) => { server.close(() => resolveClose()); server.closeAllConnections(); }),
    };
}
