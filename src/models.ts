import type { Experimental_EvaluationModel, Experimental_EvaluationQuestion, LanguageModel } from 'ai';
import type { z } from 'zod';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createGateway, experimental_evaluate as evaluate, generateText, NoObjectGeneratedError, NoOutputGeneratedError, Output } from 'ai';
import { JevwrightError } from './errors.ts';

export type Question = Experimental_EvaluationQuestion;
type LanguageModelV4 = Extract<LanguageModel, { specificationVersion: 'v4' }>;

/** Model gateways reachable through an AI SDK provider. */
export type ModelProvider = 'openrouter' | 'vercel';

const DEFAULT_MODELS: Record<ModelProvider, { jev: string; llm: string }> = {
    openrouter: { jev: '~typesafe/jev-latest', llm: 'deepseek/deepseek-v4.1-flash' },
    vercel: { jev: 'typesafe-ai/jev', llm: 'deepseek/deepseek-v4.1-flash' },
};

/**
 * The gateway to use from environment keys: `OPENROUTER_API_KEY` first, then `VERCEL_AI_GATEWAY_API_KEY`
 * (or the AI SDK's `AI_GATEWAY_API_KEY`); only that provider's key when `provider` is given. Undefined when
 * no key is set.
 */
export function gatewayFromEnv(env: Record<string, string | undefined> = process.env, provider?: ModelProvider): { provider: ModelProvider; apiKey: string } | undefined {
    const openrouter = env.OPENROUTER_API_KEY?.trim();
    if (openrouter && provider !== 'vercel') { return { provider: 'openrouter', apiKey: openrouter }; }
    const vercel = (env.VERCEL_AI_GATEWAY_API_KEY || env.AI_GATEWAY_API_KEY)?.trim();
    return vercel && provider !== 'openrouter' ? { provider: 'vercel', apiKey: vercel } : undefined;
}

/** How a run reaches its models. */
export interface ModelSettings {
    /** Gateway key; required unless `models` is given. */
    apiKey?: string;
    /** Defaults to OpenRouter. */
    provider?: ModelProvider;
    /** Jev model id on the gateway; defaults to TypeSafe's current Jev. */
    jevModel?: string;
    /** Helper model for steps Jev cannot resolve alone; defaults to DeepSeek V4.1 Flash. */
    llmModel?: string;
    /** Ceiling on model calls per test attempt, failed calls included. Default 80. */
    maxCallsPerTest?: number;
    /** Per-request timeout. Default 45 s. */
    timeoutMs?: number;
    /**
     * AI SDK models to use instead of a gateway, e.g. the SDK's mock models in your own tests; `provider`,
     * `apiKey` and the model ids are then ignored.
     * @experimental Built on the AI SDK's experimental evaluation API; its shape may change in a minor release.
     */
    models?: { evaluation: Exclude<Experimental_EvaluationModel, string>; language: LanguageModelV4 };
}

export interface ModelCall {
    kind: 'jev' | 'llm';
    purpose: string;
    durationMs: number;
    inputTokens: number;
    outputTokens: number;
    /** USD, when the gateway reports it. */
    cost?: number;
    error?: string;
}

export interface ModelUsage {
    jevCalls: number;
    llmCalls: number;
    inputTokens: number;
    outputTokens: number;
    jevMs: number;
    llmMs: number;
    failures: number;
    /** USD reported by the gateway; 0 when it reports none. */
    cost: number;
}

export class ModelError extends Error {
    constructor(message: string, readonly kind: 'budget' | 'service' | 'output' | 'cancelled') {
        super(message);
    }
}

/**
 * Accumulated model cost for one run, shared by every concurrently running test attempt (each has its
 * own `Models` instance, but they all charge the same budget). `reserve()` checks it ahead of the
 * per-attempt 80-call cap, so it fails a call the same way that cap does.
 */
export interface RunBudget {
    readonly capUsd: number;
    /** Adds a call's cost; 0 when the gateway reported none. */
    charge: (usd: number) => void;
    reached: () => boolean;
}

export function createRunBudget(capUsd: number): RunBudget {
    let spent = 0;
    return {
        capUsd,
        charge(usd) { spent += usd; },
        reached: () => spent >= capUsd,
    };
}

/** What a reached run budget fails or skips with; kept in one place so the CLI, engine and reports agree. */
export function runBudgetMessage(budget: RunBudget): string {
    return `Run budget of $${budget.capUsd} reached`;
}

export interface ChoiceAnswer { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence?: number }
export interface BooleanAnswer { type: 'boolean'; probability: number }
export type Answer = ChoiceAnswer | BooleanAnswer | { type: 'score'; score: number; probabilities?: Record<string, number> };

export function emptyUsage(): ModelUsage {
    return { jevCalls: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0, jevMs: 0, llmMs: 0, failures: 0, cost: 0 };
}

export function addUsage(total: ModelUsage, part: ModelUsage): void {
    for (const key of Object.keys(total) as Array<keyof ModelUsage>) { total[key] += part[key]; }
}

/** One instance per test attempt, so usage and budgets never leak between tests. */
/** Provider and model ids the settings resolve to; recorded in run.json. */
export function modelIds(settings: Omit<ModelSettings, 'apiKey'>): { provider: ModelProvider | 'offline'; jev: string; llm: string } {
    const provider = settings.provider ?? 'openrouter';
    return { provider: settings.models ? 'offline' : provider, jev: settings.jevModel ?? DEFAULT_MODELS[provider].jev, llm: settings.llmModel ?? DEFAULT_MODELS[provider].llm };
}

export function createModels(settings: ModelSettings, runBudget?: RunBudget) {
    const ids = modelIds(settings);
    const jevModel = ids.jev;
    const llmModel = ids.llm;
    const models = settings.models ?? (settings.apiKey ? providerModels(settings.provider ?? 'openrouter', settings.apiKey, jevModel, llmModel) : undefined);
    if (!models) { throw new JevwrightError('Model settings need an apiKey, or AI SDK models in `models`'); }
    const evaluation = tolerateRoundedTies(models.evaluation);
    const language = models.language;
    const usage = emptyUsage();
    const calls: ModelCall[] = [];
    const maxCalls = settings.maxCallsPerTest ?? 80;

    const reserve = () => {
        if (runBudget?.reached()) { throw new ModelError(runBudgetMessage(runBudget), 'budget'); }
        if (usage.jevCalls + usage.llmCalls >= maxCalls) { throw new ModelError(`Model call budget of ${maxCalls} exhausted`, 'budget'); }
    };
    const requestSignal = (signal: AbortSignal) => AbortSignal.any([signal, AbortSignal.timeout(settings.timeoutMs ?? 45_000)]);
    const failure = (error: unknown, signal: AbortSignal): ModelError => {
        if (error instanceof ModelError) { return error; }
        if (signal.aborted) { return new ModelError('Cancelled', 'cancelled'); }
        const name = error instanceof Error ? error.name : '';
        // Unparsable structured output: keep the start of what the model wrote, for diagnosis.
        const output = NoObjectGeneratedError.isInstance(error) && error.text ? ` (output: ${error.text.slice(0, 160)})` : '';
        const message = `${error instanceof Error ? error.message.split('\n')[0]!.slice(0, 200) : String(error)}${output}`;
        return new ModelError(`${name}: ${message}`, /NoObjectGenerated|NoOutputGenerated|InvalidResponseData|TypeValidation|JSONParse/.test(name) ? 'output' : 'service');
    };

    return {
        usage,
        calls,
        metadata: ids,
        /** Jev: typed answers and probabilities over one state; many questions per request. */
        async judge(state: Record<string, unknown>, questions: Record<string, Question>, signal: AbortSignal, purpose: string): Promise<Record<string, Answer>> {
            reserve();
            usage.jevCalls++;
            const started = performance.now();
            const call: ModelCall = { kind: 'jev', purpose, durationMs: 0, inputTokens: 0, outputTokens: 0 };
            try {
                // The SDK retries 408/429/5xx with exponential backoff; it validates distributions and arg-max.
                const result = await evaluate({ model: evaluation, state: state as never, questions, maxRetries: 4, abortSignal: requestSignal(signal) });
                call.inputTokens = result.usage.inputTokens ?? 0;
                call.outputTokens = result.usage.outputTokens ?? 0;
                call.cost = costOf(result.providerMetadata);
                const confidence = confidences(result.providerMetadata);
                const answers: Record<string, Answer> = {};
                for (const [id, answer] of Object.entries(result.answers)) {
                    answers[id] = answer.type === 'choice'
                        ? { type: 'choice', choice: answer.choice, probabilities: answer.probabilities ?? { [answer.choice]: 1 }, confidence: confidence[id] }
                        : answer as Answer;
                }
                return answers;
            } catch (error) {
                const wrapped = failure(error, signal);
                call.error = wrapped.message;
                usage.failures++;
                throw wrapped;
            } finally {
                call.durationMs = Math.round(performance.now() - started);
                usage.jevMs += call.durationMs;
                usage.inputTokens += call.inputTokens;
                usage.outputTokens += call.outputTokens;
                usage.cost += call.cost ?? 0;
                runBudget?.charge(call.cost ?? 0);
                calls.push(call);
            }
        },
        /** Helper LLM: structured output only; used when Jev reports it cannot proceed. */
        async generate<T>(system: string, prompt: string, schema: z.ZodType<T>, signal: AbortSignal, purpose: string): Promise<T> {
            reserve();
            usage.llmCalls++;
            const started = performance.now();
            const call: ModelCall = { kind: 'llm', purpose, durationMs: 0, inputTokens: 0, outputTokens: 0 };
            try {
                const request = async () => {
                    const result = await generateText({ model: language, system, prompt, output: Output.object({ schema }), reasoning: 'none', maxOutputTokens: 1500, maxRetries: 3, abortSignal: requestSignal(signal) });
                    // Reading `output` throws when the model stopped without writing any text.
                    return { result, output: result.output };
                };
                // One more try when the output is empty or does not parse; a second failure is real.
                const { result, output } = await request().catch(async (error: unknown) => {
                    if (NoObjectGeneratedError.isInstance(error) || NoOutputGeneratedError.isInstance(error)) { return request(); }
                    throw error;
                });
                call.inputTokens = result.usage.inputTokens ?? 0;
                call.outputTokens = result.usage.outputTokens ?? 0;
                call.cost = costOf(result.providerMetadata);
                return output;
            } catch (error) {
                const wrapped = failure(error, signal);
                call.error = wrapped.message;
                usage.failures++;
                throw wrapped;
            } finally {
                call.durationMs = Math.round(performance.now() - started);
                usage.llmMs += call.durationMs;
                usage.inputTokens += call.inputTokens;
                usage.outputTokens += call.outputTokens;
                usage.cost += call.cost ?? 0;
                runBudget?.charge(call.cost ?? 0);
                calls.push(call);
            }
        },
    };
}
export type Models = ReturnType<typeof createModels>;

function providerModels(provider: ModelProvider, apiKey: string, jevModel: string, llmModel: string) {
    if (provider === 'vercel') {
        const gateway = createGateway({ apiKey });
        return { evaluation: gateway.evaluationModel(jevModel), language: gateway.languageModel(llmModel) };
    }
    const openrouter = createOpenRouter({ apiKey, compatibility: 'strict', appName: 'jevwright', appUrl: 'https://github.com/Ice-Hazymoon/jevwright' });
    return { evaluation: openrouter.evaluationModel(jevModel), language: openrouter.chat(llmModel) };
}

type EvaluationModel = Exclude<Experimental_EvaluationModel, string>;

/**
 * Providers round probabilities (OpenRouter: 2 decimals), but the SDK compares the chosen option with the
 * rounded maximum without that tolerance and rejects near-ties. Options within one rounding unit are tied;
 * report the highest-probability one so the answer stays consistent with its own distribution.
 */
function tolerateRoundedTies(model: EvaluationModel): EvaluationModel {
    return {
        specificationVersion: model.specificationVersion,
        provider: model.provider,
        modelId: model.modelId,
        supportedQuestionTypes: model.supportedQuestionTypes,
        async doEvaluate(options) {
            const result = await model.doEvaluate(options);
            const decimals = result.rounding?.probabilityDecimals;
            if (decimals === undefined) { return result; }
            const unit = 10 ** -decimals + 1e-9;
            const answers = Object.fromEntries(Object.entries(result.answers).map(([id, answer]) => {
                if (answer.type !== 'choice' || !answer.probabilities) { return [id, answer]; }
                const [top, highest] = Object.entries(answer.probabilities).reduce((best, entry) => entry[1] > best[1] ? entry : best);
                const selected = answer.probabilities[answer.choice] ?? 0;
                return [id, highest > selected && highest - selected <= unit ? { ...answer, choice: top } : answer];
            }));
            return { ...result, answers };
        },
    };
}

type ProviderMetadata = Record<string, Record<string, unknown>> | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Per-question choice confidence: TypeSafe via the Vercel Gateway reports a map, OpenRouter reports it per answer. */
function confidences(metadata: ProviderMetadata): Record<string, number> {
    const result: Record<string, number> = {};
    const typesafe = metadata?.typesafe?.confidence;
    if (isRecord(typesafe)) {
        for (const [id, value] of Object.entries(typesafe)) { if (typeof value === 'number') { result[id] = value; } }
    }
    const answers = metadata?.openrouter?.answers;
    if (isRecord(answers)) {
        for (const [id, value] of Object.entries(answers)) { if (isRecord(value) && typeof value.confidence === 'number') { result[id] = value.confidence; } }
    }
    return result;
}

function costOf(metadata: ProviderMetadata): number | undefined {
    const usage = metadata?.openrouter?.usage;
    return isRecord(usage) && typeof usage.cost === 'number' ? usage.cost : undefined;
}

export function probabilityOf(answer: Answer | undefined): number {
    return answer?.type === 'boolean' ? answer.probability : 0;
}

export function choiceOf(answer: Answer | undefined): ChoiceAnswer | undefined {
    return answer?.type === 'choice' ? answer : undefined;
}

/** Choices sorted by probability, highest first. */
export function ranked(answer: ChoiceAnswer | undefined): Array<[string, number]> {
    return answer ? Object.entries(answer.probabilities).toSorted((a, b) => b[1] - a[1]) : [];
}
