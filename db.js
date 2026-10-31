// ============================================================================
// MongoDB Veritabanı Yönetim Modülü (Anket & Oy Takibi)
// ============================================================================
// MONGO_URI ve DB_NAME .env dosyasında tanımlı değilse tüm DB işlemleri
// sessizce atlanır (no-op). Mevcut bot işleyişi etkilenmez.
// ============================================================================

const { MongoClient } = require('mongodb');
const { randomUUID, createHash } = require('crypto');
const bcrypt = require('bcryptjs');
const { createReadingSync } = require('./readingSync');
const { normalizeVoterLid, voterLidVariants } = require('./whatsappIdentity');
let readingSync = null;
let promotionHandler = () => {};
function setPromotionHandler(handler) { promotionHandler = handler; }

async function syncSavedVote(collection, filter) {
  if (!readingSync) {
    return { status: 'pending', reason: 'sync_not_ready' };
  }
  try {
    return await readingSync.processVote(collection, filter);
  }
  catch (error) {
    // Kuyrukta kalır; yeniden başlatmada veya periyodik taramada tekrar denenir.
    console.error('WA okuma kaydı beklemede:', error.message);
    return { status: 'pending', reason: 'sync_error', error: error.message };
  }
}

let client = null;
let db = null;
let dbEnabled = false;
const DASHBOARD_AUTH_COLLECTION = 'auth-wob';
const REMINDER_STATE_COLLECTION = 'reminder_delivery_state';
const GROUP_CONFIG_COLLECTION = 'group_configs';
const UNRESOLVED_VOTER_LIDS_COLLECTION = 'unresolved_voter_lids';

/**
 * MONGO_URI ve DB_NAME tanımlı mı kontrol eder.
 * Tanımlı değilse tüm DB fonksiyonları sessizce atlanır.
 */
function isDBEnabled() {
  return dbEnabled;
}

/**
 * Aktif veritabanı referansını döner. Bağlantı yoksa null.
 */
function getDB() {
  return db;
}

/**
 * MongoDB Atlas'a bağlanır, gerekli indeksleri oluşturur.
 * MONGO_URI veya DB_NAME yoksa bağlanmaz ve sessizce döner.
 */
async function connectDB() {
  const uri = process.env.MONGO_URI;
  const dbName = process.env.DB_NAME;

  if (!uri || !dbName) {
    console.warn('⚠️ MONGO_URI veya DB_NAME çevre değişkeni .env dosyasında tanımlanmamış. Veritabanı bağlantısı yapılamadı.');
    dbEnabled = false;
    return null;
  }

  try {
    client = new MongoClient(uri);
    await client.connect();
    db = client.db(dbName);
    dbEnabled = true;
    console.log('✅ MongoDB bağlantısı başarılı.');

    await ensureCollectionIndexes();

    readingSync = createReadingSync({
      db,
      onPromotion: groupId => promotionHandler(groupId),
      getScope: async () => {
        const configKey = getConfigKey();
        if (!configKey) return null;
        const configs = await listGroupConfigs(configKey);
        if (configs.length === 0) return null;
        return {
          configKey,
          $or: configs.map(config => ({
            readingGroupId: config.readingGroupId,
            groupId: config.groupId
          }))
        };
      }
    });
    readingSync.start();
    return db;
  } catch (err) {
    console.error('❌ MongoDB bağlantı hatası:', err.message);
    dbEnabled = false;
    return null;
  }
}

/**
 * Gerekli indeksleri oluşturur. polls time-series olduğu için unique indeks kullanılmaz.
 * Sorgu hızlandırma indeksleri best-effort'tur; veri izolasyonu ve
 * benzersizlik sağlayan zorunlu indeksler kurulamazsa DB devre dışı kalır.
 */
async function ensureCollectionIndexes() {
  if (!db) return;

  const createSafeIndex = async (collectionName, keys, options = {}) => {
    try {
      await db.collection(collectionName).createIndex(keys, options);
    } catch (err) {
      console.warn(`⚠️ İndeks oluşturulamadı [${collectionName}]:`, err.message);
    }
  };
  const createRequiredIndex = async (collectionName, keys, options = {}) => {
    try {
      await db.collection(collectionName).createIndex(keys, options);
    } catch (err) {
      console.error(`❌ Zorunlu indeks oluşturulamadı [${collectionName}]:`, err.message);
      throw err;
    }
  };

  // polls: time-series (timeField: createdAt) — unique desteklenmez; sadece sorgular için pollId indeksi
  await createSafeIndex('polls', { pollId: 1 });
  await createSafeIndex('polls', { groupId: 1, configKey: 1, readingGroupId: 1, createdAt: -1 });
  // createdAt zaten time-series timeField; ek indeks gerekmez

  await createSafeIndex('poll_votes', { pollId: 1, voterJid: 1 }, { unique: true });
  await createSafeIndex('poll_votes', { pollId: 1 });
  await createSafeIndex('poll_votes', { configKey: 1, syncedVersion: 1 });
  await createSafeIndex('poll_votes', { pollId: 1, configKey: 1, readingGroupId: 1, groupId: 1, updatedAt: -1 });
  await createSafeIndex(
    UNRESOLVED_VOTER_LIDS_COLLECTION,
    { configKey: 1, readingGroupId: 1, groupId: 1, voterLid: 1 },
    { unique: true }
  );
  await createSafeIndex(UNRESOLVED_VOTER_LIDS_COLLECTION, { updatedAt: -1 });
  await createSafeIndex('pending_league_congratulations', { userId: 1, groupId: 1, league: 1 }, { unique: true });
  await createSafeIndex('pending_league_congratulations', { createdAt: 1 }, { expireAfterSeconds: 3600 });
  await createSafeIndex(REMINDER_STATE_COLLECTION, { configKey: 1, groupId: 1 }, { unique: true });
  await createSafeIndex(DASHBOARD_AUTH_COLLECTION, { username: 1 }, {
    unique: true,
    partialFilterExpression: { username: { $type: 'string' } }
  });
  await createSafeIndex(DASHBOARD_AUTH_COLLECTION, { configKey: 1 }, {
    unique: true,
    partialFilterExpression: { configKey: { $type: 'string' } }
  });
  await createSafeIndex(GROUP_CONFIG_COLLECTION, { configKey: 1, createdAt: 1 });
  await createRequiredIndex(GROUP_CONFIG_COLLECTION, { configKey: 1, groupId: 1 }, {
    unique: true,
    partialFilterExpression: {
      configKey: { $type: 'string' },
      groupId: { $type: 'string' }
    }
  });
  await createRequiredIndex(GROUP_CONFIG_COLLECTION, { configKey: 1, readingGroupId: 1 }, {
    unique: true,
    partialFilterExpression: {
      configKey: { $type: 'string' },
      readingGroupId: { $type: 'string' }
    }
  });
  // text_votes artık WhatsApp grubu ve okuma grubuna göre de ayrılır.
  // Bu indeks veri izolasyonu için zorunludur: kurulamazsa uygulama eski,
  // tek-grup unique indeksiyle çalışıp iki eşleşmenin oylarını çakıştırmamalı.
  await createRequiredIndex(
    'text_votes',
    { configKey: 1, readingGroupId: 1, groupId: 1, voterJid: 1, date: 1 },
    { unique: true }
  );
  try {
    await db.collection('text_votes').dropIndex('configKey_1_voterJid_1_date_1');
  } catch (err) {
    if (err?.codeName !== 'IndexNotFound' && err?.code !== 27) {
      console.error('❌ Eski text_votes unique indeksi kaldırılamadı:', err.message);
      throw err;
    }
  }
  await createSafeIndex('text_votes', { configKey: 1, syncedVersion: 1 });
  await createSafeIndex('text_votes', { readingGroupId: 1, date: -1, updatedAt: -1 });
  await createSafeIndex('text_votes', { configKey: 1, readingGroupId: 1, groupId: 1, date: -1, updatedAt: -1 });

  // Eski sürüm bu birleşik nedeni yalnızca kullanıcı eşleşmediğinde yazıyordu.
  try {
    await db.collection('text_votes').updateMany(
      { syncReason: 'user_not_found_or_invalid_vote' },
      { $set: { syncReason: 'user_not_found' } }
    );
  } catch (err) {
    console.warn('⚠️ Eski text_votes nedenleri güncellenemedi:', err.message);
  }
}

function normalizeDashboardUsername(username) {
  return String(username || '').trim();
}

function normalizeDashboardPasswordForBcrypt(password) {
  return createHash('sha256').update(String(password || ''), 'utf8').digest('hex');
}

/**
 * CONFIG_KEY ile eşleşen yönetim paneli kullanıcısının mevcut olup olmadığını döndürür.
 */
async function getDashboardUserStatus(configKey = getConfigKey()) {
  if (!dbEnabled || !db) {
    return { success: false, message: 'Veritabanı bağlantısı aktif değil.' };
  }

  const username = normalizeDashboardUsername(configKey);
  if (!username) {
    return { success: false, message: 'CONFIG_KEY çevre değişkeni tanımlanmamış.' };
  }

  const user = await db.collection(DASHBOARD_AUTH_COLLECTION).findOne(
    { $or: [{ _id: username }, { username }, { configKey: username }] },
    { projection: { _id: 1 } }
  );
  return { success: true, username, registered: Boolean(user) };
}

/**
 * İlk kurulumda CONFIG_KEY kullanıcısını güvenli parola özetiyle oluşturur.
 * _id alanının CONFIG_KEY olması eşzamanlı iki kaydın oluşmasını da engeller.
 */
async function registerDashboardUser(configKey, password) {
  if (!dbEnabled || !db) {
    return { success: false, message: 'Veritabanı bağlantısı aktif değil.' };
  }

  const username = normalizeDashboardUsername(configKey);
  const pass = String(password || '');
  if (!username) return { success: false, message: 'CONFIG_KEY çevre değişkeni tanımlanmamış.' };
  if (pass.length < 8 || pass.length > 128) {
    return { success: false, message: 'Şifre 8 ile 128 karakter arasında olmalıdır.' };
  }

  const passwordHash = await bcrypt.hash(normalizeDashboardPasswordForBcrypt(pass), 12);
  try {
    await db.collection(DASHBOARD_AUTH_COLLECTION).insertOne({
      _id: username,
      username,
      configKey: username,
      passwordHash,
      passwordHashVersion: 1,
      createdAt: new Date(),
      updatedAt: new Date()
    });
    return { success: true, username };
  } catch (error) {
    if (error?.code === 11000) {
      return { success: false, code: 'USER_EXISTS', message: 'Bu CONFIG_KEY için kullanıcı zaten kayıtlı.' };
    }
    throw error;
  }
}

/**
 * Yönetim paneli kullanıcısını CONFIG_KEY ve bcrypt parola özeti ile doğrular.
 */
async function verifyDashboardUser(configKey, password) {
  if (!dbEnabled || !db) {
    return { success: false, message: 'Veritabanı bağlantısı aktif değil.' };
  }

  const username = normalizeDashboardUsername(configKey);
  const pass = String(password || '');
  if (!username || !pass) return { success: false, message: 'Kullanıcı adı ve şifre gereklidir.' };

  const user = await db.collection(DASHBOARD_AUTH_COLLECTION).findOne({
    $or: [{ _id: username }, { username }, { configKey: username }]
  });
  if (!user?.passwordHash) {
    return { success: false, message: 'Kullanıcı adı veya şifre hatalı.' };
  }

  const bcryptInput = user.passwordHashVersion === 1
    ? normalizeDashboardPasswordForBcrypt(pass)
    : pass;
  const valid = await bcrypt.compare(bcryptInput, String(user.passwordHash));
  if (!valid) return { success: false, message: 'Kullanıcı adı veya şifre hatalı.' };

  await db.collection(DASHBOARD_AUTH_COLLECTION).updateOne(
    { _id: user._id },
    { $set: { lastLoginAt: new Date(), updatedAt: new Date() } }
  );
  return { success: true, username };
}

/**
 * Tarih değerini TSİ (+3 saat) "YYYY-MM-DD HH:mm:ss" formatına dönüştürür.
 * Örn: 2026-08-04T07:04:35.134+00:00 -> 2026-08-04 10:04:35
 */
function getTRDateString(date = new Date()) {
  if (!date) date = new Date();
  if (typeof date === 'string') {
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(date)) {
      return date;
    }
  }
  const d = (date instanceof Date) ? date : new Date(date);
  if (isNaN(d.getTime())) return date;
  const trDate = new Date(d.getTime() + 3 * 60 * 60 * 1000);
  return trDate.toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * Mesaj zamanına göre mantıksal okuma gününü 'YYYY-MM-DD' olarak döner (TSİ +3).
 * 00:00–02:00 arası bir önceki gün sayılır; isYesterday ise bir gün daha geri alınır.
 * @param {Date|number|string} [messageTime] - Mesaj zamanı (varsayılan: şimdi)
 * @param {boolean} [isYesterday=false] - Mesaj "dün" ile başlıyorsa true
 */
function getLogicalReadingDate(messageTime = new Date(), isYesterday = false) {
  let d;
  if (messageTime instanceof Date) {
    d = messageTime;
  } else if (typeof messageTime === 'number') {
    // Baileys messageTimestamp saniye veya ms olabilir
    d = new Date(messageTime < 1e12 ? messageTime * 1000 : messageTime);
  } else {
    d = new Date(messageTime);
  }
  if (isNaN(d.getTime())) d = new Date();

  const tr = new Date(d.getTime() + 3 * 60 * 60 * 1000);
  if (tr.getUTCHours() < 2) {
    tr.setUTCDate(tr.getUTCDate() - 1);
  }
  if (isYesterday) {
    tr.setUTCDate(tr.getUTCDate() - 1);
  }
  return tr.toISOString().slice(0, 10);
}

/**
 * Metin mesajından parse edilen okuma kaydını text_votes koleksiyonuna yazar (upsert).
 * Aynı configKey + readingGroupId + groupId + voterJid + date → güncelleme.
 * @param {Object} voteData - { voterJid, voterPhone, rawLid, selectedOptions, pushName, readingGroupId, groupId, configKey, date, updatedAt }
 */
async function saveTextVote(voteData) {
  if (!dbEnabled || !db) return null;

  try {
    const voterLid = normalizeVoterLid(voteData.voterLid || voteData.rawLid);
    const rawPhone = voteData.voterPhone || (!voterLid ? voteData.voterJid : '');
    const voterPhone = String(rawPhone || '').split('@')[0].split(':')[0].replace(/\D/g, '');
    const validVoterPhone = /^\d{10,15}$/.test(voterPhone) ? voterPhone : '';
    const voterIdentity = validVoterPhone || voterLid;
    const configKey = String(voteData.configKey || '').trim();
    const date = voteData.date;
    if (!date || !voterIdentity || !configKey) return null;

    let readingGroupId = voteData.readingGroupId;
    let groupId = voteData.groupId;
    readingGroupId = readingGroupId ? String(readingGroupId).trim() : null;
    groupId = groupId ? String(groupId).trim() : null;
    if (!readingGroupId || !groupId) return null;

    // Eski LID kaydı varsa ve telefon çözüldüyse temizle
    if (voterLid && voterLid !== validVoterPhone && validVoterPhone) {
      try {
        const lidFilter = {
          date,
          readingGroupId,
          groupId,
          $or: [{ voterJid: voterLid }, { voterPhone: voterLid }, { voterLid }]
        };
        if (configKey) lidFilter.configKey = configKey;
        await db.collection('text_votes').deleteMany(lidFilter);
      } catch (cleanErr) { }
    }

    const setFields = {
      syncVersion: randomUUID(),
      syncStatus: 'pending',
      syncAttempts: 0,
      selectedOptions: voteData.selectedOptions,
      readingGroupId,
      groupId,
      updatedAt: getTRDateString(voteData.updatedAt)
    };
    if (validVoterPhone) setFields.voterPhone = validVoterPhone;
    if (voterLid) setFields.voterLid = voterLid;
    if (voteData.pushName) setFields.pushName = voteData.pushName;
    setFields.configKey = configKey;

    const filter = { voterJid: voterIdentity, date, readingGroupId, groupId, configKey };

    const result = await db.collection('text_votes').updateOne(
      filter,
      {
        $set: setFields,
        $unset: { syncReason: 1, lastSyncError: 1, failedAt: 1, syncedVersion: 1 }
      },
      { upsert: true }
    );
    const syncResult = await syncSavedVote('text_votes', {
      ...filter,
      syncVersion: setFields.syncVersion
    });
    return {
      saved: true,
      writeResult: result,
      syncResult
    };
  } catch (err) {
    console.error('❌ Metin okuma DB kayıt hatası:', err.message);
    return null;
  }
}

/**
 * Anket oluşturulduğunda veritabanına kaydeder.
 * polls time-series olduğu için updateOne/upsert kullanılamaz → insertOne.
 * Aynı pollId varsa önce deleteMany, sonra insertOne (messageData güncellemesi için).
 * @param {Object} pollData - { pollId, groupId, title, options, createdAt, configKey, readingGroupId, messageData }
 */
async function savePoll(pollData) {
  if (!dbEnabled || !db) return null;
  if (!pollData?.pollId) return null;

  try {
    const polls = db.collection('polls');
    const existing = await polls.findOne({ pollId: pollData.pollId });

    let createdAt = new Date();
    if (existing?.createdAt) {
      const prev = existing.createdAt instanceof Date
        ? existing.createdAt
        : new Date(existing.createdAt);
      if (!isNaN(prev.getTime())) createdAt = prev;
    } else if (pollData.createdAt) {
      const d = pollData.createdAt instanceof Date
        ? pollData.createdAt
        : new Date(pollData.createdAt);
      if (!isNaN(d.getTime())) createdAt = d;
    }

    const groupId = pollData.groupId !== undefined ? pollData.groupId : existing?.groupId;
    const configKey = pollData.configKey || existing?.configKey || null;
    const readingGroupId = pollData.readingGroupId || existing?.readingGroupId || null;
    if (!groupId || !configKey || !readingGroupId) return null;

    const doc = {
      pollId: pollData.pollId,
      groupId: String(groupId).trim(),
      configKey: String(configKey).trim(),
      readingGroupId: String(readingGroupId).trim(),
      createdAt
    };
    if (pollData.title !== undefined) doc.title = pollData.title;
    else if (existing?.title !== undefined) doc.title = existing.title;
    if (Array.isArray(pollData.options)) doc.options = pollData.options;
    else if (Array.isArray(existing?.options)) doc.options = existing.options;
    if (pollData.messageData) doc.messageData = pollData.messageData;
    else if (existing?.messageData) doc.messageData = existing.messageData;

    if (existing) {
      await polls.deleteMany({ pollId: pollData.pollId });
    }
    await polls.insertOne(doc);
    return { acknowledged: true };
  } catch (err) {
    console.error('❌ Anket DB kayıt hatası:', err.message);
    return null;
  }
}

/**
 * Oy geldiğinde veritabanına kaydeder (upsert).
 * Aynı kullanıcı aynı ankete tekrar oy verirse günceller.
 * @param {Object} voteData - { pollId, voterJid, voterPhone, rawLid, selectedOptions, pushName, readingGroupId, groupId, configKey, updatedAt }
 */
async function saveVote(voteData) {
  if (!dbEnabled || !db) return null;

  try {
    const voterLid = normalizeVoterLid(voteData.voterLid || voteData.rawLid);
    const rawPhone = voteData.voterPhone || (!voterLid ? voteData.voterJid : '');
    const voterPhone = String(rawPhone || '').split('@')[0].split(':')[0].replace(/\D/g, '');
    const validVoterPhone = /^\d{10,15}$/.test(voterPhone) ? voterPhone : '';
    const voterIdentity = validVoterPhone || voterLid;
    if (!voterIdentity) return null;

    // Eğer önceden LID (ör: 114345098911975) olarak saklanmış eski bir oy varsa ve simdi telefon çözüldüyse eski kaydı temizle
    if (voterLid && voterLid !== validVoterPhone && validVoterPhone) {
      try {
        await db.collection('poll_votes').deleteMany({
          pollId: voteData.pollId,
          $or: [{ voterJid: voterLid }, { voterPhone: voterLid }, { voterLid }]
        });
      } catch (cleanErr) { }
    }

    let readingGroupId = voteData.readingGroupId;
    let groupId = voteData.groupId;
    const configKey = String(voteData.configKey || '').trim();
    readingGroupId = readingGroupId ? String(readingGroupId).trim() : null;
    groupId = groupId ? String(groupId).trim() : null;
    if (!readingGroupId || !groupId || !configKey) return null;

    const setFields = {
      syncVersion: randomUUID(),
      syncStatus: 'pending',
      syncAttempts: 0,
      selectedOptions: voteData.selectedOptions,
      readingGroupId: readingGroupId,
      groupId: groupId,
      updatedAt: getTRDateString(voteData.updatedAt)
    };
    if (validVoterPhone) setFields.voterPhone = validVoterPhone;
    if (voterLid) setFields.voterLid = voterLid;
    if (voteData.pushName) {
      setFields.pushName = voteData.pushName;
    }
    // configKey alanı: farklı kullanıcıların oylarını izole etmek için
    setFields.configKey = configKey;

    const result = await db.collection('poll_votes').updateOne(
      { pollId: voteData.pollId, voterJid: voterIdentity },
      {
        $set: setFields,
        $unset: { syncReason: 1, lastSyncError: 1, failedAt: 1, syncedVersion: 1 }
      },
      { upsert: true }
    );
    await syncSavedVote('poll_votes', { pollId: voteData.pollId, voterJid: voterIdentity });
    const action = result.upsertedCount > 0 ? 'Yeni oy' : 'Oy güncelleme';
    // console.log(`🗳️ ${action}: ${voterPhone} → [${voteData.selectedOptions.join(', ')}] (readingGroupId: ${readingGroupId})`);
    return result;
  } catch (err) {
    console.error('❌ Oy DB kayıt hatası:', err.message);
    return null;
  }
}

/**
 * Kullanıcı oyunu çektiğinde (selectedOptions boş) veritabanından siler.
 * @param {string} pollId - Anket mesaj ID'si
 * @param {string} voterJid - Oy çeken kullanıcının JID'si
 */
/**
 * Kullanıcı oyunu çektiğinde (selectedOptions boş) veritabanından siler.
 * @param {string} pollId - Anket mesaj ID'si
 * @param {string} voterJid - Oy çeken kullanıcının JID'si
 */
async function removeVote(pollId, voterJid) {
  if (!dbEnabled || !db) return null;

  try {
    const result = await db.collection('poll_votes').deleteOne({ pollId, voterJid });
    if (result.deletedCount > 0) {
      // console.log(`🗑️ Oy silindi: ${voterJid} anketten çıktı (${pollId})`);
    }
    return result;
  } catch (err) {
    console.error('❌ Oy silme hatası:', err.message);
    return null;
  }
}

const DEFAULT_POLL_OPTIONS = [
  '5 dakika', '10 dakika', '15 dakika', '20 dakika', '30 dakika',
  '45 dakika', '60 dakika', '75 dakika', '90 dakika', '120 dakika',
  '150 dakika', '180 dakika'
];

const DEFAULT_GROUP_CONFIG_FEATURES = Object.freeze({
  pollEnabled: false,
  voteTrackingEnabled: false,
  messageReadingEnabled: false,
  sentenceEnabled: true,
  weeklyReportEnabled: true,
  weeklyReportQuoteEnabled: true,
  weeklyTableEnabled: true,
  leagueCongratulationEnabled: true,
  esmaulhusnaEnabled: false
});

const DEFAULT_GROUP_CONFIG_SCHEDULES = Object.freeze({
  poll: Object.freeze({ hour: 9, minute: 0 }),
  sentence: Object.freeze({ weekdays: Object.freeze([2, 4]), hour: 22, minute: 30 }),
  esmaulhusna: Object.freeze({ weekdays: Object.freeze([3, 5]), hour: 22, minute: 30 })
});

const GROUP_CONFIG_SCHEDULE_KEYS = Object.freeze(['poll', 'sentence', 'esmaulhusna']);

const GROUP_CONFIG_FEATURE_FIELDS = Object.freeze({
  pollEnabled: 'featurePollEnabled',
  voteTrackingEnabled: 'featureVoteTrackingEnabled',
  messageReadingEnabled: 'featureMessageReadingEnabled',
  sentenceEnabled: 'featureSentenceEnabled',
  weeklyReportEnabled: 'featureWeeklyReportEnabled',
  weeklyReportQuoteEnabled: 'featureWeeklyReportQuoteEnabled',
  weeklyTableEnabled: 'featureWeeklyTableEnabled',
  leagueCongratulationEnabled: 'featureLeagueCongratulationEnabled',
  esmaulhusnaEnabled: 'featureEsmaulhusnaEnabled'
});

function isValidReadingGroupId(value) {
  const id = String(value || '').trim();
  // RoTaKip kimlikleri Türkçe harf içerebilir (örn. catıkatı23).
  // Nokta, boşluk, $ ve diğer koleksiyon-adı enjeksiyon karakterleri reddedilir.
  return /^[\p{L}\p{N}\p{M}_-]{1,100}$/u.test(id);
}

function normalizeConfigKey(passedConfigKey = null) {
  return String(passedConfigKey || getConfigKey() || '').trim();
}

function normalizeGroupConfigFeatures(doc = {}) {
  const features = {};
  for (const [featureName, fieldName] of Object.entries(GROUP_CONFIG_FEATURE_FIELDS)) {
    const fallback = DEFAULT_GROUP_CONFIG_FEATURES[featureName];
    features[featureName] = fallback
      ? doc[fieldName] !== false
      : doc[fieldName] === true;
  }
  return features;
}

function cloneDefaultGroupConfigSchedules() {
  return {
    poll: { ...DEFAULT_GROUP_CONFIG_SCHEDULES.poll },
    sentence: {
      ...DEFAULT_GROUP_CONFIG_SCHEDULES.sentence,
      weekdays: [...DEFAULT_GROUP_CONFIG_SCHEDULES.sentence.weekdays]
    },
    esmaulhusna: {
      ...DEFAULT_GROUP_CONFIG_SCHEDULES.esmaulhusna,
      weekdays: [...DEFAULT_GROUP_CONFIG_SCHEDULES.esmaulhusna.weekdays]
    }
  };
}

function normalizeGroupConfigSchedules(source = {}) {
  const defaults = cloneDefaultGroupConfigSchedules();
  const normalized = {};
  for (const key of GROUP_CONFIG_SCHEDULE_KEYS) {
    const fallback = defaults[key];
    const value = source?.[key];
    const hour = Number.isInteger(value?.hour) && value.hour >= 0 && value.hour <= 23
      ? value.hour
      : fallback.hour;
    const minute = Number.isInteger(value?.minute) && value.minute >= 0 && value.minute <= 59
      ? value.minute
      : fallback.minute;
    normalized[key] = { hour, minute };
    if (key !== 'poll') {
      const weekdays = Array.isArray(value?.weekdays)
        ? [...new Set(value.weekdays.filter(day => Number.isInteger(day) && day >= 1 && day <= 7))]
        : [];
      normalized[key].weekdays = weekdays.length === 2 ? weekdays : [...fallback.weekdays];
    }
  }
  return normalized;
}

function validateGroupConfigSchedules(input, baseSchedules = null) {
  const base = normalizeGroupConfigSchedules(baseSchedules || {});
  if (input === undefined) return { success: true, schedules: base };
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { success: false, code: 'INVALID_GROUP_SCHEDULES', message: 'Zamanlama ayarları geçersiz.' };
  }
  const unknownKey = Object.keys(input).find(key => !GROUP_CONFIG_SCHEDULE_KEYS.includes(key));
  if (unknownKey) {
    return { success: false, code: 'INVALID_GROUP_SCHEDULE', message: `Bilinmeyen zamanlama türü: ${unknownKey}` };
  }

  const schedules = {};
  for (const key of GROUP_CONFIG_SCHEDULE_KEYS) {
    const provided = input[key];
    if (provided !== undefined && (!provided || typeof provided !== 'object' || Array.isArray(provided))) {
      return { success: false, code: 'INVALID_GROUP_SCHEDULE', message: `${key} zamanlaması geçersiz.` };
    }
    const candidate = { ...base[key], ...(provided || {}) };
    if (!Number.isInteger(candidate.hour) || candidate.hour < 0 || candidate.hour > 23 ||
        !Number.isInteger(candidate.minute) || candidate.minute < 0 || candidate.minute > 59) {
      return { success: false, code: 'INVALID_GROUP_SCHEDULE_TIME', message: 'Saat 00:00 ile 23:59 arasında olmalıdır.' };
    }
    schedules[key] = { hour: candidate.hour, minute: candidate.minute };
    if (key !== 'poll') {
      if (!Array.isArray(candidate.weekdays) || candidate.weekdays.length !== 2 ||
          candidate.weekdays.some(day => !Number.isInteger(day) || day < 1 || day > 7) ||
          new Set(candidate.weekdays).size !== 2) {
        return { success: false, code: 'INVALID_GROUP_SCHEDULE_DAYS', message: 'Haftalık gönderimler için iki farklı gün seçilmelidir.' };
      }
      schedules[key].weekdays = [...candidate.weekdays];
    }
  }
  return { success: true, schedules };
}

function normalizeGroupConfigDocument(doc) {
  if (!doc) return null;
  return {
    id: String(doc._id),
    configKey: String(doc.configKey || '').trim(),
    groupId: String(doc.groupId || '').trim(),
    readingGroupId: String(doc.readingGroupId || '').trim(),
    titleTemplate: String(doc.titleTemplate || '{{date}}'),
    options: Array.isArray(doc.options) && doc.options.length > 0
      ? doc.options.map(option => String(option))
      : [...DEFAULT_POLL_OPTIONS],
    features: normalizeGroupConfigFeatures(doc),
    schedules: normalizeGroupConfigSchedules(doc.schedules),
    esmaulhusnaIndex: Number.isInteger(doc.esmaulhusnaIndex) && doc.esmaulhusnaIndex >= 1
      ? doc.esmaulhusnaIndex
      : 1,
    lastPollSentAt: doc.lastPollSentAt || null,
    createdAt: doc.createdAt || null,
    updatedAt: doc.updatedAt || null
  };
}

function validateGroupConfigValues({ groupId, readingGroupId, titleTemplate, options }) {
  if (!groupId || !/^[0-9-]{5,40}@g\.us$/.test(groupId)) {
    return { success: false, code: 'INVALID_WHATSAPP_GROUP', message: 'Geçersiz WhatsApp grup JID değeri.' };
  }
  if (!isValidReadingGroupId(readingGroupId)) {
    return { success: false, code: 'INVALID_READING_GROUP', message: 'Geçersiz okuma grubu kimliği.' };
  }
  if (!titleTemplate || titleTemplate.length > 200) {
    return { success: false, code: 'INVALID_POLL_TITLE', message: 'Anket başlığı şablonu 1 ile 200 karakter arasında olmalıdır.' };
  }
  if (!Array.isArray(options) || options.length < 2 || options.length > 12) {
    return { success: false, code: 'INVALID_POLL_OPTIONS', message: 'Anket seçenekleri 2 ile 12 adet arasında olmalıdır.' };
  }
  if (options.some(option => !option || option.length > 100)) {
    return { success: false, code: 'INVALID_POLL_OPTION', message: 'Anket seçenekleri boş olamaz ve en fazla 100 karakter olabilir.' };
  }
  const normalizedOptions = options.map(option => option.toLocaleLowerCase('tr-TR'));
  if (new Set(normalizedOptions).size !== normalizedOptions.length) {
    return { success: false, code: 'DUPLICATE_POLL_OPTION', message: 'Anket seçenekleri aynı olamaz.' };
  }
  return { success: true };
}

function duplicateGroupConfigResult(error) {
  const duplicateField = error?.keyPattern?.groupId
    ? 'groupId'
    : (error?.keyPattern?.readingGroupId ? 'readingGroupId' : null);
  const message = duplicateField === 'groupId'
    ? 'Bu WhatsApp grubu başka bir aktif eşleşmede kullanılıyor.'
    : (duplicateField === 'readingGroupId'
      ? 'Bu RoTaKip okuma grubu başka bir aktif eşleşmede kullanılıyor.'
      : 'Bu grup eşleşmesi zaten mevcut.');
  return {
    success: false,
    status: 409,
    code: 'DUPLICATE_GROUP_CONFIG',
    mongoCode: 11000,
    duplicateField,
    message
  };
}

async function listGroupConfigs(passedConfigKey = null) {
  if (!dbEnabled || !db) return [];
  const configKey = normalizeConfigKey(passedConfigKey);
  if (!configKey) return [];
  const docs = await db.collection(GROUP_CONFIG_COLLECTION)
    .find({ configKey })
    .sort({ createdAt: 1, _id: 1 })
    .toArray();
  return docs.map(normalizeGroupConfigDocument);
}

async function getGroupConfigById(id, passedConfigKey = null) {
  if (!dbEnabled || !db || !id) return null;
  const configKey = normalizeConfigKey(passedConfigKey);
  if (!configKey) return null;
  const doc = await db.collection(GROUP_CONFIG_COLLECTION).findOne({
    _id: String(id),
    configKey
  });
  return normalizeGroupConfigDocument(doc);
}

async function findGroupConfigByWhatsAppGroup(groupId, passedConfigKey = null) {
  if (!dbEnabled || !db || !groupId) return null;
  const configKey = normalizeConfigKey(passedConfigKey);
  if (!configKey) return null;
  const doc = await db.collection(GROUP_CONFIG_COLLECTION).findOne({
    configKey,
    groupId: String(groupId).trim()
  });
  return normalizeGroupConfigDocument(doc);
}

async function findGroupConfigByReadingGroup(readingGroupId, passedConfigKey = null) {
  if (!dbEnabled || !db || !readingGroupId) return null;
  const configKey = normalizeConfigKey(passedConfigKey);
  if (!configKey) return null;
  const doc = await db.collection(GROUP_CONFIG_COLLECTION).findOne({
    configKey,
    readingGroupId: String(readingGroupId).trim()
  });
  return normalizeGroupConfigDocument(doc);
}

async function findGroupConfigByPair(groupId, readingGroupId, passedConfigKey = null) {
  if (!dbEnabled || !db || !groupId || !readingGroupId) return null;
  const configKey = normalizeConfigKey(passedConfigKey);
  if (!configKey) return null;
  const doc = await db.collection(GROUP_CONFIG_COLLECTION).findOne({
    configKey,
    groupId: String(groupId).trim(),
    readingGroupId: String(readingGroupId).trim()
  });
  return normalizeGroupConfigDocument(doc);
}

async function createGroupConfig(configData = {}) {
  if (!dbEnabled || !db) return { success: false, status: 503, message: 'Veritabanı bağlantısı aktif değil.' };
  const configKey = normalizeConfigKey(configData.configKey);
  if (!configKey) return { success: false, status: 400, code: 'MISSING_CONFIG_KEY', message: 'CONFIG_KEY tanımlanmamış.' };

  const groupId = String(configData.groupId || '').trim();
  const readingGroupId = String(configData.readingGroupId || '').trim();
  const titleTemplate = String(configData.titleTemplate || '{{date}}').trim() || '{{date}}';
  const options = Array.isArray(configData.options)
    ? configData.options.map(option => String(option).trim()).filter(Boolean)
    : [...DEFAULT_POLL_OPTIONS];
  const validation = validateGroupConfigValues({ groupId, readingGroupId, titleTemplate, options });
  if (!validation.success) return { ...validation, status: 400 };
  const scheduleValidation = validateGroupConfigSchedules(configData.schedules);
  if (!scheduleValidation.success) return { ...scheduleValidation, status: 400 };

  const now = new Date();
  const doc = {
    _id: randomUUID(),
    schemaVersion: 3,
    configKey,
    groupId,
    readingGroupId,
    titleTemplate,
    options,
    schedules: scheduleValidation.schedules,
    esmaulhusnaIndex: Number.isInteger(configData.esmaulhusnaIndex) && configData.esmaulhusnaIndex >= 1
      ? configData.esmaulhusnaIndex
      : 1,
    lastPollSentAt: configData.lastPollSentAt || null,
    createdAt: now,
    updatedAt: now
  };
  const requestedFeatures = configData.features || {};
  for (const [featureName, fieldName] of Object.entries(GROUP_CONFIG_FEATURE_FIELDS)) {
    doc[fieldName] = typeof requestedFeatures[featureName] === 'boolean'
      ? requestedFeatures[featureName]
      : DEFAULT_GROUP_CONFIG_FEATURES[featureName];
  }
  if (configData.migratedFromLegacy === true) doc.migratedFromLegacy = true;

  try {
    await db.collection(GROUP_CONFIG_COLLECTION).insertOne(doc);
    return { success: true, config: normalizeGroupConfigDocument(doc) };
  } catch (error) {
    if (error?.code === 11000) return duplicateGroupConfigResult(error);
    console.error('❌ Grup eşleşmesi oluşturma hatası:', error.message);
    return { success: false, status: 500, message: 'Grup eşleşmesi oluşturulamadı.' };
  }
}

async function updateGroupConfig(id, configData = {}, passedConfigKey = null) {
  if (!dbEnabled || !db) return { success: false, status: 503, message: 'Veritabanı bağlantısı aktif değil.' };
  const configKey = normalizeConfigKey(passedConfigKey || configData.configKey);
  if (!configKey || !id) return { success: false, status: 400, message: 'Eşleşme kimliği ve CONFIG_KEY gereklidir.' };

  const collection = db.collection(GROUP_CONFIG_COLLECTION);
  const current = await collection.findOne({ _id: String(id), configKey });
  if (!current) return { success: false, status: 404, code: 'GROUP_CONFIG_NOT_FOUND', message: 'Grup eşleşmesi bulunamadı.' };

  const groupId = configData.groupId === undefined
    ? String(current.groupId || '').trim()
    : String(configData.groupId || '').trim();
  const readingGroupId = configData.readingGroupId === undefined
    ? String(current.readingGroupId || '').trim()
    : String(configData.readingGroupId || '').trim();
  const titleTemplate = configData.titleTemplate === undefined
    ? String(current.titleTemplate || '{{date}}').trim()
    : (String(configData.titleTemplate || '').trim() || '{{date}}');
  const options = configData.options === undefined
    ? (Array.isArray(current.options) ? current.options.map(option => String(option).trim()).filter(Boolean) : [...DEFAULT_POLL_OPTIONS])
    : (Array.isArray(configData.options) ? configData.options.map(option => String(option).trim()).filter(Boolean) : []);
  const validation = validateGroupConfigValues({ groupId, readingGroupId, titleTemplate, options });
  if (!validation.success) return { ...validation, status: 400 };
  const scheduleValidation = validateGroupConfigSchedules(configData.schedules, current.schedules);
  if (!scheduleValidation.success) return { ...scheduleValidation, status: 400 };

  // PATCH semantiğini koru: doğrulama tüm birleşik belge üzerinde yapılır,
  // fakat yalnızca istekte gerçekten bulunan alanlar yazılır. Böylece farklı
  // ekran/sekme eşzamanlı olarak şablon ve özellik güncellediğinde stale bir
  // okuma ilgisiz alanları geri ezmez.
  const setFields = { updatedAt: new Date() };
  if (configData.groupId !== undefined) setFields.groupId = groupId;
  if (configData.readingGroupId !== undefined) setFields.readingGroupId = readingGroupId;
  if (configData.titleTemplate !== undefined) setFields.titleTemplate = titleTemplate;
  if (configData.options !== undefined) setFields.options = options;
  if (configData.schedules !== undefined) {
    setFields.schedules = scheduleValidation.schedules;
    setFields.schemaVersion = 3;
  }
  const features = configData.features || {};
  for (const [featureName, fieldName] of Object.entries(GROUP_CONFIG_FEATURE_FIELDS)) {
    if (typeof features[featureName] === 'boolean') setFields[fieldName] = features[featureName];
  }
  if (Number.isInteger(configData.esmaulhusnaIndex) && configData.esmaulhusnaIndex >= 1) {
    setFields.esmaulhusnaIndex = configData.esmaulhusnaIndex;
  }

  try {
    const result = await collection.updateOne({ _id: String(id), configKey }, { $set: setFields });
    if (result.matchedCount !== 1) {
      return { success: false, status: 404, code: 'GROUP_CONFIG_NOT_FOUND', message: 'Grup eşleşmesi bulunamadı.' };
    }
    return { success: true, config: normalizeGroupConfigDocument({ ...current, ...setFields }) };
  } catch (error) {
    if (error?.code === 11000) return duplicateGroupConfigResult(error);
    console.error('❌ Grup eşleşmesi güncelleme hatası:', error.message);
    return { success: false, status: 500, message: 'Grup eşleşmesi güncellenemedi.' };
  }
}

async function deleteGroupConfig(id, passedConfigKey = null) {
  if (!dbEnabled || !db) return { success: false, status: 503, message: 'Veritabanı bağlantısı aktif değil.' };
  const configKey = normalizeConfigKey(passedConfigKey);
  if (!configKey || !id) return { success: false, status: 400, message: 'Eşleşme kimliği ve CONFIG_KEY gereklidir.' };
  const result = await db.collection(GROUP_CONFIG_COLLECTION).deleteOne({ _id: String(id), configKey });
  if (result.deletedCount !== 1) {
    return { success: false, status: 404, code: 'GROUP_CONFIG_NOT_FOUND', message: 'Grup eşleşmesi bulunamadı.' };
  }
  return { success: true, id: String(id) };
}

async function updateGroupConfigRuntimeState(id, runtimeFields = {}, passedConfigKey = null) {
  if (!dbEnabled || !db) return { success: false, status: 503, message: 'Veritabanı bağlantısı aktif değil.' };
  const configKey = normalizeConfigKey(passedConfigKey);
  if (!configKey || !id) return { success: false, status: 400, message: 'Eşleşme kimliği ve CONFIG_KEY gereklidir.' };
  const setFields = { updatedAt: new Date() };
  if (runtimeFields.lastPollSentAt !== undefined) setFields.lastPollSentAt = runtimeFields.lastPollSentAt;
  if (Number.isInteger(runtimeFields.esmaulhusnaIndex) && runtimeFields.esmaulhusnaIndex >= 1) {
    setFields.esmaulhusnaIndex = runtimeFields.esmaulhusnaIndex;
  }
  try {
    const result = await db.collection(GROUP_CONFIG_COLLECTION).updateOne(
      { _id: String(id), configKey },
      { $set: setFields }
    );
    if (result.matchedCount !== 1) {
      return { success: false, status: 404, code: 'GROUP_CONFIG_NOT_FOUND', message: 'Grup eşleşmesi bulunamadı.' };
    }
    return { success: true, id: String(id), ...setFields };
  } catch (error) {
    console.warn('⚠️ Grup eşleşmesi çalışma durumu güncellenemedi:', error.message);
    return { success: false, status: 500, code: 'GROUP_CONFIG_RUNTIME_UPDATE_FAILED', message: 'Eşleşme çalışma durumu kaydedilemedi.' };
  }
}

async function claimGroupConfigScheduleRun(id, scheduleKey, runSlot, passedConfigKey = null) {
  if (!dbEnabled || !db) return false;
  const configKey = normalizeConfigKey(passedConfigKey);
  const key = String(scheduleKey || '').trim();
  const slot = String(runSlot || '').trim();
  if (!configKey || !id || !GROUP_CONFIG_SCHEDULE_KEYS.includes(key) || !slot) return false;
  const field = `scheduleLastRuns.${key}`;
  try {
    const result = await db.collection(GROUP_CONFIG_COLLECTION).updateOne(
      { _id: String(id), configKey, [field]: { $ne: slot } },
      { $set: { [field]: slot, updatedAt: new Date() } }
    );
    return result.modifiedCount === 1;
  } catch (error) {
    console.warn(`⚠️ ${key} zamanlama çalıştırması rezerve edilemedi:`, error.message);
    return false;
  }
}

async function getPollById(pollId, configKey, readingGroupId, groupId) {
  if (!dbEnabled || !db) return null;
  return db.collection('polls').findOne({ pollId, configKey, readingGroupId, groupId });
}

async function listPolls(groupId, configKey, readingGroupId, limit = 50) {
  if (!dbEnabled || !db) return [];
  return db.collection('polls')
    .find({ groupId, configKey, readingGroupId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();
}

async function listPollVotes(pollId, configKey, readingGroupId, groupId) {
  if (!dbEnabled || !db) return [];
  return db.collection('poll_votes')
    .find({ pollId, configKey, readingGroupId, groupId })
    .sort({ updatedAt: -1 })
    .toArray();
}

async function listTextVotes(readingGroupId, configKey, groupId, limit = 500) {
  if (!dbEnabled || !db) return [];
  const gid = String(readingGroupId || '').trim();
  const key = String(configKey || '').trim();
  const wpGroupId = String(groupId || '').trim();
  if (!gid || !key || !wpGroupId) return [];

  return db.collection('text_votes')
    .find({ readingGroupId: gid, configKey: key, groupId: wpGroupId }, {
      projection: {
        voterJid: 1,
        voterPhone: 1,
        pushName: 1,
        selectedOptions: 1,
        readingGroupId: 1,
        groupId: 1,
        configKey: 1,
        date: 1,
        updatedAt: 1,
        syncedAt: 1,
        syncStatus: 1,
        syncReason: 1,
        syncAttempts: 1,
        lastSyncError: 1
      }
    })
    .sort({ date: -1, updatedAt: -1 })
    .limit(limit)
    .toArray();
}

function getConfigKey() {
  if (process.env.CONFIG_KEY && process.env.CONFIG_KEY.trim() !== '') {
    return process.env.CONFIG_KEY.trim();
  }
  return null;
}

/**
 * Bir okuma grubunda WhatsApp LID ile kullanıcı arar. Aynı LID birden fazla
 * kullanıcıya yanlışlıkla yazılmışsa güvenli biçimde eşleştirme yapmaz.
 */
async function findReadingGroupUserByVoterLid(readingGroupId, voterLid) {
  if (!dbEnabled || !db || !readingGroupId) {
    return { user: null, reason: 'db_not_ready' };
  }

  const gid = String(readingGroupId).trim();
  const bareLid = normalizeVoterLid(voterLid);
  const variants = voterLidVariants(bareLid);
  if (!gid || !bareLid || variants.length === 0) {
    return { user: null, reason: 'invalid_voter_lid' };
  }

  try {
    const matches = await db.collection(`users_${gid}`)
      .find({ voterLid: { $in: variants } })
      .limit(2)
      .toArray();
    if (matches.length === 1) return { user: matches[0], voterLid: bareLid };
    if (matches.length > 1) return { user: null, voterLid: bareLid, reason: 'ambiguous_voter_lid' };
    return { user: null, voterLid: bareLid, reason: 'user_not_found' };
  } catch (error) {
    console.error('❌ voterLid kullanıcı arama hatası:', error.message);
    return { user: null, voterLid: bareLid, reason: 'lookup_error' };
  }
}

/**
 * Telefonu çözülemeyen ve users_ içinde voterLid eşleşmesi bulunmayan kişiyi
 * denetim amacıyla kaydeder. Oy seçimi/poll içeriği bilerek saklanmaz.
 */
async function saveUnresolvedVoterLid(data) {
  if (!dbEnabled || !db) return null;

  const configKey = String(data?.configKey || '').trim();
  const readingGroupId = String(data?.readingGroupId || '').trim();
  const groupId = String(data?.groupId || '').trim();
  const voterLid = normalizeVoterLid(data?.voterLid);
  if (!configKey || !readingGroupId || !groupId || !voterLid) return null;

  const now = getTRDateString(data?.seenAt || new Date());
  const setFields = {
    date: String(data?.date || now.slice(0, 10)).slice(0, 10),
    source: String(data?.source || 'poll').slice(0, 32),
    reason: String(data?.reason || 'user_not_found').slice(0, 64),
    updatedAt: now
  };
  const pushName = String(data?.pushName || '').trim().slice(0, 128);
  const voterUsername = String(data?.voterUsername || '').trim().replace(/^@/, '').slice(0, 128);
  if (pushName) setFields.pushName = pushName;
  if (voterUsername) setFields.voterUsername = voterUsername;

  const filter = { configKey, readingGroupId, groupId, voterLid };
  try {
    return await db.collection(UNRESOLVED_VOTER_LIDS_COLLECTION).updateOne(
      filter,
      {
        $set: setFields,
        $setOnInsert: { createdAt: now }
      },
      { upsert: true }
    );
  } catch (error) {
    console.error('❌ Çözülemeyen voterLid kaydetme hatası:', error.message);
    return null;
  }
}

async function deleteUnresolvedVoterLid({ configKey, readingGroupId, groupId, voterLid }) {
  if (!dbEnabled || !db) return null;
  const bareLid = normalizeVoterLid(voterLid);
  const filter = {
    configKey: String(configKey || '').trim(),
    readingGroupId: String(readingGroupId || '').trim(),
    groupId: String(groupId || '').trim(),
    voterLid: bareLid
  };
  if (Object.values(filter).some(value => !value)) return null;
  try {
    return await db.collection(UNRESOLVED_VOTER_LIDS_COLLECTION).deleteOne(filter);
  } catch (error) {
    console.error('❌ Çözülemeyen voterLid temizleme hatası:', error.message);
    return null;
  }
}

async function listUnresolvedVoterLids({ configKey, readingGroupId, groupId, limit = 100 }) {
  if (!dbEnabled || !db) return [];
  const filter = {
    configKey: String(configKey || '').trim(),
    readingGroupId: String(readingGroupId || '').trim(),
    groupId: String(groupId || '').trim()
  };
  if (Object.values(filter).some(value => !value)) return [];

  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 250);
  try {
    const rows = await db.collection(UNRESOLVED_VOTER_LIDS_COLLECTION)
      .find(filter, {
        projection: {
          voterLid: 1,
          voterUsername: 1,
          pushName: 1,
          date: 1,
          source: 1,
          reason: 1,
          createdAt: 1,
          updatedAt: 1
        }
      })
      .sort({ updatedAt: -1 })
      .limit(safeLimit)
      .toArray();
    return rows.map(row => ({
      voterLid: normalizeVoterLid(row.voterLid),
      voterUsername: row.voterUsername || '',
      pushName: row.pushName || '',
      date: row.date || '',
      source: row.source || '',
      reason: row.reason || '',
      createdAt: row.createdAt || '',
      updatedAt: row.updatedAt || ''
    })).filter(row => row.voterLid);
  } catch (error) {
    console.error('❌ Çözülemeyen voterLid listeleme hatası:', error.message);
    return [];
  }
}

/**
 * LID -> Telefon Numarası eşleşmesini MongoDB'deki lid_mappings koleksiyonuna kalıcı kaydeder.
 * configKey ile izole edilir: farklı kullanıcıların LID eşleşmeleri karışmaz.
 * @param {string} lid - LID değeri
 * @param {string} phone - Telefon numarası
 * @param {string} [configKey] - Konfigürasyon anahtarı (process.env.CONFIG_KEY)
 */
async function saveLidMapping(lid, phone, configKey) {
  if (!dbEnabled || !db || !lid || !phone) return;
  const bareLid = String(lid).split('@')[0].split(':')[0];
  const barePhone = String(phone).split('@')[0].split(':')[0];
  if (bareLid === barePhone || !/^\d{7,15}$/.test(barePhone)) return;

  const setFields = { phone: barePhone, updatedAt: getTRDateString() };
  if (configKey && String(configKey).trim()) {
    setFields.configKey = String(configKey).trim();
  }

  try {
    await db.collection('lid_mappings').updateOne(
      { _id: bareLid },
      { $set: setFields },
      { upsert: true }
    );
  } catch (e) { }
}

/**
 * MongoDB'de saklanan kalıcı LID -> Telefon Numarası haritasını getirir.
 * configKey verilirse sadece o kullanıcıya ait eşleşmeleri getirir.
 * @param {string} [configKey] - Konfigürasyon anahtarı ile filtrele (opsiyonel)
 */
async function getAllLidMappings(configKey) {
  if (!dbEnabled || !db) return {};
  try {
    const query = {};
    if (configKey && String(configKey).trim()) {
      query.configKey = String(configKey).trim();
    }
    const list = await db.collection('lid_mappings').find(query).toArray();
    const map = {};
    for (const item of list) {
      if (item._id && item.phone) {
        map[item._id] = item.phone;
      }
    }
    return map;
  } catch (e) {
    return {};
  }
}

/**
 * users_<readingGroupId> içindeki dolu phone alanlarını normalize edip unique dizi döner.
 * @param {string} readingGroupId
 * @returns {Promise<string[]>} bare telefonlar (örn. 905532148015)
 */
async function getReadingGroupPhones(readingGroupId) {
  if (!dbEnabled || !db || !readingGroupId) return [];
  const gid = String(readingGroupId).trim();
  if (!gid) return [];
  try {
    const users = await db.collection(`users_${gid}`).find(
      { phone: { $exists: true, $nin: [null, ''] } },
      { projection: { phone: 1 } }
    ).toArray();
    const phones = new Set();
    for (const u of users) {
      const bare = String(u.phone || '').split('@')[0].split(':')[0].replace(/\D/g, '');
      if (/^\d{10,15}$/.test(bare)) phones.add(bare);
    }
    return [...phones];
  } catch (e) {
    console.error('❌ getReadingGroupPhones hatası:', e.message);
    return [];
  }
}

/**
 * users_<readingGroupId> içindeki geçerli voterLid değerlerini normalize eder.
 */
async function getReadingGroupVoterLids(readingGroupId) {
  if (!dbEnabled || !db || !readingGroupId) return [];
  const gid = String(readingGroupId).trim();
  if (!gid) return [];
  try {
    const users = await db.collection(`users_${gid}`).find(
      { voterLid: { $exists: true, $nin: [null, ''] } },
      { projection: { voterLid: 1 } }
    ).toArray();
    return [...new Set(users.map(user => normalizeVoterLid(user.voterLid)).filter(Boolean))];
  } catch (error) {
    console.error('❌ getReadingGroupVoterLids hatası:', error.message);
    return [];
  }
}

/**
 * Bu configKey için lid_mappings'te kayıtlı telefon numaralarının set'ini döner.
 * @param {string} [configKey]
 * @returns {Promise<Set<string>>}
 */
async function getMappedPhonesByConfigKey(configKey) {
  const map = await getAllLidMappings(configKey);
  return new Set(Object.values(map).filter(Boolean).map(p => String(p).split('@')[0].split(':')[0]));
}

/**
 * Belirli bir configKey'e ait tüm LID eşleşmelerini siler.
 * Kullanıcı WhatsApp oturumunu kapattığında çağrılır.
 * @param {string} configKey - Konfigürasyon anahtarı
 */
async function deleteLidMappingsByConfigKey(configKey) {
  if (!dbEnabled || !db || !configKey) return;
  try {
    const result = await db.collection('lid_mappings').deleteMany({
      configKey: String(configKey).trim()
    });
    console.log(`🗑️ lid_mappings temizlendi (configKey: ${configKey}): ${result.deletedCount} doküman silindi.`);
  } catch (e) {
    console.error('❌ lid_mappings silme hatası:', e.message);
  }
}

/**
 * RoTaKip usergroups koleksiyonundan tüm okuma gruplarını getirir (private dahil).
 * Grup Ayarları UI'ında okuma grubu seçimi için kullanılır.
 * @returns {Array} Gruplar: [{ groupName, groupId, groupImage, description, visibility }]
 */
async function getReadingGroups() {
  if (!dbEnabled || !db) return [];
  try {
    const groups = await db.collection('usergroups')
      .find({})
      .sort({ groupName: 1 })
      .project({ groupName: 1, groupId: 1, groupImage: 1, description: 1, visibility: 1, _id: 0 })
      .toArray();
    return groups;
  } catch (e) {
    console.error('❌ getReadingGroups hatası:', e.message);
    return [];
  }
}

/**
 * users_<readingGroupId> içinde authority=admin kullanıcısını kullanıcı adı + şifre ile doğrular.
 * @returns {Promise<{success:boolean, username?:string, message?:string}>}
 */
async function verifyReadingGroupAdmin(readingGroupId, username, password) {
  if (!dbEnabled || !db) {
    return { success: false, message: 'Veritabanı bağlantısı aktif değil.' };
  }
  const gid = String(readingGroupId || '').trim();
  const uname = String(username || '').trim();
  const pass = String(password || '');
  if (!gid) return { success: false, message: 'Okuma grubu gerekli.' };
  if (!uname || !pass) return { success: false, message: 'Yönetici adı ve şifre gerekli.' };

  try {
    const bcrypt = require('bcryptjs');
    const usersCollName = `users_${gid}`;
    const admins = await db.collection(usersCollName).find({
      authority: 'admin',
      $or: [
        { username: uname },
        { username: { $regex: `^${uname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } },
        { name: uname },
        { name: { $regex: `^${uname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } }
      ]
    }).toArray();

    if (!admins.length) {
      return { success: false, message: 'Bu grup için yönetici bulunamadı veya bilgiler hatalı.' };
    }

    for (const admin of admins) {
      const hash = admin.userpassword || admin.password || '';
      if (!hash) continue;
      const ok = await bcrypt.compare(pass, String(hash));
      if (ok) {
        return {
          success: true,
          username: admin.username || admin.name || uname
        };
      }
    }
    return { success: false, message: 'Yönetici adı veya şifre hatalı.' };
  } catch (err) {
    console.error('❌ verifyReadingGroupAdmin hatası:', err.message);
    return { success: false, message: 'Yönetici doğrulaması tamamlanamadı.' };
  }
}

/**
 * Telefon düzenleme paneli için kullanıcı listesi (admin doğrulaması çağıran tarafta yapılmalı).
 */
async function listReadingGroupUsersForPhoneEdit(readingGroupId) {
  if (!dbEnabled || !db || !readingGroupId) return [];
  try {
    const usersCollName = `users_${String(readingGroupId).trim()}`;
    const users = await db.collection(usersCollName)
      .find({}, { projection: { name: 1, username: 1, phone: 1, voterLid: 1, authority: 1 } })
      .toArray();

    return users
      .map((u) => {
        const barePhone = u.phone
          ? String(u.phone).split('@')[0].split(':')[0].replace(/\D/g, '')
          : '';
        return {
          id: u._id.toString(),
          name: (u.name || u.username || 'Bilinmeyen').trim(),
          phone: /^\d{10,15}$/.test(barePhone) ? barePhone : (barePhone || ''),
          voterLid: normalizeVoterLid(u.voterLid) || String(u.voterLid || '').trim(),
          authority: u.authority || null
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'tr', { sensitivity: 'base' }));
  } catch (err) {
    console.error('❌ listReadingGroupUsersForPhoneEdit hatası:', err.message);
    return [];
  }
}

/**
 * Kullanıcı telefon numarasını günceller.
 * @returns {Promise<{success:boolean, message?:string, phone?:string|null}>}
 */
async function updateReadingGroupUserPhone(readingGroupId, userId, phone) {
  if (!dbEnabled || !db) {
    return { success: false, message: 'Veritabanı bağlantısı aktif değil.' };
  }
  const gid = String(readingGroupId || '').trim();
  const uid = String(userId || '').trim();
  if (!gid) return { success: false, message: 'readingGroupId gerekli.' };
  if (!uid) return { success: false, message: 'userId gerekli.' };

  let bare = String(phone || '').split('@')[0].split(':')[0].replace(/\D/g, '');
  if (bare === '') {
    bare = null;
  } else if (!/^\d{10,15}$/.test(bare)) {
    return { success: false, message: 'Telefon numarası 10–15 haneli olmalıdır.' };
  }

  try {
    const { ObjectId } = require('mongodb');
    const usersCollName = `users_${gid}`;
    const setFields = bare === null ? { phone: '' } : { phone: bare };
    const result = await db.collection(usersCollName).updateOne(
      { _id: new ObjectId(uid) },
      { $set: setFields }
    );
    if (result.matchedCount === 0) {
      return { success: false, message: 'Kullanıcı bulunamadı.' };
    }
    return { success: true, phone: bare };
  } catch (err) {
    console.error('❌ updateReadingGroupUserPhone hatası:', err.message);
    return { success: false, message: 'Telefon numarası güncellenemedi.' };
  }
}

/**
 * Kullanıcının WhatsApp LID kimliğini günceller. Aynı normalize LID'nin aynı
 * okuma grubunda iki kullanıcıya atanmasına izin verilmez.
 */
async function updateReadingGroupUserVoterLid(readingGroupId, userId, voterLid) {
  if (!dbEnabled || !db) {
    return { success: false, message: 'Veritabanı bağlantısı aktif değil.' };
  }
  const gid = String(readingGroupId || '').trim();
  const uid = String(userId || '').trim();
  if (!gid) return { success: false, message: 'readingGroupId gerekli.' };
  if (!uid) return { success: false, message: 'userId gerekli.' };

  const rawValue = String(voterLid || '').trim();
  const bareLid = rawValue ? normalizeVoterLid(rawValue) : '';
  if (rawValue && !bareLid) {
    return { success: false, message: 'Geçerli bir LID girin (12–20 rakam veya ...@lid).' };
  }

  try {
    const { ObjectId } = require('mongodb');
    if (!ObjectId.isValid(uid)) return { success: false, message: 'Geçersiz kullanıcı kimliği.' };
    const objectId = new ObjectId(uid);
    const users = db.collection(`users_${gid}`);

    if (bareLid) {
      const existingLids = await users.find(
        { _id: { $ne: objectId }, voterLid: { $exists: true, $nin: [null, ''] } },
        { projection: { voterLid: 1, name: 1, username: 1 } }
      ).toArray();
      const duplicate = existingLids.find(user => normalizeVoterLid(user.voterLid) === bareLid);
      if (duplicate) {
        return {
          success: false,
          code: 'DUPLICATE_VOTER_LID',
          message: `Bu LID zaten ${duplicate.name || duplicate.username || 'başka bir üye'} için kayıtlı.`
        };
      }
    }

    const result = await users.updateOne(
      { _id: objectId },
      { $set: { voterLid: bareLid } }
    );
    if (result.matchedCount === 0) {
      return { success: false, message: 'Kullanıcı bulunamadı.' };
    }
    return { success: true, voterLid: bareLid };
  } catch (error) {
    console.error('❌ updateReadingGroupUserVoterLid hatası:', error.message);
    return { success: false, message: 'LID bilgisi güncellenemedi.' };
  }
}

// ============================================================================
// RASTGELE CÜMLE GÖNDERİM FONKSİYONU (Ayetler, Dualar, Hadisler, Hatırlatmalar, Vecizeler)
// ============================================================================

// Koleksiyonlar ve ağırlıklı seçim yüzdeleri (toplam: %100)
// Hatırlatmalar Cumartesi raporunun üçüncü mesajında ayrı gönderilir.
const SENTENCE_COLLECTIONS = [
  { name: 'ayetler', weight: 20 },  // %20
  { name: 'hadisler', weight: 20 },  // %20
  { name: 'dualar', weight: 20 },  // %20
  { name: 'vecizeler', weight: 40 },  // %40
];

/**
 * Ağırlıklı rastgele koleksiyon seçimi.
 * Her koleksiyonun weight değeri seçilme yüzdesini belirler.
 */
function pickWeightedCollection() {
  const totalWeight = SENTENCE_COLLECTIONS.reduce((sum, c) => sum + c.weight, 0);
  let random = Math.random() * totalWeight;

  for (const col of SENTENCE_COLLECTIONS) {
    random -= col.weight;
    if (random <= 0) return col;
  }
  return SENTENCE_COLLECTIONS[0]; // fallback
}

async function getRandomSentence() {
  if (!dbEnabled || !db) return null;

  try {
    // Ağırlıklı rastgele koleksiyon seç
    const selected = pickWeightedCollection();
    const randomCollection = selected.name;

    // MongoDB $sample ile koleksiyondan rastgele bir doküman çek
    const docs = await db.collection(randomCollection).aggregate([{ $sample: { size: 1 } }]).toArray();

    if (!docs || docs.length === 0) {
      console.warn(`⚠️ "${randomCollection}" koleksiyonunda doküman bulunamadı.`);
      return null;
    }

    const doc = docs[0];
    return {
      sentence: doc.sentence,
      collection: randomCollection
    };
  } catch (err) {
    console.error('❌ Rastgele cümle çekme hatası:', err.message);
    return null;
  }
}

// ============================================================================
// OKUMA SERİSİ HESAPLAMA (Haftalık Rapor İçin)
// ============================================================================

/**
 * Türkiye saatine göre bugünün tarihini 'YYYY-MM-DD' formatında döner.
 */
function getTRTodayDate() {
  const now = new Date();
  const trNow = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  return trNow.toISOString().slice(0, 10);
}

/**
 * Verilen tarihin bir gün öncesini 'YYYY-MM-DD' formatında döner.
 */
function getPreviousDay(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

const TR_MONTH_NAMES = [
  'Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran',
  'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'
];

/**
 * Bu ay (TSİ) readingstatuses_<readingGroupId> içindeki amount toplamını döner.
 * amount alanı olmayan dokümanlar toplama girmez.
 * @returns {{ total: number, year: number, month: number, monthName: string } | null}
 */
async function getMonthlyReadingAmountTotal(passedReadingGroupId = null) {
  if (!dbEnabled || !db) return null;

  try {
    const readingGroupId = String(passedReadingGroupId || '').trim();
    if (!readingGroupId) return null;

    const trNow = new Date(Date.now() + 3 * 60 * 60 * 1000);
    const year = trNow.getUTCFullYear();
    const month = trNow.getUTCMonth() + 1; // 1-12
    const monthPrefix = `${year}-${String(month).padStart(2, '0')}`;

    const coll = db.collection(`readingstatuses_${readingGroupId}`);
    const agg = await coll.aggregate([
      {
        $match: {
          date: { $regex: `^${monthPrefix}` },
          amount: { $exists: true, $ne: null, $type: 'number' }
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$amount' },
          count: { $sum: 1 }
        }
      }
    ]).toArray();

    const total = agg[0]?.total != null ? Number(agg[0].total) : 0;
    const count = agg[0]?.count != null ? Number(agg[0].count) : 0;

    // Hiç amount kaydı yoksa ikinci mesaj gönderilmesin
    if (count === 0 || total <= 0) {
      return { total: 0, year, month, monthName: TR_MONTH_NAMES[month - 1], hasAmounts: false };
    }

    return {
      total,
      year,
      month,
      monthName: TR_MONTH_NAMES[month - 1],
      hasAmounts: true
    };
  } catch (err) {
    console.error('❌ getMonthlyReadingAmountTotal hatası:', err.message);
    return null;
  }
}

/**
 * users_<readingGroupId> ve readingstatuses_<readingGroupId> koleksiyonlarını kullanarak
 * her kullanıcı için okuma serisi ve okumama serisini hesaplar.
 * @param {string} passedReadingGroupId - Okuma grubu veritabanı eki.
 */
async function calculateReadingStreaks(passedReadingGroupId = null) {
  if (!dbEnabled || !db) return { readers: [], nonReaders: [] };

  try {
    const readingGroupId = String(passedReadingGroupId || '').trim();
    if (!readingGroupId) return { readers: [], nonReaders: [] };

    const usersCollName = `users_${readingGroupId}`;
    const statusesCollName = `readingstatuses_${readingGroupId}`;

    // 1) Tüm kullanıcıları çek
    const users = await db.collection(usersCollName).find({}).toArray();
    if (!users || users.length === 0) return { readers: [], nonReaders: [] };

    const today = getTRTodayDate();
    const readers = [];
    const nonReaders = [];

    for (const user of users) {
      const userId = user._id.toString();
      const userName = user.name || user.username || 'Bilinmeyen';

      // Kullanıcının tüm okuma dokümanlarını tarihe göre azalan sıralı çek
      const statuses = await db.collection(statusesCollName)
        .find({ userId: userId })
        .sort({ date: -1 })
        .toArray();

      const userStatMap = {};
      const userDates = [];

      if (statuses && statuses.length > 0) {
        for (const s of statuses) {
          userStatMap[s.date] = s.status;
          if (s.date) userDates.push(s.date);
        }
      }

      // Kullanıcının sistemde hiç verisi/dokümanı yoksa geç
      if (userDates.length === 0) continue;

      // Kullanıcının kendi en eski kayıt tarihi (Sınır noktası)
      userDates.sort();
      const userEarliestDate = userDates[0];

      const todayStatus = userStatMap[today];

      // --- 1. Pozitif Okuma Serisi (Active Reading Streak / Zinciri Kırma) ---
      let positiveStreak = 0;
      if (todayStatus === 'okudum') {
        let currentDate = today;
        while (currentDate) {
          if (userStatMap[currentDate] === 'okudum') {
            positiveStreak++;
            currentDate = getPreviousDay(currentDate);
          } else {
            break;
          }
        }
      } else if (todayStatus === 'okumadım') {
        positiveStreak = 0;
      } else {
        // Bugün henüz işaretlenmediyse (Boş/İşaretlenmemiş), dünden başla
        let currentDate = getPreviousDay(today);
        while (currentDate) {
          if (userStatMap[currentDate] === 'okudum') {
            positiveStreak++;
            currentDate = getPreviousDay(currentDate);
          } else {
            break;
          }
        }
      }

      if (positiveStreak >= 1) {
        readers.push({ name: userName, streak: positiveStreak });
      }

      // --- 2. Negatif Okumama Serisi (Consecutive Missed Streak / Art Arda Okumayanlar) ---
      let negativeStreak = 0;
      if (todayStatus === 'okudum') {
        negativeStreak = 0; // Bugün okuduysa okumama serisi yoktur
      } else {
        let currentDate;
        if (todayStatus === 'okumadım') {
          currentDate = today; // Bugün işaretli okumadı, bugünden başla
        } else {
          // Bugün henüz işaretlenmediyse (Boş/İşaretlenmemiş), dünden başla
          currentDate = getPreviousDay(today);
        }

        let count = 0;
        while (currentDate) {
          if (userStatMap[currentDate] === 'okudum') {
            break;
          }

          count++;

          // Kullanıcının kendi en eski kayıt tarihine ulaşıldıysa daha geriye gitme
          if (userEarliestDate && currentDate <= userEarliestDate) {
            break;
          }

          currentDate = getPreviousDay(currentDate);
        }
        negativeStreak = count;
      }

      // Art arda en az 2 gün okumadıysa listeye ekle
      if (negativeStreak > 1) {
        nonReaders.push({ name: userName, streak: negativeStreak });
      }
    }

    // Azalan sırala
    readers.sort((a, b) => b.streak - a.streak);
    nonReaders.sort((a, b) => b.streak - a.streak);

    return { readers, nonReaders };
  } catch (err) {
    console.error('❌ Okuma serisi hesaplama hatası:', err.message);
    return { readers: [], nonReaders: [] };
  }
}

// ============================================================================
// LİG ATLAMA KUTLAMA KUYRUĞU (pending_league_congratulations)
// ============================================================================

/**
 * Kutlanmayı bekleyen lig atlama dokümanlarını getirir.
 * status: 'pending' olanları döner, groupId ile filtrelenebilir.
 * @param {string|null} [filterGroupId] - Belirli bir gruba göre filtrele (opsiyonel)
 * @returns {Array} Bekleyen kutlama dokümanları
 */
async function getPendingCongratulations(filterGroupId = null) {
  if (!dbEnabled || !db) return [];
  try {
    const query = { status: 'pending' };
    if (filterGroupId) {
      query.groupId = filterGroupId;
    }
    const docs = await db.collection('pending_league_congratulations')
      .find(query)
      .sort({ createdAt: 1 }) // En eskiden en yeniye (sıra sıra gönder)
      .toArray();
    return docs;
  } catch (err) {
    console.error('❌ getPendingCongratulations hatası:', err.message);
    return [];
  }
}

/**
 * Bir kutlama dokümanını kuyruğu'ndan siler VE
 * ilgili kullanıcının lastCongratulatedLeague alanını günceller.
 *
 * @param {string} docId          - pending_league_congratulations doküman _id'si
 * @param {string} userId         - Kullanıcı _id'si (string)
 * @param {string} groupId        - RoTaKip reading group ID'si (users_<groupId> koleksiyonu için)
 * @param {string} league         - Yeni kutlanan lig adı
 */
async function completeCongratulation(docId, userId, groupId, league) {
  if (!dbEnabled || !db) return false;
  try {
    const { ObjectId } = require('mongodb');

    // 1. Kuyruğu'ndan sil
    await db.collection('pending_league_congratulations').deleteOne({
      _id: typeof docId === 'string' ? new ObjectId(docId) : docId
    });

    // 2. Kullanıcının lastCongratulatedLeague alanını güncelle
    const usersCollName = `users_${groupId}`;
    await db.collection(usersCollName).updateOne(
      { _id: typeof userId === 'string' ? new ObjectId(userId) : userId },
      { $set: { lastCongratulatedLeague: league } }
    );

    console.log(`✅ Kutlama tamamlandı: userId=${userId}, lig=${league}, grup=${groupId}`);
    return true;
  } catch (err) {
    console.error('❌ completeCongratulation hatası:', err.message);
    return false;
  }
}

// ============================================================================
// LİG KUTLAMA TESLİMAT TERCİHİ (users_<readingGroupId>.leagueCongratulationDelivery)
// ============================================================================

const LEAGUE_CONGRATULATION_DELIVERY_VALUES = ['group', 'dm', 'none'];

/**
 * Teslimat tercihini normalize eder. Alan yoksa / geçersizse 'group'.
 * @param {string|null|undefined} value
 * @returns {'group'|'dm'|'none'}
 */
function normalizeLeagueCongratulationDelivery(value) {
  const v = String(value || '').trim().toLowerCase();
  return LEAGUE_CONGRATULATION_DELIVERY_VALUES.includes(v) ? v : 'group';
}

/**
 * users_<readingGroupId> içinden tek kullanıcıyı getirir.
 * @param {string} readingGroupId
 * @param {string} userId
 * @returns {Promise<{_id:string, name:string, phone:string|null, leagueCongratulationDelivery:'group'|'dm'|'none'}|null>}
 */
async function getReadingGroupUser(readingGroupId, userId) {
  if (!dbEnabled || !db || !readingGroupId || !userId) return null;
  try {
    const { ObjectId } = require('mongodb');
    const usersCollName = `users_${String(readingGroupId).trim()}`;
    const doc = await db.collection(usersCollName).findOne(
      { _id: typeof userId === 'string' ? new ObjectId(userId) : userId },
      { projection: { name: 1, username: 1, phone: 1, leagueCongratulationDelivery: 1 } }
    );
    if (!doc) return null;
    const barePhone = doc.phone
      ? String(doc.phone).split('@')[0].split(':')[0].replace(/\D/g, '')
      : '';
    return {
      _id: doc._id.toString(),
      name: doc.name || doc.username || 'Bilinmeyen',
      phone: /^\d{10,15}$/.test(barePhone) ? barePhone : null,
      leagueCongratulationDelivery: normalizeLeagueCongratulationDelivery(doc.leagueCongratulationDelivery)
    };
  } catch (err) {
    console.error('❌ getReadingGroupUser hatası:', err.message);
    return null;
  }
}

/**
 * Lig kutlama teslimat ayarları paneli için üye listesi.
 * @param {string} readingGroupId
 * @returns {Promise<Array<{id:string, name:string, phone:string|null, delivery:'group'|'dm'|'none'}>>}
 */
async function listReadingGroupUsersForLeaguePrefs(readingGroupId) {
  if (!dbEnabled || !db || !readingGroupId) return [];
  try {
    const usersCollName = `users_${String(readingGroupId).trim()}`;
    const users = await db.collection(usersCollName)
      .find({}, { projection: { name: 1, username: 1, phone: 1, leagueCongratulationDelivery: 1 } })
      .toArray();

    return users
      .map((u) => {
        const barePhone = u.phone
          ? String(u.phone).split('@')[0].split(':')[0].replace(/\D/g, '')
          : '';
        return {
          id: u._id.toString(),
          name: (u.name || u.username || 'Bilinmeyen').trim(),
          phone: /^\d{10,15}$/.test(barePhone) ? barePhone : null,
          delivery: normalizeLeagueCongratulationDelivery(u.leagueCongratulationDelivery)
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'tr', { sensitivity: 'base' }));
  } catch (err) {
    console.error('❌ listReadingGroupUsersForLeaguePrefs hatası:', err.message);
    return [];
  }
}

/**
 * Kullanıcının lig kutlama teslimat tercihini günceller.
 * @param {string} readingGroupId
 * @param {string} userId
 * @param {string} delivery - 'group' | 'dm' | 'none'
 * @returns {Promise<{success:boolean, message?:string, delivery?:string}>}
 */
async function updateLeagueCongratulationDelivery(readingGroupId, userId, delivery) {
  if (!dbEnabled || !db) {
    return { success: false, message: 'Veritabanı bağlantısı aktif değil.' };
  }
  const gid = String(readingGroupId || '').trim();
  const uid = String(userId || '').trim();
  const normalized = String(delivery || '').trim().toLowerCase();

  if (!gid) return { success: false, message: 'readingGroupId gerekli.' };
  if (!uid) return { success: false, message: 'userId gerekli.' };
  if (!LEAGUE_CONGRATULATION_DELIVERY_VALUES.includes(normalized)) {
    return { success: false, message: 'Geçersiz delivery değeri. İzinli: group, dm, none.' };
  }

  try {
    const { ObjectId } = require('mongodb');
    const usersCollName = `users_${gid}`;
    const result = await db.collection(usersCollName).updateOne(
      { _id: new ObjectId(uid) },
      { $set: { leagueCongratulationDelivery: normalized } }
    );
    if (result.matchedCount === 0) {
      return { success: false, message: 'Kullanıcı bulunamadı.' };
    }
    return { success: true, delivery: normalized };
  } catch (err) {
    console.error('❌ updateLeagueCongratulationDelivery hatası:', err.message);
    return { success: false, message: 'Teslimat tercihi güncellenemedi.' };
  }
}

function getReminderScopeId(configKey, groupId) {
  return createHash('sha256')
    .update(`${String(configKey).trim()}\u0000${String(groupId).trim()}`, 'utf8')
    .digest('hex');
}

/**
 * Ortak hatırlatmalar koleksiyonundan, configKey + groupId kapsamındaki mevcut
 * döngüde henüz gönderilmemiş rastgele bir kaydı ayırır. Tüm aktif kayıtlar
 * gönderildiyse yalnızca bu kapsamın reminderSentIds listesi sıfırlanır.
 */
async function reserveRandomReminder(configKey, groupId) {
  if (!dbEnabled || !db) {
    return { success: false, message: 'Veritabanı bağlantısı aktif değil.' };
  }

  const key = String(configKey || '').trim();
  const gid = String(groupId || '').trim();
  if (!key || !gid) {
    return { success: false, message: 'Hatırlatma seçimi için configKey ve groupId gereklidir.' };
  }

  try {
    const reminders = (await db.collection('hatırlatmalar')
      .find(
        { sentence: { $type: 'string' }, active: { $ne: false } },
        { projection: { sentence: 1 } }
      )
      .toArray())
      .filter(item => String(item.sentence || '').trim() !== '');

    if (reminders.length === 0) {
      return { success: false, message: 'Gönderilebilecek aktif hatırlatma bulunamadı.' };
    }

    const scopeId = getReminderScopeId(key, gid);
    const stateCollection = db.collection(REMINDER_STATE_COLLECTION);
    await stateCollection.updateOne(
      { _id: scopeId },
      {
        $setOnInsert: {
          configKey: key,
          groupId: gid,
          reminderSentIds: [],
          cycle: 1,
          createdAt: getTRDateString()
        }
      },
      { upsert: true }
    );

    // Aynı kapsamı kullanan iki süreç varsa aynı kaydı seçmemeleri için seçim
    // addToSet ile atomik olarak sahiplenilir; yarış kaybedilirse tekrar denenir.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const state = await stateCollection.findOne({ _id: scopeId });
      const sentIds = new Set(
        Array.isArray(state?.reminderSentIds)
          ? state.reminderSentIds.map(value => String(value))
          : []
      );
      const available = reminders.filter(item => !sentIds.has(String(item._id)));

      if (available.length === 0) {
        const resetResult = await stateCollection.updateOne(
          { _id: scopeId, reminderSentIds: Array.from(sentIds) },
          {
            $set: { reminderSentIds: [], lastResetAt: getTRDateString() },
            $inc: { cycle: 1 }
          }
        );
        if (resetResult.modifiedCount === 0) continue;
        continue;
      }

      const selected = available[Math.floor(Math.random() * available.length)];
      const reminderId = String(selected._id);
      const claimResult = await stateCollection.updateOne(
        { _id: scopeId, reminderSentIds: { $ne: reminderId } },
        {
          $addToSet: { reminderSentIds: reminderId },
          $set: { updatedAt: getTRDateString() }
        }
      );

      if (claimResult.modifiedCount === 1) {
        return {
          success: true,
          scopeId,
          reminderId,
          sentence: String(selected.sentence).trim(),
          cycle: Number(state?.cycle) || 1
        };
      }
    }

    return { success: false, message: 'Hatırlatma seçimi eşzamanlı işlemler nedeniyle tamamlanamadı.' };
  } catch (err) {
    console.error('❌ reserveRandomReminder hatası:', err.message);
    return { success: false, message: 'Hatırlatma seçilemedi.' };
  }
}

/**
 * Mesaj gönderimi başarısız olursa ayrılan kaydı yeniden seçilebilir yapar.
 */
async function releaseReminderReservation(configKey, groupId, reminderId) {
  if (!dbEnabled || !db) return false;
  const key = String(configKey || '').trim();
  const gid = String(groupId || '').trim();
  const rid = String(reminderId || '').trim();
  if (!key || !gid || !rid) return false;

  try {
    const scopeId = getReminderScopeId(key, gid);
    await db.collection(REMINDER_STATE_COLLECTION).updateOne(
      { _id: scopeId },
      {
        $pull: { reminderSentIds: rid },
        $set: { updatedAt: getTRDateString() }
      }
    );
    return true;
  } catch (err) {
    console.error('❌ releaseReminderReservation hatası:', err.message);
    return false;
  }
}

module.exports = {
  setPromotionHandler,
  connectDB,
  isDBEnabled,
  getDB,
  getDashboardUserStatus,
  registerDashboardUser,
  verifyDashboardUser,
  savePoll,
  saveVote,
  saveTextVote,
  removeVote,
  getPollById,
  listPolls,
  listPollVotes,
  listTextVotes,
  getTRDateString,
  getLogicalReadingDate,
  listGroupConfigs,
  getGroupConfigById,
  findGroupConfigByWhatsAppGroup,
  findGroupConfigByReadingGroup,
  findGroupConfigByPair,
  createGroupConfig,
  updateGroupConfig,
  deleteGroupConfig,
  updateGroupConfigRuntimeState,
  claimGroupConfigScheduleRun,
  DEFAULT_GROUP_CONFIG_FEATURES,
  DEFAULT_GROUP_CONFIG_SCHEDULES,
  validateGroupConfigSchedules,
  isValidReadingGroupId,
  saveLidMapping,
  getAllLidMappings,
  findReadingGroupUserByVoterLid,
  saveUnresolvedVoterLid,
  deleteUnresolvedVoterLid,
  listUnresolvedVoterLids,
  getReadingGroupPhones,
  getReadingGroupVoterLids,
  getMappedPhonesByConfigKey,
  deleteLidMappingsByConfigKey,
  getReadingGroups,
  getRandomSentence,
  calculateReadingStreaks,
  getMonthlyReadingAmountTotal,
  getPendingCongratulations,
  completeCongratulation,
  normalizeLeagueCongratulationDelivery,
  getReadingGroupUser,
  listReadingGroupUsersForLeaguePrefs,
  updateLeagueCongratulationDelivery,
  LEAGUE_CONGRATULATION_DELIVERY_VALUES,
  verifyReadingGroupAdmin,
  listReadingGroupUsersForPhoneEdit,
  updateReadingGroupUserPhone,
  updateReadingGroupUserVoterLid,
  reserveRandomReminder,
  releaseReminderReservation
};
