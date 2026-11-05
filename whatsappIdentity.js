function normalizeVoterLid(value) {
  if (value == null) return '';

  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return '';

  const atIndex = normalized.indexOf('@');
  if (atIndex >= 0) {
    const server = normalized.slice(atIndex + 1);
    if (server !== 'lid' && server !== 'hosted.lid') return '';
  }

  const bare = normalized.split('@')[0].split(':')[0];
  return /^\d{12,20}$/.test(bare) ? bare : '';
}

function voterLidVariants(value) {
  const bare = normalizeVoterLid(value);
  if (!bare) return [];
  return [bare, `${bare}@lid`, `${bare}:0@lid`, `${bare}@hosted.lid`, `${bare}:0@hosted.lid`];
}

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

module.exports = {
  normalizeVoterLid,
  voterLidVariants,
  normalizeWhatsAppPhone,
  extractParticipantIdentity
};
