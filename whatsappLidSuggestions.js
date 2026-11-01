const { normalizeVoterLid } = require('./whatsappIdentity');

function normalizeWhatsAppPhone(value) {
  if (value == null) return '';
  const bare = String(value).trim().split('@')[0].split(':')[0].replace(/\D/g, '');
  return /^\d{10,15}$/.test(bare) ? bare : '';
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
  phoneByLid = new Map()
} = {}) {
  const phoneSet = new Set([...registeredPhones].map(normalizeWhatsAppPhone).filter(Boolean));
  const lidSet = new Set([...assignedLids].map(normalizeVoterLid).filter(Boolean));
  const seen = new Set();
  const suggestions = [];

  for (const participant of participants || []) {
    const identity = extractParticipantIdentity(participant);
    if (!identity.lid || lidSet.has(identity.lid) || seen.has(identity.lid)) continue;

    const mappedPhone = normalizeWhatsAppPhone(
      identity.phone || phoneByLid.get(identity.lid) || phoneByLid.get(`${identity.lid}@lid`)
    );
    if (mappedPhone && phoneSet.has(mappedPhone)) continue;
    // Hızlı önerinin üyeyi gerçekten ayırt edebilmesi için WhatsApp isim
    // bilgisi zorunludur. Telefon numarası varsa ek ipucu olarak gösterilir.
    if (!identity.name) continue;

    seen.add(identity.lid);
    suggestions.push({
      voterLid: identity.lid,
      phone: mappedPhone,
      name: identity.name
    });
  }

  return suggestions.sort((a, b) =>
    a.name.localeCompare(
      b.name,
      'tr'
    ) || a.voterLid.localeCompare(b.voterLid)
  );
}

module.exports = {
  normalizeWhatsAppPhone,
  extractParticipantIdentity,
  buildLidSuggestions
};
