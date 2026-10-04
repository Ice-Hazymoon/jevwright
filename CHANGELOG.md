# Changelog

## Unreleased

- Bind newly recorded app routes to the current baseURL while enforcing literal third-party origins and retaining legacy path-only replay.
- Pass explicit absent next-step boundaries and current-page evidence to completion/control reviews; never infer a later confirmation step.
- Separate not-yet-executed audit proposals from delivered action history, retaining corrected-input and repeat-count context.
- Share action authorization across decisions, completion, control review and target audit; retain flow, prior activation and next-step context so required confirmations and view navigation execute before completion.
- Review confident unactivated completion candidates with the helper even when necessity is low; audit every helper-proposed activation.
- Accept valid control judgments with verbose explanations within the existing output-token budget instead of rejecting their activation solely on explanation length.
- Ask the control helper to explain pending work before selecting activate/finished, keeping delivered actions distinct from missing product content.
- Redirect repeated single-page scrolling and container-only scroll_to toward literal instruction-entity search after two moves.
- Require current-view evidence only for requested destination views; completed gestures, uploads and closed prerequisite menus do not create missing navigation.

- Mask password selections before DOM data returns, preserving protection in traceable reads.

- Resolve confident pending activations before completion, with configurable action confidence and the existing clause and target reviews.
- Audit the proposed activation independently from corrected input history; preserve its authorized arguments and completed upload-group evidence in fresh and replayed actions.
- Accept declared file keys as upload authorization without requiring a text value; retain grouped selections during execution and replay, and supply protected value identities to completion reviews.
- Add recorded keyboard chords, bounded repetition, exact editable text selection and focused selection feedback, with platform shortcut mapping.
- Detect delegated React/Vue events and registered listeners; expose drop containers and named-section context targets. Use segmented native/pointer dragging with effect feedback.
- Search windowed text with normalized entity boundaries, scoped lightweight probes and container-sized budgets. Keep loading waits outside the successful-movement budget for growing feeds.
- Prefer conflicting visible labels while retaining accessible names, rendered content and legacy recording identities. Validate helper tool/input consistency and avoid replaying a click delivered to a replaced control.
- Integrity: replay end mismatches now fail; all anchors, origin/query, before-step absence and changed field states are checked. Empty observable effects are marked explicitly.
- Passing checks record direct visible evidence for deterministic replay. Missing evidence becomes `unverified`; `--allow-unverified` only overrides the exit policy.
- Record repeated instructions separately, reject changed duplicate counts, and save verified prefixes of failed attempts as partial recordings.
- Attribute thrown verification assertions and same-step server rejection evidence correctly. Preserve omitted failures across partial reruns and report interruption separately.
- Keep DOM text and drop-target names intact until secret protection can run before truncation.
- Cache ancestor interaction hints within each observation and read painted-box styles only for eligible empty containers.
- Report actual replay mismatches to healing, and exclude cached route differences alone from missing-effect product attribution.

- Judge whether a check's expected region is open and visible independently from its content. Attribute missing content in an open region to the product, and unopened or unknown regions to the agent after review. Preserve prior successful action evidence to identify the asserted object.
- Exclude native folded detail contents even when the browser retains their earlier layout dimensions.
- Ground unresolved requested page input before spending helper calls, and retain bounded page-value vocabularies for later input. Let completed selections and view activations reach independent result checks despite a low product-outcome probability.

- Register DOM selectors before concurrent contexts are created. Keep literal typing as typing so the helper can ground the exact instruction text immediately. Authorize necessary final controls for requested committed results without extending selection-only steps.
- Separate actual page input from human provenance labels in model history, including replay healing; preserve report labels and recording formats.

- Preserve visible card content replaced by accessible labels, including inert previews, `display:contents` wrappers, assigned shadow slots and descendants that restore CSS visibility; retain main text, prices, totals and errors while excluding hidden and replaced fallback text.
- Keep clickable cards outside the plain-text supplement cap; count omitted controls and prioritize named targets. Cache DOM visibility/text and use lightweight busy polling on large pages.
- Restrict completion review to requested actions. Treat missing check evidence as uncertain, and attribute only explicit contradictions to the product. Numeric grouping commas do not split steps.
- Reduce decision payloads, merge completion/control reviews and wait before reviewing. Read page-value vocabularies only when requested; infer dragging only from explicit attributes or grab cursors, and hover targets from revealing styles.
- Expire newly mounted loading decorations after two seconds, restore targetless scrolling in unique app containers and reject stationary scrolls. Preserve short/partial tokens in page-value target descriptions and use English replay errors.

- Ground control-activation review in successful actions on the same connected DOM ref, so changing nearby counts do not trigger extra activations.

- Reject a drag to the same DOM element, so a no-op pointer gesture cannot be recorded as a successful drop.

- Preserve code-observed page transitions during action-stage completion review, including submissions that replace their form; retain supplied-value evidence separately from current field matches.

- Respect an explicit next-step boundary when the scoped action-stage choice favors completion, avoiding rejection of an already opened confirmation dialog at borderline confidence. Later assertions and invariants still decide outcomes.

- Breaking before 1.0: `secret(value)` now defaults to password purpose and can enter only `type=password` fields. Autocomplete hints alone do not qualify. Use `secret(value, { purpose: 'any' })` for API keys and other editable fields. Code guards both observed and actual targets, including replay; field-specific model value choices exclude incompatible secrets.

- Avoid treating ordinary processing text, decorative spinners and determinate progress as loading; report busy separately and keep bounded busy waits outside the action budget.
- Limit plain-text targets to pointer/hover/context signals or instruction-named text, excluding control descendants and large-table text.
- Select scroll search spans from the original instruction with model judgments; fail missing searches explicitly and share a bounded search budget within each step.
- Preserve connected target references; relocate only stale targets. Derive drag context from semantic container labels and headings.
- Split aria-controls ID lists and apply the same mutation noise rules and diagnostics inside shadow roots.
- Keep reading recordings from 0.1.x–0.6.0. New gesture, grouped-upload, search and page-value recordings require the Unreleased engine or 0.7.0+ once released; 0.6.0 can reject new tools or silently drop optional fields. Wait actions are no longer recorded.

- Observe script-created closed shadow roots, roleless text targets, contenteditable editors and scroll containers while retaining visible labels.
- Record and replay hover, right-click, long press, double-click, drag source/destination, browser back and scroll-to-text gestures.
- Search mounted content while scrolling; wait for deferred controls and options, and refresh semantic targets after DOM replacement.
- Select exact native and ARIA options; upload declared files together to multiple inputs in one action.
- Extend screenshot secret detection to shadow roots and contenteditable editors.
- Allow Jev and the helper to enter exact observed page values, excluding declared secrets; record their sources and read the current values on replay.
- Review all clauses and action stages before accepting step completion, including submission, confirmation and destination navigation; propose remaining actions and reject unrelated targets.
- Match mixed public and secret input values to the selected field before typing.
- Attribute action-triggered validation errors to the agent unless a declared request or monitor provides deterministic failure evidence.
- Require checks and adjudication to use direct evidence from the asserted content; indirect summaries cannot override missing content.

## 0.6.0

- Generate redacted JUnit reports, stable SHA-1 shards and last-failed selection from completed runs.
- Regenerate JUnit with the report command and keep single-test reproduction independent of shard/history filters.
- Drop a step healed after a mismatched end state from the recording instead of saving the misfired replay with the fix; the next auto run records it from its start.
- Redact browser URL spellings, overlapping secrets, `\uXXXX` and `&#x27;` escapes, embedded base64 and byte arrays; ignore folded forms shorter than six code points.
- Rewrite every trace and skip screenshots of pages that show a secret declared anywhere in the run.
- Treat a recorded step with no actions as recorded; scope exit code 4 to failed tests; report rerouted steps by their test step number.
- Wait for downloads in progress, keep the timeout reason, loop flushes, and withhold non-UTF-8 downloads while secrets are active.
- Keep the configured viewport for `--device desktop`; give upload target checks the action timeout and default to the only declared file.
- Ignore interrupted runs for `--last-failed`, print the JUnit path from `report`, and stop calibration once each metric settles; remove calibration worktrees reached through a symlinked temporary directory.

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
