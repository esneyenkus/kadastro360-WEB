# Kadastro360 Web Pilot v1.6.0

Gerçek veri kullanan web pilotudur. Örnek parsel, rastgele eğim, sahte yakın yer, sahte açık katman veya tahmini rayiç üretmez.


## v1.6.0 harita performansı ve karşılaştırma

- Çevre düzeni planı, çok sayıda WMS karosu yerine tek ve yüksek çözünürlüklü görüntü olarak doğrulanıp tarayıcı önbelleğine alınır.
- **Haritaya Ekle** düğmesi parsel merkezini veya yakınlaştırma seviyesini değiştirmez.
- Yakınlaştırma ve uzaklaştırmada plan verisi yeniden indirilmez; önbellekteki görüntü anında ölçeklenir.
- **Plan Ölçeğine Git** yalnızca kullanıcı istediğinde çalışır.
- Parsel beyaz dış çerçeve ve yeşil sınırla kamu katmanının üstünde tutulur.
- Harita uzaklaştırıldığında kırmızı, animasyonlu **PARSEL** hedefi çıkar; yakınlaştıkça küçülür ve ilk sorgu yakınlığında kaybolur.
- Aynı mahallede sorgulanan son 10 parsel tarayıcı oturumu boyunca tutulur ve turuncu kesik çizgiyle karşılaştırılır.
- Karşılaştırma katmanı harita üzerindeki küçük kontrolden gizlenebilir veya temizlenebilir.
- Renk rehberi artık ekranı karartmaz; bağımsız pencere olarak fareyle taşınır.

## TKGM il → ilçe regresyon koruması

- Gerçek `ilId / ilceId / mahalleId` alanları önceliklidir.
- İl, ilçe, mahalle ve parsel aynı TKGM kaynak zincirinde tutulur.
- Eski servis yolları yalnızca kontrollü yedek olarak denenir.
- Ham `HTTP 404` yerine açıklayıcı kullanıcı mesajı gösterilir.
- İl → ilçe → mahalle → parsel akışı otomatik regresyon testinden geçirilir.

Paket içinde boş `data` klasörü yoktur. Veritabanı klasörü uygulama çalışırken otomatik oluşturulur.

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
