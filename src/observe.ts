import type { Redactor } from './secrets.ts';
import type { Page } from 'playwright';
import { createHash } from 'node:crypto';

/** Node shape of Playwright `ariaSnapshotJSON({ mode: 'ai', boxes: true })`. */
export interface AriaNode {
    role: string;
    name?: string;
    text?: string;
    children?: Array<AriaNode | string>;
    ref?: string;
    cursor?: string;
    url?: string;
    placeholder?: string;
    level?: number;
    checked?: boolean | 'mixed';
    disabled?: boolean;
    expanded?: boolean;
    selected?: boolean;
    pressed?: boolean | 'mixed';
    invalid?: boolean | string;
    active?: boolean;
    ariaHidden?: boolean;
    box?: { x: number; y: number; width: number; height: number };
}

/** One element a step may act on, or read. `i` is the option key given to the model. */
export interface PageElement {
    i: number;
    ref?: string;
    role: string;
    name: string;
    value?: string;
    placeholder?: string;
    /** Visible text next to the element; the real label when the accessible name is generic. */
    near?: string;
    /** Nearest named containers, innermost first, e.g. `dialog "Edit pool"`. */
    context?: string;
    states?: string[];
    url?: string;
    options?: string[];
    disabled?: boolean;
    offscreen?: boolean;
    /** Interactive but not taking pointer events yet (hover toolbars); acted on by hovering it first. */
    reveal?: boolean;
    /** Index among elements with the same role and name, for locating an element without a ref. */
    nth?: number;
    /** Visible text inside the element that its aria-label replaces in the accessible name (e.g. a card). */
    content?: string;
}

export interface Observation {
    url: string;
    title: string;
    /** Name and text of the open dialog, when the page is restricted to it. */
    dialog?: string;
    /** Live status, alert and toast text. */
    notices: string[];
    headings: string[];
    /** Visible main-content text in reading order, bounded. */
    text: string;
    elements: PageElement[];
    omitted: number;
    /** Changes whenever URL, element values/states, notices or text change. */
    signature: string;
}

const INTERACTIVE = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'slider', 'spinbutton', 'treeitem', 'listbox']);
const VALUED = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider']);
/** Fields whose exact text is read from the DOM (native selects keep the snapshot's selected option). */
const TEXT_FIELDS = new Set(['textbox', 'searchbox', 'spinbutton']);
const TOGGLES = new Set(['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio']);
const CONTAINERS = new Set(['dialog', 'alertdialog', 'region', 'form', 'group', 'navigation', 'complementary', 'row', 'listitem', 'article', 'tabpanel', 'menu', 'table', 'grid', 'radiogroup', 'tablist']);
const NOTICES = new Set(['alert', 'status', 'log', 'marquee', 'alertdialog']);
/** Roles a user acts on; without an aria ref they are waiting for hover (e.g. `pointer-events: none` until hovered). */
const REVEALABLE = new Set(['button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'checkbox', 'switch', 'tab', 'radio', 'textbox', 'searchbox', 'combobox', 'spinbutton', 'slider', 'option']);
const TEXT_ROLES = new Set(['paragraph', 'heading', 'generic', 'cell', 'gridcell', 'columnheader', 'rowheader', 'listitem', 'term', 'definition', 'time', 'status', 'alert', 'strong', 'emphasis', 'code', 'caption', 'blockquote', 'label', 'text', 'note', 'img']);
const GENERIC_NAME = /^(?:toggle(?: setting)?|setting|more|open|close|menu|actions?|options?|button|edit|delete|remove|select|switch|[x×…]|\.\.\.)$/i;
const SECRET = /password|passcode|secret|token|api[\s_-]?key|otp|verification code/i;

export const LIMITS = { elements: 220, text: 4000, notice: 300, near: 80 };

export interface ObserveOptions {
    redact?: Redactor;
    viewport?: { width: number; height: number };
}

export async function observe(page: Page, options: ObserveOptions = {}): Promise<Observation> {
    const [tree, title, masked, inert] = await Promise.all([
        page.ariaSnapshotJSON({ mode: 'ai', boxes: true, timeout: 10_000 }) as Promise<unknown>,
        page.title().catch(() => ''),
        maskedContent(page),
        inertBoxes(page),
    ]);
    const viewport = options.viewport ?? page.viewportSize() ?? { width: 1280, height: 900 };
    const values = await fieldValues(page, tree);
    return buildObservation(tree, { url: page.url(), title, viewport, masked, values, inert, redact: options.redact });
}

type Box = NonNullable<AriaNode['box']>;

/**
 * Boxes of the controls inside `inert` subtrees (a collapsed accordion panel, the page behind a modal). Users
 * cannot reach them, but Playwright's snapshot does not treat `inert` as hidden, so they would look clickable.
 * A box shared with a live control (a card whose whole face is an inert preview) cannot tell the two apart,
 * so it is left out and neither is hidden.
 */
async function inertBoxes(page: Page): Promise<Box[]> {
    return page.evaluate(() => {
        const roots = [...document.querySelectorAll('[inert]')];
        if (!roots.length) { return []; }
        const controls = 'a[href], button, input, select, textarea, summary, [role], [tabindex], [contenteditable]';
        // Same tolerance as `sameBox`, which matches these boxes to snapshot nodes.
        const same = (a: DOMRect, b: DOMRect) => Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;
        const live = [...document.querySelectorAll(controls)].filter(element => !element.closest('[inert]')).map(element => element.getBoundingClientRect());
        return roots.flatMap(root => [...(root.matches(controls) ? [root] : []), ...root.querySelectorAll(controls)])
            .map(element => element.getBoundingClientRect())
            .filter(rect => (rect.width || rect.height) && !live.some(other => same(other, rect)))
            .slice(0, 2000)
            .map(({ x, y, width, height }) => ({ x, y, width, height }));
    }).catch(() => []);
}

const sameBox = (a: Box, b: Box) => Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;

/** A snapshot node is the same element as a control inside an inert subtree when their boxes coincide. */
function withinInert(box: Box | undefined, inert: readonly Box[] | undefined): boolean {
    return Boolean(box && inert?.some(other => sameBox(box, other)));
}

/**
 * Exact text of the text fields, by aria ref. The snapshot folds whitespace, so a typed line break reads as a
 * space and a multi-line value never looks entered. Rich editors (contenteditable) keep the snapshot text.
 */
async function fieldValues(page: Page, tree: unknown): Promise<Record<string, string>> {
    const refs: string[] = [];
    const walk = (node: unknown): void => {
        if (Array.isArray(node)) { node.forEach(walk); return; }
        if (!node || typeof node !== 'object') { return; }
        const aria = node as AriaNode;
        if (aria.ref && TEXT_FIELDS.has(aria.role)) { refs.push(aria.ref); }
        aria.children?.forEach(walk);
    };
    walk(tree);
    const entries = await Promise.all(refs.slice(0, 40).map(async ref => [ref, await page.locator(`aria-ref=${ref}`).inputValue({ timeout: 500 }).catch(() => undefined)] as const));
    return Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => entry[1] !== undefined));
}

/**
 * Visible text inside elements with an explicit aria-label. The label becomes the accessible name and the
 * text disappears from the accessibility tree, although users see it (edit-mode cards labelled "Text").
 */
async function maskedContent(page: Page): Promise<Array<{ name: string; text: string }>> {
    return page.evaluate(() => {
        const found: Array<{ name: string; text: string }> = [];
        for (const element of document.querySelectorAll<HTMLElement>('[aria-label]')) {
            const name = element.getAttribute('aria-label')?.trim();
            // A form field's innerText is its original markup, not what it holds now; its value comes from the snapshot.
            if (!name || element.closest('[aria-hidden="true"]') || element.matches('input, textarea, select')) { continue; }
            // eslint-disable-next-line unicorn/prefer-dom-node-text-content -- innerText respects CSS visibility/layout; hidden text must not leak into observations
            const text = element.innerText;
            if (text.length > 1 && text !== name) { found.push({ name, text }); }
        }
        return found;
    }).catch(() => []);
}

interface Walk {
    node: AriaNode;
    containers: string[];
    near?: string;
    inMain: boolean;
    inChrome: boolean;
}

/** Pure transformation, unit-tested with captured snapshots. */
export function buildObservation(tree: unknown, page: { url: string; title: string; viewport: { width: number; height: number }; masked?: Array<{ name: string; text: string }>; values?: Record<string, string>; inert?: Box[]; redact?: Redactor }): Observation {
    const clip = (text: string, max: number) => clipProtected(text, max, page.redact);
    const roots = normalize(tree);
    // Consumed in document order, so repeated labels ("Text" on every card) pair with their own content.
    const masked = [...(page.masked ?? [])];
    const takeMasked = (name: string) => {
        const index = masked.findIndex(entry => entry.name === name);
        return index < 0 ? undefined : masked.splice(index, 1)[0]!.text;
    };
    const dialogs: AriaNode[] = [];
    collect(roots, node => (node.role === 'dialog' || node.role === 'alertdialog') && !node.ariaHidden, dialogs);
    // Modal libraries hide the background from the accessibility tree; a visible dialog is the scope.
    const dialog = dialogs.at(-1);
    const scope = dialog ? [dialog] : roots;

    const candidates: Array<Omit<PageElement, 'i'> & { inMain: boolean; inChrome: boolean; inert: boolean }> = [];
    const notices: string[] = [];
    const headings: string[] = [];
    const mainText: string[] = [];
    const otherText: string[] = [];

    const visit = (items: Array<AriaNode | string>, state: Omit<Walk, 'node'>): string | undefined => {
        let near = state.near;
        for (const item of items) {
            if (typeof item === 'string') {
                near = clip(item, LIMITS.near) || near;
                (state.inMain ? mainText : otherText).push(item);
                continue;
            }
            const node = item;
            if (node.ariaHidden) { continue; }
            if (NOTICES.has(node.role) && node.role !== 'alertdialog') {
                const text = clip(allText(node), LIMITS.notice);
                // Route announcers repeat the document title after every navigation; that is not page feedback.
                if (text && text === clean(page.title)) { continue; }
                if (text) { notices.push(text); }
            }
            if (node.role === 'heading' && (node.name || node.text)) { headings.push(clip(node.name || node.text || '', 120)); }
            const inMain = state.inMain || node.role === 'main' || node.role === 'dialog' || node.role === 'alertdialog';
            const inChrome = !inMain && (state.inChrome || node.role === 'navigation' || node.role === 'complementary' || node.role === 'banner' || node.role === 'contentinfo');
            const containers = CONTAINERS.has(node.role) ? [containerLabel(node, page.redact), ...state.containers].filter(Boolean) as string[] : state.containers;
            if (isElement(node)) {
                const name = clean(node.name ?? '');
                const exact = node.ref ? page.values?.[node.ref] : undefined;
                const value = VALUED.has(node.role) ? exact ?? valueOf(node) : undefined;
                const states = statesOf(node);
                const box = node.box;
                const offscreen = box ? box.y + box.height < 0 || box.y > page.viewport.height || box.x + box.width < 0 || box.x > page.viewport.width : false;
                const label = name || (node.role === 'generic' || node.role === 'img' || node.role === 'listitem' || node.role === 'cell' || node.role === 'row' ? clip(allText(node), 80) : '');
                const needsNear = !label || GENERIC_NAME.test(label) || TOGGLES.has(node.role) || label.length < 3;
                const content = name ? takeMasked(name) : undefined;
                if (content) { (inMain ? mainText : otherText).push(content); }
                candidates.push({
                    ref: node.disabled ? undefined : node.ref,
                    role: node.role,
                    name: label,
                    ...(value !== undefined ? { value: page.redact?.contains(value) ? value : SECRET.test(`${name} ${node.placeholder ?? ''}`) ? '••••' : clipValue(value, 300) } : {}),
                    ...(node.placeholder ? { placeholder: clip(node.placeholder, 80) } : {}),
                    ...(needsNear && near && near !== label ? { near } : {}),
                    ...contextOf(containers, label),
                    ...(states.length ? { states } : {}),
                    ...(node.url ? { url: shortUrl(node.url) } : {}),
                    ...(node.role === 'combobox' || node.role === 'listbox' ? optionsOf(node) : {}),
                    ...(node.disabled ? { disabled: true } : {}),
                    ...(offscreen ? { offscreen: true } : {}),
                    ...(!node.ref && !node.disabled && REVEALABLE.has(node.role) ? { reveal: true } : {}),
                    ...(content ? { content: clip(content, 160) } : {}),
                    inMain,
                    inChrome,
                    inert: withinInert(box, page.inert),
                });
                // Text inside a control belongs to the control; do not descend into its children.
                if (node.role !== 'listitem' && node.role !== 'row') {
                    near = undefined;
                    continue;
                }
            }
            // Leaf cells, headers and images carry their content as the accessible name.
            const own = !node.children?.length ? node.text || node.name : undefined;
            if (own && TEXT_ROLES.has(node.role)) {
                near = clip(own, LIMITS.near);
                (inMain ? mainText : otherText).push(own);
            }
            if (node.children?.length) {
                const last = visit(node.children, { containers, inMain, inChrome, near });
                // Text nested in a plain wrapper still labels the next sibling; a container's does not.
                near = CONTAINERS.has(node.role) ? undefined : last;
            }
        }
        return near;
    };
    visit(scope, { containers: [], inMain: Boolean(dialog), inChrome: false });

    // A clickable <label> next to its control is the control's name, not a separate target.
    for (let index = candidates.length - 1; index >= 0; index--) {
        const candidate = candidates[index]!;
        if (candidate.role === 'generic' && candidates.slice(index + 1, index + 4).some(next => next.role !== 'generic' && next.name === candidate.name)) {
            candidates.splice(index, 1);
        }
    }
    // Prefer main content and dialogs; page chrome and offscreen elements go last when trimming.
    // Controls inside an inert subtree are not offered at all, but still count toward the same-name index
    // that locates hover-revealed controls, as Playwright's role locator counts them.
    const ranked = candidates.map((element, index) => ({ element, index, rank: (element.inMain ? 0 : element.inChrome ? 2 : 1) + (element.offscreen ? 1 : 0) })).filter(entry => !entry.element.inert);
    const kept = new Set(ranked.toSorted((a, b) => a.rank - b.rank || a.index - b.index).slice(0, LIMITS.elements).map(entry => entry.index));
    const elements: PageElement[] = [];
    const seen = new Map<string, number>();
    for (const [index, { inMain: _main, inChrome: _chrome, inert: _inert, ...element }] of candidates.entries()) {
        const identity = `${element.role}\u0000${element.name}`;
        const nth = seen.get(identity) ?? 0;
        seen.set(identity, nth + 1);
        if (kept.has(index)) { elements.push({ i: elements.length, ...element, ...(element.reveal ? { nth } : {}) }); }
    }
    const text = clip([...mainText, ...(mainText.join(' ').length < 400 ? otherText : [])].map(clean).filter(Boolean).join(' · '), LIMITS.text);
    const url = shortUrl(page.url);
    const dialogName = dialog ? clean(dialog.name ?? '') || firstHeading(dialog) : '';
    const dialogText = dialog ? clip(`${dialog.role}${dialogName ? ` "${dialogName}"` : ''}`, 200) : undefined;
    const signature = createHash('sha1').update(JSON.stringify([url, dialogText, notices, text, elements.map(element => [element.role, element.name, element.value, element.states, element.disabled])])).digest('hex').slice(0, 16);
    return { url, title: page.title, ...(dialogText ? { dialog: dialogText } : {}), notices: [...new Set(notices)].slice(0, 8), headings: [...new Set(headings)].slice(0, 12), text, elements, omitted: ranked.length - elements.length, signature };
}

function firstHeading(node: AriaNode): string {
    const headings: AriaNode[] = [];
    collect(node.children ?? [], child => child.role === 'heading', headings);
    return clean(headings[0]?.name || headings[0]?.text || '');
}

function normalize(tree: unknown): Array<AriaNode | string> {
    if (Array.isArray(tree)) { return tree as Array<AriaNode | string>; }
    if (tree && typeof tree === 'object') { return [tree as AriaNode]; }
    return [];
}

function collect(items: Array<AriaNode | string>, match: (node: AriaNode) => boolean, out: AriaNode[]) {
    for (const item of items) {
        if (typeof item === 'string' || item.ariaHidden) { continue; }
        if (match(item)) { out.push(item); }
        if (item.children) { collect(item.children, match, out); }
    }
}

function isElement(node: AriaNode): boolean {
    if (INTERACTIVE.has(node.role)) { return true; }
    // Clickable non-semantic nodes (cards, rows) that carry their own text.
    if (node.cursor === 'pointer' && node.ref && !hasInteractiveDescendant(node)) {
        return Boolean(node.name || node.text || textChildren(node));
    }
    return false;
}

function hasInteractiveDescendant(node: AriaNode): boolean {
    return (node.children ?? []).some(child => typeof child !== 'string' && !child.ariaHidden && (INTERACTIVE.has(child.role) || hasInteractiveDescendant(child)));
}

function textChildren(node: AriaNode): string {
    return (node.children ?? []).filter(child => typeof child === 'string').join(' ');
}

export function allText(node: AriaNode | string): string {
    if (typeof node === 'string') { return node; }
    if (node.ariaHidden) { return ''; }
    const own = node.text ?? '';
    const name = node.name && !node.children?.length && !own ? node.name : '';
    return clean([name, own, ...(node.children ?? []).map(allText)].filter(Boolean).join(' '));
}

function valueOf(node: AriaNode): string {
    // Native <select>: the value is the selected option, which the snapshot lists as a child.
    const options: AriaNode[] = [];
    collect(node.children ?? [], child => child.role === 'option', options);
    const selected = options.filter(option => option.selected).map(option => clean(option.name ?? option.text ?? ''));
    if (selected.length) { return selected.join(', '); }
    if (node.text !== undefined) { return node.text; }
    return (node.children ?? []).map(child => typeof child === 'string' ? child : child.role === 'option' ? '' : (child.text ?? '')).join('\n').trim();
}

function optionsOf(node: AriaNode): { options?: string[] } {
    const options: AriaNode[] = [];
    collect(node.children ?? [], child => child.role === 'option', options);
    const names = options.map(option => clean(option.name ?? option.text ?? '')).filter(Boolean);
    return names.length ? { options: names.slice(0, 40) } : {};
}

function statesOf(node: AriaNode): string[] {
    const states: string[] = [];
    if (TOGGLES.has(node.role)) {
        states.push(node.checked === 'mixed' ? 'mixed' : node.checked ? 'checked' : 'unchecked');
    } else if (node.checked !== undefined) {
        states.push(node.checked === 'mixed' ? 'mixed' : node.checked ? 'checked' : 'unchecked');
    }
    if (node.expanded !== undefined) { states.push(node.expanded ? 'expanded' : 'collapsed'); }
    if (node.selected) { states.push('selected'); }
    if (node.pressed) { states.push(node.pressed === 'mixed' ? 'partly pressed' : 'pressed'); }
    if (node.invalid) { states.push('invalid'); }
    if (node.active) { states.push('focused'); }
    return states;
}

function contextOf(containers: string[], label: string): { context?: string } {
    // A list item or row that only repeats the element's own name adds nothing.
    const useful = containers.filter(container => !container.endsWith(`"${label}"`) || !/^(?:listitem|row|article) /.test(container));
    return useful.length ? { context: useful.slice(0, 2).join(' › ') } : {};
}

function containerLabel(node: AriaNode, redact?: Redactor): string | undefined {
    if (node.name) { return `${node.role} "${clipProtected(clean(node.name), 60, redact)}"`; }
    if (node.role === 'row' || node.role === 'listitem' || node.role === 'article') {
        const text = clipProtected(allText(node), 60, redact);
        return text ? `${node.role} "${text}"` : undefined;
    }
    return node.role === 'dialog' || node.role === 'alertdialog' ? node.role : undefined;
}

export function shortUrl(url: string): string {
    try {
        const parsed = new URL(url);
        return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
        return url;
    }
}

function clean(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

/** Field values are user data: keep line breaks, collapse other whitespace. */
function clipValue(text: string, max: number): string {
    const value = text.replace(/[^\S\n]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function clipProtected(text: string, max: number, redact?: Redactor): string {
    const value = clean(text);
    // Folding whitespace can join a secret's parts; never clip through either form.
    if (redact?.contains(text) || redact?.contains(value)) { return value; }
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Compact, stable description used in model state, recordings and reports. */
export function describeElement(element: Pick<PageElement, 'role' | 'name' | 'near' | 'context'>): string {
    const label = element.name ? `"${element.name}"` : element.near ? `near "${element.near}"` : '(unnamed)';
    return `${element.role} ${label}${element.name && element.near ? ` near "${element.near}"` : ''}`;
}
