'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AccountStore } = require('./account-store');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k360-admin-'));
try {
  const store = new AccountStore({ dataDir, adminUsername: 'admin', adminPassword: 'GucluParola123!', defaultDailyQuota: 20 });
  const admin = store.authenticate('admin', 'GucluParola123!');
  assert(admin && admin.role === 'admin', 'Yönetici hesabı doğrulanamadı.');
  store.createAccessRequest({ fullName: 'Test Kullanıcı', company: 'Test Kurum', email: 'test@example.com', phone: '5551112233', note: 'Pilot erişim' });
  const rows = store.listAccessRequests();
  assert.strictEqual(rows.length, 1, 'Erişim talebi kaydedilmedi.');
  assert.strictEqual(rows[0].status, 'new', 'Yeni erişim talebi durumu hatalı.');
  const updated = store.updateAccessRequest(rows[0].id, { status: 'reviewed' });
  assert.strictEqual(updated.status, 'reviewed', 'Erişim talebi durumu güncellenmedi.');
  const user = store.createUser({ username: 'pilot1', password: 'PilotParola123!', dailyQuota: 12 });
  assert.strictEqual(user.dailyQuota, 12, 'Pilot kullanıcı kotası kaydedilmedi.');
  assert(store.authenticate('pilot1', 'PilotParola123!'), 'Pilot kullanıcı giriş yapamadı.');
  console.log('Kadastro360 yönetici, erişim talebi ve hesap deposu testi geçti.');
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
}
