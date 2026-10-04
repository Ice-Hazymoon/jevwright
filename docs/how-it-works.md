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
A DOM supplement supplies roleless text targets, contenteditable fields, scrolling containers,
and visible labels that differ from accessible names. When an accessible name omits the visible control label, that label becomes primary and `aria_name` retains the accessible name; `content` still retains rendered text. Focused inputs, textareas and contenteditable editors report `selection`, including an empty selection. It excludes hidden and clipped
screen-reader text. Visible `inert` previews and `display:contents` text remain readable, while inert controls cannot be acted on. Visible text with `aria-hidden` is retained; accessible names remain separate. Main content receives the bounded text budget before navigation.
Assigned shadow slots retain their rendered text and ancestry, including captured closed roots. Hidden assignments and replaced fallback text are excluded.
Descendants that restore `visibility:visible` remain readable inside a `visibility:hidden` wrapper. Ancestors that hide content through `opacity:0`, `display:none` or a collapsed clipping box still hide their subtrees.
Field labels come from associated labels or adjacent leaf label/span elements, rather than explanatory paragraphs.
Noninteractive text is offered only when it has pointer, revealing hover or context-menu signals, or its text is named in the current instruction. Decorative hover colors do not qualify. Descendants of actual interactive controls are excluded; a named section alone does not absorb its text targets. React props, Vue event invokers and init-script listener registration supply event hints. Hints do not establish actionability. At most 30 supplemental plain-text targets are offered, preferring instruction-named and onscreen text. Clickable cards remain outside this supplement limit; controls trimmed by the overall 220-element limit count as omitted.

Some cases need special handling:
- **Closed shadow roots**: a context init script wraps `attachShadow` and retains roots in a weak map. Their modes and the application's `shadowRoot` getters stay unchanged. A selector engine reaches observed nodes in those roots. Registration finishes before concurrent contexts capture their engines. Declarative closed roots are not captured. The wrapper and engine globals are visible to application code.
- **Modal dialogs**: when one is open, only the dialog is observed.
- **Passwords**: values of password-like fields are masked.
- **Hover-revealed controls** (a row's edit button that appears on hover) are marked, so the engine hovers their container first.
- **Visible content**: rendered text replaced by an `aria-label` is kept as the control's `content`, including visible inert previews.
- **Inert controls**: controls inside an `inert` subtree, such as a collapsed accordion panel or the page behind a modal, are not offered. Playwright's snapshot does not treat `inert` as hidden. An inert element with exactly the same box as a live control, such as a card whose whole face is an inert preview, is kept, because the two cannot be told apart.

## The decision loop

Model history separates actual page input from its `input_source` provenance. Reports retain the human `page: ...` label; it is not text entered into the field.

A step runs for at most 8 actions. Each round sends one Jev request with several independent questions:
- Is the step done?
- Does the page show an error?
- Which tool should come next?
- Which control is the target?
- Which data value should be entered?
- Does any requested user action remain?
- Has each requested destination view been activated?

Jev answers with probabilities, and code applies thresholds:
- A proposed activation with tool and target confidence at least `models.actionPriorityThreshold` (default 0.75) competes with completion, including when a following step exists. The current-clause control review must authorize the pending activation, and the existing target audit must support it at 0.75 before execution. Successful activations on the same ref prevent unrequested repeats; hover does not count as activation. The 0.75 default keeps uncertain proposals out of this conflict gate.
- An independent remaining-work question reviews every clause and required outcome. A proposed completion receives an action-stage review: a requested committed result authorizes its necessary final control even when the instruction does not name that button; selection or editing alone authorizes no commit, and requested destinations must be opened. The review can propose the next missing action when the original decision offers none or wait. A separate model judgment must support the proposed target before code applies the action. A weak stage review does not overturn an otherwise completed step; a strong pending judgment does. A separate navigation judgment requires an activation action or explicit current-view state; a global heading or destination badge alone is insufficient. Prerequisites performed by a tool, such as scrolling a control into view before clicking, count as performed. Once a requested view is open, later checks evaluate its content; empty or loading product content does not undo navigation. When completion conflicts with a proposed activation, the completion request includes a control judgment against successful history alone. A standalone judgment is used only when completion was not reviewed. A disputed required activation blocks completion unless its target audit clearly rejects the action as unrelated; only strong target support injects a review-proposed action. Neither review authorizes an unrequested submission, confirmation, purchase or deletion. An uncertain activation can receive a helper review within the two-call limit. Both reviewers receive successful actions tied to the same connected DOM ref, while preserving the original descriptions. Changing nearby counts or labels does not make those actions belong to a different control; repeated activation requests still require the requested count. A strong action-stage judgment can end the step even when empty product content lowers the original completion probability; later checks still decide whether the content is correct. Dragging requires distinct source and destination DOM elements; a self-drop fails before the gesture. Action-stage completion review receives the same code-computed page changes as the action decision. Successful keyed inputs are also listed separately from exact current field matches, without exposing secret text. This preserves evidence when submission replaces the form and removes its fields; later checks still determine whether the result is correct. The action-stage review treats an explicit next step as separate later work. With that boundary, the scoped achieved/pending choice uses its majority rather than the stricter final-transaction confidence threshold; navigation and missing-value guards still apply. A confident action already proposed by the action decision can run only when the current-clause review and target audit authorize it; the remaining-work judgment still checks every current clause.
- A declared write request ends a single submission after a submitting action (click, Enter, select) once the request succeeds. Compound instructions still check remaining work, so the first successful request cannot hide a later action.
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
- type a data value or an exact span from the current observation;
- enter several of the step's values joined by line breaks, as multi-paragraph text.

It may not invent text. Page values must appear verbatim in the current observation, with whitespace normalized and case preserved. Declared secrets and redacted markers never qualify as page values. Sources are split around redacted markers so marker fragments cannot become input. Only after Jev chooses page input does the engine send a bounded list of observed spans for grounding; ordinary supplied inputs omit this vocabulary. The helper can request another observed span, which code validates. A "done" from the helper counts only when Jev does not clearly disagree.

### Browser actions

The model can choose hover, right-click, an 800 ms long press, double-click, drag, keyboard `press`, `select_text` and browser back. `press` accepts a Playwright key chord and 1–20 repetitions, on the focused element or an explicit target. Control/Meta shortcut modifiers map to Meta on Mac and Control elsewhere; Alt and Shift retain their meaning. `select_text` selects one unique exact occurrence in an editable field or editor without inserting text. Missing or ambiguous selections fail. Printable keyboard text uses the same literal authorization as typing, including repetitions. Clipboard paste requires the type tool with an authorized value because clipboard contents are outside the observed page.
A drag names both a source and a destination. Event-bound containers, labeled/testid columns and painted empty boxes can be destinations. The engine hovers the source, scrolls the destination into view, requires both endpoints onscreen, and sends down, segmented moves and up. Native HTML drag-and-drop and pointer boards use the same gesture. A changed source position, container or page text supplies effect feedback; no observed effect fails the action. The test-level `double` option remains supported. Browser back is offered and executed only when
Chromium navigation history contains an earlier HTTP(S) app page; the initial blank page is excluded.

Select distinguishes native `<select>` controls from ARIA listboxes and comboboxes. Native controls
use `selectOption`; ARIA choices click rendered options. The option question selects exact page text
when a step has no data key. Empty or delayed option lists cause bounded waiting and fresh observation.
This option choice does not authorize typing new page text.

Upload can send a selected file or all files named in the step together. The file-group question
chooses the group; multiple-file groups require a `multiple` input or multiple file chooser.
A single-file input uses the selected key. Recordings store optional `fileKeys`, never local paths.

Scroll can target the page or a scrolling container. Targetless legacy scrolling uses the document or the unique visible scrolling container; no movement fails explicitly. `scroll_to` brings a named text or control into
view. For a scroll search, Jev selects an identifying entity from the instruction. Matching folds case, parentheses and punctuation and retains word boundaries, so Record 12 does not match Record 120. Parenthesized identities and noun/number pairs can match independently of the full phrase. The search advances by 75% of a viewport and probes only mounted visible text between moves; a match triggers full observation. Page and time caps adapt to scroll height, with at most 500 moves, five unchanged positions and a shared 120-second step budget. A missing goal fails with “not found after N viewports”. This lets virtualized rows render and lets growing feeds load without a model call for
every viewport. Container searches inspect that container, so instructions outside it do not count as a loaded row.
If the document cannot scroll and exactly one container can, a content target resolves to that container.
Scroll searches and target gestures replay with semantic descriptors.

Before executing a model action, the engine uses the original connected reference. Only a stale reference triggers observation and semantic relocation, with at most two retries. Playwright still checks actionability. If a trusted click reached the original control before its handler replaced it, a subsequent detached-control error does not repeat the click. Fresh observation and the declared checks still decide its effect.

## Settle

Before each decision, the engine waits until the page is quiet: no data or navigation request is in flight, and there has been no DOM mutation for 350 ms.
- Visible `aria-busy`, indeterminate progressbars without `aria-valuenow`, loading text in status/live regions, and newly appearing loading markers keep the page busy. Ordinary text, determinate progress and initially present decorative markers do not. Newly mounted class/id loading decorations expire after two seconds if they remain; explicit semantic busy signals still block. Settle polls only busy signal nodes, rather than rebuilding the DOM observation. Busy has its own settle reason. Bounded busy waits precede completion review and do not consume action rounds.
- The app's own scripts and stylesheets count as requests, because a lazily loaded component renders nothing until its module arrives.
- Inline-style changes, SVG attribute churn, `<head>` changes and semantic `time`/`role=timer` updates do not count as mutations. Document and shadow observers apply the same rules and record the last genuine mutation.

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

A `check` asks Jev three independent questions: does the claim hold, how does the page support it, and is the region where its evidence belongs open and visible?
- The content judgments require direct evidence from the view, list, record or field the assertion names. Counts, notifications and button states cannot prove the contents of another view. Missing content is `not_shown`, even when the truth judgment is confident. A claim about a badge or notification can use that object directly.
- Direct support passes; an explicit visible contradiction fails as `product`. Missing content in a confidently open visible region also fails as `product`. Empty, loading or erroneous contents do not close a region. Collapsed sections, unselected tabs, unopened dialogs and other pages are not open regions. Unknown region evidence remains uncertain.
- A failed or unclear answer gets a second look after the page settles again. Jev is asked again only if the page changed (its observation signature differs); otherwise the first answer stands.
- If it is still unclear, the helper LLM reads the same evidence and independently chooses true/false/not_shown and open/closed/unknown. Missing content whose region is closed or unknown fails as `agent`; the report names an unopened region explicitly.
- The last three completed action steps supply successful actions to identify the subject and opened view. Those actions do not prove the asserted resulting content. Product-looking failures still undergo the existing target audit.
- The report keeps the observation the final verdict was judged against.

With a `reference`, the judge compares the page with your trusted data.

## Recordings and healing

This engine reads 0.1.x–0.6.0 recordings. New gestures and optional `fileKeys`, `scrollText`, `pageValue`, `key`, `times` and target `ariaName` fields require this Unreleased engine, or 0.7.0+ once released. Older 0.6.0 readers can reject new tools or silently discard these fields. Recordings retain schema version 1; waits are runtime timing decisions and are no longer recorded.

Legacy accessible-name targets remain resolvable after visible-label promotion. New targets retain the original aria name to disambiguate swapped labels.

Successful act steps record semantic targets, optional drag destinations, file-key lists and scroll searches, and an optional end state: a normalized changed path,
up to four appeared anchors and up to two disappeared controls. Toasts, numeric names and unstable
names are excluded; typing-only steps record no anchors. A `likely-done` step records no end state.

Inputs read from the page record an optional `pageValue` descriptor: observation source and the text before and after the value. Replay reads between those anchors in the current observation. Missing or ambiguous anchors trigger fresh grounding in auto mode; replay mode fails as `agent` with “Page value needs model grounding (source is missing or ambiguous)”. Target descriptions replace only complete value tokens with at least three characters. Action logs mark these inputs with `page:`. Existing recordings remain valid.

An unresolved type without supplied values receives a separate source/span judgment before using a helper.
Only a requested page source enables subsequent page-value vocabularies. Short public page inputs use key
events; model history identifies their starting field and notes that automatic focus can advance between
fields. That history does not replace an independent check of the accepted result.

Replay first checks a declared expectation. Otherwise, recorded end states must match the path,
at least half of the appeared anchors, and every disappeared control. The engine polls for up to
five seconds. An empty end state provides no additional evidence and is labeled in the report.

- In auto mode a missing target or mismatched end state triggers AI healing from the current page.
  Healing must perform a new successful action before it counts. A step healed after a mismatched end
  state is then dropped from the recording rather than saved: its actions started from a page the
  misfired replay had already changed. The next auto run grounds the step from its start and records it.
- In replay mode a missing target fails as `agent`; a failed declared expectation fails as `product`.
  A mismatched end state is annotated and execution continues, leaving the verdict to later checks.
  Even a passing test retains that annotation so its recording can be reviewed.
- End state mismatch alone does not establish a product defect. Failed healing can be attributed
  to `product` only when every recorded target matched a unique full identity and the action review
  supports the intended control with probability at least 0.75 (or an expectation failed).
- Legacy recordings without end states still replay. Auto may backfill an end state only if a later
  verify or write/URL expectation passes and the whole attempt passes. Invariants alone do not qualify.
- Recording writes require a changed, added or dropped step, or a newly added end state. Unchanged replay and
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

An error or rejection noticed during an unfinished `act` defaults to `agent`: the agent may have submitted incomplete input. A rejected declared request or a monitored high-severity issue supplies deterministic failure evidence. `expectError` still accepts the explicitly declared rejection; an unexpected request status remains `product`.

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

Use `secret(value, { purpose: 'password' | 'any' })` in `TestSpec.secrets`, separate from ordinary string `data`. The default purpose is `'password'`: code permits only `type=password` fields. Password autocomplete hints alone do not authorize a plain text field. Use `'any'` for API keys and other editable fields. This is an intentional breaking change before 1.0. Handles stringify as
`{secret}`. Only trusted test code can call `reveal(handle)`; `RunContext.secrets` exposes the handles.
An action references a secret by `{key}`. Models receive that placeholder and `<secret value>`, while
code fills the original value only into an enabled editable field that satisfies its declared purpose. Replay applies the current handle purpose; recordings do not store secret values or relax purpose checks. When a step supplies several values including a secret, Jev matches the value to the selected field in a separate request before typing. Incompatible secrets are omitted from that field-specific value choice. The browser checks the actual field again immediately before input, including after semantic relocation. Select actions and semantic `check`
assertions cannot consume secrets; verify exact values with `verify` and `reveal` instead.

Model payloads, progress logs and text artifacts redact the full secret, URI encoding (including browser
URL encoding), JSON escaping, HTML entities and base64. A secret-bearing descriptor is not recorded;
the report explains why that step needs AI again. Secret names are excluded from learned end anchors.
Tests that declare a secret take no step screenshots. Any other test skips a screenshot while its page
shows a secret declared elsewhere in the run. While a run has secrets, every trace is recorded without
frames; its text is rewritten and binary entries containing a secret are removed. Failed rewriting deletes
the original trace and sets `traceWithheld` without changing the test verdict.

This is an accidental-disclosure boundary, not encrypted storage. It does not recognize arbitrary
transformations such as truncation, case changes, hashes, or a secret split across nodes. Requests to
allowed app origins still carry the tested input, as intended. Keep real credentials out of ordinary data.

Engine result grammar is preserved only for engine-owned fields. User evidence, reference and metadata
objects are fully redacted, including their keys. CLI setup and translation callback errors are redacted
before being printed. These protections cover declared values and their documented encodings, not
arbitrary application hashes or application-truncated fragments of a secret.

Engine protocol types, question IDs and option IDs retain their identities. User data/file keys containing
a declared secret use deterministic aliases that are checked for secret content and collisions; Jev and
helper answers resolve back to the original key before browser execution. Dynamic descriptions and
reference evidence are redacted. Report display paths may be redacted, while writers use the separate
physical directory. A stable hashed selection key preserves `--last-failed` when a test ID is redacted.
