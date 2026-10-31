const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const schedule = require('node-schedule');
const pino = require('pino');
const QRCode = require('qrcode');
require('dotenv').config();
const {
  setPromotionHandler, connectDB, isDBEnabled, getDB,
  getDashboardUserStatus, registerDashboardUser, verifyDashboardUser,
  savePoll, saveVote, saveTextVote, removeVote, getPollById, listPolls,
  listPollVotes, listTextVotes, getTRDateString, getLogicalReadingDate,
  listGroupConfigs, getGroupConfigById,
  findGroupConfigByWhatsAppGroup, findGroupConfigByPair, createGroupConfig,
  updateGroupConfig, deleteGroupConfig, updateGroupConfigRuntimeState,
  claimGroupConfigScheduleRun, DEFAULT_GROUP_CONFIG_FEATURES,
  saveLidMapping, getAllLidMappings,
  findReadingGroupUserByVoterLid, saveUnresolvedVoterLid, deleteUnresolvedVoterLid,
  listUnresolvedVoterLids,
  getReadingGroupPhones, getReadingGroupVoterLids, getMappedPhonesByConfigKey,
  deleteLidMappingsByConfigKey, getReadingGroups, getRandomSentence,
  calculateReadingStreaks, getPendingCongratulations,
  completeCongratulation, getReadingGroupUser,
  listReadingGroupUsersForLeaguePrefs, updateLeagueCongratulationDelivery,
  normalizeLeagueCongratulationDelivery, verifyReadingGroupAdmin,
  listReadingGroupUsersForPhoneEdit, updateReadingGroupUserPhone,
  updateReadingGroupUserVoterLid,
  reserveRandomReminder, releaseReminderReservation
} = require('./db');
const { generateWeeklyTableCanvas } = require('./weeklyTableImage');
const { generateLeagueCongratulationImage } = require('./leagueCongratulationImage');
const {
  getMaxReadingAmount,
  validateTextVoteSelectedOptions
} = require('./readingVoteValidation');
const { normalizeVoterLid } = require('./whatsappIdentity');
const { encryptBaileysAuthValue, decryptBaileysAuthValue } = require('./security');

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

function getConfiguredConfigKey() {
  return String(process.env.CONFIG_KEY || '').trim();
}

async function getActiveGroupConfigs() {
  if (!isDBEnabled() || !getDB() || typeof listGroupConfigs !== 'function') return [];
  try {
    return await listGroupConfigs(getConfiguredConfigKey());
  } catch (error) {
    console.error('⚠️ Grup eşleşmeleri okunamadı:', error.message);
    return [];
  }
}

async function resolveGroupConfigById(groupConfigId) {
  const id = String(groupConfigId || '').trim();
  if (!id || typeof getGroupConfigById !== 'function') return null;
  return getGroupConfigById(id, getConfiguredConfigKey());
}

async function resolveGroupConfigForWhatsAppGroup(groupId) {
  const id = String(groupId || '').trim();
  if (!id || typeof findGroupConfigByWhatsAppGroup !== 'function') return null;
  return findGroupConfigByWhatsAppGroup(id, getConfiguredConfigKey());
}

async function resolveGroupConfigForPair(groupId, readingGroupId) {
  const whatsappId = String(groupId || '').trim();
  const readingId = String(readingGroupId || '').trim();
  if (!whatsappId || !readingId || typeof findGroupConfigByPair !== 'function') return null;
  return findGroupConfigByPair(whatsappId, readingId, getConfiguredConfigKey());
}

function checkRequiredEnvVars() {
  const missing = [];
  if (!process.env.CONFIG_KEY || process.env.CONFIG_KEY.trim() === '') missing.push('CONFIG_KEY');
  if (!process.env.MONGO_URI || process.env.MONGO_URI.trim() === '') missing.push('MONGO_URI');
  if (!process.env.DB_NAME || process.env.DB_NAME.trim() === '') missing.push('DB_NAME');
  if (
    (process.env.RENDER === 'true' || process.env.NODE_ENV === 'production' || process.env.USE_MONGO_AUTH === 'true') &&
    (!process.env.BAILEYS_AUTH_ENCRYPTION_KEY || process.env.BAILEYS_AUTH_ENCRYPTION_KEY.length < 32)
  ) {
    missing.push('BAILEYS_AUTH_ENCRYPTION_KEY (en az 32 karakter)');
  }
  return missing;
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

// esmaülhüsna.json (eşleşmeye özel seçilen iki günde sıralı gönderim için)
const ESMAULHUSNA_JSON = JSON.parse(fs.readFileSync(path.join(__dirname, 'esmaulhusna.json'), 'utf8'));


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
let jidEncode = null;

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
    jidEncode = baileys.jidEncode;
  }
}

// Anket mesajlarını bellekte tutan depo (oy şifre çözümü için zorunlu)
const messageStore = new Map();

/**
 * Gönderilen mesajı Baileys'in retry akışı için saklar.
 * Bir cihaz mesajı ilk seferde çözemediğinde Baileys getMessage ile bu içeriği
 * bulup güncel Signal oturumuyla yeniden gönderebilir.
 */
async function rememberSentMessage(message) {
  if (message?.key?.id && message?.message) {
    messageStore.set(message.key.id, message);

    // Telefon retry isteğini süreç yeniden başladıktan sonra da gönderebilir.
    // Mesajı ilgili Baileys auth koleksiyonunda, auth kayıtlarından ayrı bir
    // kimlik alanı ve aynı uygulama-seviyesi şifreleme ile sakla.
    if (isDBEnabled() && getDB()) {
      const messageData = serializePollMessage(message.message);
      if (messageData) {
        try {
          const collectionName = getAuthCollectionName();
          const documentId = getOutgoingMessageDocumentId(message.key.id);
          const encryptionSecret = getBaileysAuthEncryptionSecret();
          const payload = JSON.stringify({
            messageData,
            remoteJid: message.key.remoteJid || null
          });
          const encryptedValue = encryptBaileysAuthValue(
            payload,
            encryptionSecret,
            `${collectionName}:${documentId}`
          );
          await getDB().collection(collectionName).updateOne(
            { _id: documentId },
            {
              $set: {
                type: 'outgoing-message',
                value: encryptedValue,
                encrypted: true,
                updatedAt: new Date()
              },
              $setOnInsert: { createdAt: new Date() }
            },
            { upsert: true }
          );
        } catch (err) {
          console.warn(`⚠️ Gönderilen mesaj retry deposuna yazılamadı: ${err.message}`);
        }
      }
    }
  }
  return message;
}

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

function getOutgoingMessageDocumentId(messageId) {
  return `outgoing-message:${String(messageId)}`;
}

function getBaileysAuthEncryptionSecret() {
  const encryptionSecret = String(process.env.BAILEYS_AUTH_ENCRYPTION_KEY || '');
  if (encryptionSecret.length < 32) {
    throw new Error('BAILEYS_AUTH_ENCRYPTION_KEY en az 32 karakter olmalıdır.');
  }
  return encryptionSecret;
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
/** Çözülemeyen LID'ler: her mesajda WA/users sync'i tekrarlamamak için */
const unresolvedLidUntil = new Map();
const UNRESOLVED_LID_TTL_MS = 30 * 60 * 1000;

function markLidUnresolved(bareLid) {
  if (!bareLid) return;
  unresolvedLidUntil.set(String(bareLid), Date.now() + UNRESOLVED_LID_TTL_MS);
}

function clearLidUnresolved(bareLid) {
  if (!bareLid) return;
  unresolvedLidUntil.delete(String(bareLid));
}

function isLidTemporarilyUnresolved(bareLid) {
  const until = unresolvedLidUntil.get(String(bareLid));
  if (!until) return false;
  if (Date.now() >= until) {
    unresolvedLidUntil.delete(String(bareLid));
    return false;
  }
  return true;
}

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
    clearLidUnresolved(bareLid);
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

function isLikelyLidValue(value) {
  const s = String(value || '');
  if (s.includes('@lid')) return true;
  const bare = s.split('@')[0].split(':')[0];
  return /^\d{13,20}$/.test(bare);
}

async function loadLidMappingsIntoMemory() {
  try {
    const configKey = process.env.CONFIG_KEY ? process.env.CONFIG_KEY.trim() : undefined;
    const dbMap = await getAllLidMappings(configKey);
    for (const lid in dbMap) {
      const phone = dbMap[lid];
      lidToPhoneMap.set(lid, phone);
      lidToPhoneMap.set(lid + '@lid', phone);
    }
    return Object.keys(dbMap).length;
  } catch (e) {
    return 0;
  }
}

/**
 * Hedef okuma grubundaki users_ phone listesinden LID eşlemesi üretir (onWhatsApp).
 * onlyMissing=true ise zaten mapped telefonları atlar.
 */
async function syncLidMappingsFromReadingGroupUsers({ onlyMissing = true } = {}) {
  if (!sock || state.status !== 'READY' || typeof sock.onWhatsApp !== 'function') {
    return { checked: 0, queried: 0, saved: 0 };
  }

  const configs = await getActiveGroupConfigs();
  const readingGroupIds = [...new Set(configs.map(config => config.readingGroupId).filter(Boolean))];
  if (readingGroupIds.length === 0) return { checked: 0, queried: 0, saved: 0 };

  const phoneLists = await Promise.all(readingGroupIds.map(readingGroupId => getReadingGroupPhones(readingGroupId)));
  const phones = [...new Set(phoneLists.flat())];
  if (!phones.length) return { checked: 0, queried: 0, saved: 0 };

  let toQuery = phones;
  if (onlyMissing) {
    const configKey = process.env.CONFIG_KEY ? process.env.CONFIG_KEY.trim() : undefined;
    const mapped = await getMappedPhonesByConfigKey(configKey);
    // Bellekteki phone değerlerini de say
    for (const phone of lidToPhoneMap.values()) {
      const bare = String(phone || '').split('@')[0].split(':')[0];
      if (bare) mapped.add(bare);
    }
    toQuery = phones.filter(p => !mapped.has(p));
  }

  let saved = 0;
  const chunkSize = 20;
  for (let i = 0; i < toQuery.length; i += chunkSize) {
    const chunk = toQuery.slice(i, i + chunkSize);
    try {
      const results = await sock.onWhatsApp(...chunk);
      for (const r of results || []) {
        if (!r?.exists || !r.lid) continue;
        const lidBare = String(r.lid).split('@')[0].split(':')[0];
        const had = lidToPhoneMap.has(lidBare);
        registerJidLidMapping(r.jid, r.lid);
        if (!had && lidToPhoneMap.has(lidBare)) saved++;
      }
    } catch (e) {
      console.warn('⚠️ onWhatsApp (users_) hatası:', e.message);
    }
  }

  return { checked: phones.length, queried: toQuery.length, saved };
}

/**
 * Sadece hedef WhatsApp grubunun metadata'sından LID↔phone eşlemesi (jid dolu üyeler).
 */
async function syncLidMappingsFromTargetWhatsAppGroup() {
  if (!sock || state.status !== 'READY' || typeof sock.groupMetadata !== 'function') {
    return { participants: 0, mapped: 0 };
  }

  const configs = await getActiveGroupConfigs();
  const targetGroupIds = [...new Set(configs.map(config => config.groupId).filter(Boolean))];
  let participantCount = 0;
  let mapped = 0;

  for (const targetGroupId of targetGroupIds) {
    try {
      const meta = await sock.groupMetadata(targetGroupId);
      const participants = meta?.participants || [];
      participantCount += participants.length;
      for (const participant of participants) {
        const beforeSize = lidToPhoneMap.size;
        processParticipantOrContact(participant);
        if (lidToPhoneMap.size > beforeSize) mapped++;
      }
    } catch (error) {
      console.warn(`⚠️ Hedef WA grubu metadata hatası (${targetGroupId}):`, error.message);
    }
  }
  return { participants: participantCount, mapped };
}

/**
 * lid_mappings'i hedef okuma grubu + hedef WA grubundan günceller.
 * @param {{ reason?: string, onlyMissing?: boolean }} opts
 */
async function ensureLidMappings({ reason = 'manual', onlyMissing = true } = {}) {
  if (reason === 'open' || reason === 'settings-save') {
    unresolvedLidUntil.clear();
  }
  const loaded = await loadLidMappingsIntoMemory();
  const fromUsers = await syncLidMappingsFromReadingGroupUsers({ onlyMissing });
  const fromWa = await syncLidMappingsFromTargetWhatsAppGroup();
  console.log(
    `🔗 [lid_mappings:${reason}] bellek=${loaded}, users_ kontrol=${fromUsers.checked} sorgu=${fromUsers.queried} yeni=${fromUsers.saved}, hedefWA üye=${fromWa.participants} eşlenen=${fromWa.mapped}`
  );
  return { loaded, fromUsers, fromWa };
}

/**
 * JID adresini (LID veya s.whatsapp.net) temiz telefon numarasına dönüştürür.
 * Çözülemez LID için null döner (LID'yi phone diye yazmaz).
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

  // Bilinen çözümsüz LID: her mesajda sync yapma
  if ((isLikelyLidValue(jid) || isLikelyLidValue(bare)) && isLidTemporarilyUnresolved(bare)) {
    return null;
  }

  // 3) Eksik users_ telefonları + sadece hedef WA grubu
  if (isLikelyLidValue(jid) || isLikelyLidValue(bare)) {
    await ensureLidMappings({ reason: 'vote-miss', onlyMissing: true });
  }

  if (lidToPhoneMap.has(normalized)) {
    return lidToPhoneMap.get(normalized);
  }
  if (lidToPhoneMap.has(bare)) {
    return lidToPhoneMap.get(bare);
  }

  if (isLikelyLidValue(jid) || isLikelyLidValue(bare)) {
    markLidUnresolved(bare);
  }

  return null;
}

function getVoterLid(explicitLidCandidates = [], jidCandidates = []) {
  for (const candidate of explicitLidCandidates) {
    const voterLid = normalizeVoterLid(candidate);
    if (voterLid) return voterLid;
  }
  for (const candidate of jidCandidates) {
    const value = String(candidate || '').toLowerCase();
    if (!value.includes('@lid') && !value.includes('@hosted.lid')) continue;
    const voterLid = normalizeVoterLid(candidate);
    if (voterLid) return voterLid;
  }
  return '';
}

async function getPhoneNumberFromCandidates(candidates, groupId) {
  const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate) continue;
    const value = String(candidate).trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    const phone = await getPhoneNumberFromJid(value, groupId);
    if (phone) return phone;
  }
  return null;
}

async function resolveUserByVoterLid(readingGroupId, voterLid) {
  if (!voterLid) return { user: null, reason: 'invalid_voter_lid' };
  return findReadingGroupUserByVoterLid(readingGroupId, voterLid);
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

  // 1) Bu anket veritabanımızda (polls koleksiyonunda) kayıtlı mı ve bu bota (configKey) ait mi kontrol et
  const myConfigKey = process.env.CONFIG_KEY ? process.env.CONFIG_KEY.trim() : null;
  let pollDoc = null;
  if (getDB()) {
    try {
      const pollFilter = { pollId: pollMsgId };
      if (myConfigKey) pollFilter.configKey = myConfigKey;
      pollDoc = await getDB().collection('polls').findOne(pollFilter);
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

  // Anketin oluşturulduğu grup çifti hâlâ aktif olmalı ve oy takibi o
  // eşleşmede açık olmalıdır. Hedef değiştirilen/silinen eski anketler
  // yeni RoTaKip grubuna yanlışlıkla yazılmaz.
  const activeConfig = await resolveGroupConfigForPair(pollDoc.groupId, pollDoc.readingGroupId);
  if (!activeConfig || activeConfig.features?.voteTrackingEnabled !== true) return;

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

  // Katılımcı haritasını belleğe yükle (eksik LID çözümü getPhoneNumberFromJid içinde)
  await loadLidMappingsIntoMemory();

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

  // 5) Telefon numarasını veya users_ içindeki voterLid kimliğini çöz.
  const activeVoterJid = successfulVoterJid || voterJid;
  const currentGroupId = pollDoc.groupId || pollMsg.key?.remoteJid;
  const currentReadingGroupId = pollDoc.readingGroupId;
  const configKey = process.env.CONFIG_KEY ? process.env.CONFIG_KEY.trim() : null;
  const voterLid = getVoterLid(
    [pollUpdateMsg.key?.participantLid, pollUpdateMsg.key?.senderLid, isFromMe ? selfLid : null],
    [pollUpdateMsg.key?.participant, activeVoterJid, rawVoterJid]
  );
  const voterPhone = await getPhoneNumberFromCandidates([
    pollUpdateMsg.key?.participantPn,
    pollUpdateMsg.key?.senderPn,
    pollUpdateMsg.key?.participantAlt,
    activeVoterJid,
    rawVoterJid
  ], currentGroupId);
  const pushName = pollUpdateMsg.pushName || pollUpdateMsg.verifiedBizName || (isFromMe ? (sock?.user?.name || 'Kendi Oyunuz') : null);
  const voterUsername = pollUpdateMsg.key?.participantUsername || pollUpdateMsg.key?.remoteJidUsername || null;

  console.log(`✅ [Deşifre Başarılı] Telefon: ${voterPhone || 'ÇÖZÜLEMEDİ'} (JID: ${activeVoterJid}, LID: ${voterLid || 'YOK'}) → Seçimler:`, selectedOptionNames);

  if (!voterPhone) {
    const lidMatch = await resolveUserByVoterLid(currentReadingGroupId, voterLid);
    if (!lidMatch.user) {
      if (voterLid) {
        await saveUnresolvedVoterLid({
          configKey,
          readingGroupId: currentReadingGroupId,
          groupId: currentGroupId,
          voterLid,
          voterUsername,
          pushName,
          source: 'poll',
          reason: lidMatch.reason,
          date: getTRDateString().slice(0, 10)
        });
      }
      console.warn(
        `⚠️ Oy kaydedilmedi — telefon ve voterLid eşleşmesi bulunamadı ` +
        `(JID: ${activeVoterJid}, LID: ${voterLid || 'YOK'}, neden: ${lidMatch.reason})`
      );
      return;
    }
    await deleteUnresolvedVoterLid({
      configKey,
      readingGroupId: currentReadingGroupId,
      groupId: currentGroupId,
      voterLid
    });
  }

  // Oy, ayarlar sonradan değişmiş olsa bile anket oluşturulurken seçili olan
  // okuma grubuna yazılmalı.
  await saveVote({
    pollId: pollMsgId,
    voterJid: voterPhone || voterLid,
    voterPhone: voterPhone || undefined,
    voterLid: voterLid || undefined,
    rawLid: voterLid || undefined,
    pushName: pushName,
    selectedOptions: selectedOptionNames,
    readingGroupId: currentReadingGroupId,
    groupId: currentGroupId,
    configKey: configKey,
    updatedAt: getTRDateString()
  });

  if (selectedOptionNames.length > 0) {
    console.log(`💾 Oy DB'ye kaydedildi! (${voterPhone || voterLid} -> ${selectedOptionNames.join(', ')})`);
  } else {
    console.log(`🗑️ Oy geri çekildi, DB güncellendi (boş dizi)! (${voterPhone || voterLid} -> [])`);
  }
}

/** Metin okuma: "20" | "20 sayfa" | "0" | "iptal" | "dün 15 sayfa" vb. */
const READING_MESSAGE_REGEX = /^(dün\s+)?(\d+)(?:\s+(?:sayfa|syf|dk|dakika))?$/;
const READING_CANCEL_REGEX = /^(dün\s+)?iptal$/;
const MAX_READING_AMOUNT = getMaxReadingAmount();

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
  const selection = validateTextVoteSelectedOptions([match[2]], {
    maxAmount: MAX_READING_AMOUNT
  });
  if (!selection.valid) {
    return {
      pages: match[2],
      isYesterday: Boolean(match[1]),
      clear: false,
      invalidReason: selection.reason
    };
  }
  return {
    pages: selection.clear ? '0' : selection.selectedOptions[0],
    isYesterday: Boolean(match[1]),
    clear: selection.clear
  };
}

/**
 * Hedef gruptaki metin mesajlarından sayfa okuma bilgisini yakalar,
 * text_votes'a kaydeder; başarılıysa ✔️, üst sınırı aşıyorsa ❌ reaction bırakır.
 */
async function processReadingMessage(msg) {
  if (!isDBEnabled() || !sock) return;

  const incomingGroupId = msg.key?.remoteJid;
  if (!incomingGroupId) return;
  const groupConfig = await resolveGroupConfigForWhatsAppGroup(incomingGroupId);
  if (!groupConfig || groupConfig.features?.messageReadingEnabled !== true) return;

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

  if (parsed.invalidReason) {
    try {
      await sock.sendMessage(incomingGroupId, {
        react: { text: '❌', key: msg.key }
      });
    } catch (reactErr) {
      console.error('⚠️ Geçersiz okuma mesajı reaction hatası:', reactErr.message);
    }
  }

  const participantJid = msg.key?.participant || msg.participant || msg.key?.remoteJid;
  const voterLid = getVoterLid(
    [msg.key?.participantLid, msg.key?.senderLid],
    [msg.key?.participant, msg.participant]
  );
  const voterPhone = await getPhoneNumberFromCandidates([
    msg.key?.participantPn,
    msg.key?.senderPn,
    msg.key?.participantAlt,
    participantJid
  ], incomingGroupId);
  const configKey = process.env.CONFIG_KEY ? process.env.CONFIG_KEY.trim() : null;
  const readingGroupId = groupConfig.readingGroupId;
  if (!voterPhone) {
    const lidMatch = await resolveUserByVoterLid(readingGroupId, voterLid);
    if (!lidMatch.user) {
      if (voterLid) {
        await saveUnresolvedVoterLid({
          configKey,
          readingGroupId,
          groupId: incomingGroupId,
          voterLid,
          voterUsername: msg.key?.participantUsername || msg.key?.remoteJidUsername,
          pushName: msg.pushName,
          source: 'message',
          reason: lidMatch.reason,
          date: getLogicalReadingDate(msg.messageTimestamp, parsed.isYesterday)
        });
      }
      console.warn(
        `⚠️ Okuma mesajı kaydedilmedi — telefon ve voterLid eşleşmesi bulunamadı ` +
        `(JID: ${participantJid}, LID: ${voterLid || 'YOK'}, neden: ${lidMatch.reason})`
      );
      return;
    }
    await deleteUnresolvedVoterLid({
      configKey,
      readingGroupId,
      groupId: incomingGroupId,
      voterLid
    });
  }

  const date = getLogicalReadingDate(msg.messageTimestamp, parsed.isYesterday);
  const selectedOptions = parsed.clear ? [] : [parsed.pages];

  const result = await saveTextVote({
    voterJid: voterPhone || voterLid,
    voterPhone: voterPhone || undefined,
    voterLid: voterLid || undefined,
    rawLid: voterLid || undefined,
    selectedOptions,
    pushName: msg.pushName || undefined,
    readingGroupId,
    groupId: incomingGroupId,
    configKey,
    date,
    updatedAt: getTRDateString()
  });

  if (!result?.saved) return;
  if (parsed.invalidReason) return;
  if (result.syncResult?.status !== 'synced') {
    console.warn(
      `⚠️ Okuma mesajı kaydedildi ancak uygulanmadı: ${result.syncResult?.reason || parsed.invalidReason || 'pending'}`
    );
    return;
  }

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
const targetGroupInfoById = new Map();

async function fetchTargetGroupInfo() {
  if (!sock || state.status !== 'READY') return;
  const configs = await getActiveGroupConfigs();
  for (const config of configs) {
    const targetId = config.groupId;
    if (!targetId) continue;
    try {
      const meta = await sock.groupMetadata(targetId);
      if (meta?.subject) targetGroupInfoById.set(targetId, meta.subject);
    } catch (_) { }
  }
  const first = configs[0];
  state.targetGroup.id = first?.groupId || null;
  state.targetGroup.name = first ? (targetGroupInfoById.get(first.groupId) || null) : null;
}

/**
 * MongoDB tabanlı Baileys Auth State
 * (Render vb. uçucu/ephemeral sunucularda oturum dosyalarının ve E2EE şifreleme anahtarlarının kaybolmasını önler)
 */
async function useMongoDBAuthState(db, collectionName = 'baileys_auth') {
  const collection = db.collection(collectionName);
  const encryptionSecret = getBaileysAuthEncryptionSecret();

  const writeData = async (data, id) => {
    try {
      const serialized = JSON.stringify(data, BufferJSON ? BufferJSON.replacer : undefined);
      const encryptedValue = encryptBaileysAuthValue(serialized, encryptionSecret, `${collectionName}:${id}`);
      await collection.updateOne(
        { _id: id },
        { $set: { value: encryptedValue, encrypted: true, updatedAt: new Date() } },
        { upsert: true }
      );
    } catch (err) {
      console.error(`⚠️ MongoDB Auth verisi yazılamadı (${id}):`, err.message);
      throw err;
    }
  };

  const readData = async (id) => {
    let doc = null;
    try {
      doc = await collection.findOne({ _id: id });
      if (doc && doc.value) {
        const decrypted = decryptBaileysAuthValue(doc.value, encryptionSecret, `${collectionName}:${id}`);
        const serialized = decrypted === null ? String(doc.value) : decrypted;
        const parsed = JSON.parse(serialized, BufferJSON ? BufferJSON.reviver : undefined);
        // Önceki sürümden kalan açık metin kayıtları ilk okumada şifreli biçime geçir.
        if (decrypted === null) await writeData(parsed, id);
        return parsed;
      }
    } catch (err) {
      console.error(`⚠️ MongoDB Auth verisi okunamadı (${id}):`, err.message);
      if (doc?.encrypted || String(doc?.value || '').startsWith('enc:v1:')) throw err;
    }
    return null;
  };

  const removeData = async (id) => {
    try {
      await collection.deleteOne({ _id: id });
    } catch (err) {
      console.error(`⚠️ MongoDB Auth verisi silinemedi (${id}):`, err.message);
      throw err;
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

        // 2) Bellekte yoksa ilgili auth koleksiyonundan yükle
        // (bot yeniden başlatılmışsa)
        if (isDBEnabled() && getDB()) {
          try {
            const collectionName = getAuthCollectionName();
            const documentId = getOutgoingMessageDocumentId(key.id);
            const outgoing = await getDB().collection(collectionName).findOne({
              _id: documentId,
              type: 'outgoing-message'
            });
            if (outgoing?.value) {
              const encryptionSecret = getBaileysAuthEncryptionSecret();
              const decrypted = decryptBaileysAuthValue(
                outgoing.value,
                encryptionSecret,
                `${collectionName}:${documentId}`
              );
              if (decrypted === null) {
                throw new Error('Gönderilen mesaj kaydı şifreli değil.');
              }
              const payload = JSON.parse(decrypted);
              const decoded = deserializePollMessage(payload.messageData);
              if (decoded) {
                messageStore.set(key.id, { message: decoded });
                return decoded;
              }
            }

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
              unresolvedLidUntil.clear();
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
        ensureLidMappings({ reason: 'open', onlyMissing: true }).catch((e) => {
          console.warn('⚠️ lid_mappings open sync hatası:', e.message);
        });
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
            const incomingConfig = await resolveGroupConfigForWhatsAppGroup(incomingGroupId);

            // Yapılandırılmış WhatsApp grupları dışındaki anketleri yoksay.
            if (!incomingGroupId || !incomingConfig) {
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
                      readingGroupId: existingPoll.readingGroupId || incomingConfig.readingGroupId,
                      configKey: existingPoll.configKey || getConfiguredConfigKey(),
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
                      readingGroupId: incomingConfig.readingGroupId,
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

      for (const item of updates) {
        const key = item.key;
        const pollUpdates = item.update?.pollUpdates || item.pollUpdates;

        if (!pollUpdates || pollUpdates.length === 0) continue;

        try {
          const db = getDB();
          if (!db) continue;

          // polls koleksiyonunda kayıtlı mı ve bu bota ait mi kontrol et
          const myConfigKey = process.env.CONFIG_KEY ? process.env.CONFIG_KEY.trim() : null;
          const pollFilter = { pollId: key.id };
          if (myConfigKey) pollFilter.configKey = myConfigKey;
          const pollDoc = await db.collection('polls').findOne(pollFilter);
          if (!pollDoc) {
            // DB'de kayıtlı bir anket değilse oyları yoksay
            continue;
          }
          // Başka bir configKey'e ait anketin oylarını işleme
          if (myConfigKey && pollDoc.configKey && pollDoc.configKey !== myConfigKey) {
            continue;
          }
          const activeConfig = await resolveGroupConfigForPair(pollDoc.groupId, pollDoc.readingGroupId);
          if (!activeConfig || activeConfig.features?.voteTrackingEnabled !== true) continue;

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

          // Güncel ayar yerine öncelikle anketin oluşturulduğu okuma grubunu kullan.
          const currentReadingGroupId = pollDoc.readingGroupId;
          const configKey = process.env.CONFIG_KEY ? process.env.CONFIG_KEY.trim() : null;

          // Her güncelleme kendi oy verenini ve seçimini taşır. [] doğrudan
          // oy geri çekmedir; diğer kullanıcıların önceki oylarıyla kıyaslanmaz.
          for (const pollUpdate of pollUpdates) {
            if (!pollUpdate.vote) continue;
            const voteKey = pollUpdate.pollUpdateMessageKey;
            if (!voteKey) continue;
            const voterJid = voteKey.fromMe
              ? (sock.user?.id || sock.user?.lid)
              : (voteKey.participant || voteKey.remoteJid);
            if (!voterJid) continue;
            const currentGroupId = pollDoc.groupId || key.remoteJid;
            const voterLid = getVoterLid(
              [voteKey.participantLid, voteKey.senderLid, voteKey.fromMe ? sock.user?.lid : null],
              [voteKey.participant, voterJid]
            );
            const voterPhone = await getPhoneNumberFromCandidates([
              voteKey.participantPn,
              voteKey.senderPn,
              voteKey.participantAlt,
              voterJid
            ], currentGroupId);
            if (!voterPhone) {
              const lidMatch = await resolveUserByVoterLid(currentReadingGroupId, voterLid);
              if (!lidMatch.user) {
                if (voterLid) {
                  await saveUnresolvedVoterLid({
                    configKey,
                    readingGroupId: currentReadingGroupId,
                    groupId: currentGroupId,
                    voterLid,
                    voterUsername: voteKey.participantUsername || voteKey.remoteJidUsername,
                    source: 'poll-update',
                    reason: lidMatch.reason,
                    date: getTRDateString().slice(0, 10)
                  });
                }
                console.warn(
                  `⚠️ Yedek oy atlandı — telefon ve voterLid eşleşmesi bulunamadı ` +
                  `(JID: ${voterJid}, LID: ${voterLid || 'YOK'}, neden: ${lidMatch.reason})`
                );
                continue;
              }
              await deleteUnresolvedVoterLid({
                configKey,
                readingGroupId: currentReadingGroupId,
                groupId: currentGroupId,
                voterLid
              });
            }

            const aggregatedVotes = getAggregateVotesInPollMessage({
              message: pollMsg.message,
              pollUpdates: [pollUpdate]
            }, sock.user?.id);
            const selectedOptions = (aggregatedVotes || [])
              .filter(option => option.voters?.length > 0)
              .map(option => normalizePollOptionLabel(option.name));
            // Seçili hash varsa fakat çözülemiyorsa bunu oy geri çekme sayma.
            if (pollUpdate.vote.selectedOptions?.length > 0 && selectedOptions.length === 0) continue;

            await saveVote({
              pollId: key.id,
              voterJid: voterPhone || voterLid,
              voterPhone: voterPhone || undefined,
              voterLid: voterLid || undefined,
              rawLid: voterLid || undefined,
              selectedOptions,
              readingGroupId: currentReadingGroupId,
              groupId: currentGroupId,
              configKey,
              updatedAt: getTRDateString()
            });
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
  if (cleanedNumber.length > 15) {
    throw new Error('Telefon numarası en fazla 15 haneli olabilir.');
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
    const configKey = process.env.CONFIG_KEY ? process.env.CONFIG_KEY.trim() : null;
    if (configKey) {
      await deleteLidMappingsByConfigKey(configKey);
      lidToPhoneMap.clear();
      unresolvedLidUntil.clear();
    }
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

async function resolveSendGroupConfig(options = {}) {
  if (options.groupConfig?.id || options.groupConfig?._id) return options.groupConfig;
  if (options.groupConfigId) return resolveGroupConfigById(options.groupConfigId);
  if (options.groupId && options.readingGroupId) {
    return resolveGroupConfigForPair(options.groupId, options.readingGroupId);
  }
  if (options.groupId) return resolveGroupConfigForWhatsAppGroup(options.groupId);
  const configs = await getActiveGroupConfigs();
  return configs[0] || null;
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

  const config = await resolveSendGroupConfig(options);
  const targetGroupId = config?.groupId;
  const pollTitleCustom = options.pollTitleCustom || null;

  if (!config || !targetGroupId) {
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
  const rawTitle = pollTitleCustom || config.titleTemplate || '{{date}}';
  const pollTitle = getDailyPollTitle(rawTitle);
  const pollOptions = (config.options && Array.isArray(config.options) && config.options.length > 0)
    ? config.options
    : DEFAULT_POLL_OPTIONS;

  if (pollOptions.length < 2 || pollOptions.length > 12) {
    return {
      success: false,
      status: state.status,
      message: `Anket seçenekleri 2 ile 12 arasında olmalıdır. (Mevcut: ${pollOptions.length})`
    };
  }

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

    // Anketi veritabanına kaydet (DB aktifse). WhatsApp gönderimi başarılı
    // olup bu kayıt kaybolursa sonraki oy güncellemeleri güvenlik gereği
    // tanınmayacağı için geçici DB hatalarında birkaç kez yeniden dene.
    let pollPersisted = false;
    if (isDBEnabled()) {
      const configKey = process.env.CONFIG_KEY ? process.env.CONFIG_KEY.trim() : null;
      const pollRecord = {
        pollId: messageId,
        groupId: targetGroupId,
        title: pollTitle,
        options: pollOptions,
        configKey,
        readingGroupId: config.readingGroupId,
        messageData: serializePollMessage(sent?.message),
        createdAt: new Date()
      };
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const saveResult = await savePoll(pollRecord);
        if (saveResult) {
          pollPersisted = true;
          break;
        }
        if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 250));
      }
    }
    if (typeof updateGroupConfigRuntimeState === 'function') {
      await updateGroupConfigRuntimeState(config.id || config._id, {
        lastPollSentAt: state.lastPollSentAt
      }, getConfiguredConfigKey());
    }

    if (!pollPersisted) {
      return {
        success: false,
        partialSuccess: true,
        code: 'POLL_PERSIST_FAILED',
        message: 'Anket WhatsApp grubuna gönderildi ancak oy takibi için veritabanına kaydedilemedi.',
        messageId,
        pollTitle,
        groupId: targetGroupId,
        readingGroupId: config.readingGroupId,
        groupConfigId: config.id || config._id,
        sentAt: state.lastPollSentAt
      };
    }

    return {
      success: true,
      messageId,
      pollTitle,
      groupId: targetGroupId,
      readingGroupId: config.readingGroupId,
      groupConfigId: config.id || config._id,
      sentAt: state.lastPollSentAt
    };
  } catch (err) {
    console.error('❌ WhatsApp Anket Gönderme Hatası:', err);
    return {
      success: false,
      error: 'WhatsApp anketi gönderilemedi.'
    };
  }
}

// ============================================================================
// RASTGELE VECİZE GÖNDERİMİ (Ayetler, Dualar, Hadisler, Hatırlatmalar, Vecizeler)
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

  const config = await resolveSendGroupConfig(options);
  const targetGroupId = config?.groupId;

  if (!config || !targetGroupId) {
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
      message: 'Veritabanı bağlantısı aktif değil. Vecize gönderilemedi.'
    };
  }

  try {
    const result = await getRandomSentence();
    if (!result || !result.sentence) {
      return {
        success: false,
        message: 'Veritabanından rastgele vecize çekilemedi.'
      };
    }

    const messageText = result.sentence;

    await sock.sendMessage(targetGroupId, { text: messageText });

    const sentAt = getTRDateString();
    console.log(`✅ [Vecize Gönderildi] (${result.collection}) → "${result.sentence.substring(0, 60)}..." [Grup: ${targetGroupId}]`);

    return {
      success: true,
      sentAt,
      collection: result.collection,
      sentence: result.sentence,
      groupId: targetGroupId,
      readingGroupId: config.readingGroupId,
      groupConfigId: config.id || config._id
    };
  } catch (err) {
    console.error('❌ WhatsApp Vecize Gönderme Hatası:', err);
    return {
      success: false,
      error: 'WhatsApp mesajı gönderilemedi.'
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

async function runForEnabledGroupConfigs(featureKey, label, worker) {
  const configs = await getActiveGroupConfigs();
  const enabled = configs.filter(config => config.features?.[featureKey] === true);
  if (enabled.length === 0) {
    console.log(`[ZAMANLAYICI] ${label}: etkin eşleşme yok, atlandı.`);
    return [];
  }

  const results = [];
  for (const groupConfig of enabled) {
    try {
      const result = await worker(groupConfig);
      results.push({ groupConfigId: groupConfig.id || groupConfig._id, ...result });
    } catch (error) {
      console.error(`[ZAMANLAYICI] ${label} hatası [${groupConfig.groupId} → ${groupConfig.readingGroupId}]:`, error);
      results.push({
        success: false,
        groupConfigId: groupConfig.id || groupConfig._id,
        error: error.message
      });
    }
  }
  return results;
}

const ISTANBUL_WEEKDAY_NUMBERS = Object.freeze({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 });

function getIstanbulScheduleParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Istanbul',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date).reduce((result, part) => {
    if (part.type !== 'literal') result[part.type] = part.value;
    return result;
  }, {});
  return {
    weekday: ISTANBUL_WEEKDAY_NUMBERS[parts.weekday],
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    slot: `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`
  };
}

function isGroupScheduleDue(scheduleConfig, now, weekly = false) {
  if (!scheduleConfig || scheduleConfig.hour !== now.hour || scheduleConfig.minute !== now.minute) return false;
  return !weekly || (Array.isArray(scheduleConfig.weekdays) && scheduleConfig.weekdays.includes(now.weekday));
}

let configurableMessagingScheduleTail = Promise.resolve();

async function dispatchConfigurableMessagingSchedules(fireDate = new Date()) {
  const now = getIstanbulScheduleParts(fireDate);
  const configs = await getActiveGroupConfigs();
  const definitions = [
    {
      scheduleKey: 'poll',
      featureKey: 'pollEnabled',
      label: 'WhatsApp anketi',
      weekly: false,
      worker: groupConfig => sendWhatsAppPoll({ groupConfig })
    },
    {
      scheduleKey: 'sentence',
      featureKey: 'sentenceEnabled',
      label: 'Vecize',
      weekly: true,
      worker: groupConfig => sendWhatsAppSentence({ groupConfig })
    },
    {
      scheduleKey: 'esmaulhusna',
      featureKey: 'esmaulhusnaEnabled',
      label: 'Esmaül Hüsna',
      weekly: true,
      worker: groupConfig => sendEsmaulhusna({ groupConfig })
    }
  ];

  for (const groupConfig of configs) {
    for (const definition of definitions) {
      if (groupConfig.features?.[definition.featureKey] !== true) continue;
      if (!isGroupScheduleDue(groupConfig.schedules?.[definition.scheduleKey], now, definition.weekly)) continue;
      const claimed = await claimGroupConfigScheduleRun(
        groupConfig.id || groupConfig._id,
        definition.scheduleKey,
        now.slot,
        getConfiguredConfigKey()
      );
      if (!claimed) continue;
      try {
        console.log(`[ZAMANLAYICI] ${definition.label} başlatılıyor [${groupConfig.groupId} → ${groupConfig.readingGroupId}]`);
        const result = await definition.worker(groupConfig);
        console.log(`[ZAMANLAYICI] ${definition.label} sonucu [${groupConfig.groupId}]:`, result);
      } catch (error) {
        console.error(`[ZAMANLAYICI] ${definition.label} hatası [${groupConfig.groupId} → ${groupConfig.readingGroupId}]:`, error);
      }
    }
  }
}

function scheduleConfigurableMessagingJobs() {
  const job = schedule.scheduleJob({ rule: '* * * * *', tz: 'Europe/Istanbul' }, fireDate => {
    configurableMessagingScheduleTail = configurableMessagingScheduleTail
      .then(() => dispatchConfigurableMessagingSchedules(fireDate))
      .catch(error => console.error('[ZAMANLAYICI] Dinamik gönderim kontrolü hatası:', error));
  });
  console.log('✅ Anket, vecize ve Esmaül Hüsna dinamik zamanlayıcısı kuruldu (Europe/Istanbul)');
  return job;
}

// ============================================================================
// ESMAÜL HÜSNA GÖNDERİMİ (eşleşmeye özel iki gün ve saat)
// ============================================================================

async function sendEsmaulhusna(options = {}) {
  const missingEnvs = checkRequiredEnvVars();
  if (missingEnvs.length > 0) {
    return {
      success: false,
      message: `.env dosyanızda zorunlu değişkenler eksik: ${missingEnvs.join(', ')}`
    };
  }

  const config = await resolveSendGroupConfig(options);
  const targetGroupId = config?.groupId;

  if (!config || !targetGroupId) {
    return {
      success: false,
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
      message: 'Veritabanı bağlantısı aktif değil. Esmaül Hüsna gönderilemedi.'
    };
  }

  if (!ESMAULHUSNA_JSON || ESMAULHUSNA_JSON.length === 0) {
    return { success: false, message: 'esmaulhusna.json yüklenemedi veya boş.' };
  }

  try {
    const totalCount = ESMAULHUSNA_JSON.length; // 99

    // Mevcut index'i config'ten al (1-bazlı)
    let currentIndex = (typeof config?.esmaulhusnaIndex === 'number' && config.esmaulhusnaIndex >= 1)
      ? config.esmaulhusnaIndex
      : 1;

    // JSON'da id'ye göre bul; bulunamazsa dizi sırasını kullan
    const entry = ESMAULHUSNA_JSON.find(e => e.id === currentIndex)
      || ESMAULHUSNA_JSON[(currentIndex - 1) % totalCount];

    if (!entry) {
      return { success: false, message: `Esmaül Hüsna index ${currentIndex} bulunamadı.` };
    }

    // Mesaj formatı: *ES-SELAM*: Açıklama.
    //
    // https://youtu.be/...
    const messageText = `*${entry.esmaulhusna_name}*: ${entry.esmaulhusna_description}\n\n${entry.esmaulhusna_video_url}`;

    await sock.sendMessage(targetGroupId, { text: messageText });

    // Sonraki index'i hesapla (99'dan sonra 1'e dön)
    const nextIndex = (currentIndex % totalCount) + 1;
    let indexUpdateResult = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      indexUpdateResult = await updateGroupConfigRuntimeState(
        config.id || config._id,
        { esmaulhusnaIndex: nextIndex },
        getConfiguredConfigKey()
      );
      if (indexUpdateResult.success) break;
      if (attempt < 3) {
        await new Promise(resolve => setTimeout(resolve, attempt * 500));
      }
    }

    if (!indexUpdateResult?.success) {
      console.error(
        `❌ [Esmaül Hüsna] ${currentIndex}. isim gönderildi ancak sıradaki index kaydedilemedi:`,
        indexUpdateResult?.message || 'Bilinmeyen veritabanı hatası'
      );
      return {
        success: false,
        partialSuccess: true,
        code: 'ESMAULHUSNA_INDEX_UPDATE_FAILED',
        message: 'Esmaül Hüsna mesajı gönderildi ancak gönderim sırası veritabanına kaydedilemedi.',
        sentIndex: currentIndex,
        pendingNextIndex: nextIndex,
        name: entry.esmaulhusna_name,
        groupId: targetGroupId
      };
    }

    const sentAt = getTRDateString();
    console.log(`✅ [Esmaül Hüsna] ${currentIndex}. isim gönderildi: ${entry.esmaulhusna_name} → Sıradaki: ${nextIndex} [Grup: ${targetGroupId}]`);

    return {
      success: true,
      sentAt,
      sentIndex: currentIndex,
      nextIndex,
      name: entry.esmaulhusna_name,
      groupId: targetGroupId,
      readingGroupId: config.readingGroupId,
      groupConfigId: config.id || config._id
    };
  } catch (err) {
    console.error('❌ Esmaül Hüsna Gönderme Hatası:', err);
    return {
      success: false,
      error: 'Esmaül Hüsna mesajı gönderilemedi.'
    };
  }
}

// ============================================================================
// HAFTALIK OKUMA SERİSİ RAPORU (Her Cumartesi 22:30 TSİ)
// ============================================================================

async function sendWeeklyReadingReport(options = {}) {
  const config = await resolveSendGroupConfig(options);
  const targetGroupId = config?.groupId;
  let reservedReminder = null;
  let reminderConfigKey = null;

  if (!config || !targetGroupId) {
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
    const targetReadingGroupId = config.readingGroupId;
    const { readers, nonReaders } = await calculateReadingStreaks(targetReadingGroupId);

    // Mesaj 1: Okuma serisi yapanlar
    let msg1 = '*Okuma serisi yapanlar:*\n';
    if (readers.length > 0) {
      msg1 += readers.map(r => `${r.name} (${r.streak} gün)`).join(',\n');
    } else {
      msg1 += 'Henüz aktif okuma serisi olan kullanıcı yok.';
    }

    // Mesaj 2: Art arda okumayanlar
    const quoteEnabled = config?.features?.weeklyReportQuoteEnabled !== false;
    let msg2 = '*Art arda okumayanlar:*\n';
    if (nonReaders.length > 0) {
      msg2 += nonReaders.map(r => `${r.name} (${r.streak} gün)`).join(',\n');
    } else {
      msg2 += 'Art arda okumayan kullanıcı yok, tebrikler! 🎉';
    }

    // Mesaj 3 (opsiyonel): configKey + groupId kapsamında tekrarsız rastgele söz
    let randomReminder = null;
    if (quoteEnabled) {
      reminderConfigKey = String(config?.configKey || process.env.CONFIG_KEY || '').trim();
      const reminderResult = await reserveRandomReminder(reminderConfigKey, targetGroupId);
      if (reminderResult.success) {
        reservedReminder = reminderResult;
        randomReminder = reminderResult.sentence;
      } else {
        console.warn('⚠️ Haftalık rapor hatırlatması seçilemedi:', reminderResult.message);
      }
    }

    // Mesajları gruba gönder
    await sock.sendMessage(targetGroupId, { text: msg1 });
    // İkinci mesajı kısa bir gecikmeyle gönder
    await new Promise(r => setTimeout(r, 1500));
    await sock.sendMessage(targetGroupId, { text: msg2 });
    // Üçüncü mesaj: rastgele söz (quoteEnabled ise)
    if (randomReminder) {
      await new Promise(r => setTimeout(r, 1500));
      await sock.sendMessage(targetGroupId, { text: randomReminder });
      // Gönderim tamamlandı; hata yakalayıcının bu kaydı serbest bırakmaması gerekir.
      reservedReminder = null;
    }

    const sentAt = getTRDateString();
    console.log(`✅ [Haftalık Rapor] Okuma serisi raporu gönderildi! Okuyanlar: ${readers.length}, Okumayanlar: ${nonReaders.length} [Grup: ${targetGroupId}]`);

    return {
      success: true,
      sentAt,
      readersCount: readers.length,
      nonReadersCount: nonReaders.length,
      reminder: randomReminder,
      groupId: targetGroupId,
      readingGroupId: targetReadingGroupId,
      groupConfigId: config.id || config._id
    };
  } catch (err) {
    if (reservedReminder?.reminderId) {
      await releaseReminderReservation(reminderConfigKey, targetGroupId, reservedReminder.reminderId);
    }
    console.error('❌ Haftalık okuma raporu gönderme hatası:', err);
    return {
      success: false,
      error: 'Haftalık okuma raporu gönderilemedi.'
    };
  }
}

/**
 * Her Cumartesi saat 22:30 TSİ'de haftalık okuma serisi raporunu gönderir.
 * Cron: dakika=30, saat=22, gün=*, ay=*, haftanın günü=6 (Cumartesi)
 */
function scheduleWeeklyReadingReportJob() {
  const job = schedule.scheduleJob({ rule: '30 22 * * 6', tz: 'Europe/Istanbul' }, async () => {
    const zaman = new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
    console.log(`\n[ZAMANLAYICI - ${zaman}] Haftalık okuma serisi raporu gönderimi başlatılıyor...`);
    const results = await runForEnabledGroupConfigs('weeklyReportEnabled', 'Haftalık rapor',
      groupConfig => sendWeeklyReadingReport({ groupConfig }));
    console.log('[ZAMANLAYICI] Haftalık Rapor Gönderim Sonuçları:', results);
  });
  console.log("✅ Okuma Serisi Raporu Zamanlayıcısı Kuruldu: Her Cumartesi saat 22:30 (TSİ)");
  return job;
}

// ============================================================================
// HAFTALIK OKUMA TABLOSU GÖRSELİ (Her Pazartesi 22:30 TSİ)
// ============================================================================

async function sendWeeklyTableImage(options = {}) {
  const config = await resolveSendGroupConfig(options);
  const targetGroupId = config?.groupId;

  if (!config || !targetGroupId) {
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
    const targetReadingGroupId = config.readingGroupId;
    const tableResult = await generateWeeklyTableCanvas(getDB(), targetReadingGroupId, {
      outputFormat: 'jpeg',
      jpegQuality: 90
    });
    const imageBuffer = tableResult.buffer || tableResult;
    const captionText = tableResult.captionText || 'Haftalık okuma tablosu';
    const mimetype = tableResult.mimetype || 'image/jpeg';

    const imageMessage = {
      image: imageBuffer,
      mimetype: mimetype,
      caption: captionText
    };
    if (tableResult.jpegThumbnail) {
      imageMessage.jpegThumbnail = tableResult.jpegThumbnail;
    }
    if (tableResult.width && tableResult.height) {
      imageMessage.width = tableResult.width;
      imageMessage.height = tableResult.height;
    }
    await sock.sendMessage(targetGroupId, imageMessage);

    const sentAt = getTRDateString();
    console.log(`✅ [Haftalık Tablo Resmi] Görsel başarıyla gönderildi! [Grup: ${targetGroupId}]`);

    return {
      success: true,
      sentAt,
      groupId: targetGroupId,
      readingGroupId: targetReadingGroupId,
      groupConfigId: config.id || config._id
    };
  } catch (err) {
    console.error('❌ Haftalık tablo resmi gönderme hatası:', err);
    return {
      success: false,
      error: 'Haftalık tablo görseli gönderilemedi.'
    };
  }
}

/**
 * Her Pazartesi saat 22:30 TSİ'de haftalık okuma tablosu görselini gönderir.
 * Cron: dakika=30, saat=22, gün=*, ay=*, haftanın günü=1 (Pazartesi)
 */
function scheduleWeeklyTableImageJob() {
  const job = schedule.scheduleJob({ rule: '30 22 * * 1', tz: 'Europe/Istanbul' }, async () => {
    const zaman = new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
    console.log(`\n[ZAMANLAYICI - ${zaman}] Haftalık okuma tablosu görseli gönderimi başlatılıyor...`);
    const results = await runForEnabledGroupConfigs('weeklyTableEnabled', 'Haftalık tablo',
      groupConfig => sendWeeklyTableImage({ groupConfig }));
    console.log('[ZAMANLAYICI] Haftalık Tablo Görseli Gönderim Sonuçları:', results);
  });
  console.log("✅ Haftalık Tablo Görseli Zamanlayıcısı Kuruldu: Her Pazartesi saat 22:30 (TSİ)");
  return job;
}

// ============================================================================
// LİG ATLAMA KUTLAMA MESAJLARI (pending_league_congratulations)
// ============================================================================

/**
 * pending_league_congratulations içinden bu gruba ait bekleyen kutlamaları kontrol eder.
 * Oy işlendikten sonra hemen tetiklenir; dakika taraması bağlantı hataları için yedektir.
 * Kullanıcının leagueCongratulationDelivery tercihine göre gruba / kişiye özel gönderir veya atlar.
 */
// Zamanlayıcı, API ve anlık bildirim aynı gönderimi eşzamanlı yapmasın.
let congratulationsTail = Promise.resolve();
function sendLeagueCongratulations(options = {}) {
  const result = congratulationsTail.then(() => sendLeagueCongratulationsOnce(options));
  congratulationsTail = result.catch(() => {});
  return result;
}

async function sendLeagueCongratulationsOnce(options = {}) {
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
    const config = await resolveSendGroupConfig(options);
    if (!config) {
      return { success: false, message: 'Aktif grup eşleşmesi bulunamadı.' };
    }
    if (!config?.features?.leagueCongratulationEnabled) {
      return { success: true, sent: 0, remaining: 0, message: 'Lig kutlama gönderimi pasif (featureLeagueCongratulationEnabled: false).' };
    }

    const targetReadingGroupId = config.readingGroupId;
    if (!targetReadingGroupId) {
      return { success: false, message: 'Eşleşmenin RoTaKip grubu belirlenemedi.' };
    }

    const pending = await getPendingCongratulations(targetReadingGroupId);
    if (!pending || pending.length === 0) {
      return { success: true, sent: 0, remaining: 0, message: 'Bekleyen lig atlama kutlaması yok.' };
    }

    pending.sort((a, b) => {
      const minA = a.leagueMin != null ? Number(a.leagueMin) : 0;
      const minB = b.leagueMin != null ? Number(b.leagueMin) : 0;
      if (minB !== minA) return minB - minA;
      return (a.name || '').trim().localeCompare((b.name || '').trim(), 'tr', { sensitivity: 'base' });
    });

    const doc = pending[0];
    const remaining = pending.length - 1;
    const docIdStr = doc._id ? doc._id.toString() : null;
    if (!docIdStr) {
      return { success: false, message: 'Kutlama belgesinde _id yok.' };
    }

    // Teslimat tercihi — görsel üretiminden önce
    const user = doc.userId
      ? await getReadingGroupUser(targetReadingGroupId, doc.userId)
      : null;
    const delivery = user
      ? user.leagueCongratulationDelivery
      : normalizeLeagueCongratulationDelivery(null);

    // none → görsel üretme, kuyruğu temizle
    if (delivery === 'none') {
      await completeCongratulation(docIdStr, doc.userId, doc.groupId, doc.league);
      console.log(`🏆 [Lig Kutlaması] ${doc.name} → tercih=none, atlandı (kuyruk temizlendi). Kalan: ${remaining}`);
      return {
        success: true,
        sent: 0,
        skipped: 1,
        remaining,
        name: doc.name,
        league: doc.league,
        delivery: 'none',
        readingGroupId: targetReadingGroupId,
        message: 'Kullanıcı tercihi: gönderme (none).'
      };
    }

    // dm → telefon yoksa gruba fallback yok; kuyruğu tüket
    if (delivery === 'dm') {
      const phone = user?.phone || null;
      if (!phone) {
        await completeCongratulation(docIdStr, doc.userId, doc.groupId, doc.league);
        console.warn(`⚠️ [Lig Kutlaması] ${doc.name} → dm tercih edildi ama telefon yok; gruba fallback yok, atlandı. Kalan: ${remaining}`);
        return {
          success: true,
          sent: 0,
          skipped: 1,
          remaining,
          name: doc.name,
          league: doc.league,
          delivery: 'dm',
          readingGroupId: targetReadingGroupId,
          message: 'DM tercih edildi ancak telefon bulunamadı; gruba fallback yok.'
        };
      }

      const dmJid = `${phone}@s.whatsapp.net`;

      try {
        if (typeof sock.getUSyncDevices === 'function') {
          const devices = await sock.getUSyncDevices([sock.user?.id, dmJid].filter(Boolean), false, true);

          // Güncel cihazları bulmak tek başına yeterli değil: eski Signal
          // oturumları auth deposunda duruyorsa Baileys onları tekrar kullanır.
          // Lig DM'leri seyrek olduğu için her gönderimde tüm cihazların
          // oturumunu zorla yenilemek güvenli ve daha dayanıklıdır.
          if (typeof sock.assertSessions === 'function' && jidEncode) {
            const sessionJids = [
              jidNormalizedUser(sock.user?.id),
              dmJid,
              ...devices.map(device => jidEncode(device.user, 's.whatsapp.net', device.device))
            ].filter(Boolean);
            await sock.assertSessions([...new Set(sessionJids)], true);
          }
        }
      } catch (deviceSyncErr) {
        console.warn(`⚠️ [Lig Kutlaması] DM cihaz listesi yenilenemedi; normal gönderim deneniyor: ${deviceSyncErr.message}`);
      }

      let imagePayload;
      try {
        imagePayload = await generateLeagueCongratulationImage({
          name: doc.name,
          league: doc.league,
          leagueMin: doc.leagueMin,
          outputFormat: 'jpeg',
          jpegQuality: 90
        });
      } catch (imgErr) {
        console.error('❌ Lig kutlama görseli üretilemedi, metin mesajına düşülüyor:', imgErr.message);
      }

      try {
        if (imagePayload?.buffer) {
          const imageMessage = {
            image: imagePayload.buffer,
            caption: imagePayload.caption,
            mimetype: imagePayload.mimetype || 'image/png'
          };
          if (imagePayload.jpegThumbnail) {
            imageMessage.jpegThumbnail = imagePayload.jpegThumbnail;
          }
          if (imagePayload.width && imagePayload.height) {
            imageMessage.width = imagePayload.width;
            imageMessage.height = imagePayload.height;
          }
          const sentMessage = await sock.sendMessage(dmJid, imageMessage);
          await rememberSentMessage(sentMessage);
        } else {
          const leagueLower = doc.league ? String(doc.league).toLocaleLowerCase('tr-TR') : 'yeni';
          const leagueMin = doc.leagueMin !== undefined && doc.leagueMin !== null ? doc.leagueMin : '';
          const sentMessage = await sock.sendMessage(dmJid, {
            text: `Lig atlayan arkadaşımızı tebrik ediyoruz! 🎉🎉\n\n⚡${leagueMin} gün - *${doc.name}* ${leagueLower} lige yükseldi.`
          });
          await rememberSentMessage(sentMessage);
        }
      } catch (sendErr) {
        await completeCongratulation(docIdStr, doc.userId, doc.groupId, doc.league);
        console.error(`❌ [Lig Kutlaması] ${doc.name} → DM gönderimi başarısız (gruba fallback yok):`, sendErr.message);
        return {
          success: true,
          sent: 0,
          skipped: 1,
          remaining,
          name: doc.name,
          league: doc.league,
          delivery: 'dm',
          readingGroupId: targetReadingGroupId,
          message: `DM gönderimi başarısız: ${sendErr.message}`
        };
      }

      await completeCongratulation(docIdStr, doc.userId, doc.groupId, doc.league);
      console.log(`🏆 [Lig Kutlaması] ${doc.name} → ${doc.league} görseli DM gönderildi. Kalan: ${remaining} [JID: ${dmJid}]`);
      return {
        success: true,
        sent: 1,
        remaining,
        name: doc.name,
        league: doc.league,
        delivery: 'dm',
        groupId: dmJid,
        readingGroupId: targetReadingGroupId
      };
    }

    // group (varsayılan) → hedef WhatsApp grubuna
    const targetWhatsAppJid = config.groupId;
    if (!targetWhatsAppJid) {
      return { success: false, message: 'Eşleşmenin WhatsApp grubu belirlenemedi.' };
    }

    let imagePayload;
    try {
      imagePayload = await generateLeagueCongratulationImage({
        name: doc.name,
        league: doc.league,
        leagueMin: doc.leagueMin,
        outputFormat: 'jpeg',
        jpegQuality: 90
      });
    } catch (imgErr) {
      console.error('❌ Lig kutlama görseli üretilemedi, metin mesajına düşülüyor:', imgErr.message);
    }

    if (imagePayload?.buffer) {
      const imageMessage = {
        image: imagePayload.buffer,
        caption: imagePayload.caption,
        mimetype: imagePayload.mimetype || 'image/png'
      };
      if (imagePayload.jpegThumbnail) {
        imageMessage.jpegThumbnail = imagePayload.jpegThumbnail;
      }
      if (imagePayload.width && imagePayload.height) {
        imageMessage.width = imagePayload.width;
        imageMessage.height = imagePayload.height;
      }
      await sock.sendMessage(targetWhatsAppJid, imageMessage);
    } else {
      const leagueLower = doc.league ? String(doc.league).toLocaleLowerCase('tr-TR') : 'yeni';
      const leagueMin = doc.leagueMin !== undefined && doc.leagueMin !== null ? doc.leagueMin : '';
      await sock.sendMessage(targetWhatsAppJid, {
        text: `Lig atlayan arkadaşımızı tebrik ediyoruz! 🎉🎉\n\n⚡${leagueMin} gün - *${doc.name}* ${leagueLower} lige yükseldi.`
      });
    }

    await completeCongratulation(docIdStr, doc.userId, doc.groupId, doc.league);
    console.log(`🏆 [Lig Kutlaması] ${doc.name} → ${doc.league} görseli gönderildi. Kalan: ${remaining} [Grup: ${targetWhatsAppJid}]`);

    return {
      success: true,
      sent: 1,
      remaining,
      name: doc.name,
      league: doc.league,
      delivery: 'group',
      groupId: targetWhatsAppJid,
      readingGroupId: targetReadingGroupId,
      groupConfigId: config.id || config._id
    };
  } catch (err) {
    console.error('❌ sendLeagueCongratulations hatası:', err);
    return { success: false, error: 'Lig kutlaması gönderilemedi.' };
  }
}

function scheduleLeagueCongratulationsJob() {
  const job = schedule.scheduleJob('* * * * *', async () => {
    const configs = (await getActiveGroupConfigs())
      .filter(config => config.features?.leagueCongratulationEnabled === true);
    for (const groupConfig of configs) {
      try {
        const res = await sendLeagueCongratulations({ groupConfig });
      if (res.sent > 0) {
        console.log(`[LİG KUTLAMA] ${res.name} (${res.league}) görseli gönderildi [${res.delivery || 'group'}]. Kalan: ${res.remaining}`);
      } else if (res.skipped > 0) {
        console.log(`[LİG KUTLAMA] ${res.name} atlandı (${res.delivery}): ${res.message || ''} Kalan: ${res.remaining}`);
      }
      } catch (error) {
        console.error(`[LİG KUTLAMA] Zamanlayıcı hatası (${groupConfig.readingGroupId}):`, error.message);
      }
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
      groupConfigs: [],
      lastPollSentAt: state.lastPollSentAt,
      lastError: `.env dosyanızda zorunlu değişkenler tanımlanmamış: ${missingEnvs.join(', ')}`,
      engine: 'Baileys Engine'
    };
  }

  if (autoStartIfDisconnected && (state.status === 'DISCONNECTED' || state.status === 'ERROR') && !sock) {
    initWhatsAppClient(false);
  }

  const configs = await getActiveGroupConfigs();
  if (sock && state.status === 'READY' && configs.some(config => !targetGroupInfoById.has(config.groupId))) {
    await fetchTargetGroupInfo();
  }
  const first = configs[0] || null;
  const groupConfigs = configs.map(config => ({
    ...config,
    id: config.id || config._id,
    groupName: targetGroupInfoById.get(config.groupId) || null
  }));

  return {
    status: state.status,
    configKey: process.env.CONFIG_KEY ? process.env.CONFIG_KEY.trim() : null,
    qrDataUrl: state.qrDataUrl,
    userInfo: state.userInfo,
    targetGroup: {
      id: first?.groupId || null,
      name: first ? (targetGroupInfoById.get(first.groupId) || null) : null
    },
    targetReadingGroupId: first?.readingGroupId || null,
    groupConfigs,
    lastPollSentAt: state.lastPollSentAt,
    lastError: state.lastError ? 'WhatsApp bağlantısı kurulamadı. Ayrıntılar sunucu günlüklerine yazıldı.' : null,
    engine: 'Baileys Engine'
  };
}

// ============================================================================
// EXPRESS APP VE API ENDPOINT'LERİ
// ============================================================================

const app = express();
const port = process.env.PORT || 3000;
const DASHBOARD_SESSION_COOKIE = 'dashboard_session';
const DASHBOARD_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const AUTH_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const AUTH_ATTEMPT_LIMIT = 8;
const dashboardSessions = new Map();
const authAttempts = new Map();
const readingGroupAdminGrants = new Map();
const sensitiveActionAttempts = new Map();

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com data:; img-src 'self' data: https:; connect-src 'self'"
  });
  if (isSecureRequest(req)) {
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode >= 500 && body && typeof body === 'object' && body.error) {
      return originalJson({ ...body, error: 'Sunucu işlemi tamamlanamadı.' });
    }
    return originalJson(body);
  };
  next();
});
app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: false, limit: '32kb' }));
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const fetchSite = String(req.get('Sec-Fetch-Site') || '').toLowerCase();
  if (fetchSite === 'cross-site') {
    return res.status(403).json({ success: false, message: 'Çapraz site isteği reddedildi.' });
  }
  const origin = req.get('Origin');
  if (origin) {
    const expectedOrigin = `${req.protocol}://${req.get('host')}`;
    if (origin !== expectedOrigin) {
      return res.status(403).json({ success: false, message: 'İstek kaynağı doğrulanamadı.' });
    }
  }
  next();
});
app.use('/assets', express.static(path.join(__dirname, 'assets')));

// Sağlık kontrolü endpoint'i
app.get('/api/health', (req, res) => {
  res.json({ ok: true, timestamp: Date.now() });
});

function getConfiguredUsername() {
  return String(process.env.CONFIG_KEY || '').trim();
}

function parseCookies(req) {
  const cookies = {};
  const raw = String(req.headers.cookie || '');
  for (const part of raw.split(';')) {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex < 0) continue;
    const name = part.slice(0, separatorIndex).trim();
    const value = part.slice(separatorIndex + 1).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(value);
    } catch (_) {
      cookies[name] = value;
    }
  }
  return cookies;
}

function getDashboardSession(req) {
  const sessionId = parseCookies(req)[DASHBOARD_SESSION_COOKIE];
  if (!sessionId) return null;
  const session = dashboardSessions.get(sessionId);
  if (!session || session.expiresAt <= Date.now() || session.username !== getConfiguredUsername()) {
    dashboardSessions.delete(sessionId);
    return null;
  }
  return { id: sessionId, ...session };
}

function isSecureRequest(req) {
  return req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function setDashboardSessionCookie(req, res, username) {
  const sessionId = crypto.randomBytes(32).toString('hex');
  dashboardSessions.set(sessionId, {
    username,
    createdAt: Date.now(),
    expiresAt: Date.now() + DASHBOARD_SESSION_TTL_MS
  });
  const secure = isSecureRequest(req) ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${DASHBOARD_SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(DASHBOARD_SESSION_TTL_MS / 1000)}${secure}`
  );
}

function clearDashboardSessionCookie(req, res) {
  const session = getDashboardSession(req);
  if (session) {
    dashboardSessions.delete(session.id);
    readingGroupAdminGrants.delete(session.id);
  }
  const secure = isSecureRequest(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${DASHBOARD_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
}

function getAuthAttemptKey(req) {
  return `${req.ip || req.socket?.remoteAddress || 'unknown'}:${getConfiguredUsername()}`;
}

function isAuthRateLimited(req) {
  const key = getAuthAttemptKey(req);
  const current = authAttempts.get(key);
  if (!current || current.resetAt <= Date.now()) {
    authAttempts.delete(key);
    return false;
  }
  return current.count >= AUTH_ATTEMPT_LIMIT;
}

function recordFailedAuth(req) {
  const key = getAuthAttemptKey(req);
  const current = authAttempts.get(key);
  if (!current || current.resetAt <= Date.now()) {
    authAttempts.set(key, { count: 1, resetAt: Date.now() + AUTH_ATTEMPT_WINDOW_MS });
    return;
  }
  current.count += 1;
}

function clearAuthAttempts(req) {
  authAttempts.delete(getAuthAttemptKey(req));
}

const authCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [id, session] of dashboardSessions) {
    if (session.expiresAt <= now) {
      dashboardSessions.delete(id);
      readingGroupAdminGrants.delete(id);
    }
  }
  for (const [key, attempt] of authAttempts) {
    if (attempt.resetAt <= now) authAttempts.delete(key);
  }
  for (const [key, attempt] of sensitiveActionAttempts) {
    if (attempt.resetAt <= now) sensitiveActionAttempts.delete(key);
  }
}, 10 * 60 * 1000);
authCleanupTimer.unref();

app.get('/api/auth/status', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const username = getConfiguredUsername();
    if (!username) {
      return res.status(503).json({ success: false, code: 'MISSING_CONFIG_KEY', message: 'CONFIG_KEY tanımlı değil.' });
    }
    const status = await getDashboardUserStatus(username);
    if (!status.success) return res.status(503).json(status);

    return res.json({
      success: true,
      registered: status.registered,
      authenticated: Boolean(getDashboardSession(req))
    });
  } catch (error) {
    console.error('Panel kullanıcı durumu hatası:', error);
    return res.status(500).json({ success: false, message: 'Kullanıcı durumu kontrol edilemedi.' });
  }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    if (isAuthRateLimited(req)) {
      return res.status(429).json({ success: false, message: 'Çok fazla deneme yapıldı. Lütfen 15 dakika sonra tekrar deneyin.' });
    }

    const username = getConfiguredUsername();
    const submittedUsername = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    if (!username || submittedUsername !== username) {
      recordFailedAuth(req);
      return res.status(400).json({ success: false, message: 'Kullanıcı adı mevcut CONFIG_KEY ile aynı olmalıdır.' });
    }

    const status = await getDashboardUserStatus(username);
    if (!status.success) return res.status(503).json(status);
    if (status.registered) {
      return res.status(409).json({ success: false, code: 'USER_EXISTS', message: 'Bu kullanıcı zaten kayıtlı. Lütfen giriş yapın.' });
    }

    const result = await registerDashboardUser(username, password);
    if (!result.success) {
      recordFailedAuth(req);
      return res.status(result.code === 'USER_EXISTS' ? 409 : 400).json(result);
    }
    clearAuthAttempts(req);
    setDashboardSessionCookie(req, res, username);
    return res.status(201).json({ success: true, username });
  } catch (error) {
    console.error('Panel kullanıcı kayıt hatası:', error);
    return res.status(500).json({ success: false, message: 'Kullanıcı kaydı oluşturulamadı.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    if (isAuthRateLimited(req)) {
      return res.status(429).json({ success: false, message: 'Çok fazla hatalı deneme yapıldı. Lütfen 15 dakika sonra tekrar deneyin.' });
    }

    const username = getConfiguredUsername();
    const submittedUsername = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    if (!username || submittedUsername !== username) {
      recordFailedAuth(req);
      return res.status(401).json({ success: false, message: 'Kullanıcı adı veya şifre hatalı.' });
    }

    const result = await verifyDashboardUser(username, password);
    if (!result.success) {
      recordFailedAuth(req);
      return res.status(401).json(result);
    }
    clearAuthAttempts(req);
    setDashboardSessionCookie(req, res, username);
    return res.json({ success: true, username });
  } catch (error) {
    console.error('Panel kullanıcı giriş hatası:', error);
    return res.status(500).json({ success: false, message: 'Giriş işlemi tamamlanamadı.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  clearDashboardSessionCookie(req, res);
  res.json({ success: true });
});

function requireDashboardAuth(req, res, next) {
  const session = getDashboardSession(req);
  if (!session) {
    return res.status(401).json({ success: false, code: 'AUTH_REQUIRED', message: 'Yönetim paneline erişmek için giriş yapmalısınız.' });
  }
  req.dashboardSession = session;
  next();
}

function grantReadingGroupAdmin(req, readingGroupId, username) {
  const sessionId = req.dashboardSession?.id;
  if (!sessionId) return;
  const grants = readingGroupAdminGrants.get(sessionId) || new Map();
  grants.set(String(readingGroupId), {
    username,
    expiresAt: Date.now() + 30 * 60 * 1000
  });
  readingGroupAdminGrants.set(sessionId, grants);
}

function hasReadingGroupAdminGrant(req, readingGroupId) {
  const sessionId = req.dashboardSession?.id;
  const grant = sessionId ? readingGroupAdminGrants.get(sessionId)?.get(String(readingGroupId)) : null;
  if (!grant || grant.expiresAt <= Date.now()) {
    if (sessionId && grant) readingGroupAdminGrants.get(sessionId)?.delete(String(readingGroupId));
    return false;
  }
  return true;
}

function limitSensitiveAction({ name, limit, windowMs }) {
  return (req, res, next) => {
    const actor = req.dashboardSession?.username || req.ip || req.socket?.remoteAddress || 'unknown';
    const key = `${name}:${actor}`;
    const current = sensitiveActionAttempts.get(key);
    const now = Date.now();
    if (!current || current.resetAt <= now) {
      sensitiveActionAttempts.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (current.count >= limit) {
      return res.status(429).json({ success: false, message: 'Bu işlem için istek sınırına ulaşıldı. Lütfen daha sonra tekrar deneyin.' });
    }
    current.count += 1;
    next();
  };
}

function requireRecentDashboardAuth(req, res, next) {
  if (!req.dashboardSession?.createdAt || Date.now() - req.dashboardSession.createdAt > 15 * 60 * 1000) {
    return res.status(403).json({
      success: false,
      code: 'REAUTH_REQUIRED',
      message: 'Bu kritik işlem için oturumu kapatıp yeniden giriş yapmalısınız.'
    });
  }
  next();
}

async function getAuthorizedGroupConfig(groupConfigId) {
  const groupConfig = await resolveGroupConfigById(groupConfigId);
  if (!groupConfig) {
    return { success: false, status: 404, message: 'Grup eşleşmesi bulunamadı.' };
  }
  return { success: true, groupConfig };
}

async function getAuthorizedTargetGroup(requestedGroupId = null, groupConfigId = null) {
  const requested = String(requestedGroupId || '').trim();
  let groupConfig = groupConfigId ? await resolveGroupConfigById(groupConfigId) : null;
  if (!groupConfig && requested) groupConfig = await resolveGroupConfigForWhatsAppGroup(requested);
  if (!groupConfig) {
    const configs = await getActiveGroupConfigs();
    if (configs.length === 1) groupConfig = configs[0];
  }
  const configuredGroupId = String(groupConfig?.groupId || '').trim();
  if (!configuredGroupId || !configuredGroupId.endsWith('@g.us')) {
    return { success: false, status: 400, message: 'Geçerli bir hedef WhatsApp grubu yapılandırılmamış.' };
  }
  if (requested && requested !== configuredGroupId) {
    return { success: false, status: 403, message: 'Yalnızca yapılandırılmış hedef WhatsApp grubunda işlem yapılabilir.' };
  }
  const participatingGroups = await getWhatsAppGroups();
  if (!participatingGroups.some(group => group.id === configuredGroupId)) {
    return { success: false, status: 403, message: 'Botun katılmadığı bir WhatsApp grubunda işlem yapılamaz.' };
  }
  return { success: true, groupId: configuredGroupId, groupConfig };
}

async function getAuthorizedReadingGroup(req, requestedReadingGroupId = null, requireAdminGrant = false, groupConfigId = null) {
  const requested = String(requestedReadingGroupId || '').trim();
  let groupConfig = groupConfigId ? await resolveGroupConfigById(groupConfigId) : null;
  if (groupConfigId && !groupConfig) {
    return { success: false, status: 404, message: 'Grup eşleşmesi bulunamadı.' };
  }
  if (!groupConfig && requested) {
    const configs = await getActiveGroupConfigs();
    groupConfig = configs.find(config => config.readingGroupId === requested) || null;
  }

  // Yeni bir eşleşme oluşturulurken telefonlar, eşleşme belgesi henüz
  // kaydedilmeden düzenlenebilir. Bu kurulum yolunda okuma grubu yöneticisi
  // doğrulaması, CONFIG_KEY kapsamındaki geçici yetkiyi sağlar.
  const grantedSetupGroupId = !groupConfig && requested && hasReadingGroupAdminGrant(req, requested)
    ? requested
    : '';
  const configuredReadingGroupId = String(groupConfig?.readingGroupId || grantedSetupGroupId).trim();
  if (!configuredReadingGroupId || (requested && requested !== configuredReadingGroupId)) {
    return { success: false, status: 403, message: 'Bu okuma grubu mevcut CONFIG_KEY için yetkili değil.' };
  }
  if (requireAdminGrant && !hasReadingGroupAdminGrant(req, configuredReadingGroupId)) {
    return { success: false, status: 401, message: 'Okuma grubu yönetici doğrulaması gerekli.' };
  }
  return { success: true, readingGroupId: configuredReadingGroupId, groupConfig };
}

app.use('/api', requireDashboardAuth);
app.use('/groupAvatars', requireDashboardAuth, express.static(path.join(__dirname, 'groupAvatars')));
app.use('/userAvatars', requireDashboardAuth, express.static(path.join(__dirname, 'userAvatars')));

// Render'ı uyanık tutmak için ping sistemi
function schedulePing() {
  const pingUrl = process.env.PING_URL;
  const pingJob = schedule.scheduleJob('3/5 * * * *', async () => {
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

// Okuma kaydını bekletmeden kutlama gönderimini sıraya al.
setPromotionHandler(readingGroupId => {
  setImmediate(async () => {
    try {
      const configs = await getActiveGroupConfigs();
      const groupConfig = configs.find(config => config.readingGroupId === readingGroupId);
      if (!groupConfig || groupConfig.features?.leagueCongratulationEnabled !== true) return;
      await sendLeagueCongratulations({ groupConfig });
    } catch (error) {
      console.error('Anlık lig kutlaması hatası:', error.message);
    }
  });
});

// MongoDB bağlantısını kur, ardından WhatsApp istemcisini başlat
(async () => {
  try {
    await connectDB();
  } catch (dbErr) {
    console.error('⚠️ MongoDB başlatılırken hata:', dbErr.message);
  }

  try {
    initWhatsAppClient(true);
    scheduleConfigurableMessagingJobs();
    scheduleWeeklyReadingReportJob();
    scheduleWeeklyTableImageJob();
    scheduleLeagueCongratulationsJob();
  } catch (wpInitErr) {
    console.error("⚠️ WhatsApp servisi başlatılırken hata:", wpInitErr.message);
  }
})();

// WhatsApp API Endpoint'leri
app.get('/api/status', async (req, res) => {
  res.json(await getWhatsAppStatus(false));
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

const PHONE_REQUIRED_FEATURE_KEYS = ['voteTrackingEnabled', 'messageReadingEnabled'];

async function validateFeaturePhoneReadiness(readingGroupId, nextFeatures = {}, previousFeatures = {}, force = false) {
  const requiresPhones = PHONE_REQUIRED_FEATURE_KEYS.some(key =>
    nextFeatures?.[key] === true && (force || previousFeatures?.[key] !== true)
  );
  if (!requiresPhones) return { success: true };
  const phones = await getReadingGroupPhones(readingGroupId);
  if (phones.length > 0) return { success: true };
  const voterLids = await getReadingGroupVoterLids(readingGroupId);
  if (voterLids.length > 0) return { success: true };
  return {
    success: false,
    status: 400,
    code: 'READING_GROUP_PHONE_REQUIRED',
    message: 'Oy takibi veya mesajlardan okuma tespiti için önce telefon numarası ya da voterLid tanımlayın.'
  };
}

function mutationConfig(result) {
  if (!result) return null;
  return result.config || result.groupConfig || (result.success === undefined ? result : null);
}

function sendGroupConfigMutationResult(res, result, successStatus = 200) {
  if (result?.success === false) {
    const status = Number(result.status) || (result.mongoCode === 11000 ? 409 : 400);
    return res.status(status).json(result);
  }
  const config = mutationConfig(result);
  return res.status(successStatus).json({ success: true, config });
}

async function resolveRequestedGroupConfig(groupConfigId, { allowSingle = false } = {}) {
  const id = String(groupConfigId || '').trim();
  if (id) return resolveGroupConfigById(id);
  if (!allowSingle) return null;
  const configs = await getActiveGroupConfigs();
  return configs.length === 1 ? configs[0] : null;
}

async function validateWhatsAppGroupSelection(groupId) {
  const id = String(groupId || '').trim();
  if (!/^[0-9-]{5,40}@g\.us$/.test(id)) {
    return { success: false, status: 400, message: 'Hedef yalnızca geçerli bir WhatsApp grup JID değeri olabilir.' };
  }
  const groups = await getWhatsAppGroups();
  if (!groups.some(group => group.id === id)) {
    return { success: false, status: 403, message: 'Botun katılmadığı bir WhatsApp grubu hedef olarak seçilemez.' };
  }
  return { success: true, groupId: id };
}

async function validateReadingGroupSelection(req, readingGroupId) {
  const id = String(readingGroupId || '').trim();
  if (!id || !hasReadingGroupAdminGrant(req, id)) {
    return { success: false, status: 401, message: 'Yeni okuma grubu için yönetici doğrulaması gerekli.' };
  }
  const groups = await getReadingGroups();
  if (!groups.some(group => String(group.groupId) === id)) {
    return { success: false, status: 403, message: 'Geçersiz okuma grubu.' };
  }
  return { success: true, readingGroupId: id };
}

app.get('/api/group-configs', async (req, res) => {
  try {
    if (!isDBEnabled() || !getDB()) {
      return res.status(503).json({ success: false, message: 'Veritabanı bağlantısı aktif değil.' });
    }
    // Yönetim ekranında DB hatasını "eşleşme yok" diye maskeleme.
    // Zamanlayıcılar toleranslı wrapper'ı kullanmaya devam ederken bu API
    // doğrudan hataya düşer ve arayüz mevcut cache'i korur.
    const configs = await listGroupConfigs(getConfiguredConfigKey());
    return res.json({ success: true, count: configs.length, configs });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/group-configs/:id', async (req, res) => {
  try {
    const scope = await getAuthorizedGroupConfig(req.params.id);
    if (!scope.success) return res.status(scope.status).json(scope);
    return res.json({ success: true, config: scope.groupConfig });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/group-configs', async (req, res) => {
  try {
    const whatsappScope = await validateWhatsAppGroupSelection(req.body?.groupId);
    if (!whatsappScope.success) return res.status(whatsappScope.status).json(whatsappScope);
    const readingScope = await validateReadingGroupSelection(req, req.body?.readingGroupId);
    if (!readingScope.success) return res.status(readingScope.status).json(readingScope);
    const requestedFeatures = { ...DEFAULT_GROUP_CONFIG_FEATURES, ...(req.body?.features || {}) };
    const phoneReadiness = await validateFeaturePhoneReadiness(
      readingScope.readingGroupId,
      requestedFeatures,
      {},
      true
    );
    if (!phoneReadiness.success) return res.status(phoneReadiness.status).json(phoneReadiness);

    const result = await createGroupConfig({
      configKey: getConfiguredConfigKey(),
      groupId: whatsappScope.groupId,
      readingGroupId: readingScope.readingGroupId,
      titleTemplate: req.body?.titleTemplate,
      options: req.body?.options,
      features: requestedFeatures,
      schedules: req.body?.schedules
    });
    if (result?.success !== false && sock && state.status === 'READY') {
      void fetchTargetGroupInfo().catch(error => console.warn('⚠️ Grup adları yenilenemedi:', error.message));
      void ensureLidMappings({ reason: 'settings-save', onlyMissing: true })
        .catch(error => console.warn('⚠️ LID eşleştirmeleri yenilenemedi:', error.message));
    }
    return sendGroupConfigMutationResult(res, result, 201);
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({ success: false, code: 'DUPLICATE_GROUP', message: 'Seçilen gruplardan biri zaten başka bir aktif eşleşmede kullanılıyor.' });
    }
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.patch('/api/group-configs/:id', async (req, res) => {
  try {
    const scope = await getAuthorizedGroupConfig(req.params.id);
    if (!scope.success) return res.status(scope.status).json(scope);
    const current = scope.groupConfig;
    const changes = {};

    const nextGroupId = req.body?.groupId !== undefined
      ? String(req.body.groupId || '').trim()
      : current.groupId;
    if (nextGroupId !== current.groupId) {
      const whatsappScope = await validateWhatsAppGroupSelection(nextGroupId);
      if (!whatsappScope.success) return res.status(whatsappScope.status).json(whatsappScope);
      changes.groupId = whatsappScope.groupId;
    }

    const nextReadingGroupId = req.body?.readingGroupId !== undefined
      ? String(req.body.readingGroupId || '').trim()
      : current.readingGroupId;
    if (nextReadingGroupId !== current.readingGroupId) {
      const readingScope = await validateReadingGroupSelection(req, nextReadingGroupId);
      if (!readingScope.success) return res.status(readingScope.status).json(readingScope);
      changes.readingGroupId = readingScope.readingGroupId;
    }

    if (req.body?.titleTemplate !== undefined) changes.titleTemplate = req.body.titleTemplate;
    if (req.body?.options !== undefined) changes.options = req.body.options;
    if (req.body?.schedules !== undefined) changes.schedules = req.body.schedules;
    const nextFeatures = { ...current.features, ...(req.body?.features || {}) };
    const phoneReadiness = await validateFeaturePhoneReadiness(
      nextReadingGroupId,
      nextFeatures,
      current.features,
      nextReadingGroupId !== current.readingGroupId
    );
    if (!phoneReadiness.success) return res.status(phoneReadiness.status).json(phoneReadiness);
    if (req.body?.features !== undefined) changes.features = req.body.features;

    const result = await updateGroupConfig(req.params.id, changes, getConfiguredConfigKey());
    if (result?.success !== false && sock && state.status === 'READY') {
      void fetchTargetGroupInfo().catch(error => console.warn('⚠️ Grup adları yenilenemedi:', error.message));
      void ensureLidMappings({ reason: 'settings-save', onlyMissing: true })
        .catch(error => console.warn('⚠️ LID eşleştirmeleri yenilenemedi:', error.message));
    }
    return sendGroupConfigMutationResult(res, result);
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({ success: false, code: 'DUPLICATE_GROUP', message: 'Seçilen gruplardan biri zaten başka bir aktif eşleşmede kullanılıyor.' });
    }
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/group-configs/:id', async (req, res) => {
  try {
    const scope = await getAuthorizedGroupConfig(req.params.id);
    if (!scope.success) return res.status(scope.status).json(scope);
    const result = await deleteGroupConfig(req.params.id, getConfiguredConfigKey());
    if (result?.success === false) return res.status(Number(result.status) || 400).json(result);
    targetGroupInfoById.delete(scope.groupConfig.groupId);
    return res.json({ success: true, id: req.params.id });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Okuma grubu yönetici girişi (authority=admin + bcrypt şifre)
app.post('/api/reading-group-admin-login', limitSensitiveAction({ name: 'reading-admin-login', limit: 8, windowMs: 15 * 60 * 1000 }), async (req, res) => {
  try {
    const readingGroupId = req.body?.readingGroupId;
    const username = req.body?.username;
    const password = req.body?.password;
    const readingGroups = await getReadingGroups();
    if (!readingGroups.some(group => String(group.groupId) === String(readingGroupId || '').trim())) {
      return res.status(403).json({ success: false, message: 'Geçersiz okuma grubu.' });
    }
    const result = await verifyReadingGroupAdmin(readingGroupId, username, password);
    if (!result.success) {
      return res.status(401).json(result);
    }
    grantReadingGroupAdmin(req, readingGroupId, result.username);
    res.json({ success: true, readingGroupId, username: result.username });
  } catch (error) {
    console.error('Okuma grubu admin login hatası:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Üye telefon listesi (admin doğrulaması zorunlu)
app.post('/api/reading-group-phones', async (req, res) => {
  try {
    const readingGroupId = req.body?.readingGroupId;
    const scope = await getAuthorizedReadingGroup(req, readingGroupId, true, req.body?.groupConfigId);
    if (!scope.success) {
      return res.status(scope.status).json(scope);
    }
    const users = await listReadingGroupUsersForPhoneEdit(scope.readingGroupId);
    res.json({ success: true, readingGroupId: scope.readingGroupId, users });
  } catch (error) {
    console.error('Okuma grubu telefon listesi hatası:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Üye telefon güncelle (admin doğrulaması zorunlu)
app.put('/api/reading-group-phones/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    const readingGroupId = req.body?.readingGroupId;
    const phone = req.body?.phone;
    const scope = await getAuthorizedReadingGroup(req, readingGroupId, true, req.body?.groupConfigId);
    if (!scope.success) {
      return res.status(scope.status).json(scope);
    }
    const result = await updateReadingGroupUserPhone(scope.readingGroupId, userId, phone);
    if (!result.success) {
      return res.status(400).json(result);
    }
    res.json({ success: true, readingGroupId: scope.readingGroupId, userId, phone: result.phone });
  } catch (error) {
    console.error('Okuma grubu telefon güncelleme hatası:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Telefonu çözülemeyen WhatsApp LID kayıtları (admin doğrulaması zorunlu)
app.post('/api/reading-group-unresolved-lids', async (req, res) => {
  try {
    const readingGroupId = req.body?.readingGroupId;
    const scope = await getAuthorizedReadingGroup(req, readingGroupId, true, req.body?.groupConfigId);
    if (!scope.success) return res.status(scope.status).json(scope);

    const groupId = String(scope.groupConfig?.groupId || '').trim();
    if (!groupId) {
      return res.json({ success: true, readingGroupId: scope.readingGroupId, records: [] });
    }
    const records = await listUnresolvedVoterLids({
      configKey: getConfiguredConfigKey(),
      readingGroupId: scope.readingGroupId,
      groupId,
      limit: 200
    });
    return res.json({ success: true, readingGroupId: scope.readingGroupId, records });
  } catch (error) {
    console.error('Çözülemeyen voterLid listesi hatası:', error);
    return res.status(500).json({ success: false, message: 'LID kayıtları alınamadı.' });
  }
});

// Seçili çözülemeyen LID kaydını sil (admin doğrulaması zorunlu)
app.delete('/api/reading-group-unresolved-lids/:voterLid', async (req, res) => {
  try {
    const voterLid = normalizeVoterLid(req.params.voterLid);
    if (!voterLid) {
      return res.status(400).json({ success: false, message: 'Geçerli bir LID gerekli.' });
    }

    const readingGroupId = req.body?.readingGroupId;
    const scope = await getAuthorizedReadingGroup(req, readingGroupId, true, req.body?.groupConfigId);
    if (!scope.success) return res.status(scope.status).json(scope);

    const groupId = String(scope.groupConfig?.groupId || '').trim();
    if (!groupId) {
      return res.status(400).json({ success: false, message: 'Hedef WhatsApp grubu bulunamadı.' });
    }

    const result = await deleteUnresolvedVoterLid({
      configKey: getConfiguredConfigKey(),
      readingGroupId: scope.readingGroupId,
      groupId,
      voterLid
    });
    if (!result) {
      return res.status(500).json({ success: false, message: 'LID kaydı silinemedi.' });
    }
    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, message: 'LID kaydı bulunamadı.' });
    }
    return res.json({ success: true, voterLid });
  } catch (error) {
    console.error('Çözülemeyen voterLid silme hatası:', error);
    return res.status(500).json({ success: false, message: 'LID kaydı silinemedi.' });
  }
});

// Üye voterLid güncelle (admin doğrulaması zorunlu)
app.put('/api/reading-group-voter-lids/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    const readingGroupId = req.body?.readingGroupId;
    const scope = await getAuthorizedReadingGroup(req, readingGroupId, true, req.body?.groupConfigId);
    if (!scope.success) return res.status(scope.status).json(scope);

    const result = await updateReadingGroupUserVoterLid(
      scope.readingGroupId,
      userId,
      req.body?.voterLid
    );
    if (!result.success) return res.status(400).json(result);

    const groupId = String(scope.groupConfig?.groupId || '').trim();
    if (result.voterLid && groupId) {
      await deleteUnresolvedVoterLid({
        configKey: getConfiguredConfigKey(),
        readingGroupId: scope.readingGroupId,
        groupId,
        voterLid: result.voterLid
      });
    }
    return res.json({
      success: true,
      readingGroupId: scope.readingGroupId,
      userId,
      voterLid: result.voterLid
    });
  } catch (error) {
    console.error('Okuma grubu voterLid güncelleme hatası:', error);
    return res.status(500).json({ success: false, message: 'LID bilgisi güncellenemedi.' });
  }
});

// Bu botun okuma grubuna ait mesaj okuma kayıtlarını getirir.
app.get('/api/text-votes', async (req, res) => {
  try {
    if (!isDBEnabled() || !getDB()) {
      return res.status(503).json({ success: false, message: 'Veritabanı bağlantısı aktif değil.' });
    }

    const config = await resolveRequestedGroupConfig(req.query?.groupConfigId, { allowSingle: true });
    if (!config) {
      return res.status(400).json({ success: false, code: 'GROUP_CONFIG_REQUIRED', message: 'Geçerli bir grup eşleşmesi seçmelisiniz.' });
    }
    const readingGroupId = String(config.readingGroupId || '').trim();
    const groupId = String(config.groupId || '').trim();
    if (!readingGroupId) {
      return res.status(400).json({ success: false, message: 'Hedef okuma grubu ayarlanmamış.' });
    }
    if (!groupId) {
      return res.status(400).json({ success: false, message: 'Hedef WhatsApp grubu ayarlanmamış.' });
    }

    const configKey = process.env.CONFIG_KEY ? process.env.CONFIG_KEY.trim() : null;
    if (!configKey) {
      return res.status(400).json({ success: false, message: 'CONFIG_KEY tanımlı değil.' });
    }
    const requestedLimit = Number(req.query?.limit);
    const limit = Number.isSafeInteger(requestedLimit)
      ? Math.max(1, Math.min(1000, requestedLimit))
      : 500;
    const votes = await listTextVotes(readingGroupId, configKey, groupId, limit);
    const formattedVotes = votes.map(vote => ({
      ...vote,
      _id: vote._id ? String(vote._id) : null,
      updatedAt: vote.updatedAt ? getTRDateString(vote.updatedAt) : null,
      syncedAt: vote.syncedAt ? getTRDateString(vote.syncedAt) : null
    }));

    const statusCounts = formattedVotes.reduce((counts, vote) => {
      const status = vote.syncStatus || 'pending';
      counts[status] = (counts[status] || 0) + 1;
      return counts;
    }, {});

    return res.json({
      success: true,
      readingGroupId,
      groupId,
      groupConfigId: config.id || config._id,
      count: formattedVotes.length,
      statusCounts,
      votes: formattedVotes
    });
  } catch (error) {
    console.error('Metin okuma kayıtları listelenemedi:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Lig Kutlama Teslimat Tercihleri — üye listesi
app.get('/api/league-congratulation-prefs', async (req, res) => {
  try {
    const scope = await getAuthorizedReadingGroup(req, req.query.readingGroupId, true, req.query.groupConfigId);
    if (!scope.success) return res.status(scope.status).json(scope);
    const users = await listReadingGroupUsersForLeaguePrefs(scope.readingGroupId);
    res.json({ success: true, readingGroupId: scope.readingGroupId, users });
  } catch (error) {
    console.error('Lig kutlama prefs listesi hatası:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Lig Kutlama Teslimat Tercihleri — tek kullanıcı güncelle
app.put('/api/league-congratulation-prefs/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    const delivery = req.body?.delivery;
    const scope = await getAuthorizedReadingGroup(
      req,
      req.body?.readingGroupId || req.query.readingGroupId,
      true,
      req.body?.groupConfigId || req.query.groupConfigId
    );
    if (!scope.success) return res.status(scope.status).json(scope);
    const result = await updateLeagueCongratulationDelivery(scope.readingGroupId, userId, delivery);
    if (!result.success) {
      return res.status(400).json(result);
    }
    res.json({ success: true, readingGroupId: scope.readingGroupId, userId, delivery: result.delivery });
  } catch (error) {
    console.error('Lig kutlama prefs güncelleme hatası:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/restart', requireDashboardAuth, limitSensitiveAction({ name: 'whatsapp-restart', limit: 2, windowMs: 15 * 60 * 1000 }), async (req, res) => {
  try {
    await restartWhatsAppClient();
    res.json({ success: true, message: 'WhatsApp istemcisi sıfırlandı ve yeniden başlatılıyor. Yeni QR kod oluşturuluyor...' });
  } catch (error) {
    console.error("WhatsApp restart hatası:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/pairing-code', requireRecentDashboardAuth, limitSensitiveAction({ name: 'pairing-code', limit: 3, windowMs: 15 * 60 * 1000 }), async (req, res) => {
  try {
    if (state.status === 'READY') {
      return res.status(409).json({ success: false, message: 'WhatsApp hesabı zaten bağlı.' });
    }
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
// ANKET VERİTABANI API ENDPOINT'LERİ
// ============================================================================

// Bu bota ait anketleri listele (configKey + groupId)
app.get('/api/polls', async (req, res) => {
  try {
    if (!isDBEnabled() || !getDB()) {
      return res.status(503).json({ success: false, message: 'Veritabanı bağlantısı aktif değil.' });
    }

    const config = await resolveRequestedGroupConfig(req.query?.groupConfigId, { allowSingle: true });
    if (!config) {
      return res.status(400).json({ success: false, code: 'GROUP_CONFIG_REQUIRED', message: 'Geçerli bir grup eşleşmesi seçmelisiniz.', polls: [] });
    }
    const targetGroupId = String(config.groupId || '').trim();
    const configKey = process.env.CONFIG_KEY ? process.env.CONFIG_KEY.trim() : null;
    const readingGroupId = String(config.readingGroupId || '').trim();
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
    if (!readingGroupId) {
      return res.json({ success: false, message: 'Hedef okuma grubu ayarlanmamış.', polls: [] });
    }

    const polls = await listPolls(targetGroupId, configKey, readingGroupId);

    const formattedPolls = polls.map(p => ({
      ...p,
      createdAt: p.createdAt ? getTRDateString(p.createdAt) : p.createdAt
    }));

    res.json({
      success: true,
      count: formattedPolls.length,
      polls: formattedPolls,
      groupId: targetGroupId,
      readingGroupId,
      groupConfigId: config.id || config._id
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Belirli bir ankete ait tüm oyları getir
app.get('/api/poll-votes/:pollId', async (req, res) => {
  try {
    if (!isDBEnabled() || !getDB()) {
      return res.status(503).json({ success: false, message: 'Veritabanı bağlantısı aktif değil.' });
    }

    const { pollId } = req.params;
    const configKey = process.env.CONFIG_KEY ? process.env.CONFIG_KEY.trim() : null;
    const config = await resolveRequestedGroupConfig(req.query?.groupConfigId, { allowSingle: true });
    if (!config) {
      return res.status(400).json({ success: false, code: 'GROUP_CONFIG_REQUIRED', message: 'Geçerli bir grup eşleşmesi seçmelisiniz.' });
    }
    const readingGroupId = String(config.readingGroupId || '').trim();
    const groupId = String(config.groupId || '').trim();
    if (!configKey || !readingGroupId || !groupId) {
      return res.status(400).json({ success: false, message: 'CONFIG_KEY, hedef okuma grubu veya hedef WhatsApp grubu ayarlanmamış.' });
    }

    // Anket bu bota ait mi?
    const poll = await getPollById(pollId, configKey, readingGroupId, groupId);
    if (!poll) {
      return res.json({ success: false, message: 'Anket bulunamadı veya bu bota ait değil.' });
    }
    if (poll.createdAt) {
      poll.createdAt = getTRDateString(poll.createdAt);
    }

    const votes = await listPollVotes(pollId, configKey, readingGroupId, groupId);

    const formattedVotes = votes.map(v => ({
      ...v,
      updatedAt: v.updatedAt ? getTRDateString(v.updatedAt) : v.updatedAt
    }));

    res.json({
      success: true,
      poll,
      voteCount: formattedVotes.length,
      votes: formattedVotes,
      groupConfigId: config.id || config._id
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
