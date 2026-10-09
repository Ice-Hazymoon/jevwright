import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';

/**
 * Small multi-page app with the UI patterns of the real product (dirty-state Save, toasts,
 * generically labelled switches, same-named row actions behind a confirm dialog, native selects)
 * and opt-in defects selected by `?bug=` (`relabel` is a harmless redesign, not a defect).
 */
export interface FixtureState {
    profile: { nickname: string; bio: string };
    settings: Record<string, boolean>;
    items: Array<{ id: string; name: string; archived: boolean }>;
    currency: string;
    /** `?bug=fail-once`: the first profile save has already failed. */
    failedOnce: boolean;
    customizing: string | null;
    title: string;
    published: number;
    board: Array<{ title: string; text: string }>;
    prices: number;
    requests: Array<{ method: string; path: string }>;
}

export function initialState(): FixtureState {
    return {
        profile: { nickname: 'Ada', bio: 'Original bio' },
        settings: { news: true, digest: false, security: true },
        items: [{ id: 'a', name: 'Alpha plan' }, { id: 'b', name: 'Beta plan' }, { id: 'c', name: 'Gamma plan' }].map(item => ({ ...item, archived: false })),
        currency: 'USD',
        failedOnce: false,
        customizing: null,
        title: 'Untitled page',
        published: 0,
        board: [{ title: 'Note', text: 'Draft A' }],
        prices: 0,
        requests: [],
    };
}

const style = '<style>body{font-family:sans-serif;margin:24px} .toast{position:fixed;right:16px;bottom:16px;background:#222;color:#fff;padding:8px 12px} label{display:block;margin-top:12px}</style>';

function layout(title: string, body: string, script = ''): string {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>${style}</head><body>
<nav aria-label="Sections"><a href="/profile">Profile</a> <a href="/settings">Settings</a> <a href="/items">Plans</a> <a href="/currency">Currency</a></nav>
<main><h1>${title}</h1>${body}</main><div role="status" id="status"></div>
<script>
const toast = (text) => { const s = document.getElementById('status'); s.textContent = text; };
const send = (path, body) => fetch(path + location.search, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
${script}
</script></body></html>`;
}

function escapeHtml(text: string): string {
    return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
}

function pages(state: FixtureState, url: URL): string | undefined {
    const bug = url.searchParams.get('bug');
    switch (url.pathname) {
        case '/fresh-edit':
            return layout('Entry draft', `<label>Alias<input id="alias" value="Initial"></label><label>Notes<textarea id="notes"></textarea></label>${url.searchParams.has('mirror') ? '<div id="mirror" style="white-space:pre-wrap"></div>' : ''}<button id="commit">Commit entry</button><output id="commits">0</output>${url.searchParams.has('keypress') ? '<output id="keys">0</output>' : ''}${bug ? '<div role="alert" data-type="warning">Review delivery preferences</div><div id="error"></div>' : ''}`, `
${url.searchParams.has('mirror') ? 'document.getElementById(\'notes\').oninput = () => { document.getElementById(\'mirror\').textContent = document.getElementById(\'notes\').value; };' : ''}
${url.searchParams.has('keypress') ? `document.getElementById('notes').addEventListener('keydown', (event) => { if (event.key === 'Enter') document.getElementById('keys').textContent = String(Number(document.getElementById('keys').textContent) + 1); });` : ''}
${url.searchParams.has('delay') ? `let editTimer; document.getElementById('notes').addEventListener('input', () => { clearTimeout(editTimer); editTimer = setTimeout(() => send('/api/profile', { nickname: document.getElementById('alias').value, bio: document.getElementById('notes').value }), 2400); });` : ''}
document.getElementById('commit').onclick = async () => { document.getElementById('commits').textContent = String(Number(document.getElementById('commits').textContent) + 1); ${bug ? `await send('/api/profile', { nickname: document.getElementById('alias').value, bio: document.getElementById('notes').value }); ${bug === 'new-error' ? 'document.getElementById("error").innerHTML = \'<div role="alert">Entry failed validation</div>\';' : ''}` : ''}${url.searchParams.has('clear') ? 'document.getElementById("alias").value = ""; document.getElementById("notes").value = "";' : ''} };
`);
        case '/fresh-reserved-choice':
            return layout('Entry draft', `<button id="browse">${url.searchParams.has('joined') ? 'Browse entries and drafts' : 'Browse entries'}</button><div id="choice" role="${['deferred', 'initiation'].includes(bug ?? '') ? 'dialog' : 'alertdialog'}" aria-label="Abandon entry?" hidden>${bug === 'initiation' ? '<label>Read the details<input id="ack" type="checkbox"></label>' : ''}<button id="stay">Stay on draft</button><button id="discard">Discard draft</button></div><output id="choices">0</output>`, `
document.getElementById('browse').onclick = () => document.getElementById('choice').hidden = false;
document.getElementById('stay').onclick = () => { document.getElementById('choices').textContent = String(Number(document.getElementById('choices').textContent) + 1); document.getElementById('choice').hidden = true; };
document.getElementById('discard').onclick = () => document.querySelector('main').innerHTML = '<h1>Entries</h1>';
`);
        case '/fresh-paragraphs':
            return layout('Document draft', `<div id="draft" role="textbox" aria-label="Draft" contenteditable="true"><p>${bug ? `Opening passage</p>${bug === 'empty' ? '<p><br></p>' : ''}<p>Final passage` : '<br>'}</p></div>`, `
const draft = document.getElementById('draft');
const caret = () => { const range = document.createRange(); range.selectNodeContents(draft.lastElementChild); range.collapse(false); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); };
draft.oninput = () => { let changed = false; for (const node of [...draft.childNodes]) { if (node.nodeType === Node.TEXT_NODE || node.nodeName === 'DIV') { const p = document.createElement('p'); p.textContent = node.textContent; node.replaceWith(p); changed = true; } }
if (!draft.children.length) { draft.innerHTML = '<p><br></p>'; changed = true; }
for (const p of [...draft.children]) { if (p.textContent.includes('\\n')) { const parts = p.textContent.split('\\n').map(text => { const block = document.createElement('p'); block.textContent = text; if (!text) block.append(document.createElement('br')); return block; }); p.replaceWith(...parts); changed = true; } }
if (changed) caret(); };
`);
        case '/fresh-dialog-transition':
            return layout('Entry workspace', '<h2>Entries</h2><div role="dialog" aria-label="Edit entry"><label>Alias<input value="Pending"></label><button>Cancel edit</button></div>');
        case '/fresh-effects':
            return layout('Entry workspace', '<label>Alias<input id="alias" value="Initial"></label><button id="open">Open preferences</button><button id="save">Store entry</button><div id="panel"></div><section aria-label="Feedback"><div aria-live="polite" style="position:absolute;width:1px;height:1px;overflow:hidden"></div><div id="feedback" style="position:fixed;right:20px;top:20px"></div></section>', `
document.getElementById('save').onclick = () => { document.querySelector('[aria-live]').textContent = 'Entry stored'; document.getElementById('feedback').innerHTML = '<h3>Entry stored</h3><button>Dismiss message</button>'; document.getElementById('panel').innerHTML = '<h2>Stored entry</h2><button>…R4M7</button><button aria-label="Row actions">Entry …R4M7</button>'; };
document.getElementById('open').onclick = () => { document.getElementById('panel').innerHTML = '<h2>Preferences</h2><label>Handle<input value="user-4928abcd"></label><button role="switch" aria-checked="true">Receive updates</button>'; document.getElementById('alias').value = 'Server refreshed'; };
`);
        case '/fresh-navigation':
            return layout('Editing entry', '<label>Alias<input value="Initial"></label><div role="alertdialog" aria-label="Leave entry"><button id="discard">Discard edits</button></div>', `
document.getElementById('discard').onclick = () => { document.querySelector('[role=alertdialog]').remove(); history.pushState({}, '', '/fresh-navigation?view=activity'); document.querySelector('main').setAttribute('aria-busy', 'true'); setTimeout(() => { document.querySelector('main').innerHTML = '<h1>Activity</h1><button>Open entry</button>'; document.querySelector('main').removeAttribute('aria-busy'); }, 600); };
`);
        case '/fresh-section':
            return layout('Entry settings', '<button id="expand" aria-expanded="false">Rates</button><section id="rates" hidden><h2>Rates</h2><button id="add">Add rate</button></section><div role="dialog" aria-label="New rate" hidden><label>Amount<input type="number"></label><button>Store rate</button></div>', `
document.getElementById('expand').onclick = () => { document.getElementById('expand').setAttribute('aria-expanded', 'true'); document.getElementById('rates').hidden = false; };
document.getElementById('add').onclick = () => document.querySelector('[role=dialog]').hidden = false;
`);
        case '/fresh-loading':
            return layout('Delivery workspace', `<section ${bug === 'stale' ? 'aria-busy="true"' : ''}><h2>Delivery details</h2><p>Parcel ready</p><div role="status"><span hidden>Loading pending requests</span>Nothing pending</div><div aria-live="off">Processing instructions</div></section>`);
        case '/completion-gestures':
            return layout('Item gestures', '<button id="hold">Hold item</button><output id="held">Ready</output><button id="inspect">Inspect item</button><output id="inspected">Ready</output>', `
let down = 0; document.getElementById('hold').onpointerdown = () => { down = Date.now(); };
document.getElementById('hold').onpointerup = () => { if (Date.now() - down >= 600) document.getElementById('held').textContent = 'Held'; };
document.getElementById('inspect').ondblclick = () => { if (!location.search.includes('missing')) document.getElementById('inspected').textContent = 'Inspected'; };
`);
        case '/completion-picker':
            return layout('Reservation workshop', '<p>Reserve August 4, 2027. Use the calendar, then confirm the reservation.</p><form aria-label="Reservation"><label>Selected date<input id="date" readonly></label><button type="button" id="calendar">Choose date</button><div id="picker" role="dialog" aria-label="Calendar" hidden><h2 id="month">June 2027</h2><button type="button" id="next">Next month</button><button type="button" id="day" hidden>4</button></div><button type="button" id="confirm">Confirm reservation</button></form><output id="receipt"></output><output id="activations">0</output>', `
let month = 0; const months = ['June 2027', 'July 2027', 'August 2027'];
document.getElementById('calendar').onclick = () => document.getElementById('picker').hidden = false;
document.getElementById('next').onclick = () => { month = Math.min(month + 1, 2); document.getElementById('month').textContent = months[month]; document.getElementById('day').hidden = month !== 2; };
document.getElementById('day').onclick = () => { document.getElementById('date').value = '2027-08-04'; document.getElementById('picker').hidden = true; document.getElementById('calendar').hidden = true; };
document.getElementById('confirm').onclick = () => { document.getElementById('activations').textContent = String(Number(document.getElementById('activations').textContent) + 1); if (document.getElementById('date').value && ${JSON.stringify(bug)} !== 'missing') document.getElementById('receipt').textContent = 'Reservation confirmed'; };
`);
        case '/completion-calendar':
            return layout('Reservation desk', '<p>Reserve August 4, 2027.</p><form aria-label="Reservation"><label>Date<output id="date"></output></label><button type="button" id="calendar">Open calendar</button><div id="picker" role="dialog" aria-label="August 2027" hidden><h2>August 2027</h2><button type="button" id="day">4</button></div><button type="button" id="confirm">Confirm reservation</button></form><output id="receipt"></output>', `
document.getElementById('calendar').onclick = () => document.getElementById('picker').hidden = false;
document.getElementById('day').onclick = () => { document.getElementById('date').value = '2027-08-04'; document.getElementById('picker').hidden = true; };
document.getElementById('confirm').onclick = () => { if (document.getElementById('date').value && ${JSON.stringify(bug)} !== 'missing') document.getElementById('receipt').textContent = 'Reservation confirmed'; };
`);
        case '/completion-list':
            return layout('Saved entries', `<button id="save">Save entry</button><button id="browse" aria-pressed="true">Browse</button><button id="tab" aria-pressed="false">Saved entries (0)</button><section id="panel"><h2>Browse</h2><p>Field notes</p></section>${['review', 'fallback'].includes(bug ?? '') ? '<output id="receipt" role="status" hidden></output>' : ''}${url.searchParams.has('checked') ? '<label>Digest notices<input id="digest" type="checkbox" checked></label>' : ''}${url.searchParams.has('search') ? '<input id="search" type="search" aria-label="Search entries">' : ''}`, `
document.getElementById('save').onclick = () => { document.getElementById('save').textContent = 'Saved'; document.getElementById('tab').textContent = 'Saved entries (1)'; const receipt = document.getElementById('receipt'); if (receipt) { receipt.hidden = false; receipt.textContent = 'Entry stored'; } };
document.getElementById('tab').onclick = () => { document.getElementById('browse').setAttribute('aria-pressed', 'false'); document.getElementById('tab').setAttribute('aria-pressed', 'true'); document.getElementById('panel').innerHTML = ${JSON.stringify(bug === 'empty' || url.searchParams.has('empty') ? '<h2>Saved entries</h2><p>No entries</p>' : '<h2>Saved entries</h2><p>Field notes</p>')}; };
`);
        case '/integrity-audit':
            return layout('Draft editor', '<label>Draft<input id="draft"></label><label>Reference<input id="reference"></label><button id="store">Store draft</button>', `document.getElementById('store').onclick = () => send('/api/draft-validation', { draft: document.getElementById('draft').value });`);
        case '/compatibility-scroller':
            return layout('Scrollable workspace', `<div style="height:80px;overflow-y:auto"><p>${'Reference content '.repeat(150)}Final visible record</p></div>`);
        case '/proof-panel':
            return layout('Message workspace', '<label>Message body<textarea>First passage\n\nFinal passage</textarea></label><button>Open delivery Amber package</button><p>Receipt issued 2027-08-04 09:32</p><button>Copy receipt value</button>');
        case '/paragraph-card':
            return layout('Read-only message', `<button aria-label="Message">${bug === 'inline' ? '<span>Opening passage</span> <span>Final passage</span>' : '<p>Opening passage</p><p>Final passage</p>'}</button>`);
        case '/disabled-captions':
            return layout('Pending actions', '<button disabled>Store settings</button><button disabled>Send invitation</button>');
        case '/proof-dialog-exit':
            return layout('Draft workspace', '<label>Draft<input value="Original"></label><dialog open aria-label="Leave editor"><button>Keep writing</button></dialog>');
        case '/volatile-proof-row':
            return layout('Deliveries', '<div role="button">REF-8AZ34JXY Amber package 2027-08-04</div>');
        case '/contextual-proof':
            return layout('Delivery overview', `<article><h2>Amber parcel</h2>${bug === 'clipped-id' ? '<p>Reference …X7K9</p>' : ''}<p>Status: ${bug === 'moved' ? 'Waiting' : 'Ready'}</p><p>Owner: ${bug === 'owner-moved' ? 'Editor' : 'Inspector'}</p></article>${bug === 'nearby-time' ? '<p data-time>Reviewed 2027-08-04 09:32</p>' : ''}<article><h2>Sage parcel</h2><p>Status: ${bug === 'moved' ? 'Ready' : 'Waiting'}</p><p>Owner: ${bug === 'owner-moved' ? 'Inspector' : 'Editor'}</p></article><p>${'Unrelated information '.repeat(100)}</p><p>Checked 2027-08-04 09:32</p>`);
        case '/proof-label-overlap':
            return layout('Publishing workspace', '<button>Publish</button><button>Unpublish</button>');
        case '/compatibility-editor':
            return layout('Writing workspace', `<section aria-label="Writing area"><div contenteditable="true" role="textbox" aria-label="Document"><p>First passage</p><p><br></p><p>Final passage</p></div></section>${bug === 'spaced' ? '<style>p{margin:24px 0}</style>' : ''}`);
        case '/integrity-region':
            return layout('Draft workspace', `<section aria-label="${bug === 'moved' ? 'Review area' : 'Draft area'}"><label>Draft<input value="Original"></label></section>`);
        case '/integrity':
            return layout('Request workspace', '<label>Draft<input id="draft" value="Original"></label><button id="save">Save draft</button><button id="toggle" aria-expanded="false">Details</button><div id="receipt"></div><div id="error"></div>', `
                const bug = ${JSON.stringify(bug)};
                if (bug === 'existing-notice') document.getElementById('error').innerHTML = '<p role=\"status\">Reference notice</p>';
                if (bug === 'counter') document.getElementById('toggle').textContent = 'Count 1';
                if (bug === 'negative-control') document.getElementById('error').innerHTML = '<button id="forbidden" hidden>Delete draft</button>';
                if (bug === 'evidence-noise') document.getElementById('error').innerHTML = '<h2>Other records</h2><p>' + 'Other content '.repeat(250) + '</p><a href="/items">Unrelated navigation</a>';
                document.getElementById('toggle').onclick = e => { if (bug !== 'state') e.target.setAttribute('aria-expanded', 'true'); };
                document.getElementById('save').onclick = async () => {
                    if (bug === '500') await fetch('/api/integrity', { method: 'POST' });
                    if (bug === '422' || bug === 'validation') await fetch('/api/integrity-validation', { method: 'POST' });
                    if (bug === 'validation') document.getElementById('error').innerHTML = '<p role="alert" class="field-error">Required input missing</p>';
                    if (bug === 'alert') document.getElementById('error').innerHTML = '<p role="alert">Request rejected</p>';
                    if (bug === 'shadow-alert') { const host = document.createElement('div'); document.body.append(host); host.attachShadow({ mode: 'closed' }).innerHTML = '<p role=alert>Request rejected</p>'; }
                    if (bug === 'frame-alert') { const frame = document.createElement('iframe'); frame.srcdoc = '<p role=alert>Request rejected</p>'; document.body.append(frame); }
                    if (bug === 'hidden-alert') document.getElementById('error').innerHTML = '<p role=alert style=visibility:hidden>Decorative error</p>';
                    if (bug === 'existing-notice') document.getElementById('error').innerHTML = '<p role=\"alert\" data-type=\"error\">Reference notice</p>';
                    if (bug === 'info') document.getElementById('error').innerHTML = '<p role="alert">Settings apply to future entries.</p>';
                    if (bug === 'warning') document.getElementById('error').innerHTML = '<p role="alert" data-state="warning">Existing entries keep their original limits.</p>';
                    if (bug === 'status') document.getElementById('error').innerHTML = '<div data-sonner-toaster><h3>Draft saved</h3><button>Dismiss notification</button></div><p aria-live="polite">Updated moments ago</p>';
                    if (bug === 'counter') { document.getElementById('toggle').textContent = 'Count 2'; document.getElementById('toggle').setAttribute('aria-expanded', 'true'); }
                    if (bug === 'invalid') document.getElementById('draft').setAttribute('aria-invalid', 'true');
                    if (bug !== 'missing') document.getElementById('receipt').innerHTML = '<h2>Draft stored</h2><h3>Receipt 42</h3>';
                    if (bug === 'half') document.querySelector('h3').remove();
                    if (bug === 'query') history.replaceState({}, '', '?view=other');
                };
            `);
        case '/attribution-regions': {
            const region = url.searchParams.get('region') ?? 'loading';
            const content = `<section aria-label="Delivery records"${['slow', 'stuck'].includes(url.searchParams.get('resolve') ?? '') ? ' aria-busy="true"' : ''}><p>${region === 'loading' ? 'Fetching records…' : region === 'empty' ? 'Nothing has arrived' : 'Record ZX-71'}</p></section>`;
            return layout('Dispatch workspace', region === 'collapsed' ? `<details><summary>Delivery records</summary>${content}</details>` : region === 'unselected' ? `<div role="tablist"><button role="tab" aria-selected="true">Overview</button><button role="tab" aria-selected="false">Delivery records</button></div><section aria-label="Overview">Welcome</section><div hidden>${content}</div>` : content, url.searchParams.has('resolve') && url.searchParams.get('resolve') !== 'stuck' ? `setTimeout(() => { document.querySelector('section p').textContent = 'Record ZX-71'; document.querySelector('section').removeAttribute('aria-busy'); }, ${url.searchParams.get('resolve') === 'slow' ? 21000 : 1200});` : '');
        }
        case '/attribution-segments':
            return layout('Access challenge', `<p>Access sequence: 681942</p><div>${Array.from({ length: 6 }, (_, i) => `<input aria-label="Segment ${i + 1}" maxlength="1" autocomplete="one-time-code">`).join('')}</div><output id="result"></output>`, `const fields = [...document.querySelectorAll('input')]; fields.forEach((field, i) => field.oninput = () => { if (field.value && i < fields.length - 1) fields[i + 1].focus(); if (fields.map(f => f.value).join('') === '681942') { document.getElementById('result').textContent = 'Access granted'; fields.forEach(f => f.remove()); } });`);
        case '/attribution-sort':
            return layout('Entry amounts', '<label>Ordering<select><option>Original</option><option>Amount ascending</option></select></label><section aria-label="Entries"><p>Amber: 40</p><p>Cedar: 10</p><p>Birch: 25</p></section>');
        case '/attribution-retained-entry':
            return layout('Entry directory', '<ul><li><span>Retired entry</span><button>Remove</button></li><li><span>Current entry</span></li></ul><output></output>', `document.querySelector('button').onclick = () => document.querySelector('output').textContent = 'Removal requested';`);
        case '/hardening-visibility':
            return layout('Visibility overrides', '<section style="visibility:hidden"><button style="visibility:visible" aria-label="Preview"><span>Visible inner draft</span></button><p>Hidden branch</p></section><div style="visibility:collapse">Collapsed branch</div><p style="opacity:0">Transparent branch</p>');
        case '/hardening-slotted-content':
            return layout('Component previews', '<div id="component" role="button" tabindex="0" aria-label="Preview"><span slot="copy">Slotted draft</span><span slot="hidden" style="display:contents">Hidden slotted draft</span></div>', `document.getElementById('component').attachShadow({mode:'closed'}).innerHTML = '<div><slot name="copy">Unused fallback</slot><div style="display:none"><slot name="hidden"></slot></div></div>';`);
        case '/hardening-visible-content':
            return layout('Account overview', '<div role="button" tabindex="0" aria-label="Note"><div style="display:contents"><div inert><p>Working draft</p><button>Preview action</button></div></div></div><button aria-label="Note"><span style="display:contents">Revised draft</span></button><p style="display:contents">The subscription renews monthly.</p><p>Unit price: <span>$17.43</span></p><table><tr><th>Revenue</th><td>$69.72</td></tr><tr><th>Average</th><td>$17.43</td></tr></table><div role="alert"><p>This account is still in use.</p></div><div style="height:0;overflow:hidden" inert><p>Hidden price $999.99</p></div><p hidden>Hidden paragraph</p><span style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)">Screen reader text</span>', url.searchParams.has('chrome') ? `document.querySelector('nav').append(document.createTextNode('Section description '.repeat(300)));` : '');
        case '/hardening-cards':
            return layout('Catalog cards', Array.from({ length: Number(url.searchParams.get('count') ?? 60) }, (_, i) => `<div class="card" style="cursor:pointer;padding:6px;margin:2px;border:1px solid"><span>Product ${i}</span></div>`).join(''), `document.querySelectorAll('.card').forEach((card, i) => card.onclick = () => toast('Opened ' + i));`);
        case '/hardening-hover':
            return layout('Hover surfaces', '<style>.row:hover span{opacity:.8}.menu:hover .submenu{visibility:visible}.submenu{visibility:hidden}</style><div class="row"><span>Decorated row</span></div><div class="menu"><span>Workspace tools</span><div class="submenu"><button>Invite</button></div></div>');
        case '/hardening-table':
            return layout('Profile ledger', `<style>tr:hover{background:#eee}.hover\\:bg:hover{color:blue}</style><label>Name<input id="name"></label><button id="save"><span>Save</span></button><a href="#help">Help</a><img width="24" height="24" alt="Brand" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><div id="decoration"></div><table>${Array.from({ length: Number(url.searchParams.get('rows') ?? 120) }, (_, i) => `<tr class="hover:bg">${Array.from({ length: Number(url.searchParams.get('cols') ?? 5) }, (_, c) => `<td>Entry ${i} column ${c}</td>`).join('')}</tr>`).join('')}</table>`, `document.getElementById('save').onclick = () => { toast('Profile stored'); document.getElementById('decoration').innerHTML = '<div class="avatar skeleton" style="width:20px;height:20px"></div>'; };`);
        case '/hardening-commit':
            return layout('Public deployment', '<label>Visibility<select id="visibility"><option>Private</option><option>Public</option></select></label><button id="apply">Apply changes</button><output id="result">Deployment private</output>', `document.getElementById('apply').onclick = () => document.getElementById('result').textContent = 'Deployment ' + document.getElementById('visibility').value.toLowerCase();`);
        case '/hardening-literal':
            return layout('Contact details', '<label>Contact address<input id="contact"></label>');
        case '/hardening-shipping':
            return layout('Delivery options', '<label>Shipping<select id="shipping"><option>Standard</option><option>Express</option></select></label><button id="order">Place order</button><output id="orders">0</output>', `document.getElementById('order').onclick = () => document.getElementById('orders').textContent = String(Number(document.getElementById('orders').textContent) + 1);`);
        case '/hardening-cart':
            return layout('Basket summary', '<span>Cart (1)</span><div role="status">Added to cart</div>');
        case '/hardening-scroll':
            return layout('Shell scroll', `<style>html,body{height:100%;margin:0;overflow:hidden}nav{display:none}main{height:100%}#app{height:100%;overflow:auto}</style><div id="app">${Array.from({ length: 200 }, (_, i) => `<div style="height:40px">Row ${i}</div>`).join('')}</div>`);
        case '/hardening-page-history':
            return layout('Observed token', `<p>Access token: ${escapeHtml(url.searchParams.get('token') ?? 'HS-4127')}; enter it below.</p><label>Code<input></label>`);
        case '/hardening-page-input':
            return layout('Page entries', `<p>Token: ${url.searchParams.get('token') ?? '2'}; enter the token.</p><label>Address line 2<input></label><label>ABC1234<input></label>`);
        case '/integration-counter':
            return layout('Batch totals', '<p>Unit price: 7</p><div><span>Documents</span><button id="minus">-</button><span id="quantity">1</span><button id="plus">+</button></div><output id="total">7</output>', `
let quantity = 1; document.getElementById('plus').onclick = () => { quantity++; document.getElementById('quantity').textContent = String(quantity); document.getElementById('total').textContent = String(${bug ? '7' : 'quantity * 7'}); };
`);
        case '/integration-secrets':
            return layout('Credential purposes', '<label>Email<input id="email" type="email"></label><label>Password<input id="password" type="password"></label><label>New credential<input id="credential" autocomplete="new-password"></label><div role="textbox" aria-label="API key" contenteditable="true"></div>');
        case '/integration-static':
            return layout('Stable surface', `<p>Processing fee</p><div class="ui-spinner">Decoration</div><div role="progressbar" aria-valuenow="75">75%</div><button><span>Save</span></button><button>Cancel</button>${Array.from({ length: 120 }, (_, i) => (url.searchParams.has('aria') ? `<table role="table"><tr role="row"><td role="cell">Entry ${i}</td><td role="cell">Amount ${i}</td></tr></table>` : `<table><tr><td>Entry ${i}</td><td>Amount ${i}</td></tr></table>`)).join('')}`);
        case '/integration-pointer':
            return layout('Pointer targets', Array.from({ length: 60 }, (_, i) => `<span style="cursor:pointer">Pointer ${i}</span>`).join(' '));
        case '/integration-groups':
            return layout('Semantic groups', '<div draggable="true">Packet</div><div style="border-top:1px solid"><span>Decoration</span><button>Unrelated</button></div><section aria-label="Ready"><h2>Ready</h2><div style="cursor:grab">Draft packet</div></section>');
        case '/integration-shadow':
            return layout('Shadow animation', '<div id="host"></div>', `
const root = document.getElementById('host').attachShadow({mode:'closed'}); root.innerHTML = '<div id="animated">Stable</div><time id="clock">12:00:00</time><div id="content">Initial</div>'; window.fixtureRoot = root;
let tick = 0; setInterval(() => { tick++; root.getElementById('animated').style.transform = 'rotate(' + tick + 'deg)'; root.getElementById('clock').textContent = '12:00:' + String(tick % 60).padStart(2,'0'); }, 30);
`);
        case '/integration-controls':
            return layout('Controlled lists', '<input role="combobox" aria-label="Category" aria-controls="description first second"><p id="description">Choose a category</p><div id="first" role="listbox"><div role="option">Hardware</div></div><div id="second" role="listbox"><div role="option" onclick="toast(&quot;Selected software&quot;)">Software</div></div>');
        case '/reach-observe':
            return layout('Surface controls', '<style>.menu:hover #submenu{display:block}#submenu{display:none}.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}</style><div class="menu"><span>Workspace</span><div id="submenu"><button>Invite member</button></div></div><div id="closed"></div><div contenteditable="true" aria-label="Draft"></div><button aria-label="Discard"><span class="sr">Ignore this</span>Publish draft</button><div><span>Budget</span><input aria-label="Memo"></div><div aria-label="Activity" style="height:100px;overflow:auto"><div style="height:1200px">Earlier activity</div></div><p style="margin-top:1400px">End notes</p>', `
const root = document.getElementById('closed').attachShadow({mode:'closed'});
root.innerHTML = '<div id="nested"></div>';
root.getElementById('nested').attachShadow({mode:'closed'}).innerHTML = '<label>Member<input></label><button>Grant</button>';
window.fixtureRoot = root;
window.rootStillClosed = document.getElementById('closed').shadowRoot === null;
`);
        case '/surface-editor':
            return layout('Document formatting', `<label>Message<textarea id="message">ship confirmed</textarea></label><div contenteditable="true" aria-label="Document" id="editor" style="min-height:80px;border:1px solid;padding:12px"></div><button id="bold">Bold</button><div role="button" tabindex="0" aria-label="Close tools">Open tools</div><label>Receive alerts<input type="checkbox" aria-label="Cancel alerts"></label><button id="inspect">Inspect document</button>${url.searchParams.has('private') ? '<label>Access password<input id="protected" type="password" value="Fixture-hidden-password-9462"></label>' : ''}${url.searchParams.has('uploads') ? '<label>Documents<input id="files" type="file" multiple></label>' : ''}`, `
document.getElementById('bold').onmousedown = e => e.preventDefault();
document.getElementById('bold').onclick = () => { if (${JSON.stringify(bug)} !== 'missing-format') document.execCommand('bold'); };
document.getElementById('inspect').onclick = () => toast(document.getElementById('editor').innerHTML);
document.getElementById('files')?.addEventListener('change', e => toast([...e.target.files].map(file => file.name).join(',')));
`);
        case '/surface-events':
            return layout('Delegated workspace', '<section aria-label="Documents"><span id="react-file">ledger.csv</span> <span id="vue-file">schedule.csv</span> <span id="native-file">letter.csv</span></section><button id="rename" hidden>Rename document</button><div style="display:flex;gap:50px"><div id="parcel" draggable="true">Package</div><div id="drop" data-testid="receiving-bay" style="border:2px solid;padding:35px">Receiving bay</div><div id="task" style="padding:20px">Review draft</div><div data-testid="queue" id="queue" style="padding:35px;border:2px solid"><h2>Completed</h2></div><div id="empty" style="width:40px;height:40px;background:teal"></div></div>', `
if (location.search.includes('root')) { const root = document.querySelector('main'); root.__reactContainer$fixture = {}; for (const type of ['click','pointerdown','pointermove','pointerup','dragstart','dragover','drop','contextmenu']) root.addEventListener(type, () => {}); }
let selectedFile; const menu = e => { e.preventDefault(); selectedFile = e.target; document.getElementById('rename').hidden = false; };
document.getElementById('react-file').__reactProps$fixture = { onContextMenu: menu };
document.getElementById('vue-file')._vei = { onContextmenu: menu };
document.getElementById('native-file').addEventListener('contextmenu', menu);
document.querySelector('main').addEventListener('contextmenu', e => { if(e.target.id === 'react-file' || e.target.id === 'vue-file') menu(e); });
document.getElementById('rename').onclick = () => { selectedFile.textContent = selectedFile.textContent.replace('.csv', '-renamed.csv'); document.getElementById('rename').hidden = true; toast('Document renamed'); };
const parcel = document.getElementById('parcel'); parcel.addEventListener('dragstart', e => e.dataTransfer.setData('text/plain', 'package'));
const drop = document.getElementById('drop');
if (location.search.includes('long-drop')) drop.textContent = 'x'.repeat(70) + 'private-sequence-829173';
drop.__reactProps$fixture = { onDragOver: e => e.preventDefault(), onDrop: e => { e.preventDefault(); if(e.dataTransfer.getData('text/plain') === 'package' && !location.search.includes('no-drop')) { drop.append(parcel); toast('Package received'); } } };
document.querySelector('main').addEventListener('dragover', e => { if(drop.contains(e.target)) drop.__reactProps$fixture.onDragOver(e); });
document.querySelector('main').addEventListener('drop', e => { if(drop.contains(e.target)) drop.__reactProps$fixture.onDrop(e); });
const task = document.getElementById('task'); let start, moves = 0;
task._vei = { onPointerdown: e => { start = [e.clientX,e.clientY]; moves = 0; task.setPointerCapture(e.pointerId); } };
task.addEventListener('pointerdown', task._vei.onPointerdown);
task.addEventListener('pointermove', e => { if(start && Math.hypot(e.clientX-start[0],e.clientY-start[1]) > 8) moves++; });
task.addEventListener('pointerup', e => { const b = document.getElementById('queue').getBoundingClientRect(); if(start && moves >= 2 && e.clientX > b.left && e.clientX < b.right && e.clientY > b.top && e.clientY < b.bottom) { document.getElementById('queue').append(task); toast('Review completed'); } start = null; });
`);
        case '/surface-labels':
            return layout('Visible field labels', '<p>Enter 17.25 in Cost, leave Description empty, then Store entry.</p><label for="cost">Cost</label><input id="cost" aria-label="Description"><label for="description">Description</label><input id="description" aria-label="Cost"><button id="store" aria-label="Discard entry">Store entry</button><label>Filter entries<input id="filter"></label><p>Notebook</p>', `
document.getElementById('store').onclick = () => toast(document.getElementById('cost').value === '17.25' && !document.getElementById('description').value ? 'Entry stored' : 'Could not store entry');
document.getElementById('filter').oninput = e => history.replaceState(null,'','?q='+e.target.value);
`);
        case '/surface-replacement':
            return layout('Replacing controls', '<button id="replace">Add entry</button><output id="count">0</output>', `
document.getElementById('replace').onclick = e => { document.getElementById('count').textContent = Number(document.getElementById('count').textContent)+1; const button = document.createElement('button'); button.textContent = 'Entry added'; e.target.replaceWith(button); toast('Entry added'); };
`);
        case '/surface-search':
            return layout('Archive search', '<p>Find Special entry (record 812) in the archive.</p><div id="archive" aria-label="Archive" style="height:240px;overflow:auto"><div id="spacer" style="height:30000px;position:relative"></div></div>', `
const archive = document.getElementById('archive'); const draw = () => { const n = Math.floor(archive.scrollTop/30); document.getElementById('spacer').innerHTML = Array.from({length:10},(_,i) => '<div style="position:absolute;top:'+(n+i)*30+'px">Record '+(n+i+1)+(n+i===811 ? ' — Special entry<button onclick="toast(\\'Entry opened\\')">Open entry</button>' : '')+'</div>').join(''); }; archive.addEventListener('scroll',draw); draw();
`);
        case '/reach-actions':
            return layout('Gestures', '<button id="hold">Hold action</button><button id="double">Open twice</button><div id="file">notes.txt</div><button id="rename" hidden>Rename file</button><label>Documents<input id="files" type="file" multiple></label><div style="display:flex;gap:60px"><div draggable="true" id="source">Parcel</div><div id="drop" style="padding:40px;border:1px solid">Receiving area</div><div id="pointer" style="cursor:grab;padding:20px">Task</div><div id="destination" style="padding:40px;border:1px solid">Finished</div></div><a href="/reach-details">View details</a><p id="end" style="margin-top:1600px">End notes</p><output id="events"></output>', `
const events = document.getElementById('events'); const note = text => events.textContent += text + '|';
const hold = document.getElementById('hold'); let timer;
hold.onpointerdown = () => timer = setTimeout(() => note('held'), 600);
hold.onpointerup = () => clearTimeout(timer);
document.getElementById('double').ondblclick = () => note('twice');
document.getElementById('file').oncontextmenu = e => { e.preventDefault(); document.getElementById('rename').hidden = false; };
document.getElementById('rename').onclick = () => note('renamed');
document.getElementById('files').onchange = e => note([...e.target.files].map(f => f.name).join(','));
document.getElementById('source').ondragstart = e => e.dataTransfer.setData('text/plain','parcel');
document.getElementById('drop').ondragover = e => e.preventDefault();
document.getElementById('drop').ondrop = e => { e.preventDefault(); if(e.dataTransfer.getData('text/plain') === 'parcel') note('delivered'); };
const task = document.getElementById('pointer'); let active = false;
task.onpointerdown = e => { active = true; task.setPointerCapture(e.pointerId); };
task.onpointerup = e => { const b = document.getElementById('destination').getBoundingClientRect(); if(active && e.clientX > b.left && e.clientX < b.right) note('moved'); active = false; };
new IntersectionObserver(([entry]) => { if(entry.isIntersecting) note('end visible'); }).observe(document.getElementById('end'));
window.addEventListener('pageshow', () => { if(sessionStorage.visited) note('returned'); });
`);
        case '/reach-details':
            return layout('Details', '<p>Use browser history to return.</p>', 'sessionStorage.visited = "yes";');
        case '/reach-fields':
            return layout('Field labels', '<p>Use member@example.test / a passphrase</p><input aria-label="Address"><input aria-label="Passphrase" type="password"><label for="budget">Budget</label><input id="budget" aria-label="Memo">');
        case '/reach-visual':
            return layout('Visible summary', '<button aria-label="Choose amount" data-amount="5">5</button><button aria-label="Choose amount" data-amount="12">12</button><p>Total <span aria-hidden="true" id="total">0.00</span><span style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)">Unavailable amount</span></p><button id="finish">Finish</button>', `
for (const button of document.querySelectorAll('[data-amount]')) button.onclick = () => { document.getElementById('total').textContent = Number(button.dataset.amount).toFixed(2); };
document.getElementById('finish').onclick = () => { if(document.getElementById('total').textContent === '5.00') toast('Summary confirmed'); };
`);
        case '/reach-select':
            return layout('Choices', `${url.searchParams.has('duplicates') ? '<div role="listbox" aria-label="Other category"><div role="option" onclick="toast(&quot;Other category chosen&quot;)">Office supplies</div></div>' : ''}<label>Category<input role="combobox" aria-controls="choices" id="search"></label><div id="choices" role="listbox" aria-label="Matches"></div><label>Order<select id="order"><option>Recent</option><option>Oldest first</option></select></label>`, `
let timer; document.getElementById('search').oninput = () => { clearTimeout(timer); document.getElementById('choices').textContent = ''; timer = setTimeout(() => { const option = document.createElement('div'); option.setAttribute('role','option'); option.textContent = 'Office supplies'; option.onclick = () => toast('Category chosen'); document.getElementById('choices').append(option); }, 1200); };
document.getElementById('order').onchange = () => toast('Order chosen');
`);
        case '/reach-loading':
            return layout('Deferred controls', '<div aria-busy="true" id="pending">Loading workspace</div>', `
setTimeout(() => { const pending = document.getElementById('pending'); pending.removeAttribute('aria-busy'); pending.innerHTML = '<button onclick="toast(\\'Workspace ready\\')">Open workspace</button>'; }, 4500);
`);
        case '/reach-rebuild':
            return layout('Rebuilt controls', '<div id="list"></div>', `
let count = 0; const rebuild = () => { const list = document.getElementById('list'); list.innerHTML = '<button>Increment</button>'; list.firstChild.onclick = () => { count++; toast('Count ' + count); }; }; rebuild(); setInterval(rebuild, 400);
`);
        case '/reach-scroll':
            return layout('Windowed results', `${url.searchParams.has('hint') ? '<p>Scroll until Record 154 appears in the results.</p>' : ''}<div id="results" aria-label="Results" style="height:180px;overflow:auto"><div id="spacer" style="height:12000px;position:relative"></div></div>`, `
const results = document.getElementById('results'); const draw = () => { const n = Math.floor(results.scrollTop / 60); const spacer = document.getElementById('spacer'); spacer.innerHTML = Array.from({length:4}, (_,i) => '<div style="position:absolute;top:' + (n+i)*60 + 'px">Record ' + (n+i+1) + (n+i===153 ? '<button onclick="toast(\\'Record opened\\')">Open record</button>' : '') + '</div>').join(''); }; results.onscroll = draw; draw();
`);
        case '/reach-feed':
            return layout('Growing feed', '<div id="feed" aria-label="Updates" style="height:180px;overflow:auto"></div>', `
const feed = document.getElementById('feed'); const target = location.search.includes('many') ? 95 : 39, total = location.search.includes('many') ? 104 : 48; let count = 0, loading = false; const append = () => { for(let i=0;i<8;i++){ const row = document.createElement('div'); row.style.height='60px'; row.textContent = 'Update '+ ++count; if(count===target){ row.innerHTML += '<button onclick="toast(\\'Update opened\\')">Open update</button>'; } feed.append(row); } }; append(); feed.onscroll = () => { if(!loading && count<total && feed.scrollTop+feed.clientHeight>=feed.scrollHeight-100){ loading=true; setTimeout(() => { append(); loading=false; },400); } };
`);
        case '/page-entry': {
            const token = url.searchParams.get('token') ?? 'AR-7285';
            return layout('Access request', `<p>${bug === 'relabeled' ? 'Current token' : 'Access token'}: ${escapeHtml(token)}; enter it below.</p><label>Token<input id="token"></label><button id="apply">Apply token</button>`, `
document.getElementById('apply').onclick = () => toast(document.getElementById('token').value === ${JSON.stringify(token)} ? 'Access accepted' : 'Could not apply token');`);
        }
        case '/collection':
            return layout('Reading list', `<button id="save">Save essay</button><button id="tab" ${url.searchParams.has('buttons') ? '' : 'role="tab" aria-selected="false"'}>Reading list (0)</button><section id="content"><h2>Catalog</h2><p>An essay</p></section>`, `
document.getElementById('save').onclick = async () => { await send('/api/profile', { nickname: 'Essay', bio: 'Reading list' }); document.getElementById('save').textContent = 'Saved'; document.getElementById('tab').textContent = 'Reading list (1)'; };
document.getElementById('tab').onclick = () => { document.getElementById('tab').setAttribute('aria-selected', 'true'); document.getElementById('content').innerHTML = ${JSON.stringify(bug === 'empty' ? '<h2>Reading list</h2><p>No essays</p>' : '<h2>Reading list</h2><p>An essay</p>')}; };`);
        case '/required-form':
            return layout('Delivery', '<label>Destination<input id="destination"></label><button id="send">Confirm delivery</button>', `
document.getElementById('send').onclick = () => { const notice = document.createElement('div'); notice.setAttribute('role', 'alert'); notice.textContent = 'Could not confirm: destination is required'; document.body.append(notice); ${bug === 'crash' ? 'throw new Error(\'Delivery crashed\');' : ''} };`);
        case '/upload':
            return layout('Avatar', '<label for="avatar">Choose avatar</label><input id="avatar" type="file" hidden><button id="choose">Upload avatar</button><button id="nothing">No chooser</button><label>Visible file<input type="file" id="visible"></label><output id="uploaded"></output>', `
const avatar = document.getElementById('avatar');
document.getElementById('choose').onclick = () => avatar.click();
for (const field of [avatar, document.getElementById('visible')]) field.onchange = async () => { document.getElementById('uploaded').textContent = 'Uploaded ' + field.files[0].name + ': ' + await field.files[0].text(); };
`);
        case '/downloads':
            return layout('Exports', '<button id="csv">Export CSV</button><button id="large">Export large</button>', `
for (const [id, contents] of [['csv', 'name,value\\nAda,42'], ['large', 'x'.repeat(20 * 1024 * 1024 + 1)]]) {
 document.getElementById(id).onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([contents])); a.download = id + '.csv'; a.click(); };
}
`);
        case '/device':
            return layout('Device', `<p>Server UA: ${escapeHtml(url.searchParams.get('ua') ?? '')}</p><style>@media(max-width:480px){#menu{display:none}#hamburger{display:block!important}}</style><button id="hamburger" style="display:none">Open menu</button><div id="menu"><button id="save">Choose plan</button></div><output id="events"></output>`, `
document.getElementById('hamburger').onclick = () => { document.getElementById('menu').style.display = 'block'; };
document.getElementById('save').onclick = () => toast('Plan chosen');
addEventListener('touchstart', () => document.getElementById('events').textContent = 'Touch received');
`);
        case '/popup-parent':
            return layout('Parent', '<button onclick="window.open(\'/popup-child\')">Open child</button><button onclick="toast(\'Parent saved\')">Save parent</button>');
        case '/popup-child':
            return layout('Child', '<button onclick="window.close()">Close child</button>');

        case '/credential-form':
            return layout('Account sign-in', '<p>Account email: marble@example.test</p><label>Account email<input id="member"></label><label>Password<input id="phrase" type="password"></label><button id="enter">Sign in</button><h2 id="result"></h2>', `
document.getElementById('enter').onclick = () => { if (document.getElementById('member').value === 'marble@example.test' && document.getElementById('phrase').value === 'Private-Key-7312') { document.querySelector('main').innerHTML = '<h1>Signed in as marble@example.test</h1>'; } else { document.getElementById('result').textContent = 'Credentials rejected'; } };
`);
        case '/secret':
            return layout('API key', '<label>API key<input id="key"></label><button id="hint">Show hint</button><p id="help"></p><button id="save">Save key</button><button id="echo" hidden></button><output id="result"></output>', `
document.getElementById('hint').onclick = () => { document.getElementById('help').textContent = 'Enter the API key'; };
document.getElementById('save').onclick = () => {
  const key = document.getElementById('key').value;
  document.getElementById('result').textContent = key;
  const echo = document.getElementById('echo'); echo.hidden = false; echo.textContent = key;
  history.replaceState(null, '', '?key=' + encodeURIComponent(key));
  confirm('Confirm ' + key); console.error('Echo key ' + key);
};
document.getElementById('echo').onclick = () => { document.getElementById('help').textContent = 'Echo confirmed'; };
`);
        case '/effects': {
            const entries = [{ date: '2026-01-01', name: 'Alpha' }, { date: '2026-02-02', name: 'Beta' }];
            if (url.searchParams.has('single')) { entries.splice(1); }
            if (bug === 'swapped') { entries.reverse(); }
            return layout('Recorded effects', `<table><tbody>${entries.map(entry => `<tr><td>Entry ${entry.date}</td><td><button data-name="${entry.name}">Choose</button></td></tr>`).join('')}</tbody></table><h2 id="choice">No selection</h2>`, `
for (const button of document.querySelectorAll('button[data-name]')) button.addEventListener('click', () => {
  ${bug === 'no-effect' ? 'return;' : 'document.getElementById(\'choice\').textContent = button.dataset.name + \' chosen\';'}
  ${url.searchParams.has('confirm') && bug !== 'no-effect' ? 'const c = document.createElement(\'button\'); c.textContent = \'Confirm choice\'; c.addEventListener(\'click\', () => { document.getElementById(\'choice\').textContent += \' and confirmed\'; }); document.body.append(c);' : ''}
});`);
        }
        case '/profile':
            return layout('Profile', `
<form id="f"><label for="nick">Nickname</label><input id="nick" name="nick" value="${escapeHtml(state.profile.nickname)}">
<label for="bio">Bio</label><textarea id="bio" name="bio">${escapeHtml(state.profile.bio)}</textarea>
<p><button type="submit" id="save" disabled>${bug === 'relabel' ? 'Update profile' : 'Save profile'}</button></p></form>`, `
const f = document.getElementById('f'); const save = document.getElementById('save');
f.addEventListener('input', () => { save.disabled = false; });
f.addEventListener('submit', async (e) => { e.preventDefault(); save.disabled = true; toast('Saving…');
  const r = await send('/api/profile', { nickname: f.nick.value, bio: f.bio.value });
  if (r.ok) { toast(${bug === 'fail-once' ? '\'\'' : '\'Profile saved\''}); } else { save.disabled = false; toast(''); const a = document.createElement('div'); a.setAttribute('role', 'alert'); a.textContent = 'Could not save profile. Try again.'; f.append(a); } });`);
        case '/settings':
            return layout('Notification settings', `
<section aria-label="Email">${Object.entries({ news: 'Product news', digest: 'Weekly digest', security: 'Security alerts' }).map(([key, label]) => `
<div class="row"><span>${label}</span> <button role="switch" aria-label="Toggle setting" aria-checked="${state.settings[key]}" data-key="${key}">●</button></div>`).join('')}</section>`, `
for (const b of document.querySelectorAll('[role=switch]')) b.addEventListener('click', async () => {
  const next = b.getAttribute('aria-checked') !== 'true'; b.setAttribute('aria-checked', String(next));
  const r = await send('/api/settings', { key: b.dataset.key, value: next }); toast(r.ok ? 'Preferences updated' : 'Update failed'); });`);
        case '/items':
            return layout('Plans', `<table><thead><tr><th>Plan</th><th>Status</th><th></th></tr></thead><tbody>${state.items.map(item => `
<tr><td>${item.name}</td><td>${item.archived ? 'Archived' : 'Active'}</td><td>${item.archived ? '' : `<button data-id="${item.id}" data-name="${item.name}">Archive</button>`}</td></tr>`).join('')}</tbody></table>
<div role="alertdialog" aria-modal="true" aria-labelledby="dt" id="dlg" hidden><h2 id="dt">Archive plan?</h2><p id="dm"></p><button id="cancel">Cancel</button> <button id="confirm">Archive plan</button></div>`, `
let pending; const dlg = document.getElementById('dlg');
for (const b of document.querySelectorAll('button[data-id]')) b.addEventListener('click', () => { pending = b.dataset.id; document.getElementById('dm').textContent = 'Archive ' + b.dataset.name + '? Buyers keep access.'; dlg.hidden = false; for (const x of document.querySelectorAll('main > *:not(#dlg)')) x.setAttribute('aria-hidden', 'true'); });
document.getElementById('cancel').addEventListener('click', () => { dlg.hidden = true; for (const x of document.querySelectorAll('[aria-hidden]')) x.removeAttribute('aria-hidden'); });
document.getElementById('confirm').addEventListener('click', async () => { const r = await send('/api/items/' + (${bug === 'wrong-row' ? '\'a\'' : 'pending'}) + '/archive', {}); if (r.ok) location.reload(); });`);
        case '/currency':
            return layout('Currency', `<label for="cur">Display currency</label><select id="cur">${['USD', 'EUR', 'JPY'].map(code => `<option value="${code}"${state.currency === code ? ' selected' : ''}>${({ USD: 'US dollar', EUR: 'Euro', JPY: 'Japanese yen' } as Record<string, string>)[code]}</option>`).join('')}</select>
<p>Price preview: <span id="preview">${bug === 'nan' ? '$NaN' : state.currency === 'EUR' ? '€12.50' : state.currency === 'JPY' ? '¥1,250' : '$12.50'}</span></p><button id="save">Save currency</button>`, `
document.getElementById('save').addEventListener('click', async () => { const r = await send('/api/currency', { currency: document.getElementById('cur').value }); toast(r.ok ? 'Currency saved' : 'Failed'); });`);
        case '/animated':
            // Continuous animation through inline styles, SVG attributes and an animated favicon.
            return layout('Animated', '<div id="blob" style="width:40px;height:40px;background:#c06">x</div><svg width="60" height="20"><circle id="dot" cx="10" cy="10" r="5"/></svg><p>Static content</p>', `
const icon = document.createElement('link'); icon.rel = 'icon'; document.head.append(icon);
let t = 0; const tick = () => { t++; document.getElementById('blob').style.transform = 'rotate(' + t + 'deg)'; document.getElementById('dot').setAttribute('cx', String(10 + (t % 40))); icon.href = 'data:image/png;base64,' + t; requestAnimationFrame(tick); }; tick();`);
        case '/cards':
            // Toolbar buttons only take pointer events while their card is hovered, like card and row toolbars.
            // Beta's toolbar hangs below its card (like a dashboard card's layout menu), so the pointer must be on the card itself.
            return layout('Cards', `<style>.card{position:relative;border:1px solid #ccc;padding:12px;margin:8px 8px 64px;width:220px}.card .tools button{pointer-events:none;opacity:0}.card:hover .tools button,.card:focus-within .tools button{pointer-events:auto;opacity:1}.card.hanging .tools{position:absolute;left:12px;bottom:-44px;pointer-events:none}</style>
${['Alpha', 'Beta'].map(name => `<div class="card${name === 'Beta' ? ' hanging' : ''}"><h2>${name} card</h2><div role="button" tabindex="0" aria-label="${name} widget"><p>${name} content lives here</p></div><div role="group" aria-label="Tools for ${name} card" class="tools"><button data-id="${name.toLowerCase()}" aria-label="Customize ${name} card">✎</button></div></div>`).join('')}
<p>Customizing: ${state.customizing ?? 'none'}</p><textarea aria-label="Card note">Initial note</textarea>
<select aria-label="Card size"><option>Small</option><option selected>Large</option></select>`, `
for (const b of document.querySelectorAll('button[data-id]')) b.addEventListener('click', async () => { const r = await send('/api/cards/' + b.dataset.id + '/customize', {}); if (r.ok) location.reload(); });`);
        case '/drawer':
            // A non-modal settings drawer that opens over the page header and covers its Publish button.
            return layout('Page editor', `<style>header{position:relative;height:60px}#publish{position:absolute;right:24px;top:12px}#drawer{position:fixed;top:0;right:0;bottom:0;width:360px;background:#fff;border-left:1px solid #ccc;padding:16px}</style>
<header><button id="publish">Publish</button></header><p>Published ${state.published} times</p>
<div id="drawer"><h2>Text settings</h2><label for="txt">Text</label><input id="txt" value="Hello"><button id="close">Close drawer</button></div>`, `
document.getElementById('close').addEventListener('click', () => document.getElementById('drawer').remove());
document.getElementById('publish').addEventListener('click', async () => { const r = await send('/api/publish', {}); toast(r.ok ? 'Published' : 'Publish failed'); });`);
        case '/title':
            // An inline title that commits on Enter or blur, with no save button.
            return layout('Page settings', `<input id="title" aria-label="Page title" value="${escapeHtml(state.title)}"><p>Other settings</p>`, `
const input = document.getElementById('title'); let saved = input.value;
const commit = async () => { if (input.value === saved) return; saved = input.value; const r = await send('/api/title', { title: input.value }); toast(r.ok ? 'Title saved' : 'Failed'); };
input.addEventListener('keydown', (e) => { if (e.key === 'Enter') void commit(); }); input.addEventListener('blur', () => void commit());`);
        case '/crash-screen':
            // A client-rendered error screen: no failed request and no uncaught exception.
            return layout('Something went wrong', '<p>Error 500</p><p>An unexpected error occurred on our end.</p><button>Try again</button>');
        case '/stale-chunk':
            // The app's own code fails to download, as when a dev server re-optimizes its dependencies under an open page.
            return layout('Stale build', '<p>Loading the editor</p>', 'import("/_nuxt/missing.js?v=1");');
        case '/broken':
            return layout('Broken page', '<p>Total: undefined</p><p>settings.profile.title</p>', 'setTimeout(() => { throw new Error("Boom in fixture"); }, 10);');
        default:
            return lazyPages(state, url);
    }
}

/** Pages whose controls are not ready or not reachable when the DOM first goes quiet. */
function lazyPages(state: FixtureState, url: URL): string | undefined {
    switch (url.pathname) {
        case '/board':
            // A card board whose grid arrives in a lazily imported module, as dev-mode component chunks do. Adding a
            // card and editing one save through the same request, so a write alone does not show which one happened.
            return layout('Board', '<button id="add">Add card</button><div role="group" aria-label="Cards" id="grid"></div>', `
window.board = { cards: ${JSON.stringify(state.board)}, render: () => {} };
const saveBoard = () => send('/api/board', { cards: window.board.cards });
document.getElementById('add').addEventListener('click', () => { window.board.cards.push({ title: 'Untitled', text: '' }); window.board.render(); void saveBoard(); });
import('/modules/board.js');`);
        case '/sections':
            // Settings groups in an accordion: a collapsed panel keeps its content in the DOM, inert and zero-height,
            // so its buttons sit under the next group's header. The Cover card is live; like a page-builder card in edit mode,
            // its whole face is an inert preview of the same size.
            return layout('Product settings', `<style>.panel{display:grid;grid-template-rows:0fr}.panel.open{grid-template-rows:1fr}.inner{overflow:hidden}</style>
${['Pricing', 'Entitlements'].map((name, index) => `<h2><button aria-expanded="false" data-panel="p${index}">${name}</button></h2><div class="panel" id="p${index}" inert><div class="inner">${name === 'Pricing' ? '<p>No prices yet.</p><button id="add-price">Add a price</button>' : '<p>No entitlements yet.</p>'}</div></div>`).join('')}
<p>Prices: ${state.prices}</p>
<button aria-label="Cover" style="display:block;border:0;padding:0;width:240px;height:80px"><span inert style="display:block;width:100%;height:100%">Summer sale</span></button>`, `
for (const b of document.querySelectorAll('button[data-panel]')) b.addEventListener('click', () => { const panel = document.getElementById(b.dataset.panel); const open = !panel.classList.contains('open'); panel.classList.toggle('open', open); panel.inert = !open; b.setAttribute('aria-expanded', String(open)); });
document.getElementById('add-price').addEventListener('click', async () => { const r = await send('/api/prices', {}); if (r.ok) location.reload(); });`);
        default:
            return undefined;
    }
}

const BOARD_MODULE = `
const grid = document.getElementById('grid');
const edit = (card) => {
  let editor = document.getElementById('editor');
  if (!editor) { editor = document.createElement('textarea'); editor.id = 'editor'; document.querySelector('main').append(editor); }
  editor.setAttribute('aria-label', card.title + ' text'); editor.value = card.text;
  editor.oninput = () => { card.text = editor.value; void saveBoard(); };
};
window.board.render = () => {
  grid.replaceChildren(...window.board.cards.map((card) => { const b = document.createElement('button'); b.textContent = card.title; b.addEventListener('click', () => edit(card)); return b; }));
};
window.board.render();
`;

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) { chunks.push(chunk as Buffer); }
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> : {};
}

/** Writes that always succeed and answer with what they stored. */
const SIMPLE_WRITES: Record<string, (state: FixtureState, payload: Record<string, unknown>) => unknown> = {
    '/api/publish': (state) => { state.published++; return { published: state.published }; },
    '/api/title': (state, payload) => { state.title = String(payload.title); return { title: state.title }; },
    '/api/currency': (state, payload) => { state.currency = String(payload.currency); return { currency: state.currency }; },
    '/api/board': (state, payload) => { state.board = (payload.cards as FixtureState['board']).map(card => ({ title: String(card.title), text: String(card.text) })); return { cards: state.board }; },
    '/api/prices': (state) => { state.prices++; return { prices: state.prices }; },
};

async function api(state: FixtureState, url: URL, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const bug = url.searchParams.get('bug');
    const payload = await body(request);
    state.requests.push({ method: request.method ?? 'GET', path: url.pathname });
    const json = (status: number, value: unknown) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
    if (url.pathname === '/api/helper-reasoning') {
        const disabled = (payload.reasoning as { enabled?: boolean } | undefined)?.enabled === false;
        const tokens = disabled ? 3 : Number(payload.max_tokens);
        // Reasoning can exhaust a shared output budget before the helper writes its schema JSON.
        json(200, { id: 'fixture-helper', object: 'chat.completion', created: 0, model: String(payload.model), choices: [{ index: 0, finish_reason: disabled ? 'stop' : 'length', message: { role: 'assistant', content: disabled ? '{"ok":true}' : null, ...(disabled ? {} : { reasoning: 'Output budget exhausted before JSON' }) } }], usage: { prompt_tokens: 1, completion_tokens: tokens, total_tokens: tokens + 1, completion_tokens_details: { reasoning_tokens: disabled ? 0 : tokens } } });
        return;
    }
    if (url.pathname === '/api/draft-validation') {
        json(bug === '500' ? 500 : !payload.draft || bug === '422' ? 422 : 200, { validation: 'draft required' });
        return;
    }
    if (url.pathname === '/api/integrity') { json(500, { error: 'storage unavailable' }); return; }
    if (url.pathname === '/api/integrity-validation') { json(422, { validation: 'record invalid' }); return; }
    if (url.pathname === '/api/profile') {
        if (bug === '500') { json(500, { error: 'boom' }); return; }
        if (bug === 'fail-once' && !state.failedOnce) { state.failedOnce = true; json(503, { error: 'unavailable' }); return; }
        if (bug !== 'nosave') { state.profile = { nickname: String(payload.nickname), bio: bug === 'truncate' ? String(payload.bio).slice(0, 5) : String(payload.bio) }; }
        json(200, state.profile);
        return;
    }
    if (url.pathname === '/api/settings') { state.settings[String(payload.key)] = bug === 'sticky' ? true : Boolean(payload.value); json(200, state.settings); return; }
    const archive = /^\/api\/items\/(\w+)\/archive$/.exec(url.pathname);
    if (archive) {
        const item = state.items.find(entry => entry.id === archive[1]);
        if (!item) { json(404, {}); return; }
        item.archived = true;
        json(200, item);
        return;
    }
    const customize = /^\/api\/cards\/(\w+)\/customize$/.exec(url.pathname);
    if (customize) { state.customizing = customize[1]!; json(200, { customizing: state.customizing }); return; }
    const simple = SIMPLE_WRITES[url.pathname];
    if (simple) { json(200, simple(state, payload)); return; }
    json(404, {});
}

export async function startFixtureApp() {
    let state = initialState();
    const server = createServer((request, response) => {
        const url = new URL(request.url ?? '/', 'http://localhost');
        if (url.pathname.startsWith('/api/') && request.method === 'POST') {
            void api(state, url, request, response).catch(() => response.writeHead(500).end());
            return;
        }
        if (url.pathname === '/modules/board.js') {
            // Arrives well after the DOM has gone quiet, like a component chunk the dev server compiles on first request.
            setTimeout(() => response.writeHead(200, { 'content-type': 'text/javascript' }).end(BOARD_MODULE), 900);
            return;
        }
        if (url.pathname === '/device') { url.searchParams.set('ua', request.headers['user-agent'] ?? ''); }
        const html = pages(state, url);
        if (!html) { response.writeHead(404).end('not found'); return; }
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') { throw new Error('fixture did not bind'); }
    return {
        origin: `http://127.0.0.1:${address.port}`,
        get state() { return state; },
        reset() { state = initialState(); },
        close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
    };
}
