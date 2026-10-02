import type { Observation, PageElement } from './observe.ts';
import type { Anchor, RecordedAction, StepEnd } from './recording.ts';
import { createRedactor, type Redactor } from './secrets.ts';
import { describeTarget, resolveTarget, stable } from './recording.ts';

export interface EndCheck { checked: boolean; matched?: boolean; missing?: string[]; recorded?: boolean }
const normalize = (text: string) => text.trim().replace(/\s+/g, ' ');

export function normalizedPath(url: string): string {
    return new URL(url, 'http://jevwright.invalid').pathname.split('/').map(segment => /^\d+$/.test(segment) || /^(?=[\w-]*\d)(?=[\w-]*[a-z])[\w-]{8,}$/i.test(segment) ? ':id' : segment).join('/');
}

function anchorName(name: string): boolean {
    return normalize(name) !== '' && !/\p{N}/u.test(name) && stable(name) === name;
}

function anchors(observation: Observation): Anchor[] {
    return [
        ...(observation.dialog && anchorName(observation.dialog) ? [{ kind: 'dialog' as const, text: observation.dialog }] : []),
        ...observation.headings.filter(anchorName).map(text => ({ kind: 'heading' as const, text })),
        ...observation.elements.filter(element => anchorName(element.name)).map(element => ({ kind: 'element' as const, target: describeTarget(element, observation) })),
    ];
}

function present(anchor: Anchor, observation: Observation): boolean {
    if (anchor.kind === 'element') { return Boolean(resolveTarget(anchor.target, observation, true)); }
    const text = normalize(anchor.text);
    return anchor.kind === 'heading' ? observation.headings.some(heading => normalize(heading) === text) : normalize(observation.dialog ?? '') === text;
}

export function recordEnd(start: Observation, end: Observation, actions: RecordedAction[], redact: Redactor = createRedactor()): StepEnd {
    const path = new URL(start.url, 'http://jevwright.invalid').pathname !== new URL(end.url, 'http://jevwright.invalid').pathname ? normalizedPath(end.url) : undefined;
    if (actions.length && actions.every(action => action.tool === 'type')) { return path && !redact.contains(path) ? { path } : {}; }
    const appeared = anchors(end).filter(anchor => !redact.contains(JSON.stringify(anchor)) && !present(anchor, start)).slice(0, 4);
    const gone = start.elements.filter((element: PageElement) => anchorName(element.name)).map(element => describeTarget(element, start)).filter(target => !redact.contains(JSON.stringify(target)) && !resolveTarget(target, end, true)).slice(0, 2);
    return { ...(path && !redact.contains(path) ? { path } : {}), ...(appeared.length ? { appeared } : {}), ...(gone.length ? { gone } : {}) };
}

export function endMatches(end: StepEnd, observation: Observation): EndCheck {
    const missing: string[] = [];
    if (end.path && normalizedPath(observation.url) !== end.path) { missing.push(`path ${end.path}`); }
    const absent = (end.appeared ?? []).filter(anchor => !present(anchor, observation));
    if ((end.appeared?.length ?? 0) - absent.length < Math.ceil((end.appeared?.length ?? 0) / 2)) {
        missing.push(...absent.map(anchor => anchor.kind === 'element' ? `${anchor.target.role} ${anchor.target.name}` : `${anchor.kind} ${anchor.text}`));
    }
    for (const target of end.gone ?? []) {
        if (resolveTarget(target, observation, true)) { missing.push(`still present: ${target.role} ${target.name}`); }
    }
    return { checked: true, matched: missing.length === 0, ...(missing.length ? { missing } : {}) };
}
