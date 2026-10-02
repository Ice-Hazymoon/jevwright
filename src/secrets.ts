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

export function createRedactor(secrets: Iterable<Secret> = []) {
    const forms = [...new Set([...secrets].flatMap(handle => encodings(reveal(handle))))].sort((a, b) => b.length - a.length);
    const text = (value: string): string => forms.reduce((result, form) => result.replaceAll(form, '{secret}'), value);
    const contains = (value: string): boolean => forms.some(form => value.includes(form));
    const value = (input: unknown): unknown => {
        if (typeof input === 'string') { return text(input); }
        if (Array.isArray(input)) { return input.map(value); }
        if (input && typeof input === 'object') {
            if (input instanceof Date) { return input.toJSON(); }
            if (isSecret(input)) { return '{secret}'; }
            return Object.fromEntries(Object.entries(input).map(([key, entry]) => [text(key), value(entry)]));
        }
        return input;
    };
    return { text, contains, value: <T>(input: T): T => value(input) as T, active: forms.length > 0 };
}
export type Redactor = ReturnType<typeof createRedactor>;
