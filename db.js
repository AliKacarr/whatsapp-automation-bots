// ============================================================================
// MongoDB Veritabanı Yönetim Modülü (Anket & Oy Takibi)
// ============================================================================
// MONGO_URI ve DB_NAME .env dosyasında tanımlı değilse tüm DB işlemleri
// sessizce atlanır (no-op). Mevcut bot işleyişi etkilenmez.
// ============================================================================

const { MongoClient } = require('mongodb');

let client = null;
let db = null;
let dbEnabled = false;

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
    console.log('✅ MongoDB bağlantısı başarılı. Veritabanı:', dbName);

    await ensureCollectionIndexes();

    // Anket ayarları yoksa varsayılan şablonu veritabanına ekle
    await getPollConfig();
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
  // createdAt zaten time-series timeField; ek indeks gerekmez

  await createSafeIndex('poll_votes', { pollId: 1, voterJid: 1 }, { unique: true });
  await createSafeIndex('poll_votes', { pollId: 1 });
  await createSafeIndex('text_votes', { configKey: 1, voterJid: 1, date: 1 }, { unique: true });
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
 * Aynı configKey + voterJid + date → güncelleme.
 * @param {Object} voteData - { voterJid, voterPhone, rawLid, selectedOptions, pushName, readingGroupId, configKey, date, updatedAt }
 */
async function saveTextVote(voteData) {
  if (!dbEnabled || !db) return null;

  try {
    const voterPhone = voteData.voterPhone || voteData.voterJid;
    const configKey = voteData.configKey || null;
    const date = voteData.date;
    if (!date || !voterPhone) return null;

    // Eski LID kaydı varsa ve telefon çözüldüyse temizle
    if (voteData.rawLid && voteData.rawLid !== voterPhone && /^\d{10,15}$/.test(voterPhone)) {
      try {
        const lidFilter = {
          date,
          $or: [{ voterJid: voteData.rawLid }, { voterPhone: voteData.rawLid }]
        };
        if (configKey) lidFilter.configKey = configKey;
        await db.collection('text_votes').deleteMany(lidFilter);
      } catch (cleanErr) { }
    }

    let readingGroupId = voteData.readingGroupId;
    if (!readingGroupId) {
      const config = await getPollConfig();
      readingGroupId = config?.readingGroupId || null;
    }

    const setFields = {
      voterPhone,
      selectedOptions: voteData.selectedOptions,
      readingGroupId,
      updatedAt: getTRDateString(voteData.updatedAt)
    };
    if (voteData.pushName) setFields.pushName = voteData.pushName;
    if (configKey) setFields.configKey = configKey;

    const filter = { voterJid: voterPhone, date };
    if (configKey) filter.configKey = configKey;

    const result = await db.collection('text_votes').updateOne(
      filter,
      { $set: setFields },
      { upsert: true }
    );
    return result;
  } catch (err) {
    console.error('❌ Metin okuma DB kayıt hatası:', err.message);
    return null;
  }
}

/**
 * Anket oluşturulduğunda veritabanına kaydeder.
 * polls time-series olduğu için updateOne/upsert kullanılamaz → insertOne.
 * Aynı pollId varsa önce deleteMany, sonra insertOne (messageData güncellemesi için).
 * @param {Object} pollData - { pollId, groupId, title, options, createdAt, configKey, messageData }
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
 * @param {Object} voteData - { pollId, voterJid, voterPhone, rawLid, selectedOptions, pushName, readingGroupId, configKey, updatedAt }
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
    if (!readingGroupId) {
      const config = await getPollConfig();
      readingGroupId = config?.readingGroupId || null;
    }

    const setFields = {
      voterPhone: voterPhone,
      selectedOptions: voteData.selectedOptions,
      readingGroupId: readingGroupId,
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
      { $set: setFields },
      { upsert: true }
    );
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

/**
 * Anketi polls koleksiyonundan siler (time-series → deleteMany).
 * İlişkili poll_votes kayıtlarını da temizler.
 */
async function deletePoll(pollId) {
  if (!dbEnabled || !db) return { success: false, message: 'Veritabanı bağlantısı aktif değil.' };
  if (!pollId) return { success: false, message: 'pollId gerekli.' };

  try {
    const configKey = getPollConfigKey();
    const filter = { pollId };
    if (configKey) filter.configKey = configKey;

    const pollResult = await db.collection('polls').deleteMany(filter);
    if (pollResult.deletedCount === 0) {
      return { success: false, message: 'Anket bulunamadı veya bu bota ait değil.' };
    }

    await db.collection('poll_votes').deleteMany({ pollId });
    return { success: true, deletedCount: pollResult.deletedCount };
  } catch (err) {
    console.error('❌ Anket silme hatası:', err.message);
    return { success: false, message: err.message };
  }
}

const DEFAULT_POLL_OPTIONS = [
  '5 dakika', '10 dakika', '15 dakika', '20 dakika', '30 dakika',
  '45 dakika', '60 dakika', '75 dakika', '90 dakika', '120 dakika',
  '150 dakika', '180 dakika'
];

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
        featurePollEnabled: true,
        featureSentenceEnabled: true,
        featureWeeklyReportEnabled: true,
        featureWeeklyTableEnabled: true,
        featureVoteTrackingEnabled: true,
        featureMessageReadingEnabled: true,
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
          pollEnabled: true,
          sentenceEnabled: true,
          weeklyReportEnabled: true,
          weeklyTableEnabled: true,
          voteTrackingEnabled: true,
          messageReadingEnabled: true
        }
      };
    }

    return {
      configKey: doc._id || configKey,
      titleTemplate: doc.titleTemplate || defaultConfig.titleTemplate,
      options: (Array.isArray(doc.options) && doc.options.length > 0) ? doc.options : defaultConfig.options,
      groupId: (doc.groupId !== undefined && doc.groupId !== null && String(doc.groupId).trim() !== '') ? String(doc.groupId).trim() : null,
      readingGroupId: (doc.readingGroupId && typeof doc.readingGroupId === 'string' && doc.readingGroupId.trim() !== '') ? String(doc.readingGroupId).trim() : null,
      updatedAt: doc.updatedAt || null,
      // Özellik bayrakları: undefined veya null ise varsayılan true (geriye dönük uyumluluk)
      features: {
        pollEnabled: doc.featurePollEnabled !== false,
        sentenceEnabled: doc.featureSentenceEnabled !== false,
        weeklyReportEnabled: doc.featureWeeklyReportEnabled !== false,
        weeklyTableEnabled: doc.featureWeeklyTableEnabled !== false,
        voteTrackingEnabled: doc.featureVoteTrackingEnabled !== false,
        messageReadingEnabled: doc.featureMessageReadingEnabled !== false,
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
 * features: { pollEnabled, sentenceEnabled, weeklyReportEnabled, weeklyTableEnabled, voteTrackingEnabled, messageReadingEnabled }
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

    if (options.length === 0) {
      return { success: false, message: 'En az 1 anket seçeneği eklemelisiniz.' };
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
    if (typeof features.sentenceEnabled === 'boolean') setFields.featureSentenceEnabled = features.sentenceEnabled;
    if (typeof features.weeklyReportEnabled === 'boolean') setFields.featureWeeklyReportEnabled = features.weeklyReportEnabled;
    if (typeof features.weeklyTableEnabled === 'boolean') setFields.featureWeeklyTableEnabled = features.weeklyTableEnabled;
    if (typeof features.voteTrackingEnabled === 'boolean') setFields.featureVoteTrackingEnabled = features.voteTrackingEnabled;
    if (typeof features.messageReadingEnabled === 'boolean') setFields.featureMessageReadingEnabled = features.messageReadingEnabled;

    await db.collection('poll_config').updateOne(
      { _id: configKey },
      { $set: setFields },
      { upsert: true }
    );

    process.env.CONFIG_KEY = configKey;

    return { success: true, config: { configKey, ...setFields } };
  } catch (err) {
    console.error(`❌ Anket ayarları kayıt hatası:`, err.message);
    return { success: false, message: err.message };
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
 * RoTaKip usergroups koleksiyonundan tüm okuma gruplarını getirir.
 * Grup Ayarları UI'ında okuma grubu seçimi için kullanılır.
 * @returns {Array} Gruplar: [{ groupName, groupId, groupImage, description }]
 */
async function getReadingGroups() {
  if (!dbEnabled || !db) return [];
  try {
    const groups = await db.collection('usergroups')
      .find({ visibility: { $ne: 'private' } })
      .sort({ groupName: 1 })
      .project({ groupName: 1, groupId: 1, groupImage: 1, description: 1, _id: 0 })
      .toArray();
    return groups;
  } catch (e) {
    console.error('❌ getReadingGroups hatası:', e.message);
    return [];
  }
}

// ============================================================================
// RASTGELE CÜMLE GÖNDERİM FONKSİYONU (Ayetler, Dualar, Hadisler, Hatırlatmalar, Vecizeler)
// ============================================================================

// Koleksiyonlar ve ağırlıklı seçim yüzdeleri (toplam: %100)
const SENTENCE_COLLECTIONS = [
  { name: 'ayetler', weight: 15 },  // %15
  { name: 'hadisler', weight: 15 },  // %15
  { name: 'dualar', weight: 15 },  // %15
  { name: 'hatırlatmalar', weight: 15 },  // %15
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

module.exports = {
  connectDB,
  isDBEnabled,
  getDB,
  savePoll,
  saveVote,
  saveTextVote,
  removeVote,
  deletePoll,
  getTRDateString,
  getLogicalReadingDate,
  getPollConfig,
  savePollConfig,
  saveLidMapping,
  getAllLidMappings,
  deleteLidMappingsByConfigKey,
  getReadingGroups,
  getRandomSentence,
  calculateReadingStreaks,
  getMonthlyReadingAmountTotal,
  getPendingCongratulations,
  completeCongratulation
};
