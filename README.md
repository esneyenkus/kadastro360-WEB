# Kadastro360 Web Pilot v1.8.8

Kadastro360; TKGM parsel sorgusu, arazi eğimi, gerçek yakın yer kayıtları, yol rotaları ve açık kamu katmanlarını tek ekranda birleştiren canlı veri web pilotudur. Örnek parsel, rastgele eğim, sahte yakın yer, düz çizgiyi yol rotası gibi gösterme veya tahmini rayiç üretmez.

## v1.8.8 ile gelen ana düzeltmeler

- Açık plan katmanı artık döşemeli WMS karo yerine tek sabit, önbellekli görüntü olarak yüklenir.
- Zoom sırasında katman yeniden istek atmadığı için kaybolmaz ve harita daha az kasar.
- Hazır plan, hızlı katalog düğmesiyle otomatik eklenir.
- Renk rehberi aktif WMS lejantını ve tam EK-1c genel gösterim listesini birlikte sunar.

### 1. Korumalı yönetici girişi ve erişim talepleri

- Yönetici paneli artık normal kullanıcı girişinden ayrı `/yonetim-giris` ekranından açılır.
- Yönetici kullanıcı adı ve parolasına ek olarak Render'da tanımlanan `ADMIN_PANEL_PIN` güvenlik kodu istenir.
- Yönetici yetki çerezi HttpOnly, Secure ve SameSite=Strict olarak 30 dakika geçerlidir.
- Normal kullanıcı oturumu tek başına `/admin` veya `/api/admin/*` uçlarına erişemez.
- Ana sayfadaki pilot erişim talepleri yönetim panelinde tarih, kurum, e-posta, telefon ve not bilgileriyle listelenir.
- Talepler Yeni, İncelendi, Onaylandı veya Reddedildi durumuna alınabilir.

### 2. Hızlandırılmış açık veri akışı

- **Hazır Katmanları Getir** yalnızca önceden tanımlı resmî WMS katmanlarını ve kaynak bağlantılarını döndürür; yavaş katalog/CSV taramasını beklemez.
- **Ek Kaynakları Tara** ayrı ve isteğe bağlıdır; ULASAV katalog/CSV kaynaklarını ayrıntılı tarar.
- WMS katmanı eklenirken bilinen katman adı önce denenir; GetCapabilities keşfi yalnızca ilk bağlantı başarısız olursa çalışır.
- Katman görünürlük doğrulaması tarayıcı ve sunucuda paralel yapılır.
- Proxy karoları 512 yerine 256 piksele düşürüldü; çevre karo tamponu 3'ten 1'e indirildi.
- Harita hareket ederken gereksiz karo istekleri azaltıldı; yalnızca ekranda gerekli alan yüklenir.

### 3. Korunan yakın yer ve rota düzeltmeleri

### 1. İlçe merkezini esas alan yakın yer araması

Kırsal bir parselde yalnızca parsel çevresini genişletmek, komşu ilçedeki bir bankayı seçip gerçek ilçe merkezindeki banka ve ATM'leri kaçırabiliyordu. Yeni akışta:

- Seçilen **il ve ilçe bilgisi** yakın yer API'sine gönderilir.
- Her kategori önce parsel çevresinde 5 → 10 → 20 → 30 km kademeli taranır.
- Sonuç yoksa, en yakın sonuç 15 km'den uzaktaysa veya kayıt açıkça başka ilçeye aitse seçilen ilçe merkezi ayrıca çözülür.
- İlçe merkezi çevresi 5 → 12 → 20 → 30 km kademeleriyle gerçek OpenStreetMap/Overpass kayıtları üzerinden taranır.
- Aynı ilçeye ait kayıtlar komşu ilçe kayıtlarından önce sıralanır.
- Aynı ilçede uygun kayıt bulunduğunda açıkça başka ilçeye ait banka/ATM gibi sonuçlar listeden çıkarılır.
- ATM etiketi eksik olsa bile adında **ATM, Bankamatik, Paramatik, Bank24 veya ParafPara** geçen gerçek kayıtlar yedek eşleşme olarak değerlendirilebilir.
- Bu davranış Gönen'e özel sabitlenmemiştir; kullanıcının seçtiği her ilçe için çalışır.

İlçe merkezi çözümlemesi OpenStreetMap Nominatim ile, yakın yer kayıtları ise Overpass ile yapılır. Başarısız dış servis cevabında sahte nokta eklenmez.

### 2. Üst üste binmeyen varış etiketleri

- Varış koordinatında numaralı ikon yerine seçilen yakın yerin tam adı sürekli görünür.
- Birbirine yakın hedeflerin etiketleri otomatik kümelenir.
- Etiketler yan yana veya alt alta kaydırılır; aynı noktada birbirini kapatmaz.
- Gerçek varış koordinatı renkli küçük bir noktayla yerinde kalır; etiket yalnızca okunabilirlik için ötelenir.
- Harita hareketi ve yakınlaştırma sonrasında etiket konumları yeniden hesaplanır.

### 3. Ortak yolda çok renkli rota gösterimi

- Her rota önce kendi ana rengiyle çizilir.
- Bunun üzerine rota sayısına göre farklı fazlarda kesikli renk şeritleri uygulanır.
- İki, üç veya daha fazla rota aynı yol kesimini kullanıyorsa ortak bölüm tek renge dönüşmez; kullanılan rota renkleri dönüşümlü görünür.
- Mesafe/süre etiketleri rotaların farklı noktalarına dağıtılır.
- OSRM'nin yola eşlediği başlangıç veya bitiş ile gerçek parsel/POI koordinatı arasındaki kısa fark renkli kesik bağlantıyla tamamlanır.
- Rota katmanı parsel katmanının üstünde tutulur ve bütün hedefleri kapsayan görünüm payı artırılmıştır.

Varsayılan rota sağlayıcıları:

```text
https://router.project-osrm.org
https://routing.openstreetmap.de/routed-car
```

### 4. Hızlı ve kontrollü yakın yer taraması

- “Tüm Yerler” seçeneği tarayıcıdan kategori başına ayrı istek göndermez.
- Kategoriler dengeli toplu Overpass sorgularıyla aranır.
- Bulunan kategoriler için gereksiz genişletme yapılmaz.
- Aynı konumdaki tekrar arama 30 dakika önbellekten gelir.
- Sonuçlar kategori akordeonlarında gösterilir; kapalı başlıkta örneğin **Market · 15 adet** görünür.
- Boş kategori ile dış servis hatası ayrı gösterilir.

## Açık veri ve WMS

- Büyük ve yakınlaştırıldıkça pikselleşen tek resim yöntemi kullanılmaz.
- Katman önce tarayıcıdan gerçek WMS karoları halinde yüklenir.
- Doğrudan WMS erişimi başarısız olursa sunucu önbellekli karo proxy'si yedek olarak denenir.
- Plan katmanı düşük opaklıkta tutulur; parsel sınırı ve rotalar üstte kalır.
- **Haritaya Ekle** mevcut parsel yakınlığını değiştirmez. **Plan Ölçeğine Git** yalnızca kullanıcı tıklarsa çalışır.

## Aynı mahallede parsel karşılaştırması

Aynı mahallede sorgulanan son 10 parsel tarayıcı oturumu boyunca geçici olarak saklanır. Önceki parseller turuncu kesik sınırla gösterilir. Haritadaki **Karşılaştırma** kontrolünden gizlenebilir veya temizlenebilir.

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

Gerekli değişkenler `.env.example` dosyasındadır. `TEST_PASSWORD`, `SESSION_SECRET` ve yönetici paneli için `ADMIN_PANEL_PIN` mutlaka ayarlanmalıdır. `NOMINATIM_BASE_URL` isteğe bağlıdır; boş bırakılırsa genel OpenStreetMap Nominatim ucu kullanılır.

Render dağıtımından sonra şu adres kontrol edilir:

```text
https://SİTE-ADRESİ/api/health
```

Sonuçta `version: 1.8.8` görünmelidir.

## Önemli doğruluk notu

Çevre düzeni planları üst ölçekli planlardır. Parselin kesin imar durumu, yapılaşma hakkı veya piyasa değeri anlamına gelmez. Kesin yorum için güncel resmî pafta, belediye ve veri sağlayıcısı kayıtları kontrol edilmelidir.

Paket içinde `node_modules` veya boş `data` klasörü bulunmaz. Veri klasörü uygulama çalışırken oluşturulur.
