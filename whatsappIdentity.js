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

module.exports = {
  normalizeVoterLid,
  voterLidVariants
};
