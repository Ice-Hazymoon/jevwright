# jevwright

[![npm](https://img.shields.io/npm/v/@hazymoon/jevwright)](https://www.npmjs.com/package/@hazymoon/jevwright)
[![CI](https://github.com/Ice-Hazymoon/jevwright/actions/workflows/ci.yml/badge.svg)](https://github.com/Ice-Hazymoon/jevwright/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@hazymoon/jevwright)](https://github.com/Ice-Hazymoon/jevwright/blob/main/LICENSE)

Browser tests for business flows, written as the steps a user takes.

jevwright opens your app in Chromium and hands one step at a time to [TypeSafe's Jev](https://docs.typesafe.ai/), which picks the control the step means on the live page. The path it finds is recorded, so later runs replay it without calling a model. The model never decides whether a test passed: your code does, through the requests you declare, your own checks against the database or API, invariants, and a monitor that watches every page for crashes and broken output.

```ts
import { act, check, defineTest, reload, verify } from '@hazymoon/jevwright';

export const profileSave = defineTest({
    id: 'profile-save',
    title: 'Edit the display name, save, and see it after a reload',
    risk: 'A saved profile change is lost after a reload',
    start: '/settings/profile',
    data: { name: 'Ada Lovelace' },
    steps: () => [
        act('Change Display name to {name}'),
        act('Save the profile', { expect: { write: { method: 'PATCH', path: '/api/profile' } } }),
        verify('the API returns the new name', async ({ page }) => (await (await page.request.get('/api/profile')).json()).name === 'Ada Lovelace'),
        reload(),
        check('The Display name field shows {name}'),
    ],
});
```

## Why jevwright

- **Steps read like the test plan.** No selectors or page objects. A redesign that keeps the words on the screen keeps the test working, and when a recorded path goes stale, the step is grounded again and the recording updated.
- **The model finds controls; code decides the verdict.** A step is done when the request you declared succeeds, not when a model says so. Business facts come from `verify` callbacks that read your database or API.
- **Recorded once, replayed for free.** The first run records each step as a semantic target (role, name, nearby text, row). Replays call no model: `--mode replay` is deterministic and costs nothing in CI.
- **Every failure has a cause.** Each failure is reported as `product`, `agent`, `environment`, `model` or `timeout`, with the evidence: the failing step, its requests, screenshots, Jev's decisions and a Playwright trace. Before blaming your app, jevwright checks whether each AI-driven step acted on the control it names.
- **Implicit checks on every step.** Uncaught exceptions, 5xx and unexpected 4xx responses, failed requests, console errors, hydration mismatches, and text such as `undefined`, `NaN`, `Invalid Date` or an untranslated key.

| | Scripted browser tests | AI browser agents | jevwright |
| --- | --- | --- | --- |
| How a step finds its control | Selectors you maintain | The model, every run | The model once, then a recording |
| Who decides pass or fail | Your assertions | The model | Your code: declared requests, `verify`, invariants |
| Cost of a repeat run | None | Model calls on every step | None in replay; a fraction of a cent to heal a stale step |
| Why a test failed | Stack trace | The model's account | A cause with evidence, `product` kept apart from `agent` |

## Install

```bash
npm install -D @hazymoon/jevwright playwright
npx playwright install chromium
```

Requirements:
- Node.js 22 or newer (Bun works too).
- Playwright 1.63 or newer.
- For AI runs, an [OpenRouter](https://openrouter.ai/) or [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) key. Replay runs need no key.

## Quick start

1. **Scaffold** a config and an example test:

   ```bash
   npx jevwright init
   ```

   This creates `jevwright.config.ts` and `jevwright/example.ts`, and adds `.jevwright/` (run reports) to `.gitignore`.

2. **Point it at your app.** Set `baseURL` to a running app, or give the config a [`setup`](https://github.com/Ice-Hazymoon/jevwright/blob/main/docs/configuration.md#starting-the-app-per-run) function that starts a fresh one per run. Then rewrite the example for a real page, using the words your UI shows.

3. **Author the test:**

   ```bash
   export OPENROUTER_API_KEY=sk-or-...   # or VERCEL_AI_GATEWAY_API_KEY
   npx jevwright run --test profile-save --new
   ```

   `--new` runs the test twice in one go. The first pass lets the model ground every step and writes `jevwright/recordings/profile-save.json`. The second replays only that recording, with no model. When both pass, commit the test and its recording.

4. **Run it from then on:**

   ```bash
   npx jevwright run                 # auto: replay recordings, heal stale steps with AI
   npx jevwright run --mode replay   # recordings only: no key, no model calls (CI)
   npx jevwright serve               # open the latest report in your browser
   ```

## Writing tests

A test is a list of steps. Code owns their order, and each step does one thing:

| Step | Decided by | Use it for |
| --- | --- | --- |
| `act('Change Nickname to {nickname}', { expect })` | Jev grounds it. `expect.write` decides when it is done | One user intention, in the words on the screen |
| `check('The Nickname field shows {nickname}')` | Jev, as independent truth, support and region judgments; unclear ones get a second look | Facts visible on the page |
| `verify('row stores the nickname', fn)` | Your code, polled for up to 8 s | Exact business facts from the database or API |
| `reload()`, `back()`, `goto('/path')` | Code | Navigation |
| `run('arm a failing save', fn)` | Code | Trusted setup between steps, such as injecting a fault |

A test also declares:
- **`risk`**: the concrete business failure it guards against.
- **`data`**: the values its steps insert as `{key}`.
- **`fixture`**: the test's own accounts and seed data.
- **`invariants`**: what must never change, checked before the first step and after every step.

The [guide to writing tests](https://github.com/Ice-Hazymoon/jevwright/blob/main/docs/writing-tests.md) explains what to hand to jevwright and what to leave to lower-level tests. It also covers:
- how to word steps;
- how to declare expected requests and errors;
- how to inject faults;
- how to author a new test;
- how to read a failure.

## Signing in

Sign each test's user in from its `fixture`: add a session cookie, or post to your sign-in API with `context.request`, which shares cookies with the page. This is faster than signing in through the UI, calls no model, and keeps credentials out of model requests. See [Signing in](https://github.com/Ice-Hazymoon/jevwright/blob/main/docs/writing-tests.md#signing-in).

## Reading results

Each run writes a directory under `.jevwright/runs/`:

| File | What it holds |
| --- | --- |
| `report.html` | Step timeline with screenshots, Jev's decisions and candidates, requests, evidence |
| `junit.xml` | CI test results grouped by module; flaky evidence remains in system-out |
| `report.md` | Failures grouped by cause, each with a command that reproduces it |
| `summary.json`, `run.json` | Results and the run manifest: git commit, mode, models, command |
| `<test>/attempt-N/` | Per-step screenshots, `result.json`, and `trace.zip` (`npx playwright show-trace`) |

| Cause | Meaning | Look first at |
| --- | --- | --- |
| `product` | Likely a bug in your app | The failing step's requests and status, the stored value, the screenshot |
| `agent` | jevwright could not drive the UI, or acted on the wrong control | Whether the step's wording matches the screen |
| `environment` | Fixture, start page, test code, or the app failing to load its own code | The fixture, `server.log`, the start page |
| `model` | Gateway error or budget reached | The key and the gateway; rerun |
| `timeout` | The test took longer than its `timeoutMs` | The slowest step and the report's "slow to settle" note |

A failed test is retried once by default. A test that later passes is reported as `flaky`, not fixed. A test marked with `knownIssue` that fails on the product is reported as `known`, so a confirmed bug does not fail every run until it is fixed.

## Costs

AI runs go through your gateway, so you pay its prices. One example, measured on a 55-test suite of a web app in September 2026 with the default models:

| Run | Cost | Per test |
| --- | --- | --- |
| Full `--mode ai` run | about $0.05 | about $0.001 |
| Auto run that replays recordings | about $0.01 | — |
| `--mode replay` | nothing | — |

Your costs depend on your pages and steps. The limits:
- Each run stops at `--max-cost` (default $1).
- Each test attempt stops at 80 model calls.

## CI

Replay mode needs no key and no model, so it is the cheapest gate:

```yaml
- run: npm ci
- run: npx playwright install --with-deps chromium
- run: npx jevwright run --mode replay
- uses: actions/upload-artifact@v4
  if: failure()
  with: { name: jevwright-report, path: .jevwright/runs }
```

Replay rechecks the direct page evidence recorded by passing `check` steps. Checks without usable evidence are `unverified` and make the CLI exit 1; `--allow-unverified` overrides that exit policy while retaining the report count. A step without a recording fails, so a test committed without its recording cannot pass CI unnoticed. To heal stale recordings and run checks in CI, run the default auto mode and provide `OPENROUTER_API_KEY` as a secret.
CLI replay leaves recording files unchanged. A failed auto attempt retains an existing complete recording;
without one, it can save a verified partial prefix. Secret checks still apply before writing a replacement.

## Documentation

- [Writing tests](https://github.com/Ice-Hazymoon/jevwright/blob/main/docs/writing-tests.md): what to test with jevwright, step wording, expectations, faults, signing in, authoring, failures.
- [Configuration and CLI](https://github.com/Ice-Hazymoon/jevwright/blob/main/docs/configuration.md): every config field and flag, `setup` and `env`, the programmatic API.
- [How it works](https://github.com/Ice-Hazymoon/jevwright/blob/main/docs/how-it-works.md): observation, the decision loop, recordings, failure attribution, safety.

## Troubleshooting

A helper output generation or parsing failure is reported as `model`. Review the saved model error and retry the run. Delayed autosave receives the declared expectation timeout even after the last allowed action.

| Message or symptom | What to do |
| --- | --- |
| `Nothing answers at http://…` | Start the app, correct `baseURL`, or give the config a `setup` function that starts it. |
| `Playwright's Chromium is not installed` | Run `npx playwright install chromium` (in CI, add `--with-deps`). |
| `No model key found` | Set `OPENROUTER_API_KEY` or `VERCEL_AI_GATEWAY_API_KEY`, or pass `--env-file`. `--mode replay` and `--dry-run` need no key. |
| Replay exits with code 4 (only missing recordings) | The step was never recorded, or was reworded since. Run the test once in auto mode (`npx jevwright run --test <id>`) and commit its recording. |
| Every test fails with "Start page did not become ready" | Open the start page yourself and read `server.log`. Check that a `ready` hook does not wait for something that never appears. |
| A request the app needs is blocked | `run.json` lists `blockedRequests`. If the origin is part of your app, add it to `allowedOrigins`. |
| Replay says “Page value needs model grounding” | The recorded page-value source is missing or ambiguous. Run in auto mode to read the current value and refresh its source. |
| A visible label conflicts with an aria name | The visible label becomes the primary name; `aria_name` and `content` retain the original name and rendered text. Review the app’s accessible labels. |
| A drag reports no observed effect | Check that the destination is correct and that the page reflects the move. A delivered gesture alone does not establish a drop. |
| Secret input fails with a password-purpose message | Use a password field, or declare `secret(value, { purpose: 'any' })` for an API key or another editable field. |
| Fresh replay misses transient or form-value anchors | Re-record with the current engine. New anchors exclude toast children, clipped identities and fields the step did not edit. |
| A recorded edit submits or adds an extra paragraph | Record again with `--mode ai`. Current completion reviews check exact edits, real paragraph blocks, successful UI activations and declared requests before further work; requested commits and later views remain separate action clauses. |
| `check` steps show as unverified | The recording lacks sufficient direct evidence, the claim changed, or it uses a runtime reference. Run in auto mode to judge it; use `verify` for exact absence or reference checks. |
| `env` is `unknown` in fixtures | Declare its type once through `Register`; see [Starting the app per run](https://github.com/Ice-Hazymoon/jevwright/blob/main/docs/configuration.md#starting-the-app-per-run). |

Anything else, or an engine that gets a well-worded step wrong: [open an issue](https://github.com/Ice-Hazymoon/jevwright/issues) with the run's `report.md`.

Unmarked legacy end states retain their half-anchor rule. New strict end states require every durable anchor
and reject newly introduced errors that were absent when recording. Informational `role=alert` content
does not qualify as an error. Strict replay fails when required end states do not match. Legacy replay
reports end-state drift and leaves the test verdict to later checks and code verification. The report lists
missing anchors. Confirm the cause with an auto run; a mismatch alone does not establish a product defect.

## Limitations

- The engine can:
  - click, type into fields and contenteditable editors, press keyboard shortcuts, select exact editable text, and choose native or ARIA options;
  - upload declared files, including a chosen group in one multiple input, and verify declared downloads;
  - follow popups and return after they close;
  - scroll the page or a container, search for instruction text while scrolling, and bring static text into view;
  - wait for transient loading signals and relocate stale targets after DOM replacement;
  - hover to reveal controls;
  - choose right-click, an 800 ms long press, double-click, drag between two semantic targets, and browser back;
  - reach script-created closed shadow roots without opening them to application code.
- It cannot:
  - draw on a canvas;
  - use the clipboard.

  When one of these is only a precondition, do it in a `fixture` or `run` step. When it is the behavior under test, use a scripted Playwright test.
- Declarative closed shadow roots are not captured. The engine wraps `attachShadow` and keeps references to script-created roots; the roots retain their original mode.
- Dragging covers HTML drag-and-drop and pointer gestures. Drawing still needs scripted Playwright steps. Keyboard shortcuts and exact editable text selection can drive rich-text formatting. Computed format ranges are available only when text-node offsets match the complete unprotected rendered value; use code verification for the required formatting.
- Scroll searches use a container-sized budget, share at most 120 seconds per step, and stop after 500 viewports or five unchanged positions. Missing goals fail explicitly.
- Desktop defaults to 1280×900. Use `device: "mobile"` for touch and a mobile user agent, or provide a custom device.
- Page values can be entered only when their exact text appears in the current observation. Replay re-reads them from recorded surrounding text; changed or ambiguous sources need an auto run. Declared secrets remain available only through their keys.
- `check` waits up to 15 additional seconds per observation for visible loading. It then checks the visible content; missing evidence while loading is a timeout. `check` requires the asserted content to be visible. A count or saved-button state cannot prove what another tab contains.
- Failed checks receive a second look. Visible contradictions, or missing expected content in an open visible region, are `product`; a collapsed or unopened region is `agent`. Uncertain region evidence receives adjudication.
- Compound factual checks can record several fields or exact page quotes. Replay rechecks every selected piece in its recorded region. Missing direct evidence and recognized absence or negative clauses remain `unverified`.
- A positive adjudication can retain proof from a check that already leaned positive. The proof must match its observation; adjudication creates no proof.
- Quoted subjects and unquoted visible labels can use a unique local text excerpt that retains surrounding context. Replay requires the whole excerpt; changing dates, generated ids, clipped text and live content cannot supply this proof.
- Check proof excludes element names containing generated ids or dates. Labeled read-only cards retain rendered paragraph boundaries when their visible text agrees.
- Proof containing Unicode `…` remains `unverified`, including a literal ellipsis. Use `verify` to assert that exact text.
- `check` is a model judgment in auto/AI mode. Replay verifies recorded direct evidence; checks without it remain `unverified`. Exact values (money, multilingual text, line breaks) and negative claims belong in `verify`.
- New recordings bind app routes to the run’s `baseURL`, so changing the host or port alone does not invalidate the route check. Path, sorted query and recorded effects must still match. Routes to other origins remain literal. Unmarked legacy routes retain path-only checks.
- Chromium only.

## License

[MIT](https://github.com/Ice-Hazymoon/jevwright/blob/main/LICENSE)
