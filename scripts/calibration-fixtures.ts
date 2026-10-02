import type { TestSpec } from '../src/index.ts';
import type { startFixtureApp } from '../tests/fixtures/app.ts';
import { act, check, reload, verify } from '../src/index.ts';

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
    return tests;
}
