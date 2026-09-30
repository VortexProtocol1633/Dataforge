'use strict';
/**
 * Authentication & users.
 *
 * ---------------------------------------------------------------
 * Extension guide (future development scopes)
 * ---------------------------------------------------------------
 *  - MULTIPLE USERS / CREATE USER : add an admin-only UI on top of the
 *    existing `POST /api/users` / `GET /api/users` endpoints below.
 *  - SUPERUSER : the built-in seed account has role 'admin'. Introduce a
 *    'superuser' role by seeding a second user and extending `permFor`.
 *  - INDIVIDUAL PERMISSIONS : every user record carries a `perms` object
 *    (`{ [scope]: 'read'|'write'|'admin' }`). Tables are already filtered by
 *    `ownerId`, so granting another user access is a matter of extending
 *    `requirePerm` + adding a `sharedWith` list on the table record.
 * ---------------------------------------------------------------
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { uid, nowISO, hashPassword, verifyPassword } = require('./util');

const DATA_DIR = path.join(__dirname, '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

/** In-memory session map: token -> { userId, username, expires }. */
const sessions = new Map();
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

let usersCache = null;

function usersFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(USERS_FILE)) {
    // Seed the default administrator account: username `admin` / password `admin123`.
    const seed = [
      {
        id: 'user_admin',
        username: 'admin',
        passwordHash: hashPassword('admin123'),
        role: 'admin', // future: 'superuser' | 'admin' | 'member'
        perms: { tables: 'admin', charts: 'admin', users: 'admin' },
        createdAt: nowISO(),
      },
    ];
    fs.writeFileSync(USERS_FILE, JSON.stringify(seed, null, 2));
  }
  return USERS_FILE;
}

function loadUsers() {
  usersFile();
  usersCache = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  return usersCache;
}

function saveUsers() {
  fs.writeFileSync(usersFile(), JSON.stringify(usersCache, null, 2));
}

function findUser(username) {
  const users = usersCache || loadUsers();
  return users.find((u) => u.username === String(username).toLowerCase());
}

function publicUser(u) {
  return { id: u.id, username: u.username, role: u.role, perms: u.perms || {}, createdAt: u.createdAt };
}

/** Create a session for a user and return the opaque token. */
function createSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, {
    userId: user.id,
    username: user.username,
    role: user.role,
    perms: user.perms || {},
    expires: Date.now() + SESSION_TTL_MS,
  });
  return token;
}

function destroySession(token) {
  sessions.delete(token);
}

function sessionFromToken(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expires < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return s;
}

/** Express middleware: requires a valid session (Bearer token). */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.headers['x-session-token'];
  const session = sessionFromToken(token);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  req.session = session;
  next();
}

/**
 * Express middleware: permission check helper for future granular scopes.
 * `requirePerm('tables', 'write')` style checks can be added here.
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session) return res.status(401).json({ error: 'Not authenticated' });
    if (!roles.includes(req.session.role)) return res.status(403).json({ error: 'Forbidden' });
    next();
  };
}

function loginRoutes(app) {
  // POST /api/auth/login
  app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
    const user = findUser(username);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    const token = createSession(user);
    res.json({ token, user: publicUser(user) });
  });

  // POST /api/auth/logout
  app.post('/api/auth/logout', requireAuth, (req, res) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : req.headers['x-session-token'];
    destroySession(token);
    res.json({ ok: true });
  });

  // GET /api/auth/me
  app.get('/api/auth/me', requireAuth, (req, res) => {
    res.json({ user: { id: req.session.userId, username: req.session.username, role: req.session.role, perms: req.session.perms } });
  });

  // ---- User administration (admin-only). No UI yet — see header comment. ----
  app.get('/api/users', requireAuth, requireRole('admin'), (req, res) => {
    const users = loadUsers();
    res.json({ users: users.map(publicUser) });
  });

  // POST /api/users { username, password, role? }
  app.post('/api/users', requireAuth, requireRole('admin'), (req, res) => {
    const { username, password, role = 'member' } = req.body || {};
    const name = String(username || '').toLowerCase().trim();
    if (!/^[a-z0-9_.-]{3,32}$/.test(name)) return res.status(400).json({ error: 'Username must be 3-32 chars: letters, numbers, . _ -' });
    if (!password || String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    if (findUser(name)) return res.status(409).json({ error: 'Username already exists' });
    const user = {
      id: 'user_' + uid(8),
      username: name,
      passwordHash: hashPassword(password),
      role: ['admin', 'member'].includes(role) ? role : 'member',
      perms: { tables: 'write', charts: 'write' },
      createdAt: nowISO(),
    };
    usersCache = loadUsers();
    usersCache.push(user);
    saveUsers();
    res.json({ user: publicUser(user) });
  });
}

module.exports = { loginRoutes, requireAuth, requireRole, sessions };
