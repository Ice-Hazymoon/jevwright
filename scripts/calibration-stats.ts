/** Paired correctness takes precedence over speed and cost. Unsupported cases never enter pairs. */
export const metricNames = ['jev', 'llm', 'cost', 'duration', 'healed', 'rerouted'] as const;
export type Metrics = Record<typeof metricNames[number], number>;
export interface Sample { matched: Record<string, boolean>; metrics: Metrics }
export interface Pair { baseline: Sample; candidate: Sample }
export interface Interval { mean: number; low: number; high: number; relativeLow: number; relativeHigh: number }

export function applicableTests<T extends { id: string; requiredApis?: readonly string[] }>(tests: readonly T[], api: object) {
    const supported: T[] = [];
    const unsupported: Array<{ id: string; missing: string[] }> = [];
    for (const test of tests) {
        const missing = (test.requiredApis ?? []).filter(name => !(name in api));
        if (missing.length) { unsupported.push({ id: test.id, missing }); }
        else { supported.push(test); }
    }
    return { supported, unsupported };
}

export function comparePairs(pairs: readonly Pair[]) {
    if (!pairs.length) { throw new Error('No completed calibration pairs'); }
    const ids = Object.keys(pairs[0]!.baseline.matched);
    if (pairs.some(pair => [pair.baseline, pair.candidate].some(sample => Object.keys(sample.matched).length !== ids.length || ids.some(id => !(id in sample.matched))))) {
        throw new Error('Paired calibration samples must contain the same tests');
    }
    const flips = ids.map(id => ({
        id,
        b: pairs.filter(pair => pair.baseline.matched[id] && !pair.candidate.matched[id]).length,
        c: pairs.filter(pair => !pair.baseline.matched[id] && pair.candidate.matched[id]).length,
    }));
    const regression = flips.some(flip => flip.b - flip.c >= 2) || flips.reduce((sum, flip) => sum + flip.b - flip.c, 0) >= 3;
    // Fixed seed makes a report reproducible; pair execution order uses independent cryptographic randomness.
    let seed = 0x5eed;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    const intervals = Object.fromEntries(metricNames.map(name => {
        const differences = pairs.map(pair => pair.candidate.metrics[name] - pair.baseline.metrics[name]);
        const baseline = pairs.reduce((sum, pair) => sum + pair.baseline.metrics[name], 0) / pairs.length;
        const samples = Array.from({ length: 10_000 }, () => differences.reduce(sum => sum + differences[Math.floor(random() * differences.length)]!, 0) / differences.length).sort((a, b) => a - b);
        const low = samples[249]!;
        const high = samples[9749]!;
        const relative = (value: number) => baseline === 0 ? value === 0 ? 0 : Math.sign(value) * Infinity : value / baseline;
        return [name, { mean: differences.reduce((a, b) => a + b, 0) / differences.length, low, high, relativeLow: relative(low), relativeHigh: relative(high) }];
    })) as Record<typeof metricNames[number], Interval>;
    const withinNoise = Object.values(intervals).every(interval => interval.relativeLow >= -0.05 && interval.relativeHigh <= 0.05);
    const excludesZero = Object.values(intervals).every(interval => interval.low > 0 || interval.high < 0);
    return { flips, regression, intervals, resolved: pairs.length >= 6 && !regression && (withinNoise || excludesZero) };
}
