# Kadastro360 Web Pilot v1.0

Bu paket gerçek servislerle çalışan kapalı web pilotudur. Örnek, rastgele veya sanal parsel/yakın yer sonucu üretmez. Dış servis cevap vermezse kullanıcıya hata gösterilir.

## Yerel çalıştırma

1. `.env.example` değerlerini ortam değişkeni olarak tanımlayın.
2. `npm start` çalıştırın.
3. `http://127.0.0.1:10000` adresini açın.

## Render

Depoyu GitHub'a yükleyin, Render'da Blueprint veya Web Service oluşturun. `TEST_PASSWORD` belirleyin; `SESSION_SECRET` Render tarafından üretilebilir.

## Gerçek veri kaynakları

- Parsel: TKGM servisleri
- Eğim: Terrain Tiles; başarısız olursa Open-Meteo / Open-Elevation
- Yakın yerler: OpenStreetMap / Overpass
- Bölge fiyatı: Endeksa'ya doğrudan yönlendirme; veri kazıması yok

Bu pilot, harita mühendisliği veya resmî değerleme belgesi değildir.
