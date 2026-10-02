# Configuration and CLI

## The config file

`jevwright` looks for `jevwright.config.ts` (or `.mts`, `.js`, `.mjs`) in the current directory; `--config <file>` points elsewhere. The file and the tests it imports load without a build step:
- Under Node, [jiti](https://github.com/unjs/jiti) loads them. Subpath imports from `package.json` (`#lib/*`) work; tsconfig `paths` aliases do not.
- Under Bun (`bunx --bun jevwright`), Bun loads them itself, so tsconfig `paths` work too.

```ts
import { defineConfig } from '@hazymoon/jevwright';
import { accountTests } from './jevwright/account';
import { billingTests } from './jevwright/billing';

export default defineConfig({
    baseURL: 'http://localhost:3000',
    tests: [...accountTests, ...billingTests],
});
```

| Field | Default | Meaning |
| --- | --- | --- |
| `tests` | required | The tests, in report order. |
| `baseURL` | — | The origin of an app that is already running, such as `http://localhost:3000`. Paths belong in each test's `start`. |
| `setup` | — | Starts the app for a run; takes precedence over `baseURL`. See [below](#starting-the-app-per-run). |
| `allowedOrigins` | `[]` | Further origins of your app, such as an API or auth server on another port. The browser may reach them, and their requests are monitored like the app's own. Every other origin is blocked. |
| `recordingsDir` | `jevwright/recordings` | Recordings to commit, one JSON file per test. |
| `outputDir` | `.jevwright/runs` | One directory per run, with reports, screenshots and traces. |
| `concurrency` | `2` | Tests in parallel, each in its own browser context. |
| `retries` | `1` | Extra attempts for a failed test. |
| `maxCostUsd` | `1` | Stop a run once its model cost reaches this. |
| `viewport` | `{ width: 1280, height: 900 }` | Browser viewport. |
| `locale` | `en-US` | Browser locale. |
| `timezone` | `UTC` | Browser time zone. |
| `failOnIssues` | `true` | Fail a test when a high-severity issue appears: an uncaught page error, a 5xx response, a server error screen, or the app not loading its own code. `false` only reports them. |
| `translationKeys` | — | Your app's translation keys, or a function returning them. A key rendered verbatim is reported as untranslated. |
| `models` | from the environment | Gateway and model settings. See [Models and keys](#models-and-keys). |
| `command` | `npx jevwright` | How this project runs jevwright; reports use it in reproduce commands, e.g. `pnpm e2e`. |

`recordingsDir` and `outputDir` resolve against the directory of the config file, so the CLI behaves the same from any working directory.

Unknown fields are errors. So are the following, all reported before anything starts:
- a `baseURL` or allowed origin with a path, a query or credentials;
- a test with a missing field;
- a duplicate or non-kebab-case test id;
- a `start` that is not a path;
- a `{key}` that the test's `data` lacks.

## Starting the app per run

`setup` starts a disposable app for each run: a fresh database, a seeded server, a warm cache. Whatever it returns as `env` reaches every `fixture` and step. `teardown` always runs afterwards, including after a failure, an invalid `baseURL` or Ctrl-C; the CLI waits up to 30 seconds for it.

```ts
import { defineConfig } from '@hazymoon/jevwright';
import { startTestServer } from './scripts/test-server';
import { allTests } from './jevwright';

declare module '@hazymoon/jevwright' {
    interface Register { env: { databaseUrl: string } }
}

export default defineConfig({
    tests: allTests,
    async setup({ tests, signal, log }) {
        const server = await startTestServer({ signal });
        log(`app ready at ${server.url}`);
        return {
            baseURL: server.url,
            env: { databaseUrl: server.databaseUrl },
            serverLog: () => server.output(),       // saved as server.log next to each report
            metadata: { database: server.databaseName },   // recorded in run.json
            teardown: () => server.stop(),
        };
    },
});
```

- `tests` holds the tests this run selected; use it to warm up only their start pages.
- `signal` aborts on Ctrl-C. A second Ctrl-C exits at once, without waiting for `teardown`.
- `log` writes a progress line to stderr.
- `--base-url <url>` skips `setup` and tests an app that is already running.

The `Register` declaration types `env` in every fixture and step. Without it, `env` is `unknown`.

## Models and keys

jevwright uses two models, both through one gateway:
- **Jev** grounds steps and judges checks.
- **A helper LLM** (DeepSeek V4.1 Flash by default) suggests the next action when Jev is stuck. It is called at most twice per step.

| Environment variable | Gateway |
| --- | --- |
| `OPENROUTER_API_KEY` | [OpenRouter](https://openrouter.ai/) (preferred when both are set) |
| `VERCEL_AI_GATEWAY_API_KEY` or `AI_GATEWAY_API_KEY` | [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) |

`--env-file <file>` loads variables from a file. Variables already set in the shell keep their values.

```ts
models: {
    provider: 'vercel',            // use this gateway's key even when both are set
    apiKey: process.env.MY_KEY,    // instead of the variables above
    jevModel: 'typesafe-ai/jev',   // gateway model ids
    llmModel: 'deepseek/deepseek-v4.1-flash',
    maxCallsPerTest: 80,           // per test attempt, failed calls included
    timeoutMs: 45_000,             // per request
},
```

`--mode replay` and `--dry-run` need no key.

## CLI

```
jevwright <command> [options]
```

| Command | What it does |
| --- | --- |
| `run [filters]` | Run tests. |
| `list [filters]` | List the selected tests; starts nothing and needs no key. |
| `init` | Create `jevwright.config.ts` and `jevwright/example.ts`, and add `.jevwright/` to `.gitignore` if the project has one. Never overwrites. |
| `report <run-dir>` | Rebuild `report.md` and `report.html` from a run's `summary.json`. |
| `serve [run-dir]` | Serve a run's HTML report on 127.0.0.1 and print its URL, which carries a random access token (default: the latest run). |

**Filters** narrow the selection; each takes a comma-separated list.

| Flag | Selects |
| --- | --- |
| `--test <ids>` | Test ids; `prefix*` matches by prefix. An id that matches nothing is an error. |
| `--module <names>` | Tests whose `module` is listed. |
| `--tag <names>` | Tests with any of the tags. |

**Run options**

| Flag | Meaning |
| --- | --- |
| `--mode auto` | Default. Replay recordings, heal stale steps with AI and update their recordings. Tests without a recording run with AI and are recorded. |
| `--mode replay` | Recordings only: no model calls. A stale step, or one with no recording, fails as `agent`; `check` steps are skipped. |
| `--mode ai` | Ignore recordings and ground every step with AI, to measure the AI itself. |
| `--new` | Author the tests named by `--test`: an AI pass that records (no retries), then a replay of that recording. |
| `--dry-run` | Run fixtures, open start pages and check initial invariants only; saves each start page's observation. Never retried. |
| `--retries <n>` | Override `retries`. |
| `--concurrency <n>` | Override `concurrency`. |
| `--max-cost <usd>` | Override `maxCostUsd`. |
| `--no-record` | Do not write recordings. |
| `--base-url <origin>` | Test an app already running at this origin instead of calling `setup`. |
| `--headed` | Show the browser. |
| `--probe` | Also ask on every decision whether the page looks broken. |

**Global options**

| Flag | Meaning |
| --- | --- |
| `--config <file>` | Config file to load. |
| `--env-file <file>` | Load environment variables from a file. |
| `--port <n>` | Port for `serve`. |
| `-h`, `--help` | Show help. |
| `-v`, `--version` | Show the version. |

**Exit codes**

| Code | Meaning |
| --- | --- |
| `0` | No test failed: each passed, or was flaky, known or skipped (`skip`). |
| `1` | A test failed. This includes budget failures, missing replay targets, expectation failures, and mixed failures. |
| `2` | A usage, config or setup error, including an app that does not answer at the base URL; the message says what to fix. |
| `3` | An internal error. Please [report it](https://github.com/Ice-Hazymoon/jevwright/issues). |
| `4` | A standalone replay failed only because steps lack recordings. Record them in auto mode. The replay pass of `--new` still returns 1. |
| `130` | Interrupted. |

## Recordings

Each passing AI-grounded or healed test writes `recordings/<test-id>.json`:
- Each step's path is stored as semantic targets: role, accessible name, nearby text, the row or list item it sits in, and which of several same-named controls it was.
- Values from `data` are stored as their keys, not as the text, so changing `data` needs no new recording.
- A recording is keyed by the step's wording: rewording a step records it again.
- Reviewing a recording's diff shows how the UI changed.

## Programmatic API

The CLI is a thin layer over these exports:

```ts
import { loadConfig, runSuite, selectTests } from '@hazymoon/jevwright';

const { config, outputDir, recordingsDir } = await loadConfig();
const summary = await runSuite(selectTests(config.tests, { tag: 'smoke' }), {
    baseURL: 'http://localhost:3000',
    outputDir,
    recordingsDir,
    mode: 'replay',
});
process.exitCode = summary.totals.failed ? 1 : 0;
```

| Export | Purpose |
| --- | --- |
| `defineTest`, `act`, `check`, `verify`, `reload`, `back`, `goto`, `run` | Writing tests |
| `defineConfig`, `loadConfig` | The config file |
| `runSuite(tests, options)` | Run tests and write a run directory. Resolves with the summary and never throws for a failing test; throws a `JevwrightError` before anything runs for invalid tests or options, an app that does not answer, or missing `models` in auto and ai mode |
| `selectTests(tests, filter)` | The same selection as `--test`, `--module` and `--tag` |
| `serveReport(runDir, port?)` | Serve a run's report on 127.0.0.1 |
| `gatewayFromEnv(env?, provider?)` | The gateway and key the environment provides |
| `JevwrightError` | Errors the user fixes in their setup; the CLI prints them and exits with 2 |
| `VERSION` | The package version |

The types of the config, tests, options and results are exported too, such as `JevwrightConfig`, `TestSpec`, `SuiteOptions`, `RunSummary` and `ModelSettings`.

Differences from the CLI:
- `runSuite` needs `models` (a `ModelSettings`, e.g. from `gatewayFromEnv()`) in auto and ai mode.
- `maxCostUsd` is unbounded unless you set it; the CLI defaults to $1.
- `runSuite` neither calls `setup` nor loads `--env-file`; pass `baseURL` and `env` yourself.

`models.models` takes AI SDK evaluation and language models to use instead of a gateway, for example the SDK's mock models in your own tests. It is experimental: it relies on the AI SDK's experimental evaluation API, whose shape may change in a minor release.


### Declaring secrets

```ts
import { act, reveal, secret, verify } from '@hazymoon/jevwright';

const accessKey = secret(process.env.TEST_ACCESS_KEY!);
// Inside a test:
// secrets: { accessKey },
// steps: () => [
//     act('Enter {accessKey} in the API key field'),
//     verify('key persisted', ({ secrets }) => storedKey === reveal(secrets.accessKey!)),
// ],
```

Secrets need at least six Unicode code points. Duplicate keys across `data` and `secrets`, non-handle
secret values, and `check` assertions that reference a secret key are authoring errors. Definitions that
need their fixture are checked when that fixture has been created, before steps execute.

## Files, devices and downloads

Declare upload inputs with `files: { avatar: file('fixtures/avatar.png') }`, then write
`act('Upload {avatar} with Upload avatar')`. The model sees the filename, never the local path.
Paths resolve under the configuration directory (programmatic `rootDir`, default current directory).
Missing files and symlinks outside that root fail before browser launch. Native file inputs and
visible buttons that open a file chooser are supported. A chooser must appear within five seconds.

`--device mobile` overrides test `device`, then config `device`, then legacy `viewport`.
Mobile uses 390×844, touch, DPR 3 and a mobile Chrome user agent. Custom devices accept `viewport`,
`isMobile`, `hasTouch` and `userAgent`. Desktop recordings keep `<id>.json`; mobile uses
`<id>.mobile.json`, and custom devices use a stable settings hash. Touch clicks use tap; hover
reveal remains available. The runner returns to the most recent live page when a popup closes.

`act('Export CSV', { expect: { download: { filename: /\.csv$/ } } })` waits for a matching download.
A later `verify` reads `downloads`, an array of `{ filename, path, bytes }`; file contents are
available only to trusted test code. Untrusted suggested names never determine output paths.
Undeclared downloads are cancelled. Downloads larger than 20 MiB are deleted and fail the expectation.
Transfers have a 30-second limit. Blob/data downloads are allowed; network downloads use the origin proxy.
Fixture-dependent step declarations provisionally allow downloads in the context, but cancel every
download outside a declared step. Downloaded files are test data; do not export production secrets.
