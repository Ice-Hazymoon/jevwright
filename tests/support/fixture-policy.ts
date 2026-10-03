import type { Belief, View } from './scripted-models.ts';
import { find, is, near, within } from './scripted-models.ts';

const typed = (view: View, key: string) => view.history.some(entry => entry.action === 'type' && entry.value === key);
const clicked = (view: View) => view.history.some(entry => entry.action === 'click');

/** A competent scripted "Jev" for the fixture app: grounds each step the way the real model should. */
export function fixturePolicy(view: View): Belief {
    if (view.claim !== undefined) { return claim(view, view.claim); }
    const belief = act(view, view.step ?? '');
    // Like the real model, a failure notice that appeared during this step reads as an error; one the engine
    // reports as shown before the step began does not.
    const fresh = view.notices.filter(notice => !view.shownBefore.includes(notice));
    return belief.error === undefined && fresh.some(notice => /Could not/.test(notice)) ? { ...belief, error: 0.9 } : belief;
}

const bio = is('textbox', 'Bio');
const bioValue = (view: View) => find(view, bio)?.value ?? '';

/** Steps that type into a field: the Bio and the Note card editor. */
const EDITING: Array<[RegExp, (view: View) => Belief]> = [
    [/^Delete all text from the Bio field/, view => bioValue(view) === '' ? { done: 0.95 } : { tool: 'type', target: bio }],
    // Two typed parts around a line break, the way Jev composes multi-paragraph text.
    [/^Write .+ and .+ on two lines in the Bio/, (view) => {
        if (!typed(view, 'first')) { return { tool: 'type', target: bio, value: 'first' }; }
        if (!view.history.some(entry => entry.action === 'press_enter')) { return { tool: 'press_enter', target: bio }; }
        return typed(view, 'second') ? { done: 0.95 } : { tool: 'type', target: bio, value: 'second' };
    }],
    // Like the real model on a rich editor: alternates the two values and never presses Enter between them.
    [/^Write .+, then a blank line, then .+ in the Bio/, (view) => {
        if (bioValue(view) === `${view.values.first}\n\n${view.values.second}`) { return { done: 0.95 }; }
        const last = view.history.filter(entry => entry.action === 'type').at(-1)?.value;
        return { tool: 'type', target: bio, value: last === 'first' ? 'second' : 'first' };
    }],
    // Like the real model on a card board: first reaches for "Add card", which saves through the same request.
    [/^Open the Note card and replace its text/, (view) => {
        if (!clicked(view)) { return { tool: 'click', target: is('button', 'Add card') }; }
        const editor = find(view, is('textbox', 'Note text'));
        if (!editor) { return { tool: 'click', target: is('button', 'Note') }; }
        return editor.value === view.values.text ? { done: 0.95 } : { tool: 'type', target: is('textbox', 'Note text'), value: 'text' };
    }],
    // Like Jev with multi-script text: it cannot confirm an exact match by reading, only what code reports.
    [/^Set the Bio to exactly/, view => view.entered.bio ? { done: 0.95 } : { tool: 'type', target: bio, value: 'bio' }],
    // Like Jev when unsure: types the same value a second time before declaring the step done.
    [/^Set the Bio to .+ and make sure it took/, (view) => {
        const times = view.history.filter(entry => entry.action === 'type' && entry.value === 'bio').length;
        return times < 2 ? { tool: 'type', target: bio, value: 'bio' } : { done: 0.95 };
    }],
];

function act(view: View, step: string): Belief {
    const edit = EDITING.find(([pattern]) => pattern.test(step));
    if (edit) { return edit[1](view); }
    if (step.startsWith('Change Nickname')) {
        if (!typed(view, 'nickname')) { return { tool: 'type', target: is('textbox', 'Nickname'), value: 'nickname' }; }
        if (!typed(view, 'bio')) { return { tool: 'type', target: is('textbox', 'Bio'), value: 'bio' }; }
        return { done: 0.95 };
    }
    if (step.startsWith('Save the profile')) {
        if (view.notices.includes('Profile saved')) { return { done: 0.95 }; }
        // Like the real model, an error only counts once this step has clicked; a stale alert does not stop the attempt.
        if (clicked(view) && view.notices.some(notice => /Could not save/.test(notice))) { return { error: 0.95 }; }
        return { tool: clicked(view) ? 'wait' : 'click', target: is('button', /^(Save|Update) profile$/) };
    }
    const card = /^Customize the (Alpha|Beta) card/.exec(step);
    if (card) {
        return view.text.includes(`Customizing: ${card[1]!.toLowerCase()}`) ? { done: 0.95 } : { tool: 'click', target: is('button', `Customize ${card[1]!} card`) };
    }
    if (step.startsWith('Publish the page')) {
        // Like the real model: keeps choosing the obvious button even after a click on it was blocked.
        return view.notices.includes('Published') ? { done: 0.95 } : { tool: 'click', target: is('button', 'Publish') };
    }
    if (/^Put .+ in the Nickname field/.test(step)) {
        // A misstep seen on a real app: the text goes into a different field that saves the same way.
        const onTarget = view.history.some(entry => entry.action === 'type' && /"Bio"/.test(entry.element ?? '')) ? 0.05 : 0.95;
        return typed(view, 'nickname') ? { done: 0.95, onTarget } : { tool: 'type', target: is('textbox', 'Bio'), value: 'nickname', onTarget };
    }
    if (step.startsWith('Retitle the page to')) {
        // Like the real model on a real app: still sees nothing to do after being told nothing was saved.
        if (find(view, is('textbox', 'Page title'))?.value !== view.values.title) { return { tool: 'type', target: is('textbox', 'Page title'), value: 'title' }; }
        return view.notices.includes('Title saved') ? { done: 0.95 } : { done: 0.9, tool: 'none' };
    }
    if (step.startsWith('Rename the page to')) {
        // Like the real model: judges the step done once the field shows the name, unless told nothing was saved.
        if (find(view, is('textbox', 'Page title'))?.value !== view.values.title) { return { tool: 'type', target: is('textbox', 'Page title'), value: 'title' }; }
        if (view.notices.includes('Title saved')) { return { done: 0.95 }; }
        return view.history.some(entry => /not been saved/.test(entry.event ?? '')) ? { tool: 'press_enter', target: is('textbox', 'Page title') } : { done: 0.9, tool: 'none' };
    }
    const toggle = /^Turn (on|off) the (.+?) emails/.exec(step);
    if (toggle) {
        const wanted = toggle[1] === 'on' ? 'checked' : 'unchecked';
        const control = find(view, near('switch', toggle[2]!));
        return control?.state?.split(', ').includes(wanted) ? { done: 0.95 } : { tool: 'click', target: near('switch', toggle[2]!) };
    }
    if (step.startsWith('Start archiving the Beta plan')) {
        // Like the real model: without knowing that confirming is the next step, it presses on into the dialog.
        if (view.dialog) { return view.next ? { done: 0.95 } : { done: 0.2, tool: 'click', target: is('button', 'Archive plan') }; }
        return clicked(view) ? { done: 0.4 } : { tool: 'click', target: within('button', 'Archive', 'Beta plan') };
    }
    if (step.startsWith('Confirm archiving')) {
        return !view.dialog && clicked(view) ? { done: 0.95 } : { tool: 'click', target: is('button', 'Archive plan') };
    }
    if (/^Choose .+ as the display currency/.test(step)) {
        return find(view, is('combobox', 'Display currency'))?.value === view.values.currency ? { done: 0.95 } : { tool: 'select', target: is('combobox', 'Display currency'), value: 'currency' };
    }
    if (step.startsWith('Save the currency')) {
        return view.notices.includes('Currency saved') ? { done: 0.95 } : { tool: 'click', target: is('button', 'Save currency') };
    }
    return { done: 0.03, tool: 'none' };
}

function claim(view: View, text: string): Belief {
    const verdict = (holds: boolean): Belief => holds ? { holds: 0.95, support: 'supports' } : { holds: 0.04, support: 'contradicts' };
    const nickname = /^The Nickname field shows "(.+)"$/.exec(text);
    if (nickname) { return verdict(find(view, is('textbox', 'Nickname'))?.value === nickname[1]); }
    if (/Beta plan is shown as Archived/.test(text)) { return verdict(/Beta plan\W+Archived/.test(view.text)); }
    if (/amount in euros/.test(text)) { return verdict(view.text.includes('€')); }
    return { holds: 0.5, support: 'not_shown' };
}

/** Reproduce the real model's premature no-action answer while deferred controls are still loading. */
export function deferredPolicy(view: View): Belief {
    return view.notices.includes('Workspace ready') ? { done: 0.95 }
        : view.elements.some(is('button', 'Open workspace')) ? { tool: 'click', target: is('button', 'Open workspace') }
            : view.history.some(entry => entry.action === 'wait') ? { tool: 'none' } : { tool: 'wait' };
}
