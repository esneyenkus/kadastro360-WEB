'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

function normalizeUsername(value) {
  return String(value || '').trim().toLocaleLowerCase('tr-TR');
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
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

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parcelHistoryKey(entry = {}) {
  const normalized = [
    entry.province,
    entry.district,
    entry.neighborhood,
    entry.blockNo ?? entry.block_no,
    entry.parcelNo ?? entry.parcel_no
  ].map(value => String(value || '').trim().toLocaleLowerCase('tr-TR').replace(/\s+/g, ' '));
  return crypto.createHash('sha256').update(normalized.join('|')).digest('hex');
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function usernameSeed(value) {
  let text = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '.')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 32);
  if (text.length < 3) text = `kullanici.${crypto.randomBytes(3).toString('hex')}`;
  return text;
}

const DEFAULT_SITE_CONTENT = Object.freeze({
  heroBadge: 'Kadastro360',
  heroTitle: 'Parsel bilgisini, eğimi ve yakın çevreyi tek bakışta yönetin.',
  heroDescription: 'Kadastro360; il → ilçe → mahalle → ada → parsel sorgusunu, canlı parsel konumunu, gerçek eğim analizini, yakın yer sonuçlarını ve açık kamu katmanlarını tek bir arayüzde toplar.',
  contactEmail: 'info@kadastro360.com.tr',
  footerNote: 'Canlı veri odaklı Kadastro360 hizmeti. Kullanıcılar kendi hesap kotası dahilinde sorgu yapabilir.'
});

class AccountStore {
  constructor({
    dataDir,
    adminUsername,
    adminPassword,
    defaultDailyQuota = 20,
    databaseUrl = '',
    dbSsl = true,
    dbSslRejectUnauthorized = false
  }) {
    this.dataDir = dataDir;
    this.adminUsername = normalizeUsername(adminUsername || 'admin');
    this.adminPassword = String(adminPassword || '');
    this.defaultDailyQuota = Math.max(1, Number(defaultDailyQuota) || 20);
    this.databaseUrl = String(databaseUrl || '').trim();
    this.dbSsl = Boolean(dbSsl);
    this.dbSslRejectUnauthorized = Boolean(dbSslRejectUnauthorized);
    this.provider = this.databaseUrl ? 'postgres' : 'sqlite';
    this.db = null;
    this.pool = null;
    this.initialized = false;
    this.sqliteFile = path.join(this.dataDir, 'kadastro360.sqlite');
  }

  async init() {
    if (this.initialized) return this;
    fs.mkdirSync(this.dataDir, { recursive: true });
    if (this.provider === 'postgres') {
      const { Pool } = require('pg');
      this.pool = new Pool({
        connectionString: this.databaseUrl,
        max: 5,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 15_000,
        ssl: this.dbSsl ? { rejectUnauthorized: this.dbSslRejectUnauthorized } : false
      });
      await this.pool.query('SELECT 1');
      await this.migratePostgres();
      await this.importLegacySqliteIfNeeded();
    } else {
      this.db = new DatabaseSync(this.sqliteFile);
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
      await this.migrateSqlite();
    }
    await this.seedAdmin();
    await this.seedSiteContent();
    this.initialized = true;
    return this;
  }

  ensureReady() {
    if (!this.initialized && !this.db && !this.pool) throw new Error('Hesap veritabanı henüz başlatılmadı.');
  }

  async migratePostgres() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        password_hash TEXT NOT NULL,
        full_name TEXT,
        email TEXT,
        role TEXT NOT NULL DEFAULT 'user',
        active BOOLEAN NOT NULL DEFAULT TRUE,
        daily_quota INTEGER NOT NULL DEFAULT 20,
        trial_days INTEGER NOT NULL DEFAULT 3,
        trial_ends_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL,
        last_login_at TIMESTAMPTZ,
        invited_at TIMESTAMPTZ
      );
      ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_days INTEGER NOT NULL DEFAULT 3;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS invited_at TIMESTAMPTZ;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique ON users ((lower(email))) WHERE email IS NOT NULL AND email <> '';

      CREATE TABLE IF NOT EXISTS query_log (
        id BIGSERIAL PRIMARY KEY,
        username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
        province TEXT,
        district TEXT,
        neighborhood TEXT,
        block_no TEXT NOT NULL,
        parcel_no TEXT NOT NULL,
        history_key TEXT,
        latitude DOUBLE PRECISION,
        longitude DOUBLE PRECISION,
        source TEXT NOT NULL DEFAULT 'TKGM',
        status TEXT NOT NULL DEFAULT 'success',
        created_at TIMESTAMPTZ NOT NULL
      );
      ALTER TABLE query_log ADD COLUMN IF NOT EXISTS history_key TEXT;
      CREATE INDEX IF NOT EXISTS idx_query_log_user_created ON query_log(username, created_at DESC);

      CREATE TABLE IF NOT EXISTS access_requests (
        id BIGSERIAL PRIMARY KEY,
        full_name TEXT NOT NULL,
        company TEXT,
        email TEXT NOT NULL,
        phone TEXT,
        note TEXT,
        status TEXT NOT NULL DEFAULT 'new',
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ
      );
      ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
      CREATE INDEX IF NOT EXISTS idx_access_requests_created ON access_requests(created_at DESC);

      CREATE TABLE IF NOT EXISTS auth_tokens (
        id BIGSERIAL PRIMARY KEY,
        token_hash TEXT UNIQUE NOT NULL,
        username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
        purpose TEXT NOT NULL,
        access_request_id BIGINT REFERENCES access_requests(id) ON DELETE SET NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_auth_tokens_lookup ON auth_tokens(token_hash, purpose, expires_at);

      CREATE TABLE IF NOT EXISTS site_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );
    `);
    await this.backfillHistoryKeys();
    await this.pool.query('DROP INDEX IF EXISTS idx_query_log_unique_history');
    await this.pool.query('CREATE UNIQUE INDEX idx_query_log_unique_history ON query_log(username, history_key)');
  }

  sqliteColumns(table) {
    return new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
  }

  sqliteAddColumn(table, definition) {
    const name = definition.trim().split(/\s+/)[0];
    if (!this.sqliteColumns(table).has(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }

  async migrateSqlite() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        password_hash TEXT NOT NULL,
        full_name TEXT,
        email TEXT,
        role TEXT NOT NULL DEFAULT 'user',
        active INTEGER NOT NULL DEFAULT 1,
        daily_quota INTEGER NOT NULL DEFAULT 20,
        trial_days INTEGER NOT NULL DEFAULT 3,
        trial_ends_at TEXT,
        created_at TEXT NOT NULL,
        last_login_at TEXT,
        invited_at TEXT
      );
      CREATE TABLE IF NOT EXISTS query_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        province TEXT,
        district TEXT,
        neighborhood TEXT,
        block_no TEXT NOT NULL,
        parcel_no TEXT NOT NULL,
        history_key TEXT,
        latitude REAL,
        longitude REAL,
        source TEXT NOT NULL DEFAULT 'TKGM',
        status TEXT NOT NULL DEFAULT 'success',
        created_at TEXT NOT NULL,
        FOREIGN KEY(username) REFERENCES users(username) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_query_log_user_created ON query_log(username, created_at DESC);
      CREATE TABLE IF NOT EXISTS access_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        full_name TEXT NOT NULL,
        company TEXT,
        email TEXT NOT NULL,
        phone TEXT,
        note TEXT,
        status TEXT NOT NULL DEFAULT 'new',
        created_at TEXT NOT NULL,
        updated_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_access_requests_created ON access_requests(created_at DESC);
      CREATE TABLE IF NOT EXISTS auth_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_hash TEXT UNIQUE NOT NULL,
        username TEXT NOT NULL,
        purpose TEXT NOT NULL,
        access_request_id INTEGER,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(username) REFERENCES users(username) ON DELETE CASCADE,
        FOREIGN KEY(access_request_id) REFERENCES access_requests(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_auth_tokens_lookup ON auth_tokens(token_hash, purpose, expires_at);
      CREATE TABLE IF NOT EXISTS site_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.sqliteAddColumn('users', 'full_name TEXT');
    this.sqliteAddColumn('users', 'email TEXT');
    this.sqliteAddColumn('users', 'trial_days INTEGER NOT NULL DEFAULT 3');
    this.sqliteAddColumn('users', 'invited_at TEXT');
    this.sqliteAddColumn('query_log', 'history_key TEXT');
    this.sqliteAddColumn('access_requests', 'updated_at TEXT');
    await this.backfillHistoryKeys();
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique ON users(email) WHERE email IS NOT NULL AND email <> '';
      DROP INDEX IF EXISTS idx_query_log_unique_history;
      CREATE UNIQUE INDEX idx_query_log_unique_history ON query_log(username, history_key);
    `);
  }

  async backfillHistoryKeys() {
    const rows = this.provider === 'postgres'
      ? (await this.pool.query('SELECT id,username,province,district,neighborhood,block_no,parcel_no FROM query_log ORDER BY id DESC')).rows
      : this.db.prepare('SELECT id,username,province,district,neighborhood,block_no,parcel_no FROM query_log ORDER BY id DESC').all();
    const seen = new Set();
    for (const row of rows) {
      const key = parcelHistoryKey(row);
      const unique = `${row.username}|${key}`;
      if (seen.has(unique)) {
        if (this.provider === 'postgres') await this.pool.query('DELETE FROM query_log WHERE id=$1', [row.id]);
        else this.db.prepare('DELETE FROM query_log WHERE id=?').run(row.id);
        continue;
      }
      seen.add(unique);
      if (this.provider === 'postgres') await this.pool.query('UPDATE query_log SET history_key=$1 WHERE id=$2', [key, row.id]);
      else this.db.prepare('UPDATE query_log SET history_key=? WHERE id=?').run(key, row.id);
    }
  }

  async importLegacySqliteIfNeeded() {
    if (!fs.existsSync(this.sqliteFile)) return;
    const count = Number((await this.pool.query('SELECT COUNT(*)::int AS count FROM users')).rows[0]?.count || 0);
    if (count > 0) return;
    let legacy;
    try {
      legacy = new DatabaseSync(this.sqliteFile, { readOnly: true });
      const tables = new Set(legacy.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
      if (!tables.has('users')) return;
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const users = legacy.prepare('SELECT * FROM users').all();
        for (const row of users) {
          await client.query(`INSERT INTO users
            (username,password_hash,full_name,email,role,active,daily_quota,trial_days,trial_ends_at,created_at,last_login_at,invited_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (username) DO NOTHING`, [
            row.username, row.password_hash, row.full_name || null, normalizeEmail(row.email) || null,
            row.role || 'user', Boolean(row.active), Number(row.daily_quota) || this.defaultDailyQuota,
            Number(row.trial_days) || 3, row.trial_ends_at || null, row.created_at || new Date().toISOString(),
            row.last_login_at || null, row.invited_at || null
          ]);
        }
        if (tables.has('query_log')) {
          const logs = legacy.prepare('SELECT * FROM query_log ORDER BY id').all();
          for (const row of logs) {
            const key = row.history_key || parcelHistoryKey(row);
            await client.query(`INSERT INTO query_log
              (username,province,district,neighborhood,block_no,parcel_no,history_key,latitude,longitude,source,status,created_at)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
              ON CONFLICT (username,history_key) DO UPDATE SET created_at=EXCLUDED.created_at,latitude=EXCLUDED.latitude,longitude=EXCLUDED.longitude`, [
              row.username, row.province || null, row.district || null, row.neighborhood || null,
              String(row.block_no || ''), String(row.parcel_no || ''), key, row.latitude, row.longitude,
              row.source || 'TKGM', row.status || 'success', row.created_at || new Date().toISOString()
            ]);
          }
        }
        if (tables.has('access_requests')) {
          const requests = legacy.prepare('SELECT * FROM access_requests ORDER BY id').all();
          for (const row of requests) {
            await client.query(`INSERT INTO access_requests
              (full_name,company,email,phone,note,status,created_at,updated_at)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [
              row.full_name, row.company || null, normalizeEmail(row.email), row.phone || null, row.note || null,
              row.status || 'new', row.created_at || new Date().toISOString(), row.updated_at || null
            ]);
          }
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      console.log('[VERİTABANI] Eski SQLite hesap verileri PostgreSQL içine aktarıldı.');
    } catch (error) {
      console.warn('[VERİTABANI] SQLite otomatik aktarımı atlandı:', error.message);
    } finally {
      try { legacy?.close(); } catch {}
    }
  }

  async seedAdmin() {
    if (!this.adminPassword) return;
    const existing = await this.getUser(this.adminUsername);
    if (!existing) {
      await this.insertUser({
        username: this.adminUsername,
        passwordHash: hashPassword(this.adminPassword),
        fullName: 'Kadastro360 Yönetici',
        email: null,
        role: 'admin',
        active: true,
        dailyQuota: 999999,
        trialDays: 0,
        trialEndsAt: null,
        createdAt: new Date().toISOString(),
        invitedAt: null
      });
      return;
    }
    if (!verifyPassword(this.adminPassword, existing.passwordHash) || existing.role !== 'admin' || !existing.active) {
      if (this.provider === 'postgres') {
        await this.pool.query("UPDATE users SET password_hash=$1,role='admin',active=true,daily_quota=999999 WHERE username=$2", [hashPassword(this.adminPassword), this.adminUsername]);
      } else {
        this.db.prepare("UPDATE users SET password_hash=?,role='admin',active=1,daily_quota=999999 WHERE username=?")
          .run(hashPassword(this.adminPassword), this.adminUsername);
      }
    }
  }

  async seedSiteContent() {
    const now = new Date().toISOString();
    for (const [key, value] of Object.entries(DEFAULT_SITE_CONTENT)) {
      if (this.provider === 'postgres') {
        await this.pool.query('INSERT INTO site_settings(key,value,updated_at) VALUES($1,$2,$3) ON CONFLICT(key) DO NOTHING', [key, value, now]);
      } else {
        this.db.prepare('INSERT OR IGNORE INTO site_settings(key,value,updated_at) VALUES(?,?,?)').run(key, value, now);
      }
    }
  }

  rowToUser(row) {
    if (!row) return null;
    return {
      username: row.username,
      passwordHash: row.password_hash,
      fullName: row.full_name || '',
      email: row.email || '',
      role: row.role,
      active: Boolean(row.active),
      dailyQuota: Number(row.daily_quota),
      trialDays: Number(row.trial_days || 0),
      trialEndsAt: toIso(row.trial_ends_at),
      createdAt: toIso(row.created_at),
      lastLoginAt: toIso(row.last_login_at),
      invitedAt: toIso(row.invited_at)
    };
  }

  async getUser(username) {
    this.ensureReady();
    const normalized = normalizeUsername(username);
    const row = this.provider === 'postgres'
      ? (await this.pool.query('SELECT * FROM users WHERE username=$1', [normalized])).rows[0]
      : this.db.prepare('SELECT * FROM users WHERE username=?').get(normalized);
    return this.rowToUser(row);
  }

  async findUserByEmail(email) {
    const normalized = normalizeEmail(email);
    if (!normalized) return null;
    const row = this.provider === 'postgres'
      ? (await this.pool.query('SELECT * FROM users WHERE lower(email)=$1 LIMIT 1', [normalized])).rows[0]
      : this.db.prepare('SELECT * FROM users WHERE lower(email)=? LIMIT 1').get(normalized);
    return this.rowToUser(row);
  }

  async publicUser(user) {
    if (!user) return null;
    const usage = await this.getUsage(user.username);
    return {
      username: user.username,
      fullName: user.fullName,
      email: user.email,
      role: user.role,
      active: user.active,
      dailyQuota: user.dailyQuota,
      usedToday: usage.usedToday,
      totalQueries: usage.totalQueries,
      remainingToday: Math.max(0, user.dailyQuota - usage.usedToday),
      trialDays: user.trialDays,
      trialEndsAt: user.trialEndsAt,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
      invitedAt: user.invitedAt,
      trialExpired: Boolean(user.trialEndsAt && Date.parse(user.trialEndsAt) <= Date.now())
    };
  }

  async authenticate(username, password) {
    const user = await this.getUser(username);
    if (!user || !user.active || !verifyPassword(password, user.passwordHash)) return null;
    if (user.trialEndsAt && Date.parse(user.trialEndsAt) <= Date.now()) return null;
    const now = new Date().toISOString();
    if (this.provider === 'postgres') await this.pool.query('UPDATE users SET last_login_at=$1 WHERE username=$2', [now, user.username]);
    else this.db.prepare('UPDATE users SET last_login_at=? WHERE username=?').run(now, user.username);
    return this.getUser(user.username);
  }

  async getUsage(username) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const normalized = normalizeUsername(username);
    if (this.provider === 'postgres') {
      const row = (await this.pool.query(`SELECT
        COUNT(*) FILTER (WHERE status='success' AND created_at >= $2)::int AS used_today,
        COUNT(*) FILTER (WHERE status='success')::int AS total_queries
        FROM query_log WHERE username=$1`, [normalized, start.toISOString()])).rows[0];
      return { usedToday: Number(row?.used_today || 0), totalQueries: Number(row?.total_queries || 0) };
    }
    const row = this.db.prepare(`SELECT
      SUM(CASE WHEN status='success' AND created_at>=? THEN 1 ELSE 0 END) AS used_today,
      SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS total_queries
      FROM query_log WHERE username=?`).get(start.toISOString(), normalized);
    return { usedToday: Number(row?.used_today || 0), totalQueries: Number(row?.total_queries || 0) };
  }

  async canQuery(user) {
    if (!user?.active) return { ok: false, reason: 'Hesap pasif.' };
    if (user.trialEndsAt && Date.parse(user.trialEndsAt) <= Date.now()) return { ok: false, reason: 'Deneme süresi sona erdi.' };
    if (user.role === 'admin') return { ok: true, remaining: 999999 };
    const used = (await this.getUsage(user.username)).usedToday;
    if (used >= user.dailyQuota) return { ok: false, reason: 'Günlük parsel sorgu kotanız doldu.' };
    return { ok: true, remaining: user.dailyQuota - used };
  }

  async logQuery(entry) {
    const username = normalizeUsername(entry.username);
    const now = new Date().toISOString();
    const values = [
      username,
      entry.province || null,
      entry.district || null,
      entry.neighborhood || null,
      String(entry.blockNo || ''),
      String(entry.parcelNo || ''),
      parcelHistoryKey(entry),
      Number.isFinite(Number(entry.latitude)) ? Number(entry.latitude) : null,
      Number.isFinite(Number(entry.longitude)) ? Number(entry.longitude) : null,
      entry.source || 'TKGM',
      entry.status || 'success',
      now
    ];
    if (this.provider === 'postgres') {
      await this.pool.query(`INSERT INTO query_log
        (username,province,district,neighborhood,block_no,parcel_no,history_key,latitude,longitude,source,status,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (username,history_key) DO UPDATE SET
          province=EXCLUDED.province,district=EXCLUDED.district,neighborhood=EXCLUDED.neighborhood,
          block_no=EXCLUDED.block_no,parcel_no=EXCLUDED.parcel_no,latitude=EXCLUDED.latitude,
          longitude=EXCLUDED.longitude,source=EXCLUDED.source,status=EXCLUDED.status,created_at=EXCLUDED.created_at`, values);
    } else {
      this.db.prepare(`INSERT INTO query_log
        (username,province,district,neighborhood,block_no,parcel_no,history_key,latitude,longitude,source,status,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(username,history_key) DO UPDATE SET
          province=excluded.province,district=excluded.district,neighborhood=excluded.neighborhood,
          block_no=excluded.block_no,parcel_no=excluded.parcel_no,latitude=excluded.latitude,
          longitude=excluded.longitude,source=excluded.source,status=excluded.status,created_at=excluded.created_at`).run(...values);
    }
  }

  async history(username, limit = 30) {
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 30));
    const normalized = normalizeUsername(username);
    const sql = `SELECT id,province,district,neighborhood,block_no AS ${this.provider === 'postgres' ? '"blockNo"' : 'blockNo'},
      parcel_no AS ${this.provider === 'postgres' ? '"parcelNo"' : 'parcelNo'},latitude,longitude,source,status,
      created_at AS ${this.provider === 'postgres' ? '"createdAt"' : 'createdAt'}
      FROM query_log WHERE username=${this.provider === 'postgres' ? '$1' : '?'} ORDER BY created_at DESC,id DESC LIMIT ${this.provider === 'postgres' ? '$2' : '?'}`;
    const rows = this.provider === 'postgres'
      ? (await this.pool.query(sql, [normalized, safeLimit])).rows
      : this.db.prepare(sql).all(normalized, safeLimit);
    return rows.map(row => ({ ...row, createdAt: toIso(row.createdAt) }));
  }

  async listUsers() {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    let rows;
    if (this.provider === 'postgres') {
      rows = (await this.pool.query(`SELECT u.*,
        COUNT(q.id) FILTER (WHERE q.status='success' AND q.created_at >= $1)::int AS used_today,
        COUNT(q.id) FILTER (WHERE q.status='success')::int AS total_queries
        FROM users u LEFT JOIN query_log q ON q.username=u.username
        GROUP BY u.username ORDER BY u.created_at DESC`, [start.toISOString()])).rows;
    } else {
      rows = this.db.prepare(`SELECT u.*,
        (SELECT COUNT(*) FROM query_log q WHERE q.username=u.username AND q.status='success' AND q.created_at>=?) AS used_today,
        (SELECT COUNT(*) FROM query_log q WHERE q.username=u.username AND q.status='success') AS total_queries
        FROM users u ORDER BY u.created_at DESC`).all(start.toISOString());
    }
    return rows.map(row => {
      const user = this.rowToUser(row);
      const usedToday = Number(row.used_today || 0);
      return {
        username: user.username,
        fullName: user.fullName,
        email: user.email,
        role: user.role,
        active: user.active,
        dailyQuota: user.dailyQuota,
        usedToday,
        totalQueries: Number(row.total_queries || 0),
        remainingToday: Math.max(0, user.dailyQuota - usedToday),
        trialDays: user.trialDays,
        trialEndsAt: user.trialEndsAt,
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt,
        invitedAt: user.invitedAt,
        trialExpired: Boolean(user.trialEndsAt && Date.parse(user.trialEndsAt) <= Date.now())
      };
    });
  }

  async createAccessRequest(input) {
    const fullName = String(input.fullName || '').trim().slice(0, 160);
    const company = String(input.company || '').trim().slice(0, 160);
    const email = normalizeEmail(input.email).slice(0, 160);
    const phone = String(input.phone || '').trim().slice(0, 60);
    const note = String(input.note || '').trim().slice(0, 1000);
    if (fullName.length < 3) throw new Error('Ad soyad en az 3 karakter olmalıdır.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Geçerli bir e-posta adresi girin.');
    const now = new Date().toISOString();
    if (this.provider === 'postgres') {
      await this.pool.query(`INSERT INTO access_requests(full_name,company,email,phone,note,status,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,'new',$6,$6)`, [fullName, company || null, email, phone || null, note || null, now]);
    } else {
      this.db.prepare(`INSERT INTO access_requests(full_name,company,email,phone,note,status,created_at,updated_at)
        VALUES(?,?,?,?,?,'new',?,?)`).run(fullName, company || null, email, phone || null, note || null, now, now);
    }
    return { ok: true };
  }

  async listAccessRequests(limit = 100) {
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
    const sql = `SELECT id,full_name AS ${this.provider === 'postgres' ? '"fullName"' : 'fullName'},company,email,phone,note,status,
      created_at AS ${this.provider === 'postgres' ? '"createdAt"' : 'createdAt'},updated_at AS ${this.provider === 'postgres' ? '"updatedAt"' : 'updatedAt'}
      FROM access_requests ORDER BY CASE status WHEN 'new' THEN 0 WHEN 'reviewed' THEN 1 ELSE 2 END,id DESC LIMIT ${this.provider === 'postgres' ? '$1' : '?'}`;
    const rows = this.provider === 'postgres' ? (await this.pool.query(sql, [safeLimit])).rows : this.db.prepare(sql).all(safeLimit);
    return rows.map(row => ({ ...row, createdAt: toIso(row.createdAt), updatedAt: toIso(row.updatedAt) }));
  }

  async getAccessRequest(id) {
    const requestId = Number(id);
    if (!Number.isInteger(requestId) || requestId < 1) return null;
    const sql = `SELECT id,full_name AS ${this.provider === 'postgres' ? '"fullName"' : 'fullName'},company,email,phone,note,status,
      created_at AS ${this.provider === 'postgres' ? '"createdAt"' : 'createdAt'} FROM access_requests WHERE id=${this.provider === 'postgres' ? '$1' : '?'}`;
    const row = this.provider === 'postgres' ? (await this.pool.query(sql, [requestId])).rows[0] : this.db.prepare(sql).get(requestId);
    return row ? { ...row, createdAt: toIso(row.createdAt) } : null;
  }

  async updateAccessRequest(id, input = {}) {
    const requestId = Number(id);
    if (!Number.isInteger(requestId) || requestId < 1) throw new Error('Geçersiz erişim talebi.');
    const allowed = new Set(['new', 'reviewed', 'approved', 'rejected']);
    const status = String(input.status || '').trim();
    if (!allowed.has(status)) throw new Error('Geçersiz talep durumu.');
    const now = new Date().toISOString();
    let changed;
    if (this.provider === 'postgres') changed = (await this.pool.query('UPDATE access_requests SET status=$1,updated_at=$2 WHERE id=$3', [status, now, requestId])).rowCount;
    else changed = this.db.prepare('UPDATE access_requests SET status=?,updated_at=? WHERE id=?').run(status, now, requestId).changes;
    if (!Number(changed || 0)) throw new Error('Erişim talebi bulunamadı.');
    return this.getAccessRequest(requestId);
  }

  async insertUser(user) {
    const values = [
      user.username, user.passwordHash, user.fullName || null, normalizeEmail(user.email) || null,
      user.role || 'user', Boolean(user.active), Number(user.dailyQuota) || this.defaultDailyQuota,
      Math.max(0, Number(user.trialDays) || 0), user.trialEndsAt || null,
      user.createdAt || new Date().toISOString(), user.lastLoginAt || null, user.invitedAt || null
    ];
    if (this.provider === 'postgres') {
      await this.pool.query(`INSERT INTO users
        (username,password_hash,full_name,email,role,active,daily_quota,trial_days,trial_ends_at,created_at,last_login_at,invited_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, values);
    } else {
      this.db.prepare(`INSERT INTO users
        (username,password_hash,full_name,email,role,active,daily_quota,trial_days,trial_ends_at,created_at,last_login_at,invited_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(...values.map((value, index) => index === 5 ? (value ? 1 : 0) : value));
    }
  }

  async createUser(input) {
    const username = normalizeUsername(input.username);
    if (!/^[\p{L}\p{N}._-]{3,40}$/u.test(username)) throw new Error('Kullanıcı adı 3-40 karakter olmalıdır.');
    if (String(input.password || '').length < 8) throw new Error('Parola en az 8 karakter olmalıdır.');
    if (await this.getUser(username)) throw new Error('Bu kullanıcı adı zaten var.');
    const email = normalizeEmail(input.email);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Geçerli bir e-posta adresi girin.');
    if (email && await this.findUserByEmail(email)) throw new Error('Bu e-posta adresi başka bir hesapta kullanılıyor.');
    const role = input.role === 'admin' ? 'admin' : 'user';
    const dailyQuota = role === 'admin' ? 999999 : Math.max(1, Math.min(10000, Number(input.dailyQuota) || this.defaultDailyQuota));
    const trialEndsAt = isoOrNull(input.trialEndsAt);
    await this.insertUser({
      username,
      passwordHash: hashPassword(input.password),
      fullName: String(input.fullName || '').trim().slice(0, 160),
      email,
      role,
      active: input.active === undefined ? true : Boolean(input.active),
      dailyQuota,
      trialDays: role === 'admin' ? 0 : Math.max(0, Math.min(365, Number(input.trialDays) || 3)),
      trialEndsAt,
      createdAt: new Date().toISOString(),
      invitedAt: null
    });
    return this.publicUser(await this.getUser(username));
  }

  async updateUser(username, input = {}) {
    const current = await this.getUser(username);
    if (!current) throw new Error('Kullanıcı bulunamadı.');
    const role = input.role === 'admin' ? 'admin' : input.role === 'user' ? 'user' : current.role;
    const active = input.active === undefined ? current.active : Boolean(input.active);
    const dailyQuota = role === 'admin' ? 999999 : Math.max(1, Math.min(10000, Number(input.dailyQuota) || current.dailyQuota));
    const trialEndsAt = input.trialEndsAt === undefined ? current.trialEndsAt : isoOrNull(input.trialEndsAt);
    const trialDays = role === 'admin' ? 0 : input.trialDays === undefined ? current.trialDays : Math.max(0, Math.min(365, Number(input.trialDays) || 0));
    const fullName = input.fullName === undefined ? current.fullName : String(input.fullName || '').trim().slice(0, 160);
    let email = input.email === undefined ? current.email : normalizeEmail(input.email);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Geçerli bir e-posta adresi girin.');
    const emailOwner = email ? await this.findUserByEmail(email) : null;
    if (emailOwner && emailOwner.username !== current.username) throw new Error('Bu e-posta adresi başka bir hesapta kullanılıyor.');
    if (this.provider === 'postgres') {
      await this.pool.query(`UPDATE users SET role=$1,active=$2,daily_quota=$3,trial_days=$4,trial_ends_at=$5,full_name=$6,email=$7 WHERE username=$8`,
        [role, active, dailyQuota, trialDays, trialEndsAt, fullName || null, email || null, current.username]);
    } else {
      this.db.prepare(`UPDATE users SET role=?,active=?,daily_quota=?,trial_days=?,trial_ends_at=?,full_name=?,email=? WHERE username=?`)
        .run(role, active ? 1 : 0, dailyQuota, trialDays, trialEndsAt, fullName || null, email || null, current.username);
    }
    if (input.password) {
      if (String(input.password).length < 8) throw new Error('Parola en az 8 karakter olmalıdır.');
      if (this.provider === 'postgres') await this.pool.query('UPDATE users SET password_hash=$1 WHERE username=$2', [hashPassword(input.password), current.username]);
      else this.db.prepare('UPDATE users SET password_hash=? WHERE username=?').run(hashPassword(input.password), current.username);
    }
    return this.publicUser(await this.getUser(current.username));
  }

  async updateProfile(username, input = {}) {
    const current = await this.getUser(username);
    if (!current) throw new Error('Kullanıcı bulunamadı.');
    const fullName = String(input.fullName ?? current.fullName).trim().slice(0, 160);
    const email = normalizeEmail(input.email ?? current.email);
    if (fullName && fullName.length < 3) throw new Error('Ad soyad en az 3 karakter olmalıdır.');
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Geçerli bir e-posta adresi girin.');
    const owner = email ? await this.findUserByEmail(email) : null;
    if (owner && owner.username !== current.username) throw new Error('Bu e-posta adresi başka bir hesapta kullanılıyor.');
    if (this.provider === 'postgres') await this.pool.query('UPDATE users SET full_name=$1,email=$2 WHERE username=$3', [fullName || null, email || null, current.username]);
    else this.db.prepare('UPDATE users SET full_name=?,email=? WHERE username=?').run(fullName || null, email || null, current.username);
    return this.publicUser(await this.getUser(current.username));
  }

  async changePassword(username, currentPassword, newPassword) {
    const user = await this.getUser(username);
    if (!user || !verifyPassword(currentPassword, user.passwordHash)) throw new Error('Mevcut parola doğru değil.');
    if (String(newPassword || '').length < 8) throw new Error('Yeni parola en az 8 karakter olmalıdır.');
    const nextHash = hashPassword(newPassword);
    if (this.provider === 'postgres') await this.pool.query('UPDATE users SET password_hash=$1 WHERE username=$2', [nextHash, user.username]);
    else this.db.prepare('UPDATE users SET password_hash=? WHERE username=?').run(nextHash, user.username);
    return { ok: true };
  }

  async uniqueUsername(seed) {
    const base = usernameSeed(seed);
    let candidate = base;
    for (let index = 1; index < 1000; index += 1) {
      if (!await this.getUser(candidate)) return candidate;
      candidate = `${base.slice(0, 34)}${index + 1}`;
    }
    throw new Error('Benzersiz kullanıcı adı oluşturulamadı.');
  }

  async createAuthToken(username, purpose, ttlHours, accessRequestId = null) {
    const token = randomToken();
    const hash = tokenHash(token);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + Math.max(1, Number(ttlHours) || 1) * 3_600_000).toISOString();
    const createdAt = now.toISOString();
    if (this.provider === 'postgres') {
      await this.pool.query('UPDATE auth_tokens SET used_at=$1 WHERE username=$2 AND purpose=$3 AND used_at IS NULL', [createdAt, username, purpose]);
      await this.pool.query(`INSERT INTO auth_tokens(token_hash,username,purpose,access_request_id,expires_at,used_at,created_at)
        VALUES($1,$2,$3,$4,$5,NULL,$6)`, [hash, username, purpose, accessRequestId, expiresAt, createdAt]);
    } else {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.prepare('UPDATE auth_tokens SET used_at=? WHERE username=? AND purpose=? AND used_at IS NULL').run(createdAt, username, purpose);
        this.db.prepare(`INSERT INTO auth_tokens(token_hash,username,purpose,access_request_id,expires_at,used_at,created_at)
          VALUES(?,?,?,?,?,NULL,?)`).run(hash, username, purpose, accessRequestId, expiresAt, createdAt);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
    return { token, expiresAt };
  }

  async prepareInviteFromRequest(id, { username = '', dailyQuota, trialDays = 3, ttlHours = 48 } = {}) {
    const request = await this.getAccessRequest(id);
    if (!request) throw new Error('Erişim talebi bulunamadı.');
    let user = await this.findUserByEmail(request.email);
    if (!user) {
      const selectedUsername = username ? normalizeUsername(username) : await this.uniqueUsername(request.email.split('@')[0]);
      if (!/^[\p{L}\p{N}._-]{3,40}$/u.test(selectedUsername)) throw new Error('Kullanıcı adı 3-40 karakter olmalıdır.');
      if (await this.getUser(selectedUsername)) throw new Error('Bu kullanıcı adı zaten var.');
      await this.insertUser({
        username: selectedUsername,
        passwordHash: hashPassword(randomToken()),
        fullName: request.fullName,
        email: request.email,
        role: 'user',
        active: false,
        dailyQuota: Math.max(1, Math.min(10000, Number(dailyQuota) || this.defaultDailyQuota)),
        trialDays: Math.max(0, Math.min(365, Number(trialDays) || 3)),
        trialEndsAt: null,
        createdAt: new Date().toISOString(),
        invitedAt: new Date().toISOString()
      });
      user = await this.getUser(selectedUsername);
    } else {
      await this.updateUser(user.username, {
        fullName: request.fullName || user.fullName,
        email: request.email,
        dailyQuota: Number(dailyQuota) || user.dailyQuota,
        trialDays: Number(trialDays) || user.trialDays,
        active: user.active
      });
      user = await this.getUser(user.username);
      const now = new Date().toISOString();
      if (this.provider === 'postgres') await this.pool.query('UPDATE users SET invited_at=$1 WHERE username=$2', [now, user.username]);
      else this.db.prepare('UPDATE users SET invited_at=? WHERE username=?').run(now, user.username);
    }
    await this.updateAccessRequest(request.id, { status: 'approved' });
    const auth = await this.createAuthToken(user.username, 'invite', ttlHours, request.id);
    return { request, user: await this.publicUser(await this.getUser(user.username)), ...auth };
  }

  async createPasswordReset(identifier, ttlHours = 2) {
    const normalized = String(identifier || '').trim();
    const user = normalized.includes('@') ? await this.findUserByEmail(normalized) : await this.getUser(normalized);
    if (!user || !user.email || !user.active) return null;
    const auth = await this.createAuthToken(user.username, 'password-reset', ttlHours, null);
    return { user: await this.publicUser(user), ...auth };
  }

  async consumePasswordToken(token, purpose, newPassword) {
    if (String(newPassword || '').length < 8) throw new Error('Parola en az 8 karakter olmalıdır.');
    const hash = tokenHash(token);
    const now = new Date().toISOString();
    const nextPassword = hashPassword(newPassword);
    if (this.provider === 'postgres') {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const row = (await client.query(`SELECT * FROM auth_tokens
          WHERE token_hash=$1 AND purpose=$2 AND used_at IS NULL AND expires_at>$3 FOR UPDATE`, [hash, purpose, now])).rows[0];
        if (!row) throw new Error('Bağlantı geçersiz veya süresi dolmuş.');
        let trialEndsAt = null;
        if (purpose === 'invite') {
          const userRow = (await client.query('SELECT trial_days,trial_ends_at FROM users WHERE username=$1', [row.username])).rows[0];
          if (!userRow?.trial_ends_at && Number(userRow?.trial_days || 0) > 0) {
            trialEndsAt = new Date(Date.now() + Number(userRow.trial_days) * 86_400_000).toISOString();
          }
        }
        await client.query(`UPDATE users SET password_hash=$1,active=true,trial_ends_at=COALESCE(trial_ends_at,$2) WHERE username=$3`, [nextPassword, trialEndsAt, row.username]);
        await client.query('UPDATE auth_tokens SET used_at=$1 WHERE id=$2', [now, row.id]);
        if (row.access_request_id) await client.query("UPDATE access_requests SET status='approved',updated_at=$1 WHERE id=$2", [now, row.access_request_id]);
        await client.query('COMMIT');
        return { username: row.username };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
    let result;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare(`SELECT * FROM auth_tokens WHERE token_hash=? AND purpose=? AND used_at IS NULL AND expires_at>?`).get(hash, purpose, now);
      if (!row) throw new Error('Bağlantı geçersiz veya süresi dolmuş.');
      const userRow = this.db.prepare('SELECT trial_days,trial_ends_at FROM users WHERE username=?').get(row.username);
      let trialEndsAt = userRow?.trial_ends_at || null;
      if (purpose === 'invite' && !trialEndsAt && Number(userRow?.trial_days || 0) > 0) {
        trialEndsAt = new Date(Date.now() + Number(userRow.trial_days) * 86_400_000).toISOString();
      }
      this.db.prepare('UPDATE users SET password_hash=?,active=1,trial_ends_at=COALESCE(trial_ends_at,?) WHERE username=?').run(nextPassword, trialEndsAt, row.username);
      this.db.prepare('UPDATE auth_tokens SET used_at=? WHERE id=?').run(now, row.id);
      if (row.access_request_id) this.db.prepare("UPDATE access_requests SET status='approved',updated_at=? WHERE id=?").run(now, row.access_request_id);
      result = { username: row.username };
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return result;
  }

  async completeInvite(token, password) {
    return this.consumePasswordToken(token, 'invite', password);
  }

  async resetPassword(token, password) {
    return this.consumePasswordToken(token, 'password-reset', password);
  }

  async getSiteContent() {
    const rows = this.provider === 'postgres'
      ? (await this.pool.query('SELECT key,value FROM site_settings')).rows
      : this.db.prepare('SELECT key,value FROM site_settings').all();
    const result = { ...DEFAULT_SITE_CONTENT };
    for (const row of rows) if (Object.hasOwn(result, row.key)) result[row.key] = row.value;
    return result;
  }

  async updateSiteContent(input = {}) {
    const current = await this.getSiteContent();
    const next = {
      heroBadge: String(input.heroBadge ?? current.heroBadge).trim().slice(0, 80) || 'Kadastro360',
      heroTitle: String(input.heroTitle ?? current.heroTitle).trim().slice(0, 220) || current.heroTitle,
      heroDescription: String(input.heroDescription ?? current.heroDescription).trim().slice(0, 1000) || current.heroDescription,
      contactEmail: normalizeEmail(input.contactEmail ?? current.contactEmail),
      footerNote: String(input.footerNote ?? current.footerNote).trim().slice(0, 500) || current.footerNote
    };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.contactEmail)) throw new Error('Geçerli bir iletişim e-posta adresi girin.');
    const now = new Date().toISOString();
    for (const [key, value] of Object.entries(next)) {
      if (this.provider === 'postgres') {
        await this.pool.query(`INSERT INTO site_settings(key,value,updated_at) VALUES($1,$2,$3)
          ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=EXCLUDED.updated_at`, [key, value, now]);
      } else {
        this.db.prepare(`INSERT INTO site_settings(key,value,updated_at) VALUES(?,?,?)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(key, value, now);
      }
    }
    return next;
  }

  async close() {
    if (this.pool) await this.pool.end();
    if (this.db) this.db.close();
  }
}

module.exports = {
  AccountStore,
  normalizeUsername,
  normalizeEmail,
  hashPassword,
  verifyPassword,
  parcelHistoryKey,
  DEFAULT_SITE_CONTENT
};
