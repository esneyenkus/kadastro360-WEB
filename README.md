# Kadastro360 Web Pilot v1.3

Gerçek veri kullanan web pilotudur. Örnek parsel, rastgele eğim, sahte yakın yer, sahte katman veya tahmini rayiç üretmez.

## Bu sürümde düzeltilenler

- ULASAV/TUCBS WMS katmanları artık Render sunucusunun `GetCapabilities` isteğine bağlı değildir.
- Renkli plan ve ortofoto katmanları kullanıcının tarayıcısından doğrudan yüklenir.
- Bilinen WMS katman adları denenir; gerekirse tarayıcıdan katman listesi keşfedilir.
- Sunucu katalog servisine ulaşamasa bile pilot WMS kaynağı ve resmî kaynak bağlantısı listelenir.
- Kullanıcı ekranındaki teknik **Servisi Aç** XML bağlantısı kaldırıldı.
- Üstteki TKGM, Eğim, Yakın Yer, TUCBS ve Açık Veri kutuları görünürlük düğmesine dönüştürüldü.
- Yakın yer işaretçileri tek tıkla haritadan gizlenip yeniden gösterilebilir.
- Açık veri katmanları seçili kalırken tek tıkla gizlenip yeniden gösterilebilir.
- TKGM HTTP 404 yanıtı artık anlaşılır parsel bulunamadı mesajına çevrilir.
- Açık veri katalog/CSV kontrolü uzun sürerse WMS listesi bekletilmez; resmî kaynak bağlantıları gösterilir.
- Açık Veri bölümündeki tekrar eden bilgilendirme metni kaldırıldı.

## Pilot bölgeler

1. **Kayseri / Sivas / Yozgat**
   - Yozgat–Sivas–Kayseri Çevre Düzeni Planı
   - Kayseri idari sınır kaynakları

2. **Tekirdağ / Çorlu**
   - Tekirdağ–Kırklareli–Edirne Çevre Düzeni Planı
   - Çorlu Belediyesi arsa rayiç kaynakları

3. **Kırıkkale / Yahşihan**
   - Kırıkkale Çevre Düzeni Planı
   - Yahşihan rayiç kaynakları

4. **Giresun / Görele**
   - Doğu Karadeniz Çevre Düzeni Planı
   - Kamuya açık Görele ortofoto WMS örneği

## Açık veri kullanımı

1. Gerçek TKGM parsel sorgusunu tamamlayın.
2. **Açık Veri** sekmesini açın.
3. **Açık Katmanları Kontrol Et** düğmesine basın.
4. İstediğiniz katmanda **Haritaya Ekle** düğmesine basın.
5. Katmanı geçici olarak gizlemek için üstteki **Açık Veri** kutusuna tıklayın.
6. Renklerin açıklaması için **Renk Lejantı**, güncel kayıt için **Kaynak Sayfası** bağlantısını kullanın.

WMS katmanı yüklenemezse sistem sahte renk üretmez. Katman kartında hata gösterilir ve resmî kaynak bağlantısı kullanılabilir.

## Yakın yer görünürlüğü

Yakın yer araması tamamlandığında işaretçiler haritada gösterilir. Üstteki **Yakın Yer** kutusuna tıklayınca işaretçiler, kuş uçuşu çizgisi ve mesafe etiketi gizlenir. Tekrar tıklanınca aynı sonuçlar yeniden görünür.

## Rayiç verisi ilkesi

Rayiç özeti yalnızca sağlayıcının yayımladığı makine okunabilir dosyada rayiç/değer/bedel sütunu güvenli biçimde tespit edilebilirse hesaplanır. Ekranda veri yılı, en düşük ve en yüksek kayıt ile kaynak sütun gösterilir. CSV uygun değilse veya yalnızca PDF varsa otomatik değer gösterilmez; doğrudan kaynak bağlantısı sunulur. Belediye rayici piyasa satış değeri değildir.

## TUCBS sınırı

TUCBS e-Devlet oturumu ve kendi yetkilendirmesini kullanır. Kadastro360 kullanıcı adına e-Devlet girişi yapmaz. Kamuya açık WMS/GeoJSON kaynakları Kadastro360 içinde kullanıcı isteğiyle açılabilir; yetkili veya kapalı katmanlar için TUCBS bağlantısı korunur.

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
