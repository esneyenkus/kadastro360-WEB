'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

function normalizeUsername(value) {
  return String(value || '').trim().toLocaleLowerCase('tr-TR');
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password, saved) {
  const [salt, expectedHex] = String(saved || '').split(':');
  if (!salt || !expectedHex) return false;
  const actual = crypto.scryptSync(String(password), salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function isoOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

class AccountStore {
  constructor({ dataDir, adminUsername, adminPassword, defaultDailyQuota = 20 }) {
    this.dataDir = dataDir;
    this.adminUsername = normalizeUsername(adminUsername || 'admin');
    this.adminPassword = String(adminPassword || '');
    this.defaultDailyQuota = Math.max(1, Number(defaultDailyQuota) || 20);
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(this.dataDir, 'kadastro360.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    this.migrate();
    this.seedAdmin();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        active INTEGER NOT NULL DEFAULT 1,
        daily_quota INTEGER NOT NULL DEFAULT 20,
        trial_ends_at TEXT,
        created_at TEXT NOT NULL,
        last_login_at TEXT
      );
      CREATE TABLE IF NOT EXISTS query_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        province TEXT,
        district TEXT,
        neighborhood TEXT,
        block_no TEXT NOT NULL,
        parcel_no TEXT NOT NULL,
        latitude REAL,
        longitude REAL,
        source TEXT NOT NULL DEFAULT 'TKGM',
        status TEXT NOT NULL DEFAULT 'success',
        created_at TEXT NOT NULL,
        FOREIGN KEY(username) REFERENCES users(username)
      );
      CREATE INDEX IF NOT EXISTS idx_query_log_user_created
        ON query_log(username, created_at DESC);
      CREATE TABLE IF NOT EXISTS access_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        full_name TEXT NOT NULL,
        company TEXT,
        email TEXT NOT NULL,
        phone TEXT,
        note TEXT,
        status TEXT NOT NULL DEFAULT 'new',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_access_requests_created
        ON access_requests(created_at DESC);
    `);
  }

  seedAdmin() {
    if (!this.adminPassword) return;
    const existing = this.getUser(this.adminUsername);
    if (!existing) {
      this.db.prepare(`INSERT INTO users
        (username,password_hash,role,active,daily_quota,trial_ends_at,created_at)
        VALUES (?,?,?,?,?,?,?)`).run(
        this.adminUsername,
        hashPassword(this.adminPassword),
        'admin',
        1,
        999999,
        null,
        new Date().toISOString()
      );
      return;
    }
    // Yönetici hesabı çevre değişkeniyle yönetilir; parola değiştiğinde yeniden eşitlenir.
    if (!verifyPassword(this.adminPassword, existing.passwordHash) || existing.role !== 'admin') {
      this.db.prepare(`UPDATE users SET password_hash=?, role='admin', active=1 WHERE username=?`)
        .run(hashPassword(this.adminPassword), this.adminUsername);
    }
  }

  rowToUser(row) {
    if (!row) return null;
    return {
      username: row.username,
      passwordHash: row.password_hash,
      role: row.role,
      active: Boolean(row.active),
      dailyQuota: Number(row.daily_quota),
      trialEndsAt: row.trial_ends_at,
      createdAt: row.created_at,
      lastLoginAt: row.last_login_at
    };
  }

  getUser(username) {
    const row = this.db.prepare('SELECT * FROM users WHERE username=?').get(normalizeUsername(username));
    return this.rowToUser(row);
  }

  publicUser(user) {
    if (!user) return null;
    const usage = this.getUsage(user.username);
    return {
      username: user.username,
      role: user.role,
      active: user.active,
      dailyQuota: user.dailyQuota,
      usedToday: usage.usedToday,
      remainingToday: Math.max(0, user.dailyQuota - usage.usedToday),
      trialEndsAt: user.trialEndsAt,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
      trialExpired: Boolean(user.trialEndsAt && Date.parse(user.trialEndsAt) <= Date.now())
    };
  }

  authenticate(username, password) {
    const user = this.getUser(username);
    if (!user || !user.active || !verifyPassword(password, user.passwordHash)) return null;
    if (user.trialEndsAt && Date.parse(user.trialEndsAt) <= Date.now()) return null;
    const now = new Date().toISOString();
    this.db.prepare('UPDATE users SET last_login_at=? WHERE username=?').run(now, user.username);
    return this.getUser(user.username);
  }

  getUsage(username) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM query_log
      WHERE username=? AND status='success' AND created_at>=?`).get(normalizeUsername(username), start.toISOString());
    return { usedToday: Number(row?.count || 0) };
  }

  canQuery(user) {
    if (!user?.active) return { ok: false, reason: 'Hesap pasif.' };
    if (user.trialEndsAt && Date.parse(user.trialEndsAt) <= Date.now()) {
      return { ok: false, reason: 'Deneme süresi sona erdi.' };
    }
    if (user.role === 'admin') return { ok: true, remaining: 999999 };
    const used = this.getUsage(user.username).usedToday;
    if (used >= user.dailyQuota) return { ok: false, reason: 'Günlük parsel sorgu kotanız doldu.' };
    return { ok: true, remaining: user.dailyQuota - used };
  }

  logQuery(entry) {
    this.db.prepare(`INSERT INTO query_log
      (username,province,district,neighborhood,block_no,parcel_no,latitude,longitude,source,status,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      normalizeUsername(entry.username),
      entry.province || null,
      entry.district || null,
      entry.neighborhood || null,
      String(entry.blockNo || ''),
      String(entry.parcelNo || ''),
      Number.isFinite(Number(entry.latitude)) ? Number(entry.latitude) : null,
      Number.isFinite(Number(entry.longitude)) ? Number(entry.longitude) : null,
      entry.source || 'TKGM',
      entry.status || 'success',
      new Date().toISOString()
    );
  }

  history(username, limit = 30) {
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 30));
    return this.db.prepare(`SELECT id,province,district,neighborhood,block_no AS blockNo,
      parcel_no AS parcelNo,latitude,longitude,source,status,created_at AS createdAt
      FROM query_log WHERE username=? ORDER BY id DESC LIMIT ?`)
      .all(normalizeUsername(username), safeLimit);
  }

  listUsers() {
    return this.db.prepare('SELECT * FROM users ORDER BY created_at DESC').all()
      .map(row => this.publicUser(this.rowToUser(row)));
  }

  createAccessRequest(input) {
    const fullName = String(input.fullName || '').trim();
    const company = String(input.company || '').trim().slice(0, 160);
    const email = String(input.email || '').trim().slice(0, 160);
    const phone = String(input.phone || '').trim().slice(0, 60);
    const note = String(input.note || '').trim().slice(0, 1000);
    if (fullName.length < 3) throw new Error('Ad soyad en az 3 karakter olmalıdır.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Geçerli bir e-posta adresi girin.');
    this.db.prepare(`INSERT INTO access_requests
      (full_name,company,email,phone,note,status,created_at)
      VALUES (?,?,?,?,?,?,?)`).run(
      fullName,
      company || null,
      email,
      phone || null,
      note || null,
      'new',
      new Date().toISOString()
    );
    return { ok: true };
  }

  listAccessRequests(limit = 100) {
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
    return this.db.prepare(`SELECT id,full_name AS fullName,company,email,phone,note,status,created_at AS createdAt
      FROM access_requests ORDER BY CASE status WHEN 'new' THEN 0 WHEN 'reviewed' THEN 1 ELSE 2 END, id DESC LIMIT ?`).all(safeLimit);
  }

  updateAccessRequest(id, input = {}) {
    const requestId = Number(id);
    if (!Number.isInteger(requestId) || requestId < 1) throw new Error('Geçersiz erişim talebi.');
    const allowed = new Set(['new', 'reviewed', 'approved', 'rejected']);
    const status = String(input.status || '').trim();
    if (!allowed.has(status)) throw new Error('Geçersiz talep durumu.');
    const result = this.db.prepare('UPDATE access_requests SET status=? WHERE id=?').run(status, requestId);
    if (!Number(result.changes || 0)) throw new Error('Erişim talebi bulunamadı.');
    return this.db.prepare(`SELECT id,full_name AS fullName,company,email,phone,note,status,created_at AS createdAt
      FROM access_requests WHERE id=?`).get(requestId);
  }

  createUser(input) {
    const username = normalizeUsername(input.username);
    if (!/^[\p{L}\p{N}._-]{3,40}$/u.test(username)) throw new Error('Kullanıcı adı 3-40 karakter olmalıdır.');
    if (String(input.password || '').length < 6) throw new Error('Parola en az 6 karakter olmalıdır.');
    if (this.getUser(username)) throw new Error('Bu kullanıcı adı zaten var.');
    const role = input.role === 'admin' ? 'admin' : 'user';
    const dailyQuota = role === 'admin' ? 999999 : Math.max(1, Math.min(10000, Number(input.dailyQuota) || this.defaultDailyQuota));
    const trialEndsAt = isoOrNull(input.trialEndsAt);
    this.db.prepare(`INSERT INTO users
      (username,password_hash,role,active,daily_quota,trial_ends_at,created_at)
      VALUES (?,?,?,?,?,?,?)`).run(
      username, hashPassword(input.password), role, 1, dailyQuota, trialEndsAt, new Date().toISOString()
    );
    return this.publicUser(this.getUser(username));
  }

  updateUser(username, input) {
    const current = this.getUser(username);
    if (!current) throw new Error('Kullanıcı bulunamadı.');
    const role = input.role === 'admin' ? 'admin' : input.role === 'user' ? 'user' : current.role;
    const active = input.active === undefined ? current.active : Boolean(input.active);
    const dailyQuota = role === 'admin' ? 999999 : Math.max(1, Math.min(10000, Number(input.dailyQuota) || current.dailyQuota));
    const trialEndsAt = input.trialEndsAt === undefined ? current.trialEndsAt : isoOrNull(input.trialEndsAt);
    this.db.prepare(`UPDATE users SET role=?,active=?,daily_quota=?,trial_ends_at=? WHERE username=?`)
      .run(role, active ? 1 : 0, dailyQuota, trialEndsAt, current.username);
    if (input.password) {
      if (String(input.password).length < 6) throw new Error('Parola en az 6 karakter olmalıdır.');
      this.db.prepare('UPDATE users SET password_hash=? WHERE username=?')
        .run(hashPassword(input.password), current.username);
    }
    return this.publicUser(this.getUser(current.username));
  }
}

module.exports = { AccountStore, normalizeUsername };
