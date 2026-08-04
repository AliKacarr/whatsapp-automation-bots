# WhatsApp Otomasyon Botları

Bu depo, WhatsApp gruplarında **otomatik anket gönderme**, **mesaj gönderme** ve **veri toplama** işlemlerini gerçekleştirmek için geliştirilmiş otomasyon araçlarını içerir.

[![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express.js-000000?style=for-the-badge&logo=express&logoColor=white)](https://expressjs.com/)
[![MongoDB](https://img.shields.io/badge/MongoDB-47A248?style=for-the-badge&logo=mongodb&logoColor=white)](https://www.mongodb.com/)
[![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![Python](https://img.shields.io/badge/Python-3776AB?style=for-the-badge&logo=python&logoColor=white)](https://www.python.org/)
[![Render](https://img.shields.io/badge/Render-46E3B7?style=for-the-badge&logo=render&logoColor=black)](https://render.com/)

---

## Öne Çıkan Özellikler

- **Otomatik Anket Gönderme ve Takip:** Belirlenen saatlerde (varsayılan: her gün 09:00 TSİ) WhatsApp gruplarına otomatik anket gönderir, katılım ve oy değişikliklerini anlık olarak veritabanına kaydeder.
- **Otomatik Mesaj Gönderimi:** Gruplara veya kişilere zamanlanmış ya da anlık duyuru, hatırlatma ve bilgi mesajları iletir.
- **Veri Saklama ve İstatistik (MongoDB):** Kullanıcı tercihlerini, anket sonuçlarını ve grup etkileşim verilerini MongoDB veritabanında düzenli olarak saklar ve istatistik takibi sağlar.
- **Canlı Web Yönetim Paneli:** QR kod okutma, 8 haneli oturum kodu alma, grupların JID adreslerini listeleme ve tek tıkla anket tetikleme paneli.
- **7/24 Bulut Entegrasyonu:** Render.com veya sunucu ortamlarında bilgisayara ihtiyaç duymadan 7/24 kesintisiz çalışma desteği.

---

## Kurulum ve Yapılandırma

### 1. Bağımlılıkları Yükleyin

```bash
npm install
```

### 2. Ortam Değişkenlerini Tanımlayın (`.env`)

Proje kök dizininde `.env` dosyası oluşturun:

```env
# Hedef WhatsApp Grup JID Adresi
WHATSAPP_GROUP_ID=123456789012345678@g.us

# MongoDB Bağlantı Bilgileri
MONGO_URI=mongodb+srv://kullanici:sifre@cluster.mongodb.net/
DB_NAME=readingTracker

# Render / Cloud Uyanık Tutma Servisi (Opsiyonel)
PING_URL=https://your-site.onrender.com/api/health
```

### 3. Grup JID Bilgisini Öğrenme

Grup JID kodunu iki farklı yöntemle öğrenebilirsiniz:

- **Web Paneli Üzerinden:** WhatsApp oturumu açtıktan sonra panodaki **"Gruplar & JID"** butonuna tıklayarak gruplarınızı listeleyebilir ve ilgili JID kodunu kopyalayabilirsiniz.
- **Terminal Üzerinden:** Terminalde aşağıdaki komutu çalıştırarak üye olduğunuz tüm grupları ve JID kodlarını listeleyebilirsiniz:
  ```bash
  node list-groups.js
  ```

### 4. Uygulamayı Başlatın

```bash
npm start
```

Tarayıcınızda `http://localhost:3000/` adresini açarak yönetim paneline erişebilir ve QR kod ile oturum açabilirsiniz.

---

## API Referansı

| Endpoint | Metod | Açıklama |
| :--- | :--- | :--- |
| `/` | `GET` | Yönetim Paneli Arayüzü |
| `/api/status` | `GET` | İstemci ve veritabanı bağlantı durumu |
| `/api/send-poll` | `POST` | Hedef gruba anlık anket gönderir |
| `/api/groups` | `GET` | Katılınan WhatsApp gruplarını listeler |
| `/api/request-pairing-code` | `POST` | Telefon numarası ile 8 haneli oturum kodu üretir |
| `/api/restart` | `POST` | Oturumu ve istemciyi yeniden başlatır |
| `/api/health` | `GET` | Sunucu sağlık kontrolü endpoint'i |

---

## Veritabanı Şeması (MongoDB)

### `polls` Koleksiyonu (Anketler)
```json
{
  "pollId": "3EB0FF9D45F3A12550DEDA",
  "groupId": "123456789012345678@g.us",
  "title": "4 Ağustos",
  "options": [ "5 dakika", "10 dakika", "15 dakika", "20 dakika" ],
  "createdAt": "2026-08-04T01:00:00.000Z"
}
```

### `poll_votes` Koleksiyonu (Oy Kayıtları)
```json
{
  "pollId": "3EB0FF9D45F3A12550DEDA",
  "voterJid": "905351234567",
  "voterPhone": "905351234567",
  "selectedOptions": [ "15 dakika" ],
  "updatedAt": "2026-08-04T01:02:02.909Z"
}
```

---

## Cloud Deployment (Render.com)

1. Projeyi GitHub hesabınıza forklayın.
2. [Render.com](https://render.com/) üzerinde yeni bir **Web Service** oluşturun.
3. **Environment Variables** bölümüne `.env` değişkenlerinizi ekleyin (`WHATSAPP_GROUP_ID`, `MONGO_URI`, `DB_NAME`, `PING_URL`).
4. Servisi yayınlayıp verilen URL üzerinden yönetim paneline erişerek QR kodunuzu taratın.

---

## Python Botları ve Araçları

Grup iletişimi ve veri analizi için aşağıdaki Python scriptleri kullanılabilir:

### Kurulum ve Gereksinimler
```bash
pip install selenium clipboard
```

### Scriptler ve Açıklamaları
- **`wp-bot-anket-olusturucu.py`**: Selenium tabanlı WhatsApp Web üzerinden otomatik anket oluşturup gönderir.
- **`wp-bot-oto-mesaj.py`**: Belirtilen WhatsApp grubuna Selenium ile otomatik mesaj iletir.
- **`wp-bot-web-istatistikleri.py`**: WhatsApp Web üzerinde gruptaki mesajları tarih aralığı ve kelimelere göre sınıflandırarak analiz eder.
- **`wp-bot-anket-istatistikleri.py`**: Gruptaki anketleri tarayarak oy veren kullanıcıları ve seçenek dağılımını analiz eder.
- **`wp-bot-desktop.py`**: Masaüstü uygulamasından kopyalanan sohbet verilerini analiz eder.
- **`logout_whatsapp.py`**: WhatsApp Web oturumunu güvenli şekilde kapatır.

---

## Geliştirici

**Ali Kaçar**

[![Instagram](https://img.shields.io/badge/Instagram-E4405F?logo=instagram&logoColor=white)](https://www.instagram.com/alikacar23/)
[![LinkedIn](https://img.shields.io/badge/LinkedIn-0077B5?logo=linkedin&logoColor=white)](https://www.linkedin.com/in/alikacar23/)
[![GitHub](https://img.shields.io/badge/GitHub-181717?logo=github&logoColor=white)](https://github.com/AliKacarr)
[![YouTube](https://img.shields.io/badge/YouTube-FF0000?logo=youtube&logoColor=white)](https://www.youtube.com/@alikacardev)

[alikacardev@gmail.com](mailto:alikacardev@gmail.com)

---

## Lisans

Bu proje [MIT Lisansı](LICENSE.txt) altında sunulmaktadır.
