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

    // Anket ayarları yoksa varsayılan şablonu veritabanına ekle
    await getPollConfig();
    readingSync = createReadingSync({
      db,
      onPromotion: groupId => promotionHandler(groupId),
      getScope: async () => {
        const config = await getPollConfig();
        const configKey = String(config?.configKey || '').trim();
        const readingGroupId = String(config?.readingGroupId || '').trim();
        const groupId = String(config?.groupId || '').trim();
        if (!configKey || !readingGroupId || !groupId) return null;
        return { configKey, readingGroupId, groupId };
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
 * Bir indeks hatası tüm DB bağlantısını düşürmez.
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

  // polls: time-series (timeField: createdAt) — unique desteklenmez; sadece sorgular için pollId indeksi
  await createSafeIndex('polls', { pollId: 1 });
  await createSafeIndex('polls', { groupId: 1, configKey: 1, readingGroupId: 1, createdAt: -1 });
  // createdAt zaten time-series timeField; ek indeks gerekmez

  await createSafeIndex('poll_votes', { pollId: 1, voterJid: 1 }, { unique: true });
  await createSafeIndex('poll_votes', { pollId: 1 });
  await createSafeIndex('poll_votes', { configKey: 1, syncedVersion: 1 });
  await createSafeIndex('poll_votes', { pollId: 1, configKey: 1, readingGroupId: 1, groupId: 1, updatedAt: -1 });
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
  // text_votes artık WhatsApp grubu ve okuma grubuna göre de ayrılır.
  // Önce yeni unique indeksin hazır olduğundan emin ol; oluşturma başarısızsa
  // eski korumayı kaldırma ve uygulamayı benzersiz indeks olmadan bırakma.
  let scopedTextVoteUniqueIndexReady = false;
  try {
    await db.collection('text_votes').createIndex(
      { configKey: 1, readingGroupId: 1, groupId: 1, voterJid: 1, date: 1 },
      { unique: true }
    );
    scopedTextVoteUniqueIndexReady = true;
  } catch (err) {
    console.warn('⚠️ Grup kapsamlı text_votes unique indeksi oluşturulamadı:', err.message);
  }
  if (scopedTextVoteUniqueIndexReady) {
    try {
      await db.collection('text_votes').dropIndex('configKey_1_voterJid_1_date_1');
    } catch (err) {
      if (err?.codeName !== 'IndexNotFound' && err?.code !== 27) {
        console.warn('⚠️ Eski text_votes unique indeksi kaldırılamadı:', err.message);
      }
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
async function getDashboardUserStatus(configKey = getPollConfigKey()) {
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
    const voterPhone = voteData.voterPhone || voteData.voterJid;
    const configKey = voteData.configKey || null;
    const date = voteData.date;
    if (!date || !voterPhone) return null;

    let readingGroupId = voteData.readingGroupId;
    let groupId = voteData.groupId;
    if (!readingGroupId || !groupId) {
      const config = await getPollConfig();
      readingGroupId = readingGroupId || config?.readingGroupId || null;
      groupId = groupId || config?.groupId || null;
    }
    readingGroupId = readingGroupId ? String(readingGroupId).trim() : null;
    groupId = groupId ? String(groupId).trim() : null;
    if (!readingGroupId || !groupId) return null;

    // Eski LID kaydı varsa ve telefon çözüldüyse temizle
    if (voteData.rawLid && voteData.rawLid !== voterPhone && /^\d{10,15}$/.test(voterPhone)) {
      try {
        const lidFilter = {
          date,
          readingGroupId,
          groupId,
          $or: [{ voterJid: voteData.rawLid }, { voterPhone: voteData.rawLid }]
        };
        if (configKey) lidFilter.configKey = configKey;
        await db.collection('text_votes').deleteMany(lidFilter);
      } catch (cleanErr) { }
    }

    const setFields = {
      syncVersion: randomUUID(),
      syncStatus: 'pending',
      syncAttempts: 0,
      voterPhone,
      selectedOptions: voteData.selectedOptions,
      readingGroupId,
      groupId,
      updatedAt: getTRDateString(voteData.updatedAt)
    };
    if (voteData.pushName) setFields.pushName = voteData.pushName;
    if (configKey) setFields.configKey = configKey;

    const filter = { voterJid: voterPhone, date, readingGroupId, groupId };
    if (configKey) filter.configKey = configKey;

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

    const doc = {
      pollId: pollData.pollId,
      groupId: pollData.groupId !== undefined ? pollData.groupId : existing?.groupId,
      createdAt
    };
    if (pollData.title !== undefined) doc.title = pollData.title;
    else if (existing?.title !== undefined) doc.title = existing.title;
    if (Array.isArray(pollData.options)) doc.options = pollData.options;
    else if (Array.isArray(existing?.options)) doc.options = existing.options;
    if (pollData.configKey) doc.configKey = pollData.configKey;
    else if (existing?.configKey) doc.configKey = existing.configKey;
    let readingGroupId = pollData.readingGroupId || existing?.readingGroupId || null;
    if (!readingGroupId) {
      const config = await getPollConfig(pollData.configKey || existing?.configKey || null);
      readingGroupId = config?.readingGroupId || null;
    }
    if (readingGroupId) doc.readingGroupId = String(readingGroupId).trim();
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
    const voterPhone = voteData.voterPhone || voteData.voterJid;

    // Eğer önceden LID (ör: 114345098911975) olarak saklanmış eski bir oy varsa ve simdi telefon çözüldüyse eski kaydı temizle
    if (voteData.rawLid && voteData.rawLid !== voterPhone && /^\d{10,15}$/.test(voterPhone)) {
      try {
        await db.collection('poll_votes').deleteMany({
          pollId: voteData.pollId,
          $or: [{ voterJid: voteData.rawLid }, { voterPhone: voteData.rawLid }]
        });
      } catch (cleanErr) { }
    }

    let readingGroupId = voteData.readingGroupId;
    let groupId = voteData.groupId;
    if (!readingGroupId || !groupId) {
      const config = await getPollConfig();
      readingGroupId = readingGroupId || config?.readingGroupId || null;
      groupId = groupId || config?.groupId || null;
    }
    readingGroupId = readingGroupId ? String(readingGroupId).trim() : null;
    groupId = groupId ? String(groupId).trim() : null;
    if (!readingGroupId || !groupId) return null;

    const setFields = {
      syncVersion: randomUUID(),
      syncStatus: 'pending',
      syncAttempts: 0,
      voterPhone: voterPhone,
      selectedOptions: voteData.selectedOptions,
      readingGroupId: readingGroupId,
      groupId: groupId,
      updatedAt: getTRDateString(voteData.updatedAt)
    };
    if (voteData.pushName) {
      setFields.pushName = voteData.pushName;
    }
    // configKey alanı: farklı kullanıcıların oylarını izole etmek için
    if (voteData.configKey) {
      setFields.configKey = voteData.configKey;
    }

    const result = await db.collection('poll_votes').updateOne(
      { pollId: voteData.pollId, voterJid: voterPhone },
      {
        $set: setFields,
        $unset: { syncReason: 1, lastSyncError: 1, failedAt: 1, syncedVersion: 1 }
      },
      { upsert: true }
    );
    await syncSavedVote('poll_votes', { pollId: voteData.pollId, voterJid: voterPhone });
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

function getPollConfigKey() {
  if (process.env.CONFIG_KEY && process.env.CONFIG_KEY.trim() !== '') {
    return process.env.CONFIG_KEY.trim();
  }
  return null;
}

/**
 * Anket şablon ayarlarını MongoDB'den okur.
 * Doküman yoksa varsayılan değerleri döndürür.
 * @param {string} [passedConfigKey] - İsteğe bağlı konfigürasyon ID'si. Verilmezse CONFIG_KEY kullanılır.
 */
async function getPollConfig(passedConfigKey = null) {
  const configKey = (passedConfigKey && String(passedConfigKey).trim())
    ? String(passedConfigKey).trim()
    : getPollConfigKey();

  if (!configKey) return null;

  const defaultConfig = {
    configKey: configKey,
    titleTemplate: '{{date}}',
    options: DEFAULT_POLL_OPTIONS,
    groupId: null,
    readingGroupId: null
  };

  if (!dbEnabled || !db) return defaultConfig;

  try {
    const doc = await db.collection('poll_config').findOne({ _id: configKey });
    if (!doc) {
      const initialDoc = {
        _id: configKey,
        titleTemplate: defaultConfig.titleTemplate,
        options: defaultConfig.options,
        groupId: defaultConfig.groupId,
        readingGroupId: defaultConfig.readingGroupId,
        featurePollEnabled: false,
        featureVoteTrackingEnabled: false,
        featureMessageReadingEnabled: false,
        featureSentenceEnabled: true,
        featureWeeklyReportEnabled: true,
        featureWeeklyReportQuoteEnabled: true,
        featureWeeklyTableEnabled: true,
        featureLeagueCongratulationEnabled: true,
        featureEsmaulhusnaEnabled: false,
        esmaulhusnaIndex: 1,
        updatedAt: getTRDateString()
      };
      await db.collection('poll_config').updateOne(
        { _id: configKey },
        { $setOnInsert: initialDoc },
        { upsert: true }
      );
      console.log(`📌 poll_config (${configKey}) dokümanı oluşturuldu.`);
      return {
        configKey,
        ...initialDoc,
        features: {
          pollEnabled: false,
          voteTrackingEnabled: false,
          messageReadingEnabled: false,
          sentenceEnabled: true,
          weeklyReportEnabled: true,
          weeklyReportQuoteEnabled: true,
          weeklyTableEnabled: true,
          leagueCongratulationEnabled: true,
          esmaulhusnaEnabled: false
        },
        esmaulhusnaIndex: 1
      };
    }

    return {
      configKey: doc._id || configKey,
      titleTemplate: doc.titleTemplate || defaultConfig.titleTemplate,
      options: (Array.isArray(doc.options) && doc.options.length > 0) ? doc.options : defaultConfig.options,
      groupId: (doc.groupId !== undefined && doc.groupId !== null && String(doc.groupId).trim() !== '') ? String(doc.groupId).trim() : null,
      readingGroupId: (doc.readingGroupId && typeof doc.readingGroupId === 'string' && doc.readingGroupId.trim() !== '') ? String(doc.readingGroupId).trim() : null,
      updatedAt: doc.updatedAt || null,
      esmaulhusnaIndex: (typeof doc.esmaulhusnaIndex === 'number' && doc.esmaulhusnaIndex >= 1) ? doc.esmaulhusnaIndex : 1,
      // Anket/oy/mesaj: yoksa kapalı. Vecize/rapor/tablo/esmaülhüsna: yoksa açık/kapalı.
      features: {
        pollEnabled: doc.featurePollEnabled === true,
        voteTrackingEnabled: doc.featureVoteTrackingEnabled === true,
        messageReadingEnabled: doc.featureMessageReadingEnabled === true,
        sentenceEnabled: doc.featureSentenceEnabled !== false,
        weeklyReportEnabled: doc.featureWeeklyReportEnabled !== false,
        weeklyReportQuoteEnabled: doc.featureWeeklyReportQuoteEnabled !== false,
        weeklyTableEnabled: doc.featureWeeklyTableEnabled !== false,
        leagueCongratulationEnabled: doc.featureLeagueCongratulationEnabled !== false,
        esmaulhusnaEnabled: doc.featureEsmaulhusnaEnabled === true
      }
    };
  } catch (err) {
    console.error(`❌ Anket ayarları okuma hatası (${configKey}):`, err.message);
    return defaultConfig;
  }
}

/**
 * Anket şablon ayarlarını MongoDB'ye kaydeder.
 * @param {Object} configData - { titleTemplate, options, groupId, readingGroupId, configKey, features }
 * features: { pollEnabled, voteTrackingEnabled, messageReadingEnabled, sentenceEnabled, weeklyReportEnabled, weeklyTableEnabled, leagueCongratulationEnabled }
 */
async function savePollConfig(configData) {
  if (!dbEnabled || !db) return { success: false, message: 'Veritabanı bağlantısı aktif değil.' };

  try {
    const configKey = (configData.configKey || configData.configId || '').trim() || getPollConfigKey();

    if (!configKey) {
      return { success: false, message: 'CONFIG_KEY çevre değişkeni tanımlanmamış.' };
    }

    const titleTemplate = (configData.titleTemplate || '').trim() || '{{date}}';
    const options = Array.isArray(configData.options)
      ? configData.options.map(o => String(o).trim()).filter(Boolean)
      : [];

    if (titleTemplate.length > 200) {
      return { success: false, message: 'Anket başlığı şablonu en fazla 200 karakter olabilir.' };
    }
    if (options.some(option => option.length > 100)) {
      return { success: false, message: 'Anket seçenekleri en fazla 100 karakter olabilir.' };
    }

    if (options.length < 2) {
      return { success: false, message: 'En az 2 anket seçeneği eklemelisiniz.' };
    }
    if (options.length > 12) {
      return { success: false, message: 'En fazla 12 anket seçeneği ekleyebilirsiniz.' };
    }

    // Anket seçenekleri aynı olamaz kontrolü
    const seenOptions = new Set();
    const duplicateOptions = [];
    for (const opt of options) {
      const lower = opt.toLowerCase();
      if (seenOptions.has(lower)) {
        if (!duplicateOptions.includes(opt)) duplicateOptions.push(opt);
      } else {
        seenOptions.add(lower);
      }
    }

    if (duplicateOptions.length > 0) {
      return {
        success: false,
        message: `Anket seçenekleri aynı olamaz! Yinelenen seçenekler: ${duplicateOptions.join(', ')}`
      };
    }

    const groupId = (configData.groupId !== undefined && configData.groupId !== null && String(configData.groupId).trim() !== '')
      ? String(configData.groupId).trim()
      : null;

    const readingGroupId = (configData.readingGroupId !== undefined && configData.readingGroupId !== null && String(configData.readingGroupId).trim() !== '')
      ? String(configData.readingGroupId).trim()
      : null;

    if (groupId && !/^[0-9-]{5,40}@g\.us$/.test(groupId)) {
      return { success: false, message: 'Geçersiz WhatsApp grup JID değeri.' };
    }
    if (readingGroupId && !/^[A-Za-z0-9_-]{1,100}$/.test(readingGroupId)) {
      return { success: false, message: 'Geçersiz okuma grubu kimliği.' };
    }

    const setFields = {
      titleTemplate,
      options,
      groupId,
      readingGroupId,
      updatedAt: getTRDateString()
    };

    // Özellik bayrakları — sadece gönderilenleri güncelle (gönderilmeyenler mevcut değerini korur)
    const features = configData.features || {};
    if (typeof features.pollEnabled === 'boolean') setFields.featurePollEnabled = features.pollEnabled;
    if (typeof features.voteTrackingEnabled === 'boolean') setFields.featureVoteTrackingEnabled = features.voteTrackingEnabled;
    if (typeof features.messageReadingEnabled === 'boolean') setFields.featureMessageReadingEnabled = features.messageReadingEnabled;
    if (typeof features.sentenceEnabled === 'boolean') setFields.featureSentenceEnabled = features.sentenceEnabled;
    if (typeof features.weeklyReportEnabled === 'boolean') setFields.featureWeeklyReportEnabled = features.weeklyReportEnabled;
    if (typeof features.weeklyReportQuoteEnabled === 'boolean') setFields.featureWeeklyReportQuoteEnabled = features.weeklyReportQuoteEnabled;
    if (typeof features.weeklyTableEnabled === 'boolean') setFields.featureWeeklyTableEnabled = features.weeklyTableEnabled;
    if (typeof features.leagueCongratulationEnabled === 'boolean') setFields.featureLeagueCongratulationEnabled = features.leagueCongratulationEnabled;
    if (typeof features.esmaulhusnaEnabled === 'boolean') setFields.featureEsmaulhusnaEnabled = features.esmaulhusnaEnabled;

    await db.collection('poll_config').updateOne(
      { _id: configKey },
      { $set: setFields },
      { upsert: true }
    );

    process.env.CONFIG_KEY = configKey;

    return { success: true, config: { configKey, ...setFields } };
  } catch (err) {
    console.error(`❌ Anket ayarları kayıt hatası:`, err.message);
    return { success: false, message: 'Ayarlar kaydedilemedi.' };
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
      .find({}, { projection: { name: 1, username: 1, phone: 1, authority: 1 } })
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
    let readingGroupId = (passedReadingGroupId || '').trim();
    if (!readingGroupId) {
      const config = await getPollConfig();
      readingGroupId = config?.readingGroupId || null;
    }
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
 * @param {string} [passedReadingGroupId] - İsteğe bağlı okuma grubu veritabanı eki. Verilmezse poll_config'den okunur.
 */
async function calculateReadingStreaks(passedReadingGroupId = null) {
  if (!dbEnabled || !db) return { readers: [], nonReaders: [] };

  try {
    let readingGroupId = (passedReadingGroupId || '').trim();
    if (!readingGroupId) {
      const config = await getPollConfig();
      readingGroupId = config?.readingGroupId || null;
    }
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

/**
 * Esmaül Hüsna gönderim sırasını (index) poll_config'te günceller.
 * @param {number} newIndex - 1 ile 99 arasında yeni sıra numarası
 */
async function updateEsmaulhusnaIndex(newIndex) {
  if (!dbEnabled || !db) return { success: false, message: 'Veritabanı bağlantısı aktif değil.' };
  try {
    const configKey = getPollConfigKey();
    if (!configKey) return { success: false, message: 'CONFIG_KEY tanımlanmamış.' };
    await db.collection('poll_config').updateOne(
      { _id: configKey },
      { $set: { esmaulhusnaIndex: newIndex, updatedAt: getTRDateString() } },
      { upsert: true }
    );
    return { success: true, esmaulhusnaIndex: newIndex };
  } catch (err) {
    console.error('❌ updateEsmaulhusnaIndex hatası:', err.message);
    return { success: false, message: 'Esmaül Hüsna sırası güncellenemedi.' };
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
  getPollConfig,
  savePollConfig,
  saveLidMapping,
  getAllLidMappings,
  getReadingGroupPhones,
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
  updateEsmaulhusnaIndex,
  reserveRandomReminder,
  releaseReminderReservation
};
