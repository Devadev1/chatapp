'use strict';
/*
 * ChatApp server — zero dependencies (Node 18+).
 *  - OpenID Connect (SSO) login: authorization-code flow + PKCE, ID-token signature verification
 *  - Signed, HttpOnly session cookies
 *  - Hand-rolled RFC 6455 WebSocket for real-time messaging, receipts, typing, presence
 *  - JSON-file persistence (swap for a real DB before scaling out)
 */
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// ───────────────────────────── config ─────────────────────────────
const PORT = Number(process.env.PORT) || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const IS_HTTPS = BASE_URL.startsWith('https://');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC = path.join(__dirname, 'public');

const OIDC_ISSUER = (process.env.OIDC_ISSUER || 'https://accounts.google.com').replace(/\/$/, '');
const OIDC_CLIENT_ID = process.env.OIDC_CLIENT_ID || '';
const OIDC_CLIENT_SECRET = process.env.OIDC_CLIENT_SECRET || '';
const OIDC_SCOPES = process.env.OIDC_SCOPES || 'openid email profile';
const OIDC_NAME = process.env.OIDC_NAME || 'SSO';
const OIDC_ENABLED = Boolean(OIDC_CLIENT_ID);
// Demo login (no real SSO). Defaults ON only when no OIDC client is configured. Never use in production.
const DEV_LOGIN = process.env.DEV_LOGIN ? process.env.DEV_LOGIN === '1' : !OIDC_ENABLED;
const ALLOWED_DOMAINS = (process.env.ALLOWED_EMAIL_DOMAINS || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const MAX_TEXT = 4000;
const MAX_WS_PAYLOAD = 64 * 1024;
const SESSION_TTL = 30 * 24 * 3600 * 1000;

fs.mkdirSync(DATA_DIR, { recursive: true });

let SECRET = process.env.SESSION_SECRET;
if (!SECRET) {
  const f = path.join(DATA_DIR, 'secret.key');
  try { SECRET = fs.readFileSync(f, 'utf8').trim(); } catch {
    SECRET = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(f, SECRET, { mode: 0o600 });
  }
}

// ───────────────────────────── helpers ─────────────────────────────
const now = () => Date.now();
const rand = (n = 16) => crypto.randomBytes(n).toString('base64url');
const b64d = (s) => Buffer.from(s, 'base64url').toString('utf8');

function hmac(data) { return crypto.createHmac('sha256', SECRET).update(data).digest('base64url'); }
function sign(obj) {
  const p = Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${p}.${hmac(p)}`;
}
function unsign(tok) {
  if (typeof tok !== 'string') return null;
  const i = tok.indexOf('.');
  if (i < 0) return null;
  const p = tok.slice(0, i);
  const a = Buffer.from(tok.slice(i + 1));
  const b = Buffer.from(hmac(p));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const o = JSON.parse(b64d(p));
    if (o.exp && o.exp < now()) return null;
    return o;
  } catch { return null; }
}
function parseCookies(h) {
  const out = {};
  for (const part of (h || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const SID = IS_HTTPS ? '__Host-sid' : 'sid';
const OIDC_COOKIE = IS_HTTPS ? '__Host-oidc' : 'oidc';
function setCookie(res, name, value, maxAgeSec) {
  const attrs = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (IS_HTTPS) attrs.push('Secure');
  res.appendHeader('Set-Cookie', attrs.join('; '));
}
const clearCookie = (res, name) => setCookie(res, name, '', 0);

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function redirect(res, to) { res.writeHead(302, { Location: to, 'Cache-Control': 'no-store' }); res.end(); }
function readBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('payload too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJSON(req) {
  const b = await readBody(req);
  try { return JSON.parse(b.toString('utf8') || '{}'); } catch { throw Object.assign(new Error('bad json'), { status: 400 }); }
}
function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true; // non-browser or same-origin GET
  try { return new URL(o).host === req.headers.host || o === BASE_URL; } catch { return false; }
}

// ───────────────────────────── storage ─────────────────────────────
const DB_FILE = path.join(DATA_DIR, 'db.json');
let db = { users: {}, chats: {}, messages: {} };
try { db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; } catch { /* first run */ }

const userByKey = new Map(Object.values(db.users).map((u) => [u.key, u]));
const directIndex = new Map();
for (const c of Object.values(db.chats)) if (c.type === 'direct') directIndex.set([...c.members].sort().join('|'), c.id);

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(flush, 250);
}
function flush() {
  clearTimeout(saveTimer); saveTimer = null;
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { flush(); process.exit(0); });

// ───────────────────────────── views ─────────────────────────────
const conns = new Map(); // userId -> Set<WS>
const isOnline = (id) => (conns.get(id)?.size || 0) > 0;
const pub = (u) => ({ id: u.id, name: u.name, email: u.email, picture: u.picture || null, online: isOnline(u.id), lastSeen: u.lastSeen || null });

function chatView(chat, uid) {
  const msgs = db.messages[chat.id] || [];
  let unread = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.from === uid) continue;
    if (m.readBy.includes(uid)) break;
    unread++;
  }
  return {
    id: chat.id, type: chat.type, name: chat.name || null, createdAt: chat.createdAt, createdBy: chat.createdBy,
    members: chat.members.map((id) => db.users[id]).filter(Boolean).map(pub),
    last: msgs[msgs.length - 1] || null,
    unread,
  };
}
function sendTo(userId, obj, except) {
  const set = conns.get(userId);
  if (!set) return;
  const data = JSON.stringify(obj);
  for (const w of set) if (w !== except) w.send(data);
}
function broadcastPresence(u) {
  const ev = { t: 'presence', userId: u.id, online: isOnline(u.id), lastSeen: u.lastSeen || null };
  for (const id of conns.keys()) if (id !== u.id) sendTo(id, ev);
}

// ───────────────────────────── receipts ─────────────────────────────
function mark(userId, kind, onlyChat) {
  // kind: 'delivered' | 'read'. Walk each chat from the newest message backwards; stop at first already-marked one.
  const notices = new Map(); // `${chatId}|${sender}` -> ids
  for (const chat of Object.values(db.chats)) {
    if (!chat.members.includes(userId)) continue;
    if (onlyChat && chat.id !== onlyChat) continue;
    const msgs = db.messages[chat.id] || [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.from === userId) continue;
      const list = kind === 'read' ? m.readBy : m.deliveredTo;
      if (list.includes(userId)) break;
      list.push(userId);
      if (kind === 'read' && !m.deliveredTo.includes(userId)) m.deliveredTo.push(userId);
      const k = `${chat.id}|${m.from}`;
      if (!notices.has(k)) notices.set(k, []);
      notices.get(k).push(m.id);
    }
  }
  if (!notices.size) return;
  save();
  for (const [k, ids] of notices) {
    const [chatId, sender] = k.split('|');
    sendTo(sender, { t: 'receipts', kind, chatId, userId, ids });
  }
}

// ───────────────────────────── chat ops ─────────────────────────────
const recent = new Map(); // `${uid}:${cid}` -> message (idempotent retries)
function remember(key, msg) {
  recent.set(key, msg);
  if (recent.size > 5000) recent.delete(recent.keys().next().value);
}

function postMessage(user, ws, { chatId, text, cid }) {
  const chat = db.chats[chatId];
  if (!chat || !chat.members.includes(user.id)) return ws.send(JSON.stringify({ t: 'error', cid, error: 'not a member' }));
  if (typeof text !== 'string') return;
  text = text.replace(/\r\n/g, '\n').trim();
  if (!text || text.length > MAX_TEXT) return ws.send(JSON.stringify({ t: 'error', cid, error: 'invalid message' }));

  const key = cid ? `${user.id}:${cid}` : null;
  let msg = key && recent.get(key);
  const duplicate = Boolean(msg);
  if (!msg) {
    msg = { id: crypto.randomUUID(), chatId, from: user.id, text, ts: now(), deliveredTo: [], readBy: [] };
    for (const id of chat.members) if (id !== user.id && isOnline(id)) msg.deliveredTo.push(id);
    (db.messages[chatId] ||= []).push(msg);
    if (key) remember(key, msg);
    save();
  }
  ws.send(JSON.stringify({ t: 'message', msg, cid }));
  if (duplicate) return;
  sendTo(user.id, { t: 'message', msg }, ws);
  for (const id of chat.members) if (id !== user.id) sendTo(id, { t: 'message', msg });
}

function createChat(user, body) {
  if (body.type === 'direct') {
    const other = db.users[body.userId];
    if (!other || other.id === user.id) throw Object.assign(new Error('invalid user'), { status: 400 });
    const key = [user.id, other.id].sort().join('|');
    const existing = directIndex.get(key);
    if (existing) return { chat: db.chats[existing], created: false };
    const chat = { id: crypto.randomUUID(), type: 'direct', members: [user.id, other.id], createdBy: user.id, createdAt: now() };
    db.chats[chat.id] = chat; db.messages[chat.id] = []; directIndex.set(key, chat.id); save();
    return { chat, created: true };
  }
  if (body.type === 'group') {
    const name = String(body.name || '').trim().slice(0, 60);
    const ids = [...new Set([user.id, ...(Array.isArray(body.members) ? body.members : [])])].filter((id) => db.users[id]);
    if (!name) throw Object.assign(new Error('group name required'), { status: 400 });
    if (ids.length < 3) throw Object.assign(new Error('pick at least 2 other people'), { status: 400 });
    if (ids.length > 256) throw Object.assign(new Error('too many members'), { status: 400 });
    const chat = { id: crypto.randomUUID(), type: 'group', name, members: ids, createdBy: user.id, createdAt: now() };
    db.chats[chat.id] = chat; db.messages[chat.id] = []; save();
    return { chat, created: true };
  }
  throw Object.assign(new Error('bad type'), { status: 400 });
}

// ───────────────────────────── OIDC ─────────────────────────────
let discoveryCache = { at: 0, cfg: null };
let jwksCache = { at: 0, uri: '', keys: [] };
const fetchJSON = async (url, opts = {}) => {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
};
async function discover() {
  if (discoveryCache.cfg && now() - discoveryCache.at < 3600_000) return discoveryCache.cfg;
  const cfg = await fetchJSON(`${OIDC_ISSUER}/.well-known/openid-configuration`);
  discoveryCache = { at: now(), cfg };
  return cfg;
}
async function getJwks(uri, force) {
  if (!force && jwksCache.uri === uri && now() - jwksCache.at < 3600_000) return jwksCache.keys;
  const { keys } = await fetchJSON(uri);
  jwksCache = { at: now(), uri, keys: keys || [] };
  return jwksCache.keys;
}
const HASH = { 256: 'sha256', 384: 'sha384', 512: 'sha512' };
async function verifyIdToken(idt, cfg, expectedNonce) {
  const parts = String(idt).split('.');
  if (parts.length !== 3) throw new Error('malformed id_token');
  const header = JSON.parse(b64d(parts[0]));
  const claims = JSON.parse(b64d(parts[1]));
  const alg = String(header.alg || '');
  if (!/^(RS|PS|ES)(256|384|512)$/.test(alg)) throw new Error(`unsupported id_token alg ${alg}`);

  let keys = await getJwks(cfg.jwks_uri, false);
  const pick = (ks) => ks.find((k) => (header.kid ? k.kid === header.kid : true) && (!k.use || k.use === 'sig'));
  let jwk = pick(keys);
  if (!jwk) { keys = await getJwks(cfg.jwks_uri, true); jwk = pick(keys); }
  if (!jwk) throw new Error('signing key not found');
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const data = Buffer.from(`${parts[0]}.${parts[1]}`);
  const sig = Buffer.from(parts[2], 'base64url');
  const h = HASH[alg.slice(2)];
  let ok;
  if (alg.startsWith('RS')) ok = crypto.verify(h, data, key, sig);
  else if (alg.startsWith('PS')) ok = crypto.verify(h, data, { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST }, sig);
  else ok = crypto.verify(h, data, { key, dsaEncoding: 'ieee-p1363' }, sig);
  if (!ok) throw new Error('bad id_token signature');

  const expectedIss = String(cfg.issuer || '').replace('{tenantid}', claims.tid || '');
  if (claims.iss !== expectedIss) throw new Error('issuer mismatch');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(OIDC_CLIENT_ID)) throw new Error('audience mismatch');
  if (!claims.exp || claims.exp * 1000 < now() - 60_000) throw new Error('id_token expired');
  if (claims.nonce !== expectedNonce) throw new Error('nonce mismatch');
  return claims;
}

function upsertUser({ key, name, email, picture }) {
  let u = userByKey.get(key);
  if (!u) {
    u = { id: crypto.randomUUID(), key, createdAt: now() };
    db.users[u.id] = u; userByKey.set(key, u);
  }
  u.name = name; u.email = email; u.picture = picture || null;
  save();
  return u;
}
function upsertDemoUser(name) {
  const key = `dev|${name.toLowerCase()}`;
  let existing = userByKey.get(key);
  if (!existing) {
    existing = Object.values(db.users).find((u) => u.key?.startsWith('dev|') && u.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      userByKey.delete(existing.key);
      existing.key = key;
      userByKey.set(key, existing);
    }
  }
  return upsertUser({ key, name, email: existing?.email || null, picture: existing?.picture || null });
}
function startSession(res, user) {
  setCookie(res, SID, sign({ uid: user.id, exp: now() + SESSION_TTL }), SESSION_TTL / 1000);
}
function getSession(req) {
  const o = unsign(parseCookies(req.headers.cookie)[SID]);
  return o && db.users[o.uid] ? db.users[o.uid] : null;
}
function emailAllowed(email) {
  if (!ALLOWED_DOMAINS.length) return true;
  return ALLOWED_DOMAINS.includes(String(email).split('@').pop().toLowerCase());
}

async function authRoutes(req, res, url) {
  const p = url.pathname;
  if (p === '/auth/config' && req.method === 'GET') {
    return json(res, 200, { sso: OIDC_ENABLED, providerName: OIDC_NAME, dev: DEV_LOGIN });
  }
  if (p === '/auth/login' && req.method === 'GET') {
    if (!OIDC_ENABLED) return redirect(res, '/login');
    const cfg = await discover();
    const state = rand(), nonce = rand(), verifier = rand(32);
    setCookie(res, OIDC_COOKIE, sign({ state, nonce, verifier, exp: now() + 10 * 60_000 }), 600);
    const u = new URL(cfg.authorization_endpoint);
    u.search = new URLSearchParams({
      response_type: 'code', client_id: OIDC_CLIENT_ID, redirect_uri: `${BASE_URL}/auth/callback`,
      scope: OIDC_SCOPES, state, nonce,
      code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    }).toString();
    return redirect(res, u.toString());
  }
  if (p === '/auth/callback' && req.method === 'GET') {
    const fail = (msg) => { clearCookie(res, OIDC_COOKIE); console.warn('SSO login failed:', msg); redirect(res, '/login?error=' + encodeURIComponent('Sign-in failed. Please try again.')); };
    if (url.searchParams.get('error')) return fail(url.searchParams.get('error'));
    const pending = unsign(parseCookies(req.headers.cookie)[OIDC_COOKIE]);
    const code = url.searchParams.get('code');
    if (!pending || !code || url.searchParams.get('state') !== pending.state) return fail('state mismatch');
    try {
      const cfg = await discover();
      const form = new URLSearchParams({
        grant_type: 'authorization_code', code, redirect_uri: `${BASE_URL}/auth/callback`,
        client_id: OIDC_CLIENT_ID, code_verifier: pending.verifier,
      });
      if (OIDC_CLIENT_SECRET) form.set('client_secret', OIDC_CLIENT_SECRET);
      const tok = await fetchJSON(cfg.token_endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: form,
      });
      const claims = await verifyIdToken(tok.id_token, cfg, pending.nonce);
      const email = String(claims.email || claims.preferred_username || '').toLowerCase();
      if (!email) throw new Error('no email claim (request the "email" scope)');
      if (claims.email_verified === false) throw new Error('email not verified');
      if (!emailAllowed(email)) throw new Error(`email domain not allowed: ${email}`);
      const user = upsertUser({
        key: `${claims.iss}|${claims.sub}`,
        name: String(claims.name || claims.given_name || email.split('@')[0]).slice(0, 60),
        email, picture: typeof claims.picture === 'string' && claims.picture.startsWith('https://') ? claims.picture : null,
      });
      clearCookie(res, OIDC_COOKIE);
      startSession(res, user);
      return redirect(res, '/');
    } catch (e) { return fail(e.message); }
  }
  if (p === '/auth/dev' && req.method === 'POST') {
    if (!DEV_LOGIN) return json(res, 404, { error: 'disabled' });
    if (!sameOrigin(req)) return json(res, 403, { error: 'bad origin' });
    const f = new URLSearchParams((await readBody(req)).toString('utf8'));
    const name = String(f.get('name') || '').trim().slice(0, 60);
    if (!name) return redirect(res, '/login?error=' + encodeURIComponent('Enter your name.'));
    const user = upsertDemoUser(name);
    startSession(res, user);
    return redirect(res, '/');
  }
  if (p === '/auth/logout' && req.method === 'POST') {
    if (!sameOrigin(req)) return json(res, 403, { error: 'bad origin' });
    clearCookie(res, SID);
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: 'not found' });
}

// ───────────────────────────── REST API ─────────────────────────────
async function apiRoutes(req, res, url, user) {
  const p = url.pathname;
  if (req.method !== 'GET' && !sameOrigin(req)) return json(res, 403, { error: 'bad origin' });

  if (req.method === 'GET' && p === '/api/me') return json(res, 200, { user: pub(user) });

  if (req.method === 'GET' && p === '/api/users') {
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    const users = Object.values(db.users)
      .filter((u) => u.id !== user.id && (!q || u.name.toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q)))
      .sort((a, b) => a.name.localeCompare(b.name)).slice(0, 50).map(pub);
    return json(res, 200, { users });
  }

  if (req.method === 'GET' && p === '/api/chats') {
    const chats = Object.values(db.chats).filter((c) => c.members.includes(user.id)).map((c) => chatView(c, user.id));
    return json(res, 200, { chats });
  }

  if (req.method === 'POST' && p === '/api/chats') {
    const { chat, created } = createChat(user, await readJSON(req));
    if (created) for (const id of chat.members) if (id !== user.id) sendTo(id, { t: 'chat', chat: chatView(chat, id) });
    return json(res, 200, { chat: chatView(chat, user.id) });
  }

  const m = p.match(/^\/api\/chats\/([\w-]+)\/messages$/);
  if (req.method === 'GET' && m) {
    const chat = db.chats[m[1]];
    if (!chat || !chat.members.includes(user.id)) return json(res, 404, { error: 'not found' });
    const before = Number(url.searchParams.get('before')) || Infinity;
    const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 100);
    const all = (db.messages[chat.id] || []).filter((x) => x.ts < before);
    return json(res, 200, { messages: all.slice(-limit), more: all.length > limit });
  }
  return json(res, 404, { error: 'not found' });
}

// ───────────────────────────── static files ─────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon',
};
const WS_ORIGIN = BASE_URL.replace(/^http/, 'ws');
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' https: data:",
  `connect-src 'self' ${WS_ORIGIN}`, "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "object-src 'none'",
].join('; ');

function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { res.writeHead(400); return res.end(); }
  if (rel === '/') rel = '/index.html';
  if (rel === '/login') rel = '/login.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep) || path.basename(file).startsWith('.')) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    const ext = path.extname(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.png' ? 'public, max-age=86400' : 'no-cache',
      ...(file.endsWith('sw.js') ? { 'Service-Worker-Allowed': '/' } : {}),
    });
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
}

// ───────────────────────────── HTTP server ─────────────────────────────
const server = http.createServer(async (req, res) => {
  try {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    if (IS_HTTPS) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

    const url = new URL(req.url, BASE_URL);
    const p = url.pathname;
    if (p.startsWith('/auth/')) return await authRoutes(req, res, url);
    if (p.startsWith('/api/')) {
      const user = getSession(req);
      if (!user) return json(res, 401, { error: 'unauthorized' });
      return await apiRoutes(req, res, url, user);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    if (p === '/') { if (!getSession(req)) return redirect(res, '/login'); }
    if (p === '/login' && getSession(req)) return redirect(res, '/');
    return serveStatic(req, res, p);
  } catch (e) {
    if (e.status) return json(res, e.status, { error: e.message });
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: 'server error' }); else res.end();
  }
});

// ───────────────────────────── WebSocket (RFC 6455) ─────────────────────────────
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
class WS {
  constructor(socket) {
    this.socket = socket; this.buf = Buffer.alloc(0); this.frags = []; this.fragLen = 0; this.alive = true; this.closed = false;
    this.onmessage = () => {}; this.onclose = () => {};
    socket.on('data', (d) => this._data(d));
    socket.on('close', () => this._end());
    socket.on('error', () => this._end());
  }
  _end() { if (this.closed) return; this.closed = true; this.onclose(); }
  _data(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0, op = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f, off = 2;
      if (!masked) return this.close(1002);
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; const big = b.readBigUInt64BE(2); if (big > BigInt(MAX_WS_PAYLOAD)) return this.close(1009); len = Number(big); off = 10; }
      if (len > MAX_WS_PAYLOAD) return this.close(1009);
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4);
      const payload = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = b.subarray(off + 4 + len);
      this._frame(fin, op, payload);
      if (this.closed) return;
    }
  }
  _frame(fin, op, payload) {
    if (op === 0x8) return this.close(1000);
    if (op === 0x9) return this._write(0xA, payload);
    if (op === 0xA) { this.alive = true; return; }
    if (op === 0x1 || op === 0x0) {
      this.frags.push(payload); this.fragLen += payload.length;
      if (this.fragLen > MAX_WS_PAYLOAD) return this.close(1009);
      if (fin) {
        const text = Buffer.concat(this.frags).toString('utf8');
        this.frags = []; this.fragLen = 0;
        this.alive = true;
        this.onmessage(text);
      }
    }
  }
  _write(op, payload) {
    if (this.closed || this.socket.destroyed) return;
    const len = payload.length;
    let head;
    if (len < 126) head = Buffer.from([0x80 | op, len]);
    else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
    this.socket.write(Buffer.concat([head, payload]));
  }
  send(str) { this._write(0x1, Buffer.from(str)); }
  ping() { this._write(0x9, Buffer.alloc(0)); }
  close(code = 1000) {
    const p = Buffer.alloc(2); p.writeUInt16BE(code);
    this._write(0x8, p);
    this.socket.end();
    this._end();
  }
  terminate() { this.socket.destroy(); this._end(); }
}

const allSockets = new Set();
server.on('upgrade', (req, socket) => {
  const deny = (code, msg) => { socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
  try {
    if (new URL(req.url, BASE_URL).pathname !== '/ws') return deny(404, 'Not Found');
    if (!sameOrigin(req) || !req.headers.origin) return deny(403, 'Forbidden');
    const user = getSession(req);
    if (!user) return deny(401, 'Unauthorized');
    const key = req.headers['sec-websocket-key'];
    if (!key || req.headers['sec-websocket-version'] !== '13') return deny(400, 'Bad Request');
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.setNoDelay(true);
    onConnect(user, new WS(socket));
  } catch (e) { console.error(e); socket.destroy(); }
});

function onConnect(user, ws) {
  allSockets.add(ws);
  const first = !isOnline(user.id);
  if (!conns.has(user.id)) conns.set(user.id, new Set());
  conns.get(user.id).add(ws);
  if (first) { mark(user.id, 'delivered'); broadcastPresence(user); }
  ws.send(JSON.stringify({ t: 'ready' }));

  const bucket = { tokens: 20, at: now() };
  ws.onmessage = (raw) => {
    const t = now();
    bucket.tokens = Math.min(20, bucket.tokens + (t - bucket.at) / 500); bucket.at = t; // 2 msgs/sec sustained, burst 20
    if (--bucket.tokens < 0) return;
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;
    switch (m.t) {
      case 'send': return postMessage(user, ws, m);
      case 'read': {
        const chat = db.chats[m.chatId];
        if (chat && chat.members.includes(user.id)) { mark(user.id, 'read', chat.id); sendTo(user.id, { t: 'readself', chatId: chat.id }, ws); }
        return;
      }
      case 'typing': {
        const chat = db.chats[m.chatId];
        if (chat && chat.members.includes(user.id)) for (const id of chat.members) if (id !== user.id) sendTo(id, { t: 'typing', chatId: chat.id, userId: user.id });
        return;
      }
      default:
    }
  };
  ws.onclose = () => {
    allSockets.delete(ws);
    const set = conns.get(user.id);
    set?.delete(ws);
    if (set && set.size === 0) {
      conns.delete(user.id);
      user.lastSeen = now(); save();
      broadcastPresence(user);
    }
  };
}

setInterval(() => {
  for (const ws of allSockets) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false; ws.ping();
  }
}, 25_000).unref();

server.listen(PORT, () => {
  console.log(`ChatApp running at ${BASE_URL}  (listening on :${PORT})`);
  if (OIDC_ENABLED) {
    console.log(`SSO: ${OIDC_NAME} via ${OIDC_ISSUER}\n     Redirect URI to register: ${BASE_URL}/auth/callback`);
    if (ALLOWED_DOMAINS.length) console.log(`     Allowed email domains: ${ALLOWED_DOMAINS.join(', ')}`);
  } else {
    console.log('SSO: not configured (set OIDC_CLIENT_ID / OIDC_CLIENT_SECRET / OIDC_ISSUER — see README).');
  }
  if (DEV_LOGIN) console.warn('WARNING: demo login is ENABLED — anyone can sign in as any name. For local testing only.');
});
