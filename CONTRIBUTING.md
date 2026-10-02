# Contributing

## Setup

```bash
npm install
npx playwright install chromium
```

## Checks

```bash
npm run typecheck
npm test          # offline: a local fixture app, real Chromium, and scripted models through the AI SDK's mock providers
npm run build
```

The tests call no model and need no key.
- `tests/fixtures/app.ts` is a small multi-page app. Each page has seeded defects behind `?bug=`.
- `tests/support/fixture-policy.ts` answers the engine's questions the way a competent model would. It also reproduces the missteps seen from real models.

When you fix an engine behavior:
1. Add an example that fails before the fix.
2. Add it to the closest existing test file, at the lowest layer that shows it. Pure observation and settling go in `tests/units.test.ts`; decisions and attribution go in `tests/engine.test.ts`.

## Calibration against real models

```bash
OPENROUTER_API_KEY=... npm run calibrate -- --mode ai
```

This runs the fixture app's healthy flows and seeded defects with real models:
- Every healthy flow must pass.
- Every defect must fail with cause `product`.

A full run costs a few cents. Run it after changing prompts, questions or thresholds, and note the result in the pull request.

## Dependencies

- `ai` is pinned to an exact version. jevwright uses the AI SDK's experimental evaluation API, which is exempt from semantic versioning; bump it deliberately and rerun the calibration.
- `playwright` is a peer dependency (1.63 or newer, for `ariaSnapshotJSON`), so a project keeps the Playwright it already has.

## Releasing

1. Update `CHANGELOG.md`, and bump `version` in both `package.json` and `src/version.ts`. A unit test keeps the two equal.
2. `npm run typecheck && npm test && npm run build && npm pack --dry-run`. The pack list may hold only `dist/`, `README.md`, `CHANGELOG.md`, `LICENSE` and `package.json`.
3. `npm publish`. `prepublishOnly` repeats the checks.

## Paired calibration

Before changing a prompt or decision threshold, compare the candidate workspace with a Git revision:

```bash
npm run calibrate -- --ab HEAD --pairs 6 --mode auto --retries 1
```

A/B defaults to `auto`, one retry and at most 20 pairs. Each side first records its own AI warmup;
those runs are excluded from statistics. Each pair uses the candidate fixture list in the same order,
with a random choice of which engine runs first. The fixture app is shared and tests run serially.
Declare `expected: 'passed' | 'product'` on every fixture and `requiredApis` on a calibration fixture that uses a new export; an older baseline excludes
that case from paired statistics while the candidate still runs it.

The Markdown report under `.jevwright/calibration/` shows per-test correctness flips and 95% paired
bootstrap intervals for calls, cost, duration, healed steps and rerouted tests. Raw pairs and run
reports sit beside it. Two net adverse flips for a test, or three across all tests, fail calibration.
No regression against a broken baseline does not establish correctness: inspect the absolute
matched outcomes as well. Six or more pairs are required; unresolved intervals remain labeled at
the pair limit. The temporary baseline worktree is removed on completion or the first interrupt.
