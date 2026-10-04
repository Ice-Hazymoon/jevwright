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
    // Registration is a surface hint; actionability and the resulting effect still decide delivery.
    const events = new WeakMap<EventTarget, Set<string>>();
    Reflect.set(window, '__jevwrightEvents', events);
    const add = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, listener, options) {
        if (listener) { const types = events.get(this) ?? new Set<string>(); types.add(type.toLowerCase()); events.set(this, types); }
        return add.call(this, type, listener, options);
    };
    const roots = new WeakMap<Element, ShadowRoot>();
    Reflect.set(window, '__jevwrightRoots', roots);
    const shadowRoots = new Set<ShadowRoot>();
    Reflect.set(window, '__jevwrightShadowRoots', shadowRoots);
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init) {
        const root = attach.call(this, init);
        roots.set(this, root);
        shadowRoots.add(root);
        new MutationObserver(records => (Reflect.get(window, '__jevwrightContentMutation') as ((records: MutationRecord[]) => void) | undefined)?.(records))
            .observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
        return root;
    };
}

export interface DomSurface {
    nodes: AriaNode[];
    details: Array<{ box: NonNullable<AriaNode['box']>; content?: string; visibleName?: string; selection?: string; dropTarget?: boolean; near?: string; value?: string; inputType?: string; autocomplete?: string; nativeSelect?: boolean; context?: string; draggable?: boolean; scroll?: { top: number; height: number; viewport: number } }>;
    text: string;
    dialog?: AriaNode;
    busy: boolean;
    scrollable: boolean;
    pageScroll: { top: number; height: number; viewport: number };
}

/** DOM complements the accessibility tree; leaf text also supplies hover, context-menu and scroll targets. */
export async function readSurface(page: Page | Frame, scope?: ElementHandle<Element>, instruction = ''): Promise<DomSurface> {
    const surface = await page.evaluate(({ scope, instruction }) => {
        const roots = Reflect.get(window, '__jevwrightRoots') as WeakMap<Element, ShadowRoot> | undefined;
        const refs = new Map<string, Element>();
        const ids = (Reflect.get(window, '__jevwrightIds') as WeakMap<Element, string> | undefined) ?? new WeakMap<Element, string>();
        Reflect.set(window, '__jevwrightIds', ids);
        let serial = Number(Reflect.get(window, '__jevwrightSerial') ?? 0);
        const all: Element[] = [];
        const shadows = new Map<Element, ShadowRoot>();
        const walk = (root: Document | ShadowRoot) => {
            for (const element of root.querySelectorAll('*')) {
                all.push(element);
                const shadow = element.shadowRoot ?? roots?.get(element);
                if (shadow) { shadows.set(element, shadow); walk(shadow); }
            }
        };
        walk(document);
        const slots = new Map<Element, Node[]>(); const slotParents = new Map<Node, Element>();
        for (const element of all) { if (element instanceof HTMLSlotElement) {
            const assigned = element.assignedNodes(); slots.set(element, assigned);
            for (const node of assigned) { slotParents.set(node, element); }
        } }
        // Assigned nodes use their rendered slot ancestry, including slots in captured closed roots.
        const parentOf = (element: Element): Element | null => slotParents.get(element) ?? element.parentElement ?? ((element.getRootNode() as ShadowRoot).host ?? null);
        const childrenOf = (element: Element): Node[] => slots.get(element)?.length ? slots.get(element)! : [...(shadows.get(element) ?? element).childNodes];
        const styles = new Map<Element, CSSStyleDeclaration>();
        const boxes = new Map<Element, DOMRect>();
        const hidden = new Map<Element, boolean>();
        const inert = new Map<Element, boolean>();
        const visibility = new Map<Element, boolean>();
        const texts = new Map<Element, string>();
        const styleOf = (element: Element) => {
            let style = styles.get(element);
            if (!style) { style = getComputedStyle(element); styles.set(element, style); }
            return style;
        };
        const boxOf = (element: Element) => {
            let box = boxes.get(element);
            if (!box) { box = element.getBoundingClientRect(); boxes.set(element, box); }
            return box;
        };
        // Visibility can be restored by descendants; display, opacity and clipping hide entire subtrees.
        const hiddenTree = (element: Element): boolean => {
            if (hidden.has(element)) { return hidden.get(element)!; }
            const css = styleOf(element); const parent = parentOf(element);
            const physical = element.parentElement;
            const replaced = Boolean(physical && (shadows.has(physical) || slots.get(physical)?.length) && !slotParents.has(element));
            const folded = parent instanceof HTMLDetailsElement && !parent.open && element !== [...parent.children].find(child => child.tagName === 'SUMMARY');
            const clipped = /hidden|clip/.test(css.overflow) && css.display !== 'contents' && (boxOf(element).width <= 1 || boxOf(element).height <= 1);
            const value = folded || replaced || element.hasAttribute('hidden') || css.display === 'none' || css.opacity === '0' || clipped || Boolean(parent && hiddenTree(parent));
            hidden.set(element, value); return value;
        };
        const inertTree = (element: Element): boolean => {
            if (inert.has(element)) { return inert.get(element)!; }
            const parent = parentOf(element);
            const value = element.hasAttribute('inert') || Boolean(parent && inertTree(parent));
            inert.set(element, value); return value;
        };
        const visible = (element: Element): boolean => {
            if (visibility.has(element)) { return visibility.get(element)!; }
            const b = boxOf(element); const css = styleOf(element);
            const value = Boolean(b.width && b.height && css.visibility === 'visible' && !hiddenTree(element) && !(b.width <= 1 && b.height <= 1 && (css.overflow === 'hidden' || css.clip !== 'auto')));
            visibility.set(element, value); return value;
        };
        // Inert previews remain visible; display:contents wrappers pass their rendered children through.
        const textVisible = (element: Element) => !hiddenTree(element) && styleOf(element).visibility === 'visible' && (styleOf(element).display === 'contents' || visible(element));
        const ownText = (node: Node, element: Element): string => {
            const assigned = slotParents.get(node);
            if (!assigned && node.parentNode === element && (shadows.has(element) || slots.get(element)?.length)) { return ''; }
            return textVisible(assigned ?? element) ? node.textContent ?? '' : '';
        };
        // Each subtree contributes its visible text once, rather than being walked again for every ancestor.
        for (const element of all.toReversed()) {
            texts.set(element, !hiddenTree(element) ? childrenOf(element).map(node => node.nodeType === Node.TEXT_NODE ? ownText(node, element) : node instanceof Element ? texts.get(node) ?? '' : '').join(' ').replace(/\s+/g, ' ').trim() : '');
        }
        const text = (element: Element): string => texts.get(element) ?? '';
        const dialog = all.findLast(element => element.matches('dialog[open], [role=dialog], [role=alertdialog]') && visible(element));
        const inScope = (element: Element) => {
            if (!dialog) { return true; }
            for (let parent: Element | null = element; parent; parent = parentOf(parent)) { if (parent === dialog) { return true; } }
            return false;
        };
        const groups = new Map<Element, string>();
        const groupName = (element: Element): string => {
            if (groups.has(element)) { return groups.get(element)!; }
            if (element.matches('html,body,main,header,footer,nav')) { return ''; }
            const heading = [...element.children].find(child => child.matches('h1,h2,h3,h4,h5,h6,[role=heading]'));
            const name = element.matches('section, [role=region], [role=list], [role=group]') || heading
                ? element.getAttribute('aria-label') || (heading ? text(heading) : '') : '';
            groups.set(element, name); return name;
        };
        const actionRoles = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'slider', 'spinbutton', 'treeitem', 'listbox']);
        const hoverSelectors: string[] = [];
        const rules = (items: CSSRuleList) => { for (const rule of items) {
            if (rule instanceof CSSStyleRule && ['display', 'visibility', 'opacity'].some(property => rule.style.getPropertyValue(property))) {
                for (const selector of rule.selectorText.split(',').filter(selector => /:hover\s+|:hover\s*>/.test(selector))) {
                    try {
                        const targets = [...document.querySelectorAll(selector.replaceAll(':hover', ''))];
                        if (targets.some(target => hiddenTree(target) || styleOf(target).visibility !== 'visible')) { hoverSelectors.push(selector.split(':hover')[0]!.trim()); }
                    } catch { /* Unsupported selectors cannot establish a revealing hover. */ }
                }
            }
            else if ('cssRules' in rule) { rules((rule as CSSGroupingRule).cssRules); }
        } };
        for (const sheet of document.styleSheets) { try { rules(sheet.cssRules); } catch { /* Cross-origin stylesheets are unreadable. */ } }
        const registered = Reflect.get(window, '__jevwrightEvents') as WeakMap<EventTarget, Set<string>> | undefined;
        const eventCache = new Map<Element, Set<string>>();
        const eventsOf = (element: Element): Set<string> => {
            if (eventCache.has(element)) { return eventCache.get(element)!; }
            const keys = Object.keys(element);
            // Framework roots register delegated listeners for descendants, not actions on the root itself.
            const delegated = keys.some(key => key.startsWith('__reactContainer$') || key === '_reactRootContainer' || key === '__vue_app__');
            const events = new Set(delegated ? [] : registered?.get(element));
            for (const key of keys) {
                if (key.startsWith('__reactProps$') || key === '_vei') {
                    const props = Reflect.get(element, key) as Record<string, unknown> | undefined;
                    for (const [name, value] of Object.entries(props ?? {})) {
                        if (/^on/i.test(name) && typeof value === 'function') { events.add(name.slice(2).replace(/Capture$/, '').toLowerCase()); }
                    }
                }
            }
            for (const type of ['click', 'contextmenu', 'mouseenter', 'mouseover', 'dragstart', 'dragover', 'drop', 'pointerdown', 'pointermove', 'pointerup']) {
                if (typeof Reflect.get(element, `on${type}`) === 'function') { events.add(type); }
            }
            eventCache.set(element, events); return events;
        };
        const draggableOf = (element: Element) => element.getAttribute('draggable') === 'true' || /grab/.test(styleOf(element).cursor)
            || eventsOf(element).has('dragstart') || (eventsOf(element).has('pointerdown') && (eventsOf(element).has('pointermove') || eventsOf(element).has('pointerup')));
        const hasDrag = all.some(element => visible(element) && !inertTree(element) && draggableOf(element));
        const interactiveParent = (element: Element) => {
            for (let parent = parentOf(element); parent; parent = parentOf(parent)) {
                if (parent.matches('button,a[href],input,select,textarea,summary,[contenteditable=true]') || actionRoles.has(parent.getAttribute('role') ?? '') || styleOf(parent).cursor === 'pointer' || eventsOf(parent).has('click')) { return true; }
            }
            return false;
        };
        const pointerSignal = (element: Element) => {
            for (let parent: Element | null = element; parent && parent !== document.body; parent = parentOf(parent)) {
                if (['contextmenu', 'mouseenter', 'mouseover', 'dragover', 'drop'].some(type => eventsOf(parent!).has(type)) || /pointer|grab/.test(styleOf(parent).cursor)) { return true; }
                if (hoverSelectors.some(selector => { try { return parent!.matches(selector); } catch { return false; } })) { return true; }
            }
            return false;
        };
        const textCandidates: AriaNode[] = [];
        const nodes: AriaNode[] = [];
        const details: DomSurface['details'] = [];

        let scrollable = (document.scrollingElement?.scrollHeight ?? 0) > innerHeight;
        for (const element of all) {
            if (!visible(element) || inertTree(element) || !inScope(element)) { continue; }
            const b = boxOf(element);
            const css = styleOf(element);
            const box = { x: b.x, y: b.y, width: b.width, height: b.height };
            const rendered = text(element);
            const field = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
            const editable = element instanceof HTMLElement && element.isContentEditable;
            const select = element instanceof HTMLSelectElement;
            const nativeRole = select ? 'combobox' : field ? element instanceof HTMLInputElement && element.type === 'file' ? 'button' : element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type) ? element.type : 'textbox' : editable ? 'textbox' : element.matches('button, summary') ? 'button' : element.matches('a[href]') ? 'link' : undefined;
            const group = groupName(element);
            const role = element.getAttribute('role') ?? nativeRole ?? (group ? 'group' : 'generic');
            const label = element.getAttribute('aria-label')?.trim();
            const labelText = (label: Element): string => childrenOf(label).map(node => node.nodeType === Node.TEXT_NODE ? ownText(node, label) : node instanceof Element && !node.matches('input,textarea,select,[contenteditable=true]') ? labelText(node) : '').join(' ').replace(/\s+/g, ' ').trim();
            const labels = field || select ? [...element.labels ?? []].map(labelText).join(' ') : '';
            const labelled = element.getAttribute('aria-labelledby')?.split(/\s+/).map(id => text((element.getRootNode() as Document | ShadowRoot).getElementById(id) ?? element)).join(' ');
            const preceding = element.previousElementSibling;
            const near = labels || (preceding?.matches('label, span') && !preceding.children.length ? text(preceding) : '');
            const scrolling = /auto|scroll/.test(css.overflowY) && element.scrollHeight > element.clientHeight + 1;
            const name = label || labelled || labels || group || (field ? element.getAttribute('placeholder') ?? '' : rendered.length <= 160 ? rendered : scrolling ? text(element.firstElementChild ?? element) : '');
            const draggable = element instanceof HTMLElement && draggableOf(element);
            const painted = css.backgroundColor !== 'rgba(0, 0, 0, 0)' || ['borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'outlineWidth'].some(key => parseFloat(Reflect.get(css, key) as string) > 0);
            const container = !nativeRole && !actionRoles.has(role) && !draggable && !interactiveParent(element) && b.width >= 24 && b.height >= 24 && !element.matches('html,body,main,header,footer,nav');
            const emptyBox = container && !rendered && !element.children.length && painted;
            const dropTarget = eventsOf(element).has('dragover') || eventsOf(element).has('drop') || (hasDrag && container && (Boolean(label || element.getAttribute('data-testid')) || emptyBox));
            // Option lists and selected values are content; only a form label or action caption names a control.
            const visibleName = field || select ? labels || near : (nativeRole || actionRoles.has(role)) && !['combobox', 'listbox'].includes(role) && !select && !editable ? rendered : undefined;
            const focused = element === (element.getRootNode() as Document | ShadowRoot).activeElement;
            // Mask password selections before returning DOM data; traces can capture evaluation results.
            const selected = focused && field && element.selectionStart !== null && element.selectionEnd !== null ? element instanceof HTMLInputElement && element.type === 'password' ? '••••' : element.value.slice(element.selectionStart, element.selectionEnd)
                : focused && editable ? (element.getRootNode() instanceof ShadowRoot ? (element.getRootNode() as ShadowRoot & { getSelection?: () => Selection | null }).getSelection?.() : document.getSelection())?.toString() : undefined;
            const value = field ? element instanceof HTMLInputElement && element.type === 'password' ? '••••' : element.value : editable ? (element as HTMLElement).innerText : undefined;
            let context: string | undefined;
            for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
                const name = groupName(parent);
                if (name) { context = `group "${name}"`; break; }
            }
            if (nativeRole || label || group || actionRoles.has(role) || scrolling || draggable || dropTarget) { details.push({ box, ...(visibleName ? { visibleName } : {}), ...(selected !== undefined ? { selection: selected } : {}), ...(dropTarget ? { dropTarget: true } : {}), ...(context ? { context } : {}), ...(label && rendered && !field && !select && rendered !== label ? { content: rendered } : {}), ...(field && near && near !== name ? { near } : {}), ...(element instanceof HTMLInputElement ? { inputType: element.type, autocomplete: element.autocomplete } : {}), ...(editable ? { value } : {}), ...(select ? { nativeSelect: true } : {}), ...(draggable ? { draggable: true } : {}), ...(scrolling ? { scroll: { top: element.scrollTop, height: element.scrollHeight, viewport: element.clientHeight } } : {}) }); }
            scrollable ||= scrolling;
            const clickable = css.cursor === 'pointer' && rendered && rendered.length <= 160 && !interactiveParent(element);
            const leaf = rendered && rendered.length <= 160 && ![...element.children].some(child => text(child)) && !interactiveParent(element) && (pointerSignal(element) || instruction.toLowerCase().includes(rendered.toLowerCase()));
            if (['dialog', 'alertdialog', 'status', 'alert', 'progressbar', 'heading'].includes(role) || element.matches('h1,h2,h3,h4,h5,h6')) { continue; }
            if (!(nativeRole || group || actionRoles.has(role) || scrolling || draggable || dropTarget || clickable || leaf)) { continue; }
            if (field && element instanceof HTMLInputElement && element.type === 'hidden') { continue; }
            const key = ids.get(element) ?? `d${++serial}`;
            ids.set(element, key); refs.set(key, element);
            const node: AriaNode = { role: emptyBox && dropTarget ? 'box' : role, name: dropTarget && !label ? group || text(element.querySelector('h1,h2,h3,h4') ?? element).slice(0, 80) || element.getAttribute('data-testid') || '' : name, ref: `dom:${key}`, box, ...(value !== undefined ? { text: value } : {}), ...(element.hasAttribute('disabled') ? { disabled: true } : {}) };
            if (select) { node.children = [...element.options].map(option => ({ role: 'option', name: option.label, selected: option.selected })); }
            if (leaf && !nativeRole && !group && !actionRoles.has(role) && !scrolling && !draggable && !dropTarget && !clickable) { textCandidates.push(node); } else { nodes.push(node); }
        }
        const viewportRank = (node: AriaNode) => node.box && node.box.y >= 0 && node.box.y < innerHeight ? 0 : 1;
        const named = (node: AriaNode) => node.name && instruction.toLowerCase().includes(node.name.toLowerCase()) ? 0 : 1;
        nodes.push(...textCandidates.toSorted((a, b) => named(a) - named(b) || viewportRank(a) - viewportRank(b)).slice(0, 30));
        Reflect.set(window, '__jevwrightRefs', refs);
        Reflect.set(window, '__jevwrightSerial', serial);
        const inside = (element: Element) => {
            if (!scope) { return true; }
            for (let parent: Element | null = element; parent; parent = parentOf(parent)) { if (parent === scope) { return true; } }
            return false;
        };
        const primary = new Map<Element, boolean>();
        const inMain = (element: Element): boolean => {
            if (primary.has(element)) { return primary.get(element)!; }
            const parent = parentOf(element);
            const value = element.matches('main,[role=main]') || Boolean(parent && inMain(parent));
            primary.set(element, value); return value;
        };
        const mainText: string[] = []; const otherText: string[] = [];
        for (const element of all) {
            if (!textVisible(element) || !inScope(element) || !inside(element)) { continue; }
            const destination = inMain(element) ? mainText : otherText;
            for (const node of childrenOf(element)) { if (node.nodeType === Node.TEXT_NODE) { destination.push(ownText(node, element)); } }
        }
        // Main content gets the bounded observation budget before navigation and surrounding chrome.
        const shown = [...mainText, ...otherText].join(' ').replace(/\s+/g, ' ').trim();
        return { nodes, details, text: shown, ...(dialog ? { dialog: { role: dialog.getAttribute('role') ?? 'dialog', name: dialog.getAttribute('aria-label') ?? text(dialog.querySelector('h1,h2,h3,[role=heading]') ?? dialog), children: [...nodes, shown] } } : {}), busy: false, scrollable, pageScroll: { top: document.scrollingElement?.scrollTop ?? 0, height: document.scrollingElement?.scrollHeight ?? innerHeight, viewport: innerHeight } };
    }, { scope, instruction });
    surface.busy = await readBusy(page);
    return surface;
}

/** Busy polling queries only signal nodes; decorations expire without resetting the DOM reference map. */
export async function readBusy(page: Page | Frame): Promise<boolean> {
    return page.evaluate(() => {
        const shadowRoots = Reflect.get(window, '__jevwrightShadowRoots') as Set<ShadowRoot> | undefined;
        for (const root of shadowRoots ?? []) { if (!root.host.isConnected) { shadowRoots!.delete(root); } }
        const scopes: Array<Document | ShadowRoot> = [document, ...shadowRoots ?? []];
        const visible = (element: Element) => element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && !element.closest('[hidden],[inert]');
        const signals = scopes.flatMap(root => [...root.querySelectorAll('[aria-busy="true"],[role=progressbar]:not([aria-valuenow]),[role=status],[aria-live],[class*="loading" i],[class*="skeleton" i],[class*="spinner" i],[id*="loading" i],[id*="skeleton" i],[id*="spinner" i],[data-state*="loading" i]')]).filter(visible);
        const markers = new Set(signals.filter(element => /(?:^|\b)(?:loading|skeleton|spinner)(?:\b|$)/i.test(`${element.getAttribute('class') ?? ''} ${element.id} ${element.getAttribute('data-state') ?? ''}`)));
        const previous = Reflect.get(window, '__jevwrightLoadingMarkers') as Set<Element> | undefined;
        const transient = (Reflect.get(window, '__jevwrightTransientMarkers') as Map<Element, number> | undefined) ?? new Map<Element, number>();
        const now = performance.now();
        if (previous) { for (const marker of markers) { if (!previous.has(marker)) { transient.set(marker, now); } } }
        for (const marker of transient.keys()) { if (!markers.has(marker)) { transient.delete(marker); } }
        Reflect.set(window, '__jevwrightLoadingMarkers', markers); Reflect.set(window, '__jevwrightTransientMarkers', transient);
        return document.readyState === 'loading' || [...transient.values()].some(start => now - start < 2000) || signals.some(element => element.getAttribute('aria-busy') === 'true' || (element.getAttribute('role') === 'progressbar' && !element.hasAttribute('aria-valuenow')) || ((element.getAttribute('role') === 'status' || element.hasAttribute('aria-live')) && /^(?:loading|saving|processing|please wait)(?:\b|…)/i.test((element.textContent ?? '').trim())));
    });
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
