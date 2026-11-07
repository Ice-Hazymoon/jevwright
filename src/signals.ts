/**
 * The entrypoint owns process termination until its outer resource cleanup completes. A ladder, as in
 * tester-army/e2e `SignalLadder`: the first signal aborts `controller` so the run stops and cleans up; the
 * second stops waiting for tests but still runs `onForce` (the app's teardown, bounded by the caller) so a
 * started dev server is not orphaned; the third exits at once with 130.
 */
export function bindCancellationSignals(controller: AbortController, notify: (line: string) => void = () => {}, onForce: () => Promise<void> = async () => {}): () => void {
    let presses = 0;
    const stop = () => {
        presses++;
        if (presses === 1) {
            notify('Stopping: finishing cleanup (press Ctrl-C again to skip to teardown)…');
            controller.abort();
            return;
        }
        if (presses === 2) {
            notify('Interrupted again; stopping the app, then exiting (press Ctrl-C once more to quit at once)…');
            void onForce().catch(() => undefined).finally(() => process.exit(130));
            return;
        }
        notify('Exiting without teardown.');
        process.exit(130);
    };
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
    for (const signal of signals) { process.on(signal, stop); }
    return () => { for (const signal of signals) { process.off(signal, stop); } };
}
