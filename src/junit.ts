import type { RunSummary, TestResult } from './suite.ts';
import { reproduceCommand } from './report.ts';

/** XML 1.0 characters; lone surrogates and forbidden controls become replacement characters. */
function xml(value: string): string {
    return value.replace(/[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, '\uFFFD')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll('\'', '&apos;');
}

const isError = (test: TestResult) => test.status === 'failed' && (test.cause === 'environment' || test.cause === 'model');

export function junitReport(summary: RunSummary): string {
    const modules = new Map<string, TestResult[]>();
    for (const result of summary.results) {
        const name = result.module || 'default';
        const group = modules.get(name) ?? [];
        group.push(result);
        modules.set(name, group);
    }
    const suites = [...modules].map(([name, tests]) => {
        const errors = tests.filter(isError).length + tests.filter(test => test.status === 'unverified' || test.status === 'interrupted').length;
        const failures = tests.filter(test => test.status === 'failed').length - tests.filter(isError).length;
        const skipped = tests.filter(test => test.status === 'known' || test.status === 'skipped').length;
        const cases = tests.map((test) => {
            let result = '';
            if (test.status === 'unverified' || test.status === 'interrupted') {
                result = `<error type="${test.status}" message="${xml(test.summary)}"/>`;
            } else if (test.status === 'failed') {
                const tag = isError(test) ? 'error' : 'failure';
                const reproduce = summary.manifest.command ? reproduceCommand(summary.manifest.command, test.id) : '';
                result = `<${tag} type="${xml(test.cause ?? 'unknown')}" message="${xml(test.summary)}">${xml(reproduce)}</${tag}>`;
            } else if (test.status === 'known' || test.status === 'skipped') {
                const reason = test.status === 'known' ? `known issue: ${test.knownIssue ?? test.summary}` : test.skipReason ?? test.summary;
                result = `<skipped message="${xml(reason)}"/>`;
            } else if (test.status === 'flaky') {
                const rerouted = 'rerouted' in test && test.rerouted ? `; rerouted ${JSON.stringify(test.rerouted)}` : '';
                result = `<system-out>${xml(`Flaky: failed ${test.reproduced ?? '?'} attempts; ${test.summary}${rerouted}`)}</system-out>`;
            }
            return `    <testcase name="${xml(test.id)}" classname="${xml(name)}" time="${(test.durationMs / 1000).toFixed(3)}">${result}</testcase>`;
        });
        return [`  <testsuite name="${xml(name)}" tests="${tests.length}" failures="${failures}" errors="${errors}" skipped="${skipped}" unverified="${tests.filter(test => test.status === 'unverified').length}" interrupted="${tests.filter(test => test.status === 'interrupted').length}" time="${(tests.reduce((sum, test) => sum + test.durationMs, 0) / 1000).toFixed(3)}">`, ...cases, '  </testsuite>'].join('\n');
    });
    return ['<?xml version="1.0" encoding="UTF-8"?>', `<testsuites tests="${summary.results.length}">`, ...suites, '</testsuites>', ''].join('\n');
}
