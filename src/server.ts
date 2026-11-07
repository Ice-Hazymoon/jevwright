import type { SetupResult } from './config.ts';
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { JevwrightError } from './errors.ts';
import { checkedOrigin } from './origin.ts';

export interface ServerOptions {
    /** Shell command that starts the app, e.g. `npm run preview -- --port 4173`. */
    command: string;
    /** Where the started app answers; its origin becomes the run's `baseURL`. */
    url: string;
    cwd?: string;
    /** Added to the current environment. */
    env?: Record<string, string>;
    /** How long `url` may take to answer. Default 120 000. */
    timeoutMs?: number;
}

/** Statuses that mean a server is up, as Playwright's `webServer` counts them. */
const READY = (status: number) => (status >= 200 && status < 404) || status === 405;
const LOG_LIMIT = 256 * 1024;
const STOP_GRACE_MS = 5000;

/**
 * Starts the app for a run, modeled on Playwright's `webServer`: one process group per command, ready when
 * `url` answers, and the whole group stopped by `teardown` (SIGTERM, then SIGKILL) or, if the CLI is forced to
 * exit first, by an exit hook, so watchers and workers the command spawned never outlive the run. A port that
 * already answers is an error instead of a silent reuse of someone else's server.
 */
export async function startServer(options: ServerOptions, context: { signal?: AbortSignal; log?: (line: string) => void } = {}): Promise<SetupResult & { teardown: () => Promise<void> }> {
    const baseURL = checkedOrigin(options.url, 'server.url');
    if (await answers(options.url)) {
        throw new JevwrightError(`Something already answers at ${options.url}. Stop it, or test it as is with baseURL / --base-url instead of server.`);
    }
    let output = '';
    const child = spawn(options.command, { shell: true, detached: process.platform !== 'win32', cwd: options.cwd, env: { ...process.env, ...options.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const keep = (chunk: Buffer) => { output = (output + chunk.toString('utf8')).slice(-LOG_LIMIT); };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    const exited = new Promise<number | string>(resolve => child.once('exit', (code, signal) => resolve(code ?? signal ?? 'unknown')));
    const killOnExit = () => signalGroup(child, 'SIGKILL');
    process.once('exit', killOnExit);
    const teardown = async () => {
        process.off('exit', killOnExit);
        if (child.exitCode !== null || child.signalCode !== null) { return; }
        signalGroup(child, 'SIGTERM');
        const stopped = await Promise.race([exited.then(() => true), new Promise<false>(resolve => setTimeout(resolve, STOP_GRACE_MS, false))]);
        if (!stopped) { signalGroup(child, 'SIGKILL'); await exited; }
    };
    try {
        await waitUntilReady(options, exited, context);
    } catch (error) {
        await teardown();
        const tail = output.trim().split('\n').slice(-15).join('\n');
        throw new JevwrightError(`${error instanceof Error ? error.message : String(error)}${tail ? `\nLast server output:\n${tail}` : ''}`);
    }
    context.log?.(`App answers at ${baseURL} (pid ${child.pid})`);
    return { baseURL, serverLog: () => output, teardown };
}

async function waitUntilReady(options: ServerOptions, exited: Promise<number | string>, context: { signal?: AbortSignal }): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 120_000;
    const started = Date.now();
    let exit: number | string | undefined;
    void exited.then((code) => { exit = code; });
    for (let delay = 100; ; delay = Math.min(delay * 2, 1000)) {
        context.signal?.throwIfAborted();
        if (exit !== undefined) { throw new Error(`\`${options.command}\` exited (${exit}) before ${options.url} answered`); }
        if (await answers(options.url)) { return; }
        if (Date.now() - started >= timeoutMs) { throw new Error(`${options.url} did not answer within ${timeoutMs / 1000} s of \`${options.command}\``); }
        await new Promise(resolve => setTimeout(resolve, delay));
    }
}

async function answers(url: string): Promise<boolean> {
    try {
        const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(2000) });
        await response.body?.cancel();
        return READY(response.status);
    } catch {
        return false;
    }
}

/** The whole group: a shell's children (dev servers, watchers) do not die with the shell. */
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
    if (!child.pid) { return; }
    try {
        if (process.platform === 'win32') { child.kill(signal); } else { process.kill(-child.pid, signal); }
    } catch { /* Already gone. */ }
}
