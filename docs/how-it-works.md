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
and visible labels that differ from accessible names. When an accessible name omits the visible control label, that label becomes primary and `aria_name` retains the accessible name; `content` still retains rendered text. Focused inputs, textareas and contenteditable editors report `selection`, including an empty selection. Editors also expose computed bold, italic and underline ranges when text-node offsets match the exact rendered value. Ranges use UTF-16 offsets and are omitted for protected or clipped values. New end-state and check evidence compare these ranges; older recordings without them retain their existing checks. Inline formatting remains part of one editor, and its text stays whole before secret protection. The observation excludes hidden and clipped
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
- Control review and target audit share one authorization question. Requested entities or values match
  controls through visible context; labels need not repeat the full requested value. Named elements, necessary final
  controls in the current form/dialog/flow, requested destination views, and dismissal of blocking
  overlays are allowed. An earlier boundary or dedicated next step reserves its action. Each shared judgment names the actual reserved next action. Candidate audits
  receive prior successful actions, current page, same-control activations and helper reasoning as context.
  Corrected input history does not become part of the candidate being audited. Historical audits judge
  targets, counts and boundaries when actions occurred; missing product effects do not reject a delivered target. The control helper
  explains pending actions before choosing activate/finished. An authorized required activation
  executes before completion, including a none/done proposal. Selecting a date alone cannot complete
  a requested reservation. Every navigation clause, including “then open”, requires activation or explicit
  current-view state. Global titles, URLs and badges do not prove another view is open.
- A proposed activation with tool and target confidence at least `models.actionPriorityThreshold` (default 0.75) competes with completion, including when a following step exists. The current-clause control review must authorize the pending activation, and the target audit must support that proposed action at 0.75 before execution. The audit of this next action excludes corrected earlier mistakes; completion review receives successful actions and nonfailure events. The decision history and action records retain failed attempts for recovery and diagnosis. A winning proposal retains its authorized input and file arguments. Successful activations on the same ref prevent unrequested repeats; hover does not count as activation. The 0.75 default keeps uncertain proposals out of this conflict gate.
- An independent remaining-work question reviews every requested clause and required final control. Permission to use other editor controls does not make them required completion work. Completion review uses the same action scope as control review. A requested committed result authorizes its necessary final control, even if the instruction does not name that button. Selection or editing alone authorizes no commit. A proposed action is stored separately from delivered history. Prior actions supply flow and repeat context without making the proposal count as already executed. The review can propose a missing action when the decision offers none or wait. A weak stage review does not overturn an otherwise completed step; a strong pending judgment does. Only strong target support injects a review-proposed action.
- Navigation review applies to requested final destination views. Closed prerequisite menus or pickers, completed gestures and uploads require no destination view. Activation or explicit current-view state must establish that a requested view opened. A global heading or badge alone is insufficient. Once the view is open, later checks evaluate its content. Empty or loading content does not undo navigation.
- When Jev proposes no action, a completed field can still lead its next-target ranking. The engine separately selects an enabled activation control when it has at least half of the activation candidates’ probability mass. This selects a review candidate, not an executable action. The shared current-step scope, repeat limits and target audit at 0.75 still govern execution.
- When completion conflicts with a proposed activation, completion review includes a control judgment against successful history. A standalone control judgment runs when completion was not reviewed. An uncertain activation can receive a helper review within the two-call limit. So can an authorized, unactivated candidate that conflicts with completion. Missing next-step boundaries are explicit; a later action is never inferred. The helper sees the current page and successful history. An empty connected-control history does not invalidate delivery to a replaced control. Changing nearby counts or labels does not authorize extra repeats. A disputed required activation blocks completion unless its target audit clearly rejects it as unrelated. Neither review authorizes an unrequested submission, confirmation, purchase or deletion.
- Successful later actions can correct earlier failed attempts. Missing product effects after delivered actions belong to later checks. Completion review receives code-computed page changes and successful keyed inputs, without exposing secret text. Inputs delivered to a replaced form remain evidence even when its fields disappear. Later checks still determine whether the result is correct. A strong action-stage judgment can end a step when empty product content lowers the original completion probability. An explicit next step remains separate work. With that boundary, the scoped achieved/pending choice uses its majority; navigation and missing-value guards still apply. Every current clause must be complete.
- Tool prerequisites, such as scrolling a control into view before clicking, count as performed. Dragging requires distinct source and destination DOM elements; a self-drop fails before the gesture.
- A declared write request ends a single submission after a submitting action (click, Enter, select) once the request succeeds. Compound instructions still check remaining work, so the first successful request cannot hide a later action.
- If Jev thinks the step is done but the declared request never started, it is told once that nothing was saved.
- A value the step names, which was not on the page when the step began, must be typed or selected, or must appear on the page. Until then, neither a successful request nor Jev's "done" completes the step. This stops a different control that saves through the same request from finishing the step early.
- Notices already on the screen when the step began are marked as such, so a stale error does not fail the next step.

The helper LLM (DeepSeek V4.1 Flash by default) is consulted when Jev is stuck:
- when it is unsure of the target;
- when it proposes nothing;
- when it repeats itself;
- when an action it just chose failed.

Conflicting completion scores can treat unsaved edits or an opened initiation dialog as unfinished work. Within the two-helper-call limit, a review compares every current-step action with successful history and stable effects caused by this step. It runs at most once per new successful action count, including before extra gestures on exactly edited fields. The helper must select a provided code proof: a fulfilled author-declared write after activation with no new code-detected rejection, exact authored field edits, a field composed from several authored values plus whitespace, an opened initiation dialog with its next action reserved, or an opened view. For a composed field, its template describes observed content; the helper must compare every requested separator and paragraph break, then repair any mismatch with an authorized whole-field template. Only the declared-write proof supports a requested commit; the others authorize no commit, formatting or later navigation. Every additional action clause still needs delivery. Unsupported completion does not bypass the normal guards. Declared expectations and later checks still decide effects and the test verdict.

The helper is called at most twice per step. It may:
- act on a numbered control;
- type a data value or an exact span from the current observation;
- enter several of the step's values joined by line breaks, as multi-paragraph text.

It may not invent text. Page values must appear verbatim in the current observation, with whitespace normalized and case preserved. Declared secrets and redacted markers never qualify as page values. Sources are split around redacted markers so marker fragments cannot become input. Only after Jev chooses page input does the engine send a bounded list of observed spans for grounding; ordinary supplied inputs omit this vocabulary. The helper can request another observed span, which code validates. Without a provided code proof, a "done" from the helper counts only when Jev does not clearly disagree.

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
The helper can authorize a group through declared file keys without a text value. Each new native file selection replaces the input's current files, so a requested group is selected together.
Fresh and replayed action history retains the selected file keys. Successful uploads count as activations of their exact control, so completion review can distinguish a finished group from a missing file. Reviews also receive the declared key-to-name mapping, with secrets masked.

Scroll can target the page or a scrolling container. Targetless legacy scrolling uses the document or the unique visible scrolling container; no movement fails explicitly. `scroll_to` brings a named text or control into
view. For a scroll search, Jev selects an identifying entity from the instruction. Matching folds case, parentheses and punctuation and retains word boundaries, so Record 12 does not match Record 120. Parenthesized identities and noun/number pairs can match independently of the full phrase. The search advances by 75% of a viewport and probes only mounted visible text between moves; a match triggers full observation. Page and time caps adapt to scroll height, with at most 500 moves, five unchanged positions and a shared 120-second step budget. Loading waits consume time and the stall limit, but not the successful-movement budget. A missing goal fails with “not found after N viewports”. This lets virtualized rows render and lets growing feeds load without a model call for
every viewport. Container searches inspect that container, so instructions outside it do not count as a loaded row.
After two successful single-page scrolls, the decision receives an entity-search reminder. For a quoted
name, parenthesized identity or noun/number pair, another scroll uses the selected literal instruction
entity as a scoped search even if the model keeps proposing single-page movement or scroll_to on the container itself. Search terms are
chosen only from the instruction; this does not authorize typing new data.
If the document cannot scroll and exactly one container can, a content target resolves to that container.
Scroll searches and target gestures replay with semantic descriptors.

Before executing a model action, the engine uses the original connected reference. Only a stale reference triggers observation and semantic relocation, with at most two retries. Playwright still checks actionability. If a trusted click reached the original control before its handler replaced it, a subsequent detached-control error does not repeat the click. Fresh observation and the declared checks still decide its effect.

## Settle

Before each decision, the engine waits until the page is quiet: no data or navigation request is in flight, and there has been no DOM mutation for 350 ms.
- Visible `aria-busy`, indeterminate progressbars without `aria-valuenow`, rendered loading text in active status/live regions, and newly appearing loading markers keep the page busy. Ordinary text, determinate progress and initially present decorative markers do not. Newly mounted class/id loading decorations expire after two seconds if they remain; explicit semantic busy signals still block. Settle polls only busy signal nodes, rather than rebuilding the DOM observation. Busy has its own settle reason. Bounded busy waits precede completion review and do not consume action rounds.
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
The shared subject/scope rules appear once as `claim_scope`, outside untrusted page content. Both content questions apply those rules; their criteria and thresholds remain unchanged.
- The content judgments require direct evidence from the view, list, record or field the assertion names. Counts, notifications and button states cannot prove the contents of another view. Missing content is `not_shown`, even when the truth judgment is confident. A claim about a badge or notification can use that object directly.
- Direct support passes; an explicit visible contradiction fails as `product`. Missing content in a confidently open visible region also fails as `product`. Empty, loading or erroneous contents do not close a region. Collapsed sections, unselected tabs, unopened dialogs and other pages are not open regions. Unknown region evidence remains uncertain.
- A failed or unclear answer gets a second look after the page settles again. Jev is asked again only if the page changed (its observation signature differs); otherwise the first answer stands.
- If it is still unclear, the helper LLM reads the same evidence and independently chooses true/false/not_shown and open/closed/unknown. Missing content whose region is closed or unknown fails as `agent`; the report names an unopened region explicitly.
- The last three completed action steps supply successful actions to identify the subject and opened view. Those actions do not prove the asserted resulting content. Product-looking failures still undergo the existing target audit.
- The report keeps the observation the final verdict was judged against.

With a `reference`, the judge compares the page with your trusted data. Before judging or replaying evidence,
each check observation waits up to 15 additional seconds while visible content is loading. At the wait limit, the check inspects the visible evidence. Complete evidence can pass despite a stale busy marker.
Missing evidence while loading remains a timeout, so loading alone cannot supply a product-missing verdict.

In auto/AI mode, a separate evidence choice records the exact quoted page text and its visible region
when one evidence option directly supports the whole claim. Options omit unrelated navigation and long whole-page duplicates. Options can combine up to six named fields or
several exact page quotes and controls. The model must cover every clause. Recognized absence or negative clauses cannot record positive-fragment proof and remain unverified in replay; quoted literal wording is excluded from this conservative language guard.
Evidence choices reference the element numbers already in the page state. Full target descriptors and field values remain in the recording. This choice does not change the existing verdict.
When recording updates are disabled, including `--no-record`, the judge omits this unused choice. Runtime-reference checks also omit it. The three verdict questions, thresholds, observations and adjudication remain available.
When Jev leans positive but needs adjudication, a positive tie-breaker can retain independently selected proof only while every piece matches the observation the helper read. Adjudication creates no proof. Negative-leaning judgments and missing or changed proof remain unverified in replay.
Body-field candidates can use a visible label's subject word; entity controls can use exact quoted names. The model must still select complete proof. Short whole-page options exclude incidental times, generated ids and live-region text.
ASCII control labels respect alphanumeric word boundaries, so one action name cannot match a longer, different name. Quoted subjects and unquoted capitalized labels can offer unique local excerpts of at most 256 characters, with up to 80 characters of surrounding text on either side plus complete boundary words. These excerpts exclude changing dates, generated ids, ellipses and live content. Stored proof containing an ellipsis also remains unverified, as shortened identifier suffixes can change between runs. Replay requires the whole selected excerpt, preserving its surrounding object instead of accepting the same label elsewhere. Changes to surrounding text can invalidate this proof even when the claim still holds.
Replay deterministically checks every selected quote, its recorded container/nearby context and any field value/state/content.
Element-name proof excludes generated ids and dates. Labeled read-only controls retain rendered paragraph boundaries
when their rendered text agrees with the visible-text filter. Their original accessible label can identify a proof option. JSON-escaped quoted data can also identify exact field or card content; the decoded literal must equal that observed value or content, including paragraph breaks.
If replay proof mismatches, the engine waits 1.5 seconds and settles before checking again, as for auto checks.
A mismatch after that second observation still fails. Replay retains the final check observation for audit.
New evidence marks its region normalization: generated route ids and unstable container ids do not bind it
to a previous fixture. Unmarked evidence keeps its original literal region comparison. Exact quote excerpts
must remain uniquely visible in the same recorded page or dialog; old whole-page text remains an exact comparison.
Its source is `replay`. Quotes ending in an ellipsis are conservatively treated as clipped and unusable;
use `verify` when the page itself ends its literal evidence with an ellipsis.
Checks without sufficient evidence, with changed interpolated claims, or with runtime references are
`unverified`. Legacy recordings without check evidence are also unverified. Any unverified check prevents
the test from being passed; the CLI exits 1 unless `--allow-unverified` is supplied. JSON, HTML, Markdown
and JUnit retain the unverified count even with that exit override. Negative claims often have no
recheckable positive quote; use a code `verify` for exact absence or a runtime reference.

## Recordings and healing

This engine reads 0.1.x–0.6.0 recordings. New gestures and optional `fileKeys`, `scrollText`, `pageValue`, `key`, `times` and target `ariaName` fields require this Unreleased engine, or 0.7.0+ once released. Older 0.6.0 readers can reject new tools or silently discard these fields. Recordings retain schema version 1; waits are runtime timing decisions and are no longer recorded.

Repeated unnumbered legacy recipes retain their reuse semantics; numbered recipes remain occurrence-specific.

Legacy accessible-name targets remain resolvable after visible-label promotion. New targets retain the original aria name to disambiguate swapped labels.

Successful act steps record semantic targets, optional drag destinations, file-key lists and scroll searches.
New end states compare normalized path and query parameters sorted by key. A route at the run’s baseURL
origin records `base: true` with a relative path/query; replay resolves it against the current baseURL.
Other origins record `base: false` with their literal origin and must match exactly. Unmarked legacy
routes keep path-only comparison, including when the app port changes. End states without `strict: true`
keep the legacy half-anchor rule and original gone-target resolution. They do not check new errors or
require absence before replay. Declared requests/downloads/URLs retain precedence over cached legacy
anchors. Legacy replay drift remains reported as `endMismatch`; later checks and code verification
determine the test result, as before. Legacy end observation retains inherited editor paragraphs.
Strict new end states require all appeared anchors. A unique gone control
must disappear; repeated identities record before/after counts and require that count reduction. New appeared anchors also record their absence
before the step; replay rejects effects already present before its actions. Dates, durations, live counters
and generated ids are filtered when recording. Toast/live-region contents and their controls are also excluded, including fixed visual cards sharing a landmark with separate live announcements. Truncated names, content, nearby labels and contexts cannot supply anchors; ordinary numeric result text remains evidence.
Field values are recorded only for fields this step typed, selected or targeted with keyboard input. Revealed forms supply no initial value/state anchors. Changed states and formatting require a matching element before the action.
The engine settles before recording the end and retries observations whose route changes between accessibility and DOM reads. Keyed inputs recheck current data; page inputs recheck their recorded source. A step without an
observable effect records `effect: 'none'`, so replay verifies action delivery without claiming an effect.
A `likely-done` step records no end state.

Inputs read from the page record an optional `pageValue` descriptor: observation source and the text before and after the value. Replay reads between those anchors in the current observation. Missing or ambiguous anchors trigger fresh grounding in auto mode; replay mode fails as `agent` with “Page value needs model grounding (source is missing or ambiguous)”. Target descriptions replace only complete value tokens with at least three characters. Action logs mark these inputs with `page:`. Existing recordings remain valid.

An unresolved type without supplied values receives a separate source/span judgment before using a helper.
Only a requested page source enables subsequent page-value vocabularies. Short public page inputs use key
events; model history identifies their starting field and notes that automatic focus can advance between
fields. That history does not replace an independent check of the accepted result.

Replay checks declared expectations and recorded end states. The engine polls end states for up to
five seconds. Strict recordings store the visible notices and error surfaces at the recorded end. A replay
error must be absent both before replay and at that recorded end. Invalid fields, explicit error states
and failure language qualify; `role=alert` alone does not. Information and warning states do not qualify.
The monitor independently retains its request/crash/error-screen checks in all modes.
An observed rejected declared request retains its expectation failure even when a validation message appears.
Healing receives the actual missing conditions and current route. A cached route difference alone does
not establish a missing product effect when all other recorded conditions match.
Legacy recordings without end states still verify action delivery; their missing evidence is not reconstructed.

- In auto mode a missing target or mismatched end state triggers AI healing from the current page.
  Healing must perform a new successful action before it counts. A step healed after a mismatched end
  state is then dropped from the recording rather than saved: its actions started from a page the
  misfired replay had already changed. The next auto run grounds the step from its start and records it.
- In replay mode a missing target fails as `agent`; a failed declared expectation fails as `product`.
  A mismatched end state fails immediately as `agent`, with the missing anchors listed.
  A stale recording alone does not establish a product defect.
- End state mismatch alone does not establish a product defect. Failed healing can be attributed
  to `product` only when every recorded target matched a unique full identity and the action review
  supports the intended control with probability at least 0.75 (or an expectation failed).
- Legacy recordings without end states still replay. Auto may backfill an end state only if a later
  verify, check or write/URL expectation passes. Invariants alone do not qualify.
- Recording writes require a changed, added or dropped step, or a newly added end state. Unchanged replay and
  unchanged AI paths do not rewrite the file. Changed check evidence also updates its recording.

Repeated identical instructions get separate occurrence keys. The first occurrence retains the legacy key.
Recorded duplicate targets include their original count; a changed count requires healing rather than
using the old ordinal. A failed attempt saves only the successful prefix confirmed by a passed verification
or declared expectation, and marks the recording `partial`. The failed step is never saved. Auto replays
that prefix and grounds the remaining unrecorded steps. Existing complete recordings remain unchanged
after a failed attempt, unless old unsafe secret data requires replacement. A shorter prefix cannot
discard their previously verified suffix. CLI replay never updates recording files.

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

Thrown Node assertions and Playwright matcher errors inside `verify` are product assertions. Other
exceptions remain environment failures; classification uses error types and matcher metadata.

An error or rejection noticed during an unfinished `act` defaults to `agent`: the agent may have submitted incomplete input. A rejected declared request or a monitored high-severity issue supplies deterministic failure evidence. `expectError` still accepts the explicitly declared rejection; an unexpected request status remains `product`.

An agent failure is audited against same-step request evidence: an unexpected 5xx response, or a
rejected write with a validation response body, can establish a product failure. Action-triggered
validation errors retain agent attribution. The existing target audit also excludes requests triggered
by actions on the wrong control, including server failures.

Before a product-looking failure is reported, the engine checks the earlier AI-driven `act` steps. One Jev request asks, for each step, whether its actions operated on the control the step names or on a different one. If any step is unlikely to have acted on its target (probability below 0.25), the failure becomes `agent`, and the summary names the control the step actually touched.

This question was calibrated on real run histories, 97 correct steps and 15 steps that acted on a wrong field:
- Asked as a two-way choice, it catches 14 of the 15 and misjudges 1 of the 97.
- A plain yes/no question at the same threshold caught only 9.

A failed test is retried (`retries`, default 1):
- A failure on every attempt is reported with how often it reproduced.
- A pass on a later attempt is reported as `flaky`.
- A test marked `knownIssue` that fails on the product is reported as `known` and is not retried.
- Cancelled runs, reached cost budgets and missing recordings are never retried.
- A test cancelled by Ctrl-C is reported as `interrupted`; explicit skips remain `skipped`.

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

Partial reruns retain unresolved failures that were not selected. Interrupted runs do not resolve earlier
failures. `--last-failed` reads completed publications in finish order and removes a failure only after
a later pass or known product result. The run manifest lists failures carried outside the selected set.

An editor or selection action can be a necessary prerequisite that reveals a final control. It need not finish the whole step. Completion still requires every requested action and any necessary final control within the current step boundary.
