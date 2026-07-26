'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AccountStore } = require('./account-store');

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k360-admin-'));
  const store = new AccountStore({ dataDir, adminUsername: 'admin', adminPassword: 'GucluParola123!', defaultDailyQuota: 20 });
  try {
    await store.init();
    const admin = await store.authenticate('admin', 'GucluParola123!');
    assert(admin && admin.role === 'admin', 'Yönetici hesabı doğrulanamadı.');

    await store.createAccessRequest({ fullName: 'Test Kullanıcı', company: 'Test Kurum', email: 'test@example.com', phone: '5551112233', note: 'Pilot erişim' });
    let rows = await store.listAccessRequests();
    assert.strictEqual(rows.length, 1, 'Erişim talebi kaydedilmedi.');
    assert.strictEqual(rows[0].status, 'new', 'Yeni erişim talebi durumu hatalı.');

    const invitation = await store.prepareInviteFromRequest(rows[0].id, { username: 'pilot1', dailyQuota: 12, trialDays: 3, ttlHours: 48 });
    assert.strictEqual(invitation.user.username, 'pilot1', 'Davet kullanıcısı oluşturulmadı.');
    await store.completeInvite(invitation.token, 'PilotParola123!');
    assert(await store.authenticate('pilot1', 'PilotParola123!'), 'Davet edilen kullanıcı giriş yapamadı.');

    await store.logQuery({ username: 'pilot1', province: 'Tekirdağ', district: 'Çorlu', neighborhood: 'Önerler', blockNo: '323', parcelNo: '2', latitude: 41, longitude: 27 });
    await store.logQuery({ username: 'pilot1', province: 'Tekirdağ', district: 'Çorlu', neighborhood: 'Önerler', blockNo: '323', parcelNo: '2', latitude: 41.1, longitude: 27.1 });
    const history = await store.history('pilot1', 30);
    assert.strictEqual(history.length, 1, 'Aynı parsel geçmişte mükerrer kaydedildi.');
    assert.strictEqual(Number(history[0].latitude), 41.1, 'Mükerrer sorguda en güncel kayıt korunmadı.');

    await store.updateProfile('pilot1', { fullName: 'Pilot Kullanıcı', email: 'pilot@example.com' });
    const reset = await store.createPasswordReset('pilot@example.com', 2);
    assert(reset?.token, 'Parola yenileme bağlantısı üretilemedi.');
    await store.resetPassword(reset.token, 'YeniPilotParola123!');
    assert(await store.authenticate('pilot1', 'YeniPilotParola123!'), 'Parola yenileme çalışmadı.');

    const content = await store.updateSiteContent({ contactEmail: 'info@kadastro360.com.tr', heroBadge: 'Kadastro360' });
    assert.strictEqual(content.contactEmail, 'info@kadastro360.com.tr', 'Site iletişim içeriği kaydedilmedi.');
    console.log('Kadastro360 hesap, davet, parola, içerik ve mükerrer geçmiş testleri geçti.');
  } finally {
    await store.close().catch(() => {});
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
