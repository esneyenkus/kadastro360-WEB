# Kadastro360 Web Pilot v1.7.0

Gerçek veri kullanan web pilotudur. Örnek parsel, rastgele eğim, sahte yakın yer, sahte açık katman, düz çizgiyi yol rotası gibi gösterme veya tahmini rayiç üretmez.

## v1.7.0 — yakın yer seçimi ve harita içi yol rotaları

1. Parseli sorgulayın ve **Yakın Yerleri Bul** düğmesine basın.
2. Sonuçlar tek bir kategori akordeon grubunda gösterilir.
3. Kapalı başlıkta örneğin **Market · 15 adet** bilgisi kalır.
4. İstediğiniz yakın yerlerin yanındaki kutuları işaretleyin. En fazla 5 nokta seçilebilir.
5. **Seçili Rotaları Çiz** düğmesine basın.
6. Parsel merkezinden her seçili noktaya gerçek yol ağı rotası haritada çizilir.
7. Her rota için yol mesafesi ve tahmini sürüş süresi gösterilir.

Rotalar birbirinden ayrı çizilir. Bu yaklaşım, alıcıya hazırlanacak ekran görüntüsünde okul, hastane, market gibi farklı noktaların parsele yol erişimini karşılaştırmayı kolaylaştırır.

Pilot sürüm varsayılan olarak OSRM rota servisini kullanır. Üretim sunucusunda `ROUTING_BASE_URL` değişkeni kendi OSRM sunucumuza yönlendirilebilir. Dış servis yanıt vermezse sahte rota çizilmez.

## Açık plan katmanındaki kesik görüntü düzeltmesi

v1.6.0, performans için tek ve sabit bir WMS görüntüsü kullanıyordu. Harita o görüntünün sınırının dışına taşındığında katman kesik görünüyordu.

v1.7.0'da:

- İlk doğrulanmış görüntü hemen gösterilir.
- Harita taşındığında mevcut ekranı ve çevresini kapsayan yeni görüntü arka planda hazırlanır.
- Yakınlaştırma tamamlandığında daha uygun çözünürlükte görüntü istenir.
- Eski görüntü, yenisi tamamen hazır olana kadar kaldırılmaz.
- Parsel sınırı ve PARSEL hedefi katmanın üstünde tutulur.

Bu yöntem hem kesik görüntüyü giderir hem de her hareket sırasında yüzlerce WMS karosu istemeden daha kontrollü çalışır.

## Aynı mahallede parsel karşılaştırması

Aynı mahallede sorgulanan son 10 parsel tarayıcı oturumu boyunca saklanır. Önceki parseller turuncu kesik sınırla gösterilir. Harita üzerindeki **Karşılaştırma** kontrolünden gizlenebilir veya temizlenebilir.

## Açık veri kullanımı

1. Gerçek TKGM parsel sorgusunu tamamlayın.
2. **Açık Veri** sekmesini açın.
3. **Açık Katmanları Kontrol Et** düğmesine basın.
4. İlgili plan kartında **Haritaya Ekle** düğmesine basın.
5. Sistem parsel çevresindeki görüntüyü doğrular. Boş/şeffaf görüntü varsa katmanı eklemez.
6. Gerektiğinde **Plan Ölçeğine Git** düğmesini kullanın.
7. Genel gösterimler için taşınabilir **Renk Rehberi**ni açın.
8. Kesin ve güncel kayıt için **Kaynak Sayfası** bağlantısını kontrol edin.

Çevre düzeni planları üst ölçekli planlardır. Parselin kesin imar durumu, yapılaşma hakkı veya piyasa değeri anlamına gelmez.

## Pilot bölgeler

1. Kayseri / Sivas / Yozgat — Yozgat–Sivas–Kayseri Çevre Düzeni Planı
2. Tekirdağ / Kırklareli / Edirne — Trakya/Ergene Çevre Düzeni Planı
3. Kırıkkale — Kırıkkale Çevre Düzeni Planı
4. Giresun / Görele — Doğu Karadeniz Çevre Düzeni Planı ve Görele ortofoto

## Kurulum

Node.js 22 gerekir.

```bash
npm ci
npm run check
npm start
```

Gerekli değişkenler `.env.example` dosyasındadır. `TEST_PASSWORD` ve `SESSION_SECRET` mutlaka ayarlanmalıdır.

Önemli değişkenler:

```text
ROUTING_BASE_URL=https://router.project-osrm.org
```

Render güncellemesinden sonra `/api/health` sonucunda `version: 1.7.0` görünmelidir.

Paket içinde boş `data` klasörü veya `node_modules` bulunmaz. Veri klasörü uygulama çalışırken oluşturulur.
