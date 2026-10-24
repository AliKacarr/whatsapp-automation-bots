# WhatsApp Okuma Takip Botu

WhatsApp okuma grupları için geliştirilmiş, Node.js tabanlı otomasyon ve yönetim paneli. Günlük okuma anketlerini gönderir, anket ve mesaj yanıtlarını kaydeder, okuma istatistiklerini raporlar.

[![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express.js-000000?style=for-the-badge&logo=express&logoColor=white)](https://expressjs.com/)
[![MongoDB](https://img.shields.io/badge/MongoDB-47A248?style=for-the-badge&logo=mongodb&logoColor=white)](https://www.mongodb.com/)
[![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)

## Özellikler

- Zamanlanmış veya panelden anında gönderilebilen okuma anketleri
- Anket oylarının ve metinle bildirilen okumaların kaydı
- Haftalık okuma raporu ve tablo görseli
- Okuma serisi ve lig ilerlemesi takibi
- Kişiye özel teslimat seçeneklerine sahip lig kutlama görselleri
- Grup, anket ve otomasyon ayarları için web yönetim paneli
- Parola korumalı panel ve şifreli WhatsApp oturum verileri
- `CONFIG_KEY` ile birbirinden ayrı çalışan çoklu bot desteği

## Gereksinimler

- Güncel bir Node.js LTS sürümü
- MongoDB veritabanı
- WhatsApp hesabı
- RoTaKip okuma grubu verilerine erişim

## Kurulum

Projeyi klonladıktan sonra bağımlılıkları yükleyin:

```bash
npm install
```

Proje dizininde bir `.env` dosyası oluşturun:

```env
CONFIG_KEY=okumagrubu1
MONGO_URI=mongodb+srv://kullanici:parola@cluster.mongodb.net
DB_NAME=readingTracker
BAILEYS_AUTH_ENCRYPTION_KEY=en-az-32-karakterlik-guclu-bir-gizli-anahtar
```

Uygulamayı başlatın:

```bash
npm start
```

Yönetim paneli varsayılan olarak [http://localhost:3000](http://localhost:3000) adresinde açılır.

## İlk Yapılandırma

1. Yönetim panelini açın ve ilk kullanıcı hesabını oluşturun.
2. WhatsApp hesabınızı QR kod veya eşleştirme koduyla bağlayın.
3. **Grup Ayarları** bölümünden hedef WhatsApp grubunu seçin.
4. RoTaKip okuma grubunu seçip grup yöneticisi hesabıyla doğrulayın.
5. Kullanmak istediğiniz otomasyonları etkinleştirin.
6. **Anket Ayarları** bölümünden anket başlığını ve seçeneklerini düzenleyin.

## Ortam Değişkenleri

| Değişken | Zorunlu | Açıklama |
| :--- | :---: | :--- |
| `CONFIG_KEY` | Evet | Bot örneğini ve ayarlarını tanımlayan benzersiz anahtar |
| `MONGO_URI` | Evet | MongoDB bağlantı adresi |
| `DB_NAME` | Evet | Kullanılacak veritabanının adı |
| `BAILEYS_AUTH_ENCRYPTION_KEY` | Üretimde | WhatsApp oturum verilerini şifreleyen, en az 32 karakterlik gizli anahtar |
| `PORT` | Hayır | HTTP sunucusu portu. Varsayılan: `3000` |
| `PING_URL` | Hayır | Periyodik istek gönderilecek health check adresi |
| `MAX_READING_AMOUNT` | Hayır | Mesajla kabul edilecek en yüksek okuma miktarı. Varsayılan: `99999` |

> `.env` dosyanızı ve `BAILEYS_AUTH_ENCRYPTION_KEY` değerini kaynak kontrolüne eklemeyin. Anahtar kaybedilirse kayıtlı WhatsApp oturumu çözülemez.

## Render ile Yayınlama

1. Depoyu GitHub hesabınıza fork edin.
2. Render'da yeni bir **Web Service** oluşturup depoyu bağlayın.
3. Build komutunu `npm install`, başlatma komutunu `npm start` olarak ayarlayın.
4. Gerekli ortam değişkenlerini Render paneline ekleyin.
5. Dağıtım tamamlandığında yönetim panelini açarak ilk yapılandırmayı tamamlayın.

## Otomatik Görevler

| Görev | Zamanlama |
| :--- | :--- |
| Günlük okuma anketi | Her gün 09.00 |
| Motivasyon cümlesi | Salı ve Perşembe 22.30 |
| Haftalık okuma raporu | Cumartesi 22.30 |
| Haftalık tablo görseli | Pazartesi 22.30 |
| Bekleyen lig kutlamaları | Her dakika |

Tüm zamanlamalar `Europe/Istanbul` saat dilimini kullanır. Otomatik görevler **Grup Ayarları** bölümünden ayrı ayrı yönetilebilir.

## Mesajla Okuma Kaydı

Metinle okuma kaydı etkinleştirildiğinde aşağıdaki gibi mesajlar kabul edilir:

```text
20
20 sayfa
20 dakika
dün 15 sayfa
```

Bir kaydı iptal etmek için `0` veya `iptal` gönderilebilir. Başarıyla işlenen mesajlara ✔️, geçersiz mesajlara ❌ tepkisi verilir.

## Ekran Görüntüleri

| Ana Sayfa | Grup Ayarları |
| :---: | :---: |
| <img src="screenshots/Ana%20Sayfa.png" width="500" alt="Ana sayfa"> | <img src="screenshots/Grup%20Ayarları.png" width="500" alt="Grup ayarları"> |

| Grup Seçimi | Anket Ayarları |
| :---: | :---: |
| <img src="screenshots/Grup%20Seçme.png" width="500" alt="Grup seçimi"> | <img src="screenshots/Anket%20Ayarları.png" width="500" alt="Anket ayarları"> |

## Geliştirme

Geliştirme sunucusunu başlatmak için:

```bash
npm run dev
```

Testleri çalıştırmak için:

```bash
npm test
```

## Geliştirici

**Ali Kaçar**

[![Instagram](https://img.shields.io/badge/Instagram-E4405F?logo=instagram&logoColor=white)](https://www.instagram.com/alikacar23/)
[![LinkedIn](https://img.shields.io/badge/LinkedIn-0077B5?logo=linkedin&logoColor=white)](https://www.linkedin.com/in/alikacar23/)
[![GitHub](https://img.shields.io/badge/GitHub-181717?logo=github&logoColor=white)](https://github.com/AliKacarr)
[![YouTube](https://img.shields.io/badge/YouTube-FF0000?logo=youtube&logoColor=white)](https://www.youtube.com/@alikacardev)

[alikacardev@gmail.com](mailto:alikacardev@gmail.com)

## Lisans

Bu proje [MIT Lisansı](LICENSE) ile lisanslanmıştır.
