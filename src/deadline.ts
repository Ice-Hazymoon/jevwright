/**
 * Bounded waits. An abort signal only stops code that listens to it; user callbacks, `page.evaluate` on a
 * frozen renderer and browser shutdown do not. These helpers stop *waiting* instead, so the caller can
 * close what the abandoned work holds (the browser context) and report where it stopped.
 * Modeled on tester-army/e2e `withAbort` (packages/e2e/src/internal/time.ts) and Stagehand's `Progress`.
 */

/** Resolves with `work`, or rejects with the signal's reason once it aborts. Late results and errors are dropped. */
export function untilAborted<T>(work: PromiseLike<T> | (() => PromiseLike<T>), signal: AbortSignal): Promise<T> {
    if (signal.aborted) { return Promise.reject(signal.reason); }
    const pending = Promise.resolve().then(() => typeof work === 'function' ? work() : work);
    return new Promise<T>((resolve, reject) => {
        const stop = () => reject(signal.reason);
        signal.addEventListener('abort', stop, { once: true });
        pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
    });
}

/** Marks a wait that ran out in `within`; the work behind it is abandoned. */
export const TIMED_OUT: unique symbol = Symbol('timed out');

/** Waits at most `ms` for best-effort work (cleanup, shutdown, flushing); its errors reject as usual. */
export async function within<T>(work: PromiseLike<T> | (() => PromiseLike<T>), ms: number): Promise<T | typeof TIMED_OUT> {
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<typeof TIMED_OUT>((resolve) => { timer = setTimeout(resolve, ms, TIMED_OUT); });
    try {
        return await Promise.race([Promise.resolve().then(() => typeof work === 'function' ? work() : work), expired]);
    } finally {
        clearTimeout(timer);
    }
}
