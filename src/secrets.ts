import { JevwrightError } from './errors.ts';

const contents = new WeakMap<object, string>();
class SecretValue {
    toString(): string { return '{secret}'; }
    toJSON(): string { return '{secret}'; }
    [Symbol.toPrimitive](): string { return '{secret}'; }
}
export type Secret = SecretValue;

export function secret(value: string): Secret {
    if (typeof value !== 'string' || [...value].length < 6) { throw new JevwrightError('A secret must contain at least 6 Unicode code points'); }
    const handle = Object.freeze(new SecretValue());
    contents.set(handle, value);
    return handle;
}

/** Trusted test code must explicitly reveal a secret to read it. */
export function reveal(handle: Secret): string {
    const value = contents.get(handle);
    if (value === undefined) { throw new JevwrightError('Expected a secret() handle'); }
    return value;
}

export function isSecret(value: unknown): value is Secret {
    return typeof value === 'object' && value !== null && contents.has(value);
}

function encodings(value: string): string[] {
    const html = value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
    const uri = encodeURIComponent(value);
    const url = new URL(`http://jevwright.invalid/?v=${uri}`).search.slice(3);
    const form = new URLSearchParams({ v: value }).toString().slice(2);
    return [value, uri, url, form, JSON.stringify(value).slice(1, -1), Buffer.from(value).toString('base64'), html.replaceAll("'", '&#39;'), html.replaceAll("'", '&apos;')];
}

/** Engine-owned grammar stays valid; user strings and evidence are still redacted. */
const grammar: Record<string, ReadonlySet<string>> = Object.fromEntries(Object.entries({
    status: ['passed', 'failed', 'flaky', 'known', 'skipped', 'pending'],
    cause: ['product', 'agent', 'environment', 'model', 'timeout'],
    source: ['replay', 'ai', 'healed', 'code', 'jev', 'llm'],
    mode: ['replay', 'auto', 'ai'],
    kind: ['act', 'check', 'verify', 'goto', 'reload', 'back', 'run', 'jev', 'llm'],
    tool: ['click', 'type', 'select', 'press_enter', 'press_escape', 'wait', 'scroll', 'none', 'upload'],
    severity: ['low', 'medium', 'high'],
}).map(([key, values]) => [key, new Set(values)]));

export function createRedactor(secrets: Iterable<Secret> = []) {
    const originals = [...secrets].map(reveal);
    // The accessibility tree and compact observations fold whitespace before we see it.
    const forms = [...new Set(originals.flatMap(raw => [raw, raw.replace(/\s+/g, ' ').trim(), raw.replace(/[^\S\n]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim()].flatMap(encodings)))].filter(Boolean).sort((a, b) => b.length - a.length);
    const variants = (length: number) => forms.flatMap(form => {
        const result = [form];
        let escaped = JSON.stringify(form).slice(1, -1);
        while (escaped !== result.at(-1) && escaped.length <= length) {
            result.push(escaped);
            escaped = JSON.stringify(escaped).slice(1, -1);
        }
        return result;
    }).sort((a, b) => b.length - a.length);
    const text = (input: string): string => variants(input.length).reduce((result, form) => result.replaceAll(form, '{secret}'), input);
    const contains = (input: string): boolean => variants(input.length).some(form => input.includes(form));
    const value = (input: unknown, key = ''): unknown => {
        if (typeof input === 'string') { return grammar[key]?.has(input) ? input : text(input); }
        if (Array.isArray(input)) { return input.map(entry => value(entry)); }
        if (input && typeof input === 'object') {
            if (input instanceof Date) { return input.toJSON(); }
            if (isSecret(input)) { return '{secret}'; }
            // Keys carry schema and model option identities, never a declared secret's value.
            return Object.fromEntries(Object.entries(input).map(([name, entry]) => [name, value(entry, name)]));
        }
        return input;
    };
    return { text, contains, value: <T>(input: T): T => value(input) as T, active: forms.length > 0 };
}
export type Redactor = ReturnType<typeof createRedactor>;
