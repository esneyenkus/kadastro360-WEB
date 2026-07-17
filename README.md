# Kadastro360 Web Pilot v1.1

Gerçek veri kullanan web pilotudur. Örnek parsel, rastgele eğim veya sahte yakın yer üretmez.

## Bu sürümde yeni

- TUCBS / Ulusal Coğrafi Bilgi Platformu geçiş köprüsü
- Seçilen parselin il, ilçe, mahalle, ada/parsel ve merkez koordinatını TUCBS için hazırlama
- TUCBS koordinat ve parsel özeti kopyalama
- TKGM, eğim, yakın yer ve TUCBS durum göstergeleri
- Parsel sorgusunda aşamalı ilerleme
- SQLite tabanlı kullanıcılar, günlük kota ve sorgu geçmişi
- Yönetici panelinden kullanıcı oluşturma, pasifleştirme ve kota değiştirme
- Başarısız giriş denemesi kilidi
- Mobil haritayı küçültme/açma

## TUCBS sınırı

TUCBS e-Devlet oturumu ve kendi katman seçim ekranını kullanır. Kadastro360 kullanıcı adına e-Devlet girişi yapmaz. Bu sürüm TUCBS'yi tek tıkla açar ve seçilen parsel koordinatını/özetini hazırlar. TUCBS doğrudan URL ile katman ve koordinat kabul ettiğini resmen belgelemediği için var olmayan bir katmanı seçilmiş gibi göstermez.

TUCBS içinde önerilen aramalar:

- Arazi Kullanımı
- İlgili ilin Çevre Düzeni Planı
- E-Plan Kesinleşmiş

## Kurulum

Node.js 22 gerekir.

```bash
npm install
npm run check
npm start
```

Gerekli değişkenler `.env.example` dosyasındadır. Render'da `TEST_PASSWORD` ve `SESSION_SECRET` mutlaka ayarlanmalıdır.

## Veri kalıcılığı

Kullanıcı ve geçmiş verileri `DATA_DIR` içindeki SQLite dosyasında tutulur. Render ücretsiz dosya sistemi yeniden dağıtımda kalıcı olmayabilir. Kalıcı kullanımda Render Persistent Disk veya harici veritabanı kullanılmalıdır ve `DATA_DIR` kalıcı diske yönlendirilmelidir.
