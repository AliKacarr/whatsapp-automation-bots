const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const schedule = require('node-schedule');
const pino = require('pino');
const QRCode = require('qrcode');
require('dotenv').config();
const { connectDB, isDBEnabled, getDB, savePoll, saveVote, removeVote, getTRDateString, getPollConfig, savePollConfig, saveLidMapping, getAllLidMappings, getRandomSentence } = require('./db');

// ============================================================================
// LOG FİLTRESİ (Libsignal / Bad MAC Gürültüsünü Engelleme)
// ============================================================================
const originalStderrWrite = process.stderr.write;
process.stderr.write = function (chunk, encoding, callback) {
  const str = chunk.toString();
  if (
    str.includes('MAC Error: Bad MAC') ||
    str.includes('SessionCipher') ||
    str.includes('Closing open session') ||
    str.includes('verifyMAC') ||
    str.includes('doDecryptWhisperMessage')
  ) {
    return true; // Gürültülü libsignal dahili şifreleme hatalarını konsoldan gizle
  }
  return originalStderrWrite.apply(process.stderr, arguments);
};


// ============================================================================
// KONFİGÜRASYON VE SABİTLER
// ============================================================================

const DEFAULT_GROUP_ID = process.env.WHATSAPP_GROUP_ID;

function hasValidGroupId() {
  return !!(DEFAULT_GROUP_ID && DEFAULT_GROUP_ID.trim() !== '' && !DEFAULT_GROUP_ID.includes('1234567890'));
}

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
 * Günlük dinamik anket başlığını üretir (Örn: "4 Ağustos" veya "4 Ağustos Okuma Anketi")
 * customTitle içinde {{date}} şablonu varsa günün tarihi ile değiştirir.
 */
function getDailyPollTitle(customTitle = null) {
  const today = new Date();
  const day = today.getDate();
  const month = MONTH_NAMES_TR[today.getMonth()];
  const dateStr = `${day} ${month}`;

  if (!customTitle) return dateStr;
  if (customTitle.includes('{{date}}')) {
    return customTitle.replace(/\{\{date\}\}/g, dateStr);
  }
  return customTitle;
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
let getAggregateVotesInPollMessage = null;
let proto = null;
let decryptPollVote = null;
let jidNormalizedUser = null;

async function loadBaileys() {
  if (!makeWASocket) {
    const baileys = await import('@whiskeysockets/baileys');
    makeWASocket = baileys.default || baileys.makeWASocket;
    useMultiFileAuthState = baileys.useMultiFileAuthState;
    DisconnectReason = baileys.DisconnectReason;
    fetchLatestWaWebVersion = baileys.fetchLatestWaWebVersion;
    Browsers = baileys.Browsers;
    getAggregateVotesInPollMessage = baileys.getAggregateVotesInPollMessage;
    proto = baileys.proto;
    decryptPollVote = baileys.decryptPollVote;
    jidNormalizedUser = baileys.jidNormalizedUser;
  }
}

// Anket mesajlarını bellekte tutan depo (oy şifre çözümü için zorunlu)
const messageStore = new Map();

/**
 * Anket mesajını protobuf binary olarak serileştirip base64 string döner.
 * MongoDB'de kalıcı saklanması için kullanılır.
 */
function serializePollMessage(message) {
  if (!proto || !message) return null;
  try {
    const encoded = proto.Message.encode(message).finish();
    return Buffer.from(encoded).toString('base64');
  } catch (e) {
    console.error('⚠️ Mesaj serileştirme hatası:', e.message);
    return null;
  }
}

/**
 * MongoDB'den okunan base64 string'i protobuf mesaj nesnesine geri çözer.
 */
function deserializePollMessage(base64) {
  if (!proto || !base64) return null;
  try {
    return proto.Message.decode(Buffer.from(base64, 'base64'));
  } catch (e) {
    console.error('⚠️ Mesaj deserileştirme hatası:', e.message);
    return null;
  }
}

// LID -> Telefon numarası JID eşleşme önbelleği
const lidToPhoneMap = new Map();

/**
 * Güvenli bir şekilde LID ve Telefon Numarası JID'lerini eşleştiren yardımcı fonksiyon.
 */
function registerJidLidMapping(phoneCandidate, lidCandidate) {
  if (!phoneCandidate || !lidCandidate) return;

  const phoneStr = String(phoneCandidate);
  const lidStr = String(lidCandidate);

  // Phone candidate asla LID olmamalı
  if (phoneStr.includes('@lid')) return;

  const normPhone = jidNormalizedUser ? jidNormalizedUser(phoneStr) : phoneStr;
  const normLid = jidNormalizedUser ? jidNormalizedUser(lidStr) : lidStr;

  const barePhone = normPhone.split('@')[0].split(':')[0];
  const bareLid = normLid.split('@')[0].split(':')[0];

  // barePhone ile bareLid aynı olamaz (LID'nin kendisine haritalanmasını engelle)
  if (barePhone !== bareLid && /^\d{7,15}$/.test(barePhone)) {
    lidToPhoneMap.set(normLid, barePhone);
    lidToPhoneMap.set(bareLid, barePhone);
    saveLidMapping(bareLid, barePhone);
  }
}

/**
 * Herhangi bir katılımcı veya kişi objesinden LID ve Telefon Numarasını çıkarıp eşleştirir.
 */
function processParticipantOrContact(item) {
  if (!item) return;

  let phoneJid = null;
  let lidJid = null;

  const candidates = [item.id, item.jid, item.phoneNumber, item.pn, item.user].filter(Boolean);

  for (const cand of candidates) {
    const str = String(cand);
    if (str.includes('@s.whatsapp.net')) {
      phoneJid = str;
    } else if (str.includes('@lid')) {
      lidJid = str;
    } else if (/^\d{10,15}$/.test(str)) {
      phoneJid = str + '@s.whatsapp.net';
    }
  }

  if (item.lid) {
    const strLid = String(item.lid);
    if (strLid.includes('@lid') || /^\d{12,20}$/.test(strLid)) {
      lidJid = strLid.includes('@lid') ? strLid : strLid + '@lid';
    }
  }

  if (phoneJid && lidJid) {
    registerJidLidMapping(phoneJid, lidJid);
  }
}

/**
 * Baileys istemcisinin dahil olduğu tüm gruplardaki katılımcıları tarayarak LID -> Phone haritasını günceller.
 */
async function updateLidPhoneMapFromGroups() {
  // Önce MongoDB'de önceden kalıcı kaydedilmiş tüm haritaları belleğe yükle
  try {
    const dbMap = await getAllLidMappings();
    for (const lid in dbMap) {
      const phone = dbMap[lid];
      lidToPhoneMap.set(lid, phone);
      lidToPhoneMap.set(lid + '@lid', phone);
    }
  } catch (e) { }

  if (!sock || state.status !== 'READY') return;
  try {
    const groupsMap = await sock.groupFetchAllParticipating();
    for (const gId in groupsMap) {
      const group = groupsMap[gId];
      if (group?.participants) {
        for (const p of group.participants) {
          processParticipantOrContact(p);
        }
      }
    }
  } catch (e) { }
}

/**
 * JID adresini (LID veya s.whatsapp.net) temiz telefon numarasına dönüştürür.
 * (Örn: "905351234567@s.whatsapp.net" -> "905351234567", "114345098911975@lid" -> "905361234567")
 */
async function getPhoneNumberFromJid(jid, groupId = DEFAULT_GROUP_ID) {
  if (!jid) return null;

  const normalized = jidNormalizedUser ? jidNormalizedUser(jid) : jid;
  const bare = normalized.split('@')[0].split(':')[0];

  // 0) Zaten telefon numarası JID'si ise veya bare numara ise (ör: 905361234567)
  if (normalized.includes('@s.whatsapp.net') || (/^\d{10,12}$/.test(bare) && (bare.startsWith('90') || bare.startsWith('5')))) {
    return bare;
  }

  // 1) Bağlı olan kullanıcının kendi JID & LID haritasını kontrol et
  if (sock?.user?.id && sock?.user?.lid) {
    processParticipantOrContact({ id: sock.user.id, lid: sock.user.lid });
  }

  // 2) LID ise önbellekte ara
  if (lidToPhoneMap.has(normalized)) {
    return lidToPhoneMap.get(normalized);
  }
  if (lidToPhoneMap.has(bare)) {
    return lidToPhoneMap.get(bare);
  }

  // 3) Önbellekte yoksa katıldığımız gruplardaki üye listelerini çekip haritalandır
  await updateLidPhoneMapFromGroups();

  if (lidToPhoneMap.has(normalized)) {
    return lidToPhoneMap.get(normalized);
  }
  if (lidToPhoneMap.has(bare)) {
    return lidToPhoneMap.get(bare);
  }

  // Çözülemezse bare ID'yi dön
  return bare;
}

/**
 * Verilen JID/ID girdileri için (LID, PN JID, bare ID, :0 cihaz uzantısı vb.) tüm olası JID varyasyonlarını türetir.
 */
function buildJidCandidates(inputs) {
  const candidates = new Set();

  function addVariants(val) {
    if (!val) return;
    const str = String(val).trim();
    if (!str) return;

    candidates.add(str);

    const norm = jidNormalizedUser ? jidNormalizedUser(str) : str;
    candidates.add(norm);

    const bare = norm.split('@')[0].split(':')[0];
    candidates.add(bare);

    if (str.includes('@s.whatsapp.net') || /^\d{7,15}$/.test(bare)) {
      candidates.add(bare + '@s.whatsapp.net');
      candidates.add(bare + ':0@s.whatsapp.net');
    }
    if (str.includes('@lid') || /^\d{12,20}$/.test(bare)) {
      candidates.add(bare + '@lid');
      candidates.add(bare + ':0@lid');
    }

    // lidToPhoneMap çift yönlü kontrol
    if (lidToPhoneMap.has(str)) {
      const mapped = lidToPhoneMap.get(str);
      if (mapped && mapped !== str) addVariants(mapped);
    }
    if (lidToPhoneMap.has(norm)) {
      const mapped = lidToPhoneMap.get(norm);
      if (mapped && mapped !== norm) addVariants(mapped);
    }
    if (lidToPhoneMap.has(bare)) {
      const mapped = lidToPhoneMap.get(bare);
      if (mapped && mapped !== bare) addVariants(mapped);
    }
  }

  for (const item of (Array.isArray(inputs) ? inputs : [inputs])) {
    addVariants(item);
  }

  candidates.add('');
  return Array.from(candidates);
}

/**
 * Gelen oy güncelleme mesajını (pollUpdateMessage) Baileys decryptPollVote ile şifresini çözer
 * ve seçilen seçenekleri MongoDB'ye kaydeder.
 */
async function processPollVoteUpdate(pollUpdateMsg) {
  if (!isDBEnabled()) return;

  const pollUpdate = pollUpdateMsg.message?.pollUpdateMessage;
  if (!pollUpdate) return;

  const creationMsgKey = pollUpdate.pollCreationMessageKey;
  const pollMsgId = creationMsgKey?.id;
  if (!pollMsgId) return;

  const isFromMe = pollUpdateMsg.key?.fromMe;
  const selfJid = sock?.user?.id;
  const selfLid = sock?.user?.lid;

  const rawVoterJid = isFromMe
    ? (selfJid || selfLid || pollUpdateMsg.key?.participant || pollUpdateMsg.key?.remoteJid)
    : (pollUpdateMsg.key?.participant || pollUpdateMsg.key?.remoteJid || pollUpdateMsg.participant);
  const voterJid = jidNormalizedUser ? jidNormalizedUser(rawVoterJid) : rawVoterJid;

  // 1) Orijinal anket mesajını bul (memory veya MongoDB)
  let pollMsg = messageStore.get(pollMsgId);
  if (!pollMsg && getDB()) {
    try {
      const pollDoc = await getDB().collection('polls').findOne({ pollId: pollMsgId });
      if (pollDoc?.messageData) {
        const decoded = deserializePollMessage(pollDoc.messageData);
        if (decoded) {
          pollMsg = { message: decoded, key: { id: pollMsgId, remoteJid: pollDoc.groupId, fromMe: true } };
          messageStore.set(pollMsgId, pollMsg);
        }
      }
    } catch (e) {
      console.error('⚠️ DB anket okuma hatası:', e.message);
    }
  }

  if (!pollMsg || !pollMsg.message) {
    console.warn(`⚠️ Orijinal anket mesajı bulunamadı (${pollMsgId}), oy çözülemedi.`);
    return;
  }

  // 2) Anket detaylarını ve şifreleme anahtarını (messageSecret) al
  const pollCreation = pollMsg.message.pollCreationMessage ||
                       pollMsg.message.pollCreationMessageV2 ||
                       pollMsg.message.pollCreationMessageV3;

  const pollEncKey = pollMsg.message.messageContextInfo?.messageSecret || pollCreation?.messageSecret;
  if (!pollEncKey) {
    console.warn(`⚠️ Anket mesajında messageSecret bulunamadı (${pollMsgId}).`);
    return;
  }

  function safeToBuffer(val) {
    if (!val) return null;
    if (Buffer.isBuffer(val)) return val;
    if (val instanceof Uint8Array) return Buffer.from(val);
    if (typeof val === 'string') return Buffer.from(val, 'base64');
    if (val.type === 'Buffer' && Array.isArray(val.data)) return Buffer.from(val.data);
    return Buffer.from(val);
  }

  // 3) Baileys decryptPollVote ile oyu çöz
  const voteObj = pollUpdate.vote || pollUpdate;
  const rawEncPayload = voteObj?.encPayload || pollUpdate.encPayload;
  const rawEncIv = voteObj?.encIv || pollUpdate.encIv;

  if (!rawEncPayload || !rawEncIv) {
    console.warn(`⚠️ Oy mesajında encPayload veya encIv bulunamadı (${pollMsgId}).`);
    return;
  }

  const encPayload = safeToBuffer(rawEncPayload);
  const encIv = safeToBuffer(rawEncIv);
  const pollEncKeyBuf = safeToBuffer(pollEncKey);

  if (!encPayload || !encIv || !pollEncKeyBuf) {
    console.warn(`⚠️ Şifreleme anahtarları (Buffer) dönüştürülemedi (${pollMsgId}).`);
    return;
  }

  // Katılımcı haritasını yenile
  await updateLidPhoneMapFromGroups();

  // Tüm olası katılımcı/oluşturucu JID kaynaklarını topla (LID, PN JID, me JID, key participant vb.)
  const jidSources = [
    rawVoterJid,
    voterJid,
    pollUpdateMsg.key?.participant,
    pollUpdateMsg.key?.remoteJid,
    pollUpdateMsg.participant,
    pollUpdateMsg.user,
    pollMsg.key?.participant,
    pollMsg.key?.remoteJid,
    creationMsgKey?.participant,
    creationMsgKey?.remoteJid,
    sock?.user?.id,
    sock?.user?.lid
  ];

  // Voter & Creator JID Adayları
  const uniqueVoterJids = buildJidCandidates(jidSources);
  const uniqueCreatorJids = buildJidCandidates(jidSources);

  // EncKey Adayları (messageContextInfo vs pollCreation)
  const encKeyCandidates = [
    pollEncKey,
    pollCreation?.messageSecret,
    pollMsg.message?.messageContextInfo?.messageSecret
  ].filter(Boolean).map(safeToBuffer).filter(b => b && b.length === 32);

  const uniqueEncKeys = [...new Set(encKeyCandidates.map(b => b.toString('hex')))].map(h => Buffer.from(h, 'hex'));

  let decryptedVote = null;
  let decryptError = null;
  let successfulVoterJid = null;

  if (typeof decryptPollVote === 'function') {
    for (const keyBuf of uniqueEncKeys) {
      for (const cJid of uniqueCreatorJids) {
        for (const vJid of uniqueVoterJids) {
          try {
            decryptedVote = decryptPollVote(
              { encPayload, encIv },
              {
                pollCreatorJid: cJid,
                pollMsgId,
                pollEncKey: keyBuf,
                voterJid: vJid
              }
            );
            if (decryptedVote) {
              successfulVoterJid = vJid;
              break;
            }
          } catch (err) {
            decryptError = err;
          }
        }
        if (decryptedVote) break;
      }
      if (decryptedVote) break;
    }
  }

  if (!decryptedVote) {
    console.error('❌ Oy şifresi çözülemedi:', decryptError?.message || 'Deşifre boş döndü');
    return;
  }

  // 4) Seçilen seçeneklerin SHA256 özetini orijinal anket seçenekleriyle eşleştir
  const options = pollCreation?.options || [];
  const selectedOptionNames = [];

  for (const selectedHash of (decryptedVote.selectedOptions || [])) {
    const selectedHashHex = Buffer.from(selectedHash).toString('hex');
    for (const opt of options) {
      const optName = opt.optionName || '';
      const optHashHex = crypto.createHash('sha256').update(optName).digest('hex');
      if (optHashHex === selectedHashHex) {
        selectedOptionNames.push(optName);
      }
    }
  }

  // 5) Telefon numarasını çöz ve veritabanına kaydet / güncelle / sil
  const activeVoterJid = successfulVoterJid || voterJid;
  const voterPhone = await getPhoneNumberFromJid(activeVoterJid, pollMsg.key?.remoteJid || DEFAULT_GROUP_ID);
  const rawLid = (activeVoterJid || '').split('@')[0].split(':')[0];
  const pushName = pollUpdateMsg.pushName || pollUpdateMsg.verifiedBizName || (isFromMe ? (sock?.user?.name || 'Kendi Oyunuz') : null);

  console.log(`✅ [Deşifre Başarılı] Telefon: ${voterPhone} (JID: ${activeVoterJid}) → Seçimler:`, selectedOptionNames);

  await saveVote({
    pollId: pollMsgId,
    voterJid: voterPhone,
    voterPhone: voterPhone,
    rawLid: rawLid,
    pushName: pushName,
    selectedOptions: selectedOptionNames,
    updatedAt: getTRDateString()
  });

  if (selectedOptionNames.length > 0) {
    console.log(`💾 Oy DB'ye kaydedildi! (${voterPhone} -> ${selectedOptionNames.join(', ')})`);
  } else {
    console.log(`🗑️ Oy geri çekildi, DB güncellendi (boş dizi)! (${voterPhone} -> [])`);
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
  targetGroup: {
    id: DEFAULT_GROUP_ID,
    name: null
  },
  lastPollSentAt: null,
  lastError: null
};

async function fetchTargetGroupInfo() {
  if (!sock || state.status !== 'READY' || !DEFAULT_GROUP_ID) return;
  try {
    const meta = await sock.groupMetadata(DEFAULT_GROUP_ID);
    if (meta && meta.subject) {
      state.targetGroup.name = meta.subject;
      console.log(`🎯 Hedef Grup Bilgisi Alındı: "${meta.subject}" (${DEFAULT_GROUP_ID})`);
    }
  } catch (e) { }
}

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
  console.log('🚀 WhatsApp Baileys istemcisi başlatılıyor (Chrome gerektirmez)...');

  try {
    await loadBaileys();

    const { state: authState, saveCreds } = await useMultiFileAuthState(BAILEYS_AUTH_PATH);
    const { version } = await fetchLatestWaWebVersion().catch(() => ({ version: [2, 3000, 1015901307] }));

    sock = makeWASocket({
      version,
      auth: authState,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: Browsers ? Browsers.ubuntu('Chrome') : ['Ubuntu', 'Chrome', '20.0.04'],
      getMessage: async (key) => {
        // 1) Önce bellekte ara
        const msg = messageStore.get(key.id);
        if (msg?.message) return msg.message;

        // 2) Bellekte yoksa MongoDB'den yükle (bot yeniden başlatılmışsa)
        if (isDBEnabled() && getDB()) {
          try {
            const poll = await getDB().collection('polls').findOne({ pollId: key.id });
            if (poll?.messageData) {
              const decoded = deserializePollMessage(poll.messageData);
              if (decoded) {
                messageStore.set(key.id, { message: decoded });
                // console.log(`📦 getMessage: Mesaj MongoDB'den yüklendi ve cache'lendi (${key.id})`);
                return decoded;
              }
            }
          } catch (e) { }
        }

        // console.log(`⚠️ getMessage: Mesaj bulunamadı (${key.id}) – Store: ${messageStore.size}`);
        return undefined;
      }
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
        
        // Botun kendi LID -> Telefon numarası eşleşmesini önbelleğe kaydet
        if (sock.user?.id && sock.user?.lid) {
          const myPhoneJid = jidNormalizedUser ? jidNormalizedUser(sock.user.id) : sock.user.id;
          const myLidJid = jidNormalizedUser ? jidNormalizedUser(sock.user.lid) : sock.user.lid;
          const myBareLid = myLidJid.split('@')[0].split(':')[0];
          lidToPhoneMap.set(myLidJid, myPhoneJid);
          lidToPhoneMap.set(myBareLid, myPhoneJid);
        }

        fetchTargetGroupInfo();
        updateLidPhoneMapFromGroups();
        try {
          fs.writeFileSync(AUTH_FILE, JSON.stringify(state.userInfo, null, 2), 'utf-8');
        } catch (e) { }
      }
    });

    sock.ev.on('contacts.upsert', (contacts) => {
      for (const c of contacts) {
        processParticipantOrContact(c);
      }
    });

    // ================================================================
    // ANKET MESAJLARINI YAKALAMA & OY TAKİBİ (messages.upsert)
    // ================================================================
    sock.ev.on('messages.upsert', async ({ messages: msgs, type }) => {
      for (const msg of msgs) {
        // 1) Anket oluşturma mesajlarını store'a kaydet + DB'ye messageData yaz
        const pollCreation = msg.message?.pollCreationMessage || msg.message?.pollCreationMessageV3;
        if (pollCreation && msg.key?.id) {
          messageStore.set(msg.key.id, msg);
          // console.log(`📋 Anket mesajı store'a kaydedildi: ${msg.key.id}`);

          // Mesajı MongoDB'ye kalıcı kaydet (bot yeniden başlatıldığında kaybolmaması için)
          if (isDBEnabled() && getDB()) {
            const serialized = serializePollMessage(msg.message);
            if (serialized) {
              try {
                await getDB().collection('polls').updateOne(
                  { pollId: msg.key.id },
                  { $set: { messageData: serialized } },
                  { upsert: false }
                );
              } catch (e) { }
            }
          }
        }

        // 2) Oy güncelleme mesajlarını yakala (pollUpdateMessage)
        if (msg.message?.pollUpdateMessage && isDBEnabled()) {
          await processPollVoteUpdate(msg);
        }
      }
    });

    // ================================================================
    // ANKET OY TAKİBİ – YEDEK YOL (messages.update → pollUpdates)
    // ================================================================
    sock.ev.on('messages.update', async (updates) => {
      if (!isDBEnabled()) return;

      for (const item of updates) {
        const key = item.key;
        const pollUpdates = item.update?.pollUpdates || item.pollUpdates;

        if (!pollUpdates || pollUpdates.length === 0) continue;

        // console.log(`🗳️ [update] Poll güncelleme geldi → Anket: ${key.id}, ${pollUpdates.length} güncelleme`);

        try {
          const pollMsg = messageStore.get(key.id);
          if (!pollMsg) {
            console.warn(`⚠️ [update] Anket mesajı store'da bulunamadı: ${key.id}`);
            continue;
          }

          const aggregatedVotes = getAggregateVotesInPollMessage({
            message: pollMsg.message,
            pollUpdates: pollUpdates
          });

          if (!aggregatedVotes || aggregatedVotes.length === 0) continue;

          const allCurrentVoters = new Set();

          for (const optionResult of aggregatedVotes) {
            const optionName = optionResult.name;
            const voters = optionResult.voters || [];

            for (const voterJid of voters) {
              const voterPhone = await getPhoneNumberFromJid(voterJid, key.id);
              const rawLid = (voterJid || '').split('@')[0].split(':')[0];
              allCurrentVoters.add(voterPhone);
              await saveVote({
                pollId: key.id,
                voterJid: voterPhone,
                voterPhone: voterPhone,
                rawLid: rawLid,
                selectedOptions: [optionName],
                updatedAt: getTRDateString()
              });
            }
          }

          // Oy çekme tespiti (dokümanı silmek yerine selectedOptions: [] olarak güncelle)
          const db = getDB();
          if (db) {
            const existingVotes = await db.collection('poll_votes')
              .find({ pollId: key.id }).toArray();
            for (const existingVote of existingVotes) {
              if (!allCurrentVoters.has(existingVote.voterJid) && existingVote.selectedOptions?.length > 0) {
                await saveVote({
                  pollId: key.id,
                  voterJid: existingVote.voterJid,
                  voterPhone: existingVote.voterPhone || existingVote.voterJid,
                  pushName: existingVote.pushName,
                  selectedOptions: [],
                  updatedAt: getTRDateString()
                });
              }
            }
          }
          // console.log(`✅ [update] Oy işlendi → ${allCurrentVoters.size} aktif oy veren`);
        } catch (err) {
          console.error('❌ [update] Anket oy işleme hatası:', err.message);
        }
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
  const targetGroupId = options.groupId || DEFAULT_GROUP_ID;
  const pollTitleCustom = options.pollTitleCustom || null;

  if (!hasValidGroupId() && !options.groupId) {
    return {
      success: false,
      status: state.status,
      message: '.env dosyasında WHATSAPP_GROUP_ID tanımlanmamış! Lütfen önce paneldeki "Gruplar & JID Listesini Göster" butonuna tıklayıp grup JID kodunu kopyalayın ve .env dosyanıza kaydedin.'
    };
  }

  if (!sock || state.status !== 'READY') {
    return {
      success: false,
      status: state.status,
      message: 'WhatsApp istemcisi bağlı veya hazır değil! Lütfen önce QR kodu veya eşleşme kodunu okutun.'
    };
  }

  // DB'den dinamik anket şablonunu ve seçeneklerini yükle
  const config = await getPollConfig();
  const rawTitle = pollTitleCustom || config.titleTemplate || '{{date}}';
  const pollTitle = getDailyPollTitle(rawTitle);
  const pollOptions = (config.options && Array.isArray(config.options) && config.options.length > 0)
    ? config.options
    : DEFAULT_POLL_OPTIONS;

  try {
    const sent = await sock.sendMessage(targetGroupId, {
      poll: {
        name: pollTitle,
        values: pollOptions,
        selectableCount: 1
      }
    });

    const messageId = sent?.key?.id || 'GÖNDERİLDİ';
    state.lastPollSentAt = getTRDateString();
    // console.log(`🗳️ Baileys WhatsApp Anketi gönderildi (${pollTitle}) [Grup: ${targetGroupId}] -> MsgId: ${messageId}`);

    // Anket mesajını store'a kaydet (oy şifre çözümü için)
    if (sent) {
      messageStore.set(messageId, sent);
    }

    // Anketi veritabanına kaydet (DB aktifse)
    if (isDBEnabled()) {
      await savePoll({
        pollId: messageId,
        groupId: targetGroupId,
        title: pollTitle,
        options: pollOptions,
        messageData: serializePollMessage(sent?.message),
        createdAt: getTRDateString()
      });
    }

    return {
      success: true,
      messageId,
      pollTitle,
      groupId: targetGroupId,
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

// ============================================================================
// RASTGELE CÜMLE GÖNDERİMİ (Ayetler, Dualar, Hadisler, Hatırlatmalar, Vecizeler)
// ============================================================================

async function sendWhatsAppSentence(options = {}) {
  const targetGroupId = options.groupId || DEFAULT_GROUP_ID;

  if (!hasValidGroupId() && !options.groupId) {
    return {
      success: false,
      status: state.status,
      message: '.env dosyasında WHATSAPP_GROUP_ID tanımlanmamış!'
    };
  }

  if (!sock || state.status !== 'READY') {
    return {
      success: false,
      status: state.status,
      message: 'WhatsApp istemcisi bağlı veya hazır değil!'
    };
  }

  if (!isDBEnabled()) {
    return {
      success: false,
      message: 'Veritabanı bağlantısı aktif değil. Cümle gönderilemedi.'
    };
  }

  try {
    const result = await getRandomSentence();
    if (!result || !result.sentence) {
      return {
        success: false,
        message: 'Veritabanından rastgele cümle çekilemedi.'
      };
    }

    // Mesajı formatla
    const messageText = `${result.label}\n\n${result.sentence}`;

    await sock.sendMessage(targetGroupId, { text: messageText });

    const sentAt = getTRDateString();
    console.log(`✅ [Cümle Gönderildi] ${result.label} → "${result.sentence.substring(0, 60)}..." [Grup: ${targetGroupId}]`);

    return {
      success: true,
      sentAt,
      collection: result.collection,
      label: result.label,
      sentence: result.sentence,
      groupId: targetGroupId
    };
  } catch (err) {
    console.error('❌ WhatsApp Cümle Gönderme Hatası:', err);
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

/**
 * Her Salı ve Perşembe saat 22:30 TSİ'de rastgele cümle gönderir.
 * Cron: dakika=30, saat=22, gün=*, ay=*, haftanın günü=2,4 (Salı, Perşembe)
 */
function scheduleSentenceJob() {
  const job = schedule.scheduleJob({ rule: '30 22 * * 2,4', tz: 'Europe/Istanbul' }, async () => {
    const zaman = new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
    console.log(`\n[ZAMANLAYICI - ${zaman}] Rastgele cümle gönderimi başlatılıyor...`);
    try {
      const res = await sendWhatsAppSentence();
      console.log(`[ZAMANLAYICI] Cümle Gönderim Sonucu:`, res);
    } catch (error) {
      console.error(`[ZAMANLAYICI] Cümle Gönderim Hatası:`, error);
    }
  });
  console.log("✅ Cümle Zamanlayıcısı Kuruldu: Her Salı ve Perşembe saat 22:30 (TSİ)");
  return job;
}

function getWhatsAppStatus(autoStartIfDisconnected = false) {
  if (autoStartIfDisconnected && (state.status === 'DISCONNECTED' || state.status === 'ERROR') && !sock) {
    initWhatsAppClient(false);
  }

  if (sock && state.status === 'READY' && hasValidGroupId() && !state.targetGroup.name) {
    fetchTargetGroupInfo();
  }

  return {
    status: state.status,
    qrDataUrl: state.qrDataUrl,
    userInfo: state.userInfo,
    targetGroup: {
      id: DEFAULT_GROUP_ID || null,
      name: state.targetGroup.name || null
    },
    lastPollSentAt: state.lastPollSentAt,
    lastError: state.lastError,
    engine: 'Baileys Engine'
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

// MongoDB bağlantısını kur, ardından WhatsApp istemcisini başlat
(async () => {
  try {
    await connectDB();
  } catch (dbErr) {
    console.error('⚠️ MongoDB başlatılırken hata:', dbErr.message);
  }

  try {
    initWhatsAppClient(true);
    scheduleWhatsAppPollJob();
    scheduleSentenceJob();
  } catch (wpInitErr) {
    console.error("⚠️ WhatsApp servisi başlatılırken hata:", wpInitErr.message);
  }
})();

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

// Manuel Cümle Gönderme Endpoint'i (Test amaçlı)
app.all(['/api/send-sentence', '/api/run-sentence'], async (req, res) => {
  try {
    const groupId = req.query.groupId || req.body?.groupId;
    const result = await sendWhatsAppSentence({ groupId });
    res.json(result);
  } catch (error) {
    console.error('WhatsApp manuel cümle gönderim hatası:', error);
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

// ============================================================================
// ANKET ŞABLONU & AYARLARI API ENDPOINT'LERİ
// ============================================================================

// Anket şablon ayarlarını getir
app.get('/api/poll-config', async (req, res) => {
  try {
    const config = await getPollConfig();
    res.json({ success: true, config, dbEnabled: isDBEnabled() });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Anket şablon ayarlarını kaydet / güncelle
app.post('/api/poll-config', async (req, res) => {
  try {
    const { titleTemplate, options } = req.body;
    const result = await savePollConfig({ titleTemplate, options });
    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// ANKET VERİTABANI API ENDPOINT'LERİ
// ============================================================================

// Tüm anketleri listele
app.get('/api/polls', async (req, res) => {
  if (!isDBEnabled() || !getDB()) {
    return res.json({ success: false, message: 'Veritabanı bağlantısı aktif değil.' });
  }
  try {
    const polls = await getDB().collection('polls')
      .find({})
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray();

    const formattedPolls = polls.map(p => ({
      ...p,
      createdAt: p.createdAt ? getTRDateString(p.createdAt) : p.createdAt
    }));

    res.json({ success: true, count: formattedPolls.length, polls: formattedPolls });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Belirli bir ankete ait tüm oyları getir
app.get('/api/poll-votes/:pollId', async (req, res) => {
  if (!isDBEnabled() || !getDB()) {
    return res.json({ success: false, message: 'Veritabanı bağlantısı aktif değil.' });
  }
  try {
    const { pollId } = req.params;
    const votes = await getDB().collection('poll_votes')
      .find({ pollId })
      .sort({ updatedAt: -1 })
      .toArray();

    // İlgili anketi de getir
    const poll = await getDB().collection('polls').findOne({ pollId });
    if (poll && poll.createdAt) {
      poll.createdAt = getTRDateString(poll.createdAt);
    }

    const formattedVotes = votes.map(v => ({
      ...v,
      updatedAt: v.updatedAt ? getTRDateString(v.updatedAt) : v.updatedAt
    }));

    res.json({
      success: true,
      poll: poll || null,
      voteCount: formattedVotes.length,
      votes: formattedVotes
    });
  } catch (error) {
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