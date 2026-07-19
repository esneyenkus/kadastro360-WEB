# Kadastro360 Web Pilot v1.5

Gerçek veri kullanan web pilotudur. Örnek parsel, rastgele eğim, sahte yakın yer, sahte açık katman veya tahmini rayiç üretmez.

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
