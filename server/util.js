'use strict';
/**
 * Small shared server-side helpers.
 */
const crypto = require('crypto');

/** Short, collision-resistant alphanumeric id. */
function uid(len = 10) {
  return crypto.randomBytes(Math.ceil((len * 6) / 8)).toString('hex').slice(0, len);
}

function nowISO() {
  return new Date().toISOString();
}

/** Hash a password with scrypt. Returns "salt:hash" hex string. */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

/** Constant-time password verification. */
function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(String(password), salt, 32);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

/** Neutralise characters that could break file paths / names. */
function sanitizeName(name, fallback = 'untitled') {
  const cleaned = String(name || '')
    .normalize('NFKD')
    .replace(/[^\w\s\-.)(]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .slice(0, 80);
  return cleaned || fallback;
}

module.exports = { uid, nowISO, hashPassword, verifyPassword, sanitizeName };
