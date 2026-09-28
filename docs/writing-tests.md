# Writing tests

A jevwright test is an ordered list of plain-language steps that runs against your real app in Chromium. Jev turns each `act` into a click or keystroke on the live page. The verdict comes only from code:
- the requests a step declares;
- `verify` callbacks that read your database or API;
- `invariants`;
- the monitor that watches every page.

## What to test with jevwright

Hand jevwright the business rules a user exercises in a few steps, where the result must be stored or survive a reload:

- **Persistence across layers**: edit, save, reload, and the page and the database both hold the new value (profiles, settings, drafts, publishing).
- **Leaving and recovering**: discarding or keeping unsaved edits, retrying after a failed save.
- **Real sessions and account boundaries**: revoking a session, another account's data never showing up.
- **Duplicate and lost submissions**: a double click or a retry after a lost response takes effect once.

Leave the rest to cheaper tests:

| To prove | Use |
| --- | --- |
| Branches, edge values, permission matrices, amounts and counts | Unit and integration tests |
| HTTP contracts, middleware, error payloads | API tests |
| Exact DOM, hydration details, uploads, drag and drop, canvas, gestures, narrow screens | Scripted Playwright tests |
| Pure visual layout | Visual review or screenshot tests |

When jevwright finds a bug, add the regression at the lowest layer that can observe it.

## Anatomy of a test

```ts
import { act, check, defineTest, reload, verify } from '@hazymoon/jevwright';

export const profileSave = defineTest({
    id: 'profile-save',                     // unique, lowercase kebab-case; also names the recording file
    module: 'account',                      // optional: groups tests in reports and for --module
    title: 'Edit the nickname, save, and see it after a reload',
    risk: 'Saved profile changes are lost after a reload',   // the business failure this test guards against
    tags: ['smoke'],
    start: '/settings/profile',             // the path the test opens first
    data: { nickname: 'Ada Lovelace' },     // steps insert these as {nickname}
    fixture: async ({ context, env, defer }) => {
        const user = await env.users.create();                 // this test's own account
        defer(() => user.remove());                            // cleanup runs in reverse order, always
        await context.addCookies([user.sessionCookie]);
        return user;
    },
    invariants: [{
        name: 'email and preferences untouched',
        check: async ({ fixture }) => (await fixture.read()).email === fixture.email,
    }],
    steps: user => [
        act('Change Nickname to {nickname}'),
        act('Save the profile', { expect: { write: { method: 'PATCH', path: '/api/profile' } } }),
        verify('the account row stores the nickname', async () => (await user.read()).nickname === 'Ada Lovelace'),
        reload(),
        check('The Nickname field shows {nickname}'),
    ],
});
```

`env` is what your config's [`setup`](configuration.md#starting-the-app-per-run) returned. To type it, register it once:

```ts
declare module '@hazymoon/jevwright' {
    interface Register { env: { users: UserFactory } }
}
```

## Before you write

Answer four questions:

1. **Risk.** Which concrete failure would lose a user's data, publish something wrong, cross an account boundary, repeat a side effect, or leave the user unable to recover? Put it in `risk`. "The page works" is not a risk.
2. **Why a browser?** If a lower layer can observe the rule, test it there.
3. **Independent facts.** What proves the outcome? Use `verify` to read the database or API, and `check` after a `reload()`. A toast, an HTTP 200, or the model saying "done" does not count.
4. **What must not change.** Put untouched fields, other accounts, the current session and published content into `invariants`, not only the change you expect.

## Steps

### Wording

- One `act` per user intention, in the words on the screen: "Save profile", not "click the blue button" and never a selector.
- Look up control names in your UI source. When the same request can be sent from two places, name the path: "Click the Text card to open its editor and replace its text with {text}", not just "Replace the text with {text}".
- A confirmation in a dialog is its own step, naming the button: "Confirm with Deactivate in the dialog".
- When a list is filtered by default (for example to Active), switch to the right tab in an `act` before you `check` it.
- Aim for 3–8 steps. Prefer several focused tests over one long journey.

### Declaring what a step saves

Any `act` that writes should declare the request:

```ts
act('Save the profile', { expect: { write: { method: 'PATCH', path: '/api/profile' } } })
```

- The declared request decides when the step is done: it must start during the step and succeed.
- A declared request that fails is reported as a `product` failure.
- Leave out `status` on the success path to accept any 2xx. A handler that returns no body may answer 204, and pinning 200 would misreport it.
- `path` accepts a string or a regular expression and matches the request's path on the app's origin or any of `allowedOrigins`. `write` also accepts a list, when a step must send several requests.

A step is also not done while a value it names, such as `{nickname}`, was neither entered nor shown on the page. This matters when another control saves through the same request (for example "Add card" and "Edit card").

### Expected errors

For a step that should end on an error (a validation failure, an injected fault), set `expectError: true` and give the specific non-2xx status in its `expect.write`:

```ts
act('Save the profile with an invalid email', {
    expectError: true,
    expect: { write: { method: 'PATCH', path: '/api/profile', status: 422 } },
})
```

That status is expected only during that step; the same error anywhere else is still a finding. Use the test-level `expectedHttp` only for requests that belong to no step.

### Checks and verifications

- `check` states only what a user can literally see, without assuming exact copy. An injected 503 usually shows a generic message, so write "The page shows an error message, not a success message".
- State multi-line values as separate sentences.
- Exact values (money, multilingual text, line breaks) belong in `verify`: read `page.getByRole(...).inputValue()`, the database or your API.
- `check` accepts a `reference` callback that hands trusted data (for example amounts read from the database) to the judge.

### Data

- `data` values are strings. Steps insert them with `{key}`; a key the test does not define is reported before anything runs.
- Put multi-paragraph text into one value with line breaks (`'First paragraph\n\nSecond paragraph'`); do not split it into several values. The engine types the paragraphs with Enter, or enters the whole text at once.

## Faults and lost responses

Inject faults in a `run` step with Playwright routing, so the next matching request fails once:

```ts
run('fail the next profile save once', async ({ page }) => {
    await page.route('**/api/profile', route => route.fulfill({ status: 503, body: 'Service Unavailable' }), { times: 1 });
}),
act('Save the profile', { expectError: true, expect: { write: { method: 'PATCH', path: '/api/profile', status: 503 } } }),
check('The page shows an error message, not a success message'),
act('Save the profile', { expect: { write: { method: 'PATCH', path: '/api/profile' } } }),
```

When a test aborts requests itself to simulate a lost response (`route.abort()`), declare them in `expectedAborts: [{ method: 'PATCH', path: '/api/profile' }]`. The monitor then does not report them as failed requests or console errors.

`fixture` and `run` steps prepare data and sessions, or simulate another party (a seller renaming a product between steps). They never perform the action under test on the user's behalf.

## Signing in

Sign the test's user in from its `fixture`, not with `act` steps. It is faster and calls no model. Credentials in `data` would reach the model inside a step's instruction; cookies set in a fixture never do.

Add a session cookie your code creates:

```ts
fixture: async ({ context, env, origin }) => {
    const user = await env.users.create();
    await context.addCookies([{ name: 'session', value: user.sessionToken, url: origin }]);
    return user;
},
```

Or sign in through your API with the context's request client, which shares cookies with the page:

```ts
fixture: async ({ context, env }) => {
    const user = await env.users.create();
    await context.request.post('/api/auth/sign-in', { data: { email: user.email, password: user.password } });
    return user;
},
```

To test the sign-in form itself, write steps for it like any other flow, with a throwaway account.

## Isolation

- Give each test its own account and seed data in `fixture`, and filter database reads by the fixture's ids. Tests run in parallel, each in its own browser context, and never share state.
- Register cleanup with `defer` right after you create something.
- Replace native dialogs' default (`dialogs: 'accept'`) with `'dismiss'` where the test needs it.

## Known issues

For a confirmed product bug you will not fix yet, set `knownIssue` to what fails, where, and a tracking reference, and leave the assertions alone:
- A failure caused by the product is then reported as `known`. It is not retried and does not fail the run.
- Any other failure stays `failed`.
- When the test passes, the report asks you to remove the mark.

Never mark `agent`, `environment` or `model` failures this way.

## Authoring a new test

Finish each stage before the next:

1. **Write the steps and the oracles** following this guide. Every `act` that writes has an `expect.write` or a following `verify`.
2. **Dry run**, which calls no model:

   ```bash
   npx jevwright run --test profile-save --dry-run
   ```

   This runs the fixture, opens the start page and checks the initial invariants. Its `start-observation.json` shows what the engine sees. Confirm that the controls your first step names are there.
3. **First run, recording, replay**:

   ```bash
   npx jevwright run --test profile-save --new
   ```

   The model grounds each step with no retries and writes `jevwright/recordings/profile-save.json`; then the recording alone must reproduce the result.
4. **Commit** the test and its recording when both passes succeed, or once each failure is attributed and handled (next section).

## Reading a failure

`report.md` groups failures by cause and gives each a command that reproduces it. Start with what that cause makes most likely:

| Cause | Check first | Then |
| --- | --- | --- |
| `product` | The failing step's requests and status, the stored value, the screenshot | Fix the app and add a regression at the lowest layer; or mark `knownIssue` |
| `agent` | Whether the step's wording matches the screen: does the path exist, are the names the UI's own? "Not counted against the product" means an action landed on the wrong control. In replay, "no recording" means the step was never recorded | Reword the step. Move interactions jevwright cannot do to a scripted test; move exact values to `verify`. Record a missing step with an auto run |
| `environment` | The fixture, the start page, `server.log` (from `setup`) | Fix the fixture or rerun |
| `model` | Gateway errors, the call and cost budgets | Rerun; if it persists, check the gateway and your key |
| `timeout` | The slowest step and the report's "slow to settle" diagnosis | Split the step, or prepare data in the fixture |

A `flaky` test, one that passed on a retry, is not solved. Keep the first failure's evidence and decide whether something needs to change.

If the wording matches the screen, the interaction is supported, and jevwright still gets it wrong, you have found an engine gap. Please [open an issue](https://github.com/Ice-Hazymoon/jevwright/issues) with the run's `report.md` and the failing attempt's `result.json`. Do not work around it by loosening assertions, doing the step in the fixture, or retrying without limit.
