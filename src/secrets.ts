import { JevwrightError } from './errors.ts';

const contents = new WeakMap<object, string>();
export type SecretPurpose = 'password' | 'any';
const purposes = new WeakMap<object, SecretPurpose>();
class SecretValue {
    toString(): string { return '{secret}'; }
    toJSON(): string { return '{secret}'; }
    [Symbol.toPrimitive](): string { return '{secret}'; }
}
export type Secret = SecretValue;

export function secret(value: string, options: { purpose?: SecretPurpose } = {}): Secret {
    const purpose = options.purpose ?? 'password';
    if (purpose !== 'password' && purpose !== 'any') { throw new JevwrightError('Secret purpose must be password or any'); }
    if (typeof value !== 'string' || [...value].length < 6) { throw new JevwrightError('A secret must contain at least 6 Unicode code points'); }
    const handle = Object.freeze(new SecretValue());
    contents.set(handle, value);
    purposes.set(handle, purpose);
    return handle;
}

export function secretPurpose(handle: Secret): SecretPurpose {
    if (!contents.has(handle)) { throw new JevwrightError('Expected a secret() handle'); }
    return purposes.get(handle) ?? 'password';
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

const unicodeEscape = (character: string) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;

/** Base64 runs that only depend on the secret's bytes, wherever it starts inside a longer encoded payload. */
function base64Runs(value: string): string[] {
    const bytes = Buffer.from(value);
    return [0, 1, 2].map((offset) => {
        const encoded = Buffer.concat([Buffer.alloc(offset), bytes]).toString('base64');
        return encoded.slice(Math.ceil(offset * 8 / 6), Math.floor((offset + bytes.length) * 8 / 6));
    });
}

function encodings(value: string): string[] {
    const html = value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
    const uri = encodeURIComponent(value);
    const url = new URL(`http://jevwright.invalid/?v=${uri}`).search.slice(3);
    const form = new URLSearchParams({ v: value }).toString().slice(2);
    // Browsers percent-encode the raw value differently per URL part; `page.url()` reports those spellings.
    const browser = [new URL(`http://jevwright.invalid/?v=${value}`).search.slice(3), new URL(`http://jevwright.invalid/${value}`).pathname.slice(1), new URL(`http://jevwright.invalid/#${value}`).hash.slice(1)];
    // Serialized payloads (devalue, Nuxt) escape markup characters as \uXXXX.
    const escaped = [value.replace(/[<>&'/\u2028\u2029]/g, unicodeEscape), value.replace(/[^\w ]/g, unicodeEscape)];
    return [value, uri, url, form, ...browser, ...escaped, JSON.stringify(value).slice(1, -1), Buffer.from(value).toString('base64'), ...base64Runs(value), html.replaceAll('\'', '&#39;'), html.replaceAll('\'', '&#x27;'), html.replaceAll('\'', '&apos;')];
}

/** Engine-owned grammar stays valid; user strings and evidence are still redacted. */
const grammar: Record<string, ReadonlySet<string>> = Object.fromEntries(Object.entries({
    status: ['passed', 'failed', 'flaky', 'known', 'skipped', 'pending'],
    cause: ['product', 'agent', 'environment', 'model', 'timeout'],
    source: ['replay', 'ai', 'healed', 'code', 'jev', 'llm'],
    mode: ['replay', 'auto', 'ai'],
    kind: ['act', 'check', 'verify', 'goto', 'reload', 'back', 'run', 'jev', 'llm', 'page-error', 'asset-load', 'app-unreachable', 'console-error', 'hydration-mismatch', 'http-5xx', 'http-4xx', 'request-failed', 'raw-i18n-key', 'text-anomaly', 'ui-error', 'semantic', 'accessibility'],
    tool: ['click', 'type', 'press', 'select_text', 'select', 'press_enter', 'press_escape', 'wait', 'scroll', 'none', 'upload', 'hover', 'right_click', 'long_press', 'double_click', 'drag', 'back', 'scroll_to'],
    severity: ['low', 'medium', 'high'],
    failure: ['assertion', 'invariant', 'exception', 'blocking-issue', 'not-recorded', 'timeout', 'expectation', 'not-found', 'ambiguous', 'stuck', 'max-actions', 'model', 'error-shown'],
}).map(([key, values]) => [key, new Set(values)]));

export function createRedactor(secrets: Iterable<Secret> = []) {
    const originals = [...secrets].map(reveal);
    // The accessibility tree and compact observations fold whitespace before we see it.
    // Folded and encoded spellings shorter than the minimum would redact ordinary text ("a" inside "banana").
    const forms = [...new Set(originals.flatMap(raw => [raw, raw.replace(/\s+/g, ' ').trim(), raw.replace(/[^\S\n]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim()].flatMap(encodings)))].filter(form => [...form].length >= 6).sort((a, b) => b.length - a.length);
    const variants = (length: number) => forms.flatMap((form) => {
        const result = [form];
        let escaped = JSON.stringify(form).slice(1, -1);
        while (escaped !== result.at(-1) && escaped.length <= length) {
            result.push(escaped);
            escaped = JSON.stringify(escaped).slice(1, -1);
        }
        return result;
    }).sort((a, b) => b.length - a.length);
    // Overlapping secrets are merged into one span, so no fragment of either survives between replacements.
    const text = (input: string): string => {
        const spans: Array<[number, number]> = [];
        for (const form of variants(input.length)) {
            for (let at = input.indexOf(form); at >= 0; at = input.indexOf(form, at + 1)) { spans.push([at, at + form.length]); }
        }
        if (!spans.length) { return input; }
        spans.sort((a, b) => a[0] - b[0]);
        const merged: Array<[number, number]> = [];
        for (const span of spans) {
            const last = merged.at(-1);
            if (last && span[0] <= last[1]) { last[1] = Math.max(last[1], span[1]); } else { merged.push([...span]); }
        }
        return merged.reduceRight((result, [from, to]) => `${result.slice(0, from)}{secret}${result.slice(to)}`, input);
    };
    const contains = (input: string): boolean => variants(input.length).some(form => input.includes(form));
    const value = (input: unknown, engine = false, key = '', keepKeys = engine): unknown => {
        if (typeof input === 'string') { return engine && (grammar[key]?.has(input) || (key === 'selectionKey' && /^sha256:[a-f0-9]{64}$/.test(input)) || (['startedAt', 'finishedAt'].includes(key) && /^\d{4}-\d{2}-\d{2}T/.test(input))) ? input : text(input); }
        if (Array.isArray(input)) { return input.map(entry => value(entry, engine, '', keepKeys)); }
        if (input && typeof input === 'object') {
            if (input instanceof Date) { return text(input.toJSON()); }
            // Byte arrays would otherwise serialize as numbers that still spell the secret.
            if (ArrayBuffer.isView(input)) { return contains(Buffer.from(input.buffer, input.byteOffset, input.byteLength).toString('utf8')) ? '{secret}' : input; }
            if (isSecret(input)) { return '{secret}'; }
            // Evidence and metadata are user objects, even when their keys resemble result grammar.
            return Object.fromEntries(Object.entries(input).map(([name, entry]) => [keepKeys ? name : text(name), value(entry, engine && !['evidence', 'reference', 'metadata'].includes(name), name, keepKeys && !['evidence', 'reference', 'metadata'].includes(name))]));
        }
        return input;
    };
    return { text, contains, value: <T>(input: T): T => value(input) as T, result: <T>(input: T): T => value(input, true) as T, state: <T>(input: T): T => value(input, false, '', true) as T, active: forms.length > 0 };
}
export type Redactor = ReturnType<typeof createRedactor>;

/** Only engine-owned results use grammar preservation; model payloads never do. */
export function forResults(redact: Redactor): Redactor { return { ...redact, value: redact.result }; }
