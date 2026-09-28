import { connect } from 'node:net';
import { JevwrightError } from './errors.ts';

/**
 * Why `value` is not a bare http(s) origin such as `http://localhost:3000`, or undefined when it is one.
 * Paths belong in each test's `start`; a path here would be silently dropped.
 */
export function originProblem(value: unknown): string | undefined {
    let url: URL;
    try {
        url = new URL(String(value));
    } catch {
        return 'expected an http(s) URL such as http://localhost:3000';
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') { return `expected an http(s) URL, got a ${url.protocol} URL`; }
    if (url.username || url.password) { return 'must not contain credentials; sign in from a fixture instead'; }
    if (url.pathname !== '/' || url.search || url.hash) { return `expected an origin such as ${url.origin}, without a path; put paths in each test's \`start\``; }
    return undefined;
}

/** The origin of `value`; a JevwrightError naming `what` when it is not a bare http(s) origin. */
export function checkedOrigin(value: unknown, what: string): string {
    const problem = originProblem(value);
    if (problem) { throw new JevwrightError(`${what}: ${problem}`); }
    return new URL(String(value)).origin;
}

/**
 * Fails before any browser starts when nothing accepts connections at the app's origin; otherwise every test
 * would fail on its start page with the browser proxy's "Connection Refused".
 */
export async function assertReachable(origin: string, timeoutMs = 5000): Promise<void> {
    const url = new URL(origin);
    const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
    const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
    const problem = await new Promise<string | undefined>((resolve) => {
        const socket = connect({ host, port });
        const done = (result?: string) => {
            socket.destroy();
            resolve(result);
        };
        socket.setTimeout(timeoutMs, () => done(`no answer within ${timeoutMs / 1000} s`));
        socket.once('connect', () => done());
        socket.once('error', (error: NodeJS.ErrnoException) => done(error.code ?? error.message));
    });
    if (problem) {
        throw new JevwrightError(`Nothing answers at ${origin} (${problem}). Start the app, correct the base URL, or give the config a setup function that starts it.`);
    }
}
