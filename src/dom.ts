import type { AriaNode } from './observe.ts';
import type { ElementHandle, Frame, Page } from 'playwright';
import { selectors } from 'playwright';

let registered: Promise<void> | undefined;
export function registerDomSelector(): Promise<void> {
    registered ??= selectors.register('jev-ref', () => {
        const query = (_root: Node, key: string): Element | undefined => {
            const element = (Reflect.get(window, '__jevwrightRefs') as Map<string, Element> | undefined)?.get(key);
            return element?.isConnected ? element : undefined;
        };
        return { query, queryAll: (root: Node, key: string) => { const element = query(root, key); return element ? [element] : []; } };
    }, { contentScript: false });
    return registered;
}

/** Keep closed roots reachable to the engine without changing mode or the host's shadowRoot getter. */
export function trackRoots() {
    const roots = new WeakMap<Element, ShadowRoot>();
    Reflect.set(window, '__jevwrightRoots', roots);
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init) {
        const root = attach.call(this, init);
        roots.set(this, root);
        new MutationObserver(() => Reflect.set(window, '__jevwrightMutatedAt', performance.now()))
            .observe(root, { subtree: true, childList: true, characterData: true });
        return root;
    };
}

export interface DomSurface {
    nodes: AriaNode[];
    details: Array<{ box: NonNullable<AriaNode['box']>; content?: string; near?: string; value?: string; nativeSelect?: boolean; context?: string; draggable?: boolean; scroll?: { top: number; height: number; viewport: number } }>;
    text: string;
    dialog?: AriaNode;
    busy: boolean;
    scrollable: boolean;
    pageScroll: { top: number; height: number; viewport: number };
}

/** DOM complements the accessibility tree; leaf text also supplies hover, context-menu and scroll targets. */
export async function readSurface(page: Page | Frame, scope?: ElementHandle<Element>): Promise<DomSurface> {
    return page.evaluate((scope) => {
        const roots = Reflect.get(window, '__jevwrightRoots') as WeakMap<Element, ShadowRoot> | undefined;
        const refs = new Map<string, Element>();
        const ids = (Reflect.get(window, '__jevwrightIds') as WeakMap<Element, string> | undefined) ?? new WeakMap<Element, string>();
        Reflect.set(window, '__jevwrightIds', ids);
        let serial = Number(Reflect.get(window, '__jevwrightSerial') ?? 0);
        const all: Element[] = [];
        const walk = (root: Document | ShadowRoot) => {
            for (const element of root.querySelectorAll('*')) {
                all.push(element);
                const shadow = element.shadowRoot ?? roots?.get(element);
                if (shadow) { walk(shadow); }
            }
        };
        walk(document);
        const parentOf = (element: Element): Element | null => element.parentElement ?? ((element.getRootNode() as ShadowRoot).host ?? null);
        const visible = (element: Element): boolean => {
            const b = element.getBoundingClientRect();
            const css = getComputedStyle(element);
            for (let parent: Element | null = element; parent; parent = parentOf(parent)) {
                const style = getComputedStyle(parent);
                if (parent.matches('[hidden], [inert]') || style.opacity === '0' || style.visibility === 'hidden') { return false; }
            }
            return Boolean(b.width && b.height && css.display !== 'none' && css.visibility !== 'hidden' && css.opacity !== '0' && !element.closest('[hidden], [inert]') && !(b.width <= 1 && b.height <= 1 && (css.overflow === 'hidden' || css.clip !== 'auto')));
        };
        const text = (element: Element): string => {
            if (!visible(element)) { return ''; }
            return [...element.childNodes].map(node => node.nodeType === Node.TEXT_NODE ? node.textContent ?? '' : node instanceof Element ? text(node) : '').join(' ').replace(/\s+/g, ' ').trim();
        };
        const dialog = all.findLast(element => element.matches('dialog[open], [role=dialog], [role=alertdialog]') && visible(element));
        const inScope = (element: Element) => {
            if (!dialog) { return true; }
            for (let parent: Element | null = element; parent; parent = parentOf(parent)) { if (parent === dialog) { return true; } }
            return false;
        };
        const hasDrag = all.some(element => element instanceof HTMLElement && (element.draggable || /grab/.test(getComputedStyle(element).cursor)));
        const groupName = (element: Element) => hasDrag && Number.parseFloat(getComputedStyle(element).borderTopWidth) > 0 && element.firstElementChild ? text(element.firstElementChild).slice(0, 80) : '';
        const nodes: AriaNode[] = [];
        const details: DomSurface['details'] = [];
        let busy = document.readyState === 'loading';
        let scrollable = (document.scrollingElement?.scrollHeight ?? 0) > innerHeight;
        for (const element of all) {
            if (!visible(element) || !inScope(element)) { continue; }
            const b = element.getBoundingClientRect();
            const css = getComputedStyle(element);
            const box = { x: b.x, y: b.y, width: b.width, height: b.height };
            const rendered = text(element);
            const field = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
            const editable = element instanceof HTMLElement && element.isContentEditable;
            const select = element instanceof HTMLSelectElement;
            const nativeRole = select ? 'combobox' : field ? element instanceof HTMLInputElement && element.type === 'file' ? 'button' : element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type) ? element.type : 'textbox' : editable ? 'textbox' : element.matches('button, summary') ? 'button' : element.matches('a[href]') ? 'link' : undefined;
            const group = groupName(element);
            const role = element.getAttribute('role') ?? nativeRole ?? (group ? 'group' : 'generic');
            const label = element.getAttribute('aria-label')?.trim();
            const labels = field || select ? [...element.labels ?? []].map(text).join(' ') : '';
            const labelled = element.getAttribute('aria-labelledby')?.split(/\s+/).map(id => text((element.getRootNode() as Document | ShadowRoot).getElementById(id) ?? element)).join(' ');
            const preceding = element.previousElementSibling;
            const near = (labels || (preceding?.matches('label, span') && !preceding.children.length ? text(preceding) : '')).slice(0, 80);
            const scrolling = /auto|scroll/.test(css.overflowY) && element.scrollHeight > element.clientHeight + 1;
            const name = label || labelled || labels || group || (field ? element.getAttribute('placeholder') ?? '' : rendered.length <= 160 ? rendered : scrolling ? text(element.firstElementChild ?? element).slice(0, 60) : '');
            const draggable = element instanceof HTMLElement && (element.draggable || /grab/.test(css.cursor));
            const value = field ? element instanceof HTMLInputElement && element.type === 'password' ? '••••' : element.value : editable ? (element as HTMLElement).innerText : undefined;
            let context: string | undefined;
            for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
                const name = groupName(parent);
                if (name) { context = `group "${name}"`; break; }
            }
            details.push({ box, ...(context ? { context } : {}), ...(label && rendered && !field && !select && rendered !== label ? { content: rendered } : {}), ...(field && near && near !== name ? { near } : {}), ...(editable ? { value } : {}), ...(select ? { nativeSelect: true } : {}), ...(draggable ? { draggable: true } : {}), ...(scrolling ? { scroll: { top: element.scrollTop, height: element.scrollHeight, viewport: element.clientHeight } } : {}) });
            if (element.getAttribute('aria-busy') === 'true' || role === 'progressbar' || /(?:^|\b)(?:loading|skeleton|spinner)(?:\b|$)/i.test(`${element.className} ${element.id} ${element.getAttribute('data-state') ?? ''} ${element.getAttribute('data-testid') ?? ''}`) || (rendered.length < 80 && /^(?:loading|saving|processing|please wait)(?:\b|…)/i.test(rendered))) { busy = true; }
            scrollable ||= scrolling;
            const leaf = rendered && rendered.length <= 160 && ![...element.children].some(child => text(child));
            if (['dialog', 'alertdialog', 'status', 'alert', 'progressbar', 'heading'].includes(role) || element.matches('h1,h2,h3,h4,h5,h6')) { continue; }
            if (!(nativeRole || group || element.hasAttribute('role') || scrolling || draggable || leaf)) { continue; }
            if (field && element instanceof HTMLInputElement && element.type === 'hidden') { continue; }
            const key = ids.get(element) ?? `d${++serial}`;
            ids.set(element, key); refs.set(key, element);
            const node: AriaNode = { role, name, ref: `dom:${key}`, box, ...(value !== undefined ? { text: value } : {}), ...(element.hasAttribute('disabled') ? { disabled: true } : {}) };
            if (select) { node.children = [...element.options].map(option => ({ role: 'option', name: option.label, selected: option.selected })); }
            nodes.push(node);
        }
        Reflect.set(window, '__jevwrightRefs', refs);
        Reflect.set(window, '__jevwrightSerial', serial);
        const inside = (element: Element) => {
            if (!scope) { return true; }
            for (let parent: Element | null = element; parent; parent = parentOf(parent)) { if (parent === scope) { return true; } }
            return false;
        };
        const shown = all.filter(element => visible(element) && inScope(element) && inside(element)).flatMap(element => [...element.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent ?? '')).join(' ').replace(/\s+/g, ' ').trim();
        return { nodes, details, text: shown, ...(dialog ? { dialog: { role: dialog.getAttribute('role') ?? 'dialog', name: dialog.getAttribute('aria-label') ?? text(dialog.querySelector('h1,h2,h3,[role=heading]') ?? dialog).slice(0, 120), children: [...nodes, shown] } } : {}), busy, scrollable, pageScroll: { top: document.scrollingElement?.scrollTop ?? 0, height: document.scrollingElement?.scrollHeight ?? innerHeight, viewport: innerHeight } };
    }, scope);
}

export function domLocator(page: Page, ref: string) {
    return page.locator(ref.startsWith('dom:') ? `jev-ref=${ref.slice(4)}` : `aria-ref=${ref}`);
}

/** An initial blank document is browser setup, not an earlier app page for a back gesture. */
export async function canGoBack(page: Page): Promise<boolean> {
    const session = await page.context().newCDPSession(page);
    try {
        const history = await session.send('Page.getNavigationHistory');
        return /^https?:\/\//.test(history.entries[history.currentIndex - 1]?.url ?? '');
    } finally { await session.detach().catch(() => undefined); }
}

/** Pixels include shadow trees and editors; screenshot withholding must cover the same surfaces as observation. */
export async function secretSurface(page: Page): Promise<string> {
    return page.evaluate(() => {
        const roots = Reflect.get(window, '__jevwrightRoots') as WeakMap<Element, ShadowRoot> | undefined;
        const texts: string[] = [];
        const walk = (root: Document | ShadowRoot) => {
            for (const element of root.querySelectorAll<HTMLElement>('*')) {
                const box = element.getBoundingClientRect();
                if (box.width && box.height && getComputedStyle(element).visibility !== 'hidden') {
                    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) { texts.push(element.value); }
                    else { texts.push(element.innerText ?? ''); }
                }
                const shadow = element.shadowRoot ?? roots?.get(element);
                if (shadow) { walk(shadow); }
            }
        };
        walk(document);
        return texts.join('\n');
    });
}
