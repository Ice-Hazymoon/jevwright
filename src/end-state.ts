import type { Observation } from './observe.ts';
import type { Anchor, RecordedAction, StepEnd, ValueAnchor } from './recording.ts';
import type { Redactor } from './secrets.ts';
import type { Values } from './spec.ts';
import { readPageValue } from './page-values.ts';
import { describeTarget, resolveTarget, stable } from './recording.ts';
import { createRedactor } from './secrets.ts';

export interface EndCheck { checked: boolean; matched?: boolean; missing?: string[]; recorded?: boolean; effect?: 'none'; failure?: 'error-shown' }
const normalize = (text: string) => text.trim().replace(/\s+/g, ' ');

export function normalizedPath(url: string): string {
    return new URL(url, 'http://jevwright.invalid').pathname.split('/').map(segment => /^\d+$/.test(segment) || /^(?=[\w-]*\d)(?=[\w-]*[a-z])[\w-]{8,}$/i.test(segment) ? ':id' : segment).join('/');
}

export function normalizedRoute(url: string, origin?: string): string {
    const parsed = new URL(url, origin ?? 'http://jevwright.invalid');
    parsed.searchParams.sort();
    return `${parsed.origin}${normalizedPath(parsed.href)}${parsed.search}`;
}

/** Dates, durations, live counters and generated ids are unstable; ordinary result numbers remain evidence. */
export function volatileAnchor(text: string): boolean {
    return stable(text) !== text || /\b\d+\s*(?:ms|seconds?|minutes?|hours?)\b|\b(?:countdown|elapsed|remaining)\s*:?\s*\d+|\b\d+\s+of\s+\d+\b/i.test(text);
}
const anchorName = (name: string) => normalize(name) !== '' && !volatileAnchor(name);

function anchors(observation: Observation): Anchor[] {
    return [
        ...(observation.dialog && anchorName(observation.dialog) ? [{ kind: 'dialog' as const, text: observation.dialog }] : []),
        ...observation.notices.filter(anchorName).map(text => ({ kind: 'notice' as const, text })),
        ...observation.headings.filter(anchorName).map(text => ({ kind: 'heading' as const, text })),
        ...observation.elements.filter(element => anchorName(element.name)).map(element => ({ kind: 'element' as const, target: describeTarget(element, observation) })),
    ];
}
function present(anchor: Anchor, observation: Observation): boolean {
    if (anchor.kind === 'element') { return Boolean(resolveTarget({ ...anchor.target, nth: 0, of: undefined }, observation, true)); }
    const text = normalize(anchor.text);
    if (anchor.kind === 'notice') { return observation.notices.some(notice => normalize(notice) === text); }
    return anchor.kind === 'heading' ? observation.headings.some(heading => normalize(heading) === text) : normalize(observation.dialog ?? '') === text;
}
const durableStates = (states: string[] | undefined) => states?.filter(state => state !== 'focused');

export function recordEnd(start: Observation, end: Observation, actions: RecordedAction[], redact: Redactor = createRedactor(), data: Values = {}, baseURL?: string): StepEnd {
    const absoluteRoute = normalizedRoute(end.url, end.origin);
    const base = !!baseURL && new URL(absoluteRoute).origin === new URL(baseURL).origin;
    const route = base ? absoluteRoute.slice(new URL(baseURL!).origin.length) : absoluteRoute;
    const appeared = anchors(end).filter(anchor => !redact.contains(JSON.stringify(anchor)) && !present(anchor, start)).slice(0, 4);
    const gone = start.elements.filter(element => anchorName(element.name)).map(element => describeTarget(element, start)).filter(target => !redact.contains(JSON.stringify(target)) && !present({ kind: 'element', target }, end)).slice(0, 2);
    const values: ValueAnchor[] = end.elements.flatMap(element => {
        const target = describeTarget(element, end);
        const before = resolveTarget(target, start, true);
        const states = durableStates(element.states);
        const valueChanged = element.value !== undefined && element.value !== before?.value;
        const stateChanged = JSON.stringify(states ?? []) !== JSON.stringify(durableStates(before?.states) ?? []);
        if (!valueChanged && !stateChanged) { return []; }
        const typed = actions.findLast(action => {
            if (!action.target || !['type', 'select'].includes(action.tool)) { return false; }
            if (resolveTarget(action.target, end, true)?.i === element.i) { return true; }
            const pageValue = action.pageValue ? readPageValue(start, action.pageValue, redact) : undefined;
            return action.target.role === element.role && action.target.name.replaceAll('{page value}', pageValue ?? '') === element.name && end.elements.filter(other => other.role === element.role && other.name === element.name).length === 1;
        });
        let template = element.value ?? '';
        if (typed?.valueKey && data[typed.valueKey] !== undefined && element.value !== data[typed.valueKey]) {
            for (const [key, value] of Object.entries(data).filter(([, value]) => value).toSorted(([, a], [, b]) => b.length - a.length)) { template = template.replaceAll(value, `{${key}}`); }
        }
        const dynamic = typed?.valueKey
            ? element.value === data[typed.valueKey] ? { valueKey: typed.valueKey } : template.includes(`{${typed.valueKey}}`) ? { template } : {}
            : typed?.pageValue ? { pageValue: typed.pageValue } : typed?.template ? { template: typed.template } : {};
        const anchor: ValueAnchor = { target, ...(valueChanged && !Object.keys(dynamic).length ? { value: element.value } : dynamic), ...(stateChanged ? { states: states ?? [] } : {}) };
        return redact.contains(JSON.stringify(anchor)) || redact.contains(element.value ?? '') ? [] : [anchor];
    });
    const changedRoute = normalizedRoute(start.url, start.origin) !== absoluteRoute;
    if ((!changedRoute || redact.contains(route)) && !appeared.length && !gone.length && !values.length) { return { effect: 'none' }; }
    return { ...(!redact.contains(route) ? { route, base } : {}), ...(appeared.length ? { appeared, absentBefore: appeared } : {}), ...(gone.length ? { gone } : {}), ...(values.length ? { values } : {}) };
}

export function endMatches(end: StepEnd, observation: Observation, start?: Observation, values: Values = {}, baseURL?: string): EndCheck {
    const missing: string[] = [];
    if (end.path && normalizedPath(observation.url) !== end.path) { missing.push(`path ${end.path}`); }
    if (end.route) {
        // Unmarked recordings retain the legacy path-only contract; marked routes bind to a run or literal origin.
        const matched = end.base === undefined ? normalizedPath(observation.url) === normalizedPath(end.route)
            : normalizedRoute(observation.url, observation.origin) === normalizedRoute(end.route, end.base ? baseURL : undefined);
        if (!matched) { missing.push(`route ${end.route}`); }
    }
    missing.push(...(end.appeared ?? []).filter(anchor => !present(anchor, observation)).map(anchor => anchor.kind === 'element' ? `${anchor.target.role} ${anchor.target.name}` : `${anchor.kind} ${anchor.text}`));
    if (start) {
        for (const anchor of end.absentBefore ?? []) {
            if (present(anchor, start)) { missing.push(`already present before replay: ${anchor.kind === 'element' ? anchor.target.name : anchor.text}`); }
        }
    }
    for (const target of end.gone ?? []) {
        if (present({ kind: 'element', target }, observation)) { missing.push(`still present: ${target.role} ${target.name}`); }
    }
    for (const anchor of end.values ?? []) {
        const element = resolveTarget(anchor.target, observation, true);
        const value = anchor.valueKey ? values[anchor.valueKey] : anchor.pageValue ? readPageValue(observation, anchor.pageValue) : anchor.template ? anchor.template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? '{missing}') : anchor.value;
        if (!element || ((anchor.valueKey || anchor.pageValue || anchor.template || anchor.value !== undefined) && (value === undefined || element.value !== value)) || (anchor.states && JSON.stringify(durableStates(element.states) ?? []) !== JSON.stringify(anchor.states))) { missing.push(`value/state: ${anchor.target.role} ${anchor.target.name}`); }
    }
    return { checked: true, matched: missing.length === 0, ...(missing.length ? { missing } : {}) };
}
