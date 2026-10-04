import type { Tool } from './browser.ts';
import type { Observation, PageElement } from './observe.ts';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

/** How to find the same element again without a model: accessible role and name first. */
export interface TargetDescriptor {
    role: string;
    name: string;
    /** Original accessible name when the visible label is primary. */
    ariaName?: string;
    near?: string;
    context?: string;
    /** Position among elements that share every field above, in document order. */
    nth: number;
    /** Count sharing the full identity; an ordinal is valid only while this count stays unchanged. */
    of?: number;
}

export interface PageValueDescriptor {
    source: 'text' | 'notice' | 'name' | 'content';
    /** Text on either side of the value; the value itself is read anew. */
    before: string;
    after: string;
    /** The observed span was valid, but its context could not identify a unique replay source. */
    requiresModel?: true;
}

export interface RecordedAction {
    tool: Tool;
    target?: TargetDescriptor;
    /** Data key whose value is typed or selected; replay reads the current data. */
    valueKey?: string;
    /** A value read from the current observation, never a literal replay input. */
    pageValue?: PageValueDescriptor;
    /** Literal typed/selected value when it did not come from test data. */
    value?: string;
    key?: string;
    times?: number;
    /** Text built from several data values, e.g. `{first}\n\n{second}`; replay fills in the current data. */
    template?: string;
    double?: boolean;
    /** Typed at the cursor after earlier text in the same field, instead of replacing it. */
    append?: boolean;
    destination?: TargetDescriptor;
    fileKeys?: string[];
    scrollText?: string;
    scrollDirection?: 'up' | 'down';
}

export type Anchor = { kind: 'element'; target: TargetDescriptor } | { kind: 'heading' | 'dialog' | 'notice'; text: string };
export interface ValueAnchor { target: TargetDescriptor; value?: string; states?: string[]; valueKey?: string; pageValue?: PageValueDescriptor; template?: string }
/** base=true binds a route to the run baseURL; false keeps its literal origin; absent retains legacy path checks. */
export interface StepEnd { path?: string; route?: string; base?: boolean; appeared?: Anchor[]; gone?: TargetDescriptor[]; absentBefore?: Anchor[]; values?: ValueAnchor[]; effect?: 'none' }
export interface CheckEvidence { text: string; region: string; target?: TargetDescriptor; value?: string; states?: string[]; source: 'text' | 'notice' | 'heading' | 'element' }

export interface StepRecording {
    /** Hash of the step definition; a changed instruction invalidates its recording. */
    key: string;
    instruction: string;
    actions: RecordedAction[];
    end?: StepEnd;
    occurrence?: number;
    checkEvidence?: CheckEvidence[];
    checkClaim?: string;
}

export interface TestRecording {
    version: 1;
    test: string;
    updatedAt: string;
    steps: StepRecording[];
    partial?: true;
}

const descriptorSchema = z.object({ role: z.string(), name: z.string(), ariaName: z.string().optional(), near: z.string().optional(), context: z.string().optional(), nth: z.number().int().min(0), of: z.number().int().positive().optional() });
const pageValueSchema = z.object({ source: z.enum(['text', 'notice', 'name', 'content']), before: z.string(), after: z.string(), requiresModel: z.literal(true).optional() });
const anchorSchema = z.union([z.object({ kind: z.literal('element'), target: descriptorSchema }), z.object({ kind: z.enum(['heading', 'dialog', 'notice']), text: z.string() })]);
const recordingSchema = z.object({
    version: z.literal(1),
    test: z.string(),
    updatedAt: z.string(),
    partial: z.literal(true).optional(),
    steps: z.array(z.object({
        key: z.string(),
        instruction: z.string(),
        occurrence: z.number().int().positive().optional(),
        checkEvidence: z.array(z.object({ text: z.string(), region: z.string(), source: z.enum(['text', 'notice', 'heading', 'element']), target: descriptorSchema.optional(), value: z.string().optional(), states: z.array(z.string()).optional() })).optional(),
        checkClaim: z.string().optional(),
        end: z.object({
            path: z.string().optional(),
            route: z.string().optional(),
            base: z.boolean().optional(),
            appeared: z.array(anchorSchema).optional(),
            gone: z.array(descriptorSchema).optional(),
            absentBefore: z.array(anchorSchema).optional(),
            values: z.array(z.object({ target: descriptorSchema, value: z.string().optional(), states: z.array(z.string()).optional(), valueKey: z.string().optional(), pageValue: pageValueSchema.optional(), template: z.string().optional() })).optional(),
            effect: z.literal('none').optional(),
        }).optional(),
        actions: z.array(z.object({
            tool: z.enum(['click', 'type', 'press', 'select_text', 'press_enter', 'press_escape', 'select', 'scroll', 'wait', 'upload', 'hover', 'right_click', 'long_press', 'double_click', 'drag', 'back', 'scroll_to']),
            target: descriptorSchema.optional(),
            valueKey: z.string().optional(),
            pageValue: pageValueSchema.optional(),
            value: z.string().optional(),
            key: z.string().min(1).optional(),
            times: z.number().int().min(1).max(20).optional(),
            template: z.string().optional(),
            double: z.boolean().optional(),
            append: z.boolean().optional(),
            destination: descriptorSchema.optional(),
            fileKeys: z.array(z.string()).optional(),
            scrollText: z.string().optional(),
            scrollDirection: z.enum(['up', 'down']).optional(),
        })),
    })),
});

export function stepKey(step: { instruction: string; double?: boolean; expectError?: boolean }, occurrence = 1): string {
    const identity: unknown[] = [step.instruction, step.double ?? false, step.expectError ?? false];
    if (occurrence > 1) { identity.push(occurrence); }
    return createHash('sha1').update(JSON.stringify(identity)).digest('hex').slice(0, 12);
}

export function describeTarget(element: PageElement, observation: Observation): TargetDescriptor {
    const same = observation.elements.filter(other => sameIdentity(other, element));
    return {
        role: element.role,
        name: element.name,
        ...(element.ariaName ? { ariaName: element.ariaName } : {}),
        ...(element.near ? { near: element.near } : {}),
        ...(element.context ? { context: element.context } : {}),
        nth: Math.max(0, same.findIndex(other => other.i === element.i)),
        of: same.length,
    };
}

function sameIdentity(a: Pick<PageElement, 'role' | 'name' | 'near' | 'context'>, b: Pick<PageElement, 'role' | 'name' | 'near' | 'context'>): boolean {
    return a.role === b.role && a.name === b.name && stable(a.near) === stable(b.near) && stable(a.context) === stable(b.context);
}

const MONTH = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?';

/**
 * Dates and times as apps print them; a row's "Created" column changes every day a recording is replayed.
 * Applied in order: "1 Sep 27, 2026" (a count, then a date) must lose "Sep 27, 2026", not "1 Sep".
 */
const WHEN = [
    /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g, // 2026-09-28, 2026-09-28T14:05:00Z
    /\b\d{4}\/\d{1,2}\/\d{1,2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b\d{1,2}\.\d{1,2}\.\d{4}\b/g, // 2026/9/28, 9/28/2026, 28.09.2026
    /\d{4}年\d{1,2}月\d{1,2}日/g, // 2026年9月28日
    new RegExp(`\\b${MONTH}\\s+\\d{1,2}(?:,?\\s+\\d{4})?\\b`, 'gi'), // Sep 28, 2026
    new RegExp(`\\b\\d{1,2}\\s+${MONTH}(?:\\s+\\d{4})?\\b`, 'gi'), // 28 Sept 2026
    /\b\d{1,2}:\d{2}(?::\d{2})?(?:\s?[ap]\.?m\b\.?)?/gi, // 14:05, 2:05 PM
    /\b(?:\d+|an?)\s+(?:second|minute|hour|day|week|month|year)s?\s+ago\b|\b(?:just now|yesterday|today)\b/gi, // 3 minutes ago
];

/**
 * Surrounding text without what changes between runs: URLs (origin port, short codes), dates and times, and
 * generated ids (8+ characters mixing letters and digits). Row labels and short numbers ("Order #1001") still
 * tell rows apart.
 */
export function stable(text: string | undefined): string {
    const timeless = WHEN.reduce((current, pattern) => current.replace(pattern, '<when>'), (text ?? '').replace(/\bhttps?:\/\/\S+/g, '<url>'));
    return timeless.replace(/\b(?=[\w-]*\d)(?=[\w-]*[a-z])[\w-]{8,}\b/gi, '<id>');
}

/**
 * Find the recorded element on a fresh observation. Exact identity first; then role+name with the
 * same count of look-alikes, so the k-th stays the k-th only while none were added or removed.
 */
export function resolveTarget(target: TargetDescriptor, observation: Observation, allowDisabled = false): PageElement | undefined {
    return resolveTargetMatch(target, observation, allowDisabled).element;
}

/** Unique means exact full identity, not a fallback or an nth among duplicates. */
export function resolveTargetMatch(target: TargetDescriptor, observation: Observation, allowDisabled = false): { element?: PageElement; unique: boolean } {
    const actionable = observation.elements.filter(element => allowDisabled || ((element.ref || element.reveal) && !element.disabled));
    const exact = observation.elements.filter(element => sameIdentity(!target.ariaName && element.ariaName ? { ...element, name: element.ariaName } : element, target));
    if (target.of !== undefined && exact.length !== target.of && (exact.length > 0 || target.of > 1)) { return { unique: false }; }
    if (exact.length > target.nth) {
        const element = exact[target.nth]!;
        return actionable.includes(element) ? { element, unique: exact.length === 1 && target.nth === 0 } : { unique: false };
    }
    const named = actionable.filter(element => element.role === target.role && (element.name === target.name || element.ariaName === target.name) && target.name !== '');
    if (named.length === 1 && target.nth === 0) { return { element: named[0], unique: false }; }
    const near = target.near ? actionable.filter(element => element.role === target.role && element.near === target.near) : [];
    if (near.length === 1 && target.nth === 0) { return { element: near[0], unique: false }; }
    return { unique: false };
}

export function createRecordingStore(directory: string | undefined) {
    const path = (test: string, device = 'desktop') => join(directory!, `${test}${device === 'desktop' ? '' : `.${device}`}.json`);
    return {
        enabled: Boolean(directory),
        async load(test: string, device = 'desktop'): Promise<TestRecording | undefined> {
            if (!directory) { return undefined; }
            try {
                return recordingSchema.parse(JSON.parse(await readFile(path(test, device), 'utf8')));
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; }
                const problem = error instanceof z.ZodError
                    ? error.issues.slice(0, 3).map(issue => `${issue.path.join('.') || 'file'}: ${issue.message}`).join('; ')
                    : error instanceof Error ? error.message : String(error);
                throw new Error(`Invalid recording ${relative(process.cwd(), path(test, device))} (${problem})`);
            }
        },
        /** Atomic write; steps keep definition order. */
        async save(recording: TestRecording, device = 'desktop'): Promise<void> {
            if (!directory) { return; }
            await mkdir(dirname(path(recording.test, device)), { recursive: true });
            const temporary = `${path(recording.test, device)}.${process.pid}.tmp`;
            await writeFile(temporary, `${JSON.stringify(recording, null, 2)}\n`);
            await rename(temporary, path(recording.test, device));
        },
    };
}
export type RecordingStore = ReturnType<typeof createRecordingStore>;

/** Positions (0-based) of steps whose recorded recipe changed; a step with no previous entry is new, not rerouted. */
export function changedActionSteps(previous: TestRecording | undefined, steps: StepRecording[]): number[] {
    return steps.flatMap((step, index) => {
        const old = previous?.steps.find(entry => entry.key === step.key);
        return old && actionSignature(old.actions) !== actionSignature(step.actions) ? [index] : [];
    });
}

/** Compare the replay recipe, not timestamps; new, dropped and backfilled steps all count. */
export function learnedRecording(previous: TestRecording | undefined, steps: StepRecording[]): boolean {
    const keys = new Set(steps.map(step => step.key));
    return changedActionSteps(previous, steps).length > 0
        || steps.some(step => !previous?.steps.some(entry => entry.key === step.key))
        || (previous?.steps.some(entry => !keys.has(entry.key)) ?? false)
        || steps.some(step => step.end !== undefined && previous?.steps.find(entry => entry.key === step.key)?.end === undefined)
        || steps.some(step => !isDeepStrictEqual(step.checkEvidence, previous?.steps.find(entry => entry.key === step.key)?.checkEvidence));
}

function actionSignature(actions: RecordedAction[]): string {
    return JSON.stringify(actions.map(action => [action.tool, action.target ? [action.target.role, action.target.name, action.target.ariaName ?? null, stable(action.target.near), stable(action.target.context), action.target.nth] : null, action.valueKey ?? null, action.value ?? null, action.template ?? null, action.pageValue ?? null, action.double ?? false, action.append ?? false, action.destination ? [action.destination.role, action.destination.name, action.destination.ariaName ?? null, stable(action.destination.near), stable(action.destination.context), action.destination.nth] : null, action.fileKeys ?? null, action.scrollText ?? null, action.scrollDirection ?? null, action.key ?? null, action.times ?? null]));
}
