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
    console.log('ℹ️ MONGO_URI veya DB_NAME tanımlanmamış. Veritabanı özellikleri devre dışı.');
    dbEnabled = false;
    return null;
  }

  try {
    client = new MongoClient(uri);
    await client.connect();
    db = client.db(dbName);

    // İndeksleri oluştur (zaten varsa hata vermez)
    await db.collection('polls').createIndex({ pollId: 1 }, { unique: true });
    await db.collection('polls').createIndex({ createdAt: -1 });
    await db.collection('poll_votes').createIndex(
      { pollId: 1, voterJid: 1 },
      { unique: true }
    );
    await db.collection('poll_votes').createIndex({ pollId: 1 });

    dbEnabled = true;
    console.log('✅ MongoDB bağlantısı başarılı. Veritabanı:', dbName);

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
 * Anket oluşturulduğunda veritabanına kaydeder.
 * @param {Object} pollData - { pollId, groupId, title, options, createdAt }
 */
async function savePoll(pollData) {
  if (!dbEnabled || !db) return null;

  try {
    const setFields = {
      groupId: pollData.groupId,
      title: pollData.title,
      options: pollData.options,
      createdAt: getTRDateString(pollData.createdAt)
    };
    // Anket mesaj verisini kalıcı sakla (oy şifre çözümü için gerekli)
    if (pollData.messageData) {
      setFields.messageData = pollData.messageData;
    }

    const result = await db.collection('polls').updateOne(
      { pollId: pollData.pollId },
      { $set: setFields },
      { upsert: true }
    );
    // console.log(`📊 Anket DB'ye kaydedildi: "${pollData.title}" (${pollData.pollId})`);
    return result;
  } catch (err) {
    console.error('❌ Anket DB kayıt hatası:', err.message);
    return null;
  }
}

/**
 * Oy geldiğinde veritabanına kaydeder (upsert).
 * Aynı kullanıcı aynı ankete tekrar oy verirse günceller.
 * @param {Object} voteData - { pollId, voterJid, voterPhone, rawLid, selectedOptions, updatedAt }
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

    const setFields = {
      voterPhone: voterPhone,
      selectedOptions: voteData.selectedOptions,
      updatedAt: getTRDateString(voteData.updatedAt)
    };
    if (voteData.pushName) {
      setFields.pushName = voteData.pushName;
    }

    const result = await db.collection('poll_votes').updateOne(
      { pollId: voteData.pollId, voterJid: voterPhone },
      { $set: setFields },
      { upsert: true }
    );
    const action = result.upsertedCount > 0 ? 'Yeni oy' : 'Oy güncelleme';
    // console.log(`🗳️ ${action}: ${voterPhone} → [${voteData.selectedOptions.join(', ')}]`);
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

/**
 * Anket şablon ayarlarını MongoDB'den okur.
 * Doküman yoksa varsayılan değerleri döndürür.
 */
async function getPollConfig() {
  const defaultConfig = {
    titleTemplate: '{{date}}',
    options: DEFAULT_POLL_OPTIONS,
    groupId: process.env.WHATSAPP_GROUP_ID || null
  };

  if (!dbEnabled || !db) return defaultConfig;

  try {
    const doc = await db.collection('poll_config').findOne({ _id: 'default' });
    if (!doc) {
      const initialDoc = {
        _id: 'default',
        titleTemplate: defaultConfig.titleTemplate,
        options: defaultConfig.options,
        groupId: defaultConfig.groupId,
        updatedAt: getTRDateString()
      };
      await db.collection('poll_config').updateOne(
        { _id: 'default' },
        { $setOnInsert: initialDoc },
        { upsert: true }
      );
      console.log('📌 poll_config dokümanı bulunamadı. Varsayılan anket ayarları veritabanına kaydedildi.');
      return initialDoc;
    }

    return {
      titleTemplate: doc.titleTemplate || defaultConfig.titleTemplate,
      options: (Array.isArray(doc.options) && doc.options.length > 0) ? doc.options : defaultConfig.options,
      groupId: (doc.groupId !== undefined && doc.groupId !== null) ? doc.groupId : (process.env.WHATSAPP_GROUP_ID || null),
      updatedAt: doc.updatedAt || null
    };
  } catch (err) {
    console.error('❌ Anket ayarları okuma hatası:', err.message);
    return defaultConfig;
  }
}

/**
 * Anket şablon ayarlarını MongoDB'ye kaydeder.
 * @param {Object} configData - { titleTemplate, options, groupId }
 */
async function savePollConfig(configData) {
  if (!dbEnabled || !db) return { success: false, message: 'Veritabanı bağlantısı aktif değil.' };

  try {
    const titleTemplate = (configData.titleTemplate || '').trim() || '{{date}}';
    const options = Array.isArray(configData.options)
      ? configData.options.map(o => String(o).trim()).filter(Boolean)
      : [];

    if (options.length === 0) {
      return { success: false, message: 'En az 1 anket seçeneği eklemelisiniz.' };
    }

    const groupId = (configData.groupId !== undefined && configData.groupId !== null)
      ? String(configData.groupId).trim()
      : null;

    const setFields = {
      titleTemplate,
      options,
      groupId,
      updatedAt: getTRDateString()
    };

    await db.collection('poll_config').updateOne(
      { _id: 'default' },
      { $set: setFields },
      { upsert: true }
    );

    return { success: true, config: setFields };
  } catch (err) {
    console.error('❌ Anket ayarları kayıt hatası:', err.message);
    return { success: false, message: err.message };
  }
}

/**
 * LID -> Telefon Numarası eşleşmesini MongoDB'deki lid_mappings koleksiyonuna kalıcı kaydeder.
 */
async function saveLidMapping(lid, phone) {
  if (!dbEnabled || !db || !lid || !phone) return;
  const bareLid = String(lid).split('@')[0].split(':')[0];
  const barePhone = String(phone).split('@')[0].split(':')[0];
  if (bareLid === barePhone || !/^\d{7,15}$/.test(barePhone)) return;

  try {
    await db.collection('lid_mappings').updateOne(
      { _id: bareLid },
      { $set: { phone: barePhone, updatedAt: getTRDateString() } },
      { upsert: true }
    );
  } catch (e) { }
}

/**
 * MongoDB'de saklanan tüm kalıcı LID -> Telefon Numarası haritasını getirir.
 */
async function getAllLidMappings() {
  if (!dbEnabled || !db) return {};
  try {
    const list = await db.collection('lid_mappings').find({}).toArray();
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

/**
 * users_catikati23 ve readingstatuses_catikati23 koleksiyonlarını kullanarak
 * her kullanıcı için okuma serisi ve okumama serisini hesaplar.
 *
 * Dönüş: { readers: [{name, streak}], nonReaders: [{name, streak}] }
 *   - readers:    Ardışık okuyan kullanıcılar (streak >= 1), azalan sıralı
 *   - nonReaders: Ardışık okumayan kullanıcılar (streak > 1), azalan sıralı
 */
async function calculateReadingStreaks() {
  if (!dbEnabled || !db) return { readers: [], nonReaders: [] };

  try {
    // 1) Tüm kullanıcıları çek
    const users = await db.collection('users_catikati23').find({}).toArray();
    if (!users || users.length === 0) return { readers: [], nonReaders: [] };

    const today = getTRTodayDate();
    const readers = [];
    const nonReaders = [];

    for (const user of users) {
      const userId = user._id.toString();
      const userName = user.name || user.username || 'Bilinmeyen';

      // Kullanıcının tüm okuma dokümanlarını tarihe göre azalan sıralı çek
      const statuses = await db.collection('readingstatuses_catikati23')
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

module.exports = {
  connectDB,
  isDBEnabled,
  getDB,
  savePoll,
  saveVote,
  removeVote,
  getTRDateString,
  getPollConfig,
  savePollConfig,
  saveLidMapping,
  getAllLidMappings,
  getRandomSentence,
  calculateReadingStreaks
};
