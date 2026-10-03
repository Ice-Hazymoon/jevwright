import type { Observation } from './observe.ts';
import type { PageValueDescriptor } from './recording.ts';
import type { Redactor } from './secrets.ts';

const MARKER = /\{secret\}|<secret\s+value>/;
const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();

function sources(observation: Observation, redact?: Redactor): Array<{ source: PageValueDescriptor['source']; text: string }> {
    return [
        { source: 'text' as const, text: observation.text },
        ...observation.notices.map(text => ({ source: 'notice' as const, text })),
        ...observation.elements.flatMap(element => [
            { source: 'name' as const, text: element.name },
            ...(element.content ? [{ source: 'content' as const, text: element.content }] : []),
        ]),
    ].flatMap(entry => entry.text.split(MARKER).flatMap(text => (redact?.text(text) ?? text).split(MARKER)).map(text => ({ ...entry, text: normalize(text) }))).filter(entry => entry.text);
}

/** Only exact, case-sensitive observed spans qualify; redacted markers cannot become input. */
export function describePageValue(observation: Observation, value: string, redact?: Redactor): PageValueDescriptor | undefined {
    const text = normalize(value);
    if (!text || redact?.contains(text) || /\{secret\}|<secret value>/.test(text)) { return undefined; }
    let ambiguous: PageValueDescriptor | undefined;
    for (const entry of sources(observation, redact)) {
        const at = entry.text.indexOf(text);
        if (at < 0) { continue; }
        const descriptor = { source: entry.source, before: entry.text.slice(Math.max(0, at - 60), at), after: entry.text.slice(at + text.length, at + text.length + 60) };
        if (redact?.contains(JSON.stringify(descriptor))) { continue; }
        if (readPageValue(observation, descriptor, redact) === text) { return descriptor; }
        ambiguous ??= { ...descriptor, requiresModel: true };
    }
    return ambiguous;
}

/** Changed, missing or ambiguous context requires fresh grounding instead of a guessed replay value. */
export function readPageValue(observation: Observation, descriptor: PageValueDescriptor, redact?: Redactor): string | undefined {
    if (descriptor.requiresModel) { return undefined; }
    const found: string[] = [];
    for (const entry of sources(observation, redact).filter(entry => entry.source === descriptor.source)) {
        for (let at = descriptor.before ? entry.text.indexOf(descriptor.before) : 0; at >= 0;) {
            const from = at + descriptor.before.length;
            const to = descriptor.after ? entry.text.indexOf(descriptor.after, from) : entry.text.length;
            if (to >= from) {
                const value = normalize(entry.text.slice(from, to));
                if (value && !redact?.contains(value) && !/\{secret\}|<secret value>/.test(value)) { found.push(value); }
            }
            if (!descriptor.before) { break; }
            at = entry.text.indexOf(descriptor.before, at + 1);
        }
    }
    return found.length === 1 ? found[0] : undefined;
}

/** A bounded choice vocabulary for Jev; the helper can request any other exact observed span. */
export function pageValueChoices(observation: Observation, redact?: Redactor): string[] {
    const candidates = new Set<string>();
    for (const entry of sources(observation, redact)) {
        const text = (redact?.text(entry.text) ?? entry.text).replaceAll('{secret}', ' ');
        if (text.length <= 160 && text.trim()) { candidates.add(normalize(text)); }
        for (const match of text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}_@.+/\-]*/gu)) {
            candidates.add(match[0].replace(/[.,/\-]+$/, ''));
        }
    }
    return [...candidates].filter(value => describePageValue(observation, value, redact)).slice(0, 180);
}
