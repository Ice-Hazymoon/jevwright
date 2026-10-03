import type { ModelSettings } from '../../src/models.ts';
import type { Experimental_EvaluationModel } from 'ai';
import { Experimental_EvaluationMockModelV4, MockLanguageModelV4 } from 'ai/test';

type Evaluate = Exclude<Experimental_EvaluationModel, string>['doEvaluate'];
type Answer = Awaited<ReturnType<Evaluate>>['answers'][string];
type EvaluationQuestion = Parameters<Evaluate>[0]['questions'][string];

/** The page as the engine serializes it for Jev (see `pageState`). */
export interface View {
    step?: string;
    /** The following act step, when the engine shares it. */
    next?: string;
    claim?: string;
    values: Record<string, string>;
    history: Array<Record<string, string>>;
    url: string;
    text: string;
    notices: string[];
    /** Notices the engine reports as already on the page before this step began. */
    shownBefore: string[];
    /** Value keys the engine confirmed are exactly in a field, with that field. */
    entered: Record<string, string>;
    dialog?: string;
    elements: ViewElement[];
}
export interface ViewElement {
    i: number;
    role: string;
    name?: string;
    value?: string;
    near?: string;
    in?: string;
    state?: string;
    options?: string[];
    scroll?: unknown;
}

/** What a scripted Jev "believes" about the current state; unset answers default to unlikely. */
export interface Belief {
    done?: number;
    error?: number;
    tool?: string;
    target?: (element: ViewElement) => boolean;
    value?: string;
    destination?: (element: ViewElement) => boolean;
    option?: string;
    scrollText?: string;
    fileGroup?: 'selected' | 'all';
    scrollDirection?: 'up' | 'down';
    anomaly?: number;
    holds?: number;
    support?: 'supports' | 'contradicts' | 'not_shown';
    /** Whether the step's actions operated on what the step names (post-failure audit); defaults to yes. */
    onTarget?: number;
}

export interface ScriptedCall { questions: string[]; view: View }

const onTarget = (p: number): Answer => ({ type: 'choice', choice: p >= 0.5 ? 'named' : 'different', probabilities: { named: p, different: 1 - p } });

/**
 * Deterministic stand-in for Jev and the helper LLM, driven through the real AI SDK
 * `experimental_evaluate` / `generateText` paths so answer validation runs as in production.
 */
export function scriptedModels(policy: (view: View) => Belief, helper?: (view: View, why: string) => Record<string, unknown>, options: { costPerCall?: number } = {}) {
    const calls: ScriptedCall[] = [];
    // Reported the same way OpenRouter reports it, so `costOf` in models.ts picks it up.
    const cost = options.costPerCall !== undefined ? { providerMetadata: { openrouter: { usage: { cost: options.costPerCall } } } } : {};
    const evaluation = new Experimental_EvaluationMockModelV4({
        doEvaluate: async ({ state, questions }) => {
            const view = toView(state as Record<string, unknown>);
            calls.push({ questions: Object.keys(questions), view });
            const belief = policy(view);
            const answers: Record<string, Answer> = {};
            // Post-failure audit: one question per earlier act step, each judged by the policy for that step.
            const audited = ((state as { steps?: Array<Record<string, unknown>> }).steps ?? []).map(entry => policy(toView({ task: entry })));
            for (const [id, question] of Object.entries(questions)) {
                const step = /^on_target_(\d+)$/.exec(id);
                answers[id] = step ? onTarget(audited[Number(step[1])]?.onTarget ?? 0.95) : answer(id, question, belief, view);
            }
            return { answers, usage: { inputTokens: 1000, outputTokens: 10 }, warnings: [], ...cost };
        },
    });
    const language = new MockLanguageModelV4({
        doGenerate: async ({ prompt }) => {
            const text = JSON.stringify(prompt);
            const payload = JSON.parse(extractJson(text)) as Record<string, unknown>;
            const view = toView({ task: { step: payload.step, values: payload.values, history: payload.history }, page: payload.page, claim: payload.claim });
            const output = helper?.(view, String(payload.why_you_are_asked ?? '')) ?? { outcome: 'impossible', tool: null, element: null, value_key: null, text: null, reason: 'scripted helper has no answer' };
            return {
                content: [{ type: 'text', text: JSON.stringify(output) }],
                finishReason: { unified: 'stop', raw: 'stop' },
                usage: { inputTokens: { total: 500, noCache: 500, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 40, text: 40, reasoning: 0 } },
                warnings: [],
                ...cost,
            };
        },
    });
    const settings: ModelSettings = { apiKey: 'offline', models: { evaluation, language } };
    return { settings, calls };
}

function answer(id: string, question: EvaluationQuestion, belief: Belief, view: View): Answer {
    if (question.type === 'boolean') {
        const value = ({ done: belief.done, done_change: belief.done, complete: belief.done, error: belief.error, anomaly: belief.anomaly, holds: belief.holds } as Record<string, number | undefined>)[id];
        return { type: 'boolean', probability: value ?? 0.03 };
    }
    if (question.type === 'score') { return { type: 'score', score: 0 }; }
    const options = Object.keys(question.criteria);
    let chosen: string | undefined;
    if (id === 'tool') { chosen = belief.tool && options.includes(belief.tool) ? belief.tool : 'none'; }
    if (id === 'target') { chosen = options.find(option => belief.target?.(view.elements.find(element => element.i === Number(option))!)); }
    if (id === 'destination') { chosen = options.find(option => belief.destination?.(view.elements.find(element => element.i === Number(option))!)); }
    if (id === 'option') { chosen = options.find(option => question.criteria[option] === belief.option); }
    if (id === 'file_group') { chosen = belief.fileGroup ?? 'all'; }
    if (id === 'scroll_direction') { chosen = belief.scrollDirection ?? 'down'; }
    if (id === 'scroll_text') { chosen = options.find(option => question.criteria[option] === belief.scrollText); }
    if (id === 'value') { chosen = belief.value; }
    if (id === 'support') { chosen = belief.support ?? 'not_shown'; }
    return distribution(options, chosen && options.includes(chosen) ? chosen : undefined);
}

/** A confident choice, or a flat distribution when the script has no opinion. */
function distribution(options: string[], chosen: string | undefined): Answer {
    if (options.length === 1) { return { type: 'choice', choice: options[0]!, probabilities: { [options[0]!]: 1 } }; }
    const top = chosen ?? options[0]!;
    const p = chosen ? 0.92 : 1 / options.length;
    const rest = (1 - p) / (options.length - 1);
    return { type: 'choice', choice: top, probabilities: Object.fromEntries(options.map(option => [option, option === top ? p : rest])) };
}

function toView(state: Record<string, unknown>): View {
    const task = (state.task ?? {}) as Record<string, unknown>;
    const page = (state.page ?? {}) as Record<string, unknown>;
    return {
        ...(typeof task.step === 'string' ? { step: task.step } : {}),
        ...(typeof task.next_step === 'string' ? { next: task.next_step } : {}),
        ...(typeof state.claim === 'string' ? { claim: state.claim } : {}),
        values: (task.values ?? {}) as Record<string, string>,
        history: (task.history ?? []) as Array<Record<string, string>>,
        url: String(page.url ?? ''),
        text: String(page.text ?? ''),
        notices: (page.notices ?? []) as string[],
        shownBefore: (task.shown_before_step ?? []) as string[],
        entered: (task.values_entered ?? {}) as Record<string, string>,
        ...(typeof page.dialog === 'string' ? { dialog: page.dialog } : {}),
        elements: (page.elements ?? []) as ViewElement[],
    };
}

/** The helper prompt is a JSON document embedded in the SDK's message array. */
function extractJson(serializedPrompt: string): string {
    const messages = JSON.parse(serializedPrompt) as Array<{ role: string; content: Array<{ type: string; text?: string }> | string }>;
    const user = messages.find(message => message.role === 'user')!;
    return typeof user.content === 'string' ? user.content : user.content.map(part => part.text ?? '').join('');
}

export function is(role: string, name: string | RegExp) {
    return (element: ViewElement | undefined) =>
        Boolean(element && element.role === role && (typeof name === 'string' ? element.name === name : name.test(element.name ?? '')));
}
export const near = (role: string, text: string) => (element: ViewElement | undefined) => Boolean(element && element.role === role && element.near?.includes(text));
export const within = (role: string, name: string, context: string) => (element: ViewElement | undefined) => Boolean(is(role, name)(element) && element!.in?.includes(context));
export const find = (view: View, predicate: (element: ViewElement) => boolean) => view.elements.find(predicate);
