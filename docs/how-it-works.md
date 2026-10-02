# How it works

jevwright runs the steps you wrote in order. For each step it chooses between three paths:
- **Replay**: follow the recorded path, with no model.
- **Ground**: ask Jev what to do on the current page.
- **Code**: run your `verify`, `run` and navigation steps as written.

A test passes only when every step passes, every invariant holds, and the monitor saw nothing blocking.

Before any test starts, jevwright checks the tests (ids, required fields, every `{key}` a step uses), makes sure something accepts connections at `baseURL`, and launches Chromium. A problem with any of these stops the run with exit code 2 and a message saying what to fix.

## Components

| Part | Role |
| --- | --- |
| Observation | Turns Playwright's accessibility snapshot into a compact list of the page's controls |
| Decision loop | Grounds one `act` step with Jev, escalating to a helper LLM when stuck |
| Settle | Waits until the page is quiet before each decision and check |
| Monitor | Records requests, and reports crashes, server errors and broken text |
| Judge | Decides `check` steps |
| Recording | Stores each step's path as semantic targets and replays it |
| Attribution | Gives every failure a cause |

## Observation

Each decision starts from Playwright's `ariaSnapshotJSON` in AI mode, with element boxes. The engine reduces it to at most 220 controls, preferring main content over page chrome and onscreen over offscreen. For each control it keeps:
- role, accessible name and value;
- states such as checked, expanded or disabled;
- nearby text;
- the row or list item the control sits in.

It also keeps the page's notices (toasts, alerts) and a trimmed text of the page.

Some cases need special handling:
- **Modal dialogs**: when one is open, only the dialog is observed.
- **Passwords**: values of password-like fields are masked.
- **Hover-revealed controls** (a row's edit button that appears on hover) are marked, so the engine hovers their container first.
- **Hidden content**: text hidden behind an `aria-label` is kept as the control's content.
- **Inert controls**: controls inside an `inert` subtree, such as a collapsed accordion panel or the page behind a modal, are not offered. Playwright's snapshot does not treat `inert` as hidden. An inert element with exactly the same box as a live control, such as a card whose whole face is an inert preview, is kept, because the two cannot be told apart.

## The decision loop

A step runs for at most 8 actions. Each round sends one Jev request with several independent questions:
- Is the step done?
- Does the page show an error?
- Which tool should come next?
- Which control is the target?
- Which data value should be entered?

Jev answers with probabilities, and code applies thresholds:
- A "done" that conflicts with a proposed action is confirmed once more before the step ends.
- A declared write request ends the step after a submitting action (click, Enter, select) once the request succeeds.
- If Jev thinks the step is done but the declared request never started, it is told once that nothing was saved.
- A value the step names, which was not on the page when the step began, must be typed or selected, or must appear on the page. Until then, neither a successful request nor Jev's "done" completes the step. This stops a different control that saves through the same request from finishing the step early.
- Notices already on the screen when the step began are marked as such, so a stale error does not fail the next step.

The helper LLM (DeepSeek V4.1 Flash by default) is consulted when Jev is stuck:
- when it is unsure of the target;
- when it proposes nothing;
- when it repeats itself;
- when an action it just chose failed.

The helper is called at most twice per step. It may:
- act on a numbered control;
- type a data value;
- enter several of the step's values joined by line breaks, as multi-paragraph text.

It may not type text that neither the step nor its data contains. A "done" from the helper counts only when Jev does not clearly disagree.

## Settle

Before each decision, the engine waits until the page is quiet: no data or navigation request is in flight, and there has been no DOM mutation for 350 ms.
- The app's own scripts and stylesheets count as requests, because a lazily loaded component renders nothing until its module arrives.
- Inline-style changes, SVG attribute churn and `<head>` changes do not count as mutations, so animations do not keep a page busy forever.

The wait is bounded. When it hits the bound, the report says what kept the page busy.

## Monitor

The monitor watches every browser context. It covers the app's origins: `baseURL`'s origin and `allowedOrigins`.

It records each write request (a non-GET fetch or XHR) and the step that started it. It also reports:
- uncaught page errors;
- 5xx responses;
- 4xx responses to fetch, XHR and page loads that no step expected, except 401, which apps use to probe sessions;
- failed requests;
- console errors;
- hydration mismatches;
- rendered text such as `undefined`, `NaN`, `[object Object]`, `Invalid Date`, unfilled placeholders or untranslated keys.

High-severity issues fail the test at the step where they appear, unless `failOnIssues` is `false`. These are uncaught errors, 5xx responses, a server error screen, and the app not answering or not loading its own code. Other issues are only reported.

Two of them count as environment problems, not product ones:
- **A failure to load the app's own code**, such as a dynamic import that fails after a rebuild.
- **A request the app did not answer at all** (`app-unreachable`), because it crashed or restarted during the run.

## Checks

A `check` asks Jev two independent questions over the page: does the claim hold, and does the page support it, contradict it, or not show the information at all?
- Clear answers decide the check.
- An unclear one gets a second look after the page settles again.
- If it is still unclear, the helper LLM reads the same evidence and decides.

With a `reference`, the judge compares the page with your trusted data.

## Recordings and healing

Successful act steps record semantic targets and an optional end state: a normalized changed path,
up to four appeared anchors and up to two disappeared controls. Toasts, numeric names and unstable
names are excluded; typing-only steps record no anchors. A `likely-done` step records no end state.

Replay first checks a declared expectation. Otherwise, recorded end states must match the path,
at least half of the appeared anchors, and every disappeared control. The engine polls for up to
five seconds. An empty end state provides no additional evidence and is labeled in the report.

- In auto mode a missing target or mismatched end state triggers AI healing from the current page.
  Healing must perform a new successful action before it may replace a mismatched end state.
- In replay mode a missing target fails as `agent`; a failed declared expectation fails as `product`.
  A mismatched end state is annotated and execution continues, leaving the verdict to later checks.
  Even a passing test retains that annotation so its recording can be reviewed.
- End state mismatch alone does not establish a product defect. Failed healing can be attributed
  to `product` only when every recorded target matched a unique full identity and the action review
  supports the intended control with probability at least 0.75 (or an expectation failed).
- Legacy recordings without end states still replay. Auto may backfill an end state only if a later
  verify or write/URL expectation passes and the whole attempt passes. Invariants alone do not qualify.
- Recording writes require a changed action recipe or a newly added end state. Unchanged replay and
  unchanged AI paths do not rewrite the file.

After a product failure involving replay, auto may use one fresh AI retry. It needs at least 20% of
the run budget left; otherwise the report records why it stayed with replay. A fresh pass remains
`flaky`, and a different route is only an annotation, not proof that the recording was stale. If the
fresh retry fails because the agent could not drive the page, the prior replay cause is retained.

## Failure attribution

Every failed attempt gets one cause:

| Cause | Typical source |
| --- | --- |
| `product` | A `verify`, `check` or invariant fails; a declared request returns an unexpected status; the page shows an error screen or throws |
| `agent` | No control matches the step; repeated actions without progress; a stale or missing recording in replay mode; an action on the wrong control |
| `environment` | The fixture fails, the start page does not load, test code throws, a recording file is corrupt, or the app stops answering or fails to load its own code |
| `model` | Gateway errors, or the call or cost budget ran out, including tests the run budget kept from starting |
| `timeout` | The test exceeded `timeoutMs` (default 240 s) |

Before a product-looking failure is reported, the engine checks the earlier AI-driven `act` steps. One Jev request asks, for each step, whether its actions operated on the control the step names or on a different one. If any step is unlikely to have acted on its target (probability below 0.25), the failure becomes `agent`, and the summary names the control the step actually touched.

This question was calibrated on real run histories, 97 correct steps and 15 steps that acted on a wrong field:
- Asked as a two-way choice, it catches 14 of the 15 and misjudges 1 of the 97.
- A plain yes/no question at the same threshold caught only 9.

A failed test is retried (`retries`, default 1):
- A failure on every attempt is reported with how often it reproduced.
- A pass on a later attempt is reported as `flaky`.
- A test marked `knownIssue` that fails on the product is reported as `known` and is not retried.
- Cancelled runs, reached cost budgets and missing recordings are never retried.
- A test cancelled by Ctrl-C is reported as `skipped`.

## Budgets

- Each test attempt may make at most 80 model calls.
- The run shares one cost ceiling (`maxCostUsd`) across all tests running in parallel. Once it is reached:
  - tests that have not started fail without running, with cause `model`;
  - a test in progress fails at its next model call, with cause `model`.

## Safety

- **Origin allowlist.** Every browser connection goes through a loopback proxy that only reaches `baseURL`'s origin and `allowedOrigins`, including redirects and WebSockets. Blocked destinations are listed in `run.json`. This is a guard rail for an autonomous agent, not a sandbox.
- **Locked-down contexts.** Each test gets a fresh browser context:
  - service workers are blocked;
  - undeclared downloads are cancelled; declared downloads are saved for code verification with a 20 MiB limit;
  - native dialogs follow the test's `dialogs` setting.
- **Report server.** `jevwright serve` binds to 127.0.0.1. It serves one run directory read-only, behind a random token that it trades for an HttpOnly cookie.
- **Where your data goes.** Model requests carry the observed page: control names, values (passwords masked) and trimmed page text. They go only to the gateway you configure. Run tests against test data.


### Secret values

Use `secret(value)` in `TestSpec.secrets`, separate from ordinary string `data`. Handles stringify as
`{secret}`. Only trusted test code can call `reveal(handle)`; `RunContext.secrets` exposes the handles.
An action references a secret by `{key}`. Models receive that placeholder and `<secret value>`, while
code fills the original value into an enabled editable field. Select actions and semantic `check`
assertions cannot consume secrets; verify exact values with `verify` and `reveal` instead.

Model payloads, progress logs and text artifacts redact the full secret, URI encoding (including browser
URL encoding), JSON escaping, HTML entities and base64. A secret-bearing descriptor is not recorded;
the report explains why that step needs AI again. Secret names are excluded from learned end anchors.
After secret input, step screenshots are withheld. Secret tests disable trace frames from the start;
trace text is rewritten and binary entries containing the secret are removed. Failed rewriting deletes
the original trace and sets `traceWithheld` without changing the test verdict.

This is an accidental-disclosure boundary, not encrypted storage. It does not recognize arbitrary
transformations such as truncation, case changes, hashes, or a secret split across nodes. Requests to
allowed app origins still carry the tested input, as intended. Keep real credentials out of ordinary data.

Secret-bearing attempts suppress screenshots from the start, including fixture-rendered echoes.
Engine result grammar is preserved only for engine-owned fields. User evidence, reference and metadata
objects are fully redacted, including their keys. CLI setup and translation callback errors are redacted
before being printed. These protections cover declared values and their documented encodings, not
arbitrary application hashes or application-truncated fragments of a secret.

A failed or uncertain `check` still waits for delayed rendering and observes again. It asks Jev again
only if the observation signature changed. An unchanged uncertain verdict goes to the helper;
an unchanged certain rejection stays failed. The second observation remains available as evidence.

Engine protocol types, question IDs and option IDs retain their identities. User data/file keys containing
a declared secret use deterministic aliases that are checked for secret content and collisions; Jev and
helper answers resolve back to the original key before browser execution. Dynamic descriptions and
reference evidence are redacted. Report display paths may be redacted, while writers use the separate
physical directory. A stable hashed selection key preserves `--last-failed` when a test ID is redacted.
