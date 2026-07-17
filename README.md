# Kadastro360 Web Pilot v1.2

Gerçek veri kullanan web pilotudur. Örnek parsel, rastgele eğim, sahte yakın yer, sahte katman veya tahmini rayiç üretmez.

## Bu sürümde yeni

- Kullanıcının isteğiyle çalışan **Açık Veri** sekmesi
- Parsel sorgusundan sonra seçilen il/ilçeye uygun ULASAV/TUCBS açık kaynak kontrolü
- Katmanların otomatik yüklenmemesi; her katmanın ayrı ayrı eklenip kaldırılması
- Kamuya açık Çevre Düzeni Planı WMS katmanları
- Plan katmanı aktifken haritada tıklanan noktaya ait GetFeatureInfo sorgusu
- Renk lejantı, resmî kaynak sayfası ve doğrudan servis bağlantıları
- Kayseri ilçe/mahalle sınırı GeoJSON kaynaklarının dinamik keşfi
- Görele ortofoto pilotu
- Çorlu ve Yahşihan açık rayiç kayıtlarının dinamik aranması
- Makine okunabilir CSV bulunursa en düşük/en yüksek rayiç kaydı özeti
- Her veri kartında güncelleme/erişim tarihi ve güncellik uyarısı
- Kaynak tarihi veya veri yapısı uygun değilse değer üretmeme

## Pilot bölgeler

1. Kayseri
   - Yozgat–Sivas–Kayseri Çevre Düzeni Planı
   - ULASAV Kayseri ilçe ve mahalle sınırları

2. Tekirdağ / Çorlu
   - Tekirdağ–Kırklareli–Edirne Çevre Düzeni Planı
   - ULASAV/Çorlu Belediyesi arsa rayiç kayıtları

3. Kırıkkale / Yahşihan
   - Kırıkkale Çevre Düzeni Planı
   - ULASAV'da yayımlanmış Yahşihan rayiç kayıtları

4. Giresun / Görele
   - Doğu Karadeniz Çevre Düzeni Planı
   - Kamuya açık Görele ortofoto WMS örneği

## Kullanım

1. Gerçek TKGM parsel sorgusunu tamamlayın.
2. **Açık Veri** sekmesini açın.
3. **Açık Katmanları Kontrol Et** düğmesine basın.
4. İstediğiniz katmanda **Haritaya Ekle** düğmesine basın.
5. Plan katmanı aktifken haritada bir noktaya tıklayarak servis öznitelik bilgisini sorgulayın.
6. Renklerin açıklaması için **Renk Lejantı**, güncel kayıt için **Kaynak Sayfası** bağlantısını kullanın.

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
