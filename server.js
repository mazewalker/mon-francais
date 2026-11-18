'use strict';
// Mon Français – zero-dependency multi-user server.
// Accounts are created only with an invite code (made with `make invite`).
const http = require('http');
const fsp = require('fs').promises;
const path = require('path');
const store = require('./store');

const PORT = +process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const COOKIE = 'mf_session';
const MAX_BODY = 10 * 1024 * 1024;

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', ...headers });
  res.end(body);
}
const json = (res, code, obj, headers) => send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json', ...headers });
const redirect = (res, to) => send(res, 302, '', { Location: to });
const httpError = (status, error) => Object.assign(new Error(error), { status, expose: true });

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const isHttps = req => req.headers['x-forwarded-proto'] === 'https' || process.env.COOKIE_SECURE === '1';
function sessionCookie(req, token, maxAgeDays) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.round(maxAgeDays * 86400)}${isHttps(req) ? '; Secure' : ''}`;
}
async function currentUser(req) {
  const s = await store.getSession(cookies(req)[COOKIE]);
  return s ? s.username : null;
}

async function readBody(req) {
  // Requiring JSON forces a CORS preflight for cross-site requests (CSRF protection on top of SameSite).
  if (!/^application\/json\b/.test(req.headers['content-type'] || '')) throw httpError(415, 'expected application/json');
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > MAX_BODY) throw httpError(413, 'too large'); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw httpError(400, 'invalid json'); }
}

// Brute-force protection for login/register: max 10 failed attempts per 15 minutes per IP.
const attempts = new Map();
async function limited(req, fn) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const now = Date.now(); let a = attempts.get(ip);
  if (!a || a.reset < now) { a = { n: 0, reset: now + 15 * 60e3 }; attempts.set(ip, a); }
  if (a.n >= 10) throw httpError(429, 'too_many_attempts');
  try { return await fn(); } catch (e) { if (e.status && e.status < 500) a.n++; throw e; }
}
setInterval(() => { const now = Date.now(); for (const [k, v] of attempts) if (v.reset < now) attempts.delete(k); }, 60e3).unref();

let registering = Promise.resolve(); // serialize registrations so an invite can't be used twice

const api = {
  async 'POST /api/login'(req, res) {
    const { username, password } = await readBody(req);
    const user = await limited(req, async () => {
      const user = await store.getUser(username);
      if (!user || !(await store.verifyPassword(password || '', user.hash))) throw httpError(401, 'bad_credentials');
      return user;
    });
    const token = await store.createSession(user.username);
    json(res, 200, { ok: true, username: user.username }, { 'Set-Cookie': sessionCookie(req, token, 365) });
  },

  async 'POST /api/register'(req, res) {
    const { invite, username, password } = await readBody(req);
    const u = store.normUser(username);
    const run = async () => {
      const inv = await store.getInvite(invite);
      if (!store.inviteUsable(inv)) throw httpError(400, 'bad_invite');
      if (!store.validUsername(u)) throw httpError(400, 'bad_username');
      if (String(password || '').length < store.MIN_PASSWORD) throw httpError(400, 'short_password');
      try { await store.createUser(u, password, inv.code); }
      catch (e) { if (e.message === 'username taken') throw httpError(409, 'username_taken'); throw e; }
      await store.markInviteUsed(inv.code, u);
    };
    const p = registering.then(run, run); registering = p.catch(() => {});
    await limited(req, () => p);
    const token = await store.createSession(u);
    json(res, 200, { ok: true, username: u }, { 'Set-Cookie': sessionCookie(req, token, 365) });
  },

  async 'GET /api/invite'(req, res, url) {
    json(res, 200, { valid: store.inviteUsable(await store.getInvite(url.searchParams.get('code'))) });
  },

  async 'POST /api/logout'(req, res) {
    const t = cookies(req)[COOKIE];
    if (t) await store.deleteSession(t);
    json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
  },

  async 'GET /api/me'(req, res) {
    const u = await currentUser(req);
    u ? json(res, 200, { username: u }) : json(res, 401, { error: 'unauthenticated' });
  },

  async 'GET /api/state'(req, res) {
    const u = await currentUser(req);
    if (!u) return json(res, 401, { error: 'unauthenticated' });
    const doc = await store.readState(u);
    doc ? json(res, 200, doc) : send(res, 204);
  },

  async 'PUT /api/state'(req, res) {
    const u = await currentUser(req);
    if (!u) return json(res, 401, { error: 'unauthenticated' });
    const doc = await readBody(req);
    if (typeof doc.json !== 'string' || typeof doc.updatedAt !== 'number') throw httpError(400, 'expected {json, updatedAt}');
    try { JSON.parse(doc.json); } catch { throw httpError(400, 'invalid state json'); }
    const cur = await store.readState(u);
    if (cur && cur.updatedAt > doc.updatedAt) return json(res, 409, cur); // never overwrite newer data with older
    await store.writeState(u, { json: doc.json, updatedAt: doc.updatedAt, savedAt: Date.now() });
    json(res, 200, { ok: true, updatedAt: doc.updatedAt });
  },
};

const escAttr = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

async function page(res, file, inject) {
  let html = await fsp.readFile(path.join(PUBLIC_DIR, file), 'utf8');
  if (inject) html = html.replace('<head>', `<head>\n${inject}`);
  send(res, 200, html, { 'Content-Type': TYPES['.html'], 'X-Frame-Options': 'SAMEORIGIN' });
}

async function serveStatic(res, pathname) {
  const file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(pathname)));
  if (!file.startsWith(PUBLIC_DIR + path.sep) || file.endsWith('.html')) return send(res, 404, 'Not found');
  try { send(res, 200, await fsp.readFile(file), { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'public, max-age=3600' }); }
  catch { send(res, 404, 'Not found'); }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const { pathname } = url;
  try {
    if (pathname === '/health') return json(res, 200, { ok: true });
    const handler = api[`${req.method} ${pathname}`];
    if (handler) return await handler(req, res, url);
    if (pathname.startsWith('/api/')) return json(res, 404, { error: 'not found' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');

    if (pathname === '/' || pathname === '/index.html') {
      const u = await currentUser(req);
      if (!u) return redirect(res, '/login');
      return page(res, 'index.html', `<meta name="mf-user" content="${escAttr(u)}">`);
    }
    if (pathname === '/login' || pathname === '/register') {
      if (await currentUser(req)) return redirect(res, '/');
      return page(res, 'login.html');
    }
    return serveStatic(res, pathname);
  } catch (e) {
    if (!e.expose) console.error(e);
    if (!res.headersSent) json(res, e.status || 500, { error: e.expose ? e.message : 'server_error' });
  }
});

server.listen(PORT, () => console.log(`Mon Français on :${PORT}, data in ${store.DATA_DIR}`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => store.pendingWrites().then(() => process.exit(0))));
