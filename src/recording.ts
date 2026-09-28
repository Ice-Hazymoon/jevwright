import type { Tool } from './browser.ts';
import type { Observation, PageElement } from './observe.ts';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { z } from 'zod';

/** How to find the same element again without a model: accessible role and name first. */
export interface TargetDescriptor {
    role: string;
    name: string;
    near?: string;
    context?: string;
    /** Position among elements that share every field above, in document order. */
    nth: number;
}

export interface RecordedAction {
    tool: Tool;
    target?: TargetDescriptor;
    /** Data key whose value is typed or selected; replay reads the current data. */
    valueKey?: string;
    /** Literal typed/selected value when it did not come from test data. */
    value?: string;
    /** Text built from several data values, e.g. `{first}\n\n{second}`; replay fills in the current data. */
    template?: string;
    double?: boolean;
    /** Typed at the cursor after earlier text in the same field, instead of replacing it. */
    append?: boolean;
}

export interface StepRecording {
    /** Hash of the step definition; a changed instruction invalidates its recording. */
    key: string;
    instruction: string;
    actions: RecordedAction[];
}

export interface TestRecording {
    version: 1;
    test: string;
    updatedAt: string;
    steps: StepRecording[];
}

const descriptorSchema = z.object({ role: z.string(), name: z.string(), near: z.string().optional(), context: z.string().optional(), nth: z.number().int().min(0) });
const recordingSchema = z.object({
    version: z.literal(1),
    test: z.string(),
    updatedAt: z.string(),
    steps: z.array(z.object({
        key: z.string(),
        instruction: z.string(),
        actions: z.array(z.object({
            tool: z.enum(['click', 'type', 'press_enter', 'press_escape', 'select', 'scroll', 'wait']),
            target: descriptorSchema.optional(),
            valueKey: z.string().optional(),
            value: z.string().optional(),
            template: z.string().optional(),
            double: z.boolean().optional(),
            append: z.boolean().optional(),
        })),
    })),
});

export function stepKey(step: { instruction: string; double?: boolean; expectError?: boolean }): string {
    return createHash('sha1').update(JSON.stringify([step.instruction, step.double ?? false, step.expectError ?? false])).digest('hex').slice(0, 12);
}

export function describeTarget(element: PageElement, observation: Observation): TargetDescriptor {
    const same = observation.elements.filter(other => sameIdentity(other, element));
    return {
        role: element.role,
        name: element.name,
        ...(element.near ? { near: element.near } : {}),
        ...(element.context ? { context: element.context } : {}),
        nth: Math.max(0, same.findIndex(other => other.i === element.i)),
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
    /\b\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AaPp]\.?[Mm]\b\.?)?/g, // 14:05, 2:05 PM
    /\b(?:\d+|an?)\s+(?:second|minute|hour|day|week|month|year)s?\s+ago\b|\b(?:just now|yesterday|today)\b/gi, // 3 minutes ago
];

/**
 * Surrounding text without what changes between runs: URLs (origin port, short codes), dates and times, and
 * generated ids (8+ characters mixing letters and digits). Row labels and short numbers ("Order #1001") still
 * tell rows apart.
 */
function stable(text: string | undefined): string {
    const timeless = WHEN.reduce((current, pattern) => current.replace(pattern, '<when>'), (text ?? '').replace(/\bhttps?:\/\/\S+/g, '<url>'));
    return timeless.replace(/\b(?=[\w-]*\d)(?=[\w-]*[a-z])[\w-]{8,}\b/gi, '<id>');
}

/**
 * Find the recorded element on a fresh observation. Exact identity first; then role+name with the
 * same count of look-alikes, so the k-th stays the k-th only while none were added or removed.
 */
export function resolveTarget(target: TargetDescriptor, observation: Observation): PageElement | undefined {
    const actionable = observation.elements.filter(element => (element.ref || element.reveal) && !element.disabled);
    const exact = actionable.filter(element => sameIdentity(element, target));
    if (exact.length > target.nth) { return exact[target.nth]; }
    const named = actionable.filter(element => element.role === target.role && element.name === target.name && target.name !== '');
    if (named.length === 1 && target.nth === 0) { return named[0]; }
    const near = target.near ? actionable.filter(element => element.role === target.role && element.near === target.near) : [];
    if (near.length === 1 && target.nth === 0) { return near[0]; }
    return undefined;
}

export function createRecordingStore(directory: string | undefined) {
    const path = (test: string) => join(directory!, `${test}.json`);
    return {
        enabled: Boolean(directory),
        async load(test: string): Promise<TestRecording | undefined> {
            if (!directory) { return undefined; }
            try {
                return recordingSchema.parse(JSON.parse(await readFile(path(test), 'utf8')));
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; }
                const problem = error instanceof z.ZodError
                    ? error.issues.slice(0, 3).map(issue => `${issue.path.join('.') || 'file'}: ${issue.message}`).join('; ')
                    : error instanceof Error ? error.message : String(error);
                throw new Error(`Invalid recording ${relative(process.cwd(), path(test))} (${problem})`);
            }
        },
        /** Atomic write; steps keep definition order. */
        async save(recording: TestRecording): Promise<void> {
            if (!directory) { return; }
            await mkdir(dirname(path(recording.test)), { recursive: true });
            const temporary = `${path(recording.test)}.${process.pid}.tmp`;
            await writeFile(temporary, `${JSON.stringify(recording, null, 2)}\n`);
            await rename(temporary, path(recording.test));
        },
    };
}
export type RecordingStore = ReturnType<typeof createRecordingStore>;
