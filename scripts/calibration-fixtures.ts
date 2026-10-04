import type { TestSpec } from '../src/index.ts';
import type { startFixtureApp } from '../tests/fixtures/app.ts';
import { act, check, reload, secret, verify } from '../src/index.ts';

/** Declare newly required exports here so older engines can exclude unsupported cases. */
export type CalibrationTest = TestSpec<void> & { expected: 'passed' | 'product'; requiredApis?: readonly string[] };

type App = Awaited<ReturnType<typeof startFixtureApp>>;

/** Expected outcome per test: healthy flows pass; defects fail as product issues. */

export function fixtureTests(app: App): Array<CalibrationTest> {
    const tests: CalibrationTest[] = [];
    const profile = (id: string, bug: string | undefined, expected: 'passed' | 'product') => tests.push({
        id,
        expected,
        module: 'fixture',
        title: 'Edit and save the profile, then confirm it persists after reload',
        risk: 'Saved profile changes are lost or altered',
        start: `/profile${bug ? `?bug=${bug}` : ''}`,
        data: { nickname: 'Grace Hopper', bio: 'Compilers\nand COBOL' },
        fixture: async () => { app.reset(); },
        steps: () => [
            act('Change Nickname to {nickname} and Bio to {bio}'),
            act('Save the profile', { expect: { write: { method: 'POST', path: '/api/profile', status: 200 } } }),
            reload(),
            check('The Nickname field shows {nickname}'),
            verify('profile persisted exactly', () => Promise.resolve({ passed: app.state.profile.nickname === 'Grace Hopper' && app.state.profile.bio === 'Compilers\nand COBOL', evidence: app.state.profile })),
        ],
    });
    profile('profile-save', undefined, 'passed');
    profile('profile-save-lost', 'nosave', 'product');
    profile('profile-save-500', '500', 'product');
    profile('profile-save-truncated', 'truncate', 'product');

    const settings = (id: string, bug: string | undefined, expected: 'passed' | 'product') => tests.push({
        id,
        expected,
        module: 'fixture',
        title: 'Turn email preferences on and off',
        risk: 'A preference switch does not persist its new state',
        start: `/settings${bug ? `?bug=${bug}` : ''}`,
        fixture: async () => { app.reset(); },
        steps: () => [
            act('Turn on the Weekly digest emails', { expect: { write: { method: 'POST', path: '/api/settings', status: 200 } } }),
            act('Turn off the Product news emails', { expect: { write: { method: 'POST', path: '/api/settings', status: 200 } } }),
            verify('digest on, news off, security untouched', () => Promise.resolve({ passed: app.state.settings.digest === true && app.state.settings.news === false && app.state.settings.security === true, evidence: app.state.settings })),
        ],
    });
    settings('settings-toggle', undefined, 'passed');
    settings('settings-toggle-sticky', 'sticky', 'product');

    const archive = (id: string, bug: string | undefined, expected: 'passed' | 'product') => tests.push({
        id,
        expected,
        module: 'fixture',
        title: 'Archive one plan through its confirmation dialog',
        risk: 'Archiving affects a different plan than the one confirmed',
        start: `/items${bug ? `?bug=${bug}` : ''}`,
        fixture: async () => { app.reset(); },
        invariants: [{ name: 'Alpha and Gamma stay active', check: () => Promise.resolve({ passed: app.state.items.filter(item => item.id !== 'b').every(item => !item.archived), evidence: app.state.items }) }],
        steps: () => [
            act('Start archiving the Beta plan'),
            act('Confirm archiving in the dialog', { expect: { write: { method: 'POST', path: /\/api\/items\/\w+\/archive/, status: 200 } } }),
            check('The Beta plan is shown as Archived'),
            verify('only Beta archived', () => Promise.resolve({ passed: app.state.items.find(item => item.id === 'b')?.archived === true, evidence: app.state.items })),
        ],
    });
    archive('plans-archive', undefined, 'passed');
    archive('plans-archive-wrong-row', 'wrong-row', 'product');

    const currency = (id: string, bug: string | undefined, expected: 'passed' | 'product') => tests.push({
        id,
        expected,
        module: 'fixture',
        title: 'Switch the display currency',
        risk: 'Prices render as NaN after a currency change',
        start: `/currency${bug ? `?bug=${bug}` : ''}`,
        data: { currency: 'Euro' },
        fixture: async () => { app.reset(); },
        steps: () => [
            act('Choose {currency} as the display currency'),
            act('Save the currency', { expect: { write: { method: 'POST', path: '/api/currency', status: 200 } } }),
            verify('currency stored', () => Promise.resolve({ passed: app.state.currency === 'EUR', evidence: app.state.currency })),
            reload(),
            check('The price preview shows an amount in euros'),
        ],
    });
    currency('currency-switch', undefined, 'passed');
    currency('currency-switch-nan', 'nan', 'product');

    tests.push({
        id: 'broken-page',
        expected: 'product',
        module: 'fixture',
        title: 'Open a page that crashes',
        risk: 'Uncaught exceptions and raw placeholders reach users',
        start: '/broken',
        fixture: async () => { app.reset(); },
        steps: () => [check('The page shows a total')],
    });
    tests.push({
        id: 'page-value-entry', expected: 'passed', module: 'fixture',
        title: 'Read and enter the current access token', risk: 'The page value is replaced by invented data',
        start: '/page-entry?token=DM-4827',
        steps: () => [act('Enter the access token shown on the page and apply it'), verify('access accepted', async ({ page }) => (await page.getByRole('status').textContent()) === 'Access accepted')],
    });
    tests.push({
        id: 'choice-finalize', expected: 'passed', module: 'fixture', title: 'Finalize a prepared choice', risk: 'Selection is mistaken for submission', start: '/effects?single=1&confirm=1',
        steps: () => [act('Finalize the choice of the entry dated 2026-01-01'), verify('choice committed', async ({ page }) => page.getByRole('heading', { name: 'Alpha chosen and confirmed', exact: true }).isVisible())],
    });
    tests.push({
        id: 'credential-entry', expected: 'passed', requiredApis: ['secret'], module: 'fixture', title: 'Use public and secret credentials', risk: 'The wrong value is entered in a field', start: '/credential-form',
        data: { account: 'marble@example.test' }, secrets: { password: secret('Private-Key-7312') },
        steps: () => [act('Sign in using account {account} with password {password}'), verify('account opened', async ({ page }) => page.getByRole('heading', { name: 'Signed in as marble@example.test', exact: true }).isVisible())],
    });
    for (const empty of [false, true]) {
        tests.push({
            id: `reading-list${empty ? '-empty' : ''}`, expected: empty ? 'product' : 'passed', module: 'fixture',
            title: 'Save an essay and inspect its reading list', risk: 'A summary hides missing saved content',
            start: `/collection${empty ? '?bug=empty' : ''}`,
            steps: () => [
                act('Save the essay, then open the reading list'),
                verify('reading list opened', async ({ page }) => (await page.getByRole('heading', { name: 'Reading list', exact: true }).count()) === 2),
                check('The reading list view displays the saved essay', { reference: () => ({ savedEssay: 'An essay' }) }),
            ],
        });
    }
    tests.push(
        { id: 'document-formatting', expected: 'passed', module: 'fixture', title: 'Select and format exact text', risk: 'The wrong word receives formatting', start: '/surface-editor', data: { text: 'ship confirmed' }, steps: () => [act('Type {text} in Document and make exactly confirmed bold'), verify('only confirmed is bold', ({ page }) => page.locator('#editor').innerHTML().then(html => html === 'ship <b>confirmed</b>'))] },
        { id: 'delegated-delivery', expected: 'passed', module: 'fixture', title: 'Move native and pointer items', risk: 'A missing container prevents delivery', start: '/surface-events', steps: () => [act('Drag Package into Receiving bay, then move Review draft into Completed'), verify('both containers', ({ page }) => page.locator('#drop #parcel').count().then(async count => count === 1 && await page.locator('#queue #task').count() === 1))] },
        { id: 'delegated-document-menu', expected: 'passed', module: 'fixture', title: 'Open a delegated context menu', risk: 'The enclosing region absorbs the file target', start: '/surface-events', steps: () => [act('Rename ledger.csv through its right-click menu'), verify('renamed', async ({ page }) => (await page.locator('#status').textContent()) === 'Document renamed' && (await page.locator('#react-file').textContent()) === 'ledger-renamed.csv')] },
        { id: 'visible-entry-labels', expected: 'passed', module: 'fixture', title: 'Follow visible input labels', risk: 'An accessible name directs input into the wrong field', start: '/surface-labels', steps: () => [act('Store the entry as the page instructs'), verify('stored', ({ page }) => page.locator('#status').textContent().then(text => text === 'Entry stored'))] },
        { id: 'archive-entity-search', expected: 'passed', module: 'fixture', title: 'Find a windowed entity', risk: 'A hint or punctuation falsely ends search', start: '/surface-search', steps: () => [act('Scroll the archive until Special entry (record 812) is rendered, then Open entry'), verify('opened', ({ page }) => page.locator('#status').textContent().then(text => text === 'Entry opened'))] },
    );
    return tests;
}
