# WhatsApp Otomasyon Botları

Bu proje, WhatsApp gruplarında **otomatik anket gönderme**, **mesaj gönderme** ve **veri toplama** işlemlerini gerçekleştirmek için geliştirilmiş otomasyon araçlarını içerir.

[![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express.js-000000?style=for-the-badge&logo=express&logoColor=white)](https://expressjs.com/)
[![MongoDB](https://img.shields.io/badge/MongoDB-47A248?style=for-the-badge&logo=mongodb&logoColor=white)](https://www.mongodb.com/)
[![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![Python](https://img.shields.io/badge/Python-3776AB?style=for-the-badge&logo=python&logoColor=white)](https://www.python.org/)
[![Render](https://img.shields.io/badge/Render-46E3B7?style=for-the-badge&logo=render&logoColor=black)](https://render.com/)

---

## Öne Çıkan Özellikler

- **Anket ve Mesaj Gönderimi:** WhatsApp gruplarınıza her gün otomatik anket ve mesaj gönderebilirsiniz.
- **Veri Saklama:** Kullanıcıların **anlık anket oylamaları** ve **grup mesajları** MongoDB veri tabanında kalıcı olarak saklanır.
- **Canlı Web Yönetim Paneli:** Arayüzden anket sonuçlarını görüntüleyebilir ve anket gönderimini tetikleyebilirsiniz.

---

## Kurulum Rehberi

Uygulamayı ihtiyacınıza göre **Render.com üzerinde sunucu ortamında** veya **kendi bilgisayarınızda (yerel)** çalıştırabilirsiniz.

### 1. Render.com ile Sunucuda Kurulum

Botunuzu Render.com üzerinde 7/24 kesintisiz çalışır hale getirmek için aşağıdaki adımları sırasıyla uygulayabilirsiniz:

#### 1. Adım: Projeyi Render'da Yayına Alma ve İlk Bağlantı (QR Kod)
1. Bu projeyi kendi GitHub hesabınıza **Fork** edin.
2. [Render.com](https://render.com/) adresine ücretsiz üye olun ve **New +** > **Web Service** seçeneğini seçin.
3. Forkladığınız GitHub reponuzu bağlayın ve yayına alın.
4. Render size özel bir web site adresi verecektir (Örn: `https://okuma-takip-botu.onrender.com`).
5. Bu adrese tarayıcınızdan girin. Karşınıza gelen **QR Kodu** WhatsApp uygulamanızdan *(Bağlı Cihazlar > Cihaz Bağla)* okutarak botunuzu bağlayın.

#### 2. Adım: Grup ID (JID) Bilgisini Kopyalama
1. QR kodu okutup giriş yaptıktan sonra yönetim panelinin üst menüsünde yer alan **"Gruplar & JID"** butonuna tıklayın.
2. Botun üye olduğu WhatsApp grupları listelenecektir. Anket göndermek istediğiniz grubun yanındaki **JID** kodunu kopyalayın (Örn: `123456789012345678@g.us`).

#### 3. Adım: Render Ayarlarını Yapılandırma (Environment Variables)
1. [Render.com](https://render.com/) paneline dönün ve oluşturduğunuz servis içerisinden **Environment** bölümüne gelin.
2. Aşağıdaki değişkenleri **Add Environment Variable** butonunu kullanarak ekleyin:

| Değişken Adı | Değer / Açıklama |
| :--- | :--- |
| **`WHATSAPP_GROUP_ID`** | 2. adımda kopyalamış olduğunuz grup JID bilgisi. |
| **`PING_URL`** | Web sitenizin adresinin sonuna `/api/health` ekleyerek yazın.<br>*(Örn: `https://okuma-takip-botu.onrender.com/api/health`)* |
| **`MONGO_URI`** | Anket sonuçları ve oy verilerini kaydetmek için MongoDB bağlantı adresiniz. |
| **`DB_NAME`** | Veritabanı adınız. |

3. Değişiklikleri kaydedin. Render uygulamanızı otomatik olarak yeniden başlatacak ve botunuz belirlenen saatlerde grubunuza otomatik anket göndermeye başlayacaktır!

---

### 2. Yerel Kurulum

Projeyi kendi bilgisayarınızda geliştirme veya test amacıyla çalıştırmak isterseniz:

1. **Bağımlılıkları Yükleyin:**
   ```bash
   npm install
   ```

2. **Ortam Değişkenlerini Oluşturun:**
   Kök dizinde `.env` dosyası oluşturup değişkenlerinizi tanımlayın:
   ```env
   WHATSAPP_GROUP_ID=123456789012345678@g.us
   MONGO_URI=your_mongodb_uri
   DB_NAME=yourdatabase
   ```

3. **Uygulamayı Başlatın:**
   ```bash
   npm start
   ```
   Tarayıcınızda `http://localhost:3000/` adresine girerek yönetim paneline erişebilir ve QR kod taratarak oturum açabilirsiniz.

---

### Anketleri Özelleştirme

Anketlerin gönderim zamanını, başlığını ve seçeneklerini iki farklı şekilde güncelleyebilirsiniz:

- **Dosya Üzerinden (`server.js`):** `scheduleWhatsAppPollJob` fonksiyonundaki cron saat zamanlamasını (varsayılan: `0 9 * * *` - her gün 09:00 TSİ) ile `DEFAULT_POLL_OPTIONS` ve `getDailyPollTitle` fonksiyonlarını doğrudan kod içerisinden değiştirebilirsiniz.
- **Veritabanı Üzerinden (`poll_config` koleksiyonu):** MongoDB veritabanınız bağlıysa, arayüzdeki anket ayarları panelinden veya MongoDB veritabanınızdaki `poll_config` koleksiyonundan `titleTemplate` ve `options` verilerini dinamik olarak güncelleyebilirsiniz.

---

## Python Botları ve Analiz Araçları

Grup sohbetleri ve geçmiş anket oyları üzerinde daha detaylı analiz yapmak isteyenler için repoda Python araçları yer almaktadır:

- **Gerekli Kütüphaneler:**
  ```bash
  pip install selenium clipboard
  ```
- **Araçlar:**
  - `wp-bot-anket-olusturucu.py`: WhatsApp Web üzerinden otomatik anket oluşturur.
  - `wp-bot-oto-mesaj.py`: Belirli zamanlarda otomatik grup mesajı gönderir.
  - `wp-bot-web-istatistikleri.py`: Grup sohbet mesajlarını kelime ve tarih aralığına göre analiz eder.
  - `wp-bot-anket-istatistikleri.py`: Anket oylarını ve katılımcı dağılımını analiz eder.
  - `wp-bot-desktop.py`: Masaüstü WhatsApp verilerini işler.
  - `logout_whatsapp.py`: Oturumu güvenli şekilde sonlandırır.

---

## Yönetim Paneli

![Ana Sayfa Yönetim Paneli](screenshots/Ana%20Sayfa.png)

---

## API Referansı

| Endpoint | Metod | Açıklama |
| :--- | :--- | :--- |
| `/` | `GET` | Web Yönetim Paneli Arayüzü |
| `/api/status` | `GET` | Bot ve veritabanı bağlantı durumu |
| `/api/send-poll` | `POST` | Hedef gruba anlık anket gönderir |
| `/api/polls` | `GET` | Gönderilmiş anketleri listeler |
| `/api/poll-votes/:pollId` | `GET` | Seçilen ankete ait detaylı oy kayıtlarını getirir |
| `/api/poll-config` | `GET` / `POST` | Anket başlığı ve seçenek ayarlarını okur/günceller |
| `/api/groups` | `GET` | Katılınan WhatsApp gruplarını ve JID adreslerini listeler |
| `/api/request-pairing-code` | `POST` | Telefon numarası ile 8 haneli oturum kodu üretir |
| `/api/restart` | `POST` | Oturumu ve istemciyi yeniden başlatır |
| `/api/health` | `GET` | Sunucu canlılık (health check) endpoint'i |

---

## Veritabanı Şeması (MongoDB)

#### `poll_config` Koleksiyonu (Anket Şablon Ayarları)
```json
{
  "_id": "default",
  "titleTemplate": "{{date}} Okuma Takibi",
  "options": [ "5 dakika", "10 dakika", "15 dakika", "20 dakika" ],
  "updatedAt": "2026-08-04 10:45:00"
}
```

#### `polls` Koleksiyonu (Anket Kayıtları)
```json
{
  "pollId": "3EB0FF9D45F3A12550DEDA",
  "groupId": "123456789012345678@g.us",
  "title": "4 Ağustos",
  "options": [ "5 dakika", "10 dakika", "15 dakika", "20 dakika" ],
  "createdAt": "2026-08-04 10:00:00"
}
```

#### `poll_votes` Koleksiyonu (Anket Oy Kullanımları)
```json
{
  "pollId": "3EB0FF9D45F3A12550DEDA",
  "voterJid": "905351234567",
  "voterPhone": "905351234567",
  "selectedOptions": [ "15 dakika" ],
  "updatedAt": "2026-08-04 10:02:02"
}
```

#### `lid_mappings` Koleksiyonu (LID - Telefon Numarası Eşleşmeleri)
```json
{
  "_id": "114345098911975",
  "phone": "905351234567",
  "updatedAt": "2026-08-04 10:00:00"
}
```

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
