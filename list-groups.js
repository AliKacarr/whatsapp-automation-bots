const qrcode = require('qrcode-terminal');
const pino = require('pino');

async function connectToWhatsApp() {
    const baileys = await import('@whiskeysockets/baileys');
    const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = baileys;

    // Oturum verilerinin kaydedileceği klasörü belirliyoruz
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false, // Karekodu kendimiz bastıracağız
        logger: pino({ level: 'silent' }) // Konsoldaki kalabalık debug loglarını gizler
    });

    // Oturumda bir değişiklik olursa kaydet
    sock.ev.on('creds.update', saveCreds);

    // Bağlantı durumunu dinle
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('Lütfen WhatsApp üzerinden aşağıdaki karekodu okutun:');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Bağlantı koptu. Yeniden bağlanılıyor...', shouldReconnect);

            if (shouldReconnect) {
                connectToWhatsApp();
            } else {
                console.log('Oturum kapatılmış. Lütfen baileys_auth_info klasörünü silip tekrar başlatın.');
            }
        }
        else if (connection === 'open') {
            console.log('WhatsApp bağlantısı başarılı! Gruplar çekiliyor...\n');

            try {
                // Sadece içinde bulunduğunuz grupları doğrudan çeker
                const groups = await sock.groupFetchAllParticipating();

                const groupIds = Object.keys(groups);
                console.log(`Toplam ${groupIds.length} grup bulundu.\n`);
                console.log('--- GRUP JID LİSTESİ ---');

                groupIds.forEach(id => {
                    console.log(`Grup Adı: ${groups[id].subject}`);
                    console.log(`Grup JID: ${id}`);
                    console.log('------------------------');
                });

                // İşlem bittiğinde scripti sonlandırıyoruz
                console.log('Gruplar listelendi. Bağlantı kapatılıyor.');
                sock.ws?.close();
                process.exit(0);

            } catch (error) {
                console.error('Gruplar çekilirken bir hata oluştu:', error);
                process.exit(1);
            }
        }
    });
}

connectToWhatsApp();