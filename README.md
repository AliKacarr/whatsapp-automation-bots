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

- **Anket ve Mesaj Gönderimi:** WhatsApp gruplarınıza her gün otomatik anket ve motivasyon cümlesi gönderebilirsiniz.
- **Veri Saklama:** Kullanıcıların **anlık anket oylamaları** MongoDB veri tabanında kalıcı olarak saklanır.
- **Haftalık Okuma Tablosu:** Her hafta grubun okuma istatistiklerini içeren tablo görseli otomatik olarak oluşturulur ve gruba gönderilir.
- **Okuma Serisi Takibi:** Kullanıcıların kesintisiz okuma serileri (🔥 streak) hesaplanır ve haftalık raporda gösterilir.
- **Çoklu Bot Desteği:** Aynı veritabanını paylaşan birden fazla bot, `CONFIG_KEY` sayesinde birbirinden bağımsız çalışır.
- **Canlı Web Yönetim Paneli:** Arayüzden anket sonuçlarını görüntüleyebilir, ayarları düzenleyebilir ve anket gönderimini tetikleyebilirsiniz.

---

## Kurulum Rehberi

Uygulamayı ihtiyacınıza göre **Render.com üzerinde sunucu ortamında** veya **kendi bilgisayarınızda (yerel)** çalıştırabilirsiniz.

### 1. Render.com ile Sunucuda Kurulum

Botunuzu Render.com üzerinde 7/24 kesintisiz çalışır hale getirmek için aşağıdaki adımları sırasıyla uygulayabilirsiniz:

#### 1. Adım: Projeyi Render'da Yayına Alma
1. Bu projeyi kendi GitHub hesabınıza **Fork** edin.
2. [Render.com](https://render.com/) adresine ücretsiz üye olun ve **New +** > **Web Service** seçeneğini seçin.
3. Forkladığınız GitHub reponuzu bağlayın ve yayına alın.
4. Render size özel bir web site adresi verecektir (Örn: `https://okuma-takip-botu.onrender.com`).

#### 2. Adım: Ortam Değişkenlerini Yapılandırma (Environment Variables)
1. Render panelinde oluşturduğunuz servis içerisinden **Environment** bölümüne gelin.
2. Aşağıdaki değişkenleri **Add Environment Variable** butonunu kullanarak ekleyin:

| Değişken Adı | Zorunlu | Değer / Açıklama |
| :--- | :---: | :--- |
| **`CONFIG_KEY`** | ✅ | Botunuz için rastgele benzersiz bir anahtar belirleyin. *(Örn: `okumagrubu1`)* |
| **`MONGO_URI`** | ✅ | MongoDB bağlantı adresiniz. *(Örn: `mongodb+srv://user:pass@cluster.mongodb.net`)* |
| **`DB_NAME`** | ✅ | Veritabanı adınız. *(Örn: `readingTracker`)* |
| **`PING_URL`** | ❌ | Render'ın uyku moduna girmesini engellemek için health check adresi.<br>*(Örn: `https://okuma-takip-botu.onrender.com/api/health`)* |

3. Değişiklikleri kaydedin. Render uygulamanızı otomatik olarak yeniden başlatacaktır.

> **Not:** Bu üç zorunlu değişken tanımlanmadığında bot hiçbir WhatsApp işlemi gerçekleştirmez.

#### 3. Adım: QR Kod ile WhatsApp Bağlantısı
1. Render'ın verdiği web adresine tarayıcınızdan girin.
2. Karşınıza gelen **QR Kodu** WhatsApp uygulamanızdan *(Bağlı Cihazlar > Cihaz Bağla)* okutarak botunuzu bağlayın.

#### 4. Adım: Hedef Grup ve Ayarlar
1. QR kodu okutup giriş yaptıktan sonra yönetim panelindeki **"Grup JID Kopyala"** butonuna tıklayın.
2. Anket göndermek istediğiniz grubun yanındaki **JID** kodunu kopyalayın (Örn: `123456789012345678@g.us`).
3. **Ayarlar** butonuna tıklayarak hedef WhatsApp grubu JID, okuma grubu ID ve anket şablonu gibi tüm ayarları arayüzden kolayca yapılandırabilirsiniz.

---

### 2. Yerel Kurulum

Projeyi kendi bilgisayarınızda geliştirme veya test amacıyla çalıştırmak isterseniz:

1. **Bağımlılıkları Yükleyin:**
   ```bash
   npm install
   ```

2. **Ortam Değişkenlerini Oluşturun:**
   Kök dizinde `.env` dosyası oluşturup zorunlu değişkenlerinizi tanımlayın:
   ```env
   CONFIG_KEY=okumagrubu1
   MONGO_URI=mongodb+srv://user:pass@cluster.mongodb.net
   DB_NAME=readingTracker
   ```

3. **Uygulamayı Başlatın:**
   ```bash
   npm start
   ```
   Tarayıcınızda `http://localhost:3000/` adresine girerek yönetim paneline erişebilir, QR kod taratarak oturum açabilir ve **Ayarlar** bölümünden hedef grup, okuma grubu ve anket ayarlarını yapılandırabilirsiniz.

---

### Anketleri Özelleştirme

Anketlerin gönderim zamanını, başlığını ve seçeneklerini iki farklı şekilde güncelleyebilirsiniz:

- **Yönetim Panelinden:** Web arayüzündeki **Ayarlar** butonuna tıklayarak anket başlığı şablonunu, seçenekleri, hedef WhatsApp grubu JID bilgisini ve okuma grubu ID bilgisini doğrudan güncelleyebilirsiniz.
- **Dosya Üzerinden (`server.js`):** `scheduleWhatsAppPollJob` fonksiyonundaki cron saat zamanlamasını (varsayılan: `0 9 * * *` - her gün 09:00 TSİ) ile `DEFAULT_POLL_OPTIONS` ve `getDailyPollTitle` fonksiyonlarını doğrudan kod içerisinden değiştirebilirsiniz.

---

## Zamanlayıcılar

| Görev | Zamanlama | Açıklama |
| :--- | :--- | :--- |
| Günlük Anket | Her gün 09:00 (TSİ) | Hedef gruba otomatik okuma anketi gönderir |
| Motivasyon Cümlesi | Salı ve Perşembe 22:30 (TSİ) | Veritabanından rastgele bir cümle seçip gruba gönderir |
| Haftalık Okuma Raporu | Cumartesi 22:30 (TSİ) | Okuma serisi ve istatistik özetini metin olarak gönderir |
| Haftalık Tablo Görseli | Pazartesi 22:30 (TSİ) | Haftalık okuma tablosunu görsel olarak oluşturup gönderir |

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

## Ekran Görüntüleri

| Ana Sayfa | Grup Ayarları |
|:---------:|:-------------:|
| <img src="screenshots/Ana%20Sayfa.png" width="500"> | <img src="screenshots/Grup%20Ayarları.png" width="500"> | 

| Grup Seçim Paneli | Anket Ayarları | 
|:---------:|:-------------:|
| <img src="screenshots/Grup%20Seçme.png" width="500"> | <img src="screenshots/Anket%20Ayarları.png" width="500"> | 

---

## API Referansı

| Endpoint | Metod | Açıklama |
| :--- | :--- | :--- |
| `/` | `GET` | Web Yönetim Paneli Arayüzü |
| `/api/status` | `GET` | Bot ve veritabanı bağlantı durumu |
| `/api/send-poll` | `GET` / `POST` | Hedef gruba anlık anket gönderir |
| `/api/send-sentence` | `GET` / `POST` | Hedef gruba motivasyon cümlesi gönderir |
| `/api/send-reading-report` | `GET` / `POST` | Haftalık okuma raporu (metin) gönderir |
| `/api/send-table-image` | `GET` / `POST` | Haftalık okuma tablosu görselini gönderir |
| `/api/polls` | `GET` | Gönderilmiş anketleri listeler |
| `/api/poll-votes/:pollId` | `GET` | Seçilen ankete ait detaylı oy kayıtlarını getirir |
| `/api/poll-config` | `GET` / `POST` | Anket başlığı, seçenekler, grup JID ve okuma grubu ayarlarını okur/günceller |
| `/api/groups` | `GET` | Katılınan WhatsApp gruplarını ve JID adreslerini listeler |
| `/api/pairing-code` | `POST` | Telefon numarası ile 8 haneli oturum kodu üretir |
| `/api/restart` | `POST` | Oturumu ve istemciyi yeniden başlatır |
| `/api/health` | `GET` | Sunucu canlılık (health check) endpoint'i |

---

## Veritabanı Şeması (MongoDB)

#### `poll_config` Koleksiyonu (Bot Konfigürasyonu & Anket Şablon Ayarları)
```json
{
  "_id": "mygroupid34",
  "titleTemplate": "{{date}} Okuma Takibi",
  "options": [ "5 dakika", "10 dakika", "15 dakika", "20 dakika" ],
  "groupId": "123456789012345678@g.us",
  "readingGroupId": "mygroupid34",
  "updatedAt": "2026-08-11 10:45:00"
}
```

- `_id`: `CONFIG_KEY` ile eşleşen benzersiz konfigürasyon anahtarı
- `groupId`: Anketlerin gönderileceği WhatsApp grubu JID adresi
- `readingGroupId`: RoTaKip veritabanındaki okuma grubu kodu (`users_<readingGroupId>` ve `readingstatuses_<readingGroupId>` koleksiyonlarını belirler)

#### `polls` Koleksiyonu (Anket Kayıtları)
```json
{
  "pollId": "3EB0FF9D45F3A12550DEDA",
  "groupId": "123456789012345678@g.us",
  "title": "1 Ağustos",
  "options": [ "5 dakika", "10 dakika", "15 dakika", "20 dakika" ],
  "createdAt": "2026-08-11 10:00:00"
}
```

#### `poll_votes` Koleksiyonu (Anket Oy Kullanımları)
```json
{
  "pollId": "3EB0FF9D45F3A12550DEDA",
  "voterJid": "905351234567",
  "voterPhone": "905351234567",
  "selectedOptions": [ "15 dakika" ],
  "readingGroupId": "mygroupid34",
  "pushName": "Ahmet",
  "updatedAt": "2026-08-11 10:02:02"
}
```

#### `lid_mappings` Koleksiyonu (LID - Telefon Numarası Eşleşmeleri)
```json
{
  "_id": "114345098911975",
  "phone": "905351234567",
  "updatedAt": "2026-08-11 10:00:00"
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
