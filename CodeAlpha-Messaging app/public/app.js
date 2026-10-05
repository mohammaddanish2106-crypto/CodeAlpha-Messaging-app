/* ============================================================
   GupShup - frontend (vanilla JS single-page app)
   ============================================================ */
const $app = document.getElementById('app');
const state = {
  token:    localStorage.getItem('gs_token'),
  user:     JSON.parse(localStorage.getItem('gs_user') || 'null'),
  scope:    'all',
  authMode: 'login',
  unread:   0,       // total unread DM count
};

/* ============================================================
   Small helpers
   ============================================================ */
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Derive a friendly display name suggestion from a username.
 *   john_doe → John Doe  |  MaryJane → Mary Jane  |  cooldev2024 → Cooldev
 */
function suggestDisplayName(username) {
  if (!username) return '';
  let s = username
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_.\-]+/g, ' ')
    .replace(/^\d+|\d+$/g, '')
    .trim();
  s = s.split(/\s+/).filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
  return s.slice(0, 40);
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2400);
}

function timeAgo(iso) {
  const sec = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return 'just now';
  const units = [['d', 86400], ['h', 3600], ['m', 60]];
  for (const [label, size] of units) if (sec >= size) return `${Math.floor(sec / size)}${label} ago`;
}

const PALETTE = ['#3d3bd6', '#e5405e', '#0f8b8d', '#d9822b', '#7a4fd1', '#2f7d4f', '#c23b8a', '#3a6ea5'];
function avatar(username, name, size = '') {
  let h = 0;
  for (const ch of username) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const letter = esc((name || username).trim().charAt(0).toUpperCase());
  return `<a class="avatar ${size}" href="#/u/${esc(username)}" style="background:${PALETTE[h % PALETTE.length]}" aria-label="${esc(username)}">${letter}</a>`;
}

const ICON = {
  heart:    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 21s-7.5-4.6-9.5-9.2C1.2 8.6 3 5 6.5 5c2 0 3.5 1.1 5.5 3.2C14 6.1 15.5 5 17.5 5 21 5 22.8 8.6 21.5 11.8 19.5 16.4 12 21 12 21z"/></svg>',
  chat:     '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L3 20.5l1.5-5.1A8 8 0 1 1 21 12z"/></svg>',
  dm:       '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H8l-5 4v-4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/></svg>',
  trash:    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  logo:     '<svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor"><path d="M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-8l-5 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/></svg>',
  send:     '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
  back:     '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg>',
};

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.token) { logout(false); throw new Error(data.error || 'Please log in again.'); }
  if (!res.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

/* ============================================================
   WebSocket client
   ============================================================ */
let ws = null;
// username of the conversation currently open (or null)
let activeConvo = null;

function wsConnect() {
  if (!state.token) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}?token=${encodeURIComponent(state.token)}`);

  ws.addEventListener('open', () => console.log('[WS] connected'));

  ws.addEventListener('message', (e) => {
    let evt;
    try { evt = JSON.parse(e.data); } catch { return; }

    if (evt.type === 'message') {
      const msg = evt.message;

      // If the conversation with this person is open, append the bubble
      if (activeConvo && activeConvo === msg.with) {
        appendMessageBubble(msg);
        // Mark as read immediately
        wsSend({ type: 'read', from: msg.with });
      } else {
        // Not in that conversation — bump unread badge
        if (!msg.is_mine) {
          state.unread++;
          updateUnreadBadge();
          toast(`New message from ${msg.display_name || msg.username}`);
        }
      }

      // Refresh inbox if it's currently visible
      if (document.getElementById('inbox-list')) loadInbox();
    }
  });

  ws.addEventListener('close', () => {
    console.log('[WS] closed — reconnecting in 3s');
    ws = null;
    setTimeout(() => { if (state.token) wsConnect(); }, 3000);
  });

  ws.addEventListener('error', () => ws.close());
}

function wsDisconnect() {
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
}

function wsSend(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

/* ============================================================
   Auth
   ============================================================ */
function saveSession({ token, user }) {
  state.token = token;
  state.user  = user;
  localStorage.setItem('gs_token', token);
  localStorage.setItem('gs_user', JSON.stringify(user));
}

function logout(showToast = true) {
  wsDisconnect();
  activeConvo    = null;
  state.token    = null;
  state.user     = null;
  state.unread   = 0;
  localStorage.removeItem('gs_token');
  localStorage.removeItem('gs_user');
  location.hash = '';
  renderAuth();
  if (showToast) toast('Logged out');
}

function renderAuth() {
  const reg = state.authMode === 'register';
  $app.innerHTML = `
    <div class="auth">
      <div class="auth-card">
        <div class="brand">${ICON.logo} GupShup</div>
        <h1>${reg ? 'Create your account' : 'Welcome back'}</h1>
        <p class="sub">${reg ? 'Pick a username and start posting.' : 'Log in to see what your people are saying.'}</p>
        <form id="auth-form" novalidate>
          ${reg ? `<label class="field">
            <span>Display name</span>
            <input name="display_name" id="reg-display-name" maxlength="40" autocomplete="name" placeholder="How should people call you?" />
            <span class="dn-suggestions" id="dn-suggestions" aria-live="polite"></span>
          </label>` : ''}
          <label class="field"><span>Username</span><input name="username" id="reg-username" required autocomplete="username" /></label>
          <label class="field"><span>Password</span><input name="password" type="password" required autocomplete="${reg ? 'new-password' : 'current-password'}" /></label>
          <p class="form-error" id="auth-error"></p>
          <button class="btn block" type="submit">${reg ? 'Sign up' : 'Log in'}</button>
        </form>
        <p class="switch">${reg ? 'Already have an account?' : 'New here?'}
          <button type="button" id="auth-switch">${reg ? 'Log in' : 'Create an account'}</button></p>
      </div>
    </div>`;
}

/* ============================================================
   Shell (topbar + layout)
   ============================================================ */
function renderShell() {
  $app.innerHTML = `
    <header class="topbar"><div class="topbar-inner">
      <a class="brand" href="#/">${ICON.logo} GupShup</a>
      <nav class="nav">
        <a href="#/" id="nav-home">Home</a>
        <a href="#/messages" id="nav-msgs">${ICON.dm} Messages<span class="unread-badge" id="unread-badge" hidden></span></a>
        <a href="#/u/${esc(state.user.username)}" id="nav-me">Profile</a>
        <button type="button" id="logout">Log out</button>
      </nav>
    </div></header>
    <div class="layout">
      <main id="main"></main>
      <aside class="side"><div class="card" id="suggestions"><h3>Who to follow</h3><div id="suggest-list"></div></div></aside>
    </div>`;
}

function updateUnreadBadge() {
  const badge = document.getElementById('unread-badge');
  if (!badge) return;
  if (state.unread > 0) {
    badge.textContent = state.unread > 99 ? '99+' : state.unread;
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
}

/* ============================================================
   Suggestions sidebar
   ============================================================ */
async function loadSuggestions() {
  const box = document.getElementById('suggest-list');
  if (!box) return;
  try {
    const list = await api('/users/suggestions');
    box.innerHTML = list.length
      ? list.map((u) => `
        <div class="suggest">
          ${avatar(u.username, u.display_name, 'sm')}
          <div class="meta"><a href="#/u/${esc(u.username)}"><b>${esc(u.display_name)}</b></a><small>@${esc(u.username)}</small></div>
          <button class="btn small ghost" data-act="follow" data-user="${esc(u.username)}">Follow</button>
        </div>`).join('')
      : '<p class="empty" style="padding:8px 0">You are following everyone. Nice!</p>';
  } catch (e) { box.innerHTML = `<p class="empty">${esc(e.message)}</p>`; }
}

/* ============================================================
   Post + comment templates
   ============================================================ */
function postHTML(p) {
  const mine = p.username === state.user.username;
  return `
  <article class="card post" data-id="${p.id}">
    <div class="post-head">
      ${avatar(p.username, p.display_name)}
      <div class="post-meta">
        <a class="name" href="#/u/${esc(p.username)}">${esc(p.display_name)}</a>
        <span class="handle">@${esc(p.username)} · ${timeAgo(p.created_at)}</span>
      </div>
      ${mine ? `<button class="icon-btn del" data-act="del-post" title="Delete post" aria-label="Delete post">${ICON.trash}</button>` : ''}
    </div>
    <p class="post-body">${esc(p.content)}</p>
    <div class="post-actions">
      <button class="icon-btn like ${p.liked ? 'liked' : ''}" data-act="like" aria-pressed="${p.liked}">${ICON.heart}<span class="lc">${p.like_count}</span></button>
      <button class="icon-btn" data-act="toggle-comments">${ICON.chat}<span class="cc">${p.comment_count}</span></button>
    </div>
    <section class="comments" hidden></section>
  </article>`;
}

function commentHTML(c) {
  const mine = c.username === state.user.username;
  return `
  <div class="comment" data-cid="${c.id}">
    ${avatar(c.username, c.display_name, 'sm')}
    <div class="comment-bubble">
      ${mine ? '<button class="del" data-act="del-comment">Delete</button>' : ''}
      <a class="name" href="#/u/${esc(c.username)}">${esc(c.display_name)}</a><span class="when">${timeAgo(c.created_at)}</span>
      <p>${esc(c.content)}</p>
    </div>
  </div>`;
}

const postsHTML = (list, emptyMsg) =>
  list.length ? list.map(postHTML).join('') : `<div class="card empty">${emptyMsg}</div>`;

/* ============================================================
   Pages — Home
   ============================================================ */
async function showHome() {
  setActiveNav('home');
  activeConvo = null;
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="card compose">
      ${avatar(state.user.username, state.user.display_name)}
      <form id="post-form">
        <textarea name="content" maxlength="280" placeholder="What's on your mind?" aria-label="New post"></textarea>
        <div class="compose-foot"><span class="counter" id="counter">0 / 280</span><button class="btn" type="submit">Post</button></div>
      </form>
    </div>
    <div class="tabs">
      <button data-scope="all" class="${state.scope === 'all' ? 'on' : ''}">Everyone</button>
      <button data-scope="following" class="${state.scope === 'following' ? 'on' : ''}">Following</button>
    </div>
    <div id="feed"><div class="empty">Loading…</div></div>`;
  loadFeed();
  loadSuggestions();
}

async function loadFeed() {
  const feed = document.getElementById('feed');
  try {
    const posts = await api('/feed?scope=' + state.scope);
    feed.innerHTML = postsHTML(
      posts,
      state.scope === 'following'
        ? 'Nothing here yet. Follow someone to fill your feed.'
        : 'No posts yet. Be the first to post!'
    );
  } catch (e) { feed.innerHTML = `<div class="card empty">${esc(e.message)}</div>`; }
}

/* ============================================================
   Pages — Profile
   ============================================================ */
async function showProfile(username) {
  setActiveNav(username.toLowerCase() === state.user.username.toLowerCase() ? 'me' : '');
  activeConvo = null;
  const main = document.getElementById('main');
  main.innerHTML = '<div class="empty">Loading…</div>';
  loadSuggestions();
  try {
    const u = await api('/users/' + encodeURIComponent(username));
    main.innerHTML = `
      <div class="card profile-head" data-user="${esc(u.username)}">
        ${avatar(u.username, u.display_name, 'lg')}
        <div class="profile-info">
          <h2>${esc(u.display_name)}</h2>
          <div class="handle">@${esc(u.username)}</div>
          <p class="bio">${u.bio ? esc(u.bio) : '<span class="handle">No bio yet.</span>'}</p>
          <div class="stats">
            <div><b>${u.post_count}</b> <span>posts</span></div>
            <div><b id="followers-n">${u.followers}</b> <span>followers</span></div>
            <div><b>${u.following}</b> <span>following</span></div>
          </div>
          <div id="profile-actions" style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
            ${u.is_me
              ? '<button class="btn small ghost" data-act="edit-profile">Edit profile</button>'
              : `<button class="btn small ${u.is_following ? 'ghost' : ''}" data-act="follow" data-user="${esc(u.username)}">${u.is_following ? 'Following' : 'Follow'}</button>
                 <a class="btn small ghost" href="#/messages/${esc(u.username)}">${ICON.dm} Message</a>`}
          </div>
          <form class="edit-form" id="edit-form" hidden>
            <label class="field edit-dn-field">
              <span>Display name</span>
              <input name="display_name" id="edit-display-name" maxlength="40" value="${esc(u.display_name)}" aria-label="Display name" placeholder="Your display name" />
              <span class="dn-suggestions" id="edit-dn-suggestions" aria-live="polite" data-username="${esc(u.username)}"></span>
            </label>
            <label class="field">
              <span>Bio</span>
              <textarea name="bio" maxlength="160" rows="3" placeholder="Short bio" aria-label="Bio">${esc(u.bio)}</textarea>
            </label>
            <div><button class="btn small" type="submit">Save</button></div>
          </form>
        </div>
      </div>
      <div id="feed">${postsHTML(u.posts, u.is_me ? 'You have not posted yet.' : 'No posts yet.')}</div>`;
  } catch (e) { main.innerHTML = `<div class="card empty">${esc(e.message)}</div>`; }
}

/* ============================================================
   Pages — Inbox
   ============================================================ */
async function showInbox() {
  setActiveNav('msgs');
  activeConvo = null;
  // clear unread count when opening inbox
  state.unread = 0;
  updateUnreadBadge();

  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="card inbox-card">
      <h2 class="inbox-title">${ICON.dm} Messages</h2>
      <div id="inbox-list"><div class="empty">Loading…</div></div>
    </div>`;
  loadSuggestions();
  loadInbox();
}

async function loadInbox() {
  const box = document.getElementById('inbox-list');
  if (!box) return;
  try {
    const rows = await api('/messages/inbox');
    if (!rows.length) {
      box.innerHTML = '<p class="empty" style="padding:16px 0">No conversations yet. Message someone from their profile!</p>';
      return;
    }
    box.innerHTML = rows.map((r) => `
      <a class="inbox-row ${r.unread > 0 ? 'unread' : ''}" href="#/messages/${esc(r.username)}">
        ${avatar(r.username, r.display_name, 'sm')}
        <div class="inbox-meta">
          <div class="inbox-name"><b>${esc(r.display_name)}</b><small>@${esc(r.username)}</small></div>
          <div class="inbox-preview">${esc(r.last_message.slice(0, 60))}${r.last_message.length > 60 ? '…' : ''}</div>
        </div>
        <div class="inbox-right">
          <span class="inbox-time">${timeAgo(r.last_at)}</span>
          ${r.unread > 0 ? `<span class="inbox-unread">${r.unread}</span>` : ''}
        </div>
      </a>`).join('');
  } catch (e) { box.innerHTML = `<p class="empty">${esc(e.message)}</p>`; }
}

/* ============================================================
   Pages — Conversation
   ============================================================ */
async function showConversation(username) {
  setActiveNav('msgs');
  activeConvo = username;

  const main = document.getElementById('main');
  main.innerHTML = '<div class="empty">Loading…</div>';

  try {
    const { user: other, messages } = await api('/messages/' + encodeURIComponent(username));

    // mark as read via WS too
    wsSend({ type: 'read', from: username });

    // recalculate total unread (rough: just decrement what we loaded)
    state.unread = Math.max(0, state.unread - messages.filter(m => !m.is_mine && !m.read_at).length);
    updateUnreadBadge();

    main.innerHTML = `
      <div class="card convo-card" id="convo-card">
        <div class="convo-header">
          <a class="btn small ghost icon-btn" href="#/messages" aria-label="Back">${ICON.back}</a>
          ${avatar(other.username, other.display_name, 'sm')}
          <div class="convo-header-info">
            <a href="#/u/${esc(other.username)}"><b>${esc(other.display_name)}</b></a>
            <small>@${esc(other.username)}</small>
          </div>
        </div>
        <div class="msg-thread" id="msg-thread">
          ${messages.length
            ? messages.map(msgBubbleHTML).join('')
            : '<p class="empty msg-empty">No messages yet. Say hello!</p>'}
        </div>
        <form class="msg-compose" id="msg-form" data-to="${esc(other.username)}">
          <textarea name="content" maxlength="500" placeholder="Type a message…" aria-label="Message" rows="1"></textarea>
          <button class="btn send-btn" type="submit" aria-label="Send">${ICON.send}</button>
        </form>
      </div>`;

    scrollToBottom();
  } catch (e) { main.innerHTML = `<div class="card empty">${esc(e.message)}</div>`; }
}

function msgBubbleHTML(m) {
  return `
  <div class="msg-bubble-wrap ${m.is_mine ? 'mine' : 'theirs'}" data-mid="${m.id}">
    ${!m.is_mine ? avatar(m.username, m.display_name, 'sm') : ''}
    <div class="msg-bubble">
      <p>${esc(m.content)}</p>
      <span class="msg-time">${timeAgo(m.created_at)}</span>
    </div>
  </div>`;
}

function appendMessageBubble(msg) {
  const thread = document.getElementById('msg-thread');
  if (!thread) return;
  thread.querySelector('.msg-empty')?.remove();
  thread.insertAdjacentHTML('beforeend', msgBubbleHTML(msg));
  scrollToBottom();
}

function scrollToBottom() {
  const thread = document.getElementById('msg-thread');
  if (thread) thread.scrollTop = thread.scrollHeight;
}

/* ============================================================
   Nav helpers
   ============================================================ */
function setActiveNav(which) {
  document.getElementById('nav-home')?.classList.toggle('active', which === 'home');
  document.getElementById('nav-msgs')?.classList.toggle('active', which === 'msgs');
  document.getElementById('nav-me')?.classList.toggle('active',   which === 'me');
}

/* ============================================================
   Router
   ============================================================ */
function route() {
  if (!state.token) return renderAuth();
  if (!document.querySelector('.topbar')) renderShell();

  const hash = location.hash;
  const mConvo = hash.match(/^#\/messages\/([^/]+)/);
  const mInbox = hash.match(/^#\/messages$/);
  const mUser  = hash.match(/^#\/u\/([^/]+)/);

  if (mConvo)      showConversation(decodeURIComponent(mConvo[1]));
  else if (mInbox) showInbox();
  else if (mUser)  showProfile(decodeURIComponent(mUser[1]));
  else             showHome();

  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

/* ============================================================
   Display-name suggestion helpers
   ============================================================ */
function renderDnSuggestions(box, primary, input) {
  if (!primary) { box.innerHTML = ''; return; }
  const current = input.value.trim();
  const candidates = [primary];
  const firstName = primary.split(' ')[0];
  if (firstName && firstName !== primary) candidates.push(firstName);
  const chips = [...new Set(candidates)].filter((c) => c.toLowerCase() !== current.toLowerCase());
  if (!chips.length) { box.innerHTML = ''; return; }
  box.innerHTML =
    '<span class="dn-hint">Suggestions:</span>' +
    chips.map((c) => `<button type="button" class="dn-chip" data-value="${esc(c)}">${esc(c)}</button>`).join('');
}

/* ============================================================
   Events — submit
   ============================================================ */
$app.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const data = Object.fromEntries(new FormData(form));
  const btn  = form.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    if (form.id === 'auth-form') {
      const path = state.authMode === 'register' ? '/auth/register' : '/auth/login';
      saveSession(await api(path, { method: 'POST', body: data }));
      wsConnect();
      location.hash = '#/';
      document.querySelector('.topbar')?.remove();
      route();

    } else if (form.id === 'post-form') {
      const post = await api('/posts', { method: 'POST', body: { content: data.content } });
      form.reset();
      document.getElementById('counter').textContent = '0 / 280';
      const feed = document.getElementById('feed');
      feed.querySelector('.empty')?.remove();
      feed.insertAdjacentHTML('afterbegin', postHTML(post));
      toast('Posted');

    } else if (form.classList.contains('comment-form')) {
      const post = form.closest('.post');
      const c = await api(`/posts/${post.dataset.id}/comments`, { method: 'POST', body: { content: data.content } });
      form.reset();
      form.insertAdjacentHTML('beforebegin', commentHTML(c));
      const cc = post.querySelector('.cc');
      cc.textContent = Number(cc.textContent) + 1;

    } else if (form.id === 'edit-form') {
      const saved = await api('/users/me', { method: 'PUT', body: data });
      state.user.display_name = saved.display_name;
      localStorage.setItem('gs_user', JSON.stringify(state.user));
      toast('Profile updated');
      showProfile(state.user.username);

    } else if (form.id === 'msg-form') {
      const to      = form.dataset.to;
      const content = data.content.trim();
      if (!content) return;

      // Send over WS (server saves + broadcasts back to us)
      wsSend({ type: 'message', to, content });
      form.reset();
      autoResizeTextarea(form.querySelector('textarea'));
    }
  } catch (err) {
    if (form.id === 'auth-form') document.getElementById('auth-error').textContent = err.message;
    else toast(err.message);
  } finally {
    btn.disabled = false;
  }
});

/* ============================================================
   Events — input
   ============================================================ */
$app.addEventListener('input', (e) => {
  // Post counter
  if (e.target.name === 'content' && e.target.closest('#post-form')) {
    const n = e.target.value.length;
    const c = document.getElementById('counter');
    c.textContent = `${n} / 280`;
    c.classList.toggle('over', n > 280);
  }

  // Auto-resize message textarea
  if (e.target.closest('#msg-form')) autoResizeTextarea(e.target);

  // Register form: suggest display name from username
  if (e.target.id === 'reg-username') {
    const suggestion = suggestDisplayName(e.target.value);
    const dnInput = document.getElementById('reg-display-name');
    const box     = document.getElementById('dn-suggestions');
    if (!dnInput || !box) return;
    if (!dnInput.dataset.userEdited && suggestion) dnInput.value = suggestion;
    renderDnSuggestions(box, suggestion, dnInput);
  }
  if (e.target.id === 'reg-display-name') {
    const box = document.getElementById('dn-suggestions');
    const usernameInput = document.getElementById('reg-username');
    if (!box || !usernameInput) return;
    e.target.dataset.userEdited = 'true';
    renderDnSuggestions(box, suggestDisplayName(usernameInput.value), e.target);
  }

  // Profile edit form display name suggestions
  if (e.target.id === 'edit-display-name') {
    const box = document.getElementById('edit-dn-suggestions');
    if (!box) return;
    const username = box.dataset.username || state.user?.username || '';
    renderDnSuggestions(box, suggestDisplayName(username), e.target);
  }
});

// Shift+Enter = newline, Enter alone = submit message form
$app.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && e.target.closest('#msg-form')) {
    e.preventDefault();
    e.target.closest('form').requestSubmit();
  }
});

function autoResizeTextarea(ta) {
  if (!ta) return;
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
}

/* ============================================================
   Events — click
   ============================================================ */
$app.addEventListener('click', async (e) => {
  const el = e.target.closest('button, [data-scope], .dn-chip, a.inbox-row');
  if (!el) return;

  // Suggestion chip
  if (el.classList.contains('dn-chip')) {
    const box   = el.closest('.dn-suggestions');
    const field = box?.closest('.field');
    const input = field?.querySelector('input[name="display_name"]');
    if (input) { input.value = el.dataset.value; input.dataset.userEdited = 'true'; input.focus(); box.innerHTML = ''; }
    return;
  }

  if (el.id === 'auth-switch') { state.authMode = state.authMode === 'login' ? 'register' : 'login'; return renderAuth(); }
  if (el.id === 'logout') return logout();
  if (el.dataset.scope) {
    state.scope = el.dataset.scope;
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b === el));
    return loadFeed();
  }

  const act  = el.dataset.act;
  const post = el.closest('.post');

  try {
    if (act === 'like') {
      const r = await api(`/posts/${post.dataset.id}/like`, { method: 'POST' });
      el.classList.toggle('liked', r.liked);
      el.setAttribute('aria-pressed', r.liked);
      el.querySelector('.lc').textContent = r.like_count;

    } else if (act === 'toggle-comments') {
      const box = post.querySelector('.comments');
      if (!box.hidden) { box.hidden = true; return; }
      box.innerHTML = '<div class="empty" style="padding:6px">Loading…</div>';
      box.hidden = false;
      const list = await api(`/posts/${post.dataset.id}/comments`);
      box.innerHTML = list.map(commentHTML).join('') + `
        <form class="comment-form">
          <input name="content" maxlength="200" placeholder="Write a comment" aria-label="Write a comment" required />
          <button class="btn small" type="submit">Reply</button>
        </form>`;
      box.querySelector('input').focus();

    } else if (act === 'del-post') {
      if (!confirm('Delete this post?')) return;
      await api('/posts/' + post.dataset.id, { method: 'DELETE' });
      post.remove();
      toast('Post deleted');

    } else if (act === 'del-comment') {
      const c = el.closest('.comment');
      await api('/comments/' + c.dataset.cid, { method: 'DELETE' });
      c.remove();
      const cc = post.querySelector('.cc');
      cc.textContent = Math.max(0, Number(cc.textContent) - 1);

    } else if (act === 'follow') {
      const r = await api(`/users/${encodeURIComponent(el.dataset.user)}/follow`, { method: 'POST' });
      if (el.closest('#profile-actions')) {
        el.textContent = r.is_following ? 'Following' : 'Follow';
        el.classList.toggle('ghost', r.is_following);
        document.getElementById('followers-n').textContent = r.followers;
      } else {
        el.closest('.suggest').remove();
        toast('Followed @' + el.dataset.user);
      }

    } else if (act === 'edit-profile') {
      const f = document.getElementById('edit-form');
      f.hidden = !f.hidden;
      if (!f.hidden) {
        const box   = document.getElementById('edit-dn-suggestions');
        const input = document.getElementById('edit-display-name');
        if (box && input) renderDnSuggestions(box, suggestDisplayName(box.dataset.username || state.user?.username || ''), input);
      }
    }
  } catch (err) { toast(err.message); }
});

/* ============================================================
   Boot
   ============================================================ */
if (state.token) {
  wsConnect();
  // fetch initial unread count
  api('/messages/inbox').then((rows) => {
    state.unread = rows.reduce((s, r) => s + (r.unread || 0), 0);
    updateUnreadBadge();
  }).catch(() => {});
}
route();
