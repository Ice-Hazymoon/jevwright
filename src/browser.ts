import type { ResolvedDevice } from './devices.ts';
import type { Monitor } from './monitor.ts';
import type { Redactor } from './secrets.ts';
import type { Browser, BrowserContext, Locator, Page } from 'playwright';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { RequestError, Server } from 'proxy-chain';
import { JevwrightError } from './errors.ts';
import { canGoBack, domLocator, readSurface, registerDomSelector, trackRoots } from './dom.ts';

export function allowedUrl(raw: string, origins: readonly string[]): boolean {
    try {
        const url = new URL(raw);
        return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password && origins.includes(url.origin);
    } catch {
        return false;
    }
}

/**
 * Every browser connection, including redirect hops and WebSockets, goes through a loopback proxy
 * that only reaches the allowed origins. This is a guard rail for an autonomous agent, not a sandbox.
 */
export async function launchBrowser(options: { allowedOrigins: readonly string[]; headless?: boolean; onBlocked?: (url: string) => void }) {
    assertSupportedPlaywright();
    const origins = options.allowedOrigins.map(origin => new URL(origin).origin);
    const proxy = new Server({
        host: '127.0.0.1',
        port: 0,
        prepareRequestFunction: ({ request, hostname, port, isHttp }) => {
            const host = hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname;
            const destination = isHttp ? request.url ?? '' : `https://${host}:${port}`;
            // CONNECT tunnels carry no scheme; accept either scheme for an allowed host:port.
            const plain = isHttp ? destination : `http://${host}:${port}`;
            if (!allowedUrl(destination, origins) && !allowedUrl(plain, origins)) {
                options.onBlocked?.(destination);
                throw new RequestError('Destination outside the browser test scope', 403);
            }
            return {};
        },
    });
    await proxy.listen();
    let browser: Browser;
    try {
        browser = await chromium.launch({
            headless: options.headless ?? true,
            proxy: { server: `http://127.0.0.1:${proxy.port}`, bypass: '<-loopback>' },
            // The entrypoint owns signals so cleanup can finish before exit.
            handleSIGINT: false,
            handleSIGTERM: false,
            handleSIGHUP: false,
        });
    } catch (error) {
        await proxy.close(true);
        throw launchError(error);
    }
    return {
        browser,
        async close() {
            await browser.close().catch(() => undefined);
            await proxy.close(true);
        },
    };
}

/** Observations need `page.ariaSnapshotJSON`, which Playwright added in 1.63. */
export function assertSupportedPlaywright(version = playwrightVersion()): void {
    const [major = 0, minor = 0] = version.split('.').map(Number);
    if (major < 1 || (major === 1 && minor < 63)) {
        throw new JevwrightError(`jevwright needs Playwright 1.63 or newer, found ${version}. Upgrade with: npm install -D playwright@latest`);
    }
}

function playwrightVersion(): string {
    return (createRequire(import.meta.url)('playwright/package.json') as { version: string }).version;
}

/** A missing browser binary is a setup step, not a crash. */
function launchError(error: unknown): unknown {
    if (error instanceof Error && /Executable doesn't exist|browserType\.launch: .*install/i.test(error.message)) {
        return new JevwrightError('Playwright\'s Chromium is not installed. Run: npx playwright install chromium');
    }
    return error;
}

/**
 * Runs in the page (Playwright serializes it, so it must not reference anything outside itself): the DOM
 * mutation clock for settle(). Inline-style and SVG attribute churn is animation, and <head> churn (animated
 * favicons, meta tags) is not page content; either would keep an animated page from ever looking quiet.
 */
function watchMutations() {
    const describe = (record: MutationRecord) => {
        const element = record.target instanceof Element ? record.target : record.target.parentElement;
        const tag = element ? `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${typeof element.className === 'string' && element.className ? `.${element.className.trim().split(/\s+/)[0]}` : ''}` : '?';
        return `${record.type}${record.attributeName ? `:${record.attributeName}` : ''} <${tag}>`;
    };
    Reflect.set(window, '__jevwrightMutatedAt', performance.now());
    const observer = new MutationObserver((records) => {
        const content = records.find(record => !(record.type === 'attributes' && (record.attributeName === 'style' || record.target instanceof SVGElement))
            && !(document.head && document.head.contains(record.target)));
        if (!content) { return; }
        Reflect.set(window, '__jevwrightMutatedAt', performance.now());
        Reflect.set(window, '__jevwrightLastMutation', describe(content));
    });
    const start = () => observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    if (document.documentElement) { start(); } else { addEventListener('DOMContentLoaded', start); }
}

export async function newTestContext(browser: Browser, options: { viewport: { width: number; height: number }; dialogs: 'accept' | 'dismiss'; baseURL?: string; locale?: string; timezone?: string; device?: ResolvedDevice; acceptDownloads?: boolean; onDownload?: (download: import('playwright').Download) => void; onDialog?: (detail: string) => void }): Promise<BrowserContext> {
    // `baseURL` lets test code call `page.goto('/path')` and `page.request.get('/api/...')` with relative URLs.
    const context = await browser.newContext({ ...(options.device ?? { viewport: options.viewport }), serviceWorkers: 'block', acceptDownloads: options.acceptDownloads ?? false, locale: options.locale ?? 'en-US', timezoneId: options.timezone ?? 'UTC', ...(options.baseURL ? { baseURL: options.baseURL } : {}) });
    context.setDefaultTimeout(10_000);
    await registerDomSelector();
    await context.addInitScript(trackRoots);
    await context.addInitScript(watchMutations);
    context.on('page', (page) => {
        page.on('dialog', (dialog) => {
            options.onDialog?.(`${dialog.type()} "${dialog.message()}" ${options.dialogs === 'accept' ? 'accepted' : 'dismissed'}`);
            void (options.dialogs === 'accept' ? dialog.accept() : dialog.dismiss()).catch(() => undefined);
        });
        page.on('download', download => options.onDownload ? options.onDownload(download) : void download.cancel().catch(() => undefined));
    });
    return context;
}

/**
 * Code owns timing: quiet means no fetch/XHR/document request in flight (long polls excluded)
 * and no DOM mutation for `quietMs`. Bounded; returns the time spent.
 */
export async function settle(page: Page, monitor: Pick<Monitor, 'pendingRequests'> & Partial<Pick<Monitor, 'noteSettleCap'>>, options: { quietMs?: number; maxMs?: number } = {}): Promise<number> {
    const quietMs = options.quietMs ?? 350;
    const maxMs = options.maxMs ?? 8000;
    const started = Date.now();
    let blocker = '';
    while (Date.now() - started < maxMs) {
        let state = { idle: 0, last: '' };
        try {
            state = await page.evaluate(() => ({
                idle: document.readyState === 'loading' ? 0 : performance.now() - Number(Reflect.get(window, '__jevwrightMutatedAt') ?? 0),
                last: String(Reflect.get(window, '__jevwrightLastMutation') ?? ''),
            }));
        } catch {
            state = { idle: 0, last: 'navigation' }; // Navigation in progress.
        }
        const pending = monitor.pendingRequests();
        if (pending === 0 && state.idle >= quietMs && !(await readSurface(page)).busy) { return Date.now() - started; }
        blocker = pending ? `${pending} request(s) in flight` : `DOM still changing (${state.last || 'unknown'})`;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    monitor.noteSettleCap?.(blocker);
    return Date.now() - started;
}

export type Tool = 'hover' | 'right_click' | 'long_press' | 'double_click' | 'drag' | 'back' | 'scroll_to' | 'click' | 'type' | 'press_enter' | 'press_escape' | 'select' | 'scroll' | 'wait' | 'upload';

export interface ToolCall {
    tool: Tool;
    /** aria-ref from the latest observation. */
    ref?: string;
    /** For an element without a ref (hover-revealed): its role, name and index among same-named elements. */
    locate?: { role: string; name: string; nth: number; inDialog: boolean };
    value?: string;
    double?: boolean;
    /** Type at the cursor instead of replacing the field's content. */
    append?: boolean;
    /** Fill atomically so trace snapshots cannot capture partial secret keystrokes. */
    sensitive?: boolean;
    filePath?: string;
    filePaths?: string[];
    destinationRef?: string;
    scrollText?: string;
    scrollDirection?: 'up' | 'down';
    hasTouch?: boolean;
}

export async function perform(page: Page, call: ToolCall): Promise<void> {
    const timeout = 5000;
    const target = (): Locator => {
        if (call.ref) { return domLocator(page, call.ref); }
        if (!call.locate) { throw new Error(`${call.tool} needs a target element`); }
        const scope = call.locate.inDialog ? page.getByRole('dialog').or(page.getByRole('alertdialog')).last() : page;
        return scope.getByRole(call.locate.role as Parameters<Page['getByRole']>[0], { name: call.locate.name, exact: true }).nth(call.locate.nth);
    };
    if (!call.ref && call.locate) { await reveal(page, target(), timeout); }
    switch (call.tool) {
        case 'hover':
            await target().hover({ timeout });
            return;
        case 'right_click':
            await target().click({ button: 'right', timeout });
            return;
        case 'long_press':
            await target().click({ delay: 800, timeout });
            return;
        case 'double_click':
            await target().dblclick({ timeout });
            return;
        case 'back':
            if (!await canGoBack(page)) { throw new Error('No earlier app page in browser history'); }
            await page.goBack({ waitUntil: 'domcontentloaded', timeout });
            return;
        case 'scroll_to':
            await target().scrollIntoViewIfNeeded({ timeout });
            return;
        case 'drag': {
            if (!call.destinationRef) { throw new Error('Drag needs a destination'); }
            await target().dragTo(domLocator(page, call.destinationRef), { timeout });
            return;
        }
        case 'click':
            try {
                if (call.hasTouch) {
                    await target().tap({ timeout });
                    if (call.double) { await target().tap({ timeout }); }
                } else if (call.double) {
                    await target().dblclick({ timeout });
                } else {
                    await target().click({ timeout });
                }
            } catch (error) {
                throw await withCover(error, target());
            }
            return;
        case 'upload': {
            if (!call.filePath && !call.filePaths?.length) { throw new Error('Upload requires a declared file key'); }
            const locator = target();
            if (await locator.evaluate(element => element instanceof HTMLInputElement && element.type === 'file', undefined, { timeout })) {
                const multiple = await locator.getAttribute('multiple') !== null;
                if (!multiple && (call.filePaths?.length ?? 0) > 1) { throw new Error('Upload target accepts only one file'); }
                await locator.setInputFiles(multiple && call.filePaths?.length ? call.filePaths : call.filePath!, { timeout });
            } else {
                const chooser = page.waitForEvent('filechooser', { timeout }).catch(() => undefined);
                try {
                    if (call.hasTouch) { await locator.tap({ timeout }); } else { await locator.click({ timeout }); }
                } catch (error) { await chooser; throw error; }
                const opened = await chooser;
                if (!opened) { throw new Error('Upload target did not open a file chooser within 5 seconds'); }
                if (!opened.isMultiple() && (call.filePaths?.length ?? 0) > 1) { throw new Error('Upload target accepts only one file'); }
                await opened.setFiles(opened.isMultiple() && call.filePaths?.length ? call.filePaths : call.filePath!, { timeout });
            }
            return;
        }
        case 'type': {
            if (call.value === undefined) { throw new Error('No value to type'); }
            const locator = target();
            if (call.sensitive) {
                if (!await locator.isEditable({ timeout })) { throw new Error('Secret input needs an enabled editable field'); }
                await locator.fill(call.append ? `${await locator.inputValue()}${call.value}` : call.value, { timeout });
                return;
            }
            if (call.append) {
                // The caret is where the previous typing left it (e.g. after Enter); keep the text before it.
                await locator.pressSequentially(call.value, { delay: 4, timeout: timeout + call.value.length * 20 });
                return;
            }
            await locator.fill('', { timeout });
            // Real key events for short values: masks, pickers and rich editors can ignore fill().
            if (call.value.length <= 160) {
                await locator.pressSequentially(call.value, { delay: 4, timeout: timeout + call.value.length * 20 });
            } else {
                await locator.fill(call.value, { timeout });
            }
            const written = await locator.inputValue({ timeout: 1000 }).catch(() => null);
            if (written !== null && written !== call.value) { await locator.fill(call.value, { timeout }); }
            return;
        }
        case 'press_enter':
            await target().press('Enter', { timeout });
            return;
        case 'press_escape':
            if (call.ref) {
                await target().press('Escape', { timeout });
            } else {
                await page.keyboard.press('Escape');
            }
            return;
        case 'select': {
            const locator = target();
            if (await locator.getAttribute('role') === 'option') { await locator.click({ timeout }); return; }
            if (call.value === undefined) { throw new Error('No option to select'); }
            if (await locator.evaluate(element => element instanceof HTMLSelectElement)) {
                await locator.selectOption({ label: call.value }, { timeout }).catch(async () => locator.selectOption(call.value!, { timeout }));
            } else {
                const controls = await locator.getAttribute('aria-controls');
                const scope = await locator.getAttribute('role') === 'listbox' ? locator : controls ? page.locator(`[id=${JSON.stringify(controls)}]`) : page;
                const option = scope.getByRole('option', { name: call.value, exact: true });
                if (!await option.count()) { throw new Error('Option is not rendered yet'); }
                await option.click({ timeout });
            }
            return;
        }
        case 'scroll':
            await scrollPage(page, call);
            return;
        case 'wait':
            await page.waitForTimeout(800);
    }
}

/**
 * Hover-revealed controls ignore the pointer until their container is hovered, as a user would hover it.
 * The control can hang outside its container (a toolbar under a card), where hovering the control's own
 * position reaches the page behind it; walk up until the control takes the pointer.
 */
async function reveal(page: Page, locator: Locator, timeout: number): Promise<void> {
    for (let depth = 0; depth <= 5; depth++) {
        const container = depth ? locator.locator(`xpath=${Array.from({ length: depth }).fill('..').join('/')}`) : locator;
        await container.hover({ force: true, timeout });
        await page.waitForTimeout(depth ? 150 : 250);
        if (await takesPointer(locator)) { return; }
    }
}

async function takesPointer(locator: Locator): Promise<boolean> {
    return locator.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return Boolean(hit && element.contains(hit));
    }).catch(() => false);
}

/** Names what covers a click target (the open drawer, dialog, banner or toast) in Playwright's error. */
async function withCover(error: unknown, locator: Locator): Promise<unknown> {
    if (!(error instanceof Error) || !/intercepts pointer events/i.test(error.message)) { return error; }
    const cover = await locator.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        if (!hit || element.contains(hit)) { return ''; }
        let layer: Element = hit;
        for (let node: Element | null = hit; node && node !== document.body; node = node.parentElement) {
            const position: string = getComputedStyle(node).position;
            if (position === 'fixed' || position === 'sticky' || node.matches('dialog, [role=dialog], [role=alertdialog]')) {
                layer = node;
                break;
            }
        }
        // eslint-disable-next-line unicorn/prefer-dom-node-text-content -- innerText respects CSS visibility/layout; hidden text must not leak into the cover label
        const label = layer.getAttribute('aria-label') ?? layer.querySelector('h1, h2, h3, h4, [role=heading]')?.textContent ?? (layer as HTMLElement).innerText;
        return label ?? '';
    }).catch(() => '');
    return cover ? new Error(`${error.message}\ncovered by: ${cover}`) : error;
}

/** Short, model-readable reason for a failed Playwright action. */
export function actionError(error: unknown, redact?: Redactor): string {
    const raw = error instanceof Error ? error.message : String(error);
    const message = redact?.text(raw) ?? raw;
    if (/intercepts pointer events/i.test(message)) {
        const cover = /\ncovered by: (.+)$/.exec(message)?.[1];
        return `click blocked: ${cover ? `"${cover}" covers the target` : 'another element covers the target'} (an open panel, drawer, dialog, overlay, toast or banner)`;
    }
    if (/not visible|not attached|detached/i.test(message)) { return 'target is not visible or no longer on the page'; }
    if (/not enabled|disabled/i.test(message)) { return 'target is disabled'; }
    if (/Timeout/i.test(message)) { return 'target did not become actionable in time'; }
    return (message.split('\n')[0] ?? message).slice(0, 180);
}

/** Search at viewport-sized intervals so windowed rows are not skipped; all searches have a time and iteration cap. */
async function scrollPage(page: Page, call: ToolCall): Promise<void> {
    const locator = call.ref ? domLocator(page, call.ref) : undefined;
    const deadline = Date.now() + 45000;
    const direction = call.scrollDirection === 'up' ? -1 : 1;
    const phrase = call.scrollText?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const search = phrase ? new RegExp(`(?<![\\p{L}\\p{N}_])${phrase}(?![\\p{L}\\p{N}_])`, 'u') : undefined;
    let stalled = 0;
    for (let attempt = 0; attempt < (call.scrollText ? 500 : 1) && Date.now() < deadline; attempt++) {
        if (search) {
            const scope = locator ? await locator.elementHandle({ timeout: 5000 }) : undefined;
            const text = (await readSurface(page, scope ?? undefined).finally(() => scope?.dispose())).text;
            if (search.test(text)) { return; }
        }
        const move = (direction: number) => {
            const area = document.scrollingElement;
            if (!area) { return { before: 0, after: 0 }; }
            const before = area.scrollTop;
            area.scrollTop += direction * Math.max(100, area.clientHeight * 0.9);
            return { before, after: area.scrollTop };
        };
        const delta = locator
            ? await locator.evaluate((element, direction) => { const before = element.scrollTop; element.scrollTop += direction * Math.max(100, element.clientHeight * 0.9); return { before, after: element.scrollTop }; }, direction)
            : await page.evaluate(move, direction);
        await page.waitForTimeout(delta.before === delta.after ? 500 : 40);
        if (delta.before === delta.after) { if (++stalled >= 5) { return; } } else { stalled = 0; }
    }
}
