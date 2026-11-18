'use strict';
// Shared file-based storage used by both server.js and cli.js.
// One file per record, so the CLI and the running server never clobber each other.
//
// DATA_DIR/
//   accounts/<username>.json        { username, hash, createdAt, invite }
//   invites/<CODE>.json             { code, note, createdAt, expiresAt, usedBy, usedAt }
//   sessions/<sha256(token)>.json   { username, createdAt, expiresAt }
//   users/<username>/state.json     { json, updatedAt, savedAt }
//   users/<username>/backups/state-YYYY-MM-DD.json   (one per day, kept forever)
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const DIRS = {
  accounts: path.join(DATA_DIR, 'accounts'),
  invites: path.join(DATA_DIR, 'invites'),
  sessions: path.join(DATA_DIR, 'sessions'),
  users: path.join(DATA_DIR, 'users'),
};
for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });

const DAY = 86400e3;
const SESSION_DAYS = 365;

/* ---------- helpers ---------- */
async function readJson(file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
async function writeJson(file, obj, { exclusive = false } = {}) {
  const data = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1);
  if (exclusive) { await fsp.writeFile(file, data, { flag: 'wx' }); return; }
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fh = await fsp.open(tmp, 'w');
  try { await fh.writeFile(data); await fh.sync(); } finally { await fh.close(); }
  await fsp.rename(tmp, file); // atomic replace
}
async function listJson(dir) {
  const names = (await fsp.readdir(dir)).filter(n => n.endsWith('.json'));
  return (await Promise.all(names.map(n => readJson(path.join(dir, n))))).filter(Boolean);
}

/* ---------- usernames & passwords ---------- */
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/;
const normUser = u => String(u || '').trim().toLowerCase();
const validUsername = u => USERNAME_RE.test(u);
const MIN_PASSWORD = 6;

function scrypt(pw, salt) {
  return new Promise((res, rej) => crypto.scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => e ? rej(e) : res(k)));
}
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${(await scrypt(pw, salt)).toString('base64')}`;
}
async function verifyPassword(pw, stored) {
  const [alg, salt, hash] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const got = await scrypt(String(pw), Buffer.from(salt, 'base64'));
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}
const randomPassword = () => crypto.randomBytes(9).toString('base64url');

/* ---------- accounts ---------- */
const accountFile = u => path.join(DIRS.accounts, `${u}.json`);
async function getUser(username) {
  const u = normUser(username);
  return validUsername(u) ? readJson(accountFile(u)) : null;
}
async function createUser(username, password, invite) {
  const u = normUser(username);
  if (!validUsername(u)) throw new Error('invalid username');
  if (String(password).length < MIN_PASSWORD) throw new Error('password too short');
  const rec = { username: u, hash: await hashPassword(password), createdAt: Date.now(), invite: invite || null };
  try { await writeJson(accountFile(u), rec, { exclusive: true }); }
  catch (e) { if (e.code === 'EEXIST') throw new Error('username taken'); throw e; }
  await fsp.mkdir(path.join(DIRS.users, u, 'backups'), { recursive: true });
  return rec;
}
async function setPassword(username, password) {
  const rec = await getUser(username);
  if (!rec) throw new Error('no such user');
  if (String(password).length < MIN_PASSWORD) throw new Error('password too short');
  rec.hash = await hashPassword(password);
  await writeJson(accountFile(rec.username), rec);
  await deleteUserSessions(rec.username);
}
async function deleteUser(username, { purge = false } = {}) {
  const u = normUser(username);
  if (!(await getUser(u))) throw new Error('no such user');
  await fsp.rm(accountFile(u), { force: true });
  await deleteUserSessions(u);
  if (purge) await fsp.rm(path.join(DIRS.users, u), { recursive: true, force: true });
}
const listUsers = () => listJson(DIRS.accounts);

/* ---------- invites ---------- */
const INVITE_RE = /^[A-Z0-9]{6,32}$/;
const normInvite = c => String(c || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
const inviteFile = c => path.join(DIRS.invites, `${c}.json`);
function newInviteCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
  return [...crypto.randomBytes(10)].map(b => A[b % A.length]).join('');
}
async function createInvite({ note = '', days = 14 } = {}) {
  const code = newInviteCode();
  const rec = { code, note, createdAt: Date.now(), expiresAt: days > 0 ? Date.now() + days * DAY : null, usedBy: null, usedAt: null };
  await writeJson(inviteFile(code), rec, { exclusive: true });
  return rec;
}
async function getInvite(code) {
  const c = normInvite(code);
  return INVITE_RE.test(c) ? readJson(inviteFile(c)) : null;
}
const inviteUsable = inv => !!inv && !inv.usedBy && (!inv.expiresAt || inv.expiresAt > Date.now());
async function markInviteUsed(code, username) {
  const inv = await getInvite(code);
  inv.usedBy = username; inv.usedAt = Date.now();
  await writeJson(inviteFile(inv.code), inv);
}
async function revokeInvite(code) {
  const inv = await getInvite(code);
  if (!inv) throw new Error('no such invite');
  await fsp.rm(inviteFile(inv.code), { force: true });
}
const listInvites = () => listJson(DIRS.invites);

/* ---------- sessions ---------- */
const tokenHash = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const sessionFile = t => path.join(DIRS.sessions, `${tokenHash(t)}.json`);
async function createSession(username) {
  const token = crypto.randomBytes(32).toString('base64url');
  await writeJson(sessionFile(token), { username, createdAt: Date.now(), expiresAt: Date.now() + SESSION_DAYS * DAY });
  return token;
}
async function getSession(token) {
  if (!token || !/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const s = await readJson(sessionFile(token));
  if (!s) return null;
  if (s.expiresAt < Date.now() || !(await getUser(s.username))) { await deleteSession(token); return null; }
  if (s.expiresAt - Date.now() < (SESSION_DAYS - 1) * DAY) { // sliding expiry, refreshed at most daily
    s.expiresAt = Date.now() + SESSION_DAYS * DAY;
    await writeJson(sessionFile(token), s).catch(() => {});
  }
  return s;
}
const deleteSession = token => fsp.rm(sessionFile(token), { force: true });
async function deleteUserSessions(username) {
  for (const n of await fsp.readdir(DIRS.sessions)) {
    const f = path.join(DIRS.sessions, n);
    const s = await readJson(f).catch(() => null);
    if (s && s.username === username) await fsp.rm(f, { force: true });
  }
}

/* ---------- per-user app state ---------- */
const userDir = u => path.join(DIRS.users, u);
const readState = u => readJson(path.join(userDir(u), 'state.json'));
const queues = new Map(); // serialize writes per user
function writeState(u, doc) {
  const run = async () => {
    const dir = userDir(u);
    await fsp.mkdir(path.join(dir, 'backups'), { recursive: true });
    const data = JSON.stringify(doc);
    await writeJson(path.join(dir, 'state.json'), data);
    await writeJson(path.join(dir, 'backups', `state-${new Date().toISOString().slice(0, 10)}.json`), data);
  };
  const p = (queues.get(u) || Promise.resolve()).then(run, run);
  queues.set(u, p);
  return p;
}
const pendingWrites = () => Promise.allSettled([...queues.values()]);

module.exports = {
  DATA_DIR, DIRS, MIN_PASSWORD, normUser, validUsername, verifyPassword, randomPassword,
  getUser, createUser, setPassword, deleteUser, listUsers,
  normInvite, createInvite, getInvite, inviteUsable, markInviteUsed, revokeInvite, listInvites,
  createSession, getSession, deleteSession, deleteUserSessions,
  userDir, readState, writeState, pendingWrites, readJson, writeJson,
};
