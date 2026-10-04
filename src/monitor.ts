import type { WriteExpectation, WriteRecord } from './spec.ts';
import type { BrowserContext, ConsoleMessage, Page, Request, Response } from 'playwright';

export type IssueKind = 'page-error' | 'asset-load' | 'app-unreachable' | 'console-error' | 'hydration-mismatch' | 'http-5xx' | 'http-4xx' | 'request-failed' | 'raw-i18n-key' | 'text-anomaly' | 'ui-error' | 'semantic' | 'accessibility';
export type Severity = 'high' | 'medium' | 'low';

/** A signal that the product may be wrong, independent of the test's own assertions. */
export interface Issue {
    kind: IssueKind;
    severity: Severity;
    /** Step during which it was first seen; -1 means setup/initial load. */
    step: number;
    message: string;
    detail?: string;
    count: number;
}

export interface MonitorOptions {
    redact?: import('./secrets.ts').Redactor;
    /** The app's origin: relative paths in expectations and messages refer to it. */
    origin: string;
    /** Further origins that belong to the app (a separate API or auth server); monitored like `origin`. */
    allowedOrigins?: readonly string[];
    expectedHttp?: ReadonlyArray<WriteExpectation & { status: number | readonly number[] }>;
    ignoreConsole?: readonly RegExp[];
    /** Known translation keys; any of them rendered verbatim is a missing-translation bug. */
    i18nKeys?: ReadonlySet<string>;
    /** Requests the test itself aborts; neither the failed request nor its console line is reported. */
    expectedAborts?: readonly WriteExpectation[];
}

// Dev-server and third-party noise that says nothing about product behavior.
const CONSOLE_NOISE = [
    /Failed to load resource: the server responded with a status of \d+/i,
    /\[vite\]|\[hmr\]|webpack/i,
    /Download the Vue Devtools|DevTools/i,
    /net::ERR_ABORTED/,
    // Our own origin allowlist refused the request; run.json lists blocked origins.
    /net::ERR_TUNNEL_CONNECTION_FAILED/,
    // The host's network changed (interfaces or routes); Chromium drops what was in flight.
    /net::ERR_NETWORK_CHANGED/,
    /ResizeObserver loop/i,
];

// The app's own code failed to download: a dev server re-optimizing its dependencies, or a deploy replacing the
// build under an open page. It blocks the page but says nothing about how the page behaves.
const ASSET_LOAD = /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i;

/** A line that on its own announces a server error page, e.g. a status chip reading "Error 500". */
const ERROR_SCREEN = /^(?:(?:Error|HTTP)\s*5\d\d|5\d\d\s+(?:Internal\s+)?Server\s+Error|Internal\s+Server\s+Error)$/i;

/**
 * Statuses the browser's proxy answers with when it cannot reach the app (590 Non Successful … 599 Upstream
 * Error; 594 is Connection Refused). The app itself is down or restarting: an environment problem.
 */
const unreachable = (status: number) => status >= 590 && status <= 599;

/** Client errors worth reporting: the app's own data requests and page loads, not a missing favicon. */
const REPORTED_4XX = new Set(['fetch', 'xhr', 'document']);

/** Chromium's console line for a request that failed at the network level (as `route.abort()` does). */
const RESOURCE_LOAD_FAILURE = /^Failed to load resource: net::/i;

const SENTINELS: Array<[RegExp, string]> = [
    [/\bundefined\b/, 'Rendered "undefined"'],
    [/\bNaN\b/, 'Rendered "NaN"'],
    [/\[object Object\]/, 'Rendered "[object Object]"'],
    [/\bInvalid Date\b/, 'Rendered "Invalid Date"'],
    [/\{\{[^}]{1,40}\}\}/, 'Unrendered template placeholder'],
    [/(?:^|\s)\{[a-z]\w{1,30}\}(?:\s|$)/, 'Uninterpolated translation parameter'],
];

const PAGE_DATA = new Set(['fetch', 'xhr', 'document']);
const APP_CODE = new Set(['script', 'stylesheet']);

/**
 * Requests whose arrival can still change what the page shows. The app's own code counts: a lazily imported
 * component renders nothing until its module arrives, and a dev server compiles each one on first request,
 * long after the DOM went quiet.
 */
function changesPage(type: string, sameOrigin: boolean): boolean {
    return PAGE_DATA.has(type) || (sameOrigin && APP_CODE.has(type));
}

/**
 * Tracks writes and implicit oracles for one browser context. Everything here is deterministic:
 * uncaught exceptions, server errors, unexpected client errors and broken rendered text.
 */
export function createMonitor(context: BrowserContext, options: MonitorOptions) {
    const safe = (text: string) => options.redact?.text(text) ?? text;
    const origin = new URL(options.origin).origin;
    const appOrigins = new Set([origin, ...(options.allowedOrigins ?? []).map(value => new URL(value).origin)]);
    const issues = new Map<string, Issue>();
    const writes: WriteRecord[] = [];
    const inflight = new Map<Request, number>();
    const byRequest = new Map<Request, WriteRecord>();
    let step = -1;
    let writeId = 0;
    const responseEvidence = new Set<Promise<void>>();

    const add = (issue: Omit<Issue, 'count' | 'step'>) => {
        const key = `${issue.kind}|${issue.message}`;
        const existing = issues.get(key);
        if (existing) { existing.count++; return; }
        issues.set(key, { ...issue, step, count: 1 });
    };
    const ofApp = (url: string) => {
        try { return appOrigins.has(new URL(url).origin); } catch { return false; }
    };
    // Paths on the app's own origin read as `/api/x`; another app origin keeps its host.
    const where = (url: URL) => url.origin === origin ? url.pathname : `${url.host}${url.pathname}`;
    // Non-2xx outcomes an `expectError` step declares; expected only for writes that step sent.
    const stepExpectations = new Map<number, readonly WriteExpectation[]>();
    const expected = (method: string, path: string, status: number, atStep: number | undefined) => (options.expectedHttp ?? []).some(rule => matchesWrite(rule, method, path, status))
        || (atStep !== undefined && (stepExpectations.get(atStep) ?? []).some(rule => rule.status !== undefined && matchesWrite(rule, method, path, status)));
    // The test itself aborted this request (e.g. `route.abort('failed')`); method is known for the failed
    // request, but a "Failed to load resource" console line carries only the URL, so that side matches by path.
    const declaredAbort = (method: string, path: string) => (options.expectedAborts ?? []).some(rule => matchesWrite(rule, method, path));
    const declaredAbortPath = (path: string) => (options.expectedAborts ?? []).some(rule => typeof rule.path === 'string' ? rule.path === path : rule.path.test(path));

    const watchPage = (page: Page) => {
        page.on('pageerror', (error) => {
            if (ASSET_LOAD.test(error.message)) {
                add({ kind: 'asset-load', severity: 'high', message: firstLine(safe(error.message)) });
                return;
            }
            add({ kind: 'page-error', severity: 'high', message: firstLine(safe(error.message)), detail: error.stack ? safe(error.stack).split('\n').slice(0, 4).join('\n') : undefined });
        });
        let hydrationWarnings = 0;
        // Dev-server noise and requests the test itself aborted; only a real console error is worth reporting.
        const isReportableConsoleError = (text: string, url: string): boolean => {
            if (CONSOLE_NOISE.some(pattern => pattern.test(text)) || options.ignoreConsole?.some(pattern => pattern.test(text))) { return false; }
            // Chromium logs this for the request a declared `route.abort()` broke; correlate by the
            // resource URL the browser attaches to the message (there is no method to match on here).
            return !(RESOURCE_LOAD_FAILURE.test(text) && declaredAbortPath(shortPath(url)));
        };
        page.on('console', (message) => {
            const text = message.text();
            // SSR/client divergence: Vue's warning names the node and both values.
            if (message.type() === 'warning' && /Hydration .*mismatch/i.test(text)) {
                hydrationWarnings++;
                const path = shortPath(page.url());
                void consoleText(message).then((described) => {
                    const lines = safe(described).split('\n').map(line => line.trim()).filter(Boolean);
                    add({ kind: 'hydration-mismatch', severity: 'medium', message: `${lines[0]!.replace(/^\[Vue warn\]:\s*/, '').slice(0, 200)} on ${path}`, detail: lines.slice(1, 6).join('\n').slice(0, 600) });
                });
                return;
            }
            // Vue's closing summary; the warnings before it carry the detail. Without them (production builds) it is the only signal.
            if (message.type() === 'error' && text.startsWith('Hydration completed but contains mismatches')) {
                if (!hydrationWarnings) { add({ kind: 'hydration-mismatch', severity: 'medium', message: `Hydration completed but contains mismatches on ${shortPath(page.url())}` }); }
                return;
            }
            if (message.type() !== 'error') { return; }
            if (!isReportableConsoleError(text, message.location().url)) { return; }
            add({ kind: 'console-error', severity: 'medium', message: firstLine(safe(text)).slice(0, 240) });
        });
    };
    context.on('page', watchPage);
    for (const page of context.pages()) { watchPage(page); }

    const onRequest = (request: Request) => {
        const type = request.resourceType();
        if (changesPage(type, ofApp(request.url()))) { inflight.set(request, Date.now()); }
        if (!ofApp(request.url()) || (type !== 'fetch' && type !== 'xhr')) { return; }
        const method = request.method();
        if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') { return; }
        const record: WriteRecord = { id: ++writeId, step, method, path: new URL(request.url()).pathname, status: 'pending' };
        writes.push(record);
        byRequest.set(request, record);
    };
    context.on('request', onRequest);
    // Judged once headers arrive: the body can still be cut off (a navigation right after, save → reload, or an
    // opaque cross-origin response), and then `requestfinished` never fires for that request.
    const onResponse = (response: Response) => {
        const request = response.request();
        const record = byRequest.get(request);
        if (record?.status === 'pending') { record.status = response.status(); }
        if (!ofApp(request.url())) { return; }
        const status = response.status();
        if (record && status >= 400 && status < 500 && !expected(request.method(), record.path, status, record.step)) {
            const evidence = response.text().then(body => {
                if (/validation|invalid|required|unprocessable/i.test(body)) { record.validationError = safe(body).slice(0, 600); }
            }).catch(() => undefined);
            responseEvidence.add(evidence);
            void evidence.finally(() => responseEvidence.delete(evidence));
        }
        const url = new URL(request.url());
        const path = url.pathname;
        const line = `${request.method()} ${where(url)} → ${status}`;
        if (unreachable(status)) {
            const reason = response.statusText();
            add({ kind: 'app-unreachable', severity: 'high', message: `${line}: the app did not answer${reason ? ` (${reason})` : ''}` });
        } else if (status >= 500 && !expected(request.method(), path, status, record?.step)) {
            add({ kind: 'http-5xx', severity: 'high', message: line });
        } else if (status >= 400 && status !== 401 && REPORTED_4XX.has(request.resourceType()) && !expected(request.method(), path, status, record?.step)) {
            add({ kind: 'http-4xx', severity: 'medium', message: line });
        }
    };
    context.on('response', onResponse);
    const onRequestFinished = async (request: Request) => {
        inflight.delete(request);
        const record = byRequest.get(request);
        const response = record && await request.response().catch(() => null);
        if (record && response) {
            record.status = response.status();
            record.durationMs = Math.round(request.timing().responseEnd);
        }
    };
    context.on('requestfinished', onRequestFinished);
    const onRequestFailed = (request: Request) => {
        inflight.delete(request);
        const record = byRequest.get(request);
        const failure = request.failure()?.errorText ?? 'failed';
        if (record) {
            // A response that arrived before the transport broke keeps its status.
            if (record.status === 'pending') { record.status = 'failed'; }
        }
        // Navigation cancels in-flight requests; that is not a product failure.
        // A host network change is the environment, not the product.
        if (!ofApp(request.url()) || /ERR_ABORTED|NS_BINDING_ABORTED|ERR_NETWORK_CHANGED/.test(failure)) { return; }
        const url = new URL(request.url());
        if (declaredAbort(request.method(), url.pathname)) { return; }
        add({ kind: 'request-failed', severity: 'medium', message: `${request.method()} ${where(url)}: ${failure}` });
    };
    context.on('requestfailed', onRequestFailed);

    const settleCaps: Array<{ step: number; reason: string }> = [];
    return {
        issues: () => [...issues.values()],
        /** Times settle() gave up waiting, with what kept the page busy; slow-test diagnostics. */
        settleCaps: settleCaps as ReadonlyArray<{ step: number; reason: string }>,
        noteSettleCap(reason: string) { settleCaps.push({ step, reason }); },
        writes: writes as readonly WriteRecord[],
        async flushEvidence() { await Promise.race([Promise.all([...responseEvidence]), new Promise(resolve => setTimeout(resolve, 1000))]); },
        setStep(value: number) { step = value; },
        expectDuring(stepIndex: number, rules: readonly WriteExpectation[]) { stepExpectations.set(stepIndex, rules); },
        report: add,
        /** Requests still running that could change what the page shows; long polls are ignored. */
        pendingRequests(): number {
            const now = Date.now();
            return [...inflight.values()].filter(started => now - started < 5000).length;
        },
        /** Scan visible text for rendering defects. Values inside form fields are user data and skipped. */
        async scanText(page: Page): Promise<void> {
            const text = await page.evaluate(() => {
                if (!document.body) { return ''; }
                const parts: string[] = [];
                const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
                for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                    const parent = node.parentElement;
                    if (!parent || parent.closest('input, textarea, [contenteditable="true"], script, style, code, pre, noscript, template, [aria-hidden="true"]')) { continue; }
                    const style = getComputedStyle(parent);
                    if (style.display === 'none' || style.visibility === 'hidden') { continue; }
                    const value = node.textContent?.trim();
                    if (value) { parts.push(value); }
                }
                return parts.join('\n');
            }).catch(() => '');
            for (const line of safe(text).split('\n')) {
                // A client-rendered error screen can appear with no failed request and no uncaught exception.
                if (ERROR_SCREEN.test(line.trim())) { add({ kind: 'ui-error', severity: 'high', message: `Server error screen on ${shortPath(page.url())}: "${safe(line).trim().slice(0, 80)}"` }); }
                for (const [pattern, label] of SENTINELS) {
                    if (pattern.test(line)) { add({ kind: 'text-anomaly', severity: 'medium', message: `${label}: "${safe(line).slice(0, 120)}"` }); }
                }
                if (options.i18nKeys?.size) {
                    for (const token of line.match(/\b[a-z][\w-]*(?:\.[\w-]+){1,6}\b/gi) ?? []) {
                        if (options.i18nKeys.has(token)) { add({ kind: 'raw-i18n-key', severity: 'medium', message: `Untranslated key "${token}"`, detail: safe(line).slice(0, 160) }); }
                    }
                }
            }
        },
    };
}
export type Monitor = ReturnType<typeof createMonitor>;

export function matchesWrite(rule: WriteExpectation, method: string, path: string, status?: number): boolean {
    if (rule.method && rule.method.toUpperCase() !== method.toUpperCase()) { return false; }
    if (typeof rule.path === 'string' ? rule.path !== path : !rule.path.test(path)) { return false; }
    if (status === undefined) { return true; }
    if (rule.status === undefined) { return status >= 200 && status < 300; }
    return typeof rule.status === 'number' ? rule.status === status : rule.status.includes(status);
}

/** Console text with DOM node arguments named (`<button#save.primary>`) instead of Playwright's `JSHandle@node`. */
async function consoleText(message: ConsoleMessage): Promise<string> {
    let text = message.text();
    if (!text.includes('JSHandle@node')) { return text; }
    for (const arg of message.args()) {
        const label = await arg.evaluate((value: unknown) => {
            if (!(value instanceof Node)) { return undefined; }
            if (!(value instanceof Element)) { return value.nodeName.toLowerCase(); }
            const classes = [...value.classList].slice(0, 3).map(name => `.${name}`).join('');
            return `<${value.tagName.toLowerCase()}${value.id ? `#${value.id}` : ''}${classes}>`;
        }).catch(() => undefined);
        if (label) { text = text.replace('JSHandle@node', label); }
    }
    return text;
}

function shortPath(url: string): string {
    try { return new URL(url).pathname; } catch { return url; }
}

function firstLine(text: string): string {
    return (text.split('\n')[0] ?? '').slice(0, 300);
}
