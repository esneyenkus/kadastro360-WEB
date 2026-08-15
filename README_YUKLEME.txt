Kadastro360 v2.0.9.19 — ÖNERLER / ERGENE DOĞRUDAN WMS GÖRÜNÜMÜ

YÜKLENECEK TEK DOSYA:
- index.html

GitHub ana dizinindeki index.html dosyasını bu paketteki index.html ile değiştirin.
open-data.js, server.js, package.json, package-lock.json veya başka hiçbir dosyayı değiştirmeyin.

Bu sürüm mevcut GitHub main (v2.0.9.17 open-data.js + mevcut index tabanı) üzerine hazırlanmıştır.

Amaç:
1. Önerler/Ergene'yi Kayseri tipi 512 px Render proxy karo yolundan çıkarmak.
2. Composite/çok paftalı yolu Ergene için kullanmamak.
3. Ergene WMS'yi doğrudan tarayıcıdan, sadece görünen alan için TEK GetMap görüntüsü olarak almak.
4. Görüntüyü en fazla 1280x960 ile sınırlayarak gereksiz 2K/çoklu istek yükünü azaltmak.
5. Zoom/kaydırmada eski çalışan görüntüyü yeni görüntü TAM yüklenene kadar ekranda tutmak.
6. İlk çok-yakın görünüm servis tarafından reddedilirse yalnız ilk açılışta v1.9.0 hattındaki 12 km güvenli pencereyi yedek olarak denemek.
7. Kayseri/Kırıkkale/Giresun/Balıkesir/Konya/Yozgat ortak WMS fonksiyonlarına dokunmamak.

Not: Tarayıcıda deploy sonrası Ctrl+F5 ile önbelleği yenileyin.
