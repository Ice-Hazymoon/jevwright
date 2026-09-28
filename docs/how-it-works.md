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

After each successful step, the engine stores the path as semantic targets: role, name, nearby text, row, and which of several same-named controls it was. Values from `data` are stored as their keys.

When a run replays a step:
- The engine finds each target again on the current page.
- If a target is missing, the step is **healed**: grounded with AI from that point, and in auto mode the recording is updated.
- In replay mode, a missing target fails the step as `agent`. So does a step with no recording at all: a new test, or a step reworded since it was recorded. It is not retried.

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
  - downloads are cancelled;
  - native dialogs follow the test's `dialogs` setting.
- **Report server.** `jevwright serve` binds to 127.0.0.1. It serves one run directory read-only, behind a random token that it trades for an HttpOnly cookie.
- **Where your data goes.** Model requests carry the observed page: control names, values (passwords masked) and trimmed page text. They go only to the gateway you configure. Run tests against test data.
