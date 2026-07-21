# Kadastro360 Web Pilot v1.8.0

Gerçek veri kullanan web pilotudur. Örnek parsel, rastgele eğim, sahte yakın yer, düz çizgiyi yol rotası gibi gösterme veya tahmini rayiç üretmez.

## Bu sürümde düzeltilen ana sorunlar

### 1. Seçilen rotaların eksik çizilmesi

- En fazla 5 hedef korunur.
- Her hedef sırayla ve bağımsız olarak hesaplanır.
- Birincil OSRM servisi yanıt vermezse ikinci OSRM servisi otomatik denenir.
- Yol ağına eşleşmeyen noktalar için genişletilmiş yol eşleştirme denemesi yapılır.
- Her hedef için ayrı **Hazır / Rota alınamadı** sonucu gösterilir.
- Başarısız hedef sessizce atlanmaz.
- Başarılı rotalar gerçek yol geometrisi, mesafe ve tahmini süreyle çizilir.

Varsayılan sağlayıcılar:

```text
https://router.project-osrm.org
https://routing.openstreetmap.de/routed-car
```

### 2. Yakın yer aramasının yavaşlaması

- “Tüm Yerler” seçeneği artık tarayıcıdan kategori başına 11 ayrı istek göndermez.
- Kategoriler üç dengeli toplu sorgu grubunda aranır.
- 5 km içinde bulunan kategoriler için gereksiz 10–30 km tekrarları yapılmaz.
- Okul, market, cami, eczane, banka ve ATM en fazla 10 km; hastane 20 km; bölgesel ulaşım/sahil türleri 30 km’ye kadar kontrollü genişletilir.
- Aynı konumdaki tekrar arama 30 dakika önbellekten gelir.
- Sonuçlar tek akordeon listesinde kalır; kapalı başlıkta örneğin **Market · 15 adet** görünür.

### 3. Açık veri katmanının bulanık veya kesik görünmesi

- Büyük ve büyütüldükçe pikselleşen tek resim yöntemi artık kullanılmaz.
- Katman önce kullanıcının tarayıcısından gerçek WMS karoları halinde yüklenir.
- Doğrudan WMS erişimi başarısız olursa aynı kaynak, sunucu önbellekli karo proxy’si üzerinden yedek olarak denenir.
- Yakınlaştırmada her seviye kendi karosunu aldığı için görüntü büyütülmüş tek resim gibi bulanıklaşmaz.
- Plan katmanı daha düşük opaklıkta gösterilir; parsel sınırı ve rotalar üstte kalır.
- **Haritaya Ekle** mevcut parsel yakınlığını değiştirmez. **Plan Ölçeğine Git** yalnızca kullanıcı tıklarsa çalışır.

## Aynı mahallede parsel karşılaştırması

Aynı mahallede sorgulanan son 10 parsel, tarayıcı oturumu boyunca geçici olarak saklanır. Önceki parseller turuncu kesik sınırla gösterilir. Haritadaki **Karşılaştırma** kontrolünden gizlenebilir veya temizlenebilir.

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

Render dağıtımından sonra şu adres kontrol edilir:

```text
https://SİTE-ADRESİ/api/health
```

Sonuçta `version: 1.8.0` görünmelidir.

## Önemli doğruluk notu

Çevre düzeni planları üst ölçekli planlardır. Parselin kesin imar durumu, yapılaşma hakkı veya piyasa değeri anlamına gelmez. Kesin yorum için güncel resmî pafta, belediye ve veri sağlayıcısı kayıtları kontrol edilmelidir.

Paket içinde `node_modules` veya boş `data` klasörü bulunmaz. Veri klasörü uygulama çalışırken oluşturulur.
