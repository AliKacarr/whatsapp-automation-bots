const express = require('express');
const path = require('path');
const fs = require('fs');
const schedule = require('node-schedule');
const pino = require('pino');
const QRCode = require('qrcode');
require('dotenv').config();

// ============================================================================
// KONFİGÜRASYON VE SABİTLER
// ============================================================================

const DEFAULT_GROUP_ID = process.env.WHATSAPP_GROUP_ID;

const DEFAULT_POLL_OPTIONS = [
  '5 dakika', '10 dakika', '15 dakika', '20 dakika', '30 dakika',
  '45 dakika', '60 dakika', '75 dakika', '90 dakika', '120 dakika',
  '150 dakika', '180 dakika'
];

const MONTH_NAMES_TR = [
  'Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran',
  'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'
];

/**
 * Günlük dinamik anket başlığını üretir (Örn: "1 Ağustos")
 */
function getDailyPollTitle(customTitle = null) {
  if (customTitle) return customTitle;
  const today = new Date();
  const day = today.getDate();
  const month = MONTH_NAMES_TR[today.getMonth()];
  return `${day} ${month}`;
}

// ============================================================================
// WHATSAPP BAILEYS CLIENT YÖNETİMİ
// ============================================================================

// Baileys modülü dinamik yükleme (ESM Uyumlu)
let makeWASocket = null;
let useMultiFileAuthState = null;
let DisconnectReason = null;
let fetchLatestWaWebVersion = null;
let Browsers = null;

async function loadBaileys() {
  if (!makeWASocket) {
    const baileys = await import('@whiskeysockets/baileys');
    makeWASocket = baileys.default || baileys.makeWASocket;
    useMultiFileAuthState = baileys.useMultiFileAuthState;
    DisconnectReason = baileys.DisconnectReason;
    fetchLatestWaWebVersion = baileys.fetchLatestWaWebVersion;
    Browsers = baileys.Browsers;
  }
}

// Session ve kimlik doğrulama dizinleri
const SESSION_BASE = path.resolve(__dirname, 'whatsapp', 'session');
const BAILEYS_AUTH_PATH = path.join(SESSION_BASE, 'baileys_auth');
const AUTH_FILE = path.join(SESSION_BASE, 'session_authenticated.json');

if (!fs.existsSync(BAILEYS_AUTH_PATH)) {
  fs.mkdirSync(BAILEYS_AUTH_PATH, { recursive: true });
}

let sock = null;

// Servis Durumu
const state = {
  status: 'DISCONNECTED', // 'DISCONNECTED' | 'INITIALIZING' | 'WAITING_FOR_QR' | 'AUTHENTICATED' | 'READY' | 'ERROR'
  qrDataUrl: null,
  userInfo: null,
  lastPollSentAt: null,
  lastError: null
};

function hasExistingSession() {
  return fs.existsSync(AUTH_FILE);
}

async function initWhatsAppClient(onlyIfSessionExists = false) {
  if (sock && (state.status === 'READY' || state.status === 'WAITING_FOR_QR' || state.status === 'INITIALIZING')) {
    return sock;
  }

  if (onlyIfSessionExists && !hasExistingSession()) {
    console.log('ℹ️ WhatsApp oturumu bulunamadı. QR kod web adresi açıldığında üretilecek.');
    state.status = 'DISCONNECTED';
    return null;
  }

  state.status = 'INITIALIZING';
  state.lastError = null;
  console.log('🚀 WhatsApp Baileys istemcisi başlatılıyor (Süper hafif mod - Chrome gerektirmez)...');

  try {
    await loadBaileys();

    const { state: authState, saveCreds } = await useMultiFileAuthState(BAILEYS_AUTH_PATH);
    const { version } = await fetchLatestWaWebVersion().catch(() => ({ version: [2, 3000, 1015901307] }));

    sock = makeWASocket({
      version,
      auth: authState,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: Browsers ? Browsers.ubuntu('Chrome') : ['Ubuntu', 'Chrome', '20.0.04']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        state.status = 'WAITING_FOR_QR';
        try {
          state.qrDataUrl = await QRCode.toDataURL(qr, { margin: 2, scale: 8 });
          console.log('📲 Baileys WhatsApp QR Kod üretildi! Web sayfasından okutabilirsiniz.');
        } catch (e) {
          console.error('QR DataURL hatası:', e);
        }
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.warn(`⚠️ WhatsApp bağlantısı kapandı (Kod: ${statusCode}). Yeniden bağlanılacak mı? ${shouldReconnect}`);

        state.qrDataUrl = null;

        if (shouldReconnect) {
          state.status = 'DISCONNECTED';
          setTimeout(() => {
            initWhatsAppClient(false);
          }, 3000);
        } else {
          console.log('ℹ️ WhatsApp oturumu kapatıldı/sonlandırıldı. Eski oturum verileri temizlenip yeni QR kod üretiliyor...');
          if (fs.existsSync(AUTH_FILE)) {
            try { fs.unlinkSync(AUTH_FILE); } catch (e) { }
          }
          if (fs.existsSync(BAILEYS_AUTH_PATH)) {
            try { fs.rmSync(BAILEYS_AUTH_PATH, { recursive: true, force: true }); } catch (e) { }
          }
          if (sock) {
            try { sock.end(new Error('Logged out')); } catch (e) { }
            sock = null;
          }
          state.status = 'INITIALIZING';
          state.userInfo = null;
          state.lastError = null;

          setTimeout(() => {
            initWhatsAppClient(false);
          }, 1500);
        }
      } else if (connection === 'open') {
        state.status = 'READY';
        state.qrDataUrl = null;
        state.userInfo = {
          id: sock.user?.id || 'Bağlı',
          pushname: sock.user?.name || sock.user?.notify || 'Ubuntu'
        };
        console.log('✅ WhatsApp Baileys İstemcisi Hazır! Bağlı Kullanıcı:', state.userInfo.pushname);
        try {
          fs.writeFileSync(AUTH_FILE, JSON.stringify(state.userInfo, null, 2), 'utf-8');
        } catch (e) { }
      }
    });

    return sock;
  } catch (err) {
    console.error('❌ Baileys başlatma hatası:', err);
    state.status = 'ERROR';
    state.lastError = err.message;
    return null;
  }
}

async function requestPairingCode(phoneNumber) {
  await loadBaileys();

  if (!sock || state.status === 'DISCONNECTED' || state.status === 'ERROR') {
    await initWhatsAppClient(false);
    await new Promise(r => setTimeout(r, 1500));
  }
  if (!sock) throw new Error('İstemci başlatılamadı.');

  let cleanedNumber = phoneNumber.replace(/\D/g, '');
  if (cleanedNumber.startsWith('0') && cleanedNumber.length === 11) {
    cleanedNumber = '90' + cleanedNumber.substring(1);
  } else if (cleanedNumber.length === 10 && cleanedNumber.startsWith('5')) {
    cleanedNumber = '90' + cleanedNumber;
  }

  if (!cleanedNumber || cleanedNumber.length < 10) {
    throw new Error('Geçerli bir telefon numarası girin (örn: 5551234567).');
  }

  console.log(`📲 Telefon Numarası ile Eşleşme Kodu isteniyor (${cleanedNumber})...`);
  const rawCode = await sock.requestPairingCode(cleanedNumber);
  const code = rawCode?.match(/.{1,4}/g)?.join('-') || rawCode;
  return code;
}

async function restartWhatsAppClient() {
  console.log('🔄 WhatsApp Baileys istemcisi sıfırlanıyor...');
  if (fs.existsSync(AUTH_FILE)) {
    try { fs.unlinkSync(AUTH_FILE); } catch (e) { }
  }
  if (fs.existsSync(BAILEYS_AUTH_PATH)) {
    try { fs.rmSync(BAILEYS_AUTH_PATH, { recursive: true, force: true }); } catch (e) { }
  }
  if (sock) {
    try {
      sock.end(new Error('Manual Restart'));
    } catch (e) { }
    sock = null;
  }
  state.status = 'DISCONNECTED';
  state.qrDataUrl = null;
  state.userInfo = null;
  state.lastError = null;

  return initWhatsAppClient(false);
}

async function sendWhatsAppPoll(options = {}) {
  const {
    groupId = DEFAULT_GROUP_ID,
    pollTitleCustom = null
  } = options;

  if (!sock || state.status !== 'READY') {
    return {
      success: false,
      status: state.status,
      message: 'WhatsApp istemcisi bağlı veya hazır değil! Lütfen önce QR kodu veya eşleşme kodunu okutun.'
    };
  }

  const pollTitle = getDailyPollTitle(pollTitleCustom);

  try {
    const sent = await sock.sendMessage(groupId, {
      poll: {
        name: pollTitle,
        values: DEFAULT_POLL_OPTIONS,
        selectableCount: 1
      }
    });

    const messageId = sent?.key?.id || 'GÖNDERİLDİ';
    state.lastPollSentAt = new Date().toISOString();
    console.log(`🗳️ Baileys WhatsApp Anketi gönderildi (${pollTitle}) [Grup: ${groupId}] -> MsgId: ${messageId}`);
    return {
      success: true,
      messageId,
      pollTitle,
      groupId,
      sentAt: state.lastPollSentAt
    };
  } catch (err) {
    console.error('❌ WhatsApp Anket Gönderme Hatası:', err);
    return {
      success: false,
      error: err.message
    };
  }
}

async function getWhatsAppGroups() {
  if (!sock || state.status !== 'READY') {
    return [];
  }
  try {
    const groupsMap = await sock.groupFetchAllParticipating();
    return Object.values(groupsMap).map(g => ({
      id: g.id,
      name: g.subject,
      unreadCount: 0
    }));
  } catch (err) {
    console.error('Gruplar çekilirken hata:', err);
    return [];
  }
}

function scheduleWhatsAppPollJob() {
  const job = schedule.scheduleJob({ rule: '0 9 * * *', tz: 'Europe/Istanbul' }, async () => {
    const zaman = new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
    console.log(`\n[ZAMANLAYICI - ${zaman}] Günlük WhatsApp anketi gönderimi başlatılıyor...`);
    try {
      const res = await sendWhatsAppPoll();
      console.log(`[ZAMANLAYICI] WhatsApp Anket Gönderim Sonucu:`, res);
    } catch (error) {
      console.error(`[ZAMANLAYICI] WhatsApp Anket Gönderim Hatası:`, error);
    }
  });
  console.log("✅ WhatsApp Anket Zamanlayıcısı Kuruldu: Her gün saat 09:00 (TSİ)");
  return job;
}

function getWhatsAppStatus(autoStartIfDisconnected = false) {
  if (autoStartIfDisconnected && (state.status === 'DISCONNECTED' || state.status === 'ERROR') && !sock) {
    initWhatsAppClient(false);
  }

  return {
    status: state.status,
    qrDataUrl: state.qrDataUrl,
    userInfo: state.userInfo,
    lastPollSentAt: state.lastPollSentAt,
    lastError: state.lastError,
    engine: 'Baileys (Ultra Light - 25MB RAM)'
  };
}

// ============================================================================
// EXPRESS APP VE API ENDPOINT'LERİ
// ============================================================================

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Sağlık kontrolü endpoint'i
app.get('/api/health', (req, res) => {
  res.json({ ok: true, timestamp: Date.now() });
});

// Render'ı uyanık tutmak için ping sistemi
function schedulePing() {
  const pingUrl = process.env.PING_URL;
  const pingJob = schedule.scheduleJob('*/2 * * * *', async () => {
    try {
      const response = await fetch(pingUrl, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        console.warn(`⚠️ Ping başarısız: ${response.status} ${response.statusText} - ${errorText.trim()}`);
        return;
      }

      const contentType = response.headers.get('content-type');
      if (!(contentType && contentType.includes('application/json'))) {
        const text = await response.text();
        console.warn(`⚠️ Ping yanıtı JSON değil: ${text.substring(0, 100)}`);
      }
    } catch (error) {
      if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
        console.warn('⚠️ Ping bağlantı hatası (network). Bir sonraki ping\'de tekrar denenecek.');
      } else if (error.message && error.message.includes('JSON')) {
        console.warn('⚠️ Ping JSON parse hatası:', error.message);
      } else {
        console.warn('⚠️ Ping hatası:', error.message || error);
      }
    }
  });

  console.log("Ping scheduler started.");

  process.on('SIGINT', async () => {
    console.log('Uygulama kapatılıyor...');
    try { pingJob.cancel(); } catch (e) { }
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('Uygulama kapatılıyor...');
    try { pingJob.cancel(); } catch (e) { }
    process.exit(0);
  });

  return pingJob;
}

// Ping zamanlayıcısını başlat
const pingJob = schedulePing();

// WhatsApp istemcisini ve her gün 09:00 (TSİ) zamanlayıcısını başlat
try {
  initWhatsAppClient(true);
  scheduleWhatsAppPollJob();
} catch (wpInitErr) {
  console.error("⚠️ WhatsApp servisi başlatılırken hata:", wpInitErr.message);
}

// WhatsApp API Endpoint'leri
app.get('/api/status', (req, res) => {
  const autoStart = req.query.autoStart === 'true';
  res.json(getWhatsAppStatus(autoStart));
});

app.get('/api/groups', async (req, res) => {
  try {
    const groups = await getWhatsAppGroups();
    res.json({ success: true, count: groups.length, groups });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Manuel Anket Gönderme Endpoint'i (örn: GET veya POST /api/send-poll)
app.all(['/api/send-poll', '/api/run-poll'], async (req, res) => {
  try {
    const groupId = req.query.groupId || req.body?.groupId;
    const pollTitle = req.query.pollTitle || req.body?.pollTitle;
    const result = await sendWhatsAppPoll({ groupId, pollTitleCustom: pollTitle });
    res.json(result);
  } catch (error) {
    console.error("WhatsApp manuel anket hatası:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/restart', async (req, res) => {
  try {
    await restartWhatsAppClient();
    res.json({ success: true, message: 'WhatsApp istemcisi yeniden başlatılıyor...' });
  } catch (error) {
    console.error("WhatsApp restart hatası:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/pairing-code', async (req, res) => {
  try {
    const { phoneNumber } = req.body;
    if (!phoneNumber) {
      return res.status(400).json({ success: false, message: 'Telefon numarası gereklidir (Örn: 5551234567)' });
    }
    const code = await requestPairingCode(phoneNumber);
    res.json({ success: true, code });
  } catch (error) {
    console.error("Pairing code hatası:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Web Arayüzü (Ana dizindeki index.html sunulur)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Server Başlatma
app.listen(port, () => {
  console.log(`Uygulama http://localhost:${port} adresinde çalışıyor`);
});