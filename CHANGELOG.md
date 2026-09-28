# Changelog

## 0.1.0

First release.

- Tests are ordered plain-language steps: `act`, `check`, `verify`, `reload`, `back`, `goto` and `run`, plus `data`, `fixture`, `invariants` and `knownIssue`.
- TypeSafe's Jev grounds each `act` on the live page; a helper LLM steps in when Jev is stuck. Verdicts come from declared write requests, `verify`, invariants and the page monitor.
- Recordings store each step's path as semantic targets and replay it with no model call. Stale steps heal in `auto` mode. `replay` mode is deterministic and needs no key; a step without a recording fails there, so CI cannot pass a test that never ran.
- Every failure gets a cause (`product`, `agent`, `environment`, `model`, `timeout`) with the evidence. An audit keeps a step that acted on the wrong control from being blamed on the app.
- The monitor watches the app's origins (`baseURL` and `allowedOrigins`). It reports uncaught errors, 5xx and unexpected 4xx responses, failed requests, console errors, hydration mismatches and broken rendered text. High-severity issues fail the test unless `failOnIssues` is `false`.
- Before a run starts, the tests, the config and the app's reachability are checked, and problems are reported with what to fix.
- `jevwright` CLI: `run`, `list`, `init`, `report` and `serve`. Exit codes: 0 no failure, 1 a test failed, 2 a usage, config or setup error, 3 an internal error, 130 interrupted.
  - `run` supports `--new` (record, then replay), `--dry-run`, filters, `--env-file` and `--base-url`.
- `jevwright.config.ts` has `setup` and `teardown` for a disposable app per run. `env` reaches fixtures and steps and is typed through `Register`.
- Reports: `report.html`, `report.md` with a reproduce command per failure, `summary.json`, `run.json`, screenshots and Playwright traces.
- Model gateways: OpenRouter and Vercel AI Gateway. Cost is capped per run (`maxCostUsd`) and model calls per test attempt.
