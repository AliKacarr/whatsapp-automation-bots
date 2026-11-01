const { normalizeVoterLid } = require('./whatsappIdentity');

function normalizeWhatsAppPhone(value) {
  if (value == null) return '';
  const bare = String(value).trim().split('@')[0].split(':')[0].replace(/\D/g, '');
  return /^\d{10,15}$/.test(bare) ? bare : '';
}

function getIdentityKeys(item) {
  if (!item) return [];
  const keys = new Set();
  const values = [item.id, item.jid, item.phoneNumber, item.pn, item.user, item.lid];

  for (const value of values) {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) continue;
    const bare = raw.split('@')[0].split(':')[0];
    keys.add(raw);
    if (bare) keys.add(bare);
  }

  return [...keys];
}

function extractParticipantIdentity(item, fallback = {}) {
  if (!item) return { lid: '', phone: '', username: '', name: '', admin: null };

  let lid = normalizeVoterLid(item.lid);
  let phone = normalizeWhatsAppPhone(item.phoneNumber || item.pn);
  const candidates = [item.id, item.jid, item.phoneNumber, item.pn, item.user];

  for (const candidate of candidates) {
    const raw = String(candidate || '').trim().toLowerCase();
    if (!raw) continue;
    if (!lid && (raw.includes('@lid') || raw.includes('@hosted.lid'))) {
      lid = normalizeVoterLid(raw);
    }
    if (!phone && raw.includes('@s.whatsapp.net')) {
      phone = normalizeWhatsAppPhone(raw);
    }
  }

  const username = String(
    item.username || item.participantUsername || fallback.username || ''
  ).trim().replace(/^@/, '').slice(0, 128);
  const name = String(
    item.name || item.notify || item.pushName || item.verifiedName || fallback.name || ''
  ).trim().slice(0, 128);

  return {
    lid,
    phone,
    username,
    name,
    admin: item.admin || null
  };
}

function buildLidSuggestions(participants, {
  registeredPhones = [],
  assignedLids = [],
  detailsByIdentity = new Map(),
  phoneByLid = new Map()
} = {}) {
  const phoneSet = new Set([...registeredPhones].map(normalizeWhatsAppPhone).filter(Boolean));
  const lidSet = new Set([...assignedLids].map(normalizeVoterLid).filter(Boolean));
  const seen = new Set();
  const suggestions = [];

  for (const participant of participants || []) {
    let fallback = {};
    for (const key of getIdentityKeys(participant)) {
      if (detailsByIdentity.has(key)) {
        fallback = detailsByIdentity.get(key) || {};
        break;
      }
    }

    const identity = extractParticipantIdentity(participant, fallback);
    if (!identity.lid || lidSet.has(identity.lid) || seen.has(identity.lid)) continue;

    const mappedPhone = normalizeWhatsAppPhone(
      identity.phone || phoneByLid.get(identity.lid) || phoneByLid.get(`${identity.lid}@lid`)
    );
    if (mappedPhone && phoneSet.has(mappedPhone)) continue;
    // Salt LID, kişiyi ayırt etmeye yardımcı olmaz. Böyle kayıtlar mevcut
    // mesaj/oy tespit akışında pushName veya kullanıcı adı gelene kadar bekler.
    if (!mappedPhone && !identity.username && !identity.name) continue;

    seen.add(identity.lid);
    suggestions.push({
      voterLid: identity.lid,
      phone: mappedPhone,
      username: identity.username,
      name: identity.name,
      admin: identity.admin
    });
  }

  return suggestions.sort((a, b) => {
    const infoRank = item => (item.phone ? 4 : 0) + (item.username ? 2 : 0) + (item.name ? 1 : 0);
    return infoRank(b) - infoRank(a) || a.voterLid.localeCompare(b.voterLid);
  });
}

module.exports = {
  normalizeWhatsAppPhone,
  getIdentityKeys,
  extractParticipantIdentity,
  buildLidSuggestions
};
