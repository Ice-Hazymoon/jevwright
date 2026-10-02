# Changelog

## 0.6.0

- Generate redacted JUnit reports, stable SHA-1 shards and last-failed selection from completed runs.
- Regenerate JUnit with the report command and keep single-test reproduction independent of shard/history filters.


## 0.5.0

- Skip the second check judgment when the observed page has not changed; uncertain first judgments still use the helper.
- Six paired real-model runs preserved 66/66 expected outcomes and reduced Jev calls by four per pair (95% interval [-4,-4]).


## 0.4.0

- Add root-scoped uploads, mobile/touch device contexts and separate device recordings.
- Add declared downloads with completion and size checks, secret withholding after verification, and popup close recovery.


## 0.3.0

- Add opaque secrets, restricted field input, model and artifact redaction, and fail-closed trace cleanup.
- Preserve internal result grammar and protect long, whitespace-normalized and nested JSON appearances.


## 0.2.0

- Record visible action end states and check them during replay, preserving deterministic failure attribution and healing stale paths in auto mode.
- Retry replay-backed product failures once with fresh AI grounding when the budget allows; retain flaky status and report changed paths.
- Return exit code 4 only for standalone replay failures caused solely by missing recordings. AI mode can replace malformed recordings.

## 0.1.1

- Add paired maintainer calibration against a Git revision, with separate warmup recordings, correctness regression gates, bootstrap intervals and interrupted-run cleanup.

## 0.1.0

First release.

- Tests are ordered plain-language steps: `act`, `check`, `verify`, `reload`, `back`, `goto` and `run`, plus `data`, `fixture`, `invariants` and `knownIssue`.
- TypeSafe's Jev grounds each `act` on the live page; a helper LLM steps in when Jev is stuck. Verdicts come from declared write requests, `verify`, invariants and the page monitor.
- Recordings store each step's path as semantic targets and replay it with no model call. Targets are found again by role, name and surrounding text, ignoring what changes between runs: URLs, generated ids, dates and times. Stale steps heal in `auto` mode. `replay` mode is deterministic and needs no key; a step without a recording fails there, so CI cannot pass a test that never ran.
- Every failure gets a cause (`product`, `agent`, `environment`, `model`, `timeout`) with the evidence. An audit keeps a step that acted on the wrong control from being blamed on the app.
- The monitor watches the app's origins (`baseURL` and `allowedOrigins`). It reports uncaught errors, 5xx and unexpected 4xx responses, failed requests, console errors, hydration mismatches and broken rendered text. High-severity issues fail the test unless `failOnIssues` is `false`.
- Before a run starts, the tests, the config and the app's reachability are checked, and problems are reported with what to fix.
- `jevwright` CLI: `run`, `list`, `init`, `report` and `serve`. Exit codes: 0 no failure, 1 a test failed, 2 a usage, config or setup error, 3 an internal error, 130 interrupted.
  - `run` supports `--new` (record, then replay), `--dry-run`, filters, `--env-file` and `--base-url`.
- `jevwright.config.ts` loads without a build step: through jiti under Node, through Bun's own loader (with tsconfig `paths`) under Bun. It has `setup` and `teardown` for a disposable app per run. `env` reaches fixtures and steps and is typed through `Register`.
- Reports: `report.html`, `report.md` with a reproduce command per failure, `summary.json`, `run.json`, screenshots and Playwright traces.
- Model gateways: OpenRouter and Vercel AI Gateway. Cost is capped per run (`maxCostUsd`) and model calls per test attempt.
