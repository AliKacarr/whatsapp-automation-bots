# WhatsApp Otomatik Anket, Mesaj ve Analiz Botları

Bu depo, WhatsApp gruplarında **anket gönderme**, **otomatik mesaj gönderme** ve **veri analizi / istatistik toplama** işlemlerini gerçekleştirmek için geliştirilmiş araçları içerir.

---

## 1. Anket Gönderme (2 Yöntem)

### Yöntem 1: Node.js Baileys Botu (Otomatik & Web Panelli)

**Açıklama**: Browser (Chrome/Puppeteer) gerektirmeyen, ultra hafif (~25MB RAM) Node.js altyapısıdır. Belirlenen saatte (varsayılan: her gün 09:00 TSİ) WhatsApp grubunuza otomatik anket gönderir.

#### Yerel (Local) Kurulum Adımları
1. **Proje Bağımlılıklarını Yükleyin**:
   ```bash
   npm install
   ```
2. **`.env` Dosyası Oluşturun**:
   Proje dizininde `.env` dosyası oluşturup aşağıdaki bilgileri tanımlayın:
   ```env
   WHATSAPP_GROUP_ID=123456789012345678@g.us
   PING_URL=http://localhost:3000/api/health *(Ücretsiz Render sunucunuzu aktif tutmak için)*
   ```
3. **Uygulamayı Başlatın**:
   ```bash
   npm start
   ```
4. **Giriş Yapın & Kullanın**:
   - Tarayıcınızda `http://localhost:3000/` adresini açın.
   - Ekrandaki QR kodu okutarak veya telefon numaranızla **8 haneli eşleşme kodu** alarak giriş yapabilirsiniz.
   - Giriş yaptıktan sonra **"Grupları & JID Listesini Göster"** butonuyla istediğiniz grubun JID bilgisini kopyalayıp `.env` dosyanıza kaydedebilirsiniz.
   - Alternatif olarak terminalde `node list-groups.js` komutunu çalıştırarak da üye olduğunuz tüm grupları ve JID kodlarını listeleyebilirsiniz.

#### Render.com Üzerinde 7/24 Ücretsiz Canlıya Alma (Cloud Deployment)
Bilgisayarınızı sürekli açık tutmaya gerek kalmadan botu Render.com üzerinde 7/24 ücretsiz çalıştırmak için aşağıdaki adımları izleyebilirsiniz:

1. **Fork Alma**: Kendi GitHub hesabınıza bu depoyu forklayın ([AliKacarr/whatsapp-automation-bots](https://github.com/AliKacarr/whatsapp-automation-bots)).
2. **Render Web Service Oluşturma**: [Render.com](https://render.com/) üzerinde forkladığınız repo ile yeni bir **Web Service** oluşturun.
3. **WhatsApp Oturumu Açma**: Render'ın sağladığı canlı web sitesi adresini açın (`https://your-site.onrender.com`). Ekrandaki QR kodu okutarak veya eşleşme kodu ile WhatsApp hesabınızı bağlayın.
4. **Grup JID Bilgisini Alma**: Web panelindeki **"Grupları & JID Listesini Göster"** butonuna basarak anket göndermek istediğiniz grubun JID bilgisini kopyalayın.
5. **Ortam Değişkenlerini (Environment Variables) Tanımlama**: Render panelindeki **Environment** sayfasına bilgilerinizi tanımlayın:
   - `WHATSAPP_GROUP_ID` = `123456789012345678@g.us`
   - `PING_URL` = `https://your-site.onrender.com/api/health` *(Ücretsiz Render sunucunuzu aktif tutmak için)*

🥳 **Her şey tamam!** Artık `https://your-site.onrender.com/api/send-poll` ile de manuel deneyebilir veya otomatik zamanlayıcının her gün saat 09:00'da anketi göndermesini bekleyebilirsiniz.

> **Not & Özelleştirme:**  
> Anket gönderimi varsayılan olarak saat **09:00 (TSİ)**'da çalışmaktadır. Anket başlığı olarak bugünün tarihi yazmakta; seçenekler olarak ise *5 dakika, 10 dakika...* yazmaktadır. Bu bilgileri projedeki [server.js](file:///c:/Users/Lenovo/Desktop/whatsapp-automation-bots/server.js#L15-L35) dosyası üzerinden güncelleyebilirsiniz.

#### API Endpoint'leri
| Endpoint | Metod | Açıklama |
| :--- | :--- | :--- |
| `/` | `GET` | Web QR ve Yönetim Paneli Arayüzü |
| `/api/send-poll` | `GET / POST` | WhatsApp grubuna manuel anket gönderir |
| `/api/status` | `GET` | Oturum ve bağlantı durumunu gösterir |
| `/api/groups` | `GET` | Botun katıldığı grupları listeler |
| `/api/pairing-code` | `POST` | Telefon numarası ile 8 haneli eşleşme kodu üretir |
| `/api/restart` | `POST` | Oturumu sıfırlayıp yeniden başlatır |
| `/api/health` | `GET` | Sunucu sağlık kontrolü / ping yanıtı |

### Yöntem 2: Python Selenium Scripti (`wp-bot-anket-olusturucu.py`)
- **Açıklama**: Selenium ve Chrome tarayıcısı kullanarak WhatsApp Web üzerinden otomatik anket oluşturup gönderir.
- **Kullanım**:
  ```bash
  python wp-bot-anket-olusturucu.py
  ```

---

## 2. Otomatik Mesaj Gönderme

- **Script**: `wp-bot-oto-mesaj.py`
- **Açıklama**: Belirtilen WhatsApp grubuna istediğiniz mesajı Selenium ile otomatik olarak gönderir.
- **Kullanım**:
  ```bash
  python wp-bot-oto-mesaj.py
  ```

---

## 3. Veri Analizi ve İstatistik

Grup içi okuma, mesaj ve anket istatistiklerini toplamak için aşağıdaki Python scriptleri kullanılır:

- **`wp-bot-web-istatistikleri.py`**: WhatsApp Web üzerinde belirtilen gruptaki mesajları analiz eder, tarih aralığı ve anahtar kelimelere göre sınıflandırır.
- **`wp-bot-anket-istatistikleri.py`**: Gruptaki anketi bulup ankete oy verenleri ve seçenekleri analiz eder.
- **`wp-bot-desktop.py`**: Kullanıcının masaüstü uygulamasından kopyaladığı mesajları analiz eder.
- **`logout_whatsapp.py`**: WhatsApp Web oturumunu güvenli şekilde sonlandırmak için kullanılır.

---

## Python Botları İçin Kurulum ve Yapılandırma

### Gereksinimler
- **Python 3.7+**
- **Chrome tarayıcısı** ve **`chromedriver`** (Not: `chromedriver` sistem PATH'ine eklenmiş olmalıdır)
- **Kütüphane Kurulumu**:
  ```bash
  pip install selenium clipboard
  ```

### Script İçi Yapılandırma
Python botlarını kullanmadan önce ilgili script dosyaları içerisindeki aşağıdaki değişkenleri kendi kullanımınıza göre ayarlamanız gerekir:

```python
group_name = "Grup Adı"
options = {
    "seçenek1": ["varyant1", "varyant2"],
    "seçenek2": ["varyant1", "varyant2"]
}
start_datetime_str = "21:00 4/5/2025"  # saat:dakika gün/ay/yıl
end_datetime_str = "22:10 30/5/2025"
poll_topic = "Anket Başlığı"  # Anket analiz botu için
message_text = "Merhaba"  # Gönderilecek mesaj
```

---

## Notlar ve Uyarılar

- **Selenium ve Arayüz**: Scriptler Selenium kullanır. WhatsApp Web arayüzü değişirse bazı XPath yollarında ufak güncellemeler gerekebilir.
- **QR Kod Taraması**: Python botlarının çalışabilmesi için WhatsApp Web ana sayfasındaki QR kodun telefonla taratılması gerekmektedir. Tarama işleminden sonra bot ilgili sohbeti bulup otomatik olarak devam eder.
- **Çalışma Süresi**: Bu işlemlerin başarıyla gerçekleşmesi, internet bağlantı hızınıza bağlı olarak yaklaşık 2 dakika sürebilir. Lütfen bu süreçte tarayıcıyı kapatmadan bekleyiniz.
- **Oturum Sonlandırma**: Python scriptleri çalışmasını tamamladıktan sonra WhatsApp Web oturumunu kapatır.
- **Güvenlik ve Gizlilik**: WhatsApp oturum verileri `whatsapp/session/` klasöründe tutulur ve `.gitignore` ile gizlenmiştir. Kendi sohbet verileriniz dışında kullanımda gizlilik kurallarına uymanız gerekmektedir. Bu araç yalnızca kişisel kullanım için tasarlanmıştır.

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

Bu proje [MIT Lisansı](LICENSE.txt) ile lisanslanmıştır.
