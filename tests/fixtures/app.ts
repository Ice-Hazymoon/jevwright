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
        case '/reach-observe':
            return layout('Surface controls', '<style>.menu:hover #submenu{display:block}#submenu{display:none}.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}</style><div class="menu"><span>Workspace</span><div id="submenu"><button>Invite member</button></div></div><div id="closed"></div><div contenteditable="true" aria-label="Draft"></div><button aria-label="Discard"><span class="sr">Ignore this</span>Publish draft</button><div><span>Budget</span><input aria-label="Memo"></div><div aria-label="Activity" style="height:100px;overflow:auto"><div style="height:1200px">Earlier activity</div></div><p style="margin-top:1400px">End notes</p>', `
const root = document.getElementById('closed').attachShadow({mode:'closed'});
root.innerHTML = '<div id="nested"></div>';
root.getElementById('nested').attachShadow({mode:'closed'}).innerHTML = '<label>Member<input></label><button>Grant</button>';
window.fixtureRoot = root;
window.rootStillClosed = document.getElementById('closed').shadowRoot === null;
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
            return layout('Choices', (url.searchParams.has('duplicates') ? '<div role="listbox" aria-label="Other category"><div role="option" onclick="toast(&quot;Other category chosen&quot;)">Office supplies</div></div>' : '') + '<label>Category<input role="combobox" aria-controls="choices" id="search"></label><div id="choices" role="listbox" aria-label="Matches"></div><label>Order<select id="order"><option>Recent</option><option>Oldest first</option></select></label>', `
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
            return layout('Windowed results', (url.searchParams.has('hint') ? '<p>Scroll until Record 154 appears in the results.</p>' : '') + '<div id="results" aria-label="Results" style="height:180px;overflow:auto"><div id="spacer" style="height:12000px;position:relative"></div></div>', `
const results = document.getElementById('results'); const draw = () => { const n = Math.floor(results.scrollTop / 60); const spacer = document.getElementById('spacer'); spacer.innerHTML = Array.from({length:4}, (_,i) => '<div style="position:absolute;top:' + (n+i)*60 + 'px">Record ' + (n+i+1) + (n+i===153 ? '<button onclick="toast(\\'Record opened\\')">Open record</button>' : '') + '</div>').join(''); }; results.onscroll = draw; draw();
`);
        case '/reach-feed':
            return layout('Growing feed', '<div id="feed" aria-label="Updates" style="height:180px;overflow:auto"></div>', `
const feed = document.getElementById('feed'); let count = 0, loading = false; const append = () => { for(let i=0;i<8;i++){ const row = document.createElement('div'); row.style.height='60px'; row.textContent = 'Update '+ ++count; if(count===39){ row.innerHTML += '<button onclick="toast(\\'Update opened\\')">Open update</button>'; } feed.append(row); } }; append(); feed.onscroll = () => { if(!loading && count<48 && feed.scrollTop+feed.clientHeight>=feed.scrollHeight-100){ loading=true; setTimeout(() => { append(); loading=false; },400); } };
`);
        case '/page-entry': {
            const token = url.searchParams.get('token') ?? 'AR-7285';
            return layout('Access request', `<p>${bug === 'relabeled' ? 'Current token' : 'Access token'}: ${escapeHtml(token)}; enter it below.</p><label>Token<input id="token"></label><button id="apply">Apply token</button>`, `
document.getElementById('apply').onclick = () => toast(document.getElementById('token').value === ${JSON.stringify(token)} ? 'Access accepted' : 'Could not apply token');`);
        }
        case '/collection':
            return layout('Reading list', '<button id="save">Save essay</button><button id="tab" role="tab" aria-selected="false">Reading list (0)</button><section id="content"><h2>Catalog</h2><p>An essay</p></section>', `
document.getElementById('save').onclick = async () => { await send('/api/profile', { nickname: 'Essay', bio: 'Reading list' }); document.getElementById('save').textContent = 'Saved'; document.getElementById('tab').textContent = 'Reading list (1)'; };
document.getElementById('tab').onclick = () => { document.getElementById('tab').setAttribute('aria-selected', 'true'); document.getElementById('content').innerHTML = ${JSON.stringify(bug === 'empty' ? '<h2>Reading list</h2><p>No essays</p>' : '<h2>Reading list</h2><p>An essay</p>')}; };`);
        case '/required-form':
            return layout('Delivery', '<label>Destination<input id="destination"></label><button id="send">Confirm delivery</button>', `
document.getElementById('send').onclick = () => { const notice = document.createElement('div'); notice.setAttribute('role', 'alert'); notice.textContent = 'Could not confirm: destination is required'; document.body.append(notice); ${bug === 'crash' ? "throw new Error('Delivery crashed');" : ''} };`);
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
