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
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>${style}</head><body>
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
        case '/effects': {
            const entries = [{ date: '2026-01-01', name: 'Alpha' }, { date: '2026-02-02', name: 'Beta' }];
            if (url.searchParams.has('single')) { entries.splice(1); }
            if (bug === 'swapped') { entries.reverse(); }
            return layout('Recorded effects', `<table><tbody>${entries.map(entry => `<tr><td>Entry ${entry.date}</td><td><button data-name="${entry.name}">Choose</button></td></tr>`).join('')}</tbody></table><h2 id="choice">No selection</h2>`, `
for (const button of document.querySelectorAll('button[data-name]')) button.addEventListener('click', () => {
  ${bug === 'no-effect' ? 'return;' : "document.getElementById('choice').textContent = button.dataset.name + ' chosen';"}
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
