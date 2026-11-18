#!/usr/bin/env node
'use strict';
// Admin CLI. Usually run through the Makefile (`make help`).
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const store = require('./store');

const fmt = t => t ? new Date(t).toISOString().slice(0, 16).replace('T', ' ') : '-';
const baseUrl = () => (process.env.PUBLIC_URL || process.env.COOLIFY_URL || '').split(',')[0].replace(/\/+$/, '');
function table(rows, cols) {
  if (!rows.length) return console.log('(none)');
  const w = cols.map(c => Math.max(c.length, ...rows.map(r => String(r[c] ?? '').length)));
  console.log(cols.map((c, i) => c.padEnd(w[i])).join('  '));
  for (const r of rows) console.log(cols.map((c, i) => String(r[c] ?? '').padEnd(w[i])).join('  '));
}
function need(v, msg) { if (!v) { console.error(msg); process.exit(1); } return v; }

const cmds = {
  async invite(note = '', days = '14') {
    const inv = await store.createInvite({ note, days: +days });
    const base = baseUrl();
    console.log(`Invite code: ${inv.code}`);
    console.log(`Expires:     ${inv.expiresAt ? fmt(inv.expiresAt) : 'never'}${note ? `\nNote:        ${note}` : ''}`);
    console.log(`Link:        ${base || '<your-site>'}/register?invite=${inv.code}`);
    if (!base) console.log('(set PUBLIC_URL to print a full link)');
  },

  async invites() {
    const list = (await store.listInvites()).sort((a, b) => a.createdAt - b.createdAt);
    table(list.map(i => ({
      code: i.code, note: i.note, created: fmt(i.createdAt),
      status: i.usedBy ? `used by ${i.usedBy}` : store.inviteUsable(i) ? `open until ${i.expiresAt ? fmt(i.expiresAt) : 'forever'}` : 'expired',
    })), ['code', 'status', 'created', 'note']);
  },

  async 'revoke-invite'(code) {
    await store.revokeInvite(need(code, 'usage: revoke-invite <CODE>'));
    console.log('Invite revoked.');
  },

  async users() {
    const users = (await store.listUsers()).sort((a, b) => a.createdAt - b.createdAt);
    const rows = [];
    for (const u of users) {
      const st = await store.readState(u.username).catch(() => null);
      let words = '-';
      try { if (st) words = JSON.parse(st.json).lists.reduce((n, l) => n + l.words.length, 0); } catch {}
      rows.push({ username: u.username, created: fmt(u.createdAt), 'last save': fmt(st && st.savedAt), words, invite: u.invite || '-' });
    }
    table(rows, ['username', 'created', 'last save', 'words', 'invite']);
  },

  async 'create-user'(username, password) {
    need(username, 'usage: create-user <username> [password]');
    const pw = password || store.randomPassword();
    const u = await store.createUser(username, pw, 'cli');
    console.log(`Created ${u.username}${password ? '' : ` with password: ${pw}`}`);
  },

  async passwd(username, password) {
    need(username, 'usage: passwd <username> [password]');
    const pw = password || store.randomPassword();
    await store.setPassword(username, pw);
    console.log(`Password changed for ${store.normUser(username)}${password ? '' : `: ${pw}`} (all their sessions were logged out)`);
  },

  async 'delete-user'(username, flag) {
    need(username, 'usage: delete-user <username> [--purge]');
    const purge = flag === '--purge';
    await store.deleteUser(username, { purge });
    console.log(purge ? 'User and all their data deleted.' : `User deleted. Their data is kept in ${store.userDir(store.normUser(username))}`);
  },

  async logout(username) {
    await store.deleteUserSessions(store.normUser(need(username, 'usage: logout <username>')));
    console.log('All sessions removed.');
  },

  // Move data from the old single-user version (DATA_DIR/state.json) into a user's account.
  async 'import-legacy'(username, flag) {
    need(username, 'usage: import-legacy <username> [--force]');
    const u = await store.getUser(username);
    need(u, `No user "${username}". Create them first (make invite, or make create-user).`);
    const legacy = path.join(store.DATA_DIR, 'state.json');
    const doc = await store.readJson(legacy);
    need(doc, `No legacy data found at ${legacy}`);
    if (await store.readState(u.username) && flag !== '--force') need(false, `${u.username} already has data. Add --force (FORCE=1) to overwrite (their old state stays in backups/).`);
    doc.updatedAt = doc.savedAt = Date.now(); // newer than any browser copy, so it wins on next load
    await store.writeState(u.username, doc);
    const oldBackups = path.join(store.DATA_DIR, 'backups');
    if (fs.existsSync(oldBackups)) {
      for (const f of await fsp.readdir(oldBackups)) {
        const dest = path.join(store.userDir(u.username), 'backups', f.replace(/^state-/, 'legacy-state-'));
        await fsp.copyFile(path.join(oldBackups, f), dest);
      }
    }
    await fsp.rename(legacy, legacy + '.imported');
    console.log(`Imported legacy data into ${u.username}.`);
  },

  async help() {
    console.log(`Commands:
  invite [note] [days=14]        create a single-use invite (days=0: never expires)
  invites                        list invites
  revoke-invite <CODE>           delete an invite
  users                          list users
  create-user <user> [password]  create a user directly (random password if omitted)
  passwd <user> [password]       reset password (random if omitted)
  logout <user>                  log a user out everywhere
  delete-user <user> [--purge]   delete account (--purge also deletes their data)
  import-legacy <user> [--force] move single-user data (data/state.json) to a user`);
  },
};

const [cmd = 'help', ...args] = process.argv.slice(2);
const fn = cmds[cmd] || (() => { console.error(`Unknown command: ${cmd}\n`); process.exitCode = 1; return cmds.help(); });
Promise.resolve(fn(...args)).catch(e => { console.error('Error:', e.message); process.exit(1); });
