(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const el = (tag, props = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid);
    return e;
  };
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

  const S = {
    me: null, chats: new Map(), msgs: new Map(), more: new Map(), active: null,
    typing: new Map(), outbox: [], ws: null, wsOpen: false, retry: 0, reconnectTimer: null, gotReady: false, filter: '',
  };

  /* ───────── api ───────── */
  async function api(path, opts = {}) {
    const r = await fetch(path, {
      credentials: 'same-origin', ...opts,
      headers: { 'Content-Type': 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (r.status === 401) { location.href = '/login'; throw new Error('unauthorized'); }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || r.statusText);
    return data;
  }
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3000);
  }

  /* ───────── formatting ───────── */
  const COLORS = ['#e57373', '#f06292', '#ba68c8', '#9575cd', '#7986cb', '#4fc3f7', '#4db6ac', '#81c784', '#dce775', '#ffb74d', '#ff8a65', '#a1887f'];
  const colorFor = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return COLORS[h % COLORS.length]; };
  const initials = (n) => (String(n).trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('') || '?').toUpperCase();
  const timeFmt = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  function dayLabel(ts) {
    const d = new Date(ts), today = startOfDay(new Date()), day = startOfDay(d);
    if (day === today) return 'Today';
    if (day === today - 864e5) return 'Yesterday';
    return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  }
  function listTime(ts) {
    const day = startOfDay(new Date(ts)), today = startOfDay(new Date());
    if (day === today) return timeFmt(ts);
    if (day === today - 864e5) return 'Yesterday';
    return new Date(ts).toLocaleDateString([], { day: 'numeric', month: 'short' });
  }
  function lastSeenText(ts) {
    if (!ts) return 'offline';
    const day = startOfDay(new Date(ts)), today = startOfDay(new Date());
    if (day === today) return `last seen today at ${timeFmt(ts)}`;
    if (day === today - 864e5) return `last seen yesterday at ${timeFmt(ts)}`;
    return `last seen ${new Date(ts).toLocaleDateString([], { day: 'numeric', month: 'short' })}`;
  }
  function linkify(text) {
    const frag = document.createDocumentFragment();
    const re = /https?:\/\/[^\s<]+[^\s<.,;:!?'")\]]/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) frag.append(text.slice(last, m.index));
      frag.append(el('a', { href: m[0], target: '_blank', rel: 'noopener noreferrer nofollow', text: m[0] }));
      last = m.index + m[0].length;
    }
    if (last < text.length) frag.append(text.slice(last));
    return frag;
  }
  const TICK1 = '<svg class="tick" viewBox="0 0 16 11"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" d="M1.5 5.8l3.4 3.4L11 2"/></svg>';
  const TICK2 = '<svg class="tick" viewBox="0 0 16 11"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" d="M1 5.8l3.4 3.4L10.5 2M7 8.6l1 .6L14.5 2"/></svg>';
  const CLOCK = '<svg class="tick" viewBox="0 0 16 11"><circle cx="8" cy="5.5" r="4" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 3.4v2.3l1.5.9" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';

  function avatar(user, cls = '') {
    const a = el('div', { class: `avatar ${cls}` });
    a.style.background = colorFor(user.id || user.name);
    if (user.picture) {
      const img = el('img', { src: user.picture, alt: '', referrerpolicy: 'no-referrer', loading: 'lazy' });
      img.onerror = () => { img.remove(); a.textContent = initials(user.name); };
      a.append(img);
    } else a.textContent = initials(user.name);
    return a;
  }

  /* ───────── chat helpers ───────── */
  const otherOf = (chat) => chat.members.find((m) => m.id !== S.me.id) || chat.members[0];
  const chatName = (chat) => (chat.type === 'group' ? chat.name : otherOf(chat)?.name || 'Chat');
  const chatAvatarUser = (chat) => (chat.type === 'group' ? { id: chat.id, name: chat.name } : otherOf(chat));
  const memberName = (chat, id) => chat.members.find((m) => m.id === id)?.name || 'Someone';
  function msgStatus(chat, m) {
    if (m.pending) return 'pending';
    const others = chat.members.filter((x) => x.id !== S.me.id).map((x) => x.id);
    if (others.length && others.every((id) => m.readBy.includes(id))) return 'read';
    if (others.length && others.every((id) => m.deliveredTo.includes(id))) return 'delivered';
    return 'sent';
  }
  function typingNames(chatId) {
    const chat = S.chats.get(chatId), t = S.typing.get(chatId);
    if (!chat || !t || !t.size) return null;
    return [...t.keys()].map((id) => memberName(chat, id).split(' ')[0]);
  }

  /* ───────── rendering: list ───────── */
  function renderList() {
    const q = S.filter.trim().toLowerCase();
    const chats = [...S.chats.values()]
      .filter((c) => !q || chatName(c).toLowerCase().includes(q))
      .sort((a, b) => (b.last?.ts || b.createdAt) - (a.last?.ts || a.createdAt));
    const box = $('#chatlist'); box.replaceChildren();
    for (const c of chats) {
      const who = chatAvatarUser(c);
      const av = avatar(who);
      if (c.type === 'direct' && otherOf(c)?.online) av.append(el('span', { class: 'dot' }));
      const tn = typingNames(c.id);
      let preview;
      if (tn) preview = el('span', { class: 'typing', text: c.type === 'group' ? `${tn.join(', ')} typing…` : 'typing…' });
      else if (c.last) {
        const mine = c.last.from === S.me.id;
        const prefix = mine ? 'You: ' : c.type === 'group' ? `${memberName(c, c.last.from).split(' ')[0]}: ` : '';
        preview = el('span', { text: prefix + c.last.text.replace(/\s+/g, ' ') });
      } else preview = el('span', { text: 'No messages yet' });
      const item = el('div', { class: 'chat-item' + (c.id === S.active ? ' active' : ''), role: 'listitem', tabindex: '0', onclick: () => go(c.id), onkeydown: (e) => { if (e.key === 'Enter') go(c.id); } },
        av,
        el('div', { class: 'chat-main' },
          el('div', { class: 'chat-row' },
            el('div', { class: 'chat-name', text: chatName(c) }),
            c.last ? el('div', { class: 'chat-time' + (c.unread ? ' unread' : ''), text: listTime(c.last.ts) }) : null),
          el('div', { class: 'chat-row' },
            el('div', { class: 'chat-preview' }, preview),
            c.unread ? el('div', { class: 'badge', text: c.unread > 99 ? '99+' : String(c.unread) }) : null)));
      box.append(item);
    }
    $('#list-empty').hidden = S.chats.size > 0;
    const total = [...S.chats.values()].reduce((n, c) => n + c.unread, 0);
    document.title = total ? `(${total}) ChatApp` : 'ChatApp';
  }

  /* ───────── rendering: thread ───────── */
  function renderHeader() {
    const chat = S.chats.get(S.active);
    if (!chat) return;
    const av = avatar(chatAvatarUser(chat));
    av.id = 'head-avatar';
    $('#head-avatar').replaceWith(av);
    $('#head-name').textContent = chatName(chat);
    const tn = typingNames(chat.id);
    let status;
    if (tn) status = chat.type === 'group' ? `${tn.join(', ')} typing…` : 'typing…';
    else if (chat.type === 'group') status = chat.members.map((m) => (m.id === S.me.id ? 'You' : m.name.split(' ')[0])).join(', ');
    else { const o = otherOf(chat); status = o.online ? 'online' : lastSeenText(o.lastSeen); }
    $('#head-status').textContent = status;
  }

  function renderMessages({ stick } = {}) {
    const chat = S.chats.get(S.active);
    const box = $('#messages');
    if (!chat) return;
    const msgs = S.msgs.get(chat.id) || [];
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    const prevH = box.scrollHeight, prevTop = box.scrollTop;
    box.replaceChildren();
    let lastDay = null, lastFrom = null;
    for (const m of msgs) {
      const label = dayLabel(m.ts);
      if (label !== lastDay) { box.append(el('div', { class: 'day', text: label })); lastDay = label; lastFrom = null; }
      const out = m.from === S.me.id;
      const first = lastFrom !== m.from;
      lastFrom = m.from;
      const bubble = el('div', { class: 'msg' });
      if (!out && chat.type === 'group' && first) {
        const w = el('div', { class: 'who', text: memberName(chat, m.from) });
        w.style.color = colorFor(m.from); bubble.append(w);
      }
      bubble.append(linkify(m.text));
      const meta = el('span', { class: 'meta' }, el('span', { text: timeFmt(m.ts) }));
      if (out) {
        if (m.failed) meta.append(el('span', { class: 'failed', text: 'not sent' }));
        else {
          const st = msgStatus(chat, m);
          const t = el('span'); t.innerHTML = st === 'pending' ? CLOCK : st === 'sent' ? TICK1 : TICK2;
          if (st === 'read') t.firstChild.classList.add('read');
          t.setAttribute('aria-label', st); meta.append(t);
        }
      }
      bubble.append(meta);
      box.append(el('div', { class: `row ${out ? 'out' : 'in'}${first ? ' first' : ''}`, 'data-id': m.id }, bubble));
    }
    if (stick === 'older') box.scrollTop = prevTop + (box.scrollHeight - prevH);
    else if (stick === true || nearBottom) box.scrollTop = box.scrollHeight;
    else box.scrollTop = prevTop;
  }

  /* ───────── navigation ───────── */
  const go = (id) => { location.hash = id ? `#/c/${id}` : ''; };
  async function route() {
    const m = location.hash.match(/^#\/c\/([\w-]+)/);
    if (m && S.chats.has(m[1])) await openChat(m[1]);
    else if (m && S.me) { await loadChats(); if (S.chats.has(m[1])) await openChat(m[1]); else closeChat(); }
    else closeChat();
  }
  function closeChat() {
    S.active = null;
    document.body.classList.remove('chat-open');
    $('#thread').hidden = true; $('#placeholder').hidden = false;
    renderList();
  }
  async function openChat(id) {
    S.active = id;
    const chat = S.chats.get(id);
    document.body.classList.add('chat-open');
    $('#thread').hidden = false; $('#placeholder').hidden = true;
    renderHeader(); renderList();
    if (!S.msgs.has(id)) {
      try {
        const { messages, more } = await api(`/api/chats/${id}/messages`);
        S.msgs.set(id, messages); S.more.set(id, more);
      } catch (e) { toast(e.message); return; }
    }
    if (S.active !== id) return;
    renderMessages({ stick: true });
    markRead();
    if (matchMedia('(pointer: fine)').matches) $('#input').focus();
    void chat;
  }
  function markRead() {
    const chat = S.chats.get(S.active);
    if (!chat || document.hidden) return;
    if (chat.unread > 0) { chat.unread = 0; renderList(); wsSend({ t: 'read', chatId: chat.id }); }
  }

  /* ───────── data loading ───────── */
  async function loadChats() {
    const { chats } = await api('/api/chats');
    S.chats = new Map(chats.map((c) => [c.id, c]));
    renderList();
  }
  async function resync() {
    await loadChats();
    if (S.active && S.chats.has(S.active)) {
      const { messages, more } = await api(`/api/chats/${S.active}/messages`);
      const pending = (S.msgs.get(S.active) || []).filter((m) => m.pending || m.failed);
      S.msgs.set(S.active, [...messages, ...pending.filter((p) => !messages.some((m) => m.id === p.id))]);
      S.more.set(S.active, more);
      renderHeader(); renderMessages({}); markRead();
    }
    for (const id of [...S.msgs.keys()]) if (id !== S.active) S.msgs.delete(id); // drop stale caches
  }

  /* ───────── websocket ───────── */
  function wsSend(obj) { if (S.wsOpen) { S.ws.send(JSON.stringify(obj)); return true; } return false; }
  function setConn(ok) { $('#conn').hidden = ok; }
  function connect() {
    clearTimeout(S.reconnectTimer);
    if (S.ws && S.ws.readyState <= 1) return;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    S.ws = ws; S.gotReady = false;
    ws.onmessage = (e) => { try { onWS(JSON.parse(e.data)); } catch (err) { console.error(err); } };
    ws.onclose = () => {
      S.wsOpen = false; setConn(false);
      if (!S.gotReady) api('/api/me').catch(() => {}); // redirects to /login if the session expired
      S.retry++;
      S.reconnectTimer = setTimeout(connect, Math.min(500 * 2 ** S.retry, 15000));
    };
    ws.onerror = () => ws.close();
  }
  function onWS(m) {
    switch (m.t) {
      case 'ready':
        S.gotReady = true; S.wsOpen = true; S.retry = 0; setConn(true);
        resync().then(flushOutbox).catch(console.error);
        break;
      case 'message': onMessage(m.msg, m.cid); break;
      case 'receipts': onReceipts(m); break;
      case 'readself': { const c = S.chats.get(m.chatId); if (c) { c.unread = 0; renderList(); } break; }
      case 'typing': onTyping(m); break;
      case 'presence': onPresence(m); break;
      case 'chat': S.chats.set(m.chat.id, m.chat); renderList(); break;
      case 'error': {
        const arr = S.msgs.get(S.active) || [];
        const p = arr.find((x) => x.cid === m.cid);
        if (p) { p.pending = false; p.failed = true; S.outbox = S.outbox.filter((o) => o.cid !== m.cid); renderMessages({}); }
        toast(m.error || 'Message failed');
        break;
      }
      default:
    }
  }
  function onMessage(msg, cid) {
    const chat = S.chats.get(msg.chatId);
    if (!chat) { loadChats(); return; }
    const prevLast = chat.last;
    if (!prevLast || msg.ts >= prevLast.ts) chat.last = msg;
    const arr = S.msgs.get(msg.chatId);
    if (arr) {
      let i = cid ? arr.findIndex((x) => x.cid === cid) : -1;
      if (i < 0) i = arr.findIndex((x) => x.id === msg.id);
      if (i >= 0) arr[i] = msg; else arr.push(msg);
    }
    if (cid) S.outbox = S.outbox.filter((o) => o.cid !== cid);
    const mine = msg.from === S.me.id;
    if (!mine) {
      S.typing.get(msg.chatId)?.delete(msg.from);
      if (S.active === msg.chatId && !document.hidden) { wsSend({ t: 'read', chatId: msg.chatId }); }
      else { chat.unread++; notify(chat, msg); }
    }
    renderList();
    if (S.active === msg.chatId) { renderHeader(); renderMessages({ stick: mine ? true : undefined }); }
  }
  function onReceipts({ kind, chatId, userId, ids }) {
    const arr = S.msgs.get(chatId); if (!arr) return;
    const set = new Set(ids);
    for (const m of arr) {
      if (!set.has(m.id)) continue;
      if (!m.deliveredTo.includes(userId)) m.deliveredTo.push(userId);
      if (kind === 'read' && !m.readBy.includes(userId)) m.readBy.push(userId);
    }
    const chat = S.chats.get(chatId);
    if (chat?.last && set.has(chat.last.id)) { /* last is shared object or copy; keep list in sync */ }
    if (S.active === chatId) renderMessages({});
  }
  function onTyping({ chatId, userId }) {
    if (!S.typing.has(chatId)) S.typing.set(chatId, new Map());
    const t = S.typing.get(chatId);
    clearTimeout(t.get(userId));
    t.set(userId, setTimeout(() => { t.delete(userId); renderList(); if (S.active === chatId) renderHeader(); }, 3500));
    renderList(); if (S.active === chatId) renderHeader();
  }
  function onPresence({ userId, online, lastSeen }) {
    for (const c of S.chats.values()) for (const mem of c.members) if (mem.id === userId) { mem.online = online; mem.lastSeen = lastSeen; }
    renderList(); if (S.active) renderHeader();
  }

  /* ───────── sending ───────── */
  function sendMessage(text) {
    text = text.trim();
    const chat = S.chats.get(S.active);
    if (!text || !chat) return;
    const cid = uid();
    const m = { id: 'p_' + cid, cid, chatId: chat.id, from: S.me.id, text, ts: Date.now(), deliveredTo: [], readBy: [], pending: true };
    const arr = S.msgs.get(chat.id) || []; arr.push(m); S.msgs.set(chat.id, arr);
    chat.last = m;
    S.outbox.push({ t: 'send', chatId: chat.id, text, cid });
    flushOutbox();
    renderList(); renderMessages({ stick: true });
  }
  function flushOutbox() { if (S.wsOpen) for (const o of S.outbox) wsSend(o); }

  let lastTyping = 0;
  function typingPing() {
    const t = Date.now();
    if (S.active && t - lastTyping > 2500) { lastTyping = t; wsSend({ t: 'typing', chatId: S.active }); }
  }

  /* ───────── notifications ───────── */
  function notify(chat, msg) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if (!document.hidden && S.active === chat.id) return;
    const title = chat.type === 'group' ? `${chatName(chat)}` : chatName(chat);
    const body = (chat.type === 'group' ? `${memberName(chat, msg.from)}: ` : '') + msg.text.slice(0, 140);
    const opts = { body, tag: chat.id, icon: '/icons/icon-192.png', data: { chatId: chat.id } };
    if (navigator.serviceWorker?.controller) navigator.serviceWorker.ready.then((r) => r.showNotification(title, opts));
    else { const n = new Notification(title, opts); n.onclick = () => { window.focus(); go(chat.id); n.close(); }; }
  }

  /* ───────── modal: new chat / group ───────── */
  function openNewChat() {
    const modal = $('#modal');
    let mode = 'pick', users = [], selected = new Map(), q = '', closed = false, seq = 0;
    const close = () => { closed = true; clearTimeout(draw.t); modal.hidden = true; modal.replaceChildren(); };
    modal.onclick = (e) => { if (e.target === modal) close(); };

    async function fetchUsers() {
      const mine = ++seq; // ignore out-of-order responses and anything that lands after the dialog closed
      let res = [];
      try { res = (await api(`/api/users?q=${encodeURIComponent(q)}`)).users; } catch { res = []; }
      if (closed || mine !== seq) return;
      users = res;
      draw();
    }
    async function startDirect(u) {
      try {
        const { chat } = await api('/api/chats', { method: 'POST', body: { type: 'direct', userId: u.id } });
        S.chats.set(chat.id, S.chats.get(chat.id) || chat);
        close(); go(chat.id);
      } catch (e) { toast(e.message); }
    }
    async function createGroup(name) {
      try {
        const { chat } = await api('/api/chats', { method: 'POST', body: { type: 'group', name, members: [...selected.keys()] } });
        S.chats.set(chat.id, chat); close(); go(chat.id);
      } catch (e) { toast(e.message); }
    }
    const row = (u, onclick, withCheck) => el('div', { class: 'item', onclick },
      avatar(u, 'sm'),
      el('div', {}, el('div', { class: 'name', text: u.name }), el('div', { class: 'email', text: u.email })),
      withCheck ? el('div', { class: 'check' + (selected.has(u.id) ? ' on' : ''), text: selected.has(u.id) ? '✓' : '' }) : null);

    function draw() {
      const keepFocus = document.activeElement?.id === 'u-search';
      const title = mode === 'pick' ? 'New chat' : 'New group';
      const search = el('div', { class: 'pad' }, el('input', {
        id: 'u-search', type: 'search', placeholder: 'Search people by name or email', value: q, autocomplete: 'off',
        oninput: (e) => { q = e.target.value; clearTimeout(draw.t); draw.t = setTimeout(fetchUsers, 200); },
      }));
      const body = el('div', { class: 'body' });
      if (mode === 'pick') {
        body.append(el('div', { class: 'item', onclick: () => { mode = 'group'; draw(); } },
          el('div', { class: 'avatar sm', style: 'background:var(--accent)', text: '👥' }), el('div', { class: 'name', text: 'New group' })));
        for (const u of users) body.append(row(u, () => startDirect(u), false));
      } else {
        for (const u of users) body.append(row(u, () => { selected.has(u.id) ? selected.delete(u.id) : selected.set(u.id, u); draw(); }, true));
      }
      if (!users.length) body.append(el('div', { class: 'empty-note', text: q ? 'No matches.' : 'No other people have signed in yet. Ask a colleague to log in, then search for them here.' }));
      const sheet = el('div', { class: 'sheet', role: 'dialog', 'aria-label': title },
        el('div', { class: 'bar' },
          el('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: mode === 'group' ? () => { mode = 'pick'; selected.clear(); draw(); } : close },
            el('span', { text: mode === 'group' ? '←' : '✕', style: 'font-size:20px' })),
          el('div', { class: 'title grow', text: title })),
        search, body);
      if (mode === 'group') {
        const name = el('input', { type: 'text', id: 'g-name', placeholder: 'Group name', maxlength: '60' });
        const btn = el('button', { class: 'primary', text: `Create group (${selected.size} selected)`, disabled: selected.size < 2,
          onclick: () => { const n = name.value.trim(); if (!n) { toast('Give the group a name'); name.focus(); return; } createGroup(n); } });
        const keep = $('#g-name')?.value || '';
        name.value = keep;
        sheet.append(el('div', { class: 'foot' }, name, btn));
        if (selected.size) sheet.insertBefore(el('div', { class: 'pad sub', text: [...selected.values()].map((u) => u.name).join(', ') }), body);
      }
      modal.replaceChildren(sheet);
      modal.hidden = false;
      if (keepFocus || !draw.shown) { const i = $('#u-search'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); draw.shown = true; }
    }
    draw.shown = false;
    fetchUsers();
  }

  /* ───────── init ───────── */
  function bindUI() {
    $('#btn-new').onclick = openNewChat;
    $('#btn-back').onclick = () => go('');
    $('#filter').oninput = (e) => { S.filter = e.target.value; renderList(); };
    const menu = $('#menu');
    $('#btn-menu').onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; };
    document.addEventListener('click', () => (menu.hidden = true));
    $('#menu-logout').onclick = async () => { try { await api('/auth/logout', { method: 'POST' }); } finally { location.href = '/login'; } };
    const nb = $('#menu-notif');
    if (!('Notification' in window)) nb.hidden = true;
    else {
      const sync = () => { nb.textContent = Notification.permission === 'granted' ? 'Notifications enabled ✓' : 'Enable notifications'; };
      sync();
      nb.onclick = async () => {
        if (Notification.permission === 'denied') toast('Notifications are blocked in your browser settings');
        else { await Notification.requestPermission(); sync(); }
      };
    }

    const input = $('#input'), form = $('#composer');
    const fit = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 140) + 'px'; };
    input.addEventListener('input', () => { fit(); if (input.value.trim()) typingPing(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(pointer: fine)').matches) { e.preventDefault(); form.requestSubmit(); }
    });
    $('#btn-send').addEventListener('pointerdown', (e) => e.preventDefault()); // keep keyboard open on mobile
    form.addEventListener('submit', (e) => { e.preventDefault(); sendMessage(input.value); input.value = ''; fit(); });

    $('#messages').addEventListener('scroll', async (e) => {
      const box = e.target;
      if (box.scrollTop > 40 || !S.active || !S.more.get(S.active) || S.loadingOlder) return;
      const arr = S.msgs.get(S.active) || [];
      const first = arr.find((m) => !m.pending);
      if (!first) return;
      S.loadingOlder = true;
      try {
        const id = S.active;
        const { messages, more } = await api(`/api/chats/${id}/messages?before=${first.ts}`);
        if (S.active === id) { S.msgs.set(id, [...messages, ...arr]); S.more.set(id, more); renderMessages({ stick: 'older' }); }
      } finally { S.loadingOlder = false; }
    });

    window.addEventListener('hashchange', route);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) markRead(); });
    window.addEventListener('online', () => { S.retry = 0; connect(); });
    // iOS/Android keyboard: size the app to the visual viewport so the composer stays visible.
    if (window.visualViewport) {
      const vv = window.visualViewport;
      const set = () => { document.documentElement.style.setProperty('--app-h', vv.height + 'px'); window.scrollTo(0, 0); const b = $('#messages'); if (document.activeElement === input) b.scrollTop = b.scrollHeight; };
      vv.addEventListener('resize', set); set();
    }
    setInterval(() => { renderList(); if (S.active) renderHeader(); }, 60_000);
  }

  async function init() {
    const { user } = await api('/api/me');
    S.me = user;
    const me = avatar(user); me.id = 'me'; me.classList.add('sm');
    $('#me').replaceWith(me);
    $('#menu-who').textContent = `${user.name}\n${user.email}`;
    $('#menu-who').style.whiteSpace = 'pre-line';
    bindUI();
    await loadChats();
    await route();
    setConn(false);
    connect();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  init().catch((e) => { console.error(e); });
})();
