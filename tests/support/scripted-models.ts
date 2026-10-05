import type { ModelSettings } from '../../src/models.ts';
import type { Experimental_EvaluationModel } from 'ai';
import { Experimental_EvaluationMockModelV4, MockLanguageModelV4 } from 'ai/test';

type Evaluate = Exclude<Experimental_EvaluationModel, string>['doEvaluate'];
type Answer = Awaited<ReturnType<Evaluate>>['answers'][string];
type EvaluationQuestion = Parameters<Evaluate>[0]['questions'][string];

/** The page as the engine serializes it for Jev (see `pageState`). */
export interface View {
    step?: string;
    field?: string;
    control?: string;
    controlActivations: Array<Record<string, string>>;
    auditContext?: { prior_actions?: Array<Record<string, string>>; control_activations?: Array<Record<string, string>> };
    review?: boolean;
    instructions?: string;
    actionScope?: string;
    proposal?: Record<string, string>;
    change?: Record<string, unknown>;
    /** The following act step, when the engine shares it. */
    next?: string | null;
    claim?: string;
    priorActions: Array<{ step: string; history: Array<Record<string, string>> }>;
    pageValues: string[];
    values: Record<string, string>;
    history: Array<Record<string, string>>;
    url: string;
    text: string;
    notices: string[];
    /** Notices the engine reports as already on the page before this step began. */
    shownBefore: string[];
    /** Value keys the engine confirmed are exactly in a field, with that field. */
    entered: Record<string, string>;
    supplied: Record<string, string>;
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
    selection?: string;
    drop_target?: boolean;
    draggable?: boolean;
}

/** What a scripted Jev "believes" about the current state; unset answers default to unlikely. */
export interface Belief {
    done?: number;
    complete?: number;
    achieved?: number;
    remaining?: number;
    navigation?: number;
    needed?: number;
    pTarget?: number;
    /** Reproduce nonuniform target rankings independently of the proposed tool. */
    targetProbability?: (element: ViewElement) => number;
    pageValue?: string;
    inputSource?: 'step' | 'page' | 'clear';
    error?: number;
    tool?: string;
    target?: (element: ViewElement) => boolean;
    value?: string;
    destination?: (element: ViewElement) => boolean;
    option?: string;
    key?: string;
    times?: number;
    selectText?: string;
    scrollText?: string;
    fileGroup?: 'selected' | 'all';
    scrollDirection?: 'up' | 'down';
    anomaly?: number;
    holds?: number;
    support?: 'supports' | 'contradicts' | 'not_shown';
    region?: 'open' | 'closed' | 'unknown';
    pSupport?: number;
    /** Evidence selection can be confident while the truth judgment still needs adjudication. */
    proof?: boolean;
    /** Whether the step's actions operated on what the step names (post-failure audit); defaults to yes. */
    onTarget?: number;
}

export interface ScriptedCall { questions: string[]; view: View }

function onTarget(p: number, authorized = false): Answer { const key = authorized ? 'authorized' : 'named'; return { type: 'choice', choice: p >= 0.5 ? key : 'different', probabilities: { [key]: p, different: 1 - p } }; }

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
            view.review = Object.hasOwn(questions, 'complete');
            view.instructions = JSON.stringify(questions);
            calls.push({ questions: Object.keys(questions), view });
            const belief = policy(view.review ? { ...view, control: undefined, controlActivations: [] } : view);
            const controlBelief = view.control ? policy({ ...view, review: false, text: '', notices: [], elements: [], change: undefined }) : belief;
            const answers: Record<string, Answer> = {};
            // Post-failure audit: one question per earlier act step, each judged by the policy for that step.
            const audited = ((state as { steps?: Array<Record<string, unknown>> }).steps ?? []).map(entry => policy({ ...toView({ task: entry }), instructions: JSON.stringify(questions) }));
            for (const [id, question] of Object.entries(questions)) {
                const step = /^on_target_(\d+)$/.exec(id);
                answers[id] = step ? onTarget(audited[Number(step[1])]?.onTarget ?? 0.95, question.type === 'choice' && Object.hasOwn(question.criteria, 'authorized')) : answer(id, question, id === 'needed' ? controlBelief : belief, view);
            }
            return { answers, usage: { inputTokens: 1000, outputTokens: 10 }, warnings: [], ...cost };
        },
    });
    const language = new MockLanguageModelV4({
        doGenerate: async ({ prompt }) => {
            const text = JSON.stringify(prompt);
            const payload = JSON.parse(extractJson(text)) as Record<string, unknown>;
            const view = toView({ task: { step: payload.step, values: payload.values, history: payload.history, next_step: payload.next_step }, page: payload.page, claim: payload.claim, prior_actions: payload.prior_actions, control: payload.control, control_activations: payload.control_activations });
            const output = helper?.(view, String(payload.why_you_are_asked ?? '')) ?? (payload.control ? { reason: 'The fixture policy requested no pending activation of this control', activation: 'finished' } : { outcome: 'impossible', tool: null, element: null, value_key: null, text: null, reason: 'scripted helper has no answer' });
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
        const value = ({ done: belief.done, done_change: belief.done, complete: belief.complete ?? belief.done, remaining: belief.remaining ?? (belief.done === undefined ? 0 : 1 - belief.done), error: belief.error, anomaly: belief.anomaly, holds: belief.holds, scroll_search: belief.scrollText ? 0.99 : 0.01 } as Record<string, number | undefined>)[id];
        return { type: 'boolean', probability: value ?? 0.03 };
    }
    if (question.type === 'score') { return { type: 'score', score: 0 }; }
    const options = Object.keys(question.criteria);
    if (id === 'complete') {
        const p = belief.achieved ?? belief.complete ?? belief.done ?? 0.03;
        return { type: 'choice', choice: p >= 0.5 ? 'achieved' : 'pending', probabilities: { achieved: p, pending: 1 - p } };
    }
    if (id === 'needed') {
        const p = belief.needed ?? 0.02;
        return { type: 'choice', choice: p >= 0.5 ? 'activate' : 'finished', probabilities: { activate: p, finished: 1 - p } };
    }
    if (id === 'navigation') {
        const p = belief.navigation ?? 0;
        return { type: 'choice', choice: p >= 0.5 ? 'pending' : 'reached', probabilities: { pending: p, reached: 1 - p, not_required: 0 } };
    }
    if (id === 'remaining') {
        const p = belief.remaining ?? (belief.done === undefined ? 0 : 1 - belief.done);
        return { type: 'choice', choice: p >= 0.5 ? 'unfinished' : 'complete', probabilities: { unfinished: p, complete: 1 - p } };
    }
    let chosen: string | undefined;
    if (id === 'tool') { chosen = belief.tool && options.includes(belief.tool) ? belief.tool : 'none'; }
    if (id === 'target' && belief.targetProbability) {
        const probabilities = Object.fromEntries(options.map(option => [option, belief.targetProbability!(view.elements.find(element => element.i === Number(option))!)]));
        const choice = options.toSorted((a, b) => probabilities[b]! - probabilities[a]!)[0]!;
        return { type: 'choice', choice, probabilities };
    }
    if (id === 'target') { chosen = options.find(option => belief.target?.(view.elements.find(element => element.i === Number(option))!)); }
    if (id === 'destination') { chosen = options.find(option => belief.destination?.(view.elements.find(element => element.i === Number(option))!)); }
    if (id === 'option') { chosen = options.find(option => question.criteria[option] === belief.option); }
    if (id === 'file_group') { chosen = belief.fileGroup ?? 'all'; }
    if (id === 'scroll_direction') { chosen = belief.scrollDirection ?? 'down'; }
    if (id === 'scroll_start' || id === 'scroll_end') {
        const words = [...(view.step ?? '').matchAll(/\S+/g)]; const at = belief.scrollText ? view.step?.indexOf(belief.scrollText) ?? -1 : -1;
        const boundary = id === 'scroll_start' ? at : at + (belief.scrollText?.length ?? 0) - 1;
        chosen = at < 0 ? undefined : String(words.findIndex(word => word.index! <= boundary && word.index! + word[0].length > boundary));
    }
    if (id === 'scroll_text') { chosen = options.find(option => question.criteria[option] === belief.scrollText); }
    if (id === 'key') { chosen = options.find(option => question.criteria[option] === belief.key); }
    if (id === 'times') { chosen = String(belief.times ?? 1); }
    if (id === 'press_target') { chosen = belief.target ? 'element' : 'focus'; }
    if (id === 'selection_text') { chosen = options.find(option => question.criteria[option] === belief.selectText); }
    if (id === 'value') { chosen = belief.value; }
    if (id === 'input_source') { chosen = belief.inputSource ?? (belief.pageValue !== undefined ? 'page' : Object.keys(view.values).length ? 'step' : 'clear'); }
    if (id === 'page_value') { chosen = options.find(key => question.criteria[key] === belief.pageValue); }
    if (id === 'support') { chosen = belief.support ?? 'not_shown'; }
    if (id === 'evidence') {
        const quoted = (option: string) => {
            try {
                const entry = JSON.parse(String(question.criteria[option]));
                return (Array.isArray(entry) ? entry : [entry]).map((entry) => {
                    const element = typeof entry.element === 'number' ? view.elements.find(element => element.i === entry.element) : undefined;
                    return element ? { source: 'element', text: element.name, value: element.value } : entry;
                }) as Array<{ text?: string; value?: string; source?: string }>;
            } catch { return []; }
        };
        const fields = (option: string) => quoted(option).filter(entry => entry.source === 'element' && entry.value !== undefined && view.claim?.includes(entry.text ?? '') && view.claim?.includes(entry.value));
        const field = options.toSorted((a, b) => fields(b).length - fields(a).length).find(option => fields(option).length);
        chosen = (belief.proof ?? (belief.support === 'supports' && (belief.holds ?? 0) >= 0.7)) ? field ?? options.find(option => quoted(option).some(entry => entry.source === 'text')) ?? 'none' : 'none';
    }
    if (id === 'region') { chosen = belief.region ?? 'unknown'; }
    return distribution(options, chosen && options.includes(chosen) ? chosen : undefined, id === 'support' ? belief.pSupport : id === 'target' ? belief.pTarget : undefined);
}

/** A confident choice, or a flat distribution when the script has no opinion. */
function distribution(options: string[], chosen: string | undefined, probability = 0.92): Answer {
    if (options.length === 1) { return { type: 'choice', choice: options[0]!, probabilities: { [options[0]!]: 1 } }; }
    const top = chosen ?? options[0]!;
    const p = chosen ? probability : 1 / options.length;
    const rest = (1 - p) / (options.length - 1);
    return { type: 'choice', choice: top, probabilities: Object.fromEntries(options.map(option => [option, option === top ? p : rest])) };
}

function toView(state: Record<string, unknown>): View {
    const task = (state.task ?? {}) as Record<string, unknown>;
    const page = (state.page ?? {}) as Record<string, unknown>;
    return {
        ...(typeof task.step === 'string' ? { step: task.step } : {}),
        ...(typeof task.action_scope === 'string' ? { actionScope: task.action_scope } : {}),
        ...(task.proposal ? { proposal: task.proposal as Record<string, string> } : {}),
        ...(typeof state.field === 'string' ? { field: state.field } : {}),
        ...(typeof state.control === 'string' ? { control: state.control } : {}),
        ...(task.next_step === null || typeof task.next_step === 'string' ? { next: task.next_step } : {}),
        ...(typeof state.claim === 'string' ? { claim: state.claim } : {}),
        priorActions: (state.prior_actions ?? []) as View['priorActions'],
        pageValues: (task.page_values ?? []) as string[],
        ...(task.context ? { auditContext: task.context as View['auditContext'] } : {}),
        controlActivations: (state.control_activations ?? []) as Array<Record<string, string>>,
        values: (task.values ?? {}) as Record<string, string>,
        history: (task.history ?? []) as Array<Record<string, string>>,
        url: String(page.url ?? ''),
        text: String(page.text ?? ''),
        notices: (page.notices ?? []) as string[],
        shownBefore: (task.shown_before_step ?? []) as string[],
        entered: (task.values_entered ?? {}) as Record<string, string>,
        supplied: (task.values_supplied ?? {}) as Record<string, string>,
        change: task.last_change as Record<string, unknown> | undefined,
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
