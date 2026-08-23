const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const schedule = require('node-schedule');
const pino = require('pino');
const QRCode = require('qrcode');
require('dotenv').config();
const { connectDB, isDBEnabled, getDB, savePoll, saveVote, saveTextVote, removeVote, deletePoll, getTRDateString, getLogicalReadingDate, getPollConfig, savePollConfig, saveLidMapping, getAllLidMappings, deleteLidMappingsByConfigKey, getReadingGroups, getRandomSentence, calculateReadingStreaks, getMonthlyReadingAmountTotal, getPendingCongratulations, completeCongratulation } = require('./db');
const { generateWeeklyTableCanvas } = require('./weeklyTableImage');

// ============================================================================
// LOG FİLTRESİ VE HATA YÖNETİMİ (Libsignal / Bad MAC / Noise Gürültüsünü Engelleme)
// ============================================================================
const originalStderrWrite = process.stderr.write;
process.stderr.write = function (chunk, encoding, callback) {
  const str = chunk.toString();
  if (
    str.includes('MAC Error: Bad MAC') ||
    str.includes('SessionCipher') ||
    str.includes('Closing open session') ||
    str.includes('Closing session') ||
    str.includes('SessionEntry') ||
    str.includes('verifyMAC') ||
    str.includes('doDecryptWhisperMessage') ||
    str.includes('Failed to decrypt message')
  ) {
    return true; // Gürültülü libsignal dahili şifreleme hatalarını konsoldan gizle
  }
  return originalStderrWrite.apply(process.stderr, arguments);
};

const originalStdoutWrite = process.stdout.write;
process.stdout.write = function (chunk, encoding, callback) {
  const str = chunk.toString();
  if (
    str.includes('Closing open session') ||
    str.includes('Closing session') ||
    str.includes('SessionEntry') ||
    str.includes('SessionCipher') ||
    str.includes('MAC Error: Bad MAC')
  ) {
    return true; // Gürültülü libsignal dahili oturum kapatma loglarını konsoldan gizle
  }
  return originalStdoutWrite.apply(process.stdout, arguments);
};

/**
 * Ephemeral (Süreli), ViewOnce veya Document ile sarmalanmış ham mesaj içeriğini çıkarır.
 */
function getRawMessage(msgObj) {
  if (!msgObj) return null;
  let m = msgObj.message || msgObj;
  while (m?.ephemeralMessage?.message || m?.viewOnceMessage?.message || m?.viewOnceMessageV2?.message || m?.documentWithCaptionMessage?.message) {
    m = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m.viewOnceMessageV2?.message || m.documentWithCaptionMessage?.message;
  }
  return m;
}


let noiseErrorCounter = 0;
let lastNoiseErrorTime = 0;

function handleNoiseError(errMessage) {
  const now = Date.now();
  if (now - lastNoiseErrorTime > 60000) {
    noiseErrorCounter = 0;
  }
  lastNoiseErrorTime = now;
  noiseErrorCounter++;

  console.warn(`⚠️ Baileys Noise/GCM deşifre hatası (${noiseErrorCounter}/5):`, errMessage);

  if (noiseErrorCounter >= 5) {
    noiseErrorCounter = 0;
    console.error('🔄 Üst üste Noise deşifre hatası alındı (Socket zombi durumunda). WhatsApp bağlantısı otomatik yenileniyor...');
    if (sock) {
      try {
        sock.end(new Error('Noise Decryption Failure Auto-Reconnect'));
      } catch (e) { }
    }
  }
}

// Baileys Noise/GCM şifre çözme hatalarının Node.js sürecini çökertmesini önleme
process.on('uncaughtException', (err) => {
  const errStr = err?.stack || err?.message || String(err);
  if (
    errStr.includes('Unsupported state or unable to authenticate data') ||
    errStr.includes('Bad MAC') ||
    errStr.includes('noise-handler') ||
    errStr.includes('SessionCipher')
  ) {
    handleNoiseError(err.message || String(err));
    return;
  }
  console.error('💥 Yakalanmamış İstisna (Uncaught Exception):', err);
});

process.on('unhandledRejection', (reason) => {
  const errStr = reason?.stack || reason?.message || String(reason);
  if (
    errStr.includes('Unsupported state or unable to authenticate data') ||
    errStr.includes('Bad MAC') ||
    errStr.includes('noise-handler') ||
    errStr.includes('SessionCipher')
  ) {
    handleNoiseError(reason?.message || String(reason));
    return;
  }
  console.error('💥 Yakalanmamış Söz (Unhandled Rejection):', reason);
});


// ============================================================================
// KONFİGÜRASYON VE SABİTLER
// ============================================================================

async function getTargetGroupId() {
  if (isDBEnabled() && getDB()) {
    try {
      const config = await getPollConfig();
      if (config && config.groupId && typeof config.groupId === 'string' && config.groupId.trim() !== '') {
        return config.groupId.trim();
      }
    } catch (e) { }
  }
  return null;
}

async function getTargetReadingGroupId() {
  if (isDBEnabled() && getDB()) {
    try {
      const config = await getPollConfig();
      if (config && config.readingGroupId && typeof config.readingGroupId === 'string' && config.readingGroupId.trim() !== '') {
        return config.readingGroupId.trim();
      }
    } catch (e) { }
  }
  return null;
}

function checkRequiredEnvVars() {
  const missing = [];
  if (!process.env.CONFIG_KEY || process.env.CONFIG_KEY.trim() === '') missing.push('CONFIG_KEY');
  if (!process.env.MONGO_URI || process.env.MONGO_URI.trim() === '') missing.push('MONGO_URI');
  if (!process.env.DB_NAME || process.env.DB_NAME.trim() === '') missing.push('DB_NAME');
  return missing;
}

async function hasValidGroupId() {
  if (checkRequiredEnvVars().length > 0) return false;
  const targetId = await getTargetGroupId();
  return !!(targetId && targetId.trim() !== '' && !targetId.includes('1234567890') && !targetId.includes('mygroupid34'));
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

const reminderAlternatives = [
  "Okumalarımıza düzenli devam edebilmek dileğiyle 🌿",
  "Okuma alışkanlığımızı birlikte güçlendirelim inşaAllah 📖",
  "Küçük adımlar, büyük alışkanlıklar oluşturur. Takipteyiz! 📘",
  "Bu hatırlatma bir vesile olsun, kaldığımız yerden devam edelim 🔄",
  "Düzenli okumalarla bereketli bir sürece birlikte yürüyelim 🌱",
  "İstikrar güzeldir; eksiklerimizi birlikte tamamlayalım 🤝",
  "Okuyanlara tebrikler, henüz okumayanlara nazik bir davet 😊",
  "İstikrarın güzelliğini hep birlikte yaşayalım 🌟",
  "Daha okumasını tamamlamayanlar için nazik bir hatırlatma 📖",
  "Okumalarımıza birlikte devam edebilmek duasıyla 🤲",
  "Birlikte ilerlemek, devam etmenin en güzel hali 👣",
  "Okumalarımıza sadakatle devam edelim inşaAllah 🕊️",
  "Her gün bir satır da olsa, devam edelim ✍️",
  "İstikrarla yürüdüğümüz bu yolda hep birlikteyiz 🛤️",
  "Bu küçük hatırlatma, güzel bir başlangıç olsun 🌸",
  "Unutmak kolay, alışkanlık ise emek ister. Devam edelim 💪",
  "Güzel alışkanlıklar birlikte inşa edilir 🍃",
  "Okuma yolculuğumuza birlikte güç katalım 🚀",
  "Birlikte tamamlanan okumalarda bereket vardır 🧡",
  "Düzenli okumalarla kalplerimizi diri tutalım ❤️🔥",
  "Hatırlatmak bizden, gayret sizden 🙏",
  "Okumaları unutmayalım 🔔",
  "İstikrarlı adımlar en kalıcı olanlardır ⏳",
  "Okuma halkamızın bir parçası olmaya ne dersiniz? 💫",
  "Birlikte okumak, yalnız okumaktan daha değerlidir 🤝",
  "Okudukça zihin açılır, gönül ferahlar ☀️",
  "İstikrarlı olan kazanır; bugünü de boş geçmeyelim ⏰",
  "Birlikte okumak, birlikte güçlenmektir 💪",
  "Bugün okumaya vakit ayırmak, kendine bir iyiliktir 💝",
  "Okuma halkamızda siz de yerinizi alın 🤗",
  "Bir satır da bugün için, alışkanlık zincirini kırma 🔗",
  "Okumak, gönlü besleyen en güzel alışkanlıktır 🌾",
  "Okuma yolculuğumuzda mola değil, devam zamanı 🔄",
  "Zinciri kırmayalım, okumaya devam 🔗",
  "Az da olsa devamlı okuyalım 💧",
  "Kaldığımız yerden aynı şevkle devam! 🚀",
  "Birkaç satır da olsa okuyalım 📖",
  "Birlikte okuyor, birlikte güzelleşiyoruz 🌱",
  "Ruhumuza kısa bir okuma molası ☕",
  "Günün yoğunluğuna kısa bir okuma arası ☕",
  "Günün bereketini okumayla yakalayalım ☀️",
  "Okuma saatimiz geldi, sizleri de aramızda görmek isteriz ⏰",
  "Günü kapatmadan okumalarımızı tamamlayalım ⌛",
  "Küçük bir gayret, büyük bereket 🌾",
  "Kitaplar bizi bekler, hadi okumaya 📚",
  "Gönlümüze iyi gelecek satırlara dönelim 🕊️",
  "Okuma kervanımız yola devam ediyor 🛤️",
  "Okumalarımızı tamamlayıp güne huzur katalım 🍂"
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
let initAuthCreds = null;
let BufferJSON = null;
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
    initAuthCreds = baileys.initAuthCreds;
    BufferJSON = baileys.BufferJSON;
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
    const configKey = process.env.CONFIG_KEY ? process.env.CONFIG_KEY.trim() : undefined;
    saveLidMapping(bareLid, barePhone, configKey);
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
    const configKey = process.env.CONFIG_KEY ? process.env.CONFIG_KEY.trim() : undefined;
    const dbMap = await getAllLidMappings(configKey);
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
async function getPhoneNumberFromJid(jid, groupId = null) {
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

  // Oy tespiti özelliği pasifse oyları işleme
  const _voteConfig = await getPollConfig();
  if (_voteConfig?.features?.voteTrackingEnabled === false) return;

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

  // 1) Bu anket veritabanımızda (polls koleksiyonunda) kayıtlı mı ve bu bota (configKey) ait mi kontrol et
  const myConfigKey = process.env.CONFIG_KEY ? process.env.CONFIG_KEY.trim() : null;
  let pollDoc = null;
  if (getDB()) {
    try {
      pollDoc = await getDB().collection('polls').findOne({ pollId: pollMsgId });
    } catch (e) {
      console.error('⚠️ DB anket okuma hatası:', e.message);
    }
  }

  // Veritabanında (polls koleksiyonunda) kayıtlı olmayan yabancı/harici anketlerin oylarını KESİNLİKLE işleme ve kaydetme!
  if (!pollDoc) {
    return;
  }

  // Bu anket başka bir configKey'e ait mi? (Projeyi paylaşan diğer botların anketlerine karışmamak için)
  if (myConfigKey && pollDoc.configKey && pollDoc.configKey !== myConfigKey) {
    return;
  }

  // 2) Orijinal anket mesajını bul (memory veya MongoDB messageData)
  let pollMsg = messageStore.get(pollMsgId);
  if (!pollMsg && pollDoc?.messageData) {
    const decoded = deserializePollMessage(pollDoc.messageData);
    if (decoded) {
      pollMsg = { message: decoded, key: { id: pollMsgId, remoteJid: pollDoc.groupId, fromMe: true } };
      messageStore.set(pollMsgId, pollMsg);
    }
  }

  if (!pollMsg || !pollMsg.message) {
    console.warn(`⚠️ Orijinal anket mesajı bulunamadı (${pollMsgId}), oy çözülemedi.`);
    return;
  }

  // 2) Anket detaylarını ve şifreleme anahtarını (messageSecret) al
  const rawMsg = getRawMessage(pollMsg);
  const pollCreation = rawMsg?.pollCreationMessage ||
    rawMsg?.pollCreationMessageV2 ||
    rawMsg?.pollCreationMessageV3;

  const pollEncKey = pollMsg.message?.messageContextInfo?.messageSecret ||
    rawMsg?.messageContextInfo?.messageSecret ||
    pollCreation?.messageSecret;
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
    pollMsg.message?.messageContextInfo?.messageSecret,
    rawMsg?.messageContextInfo?.messageSecret
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
        selectedOptionNames.push(normalizePollOptionLabel(optName));
      }
    }
  }

  // 5) Telefon numarasını çöz ve veritabanına kaydet / güncelle / sil
  const activeVoterJid = successfulVoterJid || voterJid;
  const currentGroupId = pollMsg.key?.remoteJid || (await getTargetGroupId());
  const voterPhone = await getPhoneNumberFromJid(activeVoterJid, currentGroupId);
  const rawLid = (activeVoterJid || '').split('@')[0].split(':')[0];
  const pushName = pollUpdateMsg.pushName || pollUpdateMsg.verifiedBizName || (isFromMe ? (sock?.user?.name || 'Kendi Oyunuz') : null);

  console.log(`✅ [Deşifre Başarılı] Telefon: ${voterPhone} (JID: ${activeVoterJid}) → Seçimler:`, selectedOptionNames);

  const currentReadingGroupId = await getTargetReadingGroupId();
  const configKey = process.env.CONFIG_KEY ? process.env.CONFIG_KEY.trim() : null;

  await saveVote({
    pollId: pollMsgId,
    voterJid: voterPhone,
    voterPhone: voterPhone,
    rawLid: rawLid,
    pushName: pushName,
    selectedOptions: selectedOptionNames,
    readingGroupId: currentReadingGroupId,
    configKey: configKey,
    updatedAt: getTRDateString()
  });

  if (selectedOptionNames.length > 0) {
    console.log(`💾 Oy DB'ye kaydedildi! (${voterPhone} -> ${selectedOptionNames.join(', ')})`);
  } else {
    console.log(`🗑️ Oy geri çekildi, DB güncellendi (boş dizi)! (${voterPhone} -> [])`);
  }
}

/** Metin okuma: "20" | "20 sayfa" | "0" | "iptal" | "dün 15 sayfa" vb. */
const READING_MESSAGE_REGEX = /^(dün\s+)?(\d+)(?:\s+(?:sayfa|syf|dk|dakika))?$/;
const READING_CANCEL_REGEX = /^(dün\s+)?iptal$/;

/**
 * Anket seçenek metnini kayda hazırlar.
 * Başta sayı varsa sadece sayı ("5 sayfa" → "5"), yoksa metnin kendisi ("okumadım").
 */
function normalizePollOptionLabel(optionName) {
  if (optionName == null) return optionName;
  const trimmed = String(optionName).trim();
  const match = trimmed.match(/^(\d+)/);
  return match ? match[1] : trimmed;
}

/**
 * Türkçe büyük/küçük harf: İ→i, I→ı (tr-TR).
 * Anahtar kelime eşleşmesi için ı→i (IPTAL ve İPTAL ikisi de "iptal" olur).
 */
function normalizeReadingText(rawText) {
  return String(rawText)
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('tr-TR')
    .replace(/ı/g, 'i')
    .replace(/\u0307/g, ''); // olası combining-dot artığı
}

/**
 * Metin gövdesini normalize eder.
 * Geçerliyse { pages, isYesterday, clear } döner.
 * clear=true veya pages==="0" → text_votes'ta selectedOptions: []
 */
function parseReadingMessage(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;
  const normalized = normalizeReadingText(rawText);

  const cancelMatch = normalized.match(READING_CANCEL_REGEX);
  if (cancelMatch) {
    return { pages: '0', isYesterday: Boolean(cancelMatch[1]), clear: true };
  }

  const match = normalized.match(READING_MESSAGE_REGEX);
  if (!match) return null;
  const pages = match[2];
  return {
    pages,
    isYesterday: Boolean(match[1]),
    clear: pages === '0'
  };
}

/**
 * Hedef gruptaki metin mesajlarından sayfa okuma bilgisini yakalar,
 * text_votes'a kaydeder ve başarılıysa ✔️ reaction bırakır.
 */
async function processReadingMessage(msg) {
  if (!isDBEnabled() || !sock) return;

  const _cfg = await getPollConfig();
  if (_cfg?.features?.messageReadingEnabled === false) return;

  const incomingGroupId = msg.key?.remoteJid;
  const targetGroupId = await getTargetGroupId();
  if (!incomingGroupId || !targetGroupId || incomingGroupId !== targetGroupId) return;

  const rawMsg = getRawMessage(msg);
  const text =
    rawMsg?.conversation ||
    rawMsg?.extendedTextMessage?.text ||
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    null;
  if (!text) return;

  const parsed = parseReadingMessage(text);
  if (!parsed) return;

  const participantJid = msg.key?.participant || msg.participant || msg.key?.remoteJid;
  const rawLid = participantJid ? (jidNormalizedUser ? jidNormalizedUser(participantJid) : participantJid).split('@')[0].split(':')[0] : null;
  const voterPhone = await getPhoneNumberFromJid(participantJid, incomingGroupId);
  if (!voterPhone) return;

  const configKey = process.env.CONFIG_KEY ? process.env.CONFIG_KEY.trim() : null;
  const readingGroupId = await getTargetReadingGroupId();
  const date = getLogicalReadingDate(msg.messageTimestamp, parsed.isYesterday);
  const selectedOptions = parsed.clear ? [] : [parsed.pages];

  const result = await saveTextVote({
    voterJid: voterPhone,
    voterPhone,
    rawLid: rawLid && rawLid !== voterPhone ? rawLid : undefined,
    selectedOptions,
    pushName: msg.pushName || undefined,
    readingGroupId,
    configKey,
    date,
    updatedAt: getTRDateString()
  });

  if (!result) return;

  try {
    await sock.sendMessage(incomingGroupId, {
      react: { text: '✔️', key: msg.key }
    });
  } catch (reactErr) {
    console.error('⚠️ Okuma mesajı reaction hatası:', reactErr.message);
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
    id: null,
    name: null
  },
  lastPollSentAt: null,
  lastError: null
};

async function fetchTargetGroupInfo() {
  const targetId = await getTargetGroupId();
  if (!sock || state.status !== 'READY' || !targetId) return;
  try {
    state.targetGroup.id = targetId;
    const meta = await sock.groupMetadata(targetId);
    if (meta && meta.subject) {
      state.targetGroup.name = meta.subject;
      console.log(`🎯 Hedef Grup Bilgisi Alındı: "${meta.subject}" (${targetId})`);
    }
  } catch (e) { }
}

/**
 * MongoDB tabanlı Baileys Auth State
 * (Render vb. uçucu/ephemeral sunucularda oturum dosyalarının ve E2EE şifreleme anahtarlarının kaybolmasını önler)
 */
async function useMongoDBAuthState(db, collectionName = 'baileys_auth') {
  const collection = db.collection(collectionName);

  const writeData = async (data, id) => {
    try {
      const serialized = JSON.stringify(data, BufferJSON ? BufferJSON.replacer : undefined);
      await collection.updateOne(
        { _id: id },
        { $set: { value: serialized, updatedAt: new Date() } },
        { upsert: true }
      );
    } catch (err) {
      console.error(`⚠️ MongoDB Auth verisi yazılamadı (${id}):`, err.message);
    }
  };

  const readData = async (id) => {
    try {
      const doc = await collection.findOne({ _id: id });
      if (doc && doc.value) {
        return JSON.parse(doc.value, BufferJSON ? BufferJSON.reviver : undefined);
      }
    } catch (err) {
      console.error(`⚠️ MongoDB Auth verisi okunamadı (${id}):`, err.message);
    }
    return null;
  };

  const removeData = async (id) => {
    try {
      await collection.deleteOne({ _id: id });
    } catch (err) {
      console.error(`⚠️ MongoDB Auth verisi silinemedi (${id}):`, err.message);
    }
  };

  let creds = await readData('creds');

  // Mongo'da creds bulunamadıysa ama yerel diskte oturum dosyaları varsa, otomatik Mongo'ya taşı
  if (!creds && fs.existsSync(BAILEYS_AUTH_PATH)) {
    try {
      const files = fs.readdirSync(BAILEYS_AUTH_PATH);
      const jsonFiles = files.filter(f => f.endsWith('.json'));
      if (jsonFiles.length > 0) {
        console.log(`📦 ${jsonFiles.length} adet yerel oturum dosyası MongoDB veritabanına taşınıyor...`);
        for (const file of jsonFiles) {
          const filePath = path.join(BAILEYS_AUTH_PATH, file);
          const content = fs.readFileSync(filePath, 'utf-8');
          const parsed = JSON.parse(content, BufferJSON ? BufferJSON.reviver : undefined);
          const id = file === 'creds.json' ? 'creds' : file.replace('.json', '');
          await writeData(parsed, id);
        }
        creds = await readData('creds');
        console.log('✅ Yerel oturum dosyaları başarıyla MongoDB\'ye aktarıldı!');
      }
    } catch (e) {
      console.warn('⚠️ Yerel oturum aktarımı uyarısı:', e.message);
    }
  }

  if (!creds && initAuthCreds) {
    creds = initAuthCreds();
  }

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === 'app-state-sync-key' && value && proto) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              if (value) {
                tasks.push(writeData(value, key));
              } else {
                tasks.push(removeData(key));
              }
            }
          }
          await Promise.all(tasks);
        }
      }
    },
    saveCreds: async () => {
      await writeData(creds, 'creds');
    }
  };
}

function getAuthCollectionName() {
  if (process.env.AUTH_COLLECTION) return process.env.AUTH_COLLECTION;
  const configKey = process.env.CONFIG_KEY ? process.env.CONFIG_KEY.trim() : 'default';
  return (process.env.RENDER === 'true' || process.env.NODE_ENV === 'production') ? `baileys_auth_${configKey}` : `baileys_auth_dev_${configKey}`;
}

function shouldUseMongoAuth() {
  if (!isDBEnabled() || !getDB()) return false;
  if (process.env.RENDER === 'true' || process.env.NODE_ENV === 'production' || process.env.USE_MONGO_AUTH === 'true') {
    return true;
  }
  return false;
}

async function hasExistingSession() {
  if (fs.existsSync(AUTH_FILE)) return true;
  if (shouldUseMongoAuth()) {
    try {
      const collName = getAuthCollectionName();
      const doc = await getDB().collection(collName).findOne({ _id: 'creds' });
      if (doc && doc.value) return true;
    } catch (e) { }
  }
  return false;
}

async function initWhatsAppClient(onlyIfSessionExists = false) {
  const missingEnvs = checkRequiredEnvVars();
  if (missingEnvs.length > 0) {
    console.log(`⚠️ Zorunlu çevre değişkenleri (.env) eksik: ${missingEnvs.join(', ')}. WhatsApp istemcisi başlatılamıyor.`);
    state.status = 'MISSING_ENV';
    state.lastError = `.env dosyanızda şu değişkenler eksik: ${missingEnvs.join(', ')}`;
    return null;
  }

  if (sock && (state.status === 'READY' || state.status === 'WAITING_FOR_QR' || state.status === 'INITIALIZING')) {
    return sock;
  }

  const existing = await hasExistingSession();
  if (onlyIfSessionExists && !existing) {
    console.log('ℹ️ WhatsApp oturumu bulunamadı. QR kod web adresi açıldığında üretilecek.');
    state.status = 'DISCONNECTED';
    return null;
  }

  state.status = 'INITIALIZING';
  state.lastError = null;
  console.log('🚀 WhatsApp Baileys istemcisi başlatılıyor (Chrome gerektirmez)...');

  try {
    await loadBaileys();

    let authState, saveCreds;
    if (shouldUseMongoAuth()) {
      const collectionName = getAuthCollectionName();
      console.log(`💾 MongoDB tabanlı WhatsApp oturum deposu aktif (Koleksiyon: ${collectionName})...`);
      const mongoAuth = await useMongoDBAuthState(getDB(), collectionName);
      authState = mongoAuth.state;
      saveCreds = mongoAuth.saveCreds;
    } else {
      console.log('📁 Yerel dosya tabanlı WhatsApp oturum deposu aktif.');
      const fileAuth = await useMultiFileAuthState(BAILEYS_AUTH_PATH);
      authState = fileAuth.state;
      saveCreds = fileAuth.saveCreds;
    }

    const { version } = await fetchLatestWaWebVersion().catch(() => ({ version: [2, 3000, 1015901307] }));

    sock = makeWASocket({
      version,
      auth: authState,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: Browsers ? Browsers.ubuntu('Chrome') : ['Ubuntu', 'Chrome', '20.0.04'],
      keepAliveIntervalMs: 30000,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      syncFullHistory: false,
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
          if (isDBEnabled() && getDB()) {
            try { await getDB().collection(getAuthCollectionName()).deleteMany({}); } catch (e) { }
            // Logout'ta bu configKey'e ait LID eşleşmelerini de temizle
            const configKey = process.env.CONFIG_KEY ? process.env.CONFIG_KEY.trim() : null;
            if (configKey) {
              await deleteLidMappingsByConfigKey(configKey);
              lidToPhoneMap.clear();
            }
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
        // 1) Anket oluşturma mesajlarını yakala
        const rawMsg = getRawMessage(msg);
        const pollCreation = rawMsg?.pollCreationMessage || rawMsg?.pollCreationMessageV2 || rawMsg?.pollCreationMessageV3;
        if (pollCreation && msg.key?.id) {
          // Mesajı MongoDB'ye kalıcı kaydet (bot yeniden başlatıldığında kaybolmaması için)
          if (isDBEnabled() && getDB()) {
            const serialized = serializePollMessage(msg.message);
            const isFromMe = msg.key?.fromMe === true;
            const incomingGroupId = msg.key?.remoteJid;
            const targetGroupId = await getTargetGroupId();

            // 1) Hedef gruptan gelmeyen (farklı gruplar/özel sohbetler) TÜM anketleri yoksay
            if (!incomingGroupId || !targetGroupId || incomingGroupId !== targetGroupId) {
              continue;
            }

            // 2) SADECE hedef grupta ve siz/bot (fromMe: true) tarafından gönderilen anketleri işle
            if (isFromMe) {
              messageStore.set(msg.key.id, msg);
              if (serialized) {
                try {
                  const existingPoll = await getDB().collection('polls').findOne({ pollId: msg.key.id });
                  if (existingPoll) {
                    // Bot tarafından API/Zamanlayıcı ile oluşturulmuş, sadece messageData güncelle
                    await savePoll({
                      pollId: msg.key.id,
                      groupId: existingPoll.groupId || incomingGroupId,
                      messageData: serialized,
                      createdAt: existingPoll.createdAt
                    });
                  } else {
                    // WhatsApp uygulamasından elle hedef gruba atılmış anket: tam doküman olarak kaydet
                    const configKey = process.env.CONFIG_KEY ? process.env.CONFIG_KEY.trim() : null;
                    const title = pollCreation.name || 'WhatsApp Anketi';
                    const options = (pollCreation.options || []).map(opt => opt.optionName || opt);

                    await savePoll({
                      pollId: msg.key.id,
                      groupId: incomingGroupId,
                      title: title,
                      options: options,
                      configKey: configKey,
                      messageData: serialized,
                      createdAt: new Date()
                    });
                    console.log(`🗳️ [Hedef Grup] WhatsApp'tan manuel gönderilen anket kaydedildi: "${title}" (PollId: ${msg.key.id})`);
                  }
                } catch (e) {
                  console.error('⚠️ Anket kaydetme/güncelleme hatası:', e.message);
                }
              }
            } else {
              // fromMe: false -> Başka bir üyenin attığı anket. Kesinlikle messageStore'a ve DB'ye kaydedilmez!
            }
          }
        }

        // 2) Oy güncelleme mesajlarını yakala (pollUpdateMessage)
        if (msg.message?.pollUpdateMessage && isDBEnabled()) {
          await processPollVoteUpdate(msg);
        }

        // 3) Metin okuma mesajlarını yakala (sayfa sayısı)
        if (isDBEnabled()) {
          await processReadingMessage(msg);
        }
      }
    });

    // ================================================================
    // ANKET OY TAKİBİ – YEDEK YOL (messages.update → pollUpdates)
    // ================================================================
    sock.ev.on('messages.update', async (updates) => {
      if (!isDBEnabled()) return;

      // Oy tespiti özelliği pasifse oyları işleme
      const _updateVoteConfig = await getPollConfig();
      if (_updateVoteConfig?.features?.voteTrackingEnabled === false) return;

      for (const item of updates) {
        const key = item.key;
        const pollUpdates = item.update?.pollUpdates || item.pollUpdates;

        if (!pollUpdates || pollUpdates.length === 0) continue;

        try {
          const db = getDB();
          if (!db) continue;

          // polls koleksiyonunda kayıtlı mı ve bu bota ait mi kontrol et
          const myConfigKey = process.env.CONFIG_KEY ? process.env.CONFIG_KEY.trim() : null;
          const pollDoc = await db.collection('polls').findOne({ pollId: key.id });
          if (!pollDoc) {
            // DB'de kayıtlı bir anket değilse oyları yoksay
            continue;
          }
          // Başka bir configKey'e ait anketin oylarını işleme
          if (myConfigKey && pollDoc.configKey && pollDoc.configKey !== myConfigKey) {
            continue;
          }

          let pollMsg = messageStore.get(key.id);
          if (!pollMsg && pollDoc?.messageData) {
            const decoded = deserializePollMessage(pollDoc.messageData);
            if (decoded) {
              pollMsg = { message: decoded, key: { id: key.id, remoteJid: pollDoc.groupId, fromMe: true } };
              messageStore.set(key.id, pollMsg);
            }
          }

          if (!pollMsg) {
            continue;
          }

          const aggregatedVotes = getAggregateVotesInPollMessage({
            message: pollMsg.message,
            pollUpdates: pollUpdates
          });

          if (!aggregatedVotes || aggregatedVotes.length === 0) continue;

          const allCurrentVoters = new Set();
          const currentReadingGroupId = await getTargetReadingGroupId();
          const configKey = process.env.CONFIG_KEY ? process.env.CONFIG_KEY.trim() : null;

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
                selectedOptions: [normalizePollOptionLabel(optionName)],
                readingGroupId: currentReadingGroupId,
                configKey: configKey,
                updatedAt: getTRDateString()
              });
            }
          }

          // Oy çekme tespiti (dokümanı silmek yerine selectedOptions: [] olarak güncelle)
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
                  readingGroupId: existingVote.readingGroupId || currentReadingGroupId,
                  configKey: configKey,
                  updatedAt: getTRDateString()
                });
              }
            }
          }
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
  if (isDBEnabled() && getDB()) {
    try { await getDB().collection(getAuthCollectionName()).deleteMany({}); } catch (e) { }
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
  const missingEnvs = checkRequiredEnvVars();
  if (missingEnvs.length > 0) {
    return {
      success: false,
      status: state.status,
      message: `.env dosyanızda zorunlu değişkenler eksik: ${missingEnvs.join(', ')}`
    };
  }

  const targetGroupId = options.groupId || await getTargetGroupId();
  const pollTitleCustom = options.pollTitleCustom || null;

  if (!(await hasValidGroupId()) && !options.groupId) {
    return {
      success: false,
      status: state.status,
      message: 'Henüz bir hedef WhatsApp grubu seçilmemiş! Lütfen Grup Ayarları panelinden WhatsApp Grubunuzu seçin.'
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

  // Anket seçenekleri aynı olamaz kontrolü
  const seenPollOptions = new Set();
  const duplicatePollOptions = [];
  for (const opt of pollOptions) {
    const lower = String(opt).trim().toLowerCase();
    if (seenPollOptions.has(lower)) {
      if (!duplicatePollOptions.includes(opt)) duplicatePollOptions.push(opt);
    } else {
      seenPollOptions.add(lower);
    }
  }

  if (duplicatePollOptions.length > 0) {
    return {
      success: false,
      status: state.status,
      message: `Anket seçenekleri aynı olamaz! Yinelenen seçenekler: ${duplicatePollOptions.join(', ')}`
    };
  }

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
      const configKey = process.env.CONFIG_KEY ? process.env.CONFIG_KEY.trim() : null;
      await savePoll({
        pollId: messageId,
        groupId: targetGroupId,
        title: pollTitle,
        options: pollOptions,
        configKey,
        messageData: serializePollMessage(sent?.message),
        createdAt: new Date()
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
  const missingEnvs = checkRequiredEnvVars();
  if (missingEnvs.length > 0) {
    return {
      success: false,
      status: state.status,
      message: `.env dosyanızda zorunlu değişkenler eksik: ${missingEnvs.join(', ')}`
    };
  }

  const targetGroupId = options.groupId || await getTargetGroupId();

  if (!(await hasValidGroupId()) && !options.groupId) {
    return {
      success: false,
      status: state.status,
      message: 'Henüz bir hedef WhatsApp grubu seçilmemiş! Lütfen Grup Ayarları panelinden WhatsApp Grubunuzu seçin.'
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

    const messageText = result.sentence;

    await sock.sendMessage(targetGroupId, { text: messageText });

    const sentAt = getTRDateString();
    console.log(`✅ [Cümle Gönderildi] (${result.collection}) → "${result.sentence.substring(0, 60)}..." [Grup: ${targetGroupId}]`);

    return {
      success: true,
      sentAt,
      collection: result.collection,
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
    const config = await getPollConfig();
    if (!config?.features?.pollEnabled) {
      console.log('[ZAMANLAYICI] Anket gönderimi pasif (featurePollEnabled: false), atlandı.');
      return;
    }
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
    const config = await getPollConfig();
    if (!config?.features?.sentenceEnabled) {
      console.log('[ZAMANLAYICI] Günün sözü gönderimi pasif (featureSentenceEnabled: false), atlandı.');
      return;
    }
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

// ============================================================================
// HAFTALIK OKUMA SERİSİ RAPORU (Her Cumartesi 22:30 TSİ)
// ============================================================================

async function sendWeeklyReadingReport(options = {}) {
  const targetGroupId = options.groupId || await getTargetGroupId();

  if (!(await hasValidGroupId()) && !options.groupId) {
    return {
      success: false,
      status: state.status,
      message: 'Henüz bir hedef WhatsApp grubu seçilmemiş! Lütfen Grup Ayarları panelinden WhatsApp Grubunuzu seçin.'
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
      message: 'Veritabanı bağlantısı aktif değil. Rapor gönderilemedi.'
    };
  }

  try {
    const targetReadingGroupId = options.readingGroupId || await getTargetReadingGroupId();
    const { readers, nonReaders } = await calculateReadingStreaks(targetReadingGroupId);

    // Mesaj 1: Okuma serisi yapanlar
    let msg1 = '*Okuma serisi yapanlar:*\n';
    if (readers.length > 0) {
      msg1 += readers.map(r => `${r.name} (${r.streak} gün)`).join(',\n');
    } else {
      msg1 += 'Henüz aktif okuma serisi olan kullanıcı yok.';
    }

    // Mesaj 2: Art arda okumayanlar + rastgele hatırlatma
    const randomReminder = reminderAlternatives[Math.floor(Math.random() * reminderAlternatives.length)];
    let msg2 = '*Art arda okumayanlar:*\n';
    if (nonReaders.length > 0) {
      msg2 += nonReaders.map(r => `${r.name} (${r.streak} gün)`).join(',\n');
    } else {
      msg2 += 'Art arda okumayan kullanıcı yok, tebrikler! 🎉';
    }
    msg2 += '\n\n' + randomReminder;

    // İki mesajı gruba gönder
    await sock.sendMessage(targetGroupId, { text: msg1 });
    // İkinci mesajı kısa bir gecikmeyle gönder
    await new Promise(r => setTimeout(r, 1500));
    await sock.sendMessage(targetGroupId, { text: msg2 });

    const sentAt = getTRDateString();
    console.log(`✅ [Haftalık Rapor] Okuma serisi raporu gönderildi! Okuyanlar: ${readers.length}, Okumayanlar: ${nonReaders.length} [Grup: ${targetGroupId}]`);

    return {
      success: true,
      sentAt,
      readersCount: readers.length,
      nonReadersCount: nonReaders.length,
      reminder: randomReminder,
      groupId: targetGroupId
    };
  } catch (err) {
    console.error('❌ Haftalık okuma raporu gönderme hatası:', err);
    return {
      success: false,
      error: err.message
    };
  }
}

/**
 * Her Cumartesi saat 22:30 TSİ'de haftalık okuma serisi raporunu gönderir.
 * Cron: dakika=30, saat=22, gün=*, ay=*, haftanın günü=6 (Cumartesi)
 */
function scheduleWeeklyReadingReportJob() {
  const job = schedule.scheduleJob({ rule: '30 22 * * 6', tz: 'Europe/Istanbul' }, async () => {
    const config = await getPollConfig();
    if (!config?.features?.weeklyReportEnabled) {
      console.log('[ZAMANLAYICI] Haftalık okuma raporu pasif (featureWeeklyReportEnabled: false), atlandı.');
      return;
    }
    const zaman = new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
    console.log(`\n[ZAMANLAYICI - ${zaman}] Haftalık okuma serisi raporu gönderimi başlatılıyor...`);
    try {
      const res = await sendWeeklyReadingReport();
      console.log(`[ZAMANLAYICI] Haftalık Rapor Gönderim Sonucu:`, res);
    } catch (error) {
      console.error(`[ZAMANLAYICI] Haftalık Rapor Gönderim Hatası:`, error);
    }
  });
  console.log("✅ Haftalık Okuma Raporu Zamanlayıcısı Kuruldu: Her Cumartesi saat 22:30 (TSİ)");
  return job;
}

// ============================================================================
// HAFTALIK OKUMA TABLOSU GÖRSELİ (Her Pazartesi 22:30 TSİ)
// ============================================================================

async function sendWeeklyTableImage(options = {}) {
  const targetGroupId = options.groupId || await getTargetGroupId();

  if (!(await hasValidGroupId()) && !options.groupId) {
    return {
      success: false,
      status: state.status,
      message: 'Henüz bir hedef WhatsApp grubu seçilmemiş! Lütfen Grup Ayarları panelinden WhatsApp Grubunuzu seçin.'
    };
  }

  if (!sock || state.status !== 'READY') {
    return {
      success: false,
      status: state.status,
      message: 'WhatsApp istemcisi bağlı veya hazır değil!'
    };
  }

  if (!isDBEnabled() || !getDB()) {
    return {
      success: false,
      message: 'Veritabanı bağlantısı aktif değil. Tablo resmi gönderilemedi.'
    };
  }

  try {
    const targetReadingGroupId = options.readingGroupId || await getTargetReadingGroupId();
    const tableResult = await generateWeeklyTableCanvas(getDB(), targetReadingGroupId);
    const imageBuffer = tableResult.buffer || tableResult;
    const captionText = tableResult.captionText || 'Haftalık okuma tablosu';
    const mimetype = tableResult.mimetype || 'image/png';

    await sock.sendMessage(targetGroupId, {
      image: imageBuffer,
      mimetype: mimetype,
      caption: captionText
    });

    const sentAt = getTRDateString();
    console.log(`✅ [Haftalık Tablo Resmi] Görsel başarıyla gönderildi! [Grup: ${targetGroupId}]`);

    const weekSuccessPct = tableResult.weekSuccessPct !== undefined ? tableResult.weekSuccessPct : 0;
    const summaryMessage = `Geçen haftaki okuma oranımız %${weekSuccessPct}`;

    await new Promise(res => setTimeout(res, 1500));
    await sock.sendMessage(targetGroupId, { text: summaryMessage });
    console.log(`✅ [Haftalık Okuma Oranı Mesajı] Mesaj başarıyla gönderildi: "${summaryMessage}" [Grup: ${targetGroupId}]`);

    // Bu ayın amount toplamı (yoksa / 0 ise ikinci mesaj atlanır)
    const MONTHLY_READING_GOAL = Number(process.env.MONTHLY_READING_GOAL) || 10000;
    let monthlyMessage = null;
    const monthly = await getMonthlyReadingAmountTotal(targetReadingGroupId);
    if (monthly?.hasAmounts && monthly.total > 0) {
      if (monthly.total >= MONTHLY_READING_GOAL) {
        monthlyMessage =
          `${monthly.monthName} Ayı Toplam Okumamız ${monthly.total}.\n` +
          `Bu ayki okuma hedefimize ulaştık 🎉🎉 Herkesin eline sağlık! 👏`;
      } else {
        monthlyMessage =
          `${monthly.monthName} Ayı Toplam Okumamız ${monthly.total}.\n` +
          `Hedefimiz ${MONTHLY_READING_GOAL} okumaya ulaşmak. Herkese iyi okumalar!`;
      }
      await new Promise(res => setTimeout(res, 1500));
      await sock.sendMessage(targetGroupId, { text: monthlyMessage });
      console.log(`✅ [Aylık Okuma Toplamı] Mesaj gönderildi: toplam=${monthly.total} [Grup: ${targetGroupId}]`);
    } else {
      console.log(`ℹ️ [Aylık Okuma Toplamı] Bu ay amount kaydı yok veya toplam 0 — ikinci mesaj atlandı.`);
    }

    return {
      success: true,
      sentAt,
      groupId: targetGroupId,
      weekSuccessPct,
      summaryMessage,
      monthlyMessage,
      monthlyTotal: monthly?.total || 0
    };
  } catch (err) {
    console.error('❌ Haftalık tablo resmi gönderme hatası:', err);
    return {
      success: false,
      error: err.message
    };
  }
}

/**
 * Her Pazartesi saat 22:30 TSİ'de haftalık okuma tablosu görselini gönderir.
 * Cron: dakika=30, saat=22, gün=*, ay=*, haftanın günü=1 (Pazartesi)
 */
function scheduleWeeklyTableImageJob() {
  const job = schedule.scheduleJob({ rule: '30 22 * * 1', tz: 'Europe/Istanbul' }, async () => {
    const config = await getPollConfig();
    if (!config?.features?.weeklyTableEnabled) {
      console.log('[ZAMANLAYICI] Haftalık tablo görseli pasif (featureWeeklyTableEnabled: false), atlandı.');
      return;
    }
    const zaman = new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
    console.log(`\n[ZAMANLAYICI - ${zaman}] Haftalık okuma tablosu görseli gönderimi başlatılıyor...`);
    try {
      const res = await sendWeeklyTableImage();
      console.log(`[ZAMANLAYICI] Haftalık Tablo Görseli Gönderim Sonucu:`, res);
    } catch (error) {
      console.error(`[ZAMANLAYICI] Haftalık Tablo Görseli Gönderim Hatası:`, error);
    }
  });
  console.log("✅ Haftalık Tablo Görseli Zamanlayıcısı Kuruldu: Her Pazartesi saat 22:30 (TSİ)");
  return job;
}

// ============================================================================
// LİG ATLAMA KUTLAMA MESAJLARI (pending_league_congratulations)
// ============================================================================

/**
 * pending_league_congratulations koleksiyonundaki bekleyen tebrik dokümanlarını kontrol eder.
 * Her biri için WhatsApp grubuna kutlama mesajı gönderir, ardından dokümanı siler ve
 * lastCongratulatedLeague alanını günceller.
 *
 * @param {object} [options]           - Opsiyonel parametreler
 * @param {string} [options.groupId]   - Belirli bir WhatsApp grup JID'si (yoksa poll_config'den alınır)
 * @param {string} [options.readingGroupId] - Belirli bir reading group ID (yoksa poll_config'den alınır)
 */
async function sendLeagueCongratulations(options = {}) {
  if (!isDBEnabled()) {
    return { success: false, message: 'Veritabanı bağlantısı aktif değil.' };
  }

  if (!sock || state.status !== 'READY') {
    return {
      success: false,
      status: state.status,
      message: 'WhatsApp istemcisi bağlı veya hazır değil!'
    };
  }

  try {
    // poll_config'den bu botun bağlı olduğu reading group ID'yi al
    const targetReadingGroupId = options.readingGroupId || await getTargetReadingGroupId();
    if (!targetReadingGroupId) {
      return { success: false, message: 'readingGroupId belirlenemedi (poll_config kontrol edin).' };
    }

    // Bu bota ait grubu filtrele (kendi readingGroupId'si ile eşleşen kutlamalar)
    const pending = await getPendingCongratulations(targetReadingGroupId);
    if (!pending || pending.length === 0) {
      return { success: true, sent: 0, message: 'Bekleyen lig atlama kutlaması yok.' };
    }

    const targetWhatsAppJid = options.groupId || await getTargetGroupId();
    if (!targetWhatsAppJid) {
      return { success: false, message: 'WhatsApp Grup JID belirlenemedi (poll_config kontrol edin).' };
    }

    // Sıralama:
    // 1. En üst ligdekiler / en çok güne sahip olanlar en üstte (büyükten küçüğe)
    // 2. Aynı ligdeki kişiler ise kendi arasında alfabetik (A'dan Z'ye)
    pending.sort((a, b) => {
      const minA = a.leagueMin != null ? Number(a.leagueMin) : 0;
      const minB = b.leagueMin != null ? Number(b.leagueMin) : 0;
      if (minB !== minA) {
        return minB - minA; // Yüksek lig (gün sayısı fazla olan) üstte
      }
      const nameA = (a.name || '').trim();
      const nameB = (b.name || '').trim();
      return nameA.localeCompare(nameB, 'tr', { sensitivity: 'base' }); // Aynı ligdekiler alfabetik
    });

    // Başlık: Tek kişi varsa tekil, birden fazla kişi varsa çoğul
    const title = pending.length === 1
      ? 'Lig atlayan arkadaşımızı tebrik ediyoruz! 🎉🎉'
      : 'Lig atlayan arkadaşlarımızı tebrik ediyoruz! 🎉🎉';

    // Satırlar: Sonuncusu '.' ile, öncekiler ',' ile biter
    const lines = pending.map((doc, index) => {
      const leagueLower = doc.league ? doc.league.toLowerCase() : 'yeni';
      const leagueMin = doc.leagueMin !== undefined && doc.leagueMin !== null ? doc.leagueMin : '';
      const punctuation = index === pending.length - 1 ? '.' : ',';
      return `⚡${leagueMin} gün - *${doc.name}* ${leagueLower} lige yükseldi${punctuation}`;
    });

    const messageText = `${title}\n\n${lines.join('\n')}`;

    // Gruba tek seferde toplu mesajı gönder
    await sock.sendMessage(targetWhatsAppJid, { text: messageText });
    console.log(`🏆 [Lig Kutlaması] ${pending.length} kişi için toplu kutlama mesajı gönderildi. [Grup: ${targetWhatsAppJid}]`);

    // Gönderilen her kullanıcı için kuyruktan sil ve lastCongratulatedLeague alanını güncelle
    let processedCount = 0;
    for (const doc of pending) {
      try {
        const docIdStr = doc._id ? doc._id.toString() : null;
        if (docIdStr) {
          await completeCongratulation(docIdStr, doc.userId, doc.groupId, doc.league);
          processedCount++;
        }
      } catch (err) {
        console.error(`❌ completeCongratulation hatası (${doc.name}):`, err.message);
      }
    }

    return {
      success: true,
      sent: processedCount,
      total: pending.length,
      groupId: targetWhatsAppJid,
      readingGroupId: targetReadingGroupId
    };
  } catch (err) {
    console.error('❌ sendLeagueCongratulations hatası:', err);
    return { success: false, error: err.message };
  }
}

function scheduleLeagueCongratulationsJob() {
  const job = schedule.scheduleJob('* * * * *', async () => {
    try {
      const res = await sendLeagueCongratulations();
      if (res.sent > 0) {
        console.log(`[LİG KUTLAMA] ${res.sent} kutlama mesajı gönderildi.`);
      }
    } catch (error) {
      console.error('[LİG KUTLAMA] Zamanlayıcı hatası:', error.message);
    }
  });
  console.log('✅ Lig Kutlama Zamanlayıcısı Kuruldu');
  return job;
}

async function getWhatsAppStatus(autoStartIfDisconnected = false) {
  const missingEnvs = checkRequiredEnvVars();
  if (missingEnvs.length > 0) {
    return {
      status: 'MISSING_ENV',
      missingEnvs: missingEnvs,
      qrDataUrl: null,
      userInfo: null,
      targetGroup: {
        id: null,
        name: null
      },
      targetReadingGroupId: null,
      lastPollSentAt: state.lastPollSentAt,
      lastError: `.env dosyanızda zorunlu değişkenler tanımlanmamış: ${missingEnvs.join(', ')}`,
      engine: 'Baileys Engine'
    };
  }

  if (autoStartIfDisconnected && (state.status === 'DISCONNECTED' || state.status === 'ERROR') && !sock) {
    initWhatsAppClient(false);
  }

  const targetId = await getTargetGroupId();
  const targetReadingId = await getTargetReadingGroupId();
  if (sock && state.status === 'READY' && targetId && !state.targetGroup.name) {
    fetchTargetGroupInfo();
  }

  return {
    status: state.status,
    configKey: process.env.CONFIG_KEY ? process.env.CONFIG_KEY.trim() : null,
    qrDataUrl: state.qrDataUrl,
    userInfo: state.userInfo,
    targetGroup: {
      id: targetId || null,
      name: state.targetGroup.name || null
    },
    targetReadingGroupId: targetReadingId || null,
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
app.use('/groupAvatars', express.static(path.join(__dirname, 'groupAvatars')));
app.use('/userAvatars', express.static(path.join(__dirname, 'userAvatars')));

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
    scheduleWeeklyReadingReportJob();
    scheduleWeeklyTableImageJob();
    scheduleLeagueCongratulationsJob();
  } catch (wpInitErr) {
    console.error("⚠️ WhatsApp servisi başlatılırken hata:", wpInitErr.message);
  }
})();

// WhatsApp API Endpoint'leri
app.get('/api/status', async (req, res) => {
  const autoStart = req.query.autoStart === 'true';
  res.json(await getWhatsAppStatus(autoStart));
});

app.get('/api/groups', async (req, res) => {
  try {
    const groups = await getWhatsAppGroups();
    res.json({ success: true, count: groups.length, groups });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// RoTaKip okuma gruplarini listele (usergroups koleksiyonu)
app.get('/api/reading-groups', async (req, res) => {
  try {
    const groups = await getReadingGroups();
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

// Manuel Haftalık Okuma Raporu Gönderme Endpoint'i (Test amaçlı)
app.all(['/api/send-reading-report', '/api/run-reading-report'], async (req, res) => {
  try {
    const groupId = req.query.groupId || req.body?.groupId;
    const result = await sendWeeklyReadingReport({ groupId });
    res.json(result);
  } catch (error) {
    console.error('WhatsApp haftalık rapor gönderim hatası:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Manuel Lig Kutlama Kontrolü Endpoint'i
app.all(['/api/send-league-congratulations', '/api/run-league-congratulations'], async (req, res) => {
  try {
    const groupId = req.query.groupId || req.body?.groupId;
    const readingGroupId = req.query.readingGroupId || req.body?.readingGroupId;
    const result = await sendLeagueCongratulations({ groupId, readingGroupId });
    res.json(result);
  } catch (error) {
    console.error('Lig kutlama gönderim hatası:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Manuel Haftalık Okuma Tablosu Görseli Gönderme Endpoint'i (Test amaçlı)
app.all(['/api/send-table-image', '/api/run-table-image'], async (req, res) => {
  try {
    const groupId = req.query.groupId || req.body?.groupId;
    const result = await sendWeeklyTableImage({ groupId });
    res.json(result);
  } catch (error) {
    console.error('WhatsApp haftalık tablo resmi gönderim hatası:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.all(['/api/restart', '/api/logout'], async (req, res) => {
  try {
    await restartWhatsAppClient();
    res.json({ success: true, message: 'WhatsApp istemcisi sıfırlandı ve yeniden başlatılıyor. Yeni QR kod oluşturuluyor...' });
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
    const configKey = req.query.configKey || req.query.configId || null;
    const config = await getPollConfig(configKey);
    res.json({ success: true, config, dbEnabled: isDBEnabled() });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Anket şablon ayarlarını kaydet / güncelle
app.post('/api/poll-config', async (req, res) => {
  try {
    const { titleTemplate, options, groupId, readingGroupId, configKey, configId, features } = req.body;
    const result = await savePollConfig({ titleTemplate, options, groupId, readingGroupId, configKey: configKey || configId, features });
    if (result.success) {
      if (sock && state.status === 'READY') {
        fetchTargetGroupInfo();
      }
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

// Bu bota ait anketleri listele (configKey + groupId)
app.get('/api/polls', async (req, res) => {
  if (!isDBEnabled() || !getDB()) {
    return res.json({ success: false, message: 'Veritabanı bağlantısı aktif değil.' });
  }
  try {
    const targetGroupId = await getTargetGroupId();
    const configKey = process.env.CONFIG_KEY ? process.env.CONFIG_KEY.trim() : null;
    if (!targetGroupId) {
      return res.json({
        success: false,
        message: 'Henüz bir hedef grup seçilmemiş. Lütfen Grup Ayarları panelinden Hedef WhatsApp Grubunuzu seçin.',
        polls: []
      });
    }
    if (!configKey) {
      return res.json({
        success: false,
        message: 'CONFIG_KEY tanımlı değil.',
        polls: []
      });
    }

    const polls = await getDB().collection('polls')
      .find({ groupId: targetGroupId, configKey })
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray();

    const formattedPolls = polls.map(p => ({
      ...p,
      createdAt: p.createdAt ? getTRDateString(p.createdAt) : p.createdAt
    }));

    res.json({ success: true, count: formattedPolls.length, polls: formattedPolls, groupId: targetGroupId });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Anketi polls koleksiyonundan sil (ilişkili oylar da silinir)
app.delete('/api/polls/:pollId', async (req, res) => {
  try {
    const result = await deletePoll(req.params.pollId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Belirli bir ankete ait tüm oyları getir
app.get('/api/poll-votes/:pollId', async (req, res) => {
  if (!isDBEnabled() || !getDB()) {
    return res.json({ success: false, message: 'Veritabanı bağlantısı aktif değil.' });
  }
  try {
    const { pollId } = req.params;
    const configKey = process.env.CONFIG_KEY ? process.env.CONFIG_KEY.trim() : null;

    // Anket bu bota ait mi?
    const pollFilter = { pollId };
    if (configKey) pollFilter.configKey = configKey;
    const poll = await getDB().collection('polls').findOne(pollFilter);
    if (!poll) {
      return res.json({ success: false, message: 'Anket bulunamadı veya bu bota ait değil.' });
    }
    if (poll.createdAt) {
      poll.createdAt = getTRDateString(poll.createdAt);
    }

    const votes = await getDB().collection('poll_votes')
      .find({ pollId })
      .sort({ updatedAt: -1 })
      .toArray();

    const formattedVotes = votes.map(v => ({
      ...v,
      updatedAt: v.updatedAt ? getTRDateString(v.updatedAt) : v.updatedAt
    }));

    res.json({
      success: true,
      poll,
      voteCount: formattedVotes.length,
      votes: formattedVotes
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Web Arayüzü (Ana dizindeki index.html sunulur)
app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Server Başlatma
app.listen(port, () => {
  console.log(`Uygulama http://localhost:${port} adresinde çalışıyor`);
});