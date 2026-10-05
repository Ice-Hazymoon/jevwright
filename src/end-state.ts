import type { Observation } from './observe.ts';
import type { Anchor, RecordedAction, StepEnd, ValueAnchor } from './recording.ts';
import type { Redactor } from './secrets.ts';
import type { Values } from './spec.ts';
import { readPageValue } from './page-values.ts';
import { describeTarget, resolveTarget, stable, targetCount } from './recording.ts';
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
    return text.includes('…') || text.includes('...') || stable(text) !== text || /\b\d+\s*(?:ms|seconds?|minutes?|hours?)\b|\b(?:countdown|elapsed|remaining)\s*(?::\s*)?\d+|\b\d+\s+of\s+\d+\b|\(\d+\)|\b(?:count|counter)\s*(?::\s*)?\d+|\b(?:moments? ago|a moment ago)\b/i.test(text);
}
const anchorName = (name: string) => normalize(name) !== '' && !volatileAnchor(name);
function durableElement(element: Observation['elements'][number]) {
    return !element.transient && anchorName(element.name)
        && [element.ariaName, element.near, element.context, element.content].every(text => text === undefined || !volatileAnchor(text));
}

function anchors(observation: Observation): Anchor[] {
    const durable = (text: string) => anchorName(text) && !observation.transientTexts?.some(value => normalize(text).includes(normalize(value)));
    return [
        ...(observation.dialog && durable(observation.dialog) ? [{ kind: 'dialog' as const, text: observation.dialog }] : []),
        ...observation.headings.filter(durable).map(text => ({ kind: 'heading' as const, text })),
        ...observation.elements.filter(element => durableElement(element) && durable(element.name)).map(element => ({ kind: 'element' as const, target: describeTarget(element, observation) })),
    ];
}
function present(anchor: Anchor, observation: Observation): boolean {
    if (anchor.kind === 'element') { return Boolean(resolveTarget(anchor.target, observation, true)); }
    const text = normalize(anchor.text);
    if (anchor.kind === 'notice') { return observation.notices.some(notice => normalize(notice) === text); }
    return anchor.kind === 'heading' ? observation.headings.some(heading => normalize(heading) === text) : normalize(observation.dialog ?? '') === text;
}
const durableStates = (states: string[] | undefined) => states?.filter(state => state !== 'focused');

export function recordEnd(start: Observation, end: Observation, actions: RecordedAction[], redact: Redactor = createRedactor(), data: Values = {}, baseURL?: string, errors: string[] = []): StepEnd {
    const absoluteRoute = normalizedRoute(end.url, end.origin);
    const base = !!baseURL && new URL(absoluteRoute).origin === new URL(baseURL).origin;
    const route = base ? absoluteRoute.slice(new URL(baseURL!).origin.length) : absoluteRoute;
    const appeared = anchors(end).filter(anchor => !redact.contains(JSON.stringify(anchor)) && !present(anchor, start)).slice(0, 4);
    const disappearing = start.elements.filter(durableElement).map(element => describeTarget(element, start)).filter(target => !redact.contains(JSON.stringify(target)) && targetCount(target, end) < targetCount(target, start));
    const gone = disappearing.filter(target => targetCount(target, start) === 1 && targetCount(target, end) === 0).slice(0, 2);
    const reduced = disappearing.filter(target => targetCount(target, start) > 1).filter((target, index, all) => all.findIndex(other => other.role === target.role && other.name === target.name && stable(other.near) === stable(target.near) && stable(other.context) === stable(target.context)) === index).slice(0, 2).map(target => ({ target, before: targetCount(target, start), after: targetCount(target, end) }));
    const values: ValueAnchor[] = end.elements.filter(durableElement).flatMap((element) => {
        const target = describeTarget(element, end);
        const before = resolveTarget(target, start, true);
        const states = durableStates(element.states);
        const typed = actions.findLast((action) => {
            if (!action.target || !['type', 'select'].includes(action.tool)) { return false; }
            if (resolveTarget(action.target, end, true)?.i === element.i) { return true; }
            const pageValue = action.pageValue ? readPageValue(start, action.pageValue, redact) : undefined;
            return action.target.role === element.role && action.target.name.replaceAll('{page value}', pageValue ?? '') === element.name && end.elements.filter(other => other.role === element.role && other.name === element.name).length === 1;
        });
        // Revealing a form is not editing its initial values; asynchronous refreshes are not authored input.
        const edited = typed || actions.some(action => action.tool === 'press' && action.target && resolveTarget(action.target, end, true)?.i === element.i);
        const valueChanged = !!edited && element.value !== undefined && element.value !== before?.value;
        const stateChanged = !!before && JSON.stringify(states ?? []) !== JSON.stringify(durableStates(before.states) ?? []);
        const formattingChanged = !!before && element.formatting !== undefined && JSON.stringify(element.formatting) !== JSON.stringify(before.formatting);
        if (!valueChanged && !stateChanged && !formattingChanged) { return []; }
        let template = element.value ?? '';
        if ((typed?.valueKey && data[typed.valueKey] !== undefined && element.value !== data[typed.valueKey]) || typed?.template) {
            for (const [key, value] of Object.entries(data).filter(([, value]) => value).toSorted(([, a], [, b]) => b.length - a.length)) { template = template.replaceAll(value, `{${key}}`); }
        }
        const dynamic = typed?.valueKey
            ? element.value === data[typed.valueKey] ? { valueKey: typed.valueKey } : template.includes(`{${typed.valueKey}}`) ? { template } : {}
            : typed?.pageValue ? { pageValue: typed.pageValue } : typed?.template ? { template } : {};
        const anchor: ValueAnchor = { target, ...(valueChanged && !Object.keys(dynamic).length ? { value: element.value } : dynamic), ...(stateChanged ? { states: states ?? [] } : {}), ...(element.formatting ? { formatting: element.formatting } : {}) };
        return redact.contains(JSON.stringify(anchor)) || redact.contains(element.value ?? '') ? [] : [anchor];
    });
    const changedRoute = normalizedRoute(start.url, start.origin) !== absoluteRoute;
    const baseline = { strict: true as const, errors: errors.filter(error => !redact.contains(error)), notices: end.notices.filter(notice => !redact.contains(notice)) };
    if ((!changedRoute || redact.contains(route)) && !appeared.length && !gone.length && !reduced.length && !values.length) { return { ...baseline, effect: 'none' }; }
    return { ...baseline, ...(reduced.length ? { reduced } : {}), ...(!redact.contains(route) ? { route, base } : {}), ...(appeared.length ? { appeared, absentBefore: appeared } : {}), ...(gone.length ? { gone } : {}), ...(values.length ? { values } : {}) };
}

export function endMatches(end: StepEnd, observation: Observation, start?: Observation, values: Values = {}, baseURL?: string): EndCheck {
    const missing: string[] = [];
    if (end.path && normalizedPath(observation.url) !== end.path) { missing.push(`path ${end.path}`); }
    if (end.route) {
        // Unmarked recordings retain the legacy path-only contract; marked routes bind to a run or literal origin.
        const matched = end.base === undefined
            ? normalizedPath(observation.url) === normalizedPath(end.route)
            : normalizedRoute(observation.url, observation.origin) === normalizedRoute(end.route, end.base ? baseURL : undefined);
        if (!matched) { missing.push(`route ${end.route}`); }
    }
    const absent = (end.appeared ?? []).filter(anchor => !present(anchor, observation));
    if (end.strict || (end.appeared?.length ?? 0) - absent.length < Math.ceil((end.appeared?.length ?? 0) / 2)) {
        missing.push(...absent.map(anchor => anchor.kind === 'element' ? `${anchor.target.role} ${anchor.target.name}` : `${anchor.kind} ${anchor.text}`));
    }
    if (end.strict && start) {
        for (const anchor of end.absentBefore ?? []) {
            if (present(anchor, start)) { missing.push(`already present before replay: ${anchor.kind === 'element' ? anchor.target.name : anchor.text}`); }
        }
    }
    for (const target of end.gone ?? []) {
        if (end.strict ? targetCount(target, observation) > 0 : resolveTarget(target, observation, true)) { missing.push(`still present: ${target.role} ${target.name}`); }
    }
    if (end.strict) {
        for (const reduction of end.reduced ?? []) {
            if (targetCount(reduction.target, observation) !== reduction.after || (start && targetCount(reduction.target, start) !== reduction.before)) { missing.push(`count: ${reduction.target.role} ${reduction.target.name} (${reduction.before} to ${reduction.after})`); }
        }
    }
    for (const anchor of end.values ?? []) {
        const element = resolveTarget(anchor.target, observation, true);
        const value = anchor.valueKey ? values[anchor.valueKey] : anchor.pageValue ? readPageValue(observation, anchor.pageValue) : anchor.template ? anchor.template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? '{missing}') : anchor.value;
        if (!element || ((anchor.valueKey || anchor.pageValue || anchor.template || anchor.value !== undefined) && (value === undefined || element.value !== value)) || (anchor.states && JSON.stringify(durableStates(element.states) ?? []) !== JSON.stringify(anchor.states)) || (anchor.formatting !== undefined && JSON.stringify(element.formatting) !== JSON.stringify(anchor.formatting))) { missing.push(`value/state: ${anchor.target.role} ${anchor.target.name}`); }
    }
    return { checked: true, matched: missing.length === 0, ...(missing.length ? { missing } : {}) };
}
