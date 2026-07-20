# Kadastro360 Web Pilot v1.5.2

Gerçek veri kullanan web pilotudur. Örnek parsel, rastgele eğim, sahte yakın yer, sahte açık katman veya tahmini rayiç üretmez.


## v1.5.2 TKGM il → ilçe düzeltmesi

İl seçildikten sonra görülen `HTTP 404` hatası iki ayrı nedenle oluşabiliyordu:

- TKGM yanıtında gerçek `ilId / ilceId / mahalleId` yerine `fid` veya `objectid` alanı seçilebiliyordu.
- v3.1 ve eski TKGM servisleri eşzamanlı kullanıldığı için bir kaynaktan alınan kimlik başka kaynağa gönderilebiliyordu.

v1.5.2 ile:

- seviyeye özgü gerçek TKGM kimliği öncelikli seçilir,
- il, ilçe, mahalle ve parsel aynı TKGM kaynak zincirinde tutulur,
- eski servislerde görülen çift eğik çizgili idari uçlar yalnızca yedek olarak denenir,
- arayüz ham `HTTP 404` yerine açıklayıcı servis mesajı gösterir,
- il → ilçe → mahalle → parsel akışı yerel sahte TKGM sunucusuyla uçtan uca regresyon testinden geçirilir.

Paket içinde boş `data` klasörü yoktur. Veritabanı klasörü uygulama çalışırken otomatik oluşturulur; Render test ortamında `/tmp/kadastro360-data` kullanılır.

## v1.5 açık veri düzeltmesi

Önceki sürümde WMS sunucusundan boş/şeffaf bir PNG gelmesi, Leaflet `tileload` olayı nedeniyle katman yüklenmiş gibi algılanabiliyordu. v1.5 bunu değiştirdi:

- Resmî WMS `GetCapabilities` belgesi okunur.
- Tek bir `0` katmanı yerine görünür alt katmanlar ve birleşik plan katmanı denenir.
- Parsel çevresinden ayrı bir `GetMap` görüntüsü alınır.
- PNG görüntüsü piksel düzeyinde kontrol edilir.
- Tamamen şeffaf veya boş görüntü başarılı sayılmaz ve haritaya eklenmez.
- Tarayıcı doğrulaması yapılamazsa sunucu üzerinden güvenli doğrulama denenir.
- Katman yalnızca görünür plan içeriği doğrulanırsa aktif sayılır.

## Plan Ölçeğine Git

Düğme her basışta:

- haritayı parsel merkezinde yakınlaştırma 10 düzeyine getirir,
- aktif plan katmanını yeniden çizer,
- parsel sınırını planın üzerinde tutar.

## Pilot bölgeler

1. Kayseri / Sivas / Yozgat — Yozgat–Sivas–Kayseri Çevre Düzeni Planı
2. Tekirdağ / Kırklareli / Edirne — Trakya/Ergene Çevre Düzeni Planı
3. Kırıkkale — Kırıkkale Çevre Düzeni Planı
4. Giresun / Görele — Doğu Karadeniz Çevre Düzeni Planı ve Görele ortofoto

## Kullanım

1. Gerçek TKGM parsel sorgusunu tamamlayın.
2. **Açık Veri** sekmesini açın.
3. **Açık Katmanları Kontrol Et** düğmesine basın.
4. İlgili plan kartında **Haritaya Ekle** düğmesine basın.
5. Sistem görünür içeriği doğrular. Boş görüntü varsa katmanı eklemez ve açık hata verir.
6. **Plan Ölçeğine Git** ile görünümü yeniden hazırlayabilirsiniz.
7. Renkleri uygulama içindeki **Renk Rehberi** ile karşılaştırın.
8. Güncel resmî kayıt için **Kaynak Sayfası** bağlantısını kullanın.

Çevre düzeni planları üst ölçekli planlardır. Parselin kesin imar durumu, yapılaşma hakkı veya piyasa değeri anlamına gelmez. Güncel resmî pafta ve sağlayıcı kaydı esas alınmalıdır.

## Kurulum

Node.js 22 gerekir.

```bash
npm install
npm run check
npm start
```

Gerekli değişkenler `.env.example` dosyasındadır. `TEST_PASSWORD` ve `SESSION_SECRET` mutlaka ayarlanmalıdır.


## v1.5.1 Render düzeltmesi

- package-lock.json içindeki özel/erişilemez paket adresi kaldırıldı.
- pngjs paketi resmî npm kayıt adresinden yüklenir.
- Render derlemesi `npm ci --omit=dev && npm run check` ile doğrulanır.
- Node.js sürümü 22.16.0 olarak sabitlendi.
