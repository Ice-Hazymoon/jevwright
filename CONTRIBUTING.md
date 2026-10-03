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

Large-page hardening probes also run offline. Archive the baseline source into a temporary directory,
and link that directory's `node_modules` to this checkout's installed dependencies. Then run:

```bash
npx jiti scripts/hardening-performance.ts /path/to/baseline-source . 3
npx jiti scripts/hardening-calls.ts /path/to/baseline-source
npx jiti scripts/hardening-calls.ts .
```

The performance probe compares median observation and settle times on identical 2000×5 tables in fresh
contexts, enforcing a 1.5 ratio. The calls probe executes a supplied-value type/save step over 120 rows;
its caps use the measured main baseline of three calls and 18,969 serialized characters. It counts only
model state and questions, not protocol overhead or tokens. Re-measure that baseline if the probe changes.

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

`npx jiti scripts/attribution-calibration.ts` separately checks open/closed regions, transient loading,
segmented page input, broken sorting and a retained removed entry with real models. Its expected agent
failures cover unopened regions; it does not replace the main calibration or paired A/B.

## Dependencies

- `ai` is pinned to an exact version. jevwright uses the AI SDK's experimental evaluation API, which is exempt from semantic versioning; bump it deliberately and rerun the calibration.
- `playwright` is a peer dependency (1.63 or newer, for `ariaSnapshotJSON`), so a project keeps the Playwright it already has.

## Releasing

1. Update `CHANGELOG.md`, and bump `version` in both `package.json` and `src/version.ts`. A unit test keeps the two equal.
2. `npm run typecheck && npm test && npm run build && npm pack --dry-run`. The pack list may hold only `dist/`, `README.md`, `CHANGELOG.md`, `LICENSE` and `package.json`.
3. `npm publish`. `prepublishOnly` repeats the checks.

Bump only the root `version` fields of `package-lock.json`; never search and replace a version string across it.

## Artifacts and secrets

Runtime text artifacts go through `writeArtifact(path, contents, redact)`. The run redactor includes
all declared secrets. FW01 in the package checks rejects direct filesystem writes outside the artifact
writer, recording store, and CLI scaffolding function. Binary trace rewriting remains a separate,
fail-closed path. When adding a new artifact, verify both its model inputs and its saved bytes.

FW02 confines `forResults` to the suite, attempt and report writers. Model payloads use the generic
redactor, including arbitrary object keys; user evidence/reference/metadata never inherits result grammar
exemptions. Keep regression coverage for schema-shaped secrets and multiline text before splitting.

FW03 rejects generic redaction of the evaluation question map: question IDs, schema types and option
identities are protocol, while instructions, criteria descriptions and user reference data are payload.
Report writers retain the physical directory separately from display text. Failed-test selection uses a
stable SHA-256 selection key so redacted IDs cannot silently disappear from `--last-failed`.

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
