KADASTRO360 v2.0.9.20 — ÖNERLER v1.9.0 DOĞRULANMIŞ GÖRÜNÜM

GITHUB'A YÜKLENECEK TEK DOSYA:
- index.html

YÜKLEME:
1) GitHub ana dizinindeki index.html dosyasını bu paketteki index.html ile değiştirin.
2) open-data.js, server.js, package.json veya başka dosyaya dokunmayın.
3) Render mevcut servisin normal deploy'unu tamamlasın.
4) Tarayıcıda Ctrl+F5 yapın.
5) Yalnız Tekirdağ / Çorlu / Önerler 323/2 üzerinde katmanı kontrol edin.

BU SÜRÜMÜN AMACI:
- v2.0.9.19'da HTTP/image load olayı geldiği için boş/şeffaf Ergene resmi yanlışlıkla başarılı sayılabiliyordu.
- v2.0.9.20 önce görünür WMS katmanını doğrular; 0 grup katmanı boşsa resmî alt katmanları tarar.
- Önerler için 22.07.2026'da olumlu kullanıcı geri bildirimi alınan v1.9.0 viewport davranışı geri uygulanır:
  ekran alanı + %16 tampon, en az 12 km görüntü, tek ImageOverlay, yeni görüntü tam gelene kadar eskisini koruma.
- Kayseri/Kırıkkale/Giresun/Balıkesir/Yozgat ortak motorları değiştirilmemiştir.
