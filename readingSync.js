// WhatsApp oylarından okuma durumuna dönüşüm; RoTaKip sunucusundan bağımsızdır.
function trDate(value = new Date()) {
  return new Date(new Date(value).getTime() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function createReadingSync({ db, onPromotion = () => {}, getScope = async () => ({}) }) {
  const MAX_SYNC_ATTEMPTS = 6;
  function getGroupCollections(groupId) {
    return {
      users: db.collection(`users_${groupId}`),
      readingStatuses: db.collection(`readingstatuses_${groupId}`)
    };
  }
  const LEAGUES = [
    { name: 'Bronz', min: 0, max: 5 },
    { name: 'Gümüş', min: 5, max: 10 },
    { name: 'Altın', min: 10, max: 20 },
    { name: 'İnci', min: 20, max: 40 },
    { name: 'Safir', min: 40, max: 60 },
    { name: 'Zümrüt', min: 60, max: 100 },
    { name: 'Elmas', min: 100, max: 150 },
    { name: 'Yakut', min: 150, max: 200 },
    { name: 'Mercan', min: 200, max: 365 },
    { name: 'Pırlanta', min: 365, max: 9999 }
  ];

  /**
   * Verilen okudum sayısına göre ligin adını ve min değerini döndürür.
   * @param {number} okudumCount
   * @returns {{ name: string, min: number, max: number }}
   */
  function calculateUserLeague(okudumCount) {
    return LEAGUES.find(l => okudumCount >= l.min && okudumCount < l.max) || LEAGUES[LEAGUES.length - 1];
  }

  function formatPhoneNumber(phoneStr) {
    if (!phoneStr) return '';
    let digits = String(phoneStr).replace(/\D/g, '');
    if (!digits) return '';

    if (digits.startsWith('0090')) {
      digits = digits.substring(2);
    } else if (digits.startsWith('0') && digits.length === 11) {
      digits = '90' + digits.substring(1);
    } else if (digits.length === 10 && digits.startsWith('5')) {
      digits = '90' + digits;
    }
    return digits;
  }

  async function checkAndQueueLeaguePromotion(user, groupId, groupName, dateStr) {
    try {
      const { readingStatuses } = getGroupCollections(groupId);
      const userId = String(user._id);

      // Kullanıcının toplam okudum sayısını hesapla
      const okudumCount = await readingStatuses.countDocuments({ userId, status: 'okudum' });

      // Mevcut liği bul
      const currentLeague = calculateUserLeague(okudumCount);

      // Bronz (min=0) başlangıç ligi — kutlanmaz
      if (currentLeague.min === 0) return;

      // lastCongratulatedLeague alanını oku (yoksa 'Bronz' varsay)
      const lastC = (user.lastCongratulatedLeague != null && String(user.lastCongratulatedLeague).trim() !== '')
        ? String(user.lastCongratulatedLeague).trim()
        : 'Bronz';

      // Zaten bu lig kutlandıysa çık
      if (currentLeague.name === lastC) return;

      // Lig sıralaması kontrolü (gerileme durumunda kutlama yapma)
      const rCur = LEAGUES.findIndex(l => l.name === currentLeague.name);
      const rLast = LEAGUES.findIndex(l => l.name === lastC);
      if (rCur < rLast) return;

      // Lig atlama tarihi: okumanın tarihi
      const promotionDate = dateStr || trDate();

      // Kuyruğa ekle (upsert: aynı userId+groupId+league kombinasyonu varsa güncelle, yoksa ekle)
      await db.collection("pending_league_congratulations").findOneAndUpdate(
        { userId, groupId, league: currentLeague.name },
        {
          $set: {
            name: user.name || '',
            phone: user.phone || '',
            groupName: groupName || groupId,
            leagueMin: currentLeague.min,
            promotionDate,
            status: 'pending'
          },
          $setOnInsert: {
            createdAt: new Date()
          }
        },
        { upsert: true, returnDocument: 'after' }
      );

      onPromotion(groupId);
      console.log(`🏆 Lig Atlama Kuyruğu: ${user.name} (${user.phone}) → ${currentLeague.name} ligi. (Grup: ${groupId}, Tarih: ${promotionDate})`);
    } catch (err) {
      // Aynı lig zaten kuyruktaysa devam et; diğer hatalarda oy yeniden denensin.
      if (err.code !== 11000) {
        throw err;
      }
    }
  }

  // Anket başlığından (title) tarih çıkarma fonksiyonu (Örn: "4 Ağustos", "04.08.2026", "2026-08-04")
  function extractDateFromPollTitle(title, referenceYear) {
    if (!title || typeof title !== 'string') return null;
    const cleanedTitle = title.trim();
    const year = referenceYear || Number(trDate().slice(0, 4));

    // Pattern 1: ISO Format "YYYY-MM-DD"
    const isoMatch = cleanedTitle.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (isoMatch) {
      const y = isoMatch[1];
      const m = String(isoMatch[2]).padStart(2, '0');
      const d = String(isoMatch[3]).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }

    // Pattern 2: Sayısal "DD.MM.YYYY" veya "DD.MM"
    const numMatch = cleanedTitle.match(/(\d{1,2})[-/.](\d{1,2})(?:[-/.](20\d{2}))?/);
    if (numMatch) {
      const d = String(numMatch[1]).padStart(2, '0');
      const m = String(numMatch[2]).padStart(2, '0');
      const y = numMatch[3] || String(year);
      if (parseInt(m, 10) >= 1 && parseInt(m, 10) <= 12 && parseInt(d, 10) >= 1 && parseInt(d, 10) <= 31) {
        return `${y}-${m}-${d}`;
      }
    }

    // Pattern 3: Türkçe Ay İsimli Format ("4 Ağustos", "04 Ağustos 2026")
    const monthMap = {
      'ocak': '01', 'subat': '02', 'şubat': '02', 'mart': '03', 'nisan': '04',
      'mayis': '05', 'mayıs': '05', 'haziran': '06', 'temmuz': '07', 'agustos': '08',
      'ağustos': '08', 'eylul': '09', 'eylül': '09', 'ekim': '10', 'kasim': '11',
      'kasım': '11', 'aralik': '12', 'aralık': '12'
    };

    const trMatch = cleanedTitle.match(/(\d{1,2})\s+([a-zA-ZçğıöşüÇĞİÖŞÜ]+)(?:\s+(20\d{2}))?/i);
    if (trMatch) {
      const dayStr = String(trMatch[1]).padStart(2, '0');
      const monthName = trMatch[2].toLocaleLowerCase('tr-TR');
      const yStr = trMatch[3] || String(year);

      if (monthMap[monthName]) {
        return `${yStr}-${monthMap[monthName]}-${dayStr}`;
      }
    }

    return null;
  }

  /** polls.createdAt (Date veya eski string) → TR günü "YYYY-MM-DD" */
  function pollCreatedAtToDateStr(createdAt) {
    if (!createdAt) return null;

    if (createdAt instanceof Date) {
      if (Number.isNaN(createdAt.getTime())) return null;
      return trDate(createdAt);
    }

    const raw = String(createdAt).trim();
    if (!raw) return null;

    // Eski string biçim: "2026-08-04 12:43:07"
    const spaceDate = raw.split(' ')[0];
    if (/^\d{4}-\d{2}-\d{2}$/.test(spaceDate) && !raw.includes('T')) {
      return spaceDate;
    }

    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) return null;
    return trDate(parsed);
  }

  /** selectedOptions[0] → finite sayı; değilse null */
  function parseAmountFromSelectedOptions(selectedOptions) {
    if (!Array.isArray(selectedOptions) || !selectedOptions.length) return null;
    const n = Number(String(selectedOptions[0]).trim().replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }

  /** Log için: miktar varsa sayı, yoksa 'okudum' */
  function waSyncAmountLabel(selectedOptions) {
    const amount = parseAmountFromSelectedOptions(selectedOptions);
    return amount != null ? String(amount) : 'okudum';
  }

  /** readingstatuses upsert: status + opsiyonel amount */
  async function upsertReadingStatusWithAmount(readingStatuses, userId, dateStr, selectedOptions) {
    const amount = parseAmountFromSelectedOptions(selectedOptions);
    const update = {
      $set: { userId, date: dateStr, status: 'okudum' }
    };
    if (amount != null) {
      update.$set.amount = amount;
    } else {
      update.$unset = { amount: 1 };
    }
    await readingStatuses.findOneAndUpdate(
      { userId, date: dateStr },
      update,
      { upsert: true, returnDocument: 'after' }
    );
    return amount;
  }

  // Oy değişikliğini okuma durumuna (readingstatuses_<groupId>) senkronize eden fonksiyon
  // selectedOptions dizisine bakarak karar verir:
  //   - selectedOptions.length > 0  → "okudum" ekle
  //   - selectedOptions.length === 0 → "okudum" sil (oy geri çekilmiş)
  async function syncPollVoteToReadingStatus(voteDoc) {
    if (!voteDoc || !voteDoc.pollId) return false;

    // Oy veren kullanıcının telefon numarasını temizle (örn: 905010734844)
    const rawPhone = voteDoc.voterPhone || voteDoc.voterJid || '';
    const phone = formatPhoneNumber(rawPhone);
    if (!phone) return false;

    // İlgili anketi (poll) bul
    const poll = await db.collection("polls").findOne({ pollId: voteDoc.pollId });

    // Tarih tespiti öncelik sırası:
    // 1. Anket Başlığı (poll.title) -> Örn: "4 Ağustos" -> "2026-08-04"
    // 2. Anket Oluşturulma Tarihi (poll.createdAt, Date) -> TR günü "2026-08-04"
    // 3. Oy Güncellenme Tarihi (voteDoc.updatedAt) -> Örn: "2026-08-04 12:25:30" -> "2026-08-04"
    // 4. Bugünün Tarihi
    const createdAtDateStr = pollCreatedAtToDateStr(poll && poll.createdAt);
    let referenceYear = Number(trDate().slice(0, 4));
    if (createdAtDateStr) {
      const yearFromCreatedAt = parseInt(createdAtDateStr.slice(0, 4), 10);
      if (Number.isFinite(yearFromCreatedAt)) referenceYear = yearFromCreatedAt;
    }

    let dateStr = null;
    if (poll && poll.title) {
      dateStr = extractDateFromPollTitle(poll.title, referenceYear);
    }

    if (!dateStr && createdAtDateStr) {
      dateStr = createdAtDateStr;
    }

    if (!dateStr && voteDoc && voteDoc.updatedAt) {
      dateStr = voteDoc.updatedAt.split(' ')[0];
    }

    if (!dateStr) {
      dateStr = trDate();
    }

    // Oy verilmiş mi kontrol et (selectedOptions dizisi dolu mu?)
    const hasVoted = Array.isArray(voteDoc.selectedOptions) && voteDoc.selectedOptions.length > 0;

    // Hedef okuma grubu tespiti (voteDoc.readingGroupId veya poll.groupId)
    const targetGroupId = voteDoc.readingGroupId || poll?.groupId;

    if (targetGroupId) {
      // Doğrudan ilgili gruptan işlem yap
      const { users, readingStatuses } = getGroupCollections(targetGroupId);
      const user = await users.findOne({ phone });

      if (user) {
        const userId = user._id.toString();

        if (hasVoted) {
          // Kullanıcı oy vermiş -> readingstatuses_<groupId> koleksiyonuna "okudum" kaydı ekle/güncelle
          await upsertReadingStatusWithAmount(
            readingStatuses,
            userId,
            dateStr,
            voteDoc.selectedOptions
          );
          console.log(`✅ WA anket: ${user.name} ${dateStr} ${waSyncAmountLabel(voteDoc.selectedOptions)} ${targetGroupId}`);

          // Lig atlama kontrolü: okuma kaydı eklendikten sonra yeni ligi kontrol et
          const group = await db.collection("usergroups").findOne({ groupId: targetGroupId });
          await checkAndQueueLeaguePromotion(user, targetGroupId, group?.groupName || targetGroupId, dateStr);
        } else {
          // Kullanıcı oyunu geri çekmiş (selectedOptions boş) -> okuma bilgisini sil
          await readingStatuses.findOneAndDelete({ userId, date: dateStr });
          console.log(`🗑️ WA anket: ${user.name} ${dateStr} silindi ${targetGroupId}`);
        }
      } else {
        console.warn(`⚠️ WA anket: ${phone} bulunamadı ${targetGroupId}`);
        return false;
      }
      return true;
    } else {
      // Fallback: readingGroupId bilgisi yoksa veritabanındaki tüm grupları tara
      const groups = await db.collection("usergroups").find({}).toArray();

      let matched = false;
      for (const group of groups) {
        const { users, readingStatuses } = getGroupCollections(group.groupId);
        const user = await users.findOne({ phone });

        if (user) {
          matched = true;
          const userId = user._id.toString();

          if (hasVoted) {
            await upsertReadingStatusWithAmount(
              readingStatuses,
              userId,
              dateStr,
              voteDoc.selectedOptions
            );
            console.log(`✅ WA anket: ${user.name} ${dateStr} ${waSyncAmountLabel(voteDoc.selectedOptions)} ${group.groupId}`);

            // Lig atlama kontrolü: okuma kaydı eklendikten sonra yeni ligi kontrol et
            await checkAndQueueLeaguePromotion(user, group.groupId, group.groupName || group.groupId, dateStr);
          } else {
            await readingStatuses.findOneAndDelete({ userId, date: dateStr });
            console.log(`🗑️ WA anket: ${user.name} ${dateStr} silindi ${group.groupId}`);
          }
        }
      }
      return matched;
    }
  }

  /** text_votes / poll_votes ortak: telefona göre kullanıcı bul; yoksa pushName ↔ name */
  async function findUserForWhatsAppVote(usersCollection, phone, pushName) {
    if (phone) {
      const byPhone = await usersCollection.findOne({ phone });
      if (byPhone) return byPhone;
    }
    const nameHint = pushName != null ? String(pushName).trim() : '';
    if (!nameHint) return null;
    const byName = await usersCollection.findOne({
      name: { $regex: `^${nameHint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' }
    });
    return byName || null;
  }

  function resolveTextVoteDate(voteDoc) {
    if (voteDoc && voteDoc.date && /^\d{4}-\d{2}-\d{2}$/.test(String(voteDoc.date).trim())) {
      return String(voteDoc.date).trim();
    }
    if (voteDoc && voteDoc.updatedAt) {
      const part = String(voteDoc.updatedAt).split(' ')[0];
      if (/^\d{4}-\d{2}-\d{2}$/.test(part)) return part;
    }
    return trDate();
  }

  // text_votes dokümanını readingstatuses_<groupId> ile senkronize et
  async function syncTextVoteToReadingStatus(voteDoc) {
    if (!voteDoc) return false;

    const rawPhone = voteDoc.voterPhone || voteDoc.voterJid || '';
    const phone = formatPhoneNumber(rawPhone);
    const pushName = voteDoc.pushName || '';
    const dateStr = resolveTextVoteDate(voteDoc);
    const hasVoted = Array.isArray(voteDoc.selectedOptions) && voteDoc.selectedOptions.length > 0;
    const targetGroupId = voteDoc.readingGroupId != null
      ? String(voteDoc.readingGroupId).trim()
      : '';

    async function applyToGroup(groupId, groupName) {
      const { users, readingStatuses } = getGroupCollections(groupId);
      const user = await findUserForWhatsAppVote(users, phone, pushName);

      if (!user) {
        console.warn(`⚠️ WA mesaj: kullanıcı yok ${phone || pushName || '—'} ${groupId}`);
        return false;
      }

      const userId = user._id.toString();
      if (hasVoted) {
        await upsertReadingStatusWithAmount(
          readingStatuses,
          userId,
          dateStr,
          voteDoc.selectedOptions
        );
        console.log(`✅ WA mesaj: ${user.name} ${dateStr} ${waSyncAmountLabel(voteDoc.selectedOptions)} ${groupId}`);
        await checkAndQueueLeaguePromotion(
          user,
          groupId,
          groupName || groupId,
          dateStr
        );
      } else {
        const today = trDate();
        // selectedOptions [] : bugün → kaydı sil (➖); geçmiş gün → okumadım (✖)
        if (dateStr < today) {
          await readingStatuses.findOneAndUpdate(
            { userId, date: dateStr },
            {
              $set: { userId, date: dateStr, status: 'okumadım' },
              $unset: { amount: 1 }
            },
            { upsert: true, returnDocument: 'after' }
          );
          console.log(`✖ WA mesaj: ${user.name} ${dateStr} okumadım ${groupId}`);
        } else {
          await readingStatuses.findOneAndDelete({ userId, date: dateStr });
          console.log(`🗑️ WA mesaj: ${user.name} ${dateStr} silindi ${groupId}`);
        }
      }
      return true;
    }

    if (targetGroupId) {
      const group = await db.collection("usergroups").findOne({ groupId: targetGroupId });
      return applyToGroup(targetGroupId, group?.groupName);
    } else {
      const groups = await db.collection("usergroups").find({}).toArray();
      let matched = false;
      for (const group of groups) {
        if (await applyToGroup(group.groupId, group.groupName)) matched = true;
      }
      return matched;
    }
  }


  // Tek süreç içinde oy güncellemelerini sırala. Sürüm koşulu, işlem sırasında
  // gelen daha yeni bir oyun yanlışlıkla işlendi sayılmasını engeller.
  let tail = Promise.resolve();
  function serialize(work) {
    const result = tail.then(work);
    tail = result.catch(() => {});
    return result;
  }

  async function consume(collectionName, filter) {
    const collection = db.collection(collectionName);
    const vote = await collection.findOne(filter);
    if (!vote) return;
    let processed;
    if (collectionName === 'poll_votes') {
      processed = await syncPollVoteToReadingStatus(vote);
    } else {
      processed = await syncTextVoteToReadingStatus(vote);
    }
    const version = vote.syncVersion == null
      ? { syncVersion: { $exists: false }, updatedAt: vote.updatedAt, selectedOptions: vote.selectedOptions }
      : { syncVersion: vote.syncVersion };

    if (!processed) {
      const syncedVersion = vote.syncVersion || `legacy:${vote._id}`;
      await collection.updateOne(
        { _id: vote._id, ...version },
        {
          $set: {
            syncVersion: syncedVersion,
            syncedVersion,
            syncedAt: new Date(),
            syncStatus: 'ignored',
            syncReason: 'user_not_found_or_invalid_vote'
          }
        }
      );
      return;
    }

    if (collectionName === 'poll_votes') {
      const syncedVersion = vote.syncVersion || `legacy:${vote._id}`;
      await collection.updateOne(
        { _id: vote._id, ...version },
        {
          $set: {
            syncVersion: syncedVersion,
            syncedVersion,
            syncedAt: new Date(),
            syncStatus: 'synced',
            syncAttempts: 0
          },
          $unset: { syncReason: 1, lastSyncError: 1, failedAt: 1 }
        }
      );
      return;
    }

    await collection.deleteOne({ _id: vote._id, ...version });
  }

  async function recordSyncFailure(collectionName, filter, error) {
    const collection = db.collection(collectionName);
    const vote = await collection.findOne(filter);
    if (!vote) return;

    const syncAttempts = (Number(vote.syncAttempts) || 0) + 1;
    const exhausted = syncAttempts >= MAX_SYNC_ATTEMPTS;
    const syncedVersion = vote.syncVersion || `legacy:${vote._id}`;
    const version = vote.syncVersion == null
      ? { syncVersion: { $exists: false }, updatedAt: vote.updatedAt, selectedOptions: vote.selectedOptions }
      : { syncVersion: vote.syncVersion };
    const setFields = {
      syncAttempts,
      syncStatus: exhausted ? 'failed' : 'retrying',
      lastSyncError: error?.message || String(error),
      lastSyncAttemptAt: new Date()
    };

    if (exhausted) {
      setFields.syncVersion = syncedVersion;
      setFields.syncedVersion = syncedVersion;
      setFields.failedAt = new Date();
    }

    await collection.updateOne({ _id: vote._id, ...version }, { $set: setFields });
  }

  function processVote(collectionName, filter) {
    return serialize(async () => {
      try {
        return await consume(collectionName, filter);
      } catch (error) {
        try {
          await recordSyncFailure(collectionName, filter, error);
        } catch (statusError) {
          console.error('WA senkronizasyon hata durumu kaydedilemedi:', statusError.message);
        }
        throw error;
      }
    });
  }

  let scanning = false;
  async function retryPending() {
    if (scanning) return;
    scanning = true;
    try {
      const scope = await getScope();
      if (!scope) return;
      for (const name of ['poll_votes', 'text_votes']) {
        const pending = { $or: [
          { syncedVersion: { $exists: false } },
          { $expr: { $ne: ['$syncedVersion', '$syncVersion'] } }
        ] };
        const votes = await db.collection(name).find({ $and: [scope, pending] }).toArray();
        for (const vote of votes) {
          try { await processVote(name, { _id: vote._id }); }
          catch (error) { console.error(`WA tekrar deneme (${name}):`, error.message); }
        }
      }
    } catch (error) {
      console.error('WA kuyruk tarama hatası:', error.message);
    } finally { scanning = false; }
  }

  function start() {
    void retryPending();
    const timer = setInterval(retryPending, 10000);
    timer.unref();
    return () => clearInterval(timer);
  }
  return { processVote, retryPending, start };
}

module.exports = { createReadingSync, trDate };
