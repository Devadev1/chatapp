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
  function callUuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  const MAX_TEXT = 4000;
  const MAX_FILE_BYTES = 10 * 1024 * 1024;
  const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp']);
  const VOICE_TYPES = new Set(['audio/webm', 'audio/ogg', 'audio/mp4']);
  const VOICE_MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'];
  const VOICE_WAVEFORM = [18, 30, 48, 34, 65, 42, 78, 52, 33, 60, 86, 46, 28, 57, 72, 39, 61, 90, 45, 31, 68, 51, 82, 38, 58, 74, 43, 62, 35, 77, 49, 26];
  const MIC_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.93V21h2v-3.07A7 7 0 0 0 19 11h-2Z"/></svg>';
  const STOP_ICON = '<span class="voice-stop-icon" aria-hidden="true">■</span>';
  const PLAY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
  const PAUSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zm6 0h4v14h-4z"/></svg>';

  const S = {
    me: null, chats: new Map(), msgs: new Map(), more: new Map(), active: null,
    typing: new Map(), outbox: [], ws: null, wsOpen: false, retry: 0, reconnectTimer: null, gotReady: false, filter: '',
    directory: new Map(), renderDirectory: null, refreshDirectory: null, animatedReads: new WeakSet(), replyTo: null, call: null, iceServers: [],
    sidebarView: 'chats', callHistory: [],
  };
  let voiceRecorder = null, voiceStream = null, voiceChunks = [], voiceBlob = null, voiceUrl = null;
  let voiceTimer = null, voiceStartedAt = 0, voiceSize = 0, discardVoiceRecording = false;
  let callClock = null;

  /* ───────── api ───────── */
  async function api(path, opts = {}) {
    const { rawBody = false, ...request } = opts;
    const headers = { ...(rawBody ? {} : { 'Content-Type': 'application/json' }), ...(request.headers || {}) };
    const r = await fetch(path, {
      credentials: 'same-origin', ...request, headers,
      body: request.body ? (rawBody ? request.body : JSON.stringify(request.body)) : undefined,
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
  function fileSizeText(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
  const EYE = '<svg class="eye" viewBox="0 0 18 12"><path d="M1 6s2.8-4.5 8-4.5S17 6 17 6s-2.8 4.5-8 4.5S1 6 1 6Z" fill="none" stroke="currentColor" stroke-width="1.4"/><circle class="eye-pupil" cx="9" cy="6" r="2" fill="currentColor"/></svg>';
  const EMOJIS = ['😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '😊', '😇', '🙂', '🙃', '😉', '😍', '🥰', '😘', '😋', '😎', '🤔', '🤗', '🤩', '🥳', '😭', '😢', '😡', '👍', '👎', '👏', '🙌', '🙏', '💪', '👋', '❤️', '🧡', '💛', '💚', '💙', '💜', '💔', '🔥', '✨', '🎉', '🎂', '☕', '🍕', '🐱', '🐶', '🌈', '✅'];
  const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

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
    const box = $('#chatlist'), empty = $('#list-empty'); box.replaceChildren(empty);
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
        const summary = c.last.attachment ? `📎 ${c.last.attachment.name}` : (c.last.text || '').replace(/\s+/g, ' ');
        preview = el('span', { text: prefix + summary });
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
    $('#chatlist').hidden = S.sidebarView !== 'chats';
    $('#call-history-view').hidden = S.sidebarView !== 'calls';
    $('#list-empty').hidden = S.sidebarView !== 'chats' || chats.length > 0;
    $('#calls-empty').hidden = S.sidebarView !== 'calls' || S.callHistory.length > 0;
    $('#filter').placeholder = 'Search chats';
    $('#filter').setAttribute('aria-label', 'Search chats');
    if (S.sidebarView === 'calls') renderCallHistory();
    const total = [...S.chats.values()].reduce((n, c) => n + c.unread, 0);
    document.title = total ? `(${total}) ChatApp` : 'ChatApp';
  }
  function callResultText(call) {
    if (call.result === 'completed') return call.direction === 'outgoing' ? 'Outgoing call' : 'Incoming call';
    if (call.result === 'missed') return 'Missed call';
    if (call.result === 'declined') return 'Declined';
    if (call.result === 'cancelled') return 'Cancelled';
    if (call.result === 'no-answer') return 'No answer';
    if (call.result === 'unavailable') return 'Unavailable';
    if (call.result === 'busy') return 'Busy';
    return 'Call failed';
  }
  function callDurationText(durationMs) {
    if (!durationMs) return '';
    const seconds = Math.floor(durationMs / 1000);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }
  function callHistoryTitle(call) {
    if (!call.groupCall) return call.title || call.peer?.name || 'Unknown';
    const participants = (call.participants || [])
      .filter((person) => person.id !== S.me.id)
      .map((person) => person.name)
      .filter(Boolean);
    return participants.length ? participants.join('; ') : call.title || call.peer?.name || 'Unknown';
  }
  function groupCallHistoryIcon() {
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('aria-hidden', 'true');
    const shape = (name, attrs) => {
      const node = document.createElementNS('http://www.w3.org/2000/svg', name);
      for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
      return node;
    };
    icon.append(
      shape('circle', { cx: '9', cy: '8', r: '3' }),
      shape('circle', { cx: '17', cy: '9', r: '2.5' }),
      shape('path', { d: 'M3.5 19c.4-3.1 2.3-5 5.5-5h1c3.2 0 5.1 1.9 5.5 5' }),
      shape('path', { d: 'M15 14.5c2.7.1 4.4 1.6 4.8 4.5' }),
    );
    return el('span', { class: 'call-history-avatar call-history-group-icon', 'aria-hidden': 'true' }, icon);
  }
  function audioTimeText(seconds) {
    const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }
  function createVoicePlayer(src, label) {
    const audio = el('audio', { class: 'voice-player-audio', preload: 'metadata', src, 'aria-hidden': 'true' });
    const currentTime = el('span', { class: 'voice-time', text: '0:00' });
    const duration = el('span', { class: 'voice-time', text: '0:00' });
    const waveform = el('span', { class: 'voice-waveform', 'aria-hidden': 'true' });
    const bars = VOICE_WAVEFORM.map((height, index) => el('span', {
      class: 'voice-wave-bar', style: `--wave-height:${height}%;--bar-index:${index}`,
    }));
    waveform.append(...bars);
    const playButton = el('button', {
      class: 'voice-play', type: 'button', 'aria-label': `Play ${label}`, title: `Play ${label}`,
      onclick: () => {
        if (audio.paused) audio.play().catch(() => toast(`${label} could not be played`));
        else audio.pause();
      },
    });
    const player = el('div', { class: 'voice-player' }, currentTime, waveform, duration, playButton, audio);
    const update = () => {
      const progress = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.currentTime / audio.duration : 0;
      currentTime.textContent = audioTimeText(audio.currentTime);
      duration.textContent = audioTimeText(audio.duration);
      bars.forEach((bar, index) => bar.classList.toggle('played', (index + 0.5) / bars.length <= progress));
      const playing = !audio.paused && !audio.ended;
      player.classList.toggle('is-playing', playing);
      playButton.innerHTML = playing ? PAUSE_ICON : PLAY_ICON;
      playButton.setAttribute('aria-label', `${playing ? 'Pause' : 'Play'} ${label}`);
      playButton.title = `${playing ? 'Pause' : 'Play'} ${label}`;
    };
    for (const event of ['loadedmetadata', 'durationchange', 'timeupdate', 'play', 'pause', 'ended']) {
      audio.addEventListener(event, update);
    }
    update();
    return player;
  }
  function renderCallHistory() {
    const box = $('#call-list'), empty = $('#calls-empty'), query = S.filter.trim().toLowerCase();
    const calls = S.callHistory.filter((call) => {
      const peerName = callHistoryTitle(call).toLowerCase();
      return !query || peerName.includes(query) || callResultText(call).toLowerCase().includes(query);
    });
    box.replaceChildren(empty);
    for (const call of calls) {
      const missed = call.result === 'missed' || call.result === 'no-answer' || call.result === 'unavailable';
      const peer = call.peer || { id: call.peerId, name: 'Unknown' };
      const title = callHistoryTitle(call);
      const time = listTime(call.endedAt || call.startedAt);
      const duration = callDurationText(call.durationMs);
      const detail = `${callResultText(call)}${duration ? ` · ${duration}` : ''}`;
      const item = el('div', { class: 'call-history-item', role: 'listitem' },
        el('button', { class: 'call-history-info', type: 'button', onclick: () => {
          if (S.chats.has(call.chatId)) { setSidebarView('chats'); go(call.chatId); }
          else toast('This call is not linked to one of your chats');
        } },
          el('span', { class: `call-history-direction${missed ? ' missed' : ''}`, 'aria-hidden': 'true', text: call.direction === 'incoming' ? '↙' : '↗' }),
          call.groupCall ? groupCallHistoryIcon() : avatar(peer, 'call-history-avatar'),
          el('span', { class: 'call-history-copy' },
            el('span', { class: 'call-history-name', text: title }),
            el('span', { class: `call-history-result${missed ? ' missed' : ''}`, text: detail })),
          el('span', { class: 'call-history-time', text: time })),
        el('button', {
          class: 'call-redial icon-btn', type: 'button', 'aria-label': `Call ${title}`, title: `Call ${title}`,
          disabled: !S.chats.has(call.chatId), onclick: () => startVoiceCall(call.chatId),
        }, callIcon('phone', 'answer')));
      box.append(item);
    }
    $('#calls-empty').hidden = S.sidebarView !== 'calls' || calls.length > 0;
    if (S.sidebarView === 'calls' && calls.length === 0) {
      $('#calls-empty').textContent = query ? 'No matching calls.' : 'Your call history will appear here.';
    }
  }
  async function loadCallHistory() {
    const { calls } = await api('/api/call-history');
    S.callHistory = calls;
    renderList();
  }
  function setSidebarView(view) {
    S.sidebarView = view;
    S.filter = '';
    $('#filter').value = '';
    $('#call-filter').value = '';
    for (const chats of [$('#nav-chats'), $('#mobile-nav-chats')]) {
      chats.classList.toggle('active', view === 'chats');
      if (view === 'chats') chats.setAttribute('aria-current', 'page'); else chats.removeAttribute('aria-current');
    }
    for (const calls of [$('#nav-calls'), $('#mobile-nav-calls')]) {
      calls.classList.toggle('active', view === 'calls');
      if (view === 'calls') calls.setAttribute('aria-current', 'page'); else calls.removeAttribute('aria-current');
    }
    $('#sidebar-title').textContent = 'Chats';
    document.body.classList.toggle('calls-open', view === 'calls');
    document.body.classList.remove('chat-open');
    $('#call-history-view').hidden = view !== 'calls';
    $('#thread').hidden = view === 'calls' || !S.active;
    $('#placeholder').hidden = view === 'calls' || Boolean(S.active);
    renderList();
    if (view === 'calls') loadCallHistory().catch((e) => toast(e.message));
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
    const callButton = $('#btn-call');
    callButton.hidden = false;
    callButton.disabled = Boolean(S.call);
    const callLabel = chat.type === 'group' ? 'Start group voice call' : 'Start voice call';
    callButton.setAttribute('aria-label', S.call ? 'Voice call in progress' : callLabel);
    callButton.title = S.call ? 'Voice call in progress' : callLabel;
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
      if (m.forwarded) bubble.append(el('div', { class: 'forwarded-label', text: `Forwarded${m.forwardedFrom?.name ? ` from ${m.forwardedFrom.name}` : ''}` }));
      if (m.replyTo) {
        const repliedBy = m.replyTo.from === S.me.id ? 'You' : memberName(chat, m.replyTo.from);
        const excerpt = m.replyTo.attachment ? `📎 ${m.replyTo.attachment.name}` : m.replyTo.text;
        bubble.append(el('div', { class: 'reply-quote' },
          el('div', { class: 'reply-name', text: repliedBy }),
          el('div', { class: 'reply-text', text: excerpt || 'Message' })));
      }
      if (m.attachment) {
        const fileUrl = `/api/files/${encodeURIComponent(m.attachment.id)}`;
        if (m.attachment.voiceNote) {
          const player = createVoicePlayer(`${fileUrl}?play=1`, 'voice note');
          const download = el('a', {
            class: 'voice-download', href: `${fileUrl}?download=1`, download: m.attachment.name,
            'aria-label': 'Download voice note',
          }, el('span', { text: 'Download voice note' }), el('span', { class: 'file-size', text: fileSizeText(m.attachment.size) }));
          bubble.append(el('div', { class: 'voice-attachment' }, player, download));
        } else if (IMAGE_TYPES.has(m.attachment.type)) {
          const preview = el('button', {
            class: 'image-preview', type: 'button', 'aria-label': `Show preview of ${m.attachment.name}`,
            onclick: () => {
              const revealed = preview.classList.toggle('revealed');
              preview.setAttribute('aria-label', `${revealed ? 'Blur' : 'Show preview of'} ${m.attachment.name}`);
            },
          },
          el('img', { src: `${fileUrl}?preview=1`, alt: m.attachment.name, loading: 'lazy' }),
          el('span', { class: 'image-preview-overlay', text: 'Tap to reveal' }));
          const download = el('a', {
            class: 'image-download', href: `${fileUrl}?download=1`, download: m.attachment.name,
            'aria-label': `Download ${m.attachment.name}`,
          }, el('span', { text: 'Download image' }), el('span', { class: 'file-size', text: fileSizeText(m.attachment.size) }));
          bubble.append(el('div', { class: 'image-attachment' }, preview, download));
        } else {
          bubble.append(el('a', {
            class: 'file-attachment', href: `${fileUrl}?download=1`,
            download: m.attachment.name, 'aria-label': `Download ${m.attachment.name}`,
          },
          el('span', { class: 'file-symbol', text: '📎' }),
          el('span', { class: 'file-name', text: m.attachment.name }),
          el('span', { class: 'file-size', text: fileSizeText(m.attachment.size) })));
        }
      }
      if (m.text) bubble.append(linkify(m.text));
      const meta = el('span', { class: 'meta' }, el('span', { text: timeFmt(m.ts) }));
      if (m.editedAt) meta.append(el('span', { class: 'edited-label', text: 'edited' }));
      if (out) {
        if (m.failed) meta.append(el('span', { class: 'failed', text: 'not sent' }));
        else {
          const st = msgStatus(chat, m);
          const t = el('span');
          if (st === 'pending') t.innerHTML = CLOCK;
          else if (st === 'sent') t.innerHTML = TICK1;
          else if (st === 'delivered') t.innerHTML = TICK2;
          else {
            t.innerHTML = EYE;
            t.firstChild.classList.add('read');
            if (!S.animatedReads.has(m)) {
              t.firstChild.classList.add('animate');
              S.animatedReads.add(m);
            }
          }
          t.setAttribute('aria-label', st); meta.append(t);
        }
      }
      if (!m.pending && !m.failed) {
        bubble.append(el('button', {
          class: 'msg-options', type: 'button', 'aria-label': 'Message options',
          onclick: (e) => { e.stopPropagation(); openMessageActions(chat.id, m); },
        }, el('span', { text: '⋮' })));
      }
      bubble.append(meta);
      const reactions = Object.entries(m.reactions || {}).filter(([, ids]) => Array.isArray(ids) && ids.length);
      if (reactions.length) {
        const bar = el('div', { class: 'reactions' });
        for (const [emoji, ids] of reactions) {
          const mine = ids.includes(S.me.id);
          bar.append(el('button', {
            class: `reaction${mine ? ' mine' : ''}`, type: 'button',
            'aria-label': `${emoji}, ${ids.length} reaction${ids.length === 1 ? '' : 's'}`,
            'aria-pressed': String(mine), onclick: () => toggleReaction(chat.id, m.id, emoji),
          }, el('span', { text: emoji }), el('span', { text: String(ids.length) })));
        }
        bubble.append(bar);
      }
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
    if (voiceRecorder || voiceBlob) discardVoiceNote();
    S.active = null;
    clearReplyTarget();
    document.body.classList.remove('chat-open');
    $('#thread').hidden = true; $('#placeholder').hidden = S.sidebarView === 'calls';
    renderList();
  }
  async function openChat(id) {
    if (S.sidebarView !== 'chats') setSidebarView('chats');
    if (S.active && S.active !== id && (voiceRecorder || voiceBlob)) discardVoiceNote();
    if (S.replyTo && S.replyTo.chatId !== id) clearReplyTarget();
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
      if (S.call) finishVoiceCall('connection-lost', false);
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
        S.refreshDirectory?.();
        break;
      case 'message': onMessage(m.msg, m.cid); break;
      case 'messageupdate': onMessageUpdate(m.msg); break;
      case 'messagedeleted': onMessageDeleted(m); break;
      case 'messagehidden': onMessageDeleted(m); break;
      case 'receipts': onReceipts(m); break;
      case 'readself': { const c = S.chats.get(m.chatId); if (c) { c.unread = 0; renderList(); } break; }
      case 'typing': onTyping(m); break;
      case 'presence': onPresence(m); break;
      case 'chat': S.chats.set(m.chat.id, m.chat); renderList(); break;
      case 'call': onCallEvent(m); break;
      case 'call-history-updated':
        if (S.sidebarView === 'calls') loadCallHistory().catch((e) => toast(e.message));
        break;
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
  function callStatusText(call) {
    const connectedPeers = [...call.peerConnections.values()].filter((entry) => entry.pc.connectionState === 'connected').length;
    if (call.status === 'incoming') return call.groupCall ? 'Incoming group voice call' : 'Incoming voice call';
    if (call.status === 'calling') {
      const invitees = [...call.participants.values()].filter((person) => person.id !== S.me.id);
      if (invitees.some((person) => person.status === 'ringing')) return 'Calling…';
      if (invitees.length && invitees.every((person) => person.status === 'unavailable')) return 'Contact is offline';
      if (invitees.length && invitees.every((person) => person.status === 'busy')) return 'Contact is on another call';
      if (invitees.length && invitees.every((person) => person.status === 'declined')) return 'Call declined';
      if (invitees.length && invitees.every((person) => person.status === 'missed')) return 'No answer';
      return 'Waiting for someone to join…';
    }
    if (call.status === 'connecting') return 'Connecting your audio…';
    if (call.status === 'active') {
      const seconds = Math.floor((Date.now() - call.startedAt) / 1000);
      return `${connectedPeers + 1} connected  ·  ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    }
    return 'Voice call';
  }
  function callParticipantStatus(status) {
    return ({
      connected: 'In call', ringing: 'Calling…', declined: 'Declined',
      missed: 'No answer', busy: 'Busy', unavailable: 'Offline', left: 'Left',
    })[status] || 'Invited';
  }
  function updateCallParticipants(call, message) {
    if (Array.isArray(message.participants)) {
      call.participants = new Map(message.participants.map((participant) => [participant.id, participant]));
    }
    if (typeof message.title === 'string') call.title = message.title;
    if (typeof message.groupCall === 'boolean') call.groupCall = message.groupCall;
  }
  function callIcon(name, variant) {
    const paths = {
      add: ['M12 5v14m-7-7h14'],
      phone: ['M6.62 10.79a15.05 15.05 0 0 0 6.59 6.59l2.2-2.2a1 1 0 0 1 1.02-.24c1.12.37 2.33.56 3.57.56.55 0 1 .45 1 1V20c0 .55-.45 1-1 1C10.61 21 3 13.39 3 4c0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.24.19 2.45.56 3.57a1 1 0 0 1-.25 1.02z'],
      mic: ['M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.93V21h2v-3.07A7 7 0 0 0 19 11z'],
      micOff: ['M12 14a3 3 0 0 0 3-3V8.83l-6-6A3 3 0 0 0 9 5v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-.22 1.47l1.57 1.57A7 7 0 0 0 19 11h-2zm-5 7a7 7 0 0 0 3.54-.96l1.46 1.46A8.95 8.95 0 0 1 13 19.93V22h-2v-2.07a8.97 8.97 0 0 1-6-8.48h2a7 7 0 0 0 5 6.55z', 'M3 3l18 18'],
      speaker: ['M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4.03v8.05a4.5 4.5 0 0 0 2.5-4.02zM14 3.23v2.06a7 7 0 0 1 0 13.42v2.06a9 9 0 0 0 0-17.54z'],
      speakerOff: ['M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4.03v8.05a4.5 4.5 0 0 0 2.5-4.02z', 'M17 5l5 5m0-5-5 5'],
    };
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('class', `call-control-icon ${name === 'phone' && variant === 'hangup' ? 'phone-icon' : ''}`);
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('width', '26');
    icon.setAttribute('height', '26');
    icon.setAttribute('aria-hidden', 'true');
    paths[name].forEach((d, index) => {
      const slash = name.endsWith('Off') && index === paths[name].length - 1;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      path.setAttribute('fill', slash ? 'none' : 'currentColor');
      if (slash) {
        path.setAttribute('stroke', 'currentColor');
        path.setAttribute('stroke-width', '2');
        path.setAttribute('stroke-linecap', 'round');
      }
      icon.append(path);
    });
    return icon;
  }
  function callControl(label, icon, variant, onclick, pressed) {
    return el('button', {
      class: `call-control ${variant}`, type: 'button', 'aria-label': label,
      ...(pressed == null ? {} : { 'aria-pressed': String(pressed) }), onclick,
    }, el('span', { class: 'call-control-button' }, callIcon(icon, variant)), el('span', { class: 'call-control-label', text: label }));
  }
  function renderCallOverlay() {
    const overlay = $('#call-overlay'), call = S.call;
    clearInterval(callClock); callClock = null;
    if (!call) { overlay.hidden = true; overlay.replaceChildren(); return; }
    for (const audio of call.remoteAudios?.values() || []) { audio.pause(); audio.srcObject = null; }
    overlay.hidden = false;
    overlay.classList.toggle('incoming-call', call.status === 'incoming');
    overlay.classList.toggle('live-call', call.status === 'active' || call.status === 'connecting');
    overlay.classList.toggle('outgoing-call', call.status === 'calling');
    const participants = [...call.participants.values()];
    const groupCall = call.groupCall || participants.length > 2;
    const title = call.title || participants.find((person) => person.id !== S.me.id)?.name || 'Voice call';
    const avatarPeople = participants.filter((person) => person.status !== 'left').slice(0, 4);
    const avatarWrap = el('div', { class: `call-avatar-wrap${groupCall ? ' group-call-avatars' : ''}` });
    if (groupCall) {
      for (const person of avatarPeople) avatarWrap.append(avatar(person, 'call-avatar'));
    } else {
      avatarWrap.append(avatar(avatarPeople.find((person) => person.id !== S.me.id) || { id: 'call', name: title }, 'call-avatar'));
    }
    const callLabel = call.status === 'incoming'
      ? groupCall ? 'INCOMING GROUP CALL' : 'INCOMING CALL'
      : groupCall ? 'GROUP VOICE CALL' : 'VOICE CALL';
    const remoteAudios = new Map(), audioNodes = [];
    for (const [peerId, stream] of call.remoteStreams) {
      const person = call.participants.get(peerId);
      const audio = el('audio', {
        class: 'call-audio', autoplay: true, playsinline: true,
        'aria-label': `Call audio from ${person?.name || 'participant'}`,
      });
      audio.srcObject = stream;
      audio.volume = call.speakerOn === false ? 0 : 1;
      remoteAudios.set(peerId, audio); audioNodes.push(audio);
    }
    call.remoteAudios = remoteAudios;
    const dialog = el('section', { class: 'call-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'call-title' },
      el('div', { class: 'call-eyebrow' }, el('span', { class: 'call-live-dot' }), el('span', { text: callLabel })),
      avatarWrap,
      el('div', { class: 'call-person' },
        el('h2', { id: 'call-title', text: title }),
        el('p', { id: 'call-status', 'aria-live': 'polite', text: callStatusText(call) })));
    if (groupCall) {
      dialog.append(el('div', { class: 'call-roster', 'aria-label': 'Call participants' },
        ...participants.map((person) => el('div', { class: `call-roster-person ${person.status}` },
          el('span', { class: 'call-roster-name', text: person.id === S.me.id ? 'You' : person.name }),
          el('span', { class: 'call-roster-status', text: callParticipantStatus(person.status) })))));
    }
    dialog.append(...audioNodes);
    if (call.status === 'incoming') {
      dialog.append(el('div', { class: 'call-controls' },
        callControl('Decline', 'phone', 'hangup', declineVoiceCall),
        callControl('Answer', 'phone', 'answer', acceptVoiceCall)));
    } else {
      const controls = el('div', { class: 'call-controls' });
      if (call.localStream) controls.append(callControl(call.muted ? 'Unmute' : 'Mute', call.muted ? 'micOff' : 'mic', call.muted ? 'muted-toggle' : 'toggle', toggleCallMute, call.muted));
      controls.append(callControl(call.speakerOn === false ? 'Speaker off' : 'Speaker on', call.speakerOn === false ? 'speakerOff' : 'speaker', 'speaker-toggle', toggleCallSpeaker, call.speakerOn !== false));
      const anotherParticipantAnswered = participants.some((person) => person.id !== S.me.id && person.status === 'connected');
      if (anotherParticipantAnswered) {
        controls.append(callControl('Add people', 'add', 'invite-toggle', () => openCallInvitePicker(S.chats.get(call.chatId), call)));
      }
      controls.append(callControl(call.role === 'host' ? 'End call' : 'Leave call', 'phone', 'hangup', hangupVoiceCall));
      dialog.append(controls);
      if (call.status === 'calling') dialog.append(el('p', { class: 'call-hint', text: 'You can keep chatting while you wait' }));
    }
    overlay.replaceChildren(dialog);
    for (const audio of remoteAudios.values()) audio.play().catch(() => toast('Tap Speaker to enable call audio'));
    if (call.status === 'active') callClock = setInterval(() => {
      const status = $('#call-status');
      if (status && S.call === call) status.textContent = callStatusText(call);
    }, 1000);
  }
  function finishVoiceCall(action, notifyServer = true) {
    const call = S.call;
    if (!call) return;
    S.call = null;
    if (notifyServer && S.wsOpen) wsSend({ t: 'call', action, callId: call.callId });
    clearInterval(callClock); callClock = null;
    for (const timer of call.peerDisconnectTimers.values()) clearTimeout(timer);
    for (const { pc } of call.peerConnections.values()) {
      pc.ontrack = null; pc.onicecandidate = null; pc.onconnectionstatechange = null; pc.close();
    }
    if (call.localStream) for (const track of call.localStream.getTracks()) track.stop();
    for (const audio of call.remoteAudios.values()) { audio.pause(); audio.srcObject = null; }
    renderCallOverlay();
    if (S.active) renderHeader();
  }
  function hangupVoiceCall() {
    const call = S.call;
    if (!call) return;
    finishVoiceCall(call.role === 'host' ? call.status === 'calling' ? 'cancel' : 'end' : 'leave');
  }
  function declineVoiceCall() { finishVoiceCall('reject'); }
  function toggleCallMute() {
    const call = S.call;
    if (!call?.localStream) return;
    call.muted = !call.muted;
    for (const track of call.localStream.getAudioTracks()) track.enabled = !call.muted;
    renderCallOverlay();
  }
  function toggleCallSpeaker() {
    const call = S.call;
    if (!call) return;
    call.speakerOn = call.speakerOn === false;
    for (const audio of call.remoteAudios.values()) audio.volume = call.speakerOn ? 1 : 0;
    renderCallOverlay();
  }
  async function ensureLocalCallStream(call) {
    if (!window.RTCPeerConnection || !navigator.mediaDevices?.getUserMedia) throw new Error('Voice calling is not supported in this browser');
    if (call.localStream) return call.localStream;
    if (!call.localStreamPromise) {
      call.localStreamPromise = navigator.mediaDevices.getUserMedia({ audio: true, video: false }).then((stream) => {
        if (S.call !== call) { for (const track of stream.getTracks()) track.stop(); return null; }
        call.localStream = stream;
        for (const track of stream.getAudioTracks()) track.enabled = !call.muted;
        renderCallOverlay();
        return stream;
      }).finally(() => { call.localStreamPromise = null; });
    }
    const stream = await call.localStreamPromise;
    if (!stream && S.call === call) throw new Error('Could not access the microphone');
    return stream;
  }
  async function prepareCallPeer(call, peerId) {
    if (call.peerConnections.has(peerId)) return call.peerConnections.get(peerId);
    if (call.peerPromises.has(peerId)) return call.peerPromises.get(peerId);
    const setup = (async () => {
      const stream = await ensureLocalCallStream(call);
      if (!stream || S.call !== call) return null;
      const pc = new RTCPeerConnection({ iceServers: S.iceServers });
      const entry = { pc, pendingIce: [] };
      call.peerConnections.set(peerId, entry);
      for (const track of stream.getTracks()) pc.addTrack(track, stream);
      pc.onicecandidate = (event) => {
        if (event.candidate && S.call === call && !wsSend({
          t: 'call', action: 'signal', callId: call.callId, to: peerId,
          kind: 'ice', candidate: event.candidate.toJSON(),
        })) toast('Call signaling disconnected');
      };
      pc.ontrack = (event) => {
        if (S.call !== call) return;
        call.remoteStreams.set(peerId, event.streams[0] || new MediaStream([event.track]));
        renderCallOverlay();
      };
      pc.onconnectionstatechange = () => {
        if (S.call !== call) return;
        if (pc.connectionState === 'connected') {
          clearTimeout(call.peerDisconnectTimers.get(peerId));
          call.peerDisconnectTimers.delete(peerId);
          call.startedAt ||= Date.now();
          call.status = 'active';
          if (!call.connectedNoticeSent) {
            call.connectedNoticeSent = true;
            if (!wsSend({ t: 'call', action: 'connected', callId: call.callId })) toast('Call signaling disconnected');
          }
          renderCallOverlay();
        } else if (pc.connectionState === 'disconnected') {
          clearTimeout(call.peerDisconnectTimers.get(peerId));
          call.peerDisconnectTimers.set(peerId, setTimeout(() => {
            if (S.call === call && pc.connectionState === 'disconnected') {
              toast('A participant connection was lost');
              closeCallPeer(call, peerId);
            }
          }, 30_000));
        } else if (pc.connectionState === 'failed') {
          toast('Could not connect to a participant');
          closeCallPeer(call, peerId);
        }
      };
      renderCallOverlay();
      return entry;
    })();
    call.peerPromises.set(peerId, setup);
    try { return await setup; }
    finally { call.peerPromises.delete(peerId); }
  }
  function closeCallPeer(call, peerId) {
    const entry = call.peerConnections.get(peerId);
    if (entry) {
      call.peerConnections.delete(peerId);
      entry.pc.ontrack = null; entry.pc.onicecandidate = null; entry.pc.onconnectionstatechange = null;
      entry.pc.close();
    }
    clearTimeout(call.peerDisconnectTimers.get(peerId));
    call.peerDisconnectTimers.delete(peerId);
    call.remoteStreams.delete(peerId);
    if (S.call === call) {
      if (![...call.peerConnections.values()].some((peer) => peer.pc.connectionState === 'connected')) {
        const others = [...call.participants.values()].filter((person) => person.id !== S.me.id
          && (person.status === 'connected' || person.status === 'ringing'));
        call.status = others.some((person) => person.status === 'ringing') || !others.length ? 'calling' : 'connecting';
      }
      renderCallOverlay();
    }
  }
  async function acceptVoiceCall() {
    const call = S.call;
    if (!call || call.status !== 'incoming') return;
    try {
      call.status = 'connecting'; renderCallOverlay();
      await ensureLocalCallStream(call);
      if (S.call !== call || !wsSend({ t: 'call', action: 'accept', callId: call.callId })) {
        if (S.call === call) throw new Error('Call signaling is unavailable');
        return;
      }
      call.status = 'connecting'; renderCallOverlay();
    } catch (e) {
      if (S.call === call) {
        wsSend({ t: 'call', action: 'reject', callId: call.callId });
        finishVoiceCall('', false);
      }
      toast(e.message || 'Could not access the microphone');
    }
  }
  async function sendCallOffer(call, peerId) {
    const peer = await prepareCallPeer(call, peerId);
    if (!peer || S.call !== call) return;
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    if (S.call === call && !wsSend({
      t: 'call', action: 'signal', callId: call.callId, to: peerId,
      kind: 'offer', description: peer.pc.localDescription,
    })) throw new Error('Call signaling is unavailable');
  }
  async function onCallSignal(call, message) {
    let peer = call.peerConnections.get(message.from);
    if (!peer) peer = await prepareCallPeer(call, message.from);
    if (!peer || S.call !== call) return;
    if (message.action === 'ice') {
      if (!peer.pc.remoteDescription) peer.pendingIce.push(message.candidate);
      else await peer.pc.addIceCandidate(new RTCIceCandidate(message.candidate));
      return;
    }
    if (message.action === 'offer') {
      await peer.pc.setRemoteDescription(new RTCSessionDescription(message.description));
      for (const candidate of peer.pendingIce.splice(0)) await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      if (S.call === call && !wsSend({
        t: 'call', action: 'signal', callId: call.callId, to: message.from,
        kind: 'answer', description: peer.pc.localDescription,
      })) throw new Error('Call signaling is unavailable');
    } else if (message.action === 'answer') {
      await peer.pc.setRemoteDescription(new RTCSessionDescription(message.description));
      for (const candidate of peer.pendingIce.splice(0)) await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
    }
  }
  function onCallEvent(message) {
    let call = S.call;
    if (message.action === 'answered') {
      if (call?.callId === message.callId && call.role === 'participant' && call.status === 'incoming') finishVoiceCall('', false);
      return;
    }
    if (message.action === 'incoming') {
      if (call || !Array.isArray(message.participants) || !message.participants.some((person) => person.id === message.from)) {
        wsSend({ t: 'call', action: 'reject', callId: message.callId });
        return;
      }
      call = {
        callId: message.callId, chatId: message.chatId, title: message.title, groupCall: message.groupCall,
        role: 'participant', status: 'incoming', participants: new Map(), peerConnections: new Map(),
        peerPromises: new Map(), peerDisconnectTimers: new Map(), remoteStreams: new Map(), remoteAudios: new Map(),
        muted: false, speakerOn: true, startedAt: 0, connectedNoticeSent: false,
      };
      updateCallParticipants(call, message);
      S.call = call; renderCallOverlay(); if (S.active) renderHeader();
      return;
    }
    if (message.action === 'missed' || message.action === 'ended') {
      if (!call || call.callId !== message.callId) return;
      const text = message.action === 'missed' ? 'Missed voice call'
        : message.from === S.me.id ? ''
          : message.reason === 'connection-lost' ? 'Call ended because the host disconnected' : 'Call ended';
      finishVoiceCall('', false);
      if (text) toast(text);
      return;
    }
    if (!call || call.callId !== message.callId) return;
    if (message.action === 'error') {
      toast(message.error || 'Call could not be completed');
      if (call.role === 'host' && !call.serverStarted) finishVoiceCall('', false);
      return;
    }
    if (message.action === 'ringing' || message.action === 'participants-updated') {
      updateCallParticipants(call, message);
      if (message.action === 'ringing' && call.role === 'host') {
        call.serverStarted = true;
        call.status = 'calling';
      }
      renderCallOverlay();
    } else if (message.action === 'joined') {
      updateCallParticipants(call, message);
      call.status = 'connecting';
      renderCallOverlay();
      ensureLocalCallStream(call).then(() => Promise.all(
        [...call.participants.values()]
          .filter((person) => person.id !== S.me.id && person.status === 'connected')
          .map((person) => sendCallOffer(call, person.id)),
      )).catch((e) => {
        if (S.call === call) { toast(e.message || 'Could not join the voice call'); finishVoiceCall('leave'); }
      });
    } else if (message.action === 'participant-joined') {
      updateCallParticipants(call, message);
      renderCallOverlay();
    } else if (message.action === 'participant-left') {
      updateCallParticipants(call, message);
      closeCallPeer(call, message.from);
      renderCallOverlay();
    } else if (['offer', 'answer', 'ice'].includes(message.action)) {
      onCallSignal(call, message).catch((e) => {
        if (S.call === call) { toast(e.message || 'Call connection failed'); closeCallPeer(call, message.from); }
      });
    }
  }
  function openCallInvitePicker(chat = S.chats.get(S.active), call = S.call) {
    const modal = $('#modal');
    if (!call && !chat) return;
    if (call && ![...call.participants.values()].some((person) => person.id !== S.me.id && person.status === 'connected')) {
      toast('You can add people after someone answers');
      return;
    }
    const activeCount = () => call
      ? [...call.participants.values()].filter((person) => person.status === 'connected' || person.status === 'ringing').length
      : 1;
    if (activeCount() >= 4) { toast('This call already has 4 participants'); return; }
    let users = [], query = '', closed = false, sequence = 0;
    const selected = new Map();
    modal.classList.add('call-invite-modal');
    const close = () => {
      closed = true; clearTimeout(draw.timer); modal.classList.remove('call-invite-modal');
      modal.hidden = true; modal.replaceChildren();
    };
    modal.onclick = (event) => { if (event.target === modal) close(); };
    async function fetchUsers() {
      const request = ++sequence;
      try { users = (await api(`/api/users?q=${encodeURIComponent(query)}`)).users; }
      catch (error) {
        if (!closed && request === sequence) { toast(error.message); users = []; }
      }
      if (!closed && request === sequence) draw();
    }
    function draw() {
      const keepFocus = document.activeElement?.id === 'call-user-search';
      const activeIds = new Set(call
        ? [...call.participants.values()].filter((person) => person.status === 'connected' || person.status === 'ringing').map((person) => person.id)
        : [S.me.id]);
      const slots = Math.max(0, 4 - activeIds.size);
      const body = el('div', { class: 'body call-invite-list' });
      const available = users.filter((user) => !activeIds.has(user.id));
      for (const user of available) {
        const isSelected = selected.has(user.id);
        const item = el('button', {
          class: `item call-invite-option${isSelected ? ' selected' : ''}`, type: 'button',
          'aria-pressed': String(isSelected),
          onclick: () => {
            if (selected.has(user.id)) selected.delete(user.id);
            else if (selected.size < slots) selected.set(user.id, user);
            else { toast(`Choose up to ${slots} people`); return; }
            draw();
          },
        });
        const userAvatar = avatar(user, 'sm');
        if (user.online) userAvatar.append(el('span', { class: 'dot' }));
        item.append(userAvatar,
          el('span', { class: 'call-invite-copy' },
            el('span', { class: 'name', text: user.name }),
            el('span', { class: 'user-status', text: user.online ? 'Online' : lastSeenText(user.lastSeen) })),
          el('span', { class: `check${isSelected ? ' on' : ''}`, text: isSelected ? '✓' : '' }));
        body.append(item);
      }
      if (!available.length) body.append(el('div', { class: 'empty-note', text: query ? 'No matching contacts.' : 'No contacts available to invite.' }));
      const title = call ? 'Add people to call' : chat.type === 'group' ? 'Start group call' : 'Add person to call';
      const search = el('div', { class: 'pad' }, el('input', {
        id: 'call-user-search', type: 'search', placeholder: 'Search contacts', value: query, autocomplete: 'off',
        oninput: (event) => { query = event.target.value; clearTimeout(draw.timer); draw.timer = setTimeout(fetchUsers, 200); },
      }));
      const footer = el('div', { class: 'foot call-invite-footer' },
        el('span', { class: 'sub', text: `${activeIds.size} of 4 participants · choose up to ${slots}` }),
        el('button', {
          class: 'primary', type: 'button', text: call ? `Invite (${selected.size})` : `Start call (${selected.size})`,
          disabled: selected.size === 0,
          onclick: () => {
            const ids = [...selected.keys()];
            if (call) {
              if (S.call !== call || !wsSend({ t: 'call', action: 'add', callId: call.callId, participantIds: ids })) {
                toast('Could not send call invites'); return;
              }
              close(); toast(`Inviting ${ids.length} ${ids.length === 1 ? 'person' : 'people'}`);
            } else {
              close(); startVoiceCall(chat.id, ids);
            }
          },
        }));
      const sheet = el('div', { class: 'sheet call-invite-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        el('div', { class: 'bar' },
          el('div', { class: 'title grow', text: title }),
          el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: close },
            el('span', { text: '×', style: 'font-size:22px' }))),
        search, body, footer);
      modal.replaceChildren(sheet); modal.hidden = false;
      if (!draw.shown || keepFocus) {
        const input = $('#call-user-search');
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
        draw.shown = true;
      }
    }
    draw.shown = false;
    draw();
    fetchUsers();
  }
  function startVoiceCall(chatId = S.active, participantIds = null) {
    const chat = S.chats.get(chatId);
    if (!chat || S.call) return;
    if (chat.type === 'group' && !participantIds) { openCallInvitePicker(chat, null); return; }
    if (!participantIds) participantIds = [otherOf(chat).id];
    if (!participantIds.length || participantIds.length > 3) { toast('Choose up to 3 people to start a call'); return; }
    if (!window.isSecureContext || !window.RTCPeerConnection || !navigator.mediaDevices?.getUserMedia) {
      toast('Voice calling needs a supported browser and a secure connection (HTTPS or localhost)');
      return;
    }
    if (!S.wsOpen) { toast('Connect to chat before starting a call'); return; }
    if (chat.id !== S.active) go(chat.id);
    const participants = new Map([[S.me.id, { id: S.me.id, name: S.me.name, status: 'connected' }]]);
    for (const id of participantIds) {
      const person = chat.members.find((member) => member.id === id) || S.directory.get(id) || { id, name: 'Contact' };
      participants.set(id, { ...person, status: 'ringing' });
    }
    const call = {
      callId: callUuid(), chatId: chat.id,
      title: chat.type === 'group' ? chat.name : participantIds.length > 1 ? 'Group call' : participants.get(participantIds[0]).name,
      groupCall: chat.type === 'group' || participantIds.length > 1, role: 'host', status: 'calling',
      participants, peerConnections: new Map(), peerPromises: new Map(), peerDisconnectTimers: new Map(),
      remoteStreams: new Map(), remoteAudios: new Map(), muted: false, speakerOn: true,
      startedAt: 0, connectedNoticeSent: false, serverStarted: false,
    };
    S.call = call; renderCallOverlay(); renderHeader();
    if (!wsSend({ t: 'call', action: 'invite', callId: call.callId, chatId: call.chatId, participantIds })) {
      finishVoiceCall('', false); toast('Could not start the voice call');
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
    const user = S.directory.get(userId);
    if (user) {
      user.online = online; user.lastSeen = lastSeen;
      S.renderDirectory?.();
    }
    renderList(); if (S.active) renderHeader();
  }
  function onMessageUpdate(msg) {
    const arr = S.msgs.get(msg.chatId);
    if (arr) {
      const index = arr.findIndex((m) => m.id === msg.id);
      if (index >= 0) arr[index] = msg;
    }
    const chat = S.chats.get(msg.chatId);
    if (chat?.last?.id === msg.id) chat.last = msg;
    renderList();
    if (S.active === msg.chatId) renderMessages({});
  }
  function onMessageDeleted({ chatId, messageId, chat }) {
    if (chat) S.chats.set(chatId, chat);
    const arr = S.msgs.get(chatId);
    if (arr) S.msgs.set(chatId, arr.filter((msg) => msg.id !== messageId));
    if (S.replyTo?.id === messageId) clearReplyTarget();
    renderList();
    if (S.active === chatId) renderMessages({});
  }
  async function toggleReaction(chatId, messageId, emoji) {
    try {
      const { message } = await api(`/api/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}/reactions`, {
        method: 'POST', body: { emoji },
      });
      onMessageUpdate(message);
    } catch (e) { toast(e.message); }
  }
  function showSheet(title, body, className = '') {
    const modal = $('#modal');
    const close = () => {
      modal.hidden = true;
      modal.classList.remove('action-modal');
      modal.onclick = null;
      modal.replaceChildren();
    };
    modal.classList.add('action-modal');
    modal.onclick = (e) => { if (e.target === modal) close(); };
    const sheet = el('div', {
      class: `sheet action-sheet ${className}`.trim(), role: 'dialog', 'aria-modal': 'true', 'aria-label': title,
    },
    el('div', { class: 'bar' },
      el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: close }, el('span', { text: '×', style: 'font-size:20px' })),
      el('div', { class: 'title grow', text: title })),
    body);
    modal.replaceChildren(sheet);
    modal.hidden = false;
    return close;
  }
  function clearReplyTarget() {
    S.replyTo = null;
    $('#reply-preview').hidden = true;
  }
  function setReplyTarget(chatId, msg) {
    const chat = S.chats.get(chatId);
    if (!chat) return;
    S.replyTo = {
      chatId, id: msg.id, from: msg.from, text: msg.text || '',
      attachment: msg.attachment ? { name: msg.attachment.name } : null,
    };
    $('#reply-name').textContent = msg.from === S.me.id ? 'Reply to yourself' : `Reply to ${memberName(chat, msg.from)}`;
    $('#reply-text').textContent = msg.attachment ? `📎 ${msg.attachment.name}` : msg.text || 'Message';
    $('#reply-preview').hidden = false;
    $('#input').focus();
  }
  async function copyMessage(msg) {
    const text = msg.text || msg.attachment?.name || '';
    if (!text) { toast('Nothing to copy'); return; }
    if (!navigator.clipboard?.writeText) { toast('Clipboard access is unavailable'); return; }
    try { await navigator.clipboard.writeText(text); toast('Copied to clipboard'); }
    catch (e) { console.error(e); toast('Could not copy message'); }
  }
  function openEditMessage(chatId, msg) {
    const textarea = el('textarea', { class: 'edit-text', rows: '5', maxlength: String(MAX_TEXT), text: msg.text });
    let close = () => {};
    const form = el('form', {
      class: 'edit-form',
      onsubmit: async (e) => {
        e.preventDefault();
        const text = textarea.value.trim();
        if (!text) { toast('Message cannot be empty'); textarea.focus(); return; }
        try {
          const { message } = await api(`/api/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(msg.id)}`, {
            method: 'PATCH', body: { text },
          });
          close(); onMessageUpdate(message);
        } catch (err) { toast(err.message); }
      },
    },
    textarea,
    el('div', { class: 'edit-actions' },
      el('button', { class: 'action-button', type: 'button', text: 'Cancel', onclick: () => close() }),
      el('button', { class: 'action-button primary-action', type: 'submit', text: 'Save' })));
    close = showSheet('Edit message', form, 'edit-sheet');
    textarea.focus();
  }
  function openDeleteMessage(chatId, msg) {
    const body = el('div', { class: 'delete-prompt' },
      el('p', { text: 'Choose who should no longer see this message.' }),
      el('div', { class: 'delete-options' },
        el('button', { class: 'message-action delete-action', type: 'button', text: 'Delete for me', onclick: async () => {
          close();
          try {
            const { chat } = await api(`/api/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(msg.id)}`, {
              method: 'DELETE', body: { forEveryone: false },
            });
            onMessageDeleted({ chatId, messageId: msg.id, chat });
          } catch (e) { toast(e.message); }
        } }),
        ...(msg.from === S.me.id ? [el('button', {
          class: 'message-action delete-action', type: 'button', text: 'Delete for everyone', onclick: async () => {
            close();
            try {
              const { chat } = await api(`/api/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(msg.id)}`, {
                method: 'DELETE', body: { forEveryone: true },
              });
              onMessageDeleted({ chatId, messageId: msg.id, chat });
            } catch (e) { toast(e.message); }
          },
        })] : []),
        el('button', { class: 'action-button', type: 'button', text: 'Cancel', onclick: () => close() })));
    let close = () => {};
    close = showSheet('Delete message', body, 'delete-sheet');
  }
  function openForwardPicker(sourceChatId, msg) {
    const body = el('div', { class: 'forward-list' });
    const destinations = [...S.chats.values()].filter((chat) => chat.id !== sourceChatId);
    if (!destinations.length) body.append(el('div', { class: 'empty-note', text: 'No other chats to forward to.' }));
    let close = () => {};
    for (const chat of destinations) {
      body.append(el('button', {
        class: 'forward-item', type: 'button',
        onclick: async () => {
          close();
          try {
            const { message } = await api(`/api/chats/${encodeURIComponent(chat.id)}/forward`, {
              method: 'POST', body: { sourceChatId, messageId: msg.id },
            });
            onMessage(message); toast('Message forwarded');
          } catch (e) { toast(e.message); }
        },
      }, avatar(chatAvatarUser(chat), 'sm'), el('span', { class: 'name', text: chatName(chat) })));
    }
    close = showSheet('Forward message', body, 'forward-sheet');
  }
  function openMessageActions(chatId, msg) {
    const body = el('div', { class: 'message-action-list' });
    let close = () => {};
    const addAction = (label, action, className = '') => body.append(el('button', {
      class: `message-action ${className}`.trim(), type: 'button', text: label,
      onclick: () => { close(); action(); },
    }));
    addAction('Reply', () => setReplyTarget(chatId, msg));
    addAction('Forward', () => openForwardPicker(chatId, msg));
    addAction('Copy', () => copyMessage(msg));
    if (msg.from === S.me.id && !msg.attachment && msg.text) addAction('Edit', () => openEditMessage(chatId, msg));
    addAction('Delete', () => openDeleteMessage(chatId, msg), 'delete-action');
    const reactions = el('div', { class: 'action-reactions' }, el('div', { class: 'action-section-title', text: 'React' }));
    for (const emoji of REACTIONS) {
      reactions.append(el('button', {
        class: 'action-reaction', type: 'button', 'aria-label': `React with ${emoji}`,
        onclick: () => { close(); toggleReaction(chatId, msg.id, emoji); },
      }, el('span', { text: emoji })));
    }
    body.append(reactions);
    close = showSheet('Message options', body);
  }

  /* ───────── sending ───────── */
  function sendMessage(text) {
    text = text.trim();
    const chat = S.chats.get(S.active);
    if (!text || !chat) return false;
    const cid = uid();
    const replyTo = S.replyTo ? {
      id: S.replyTo.id, from: S.replyTo.from, text: S.replyTo.text,
      attachment: S.replyTo.attachment ? { name: S.replyTo.attachment.name } : null,
    } : null;
    const m = { id: 'p_' + cid, cid, chatId: chat.id, from: S.me.id, text, replyTo, ts: Date.now(), deliveredTo: [], readBy: [], pending: true };
    const arr = S.msgs.get(chat.id) || []; arr.push(m); S.msgs.set(chat.id, arr);
    chat.last = m;
    S.outbox.push({ t: 'send', chatId: chat.id, text, cid, ...(replyTo ? { replyTo: replyTo.id } : {}) });
    flushOutbox();
    renderList(); renderMessages({ stick: true });
    return true;
  }
  function stopVoiceStream() {
    if (!voiceStream) return;
    for (const track of voiceStream.getTracks()) track.stop();
    voiceStream = null;
  }
  function setVoiceButton(recording) {
    const button = $('#btn-voice');
    button.classList.toggle('recording', recording);
    button.disabled = !recording && Boolean(voiceBlob);
    button.setAttribute('aria-label', recording ? 'Stop recording' : 'Record voice note');
    button.title = recording ? 'Stop recording' : 'Record voice note';
    button.innerHTML = recording ? STOP_ICON : MIC_ICON;
  }
  function resetVoiceDraft() {
    clearInterval(voiceTimer);
    voiceTimer = null;
    stopVoiceStream();
    if (voiceUrl) URL.revokeObjectURL(voiceUrl);
    voiceUrl = null;
    voiceBlob = null;
    voiceRecorder = null;
    voiceChunks = [];
    voiceSize = 0;
    discardVoiceRecording = false;
    const preview = $('#voice-preview');
    preview.replaceChildren();
    preview.hidden = true;
    setVoiceButton(false);
  }
  function discardVoiceNote() {
    clearInterval(voiceTimer);
    voiceTimer = null;
    if (voiceRecorder && !voiceBlob) {
      discardVoiceRecording = true;
      if (voiceRecorder.state !== 'inactive') voiceRecorder.stop();
      stopVoiceStream();
      return;
    }
    resetVoiceDraft();
  }
  async function sendVoiceNote(button) {
    if (!voiceBlob) return;
    const chat = S.chats.get(S.active);
    if (!chat) { toast('Open a chat before sending a voice note'); return; }
    const blob = voiceBlob;
    const type = blob.type.split(';')[0].toLowerCase();
    if (!VOICE_TYPES.has(type)) { toast('This browser recorded an unsupported audio format'); return; }
    const replyTo = S.replyTo?.chatId === chat.id ? S.replyTo.id : null;
    button.disabled = true;
    try {
      const { message } = await api(`/api/chats/${encodeURIComponent(chat.id)}/voice-notes`, {
        method: 'POST', rawBody: true,
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Voice-Type': type,
          ...(replyTo ? { 'X-Reply-To': replyTo } : {}),
        },
        body: blob,
      });
      onMessage(message);
      if (replyTo && S.replyTo?.id === replyTo) clearReplyTarget();
      resetVoiceDraft();
    } catch (e) { toast(e.message); }
    finally { button.disabled = false; }
  }
  async function startVoiceRecording() {
    if (!S.active) { toast('Open a chat before recording a voice note'); return; }
    if (voiceBlob) { toast('Send or cancel the current voice note first'); return; }
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      toast('Voice recording is not supported in this browser');
      return;
    }
    try {
      voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = typeof MediaRecorder.isTypeSupported === 'function'
        ? VOICE_MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type))
        : '';
      voiceRecorder = mimeType ? new MediaRecorder(voiceStream, { mimeType }) : new MediaRecorder(voiceStream);
      const recorder = voiceRecorder;
      voiceChunks = [];
      voiceSize = 0;
      discardVoiceRecording = false;
      voiceStartedAt = Date.now();
      const elapsed = el('span', { class: 'voice-elapsed', text: '0:00' });
      const preview = $('#voice-preview');
      preview.replaceChildren(
        el('span', { class: 'recording-dot', 'aria-hidden': 'true' }),
        el('span', { class: 'recording-label', text: 'Recording' }),
        elapsed,
        el('button', { class: 'action-button', type: 'button', text: 'Cancel', onclick: discardVoiceNote }),
      );
      preview.hidden = false;
      voiceTimer = setInterval(() => {
        const seconds = Math.floor((Date.now() - voiceStartedAt) / 1000);
        elapsed.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
      }, 250);
      recorder.ondataavailable = (event) => {
        if (!event.data.size) return;
        voiceChunks.push(event.data);
        voiceSize += event.data.size;
        if (voiceSize > MAX_FILE_BYTES && !discardVoiceRecording) {
          toast('Voice note reached the 10 MB limit');
          discardVoiceNote();
        }
      };
      recorder.onerror = (event) => {
        console.error(event.error || event);
        toast('Voice recording failed');
        discardVoiceNote();
      };
      recorder.onstop = () => {
        clearInterval(voiceTimer);
        voiceTimer = null;
        stopVoiceStream();
        if (discardVoiceRecording) { resetVoiceDraft(); return; }
        const chunkType = voiceChunks.find((chunk) => chunk.type)?.type || '';
        const type = (recorder.mimeType || chunkType).split(';')[0].toLowerCase();
        if (!VOICE_TYPES.has(type)) {
          toast('This browser recorded an unsupported audio format');
          resetVoiceDraft();
          return;
        }
        voiceBlob = new Blob(voiceChunks, { type });
        if (!voiceBlob.size) {
          toast('No audio was recorded');
          resetVoiceDraft();
          return;
        }
        voiceUrl = URL.createObjectURL(voiceBlob);
        const audio = createVoicePlayer(voiceUrl, 'voice note preview');
        const send = el('button', { class: 'action-button primary-action', type: 'button', text: 'Send', onclick: () => sendVoiceNote(send) });
        const actions = el('div', { class: 'voice-draft-actions' },
          el('button', { class: 'action-button', type: 'button', text: 'Cancel', onclick: discardVoiceNote }),
          send);
        preview.replaceChildren(audio, actions);
        preview.hidden = false;
        setVoiceButton(false);
      };
      recorder.start(1000);
      setVoiceButton(true);
    } catch (e) {
      resetVoiceDraft();
      toast(e.name === 'NotAllowedError' ? 'Microphone permission was denied' : e.message || 'Could not start recording');
    }
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
    const preview = msg.attachment ? `📎 ${msg.attachment.name}` : msg.text.slice(0, 140);
    const body = (chat.type === 'group' ? `${memberName(chat, msg.from)}: ` : '') + preview;
    const opts = { body, tag: chat.id, icon: '/icons/icon-192.png', data: { chatId: chat.id } };
    if (navigator.serviceWorker?.controller) navigator.serviceWorker.ready.then((r) => r.showNotification(title, opts));
    else { const n = new Notification(title, opts); n.onclick = () => { window.focus(); go(chat.id); n.close(); }; }
  }

  /* ───────── modal: new chat / group ───────── */
  function openNewChat() {
    const modal = $('#modal');
    let mode = 'pick', users = [], selected = new Map(), q = '', closed = false, seq = 0;
    const close = () => {
      closed = true; clearTimeout(draw.t); S.renderDirectory = null; S.refreshDirectory = null; S.directory.clear();
      modal.hidden = true; modal.replaceChildren();
    };
    modal.onclick = (e) => { if (e.target === modal) close(); };

    async function fetchUsers() {
      const mine = ++seq; // ignore out-of-order responses and anything that lands after the dialog closed
      let res = [];
      try { res = (await api(`/api/users?q=${encodeURIComponent(q)}`)).users; } catch { res = []; }
      if (closed || mine !== seq) return;
      users = res;
      S.directory = new Map(users.map((u) => [u.id, u]));
      draw();
    }
    async function startDirect(u) {
      try {
        const { chat } = await api('/api/chats', { method: 'POST', body: { type: 'direct', userId: u.id } });
        S.chats.set(chat.id, chat);
        close(); go(chat.id);
      } catch (e) { toast(e.message); }
    }
    async function createGroup(name) {
      try {
        const { chat } = await api('/api/chats', { method: 'POST', body: { type: 'group', name, members: [...selected.keys()] } });
        S.chats.set(chat.id, chat); close(); go(chat.id);
      } catch (e) { toast(e.message); }
    }
    const row = (u, onclick, withCheck) => {
      const av = avatar(u, 'sm');
      if (u.online) av.append(el('span', { class: 'dot' }));
      return el('div', { class: 'item', onclick },
        av,
        el('div', {}, el('div', { class: 'name', text: u.name }),
          el('div', { class: 'user-status', text: u.online ? 'online' : lastSeenText(u.lastSeen) })),
        withCheck ? el('div', { class: 'check' + (selected.has(u.id) ? ' on' : ''), text: selected.has(u.id) ? '✓' : '' }) : null);
    };

    function draw() {
      const keepFocus = document.activeElement?.id === 'u-search';
      const title = mode === 'pick' ? 'New chat' : 'New group';
      const search = el('div', { class: 'pad' }, el('input', {
        id: 'u-search', type: 'search', placeholder: 'Search people by name', value: q, autocomplete: 'off',
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
    S.renderDirectory = draw;
    S.refreshDirectory = fetchUsers;
    fetchUsers();
  }

  /* ───────── init ───────── */
  function bindUI() {
    $('#btn-new').onclick = openNewChat;
    $('#btn-back').onclick = () => go('');
    $('#btn-call').onclick = () => startVoiceCall();
    $('#filter').oninput = (e) => { S.filter = e.target.value; renderList(); };
    $('#call-filter').oninput = (e) => { S.filter = e.target.value; renderCallHistory(); };
    $('#nav-chats').onclick = () => setSidebarView('chats');
    $('#nav-calls').onclick = () => setSidebarView('calls');
    $('#mobile-nav-chats').onclick = () => setSidebarView('chats');
    $('#mobile-nav-calls').onclick = () => setSidebarView('calls');
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
    const fileInput = $('#file-input');
    $('#btn-attach').addEventListener('pointerdown', (e) => e.preventDefault());
    $('#btn-attach').addEventListener('click', () => fileInput.click());
    const voiceButton = $('#btn-voice');
    voiceButton.addEventListener('pointerdown', (e) => e.preventDefault());
    voiceButton.addEventListener('click', () => {
      if (voiceRecorder?.state === 'recording') voiceRecorder.stop();
      else void startVoiceRecording();
    });
    fileInput.addEventListener('change', async () => {
      const files = [...fileInput.files];
      fileInput.value = '';
      const chat = S.chats.get(S.active);
      if (!chat) return;
      const replyTo = S.replyTo?.chatId === chat.id ? S.replyTo.id : null;
      for (const file of files) {
        if (file.size > MAX_FILE_BYTES) { toast(`${file.name}: maximum file size is 10 MB`); continue; }
        if (file.type && !file.type.startsWith('image/')) { toast(`${file.name}: choose an image`); continue; }
        try {
          const { message } = await api(`/api/chats/${encodeURIComponent(chat.id)}/files`, {
            method: 'POST', rawBody: true,
            headers: { 'X-File-Name': encodeURIComponent(file.name), ...(replyTo ? { 'X-Reply-To': replyTo } : {}) },
            body: file,
          });
          onMessage(message);
          if (replyTo && S.replyTo?.id === replyTo) clearReplyTarget();
        } catch (e) { toast(`${file.name}: ${e.message}`); }
      }
    });
    $('#btn-cancel-reply').onclick = clearReplyTarget;
    const emojiButton = $('#btn-emoji'), emojiPicker = $('#emoji-picker');
    const closeEmojiPicker = () => { emojiPicker.hidden = true; emojiButton.setAttribute('aria-expanded', 'false'); };
    const insertEmoji = (emoji) => {
      const start = input.selectionStart, end = input.selectionEnd;
      const value = input.value.slice(0, start) + emoji + input.value.slice(end);
      if (value.length > input.maxLength) { toast('Message limit reached'); return; }
      input.value = value;
      input.focus();
      input.setSelectionRange(start + emoji.length, start + emoji.length);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    for (const emoji of EMOJIS) {
      emojiPicker.append(el('button', {
        class: 'emoji-option', type: 'button', 'aria-label': `Insert ${emoji}`, text: emoji,
        onclick: () => insertEmoji(emoji),
      }));
    }
    emojiButton.addEventListener('pointerdown', (e) => e.preventDefault());
    emojiButton.addEventListener('click', () => {
      const open = emojiPicker.hidden;
      emojiPicker.hidden = !open;
      emojiButton.setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('click', (e) => {
      if (!emojiPicker.hidden && !emojiPicker.contains(e.target) && e.target !== emojiButton) closeEmojiPicker();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !emojiPicker.hidden) {
        e.preventDefault(); closeEmojiPicker(); emojiButton.focus();
      }
    });
    input.addEventListener('input', () => { fit(); if (input.value.trim()) typingPing(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(pointer: fine)').matches) { e.preventDefault(); form.requestSubmit(); }
    });
    $('#btn-send').addEventListener('pointerdown', (e) => e.preventDefault()); // keep keyboard open on mobile
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (sendMessage(input.value)) { input.value = ''; fit(); clearReplyTarget(); }
      closeEmojiPicker();
    });

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
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      resync().catch(console.error);
      S.refreshDirectory?.();
    });
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
    S.iceServers = (await api('/api/rtc-config')).iceServers;
    S.me = user;
    const me = avatar(user); me.id = 'me'; me.classList.add('sm');
    $('#me').replaceWith(me);
    $('#menu-who').textContent = user.name;
    bindUI();
    await loadChats();
    await route();
    setConn(false);
    connect();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  init().catch((e) => { console.error(e); });
})();
