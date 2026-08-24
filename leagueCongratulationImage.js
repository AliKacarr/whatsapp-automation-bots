const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const path = require('path');
const fs = require('fs');

const fontRegularPath = path.join(__dirname, 'fonts', 'Inter-Regular.ttf');
const fontMediumPath = path.join(__dirname, 'fonts', 'Inter-Medium.ttf');
const fontSemiBoldPath = path.join(__dirname, 'fonts', 'Inter-SemiBold.ttf');

if (fs.existsSync(fontRegularPath)) {
  try { GlobalFonts.registerFromPath(fontRegularPath, 'Inter'); } catch (e) { }
}

let FONT_MEDIUM_FAMILY = 'Inter';
if (fs.existsSync(fontMediumPath)) {
  try {
    GlobalFonts.registerFromPath(fontMediumPath, 'Inter Medium');
    FONT_MEDIUM_FAMILY = 'Inter Medium';
  } catch (e) { }
}

if (fs.existsSync(fontSemiBoldPath)) {
  try { GlobalFonts.registerFromPath(fontSemiBoldPath, 'Inter SemiBold'); } catch (e) { }
}

const TEMPLATE_DIR = path.join(__dirname, 'league-templates');

const LEAGUES = [
  { min: 0, max: 5, name: 'Bronz', slug: 'bronz' },
  { min: 5, max: 10, name: 'Gümüş', slug: 'gumus' },
  { min: 10, max: 20, name: 'Altın', slug: 'altin' },
  { min: 20, max: 40, name: 'İnci', slug: 'inci' },
  { min: 40, max: 60, name: 'Safir', slug: 'safir' },
  { min: 60, max: 100, name: 'Zümrüt', slug: 'zumrut' },
  { min: 100, max: 150, name: 'Elmas', slug: 'elmas' },
  { min: 150, max: 200, name: 'Yakut', slug: 'yakut' },
  { min: 200, max: 365, name: 'Mercan', slug: 'mercan' },
  { min: 365, max: 10000, name: 'Pırlanta', slug: 'pirlanta' }
];

function slugifyLeague(name) {
  return String(name || '')
    .toLocaleLowerCase('tr-TR')
    .replace(/ı/g, 'i')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ş/g, 's')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c')
    .replace(/[^a-z0-9]+/g, '');
}

function resolveLeague({ league, leagueMin }) {
  const slug = slugifyLeague(league);
  let found = LEAGUES.find(l => l.slug === slug || slugifyLeague(l.name) === slug);
  if (!found && leagueMin != null && leagueMin !== '') {
    const min = Number(leagueMin);
    if (Number.isFinite(min)) {
      found = LEAGUES.find(l => l.min === min) || LEAGUES.find(l => min >= l.min && min < l.max);
    }
  }
  return found || LEAGUES[0];
}

function fitText(ctx, text, maxWidth, maxSize, minSize, family) {
  let size = maxSize;
  while (size > minSize) {
    ctx.font = `600 ${size}px ${family}`;
    if (ctx.measureText(text).width <= maxWidth) return size;
    size -= 2;
  }
  return minSize;
}

/**
 * Lig şablonunun üzerine isim (ve lig/gün satırı) yazar.
 * @returns {Promise<{ buffer: Buffer, mimetype: string, leagueName: string, caption: string }>}
 */
async function generateLeagueCongratulationImage({ name, league, leagueMin }) {
  const resolved = resolveLeague({ league, leagueMin });
  const displayName = String(name || 'Okur').trim() || 'Okur';
  const days = (leagueMin !== undefined && leagueMin !== null && leagueMin !== '')
    ? Number(leagueMin)
    : resolved.min;
  const daysLabel = Number.isFinite(days) ? `${days} gün` : '';
  const leagueLine = daysLabel
    ? `${resolved.name} Lig  ·  ${daysLabel}`
    : `${resolved.name} Lig`;

  const templatePath = path.join(TEMPLATE_DIR, `league-${resolved.slug}.png`);
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Lig şablonu bulunamadı: league-${resolved.slug}.png`);
  }

  const template = await loadImage(templatePath);
  const width = template.width;
  const height = template.height;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  ctx.drawImage(template, 0, 0, width, height);

  const bandTop = height * 0.72;
  const bandHeight = height - bandTop;
  const gradient = ctx.createLinearGradient(0, bandTop - 40, 0, height);
  gradient.addColorStop(0, 'rgba(0,0,0,0)');
  gradient.addColorStop(0.25, 'rgba(0,0,0,0.55)');
  gradient.addColorStop(1, 'rgba(0,0,0,0.82)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, bandTop - 40, width, bandHeight + 40);

  const family = `"Inter SemiBold", "${FONT_MEDIUM_FAMILY}", Inter, sans-serif`;
  const maxTextWidth = width * 0.82;
  const nameSize = fitText(ctx, displayName, maxTextWidth, Math.round(width * 0.072), 28, family);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const nameY = bandTop + bandHeight * 0.42;
  ctx.font = `600 ${nameSize}px ${family}`;
  ctx.shadowColor = 'rgba(0,0,0,0.75)';
  ctx.shadowBlur = 12;
  ctx.shadowOffsetY = 3;
  ctx.fillStyle = '#fffef8';
  ctx.fillText(displayName, width / 2, nameY);

  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.font = `500 ${Math.round(width * 0.040)}px "${FONT_MEDIUM_FAMILY}", Inter, sans-serif`;
  ctx.fillStyle = 'rgba(255,245,210,0.92)';
  ctx.fillText(leagueLine, width / 2, nameY + nameSize * 0.85);

  const caption = `Lig atlayan arkadaşımızı tebrik ediyoruz! 🎉🎉\n\n⚡${daysLabel} - *${displayName}* ${resolved.name.toLocaleLowerCase('tr-TR')} lige yükseldi.`;

  return {
    buffer: canvas.toBuffer('image/png'),
    mimetype: 'image/png',
    leagueName: resolved.name,
    caption
  };
}

module.exports = {
  generateLeagueCongratulationImage,
  resolveLeague,
  LEAGUES
};
