# Kadastro360 Web Pilot v1.4

Gerçek veri kullanan web pilotudur. Örnek parsel, rastgele eğim, sahte yakın yer, sahte katman veya tahmini rayiç üretmez.

## Bu sürümde düzeltilenler

- Çevre düzeni planı katmanı açılırken harita otomatik olarak planın görülebileceği uygun ölçeğe alınır.
- Parsel sınırı, renkli kamu katmanının üzerinde görünür kalır.
- Harita mesajı sadeleştirildi: `1 kamu katmanı açık · Parsel sınırı görünür`.
- Teknik `GetLegendGraphic` bağlantısı ve kod/XML sayfası kullanıcı ekranından kaldırıldı.
- Her plan kartına **Renk Rehberi** ve **Plan Ölçeğine Git** düğmeleri eklendi.
- Renk rehberi, 22.01.2026 tarihli resmî EK-1c Çevre Düzeni Planı Gösterimleri temel alınarak uygulama içinde gösterilir.
- Rehberde sarı, mavi, mor, yeşil alanlar ile tarama ve sınır çizgilerinin başlıca anlamları yer alır.
- Plan katmanı görünmezse sahte renk üretilmez; kullanıcıya servis veya ölçek uyarısı gösterilir.
- Kaynak sayfası bağlantıları korunur.

## Pilot bölgeler

1. Kayseri / Sivas / Yozgat — Yozgat–Sivas–Kayseri Çevre Düzeni Planı
2. Tekirdağ / Kırklareli / Edirne — Trakya/Ergene Çevre Düzeni Planı
3. Kırıkkale — Kırıkkale Çevre Düzeni Planı
4. Giresun / Görele — Doğu Karadeniz Çevre Düzeni Planı ve Görele ortofoto

## Açık veri kullanımı

1. Gerçek TKGM parsel sorgusunu tamamlayın.
2. **Açık Veri** sekmesini açın.
3. **Açık Katmanları Kontrol Et** düğmesine basın.
4. İlgili plan kartında **Haritaya Ekle** düğmesine basın.
5. Sistem haritayı plan ölçeğine getirir; gerekirse **Plan Ölçeğine Git** düğmesini kullanın.
6. Renk ve taramaları uygulama içindeki **Renk Rehberi** ile karşılaştırın.
7. Güncel resmî kayıt için **Kaynak Sayfası** bağlantısını kullanın.

Çevre düzeni planları üst ölçekli planlardır. Parselin kesin imar durumu, yapılaşma hakkı veya piyasa değeri anlamına gelmez. Aktif plan daha eski veya değişiklik görmüşse uygulamadaki genel renk rehberinden farklı olabilir; güncel resmî plan paftası ve lejant esas alınır.

## Kurulum

Node.js 22 gerekir.

```bash
npm install
npm run check
npm start
```

Gerekli değişkenler `.env.example` dosyasındadır. Render'da `TEST_PASSWORD` ve `SESSION_SECRET` mutlaka ayarlanmalıdır.
