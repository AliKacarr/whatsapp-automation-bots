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
    return db;
  } catch (err) {
    console.error('❌ MongoDB bağlantı hatası:', err.message);
    dbEnabled = false;
    return null;
  }
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
          createdAt: pollData.createdAt || new Date()
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
    console.log(`📊 Anket DB'ye kaydedildi: "${pollData.title}" (${pollData.pollId})`);
    return result;
  } catch (err) {
    console.error('❌ Anket DB kayıt hatası:', err.message);
    return null;
  }
}

/**
 * Oy geldiğinde veritabanına kaydeder (upsert).
 * Aynı kullanıcı aynı ankete tekrar oy verirse günceller.
 * @param {Object} voteData - { pollId, voterJid, selectedOptions, updatedAt }
 */
async function saveVote(voteData) {
  if (!dbEnabled || !db) return null;

  try {
    const result = await db.collection('poll_votes').updateOne(
      { pollId: voteData.pollId, voterJid: voteData.voterJid },
      {
        $set: {
          voterPhone: voteData.voterPhone || voteData.voterJid,
          selectedOptions: voteData.selectedOptions,
          updatedAt: voteData.updatedAt || new Date()
        }
      },
      { upsert: true }
    );
    const action = result.upsertedCount > 0 ? 'Yeni oy' : 'Oy güncelleme';
    console.log(`🗳️ ${action}: ${voteData.voterJid} → [${voteData.selectedOptions.join(', ')}]`);
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
async function removeVote(pollId, voterJid) {
  if (!dbEnabled || !db) return null;

  try {
    const result = await db.collection('poll_votes').deleteOne({ pollId, voterJid });
    if (result.deletedCount > 0) {
      console.log(`🗑️ Oy silindi: ${voterJid} anketten çıktı (${pollId})`);
    }
    return result;
  } catch (err) {
    console.error('❌ Oy silme hatası:', err.message);
    return null;
  }
}

module.exports = {
  connectDB,
  isDBEnabled,
  getDB,
  savePoll,
  saveVote,
  removeVote
};
