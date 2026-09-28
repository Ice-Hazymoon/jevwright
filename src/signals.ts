/**
 * The entrypoint owns process termination until its outer resource cleanup completes. The first signal aborts
 * `controller` so the run can stop and clean up; a second one exits at once with 130.
 */
export function bindCancellationSignals(controller: AbortController, notify: (line: string) => void = () => {}): () => void {
    const stop = () => {
        if (controller.signal.aborted) {
            notify('Interrupted again; exiting without waiting for cleanup.');
            process.exit(130);
        }
        notify('Stopping: finishing cleanup (press Ctrl-C again to quit at once)…');
        controller.abort();
    };
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
    for (const signal of signals) { process.on(signal, stop); }
    return () => { for (const signal of signals) { process.off(signal, stop); } };
}
