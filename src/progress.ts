/**
 * The run's log: every line goes to the output and is kept with its offset for `run.log`, and each running
 * test's last line is tracked, so a run that goes quiet says which test and step it is waiting on.
 */
export interface RunLog {
    log: (line: string) => void;
    /** Logs a test's start line as is and starts tracking it. */
    begin: (id: string, line: string) => void;
    /** A line from a running test; it becomes that test's latest known activity. */
    test: (id: string, line: string) => void;
    end: (id: string) => void;
    /** After `quietMs` without output, logs one line naming each running test's last activity and its age. */
    heartbeat: (now?: number) => void;
    text: () => string;
}

export function createRunLog(output: (line: string) => void, quietMs = 60_000): RunLog {
    const started = Date.now();
    const lines: string[] = [];
    const running = new Map<string, { line: string; at: number }>();
    let lastAt = started;
    const write = (line: string, at = Date.now()) => {
        lines.push(`${((at - started) / 1000).toFixed(1).padStart(8)}s ${line}`);
        lastAt = at;
        output(line);
    };
    return {
        log: line => write(line),
        begin(id, line) {
            running.set(id, { line: line.trim(), at: Date.now() });
            write(line);
        },
        test(id, line) {
            running.set(id, { line: line.trim(), at: Date.now() });
            write(`[${id}] ${line}`);
        },
        end: id => running.delete(id),
        heartbeat(now = Date.now()) {
            if (now - lastAt < quietMs) { return; }
            const seconds = (since: number) => Math.round((now - since) / 1000);
            const waiting = [...running].map(([id, last]) => `${id} (${seconds(last.at)}s since "${last.line}")`).join(', ');
            write(`… no output for ${seconds(lastAt)}s; still running: ${waiting || 'between tests'}`, now);
        },
        text: () => `${lines.join('\n')}\n`,
    };
}
