"""
Bu Python scripti, WhatsApp Web üzerinde belirli bir grupta anket oluşturmak için Selenium kullanır.
Sohbet adı, anket başlığı ve anket seçenekleri kodda (değişkenleri kodda özelleştiriniz) tanımlanmıştır.
"""

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
import time
import sys
from logout_whatsapp import logout_whatsapp

def main():
    group_name = "Okuma Takip Grubu"  # Sohbet/grup adı
    poll_title = "13 Mayıs"  # Anket başlığı
    poll_options = [ # Anket seçenekleri
        "Okudum",
        "Okumadım"
    ]
    allow_multiple_answers = False  # Birden çok yanıta izin verme

    # Anket seçenekleri aynı olamaz kontrolü
    seen_opts = set()
    dup_opts = []
    for opt in poll_options:
        opt_norm = opt.strip().lower()
        if opt_norm in seen_opts:
            if opt not in dup_opts:
                dup_opts.append(opt)
        else:
            seen_opts.add(opt_norm)

    if dup_opts:
        print(f"❌ Hata: Anket seçenekleri aynı olamaz! Yinelenen seçenekler: {', '.join(dup_opts)}")
        sys.exit(1)

    options = Options()
    options.add_argument("--start-maximized")
    options.add_argument("--log-level=3")
    options.add_experimental_option('excludeSwitches', ['enable-logging'])
    options.add_argument("--new-window")

    try:
        driver = webdriver.Chrome(options=options)
        driver.get("https://web.whatsapp.com/")
    except Exception as e:
        print("Chrome başlatılamadı:", e)
        sys.exit(1)

    try:
        search_xpath = '//div[@role="textbox" and @aria-label="Arama metni giriş alanı" and @contenteditable="true"]'
        WebDriverWait(driver, 100, poll_frequency=2).until(EC.presence_of_element_located((By.XPATH, search_xpath)))
    except Exception:
        print("WhatsApp Web yüklenemedi.")
        driver.quit()
        sys.exit(1)

    # Sohbeti bul ve aç
    try:
        search_box = driver.find_element(By.XPATH, search_xpath)
        search_box.click()
        search_box.send_keys(group_name)
        # Arama sonrası grupların yüklenmesini bekle
        pane_side_xpath = '//div[@id="pane-side"]'
        WebDriverWait(driver, 20, poll_frequency=1).until(EC.presence_of_element_located((By.XPATH, pane_side_xpath)))
        # Grup kutularını bul
        group_divs = WebDriverWait(driver, 20, poll_frequency=1).until(
            EC.presence_of_all_elements_located((By.XPATH, '//div[@id="pane-side"]//div[contains(@class,"x10l6tqk") and contains(@class,"xh8yej3") and contains(@class,"x1g42fcv")]'))
        )
        for div in group_divs:
            try:
                # Grup adını içeren span'ı bul
                span = div.find_element(By.XPATH, './/span[@title]')
                if span.get_attribute("title") == group_name:
                    # Tıklanabilir olana kadar bekle
                    clickable_span = WebDriverWait(driver, 20, poll_frequency=1).until(
                        EC.element_to_be_clickable(span)
                    )
                    clickable_span.click()
                    break
            except Exception:
                continue
    except Exception:
        print("Sohbet bulunamadı. Lütfen sohbeti manuel olarak açın ve Enter'a basın.")
        search_box.send_keys(" Sohbet bulunamadı. Lütfen sohbeti seçiniz.")
        input()

    # Footer'daki plus (ekle) butonuna tıkla
    try:
        plus_button_xpath = '//footer[contains(@class,"_ak1i")]//div[contains(@class,"_ak1q")]//button'
        plus_button = WebDriverWait(driver, 20, poll_frequency=1).until(EC.element_to_be_clickable((By.XPATH, plus_button_xpath)))
        plus_button.click()
    except Exception as e:
        print("Plus (ekle) butonuna tıklanamadı:", e)
        safe_logout_whatsapp(driver)
        driver.quit()
        sys.exit(1)

    # Açılan panelden "Anket" seçeneğine tıkla
    try:
        poll_li_xpath = '//*[@id="app"]/div/span[5]/div/ul/div/div/div[5]/li[@role="button" and .//span[text()="Anket"]]'
        poll_li = WebDriverWait(driver, 21, poll_frequency=1).until(
            EC.element_to_be_clickable((By.XPATH, poll_li_xpath))
        )
        poll_li.click()
    except Exception as e:
        print("Anket seçeneğine tıklanamadı:", e)
        safe_logout_whatsapp(driver)
        driver.quit()
        sys.exit(1)

    # Anket başlığı ve seçeneklerini doldur
    try:
        # Anket başlığı alanını bul ve doldur
        print("Anket başlığı alanını buluyor ve dolduruyor...")
        poll_title_xpath = '//*[@id="app"]/div/span[2]/div/div/div/div/div/div/div/div/div[1]/div/div[1]/div[2]/div[3]/div/div[@contenteditable="true"]'
        poll_title_div = WebDriverWait(driver, 20, poll_frequency=1).until(EC.element_to_be_clickable((By.XPATH, poll_title_xpath)))
        poll_title_div.click()
        poll_title_div.send_keys(poll_title)
        print("Anket başlığı alanı dolduruldu.")

        # Seçenekler alanındaki xh8yej3 divlerini bul ve poll_options ile doldur
        try:
            # Önce sınıf adlarını kullanarak bulmayı dene
            options_container_xpath = '//div[contains(@class,"x1odjw0f") and contains(@class,"xr9ek0c") and contains(@class,"xyorhqc")]'
            options_container = WebDriverWait(driver, 10, poll_frequency=1).until(EC.presence_of_element_located((By.XPATH, options_container_xpath)))
        except Exception:
            # Bulunamazsa sabit XPath yolunu dene
            options_container_xpath = '//*[@id="app"]/div/span[2]/div/div/div/div/div/div/div/div/div[1]/div/div[2]'
            options_container = WebDriverWait(driver, 10, poll_frequency=1).until(EC.presence_of_element_located((By.XPATH, options_container_xpath)))
            print("XPath yolu kullanıldı")
        
        inner_container = options_container.find_element(By.XPATH, './/div[contains(@class,"x78zum5") and contains(@class,"xdt5ytf")]')
        for option_text in poll_options:
            yazildi = False
            # Her seferinde güncel xh8yej3 div listesini al
            option_divs = inner_container.find_elements(By.XPATH, './div[contains(@class,"xh8yej3")]')
            for div in option_divs:
                try:
                    # Her bir divdeki lexical-rich-text-input alanını bul
                    input_div = div.find_element(By.XPATH, './/div[contains(@class,"x1n2onr6") and contains(@class,"xh8yej3") and contains(@class,"lexical-rich-text-input")]/div[@contenteditable="true"]')
                    # Eğer input boşsa veya "Ekleyin" yazıyorsa, buraya yaz
                    if not input_div.text or input_div.text.strip().lower() == "ekleyin":
                        input_div.click()
                        input_div.send_keys(option_text)
                        yazildi = True
                        break  # Bir seçenek yazınca döngüyü kır, güncel div listesini tekrar al
                except Exception:
                    continue
            if not yazildi:
                print(f"'{option_text}' seçeneği için boş alan bulunamadı!")
        print("Seçenekler dolduruldu.")

        # allow_multiple_answers kontrolü ve switch'e tıklama
        if not allow_multiple_answers:
            try:
                switch_xpath = '//input[@id="polls-single-option-switch"]'
                switch_input = WebDriverWait(driver, 10, poll_frequency=1).until(EC.presence_of_element_located((By.XPATH, switch_xpath)))
                if switch_input.is_selected():
                    try:
                        label_xpath = '//label[@for="polls-single-option-switch"]'
                        label = WebDriverWait(driver, 10, poll_frequency=1).until(
                            EC.element_to_be_clickable((By.XPATH, label_xpath))
                        )
                        label.click()
                    except Exception:
                        driver.execute_script("arguments[0].click();", switch_input)
            except Exception as e:
                print("Switch (Birden çok yanıta izin ver) tıklanamadı:", e)

        # Anketi gönder
        try:
            # Find and click the send button
            button_xpath = '//div[contains(@class,"x78zum5") and contains(@class,"x6s0dn4") and contains(@class,"xl56j7k") and contains(@class,"xexx8yu")]'
            button_div = WebDriverWait(driver, 10).until(
                EC.element_to_be_clickable((By.XPATH, button_xpath))
            )
            button_div.click()
            print("Anket gönderildi.")
        except Exception as e:
            print("Anket gönderilemedi:", e)
    except Exception as e:
        print("Anket oluşturulamadı veya gönderilemedi:", e)

    # Anketi gönderme sonrası anket mesajının gönderilme durumunu kontrol et
    try:
        print("Mesajın gruba ulaşmasını ve anketin gönderildiğini kontrol ediyorum...")
        poll_found = False
        poll_msg_div = None

        def find_poll_message(driver):
            nonlocal poll_found, poll_msg_div
            print("Mesaj kontrolü döngüsü... ")
            messages_container_xpath = '//*[@id="main"]/div[3]/div/div[2]/div[3]'
            try:
                messages_container = driver.find_element(By.XPATH, messages_container_xpath)
                msg_divs = messages_container.find_elements(By.XPATH, './div')
                if msg_divs:
                    for msg_div in reversed(msg_divs[-20:]):
                        try:
                            spans = msg_div.find_elements(By.XPATH, f'.//span[text()="{poll_title}"]')
                            aria_divs = msg_div.find_elements(By.XPATH, f'.//*[@aria-label[contains(.,"{poll_title} konulu anket")]]')
                            if spans or aria_divs:
                                poll_found = True
                                poll_msg_div = msg_div
                                return True
                        except Exception:
                            continue
            except Exception:
                pass
            return False

        try:
            WebDriverWait(driver, 30, poll_frequency=2).until(find_poll_message)
        except Exception:
            pass

        if not poll_found:
            print(f"'{poll_title}' başlıklı anket mesajı 30 saniye içinde bulunamadı.")
        else:
            print(f"'{poll_title}' başlıklı anket mesajı bulundu, gönderim durumu kontrol ediliyor...")

            # 100 saniye boyunca gönderim durumunu Fluent Wait ile 2 saniye aralıklarla kontrol et
            def check_sent(driver):
                try:
                    check_icon = poll_msg_div.find_elements(By.XPATH, './/span[@data-icon="msg-check"]')
                    dblcheck_icon = poll_msg_div.find_elements(By.XPATH, './/span[@data-icon="msg-dblcheck"]')
                    return bool(check_icon or dblcheck_icon)
                except Exception:
                    return False

            try:
                # First try with 5 second intervals for 20 seconds
                try:
                    WebDriverWait(driver, 20, poll_frequency=5).until(check_sent)
                except:
                    # If not found, continue checking with 20 second intervals for 80 seconds
                    WebDriverWait(driver, 80, poll_frequency=20).until(check_sent)
                print(f"'{poll_title}' başlıklı anket başarıyla gönderildi ve grupta görünüyor.")
            except Exception:
                print(f"'{poll_title}' başlıklı anket bulundu ancak gönderildiği onaylanamadı.")
    except Exception as e:
        print("Anket mesajı ve gönderim durumu kontrolünde hata:", e)

    safe_logout_whatsapp(driver)
    driver.quit()

def safe_logout_whatsapp(driver):
    """
    Eğer WhatsApp Web sekmesi açıksa oturumu kapatır.
    """
    try:
        if "web.whatsapp.com" in driver.current_url:
            logout_whatsapp(driver)
    except Exception:
        pass

if __name__ == "__main__":
    main()
