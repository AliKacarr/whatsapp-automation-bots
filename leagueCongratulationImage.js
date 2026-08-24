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

const BADGE_DIR = path.join(__dirname, 'league_images');
const TEMPLATE_DIR = path.join(__dirname, 'league-templates');
const PARTY_POPPER_PATH = path.join(__dirname, 'assets', 'party-popper.png');
const STAR_PATH = path.join(__dirname, 'assets', 'star.png');

const LEAGUES = [
  { min: 0, max: 5, name: 'Bronz', slug: 'bronz', file: 'bronz.webp', accent: '#e2b07a' },
  { min: 5, max: 10, name: 'Gümüş', slug: 'gumus', file: 'gumus.webp', accent: '#c5c9d1' },
  { min: 10, max: 20, name: 'Altın', slug: 'altin', file: 'altin.webp', accent: '#ffd54a' },
  { min: 20, max: 40, name: 'İnci', slug: 'inci', file: 'inci.webp', accent: '#b7e4ef' },
  { min: 40, max: 60, name: 'Safir', slug: 'safir', file: 'safir.webp', accent: '#49b7ff' },
  { min: 60, max: 100, name: 'Zümrüt', slug: 'zumrut', file: 'zumrut.webp', accent: '#7dcea0' },
  { min: 100, max: 150, name: 'Elmas', slug: 'elmas', file: 'elmas.webp', accent: '#e8f6e4' },
  { min: 150, max: 200, name: 'Yakut', slug: 'yakut', file: 'yakut.webp', accent: '#ff8a9b' },
  { min: 200, max: 365, name: 'Mercan', slug: 'mercan', file: 'mercan.webp', accent: '#ff8b7a' },
  { min: 365, max: 10000, name: 'Pırlanta', slug: 'pirlanta', file: 'pirlanta.webp', accent: '#ffd27a' }
];

const badgeCache = new Map();
const templateCache = new Map();
let partyPopperCache;
let starCache;

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

function fitText(ctx, text, maxWidth, maxSize, minSize, family, weight = '600') {
  let size = maxSize;
  while (size > minSize) {
    ctx.font = `${weight} ${size}px ${family}`;
    if (ctx.measureText(text).width <= maxWidth) return size;
    size -= 2;
  }
  return minSize;
}

function rangeLabel(league) {
  if (!Number.isFinite(league.max) || league.max >= 10000) return `${league.min}+`;
  return `${league.min}-${league.max - 1}`;
}

function badgePath(fileName) {
  const primary = path.join(BADGE_DIR, fileName);
  if (fs.existsSync(primary)) return primary;
  const stem = path.parse(fileName).name;
  for (const ext of ['.png', '.webp', '.jpg']) {
    const p = path.join(BADGE_DIR, stem + ext);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function loadBadge(league) {
  if (badgeCache.has(league.slug)) return badgeCache.get(league.slug);
  const file = badgePath(league.file);
  if (!file) {
    badgeCache.set(league.slug, null);
    return null;
  }
  const img = await loadImage(file);
  badgeCache.set(league.slug, img);
  return img;
}

async function loadTemplate(slug) {
  if (templateCache.has(slug)) return templateCache.get(slug);
  const file = path.join(TEMPLATE_DIR, `league-${slug}.png`);
  if (!fs.existsSync(file)) {
    templateCache.set(slug, null);
    return null;
  }
  const img = await loadImage(file);
  templateCache.set(slug, img);
  return img;
}

async function loadPartyPopper() {
  if (partyPopperCache !== undefined) return partyPopperCache;
  if (!fs.existsSync(PARTY_POPPER_PATH)) {
    partyPopperCache = null;
    return null;
  }
  partyPopperCache = await loadImage(PARTY_POPPER_PATH);
  return partyPopperCache;
}

async function loadStar() {
  if (starCache !== undefined) return starCache;
  if (!fs.existsSync(STAR_PATH)) {
    starCache = null;
    return null;
  }
  starCache = await loadImage(STAR_PATH);
  return starCache;
}

function drawCover(ctx, img, width, height) {
  const imgRatio = img.width / img.height;
  const canvasRatio = width / height;
  let dw;
  let dh;
  let dx;
  let dy;
  if (imgRatio > canvasRatio) {
    dh = height;
    dw = height * imgRatio;
    dx = (width - dw) / 2;
    dy = 0;
  } else {
    dw = width;
    dh = width / imgRatio;
    dx = 0;
    dy = (height - dh) / 2;
  }
  ctx.drawImage(img, dx, dy, dw, dh);
}

function drawStreamer(ctx, x, y, length, rot, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.strokeStyle = color;
  ctx.lineWidth = 3.2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.quadraticCurveTo(length * 0.28, -14, length * 0.55, 3);
  ctx.quadraticCurveTo(length * 0.78, 16, length, 5);
  ctx.stroke();
  ctx.restore();
}

function drawConfettiBurst(ctx, partyPopper, { originX, originY, flip, popperSize, accent }) {
  ctx.save();
  ctx.translate(originX, originY);
  if (flip) ctx.scale(-1, 1);

  const palette = [accent, '#ffd54a', '#ff6b8a', '#7dcea0', '#49b7ff', '#fff7e8', '#ff8b7a', '#c5a3ff'];
  const s = popperSize / 128;

  const streamers = [
    { x: 86 * s, y: 10 * s, len: 52 * s, rot: -0.55, c: 3 },
    { x: 98 * s, y: 28 * s, len: 44 * s, rot: -0.12, c: 7 },
    { x: 78 * s, y: 36 * s, len: 38 * s, rot: 0.42, c: 1 }
  ];
  for (const st of streamers) {
    drawStreamer(ctx, st.x, st.y, st.len, st.rot, palette[st.c]);
  }

  const pieces = [
    { x: 72, y: 4, k: 'rect', w: 8, h: 16, r: 0.55, c: 1 },
    { x: 108, y: 8, k: 'dot', d: 8, c: 2 },
    { x: 128, y: 30, k: 'rect', w: 7, h: 14, r: -0.7, c: 4 },
    { x: 96, y: -8, k: 'dot', d: 7, c: 0 },
    { x: 148, y: 16, k: 'rect', w: 6, h: 12, r: 0.9, c: 6 },
    { x: 122, y: 56, k: 'dot', d: 6, c: 3 },
    { x: 84, y: 62, k: 'rect', w: 7, h: 13, r: 0.2, c: 7 },
    { x: 156, y: 46, k: 'dot', d: 7, c: 1 },
    { x: 64, y: 22, k: 'dot', d: 6, c: 5 },
    { x: 138, y: -6, k: 'rect', w: 6, h: 11, r: -0.35, c: 2 },
    { x: 168, y: 28, k: 'rect', w: 5, h: 12, r: 0.25, c: 3 },
    { x: 112, y: 74, k: 'dot', d: 5, c: 4 }
  ];
  for (const p of pieces) {
    ctx.save();
    ctx.translate(p.x * s, p.y * s);
    ctx.rotate(p.r || 0);
    ctx.fillStyle = palette[p.c];
    ctx.globalAlpha = 0.92;
    if (p.k === 'dot') {
      ctx.beginPath();
      ctx.arc(0, 0, (p.d * s) / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillRect(-(p.w * s) / 2, -(p.h * s) / 2, p.w * s, p.h * s);
    }
    ctx.restore();
  }

  if (partyPopper) {
    ctx.globalAlpha = 1;
    ctx.drawImage(partyPopper, 0, 0, popperSize, popperSize);
  }

  ctx.restore();
}

function drawBadge(ctx, img, cx, cy, size, alpha = 1) {
  if (!img) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.arc(cx, cy, size / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  const zoom = 1.14;
  const src = Math.min(img.width, img.height) / zoom;
  const sx = (img.width - src) / 2;
  const sy = (img.height - src) / 2;
  ctx.drawImage(img, sx, sy, src, src, cx - size / 2, cy - size / 2, size, size);
  ctx.restore();
}

/**
 * Sinematik arka plan + sade isim kartı.
 * Altta 10 rozet: parlama yok, mevcut lig biraz daha büyük.
 */
async function generateLeagueCongratulationImage({ name, league, leagueMin }) {
  const resolved = resolveLeague({ league, leagueMin });
  const currentIndex = Math.max(0, LEAGUES.findIndex(l => l.slug === resolved.slug));
  const displayName = String(name || 'Okur').trim() || 'Okur';
  const days = (leagueMin !== undefined && leagueMin !== null && leagueMin !== '')
    ? Number(leagueMin)
    : resolved.min;
  const daysLabel = Number.isFinite(days) ? `${days} gün` : '';

  const [template, images, partyPopper, star] = await Promise.all([
    loadTemplate(resolved.slug),
    Promise.all(LEAGUES.map(loadBadge)),
    loadPartyPopper(),
    loadStar()
  ]);

  const width = 1080;
  const height = 1350;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#0b0f19';
  ctx.fillRect(0, 0, width, height);

  if (template) {
    drawCover(ctx, template, width, height);
  }

  const veil = ctx.createLinearGradient(0, height * 0.28, 0, height);
  veil.addColorStop(0, 'rgba(8,10,16,0.08)');
  veil.addColorStop(0.42, 'rgba(8,10,16,0.55)');
  veil.addColorStop(0.62, 'rgba(8,10,16,0.88)');
  veil.addColorStop(1, 'rgba(8,10,16,0.96)');
  ctx.fillStyle = veil;
  ctx.fillRect(0, 0, width, height);

  const bold = `"Inter SemiBold", "${FONT_MEDIUM_FAMILY}", Inter, sans-serif`;
  const medium = `"${FONT_MEDIUM_FAMILY}", Inter, sans-serif`;

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const nameSize = fitText(ctx, displayName, width * 0.86, 88, 42, bold);
  ctx.font = `600 ${nameSize}px ${bold}`;
  ctx.fillStyle = '#fffdf8';
  ctx.fillText(displayName, width / 2, 760);

  const meta = daysLabel
    ? `${resolved.name} Lig  ·  ${daysLabel}`
    : `${resolved.name} Lig`;
  ctx.font = `500 44px ${medium}`;
  ctx.fillStyle = resolved.accent;
  ctx.fillText(meta, width / 2, 848);

  const rowY = 1040;
  const rowLeft = 18;
  const rowRight = width - 18;
  const slot = (rowRight - rowLeft) / LEAGUES.length;
  const nameY = rowY + 55;
  const rangeY = rowY + 85;
  const nameMaxW = slot - 2;

  function drawColumn(i) {
    const isCurrent = i === currentIndex;
    const isPast = i < currentIndex;
    const cx = rowLeft + slot * i + slot / 2;
    const size = isCurrent ? 75 : 60;
    const badgeY = isCurrent ? rowY - 6 : rowY;
    const alpha = isCurrent ? 1 : isPast ? 0.88 : 0.42;
    drawBadge(ctx, images[i], cx, badgeY, size, alpha);

    ctx.globalAlpha = isCurrent ? 1 : alpha;
    const colNameSize = fitText(ctx, LEAGUES[i].name, nameMaxW, isCurrent ? 22 : 21, 14, bold, '600');
    ctx.font = `600 ${colNameSize}px ${bold}`;
    ctx.fillStyle = isCurrent ? '#ffffff' : '#e8edf5';
    ctx.fillText(LEAGUES[i].name, cx, nameY);
    ctx.font = `500 19px ${medium}`;
    ctx.fillStyle = isCurrent ? 'rgba(255,255,255,0.82)' : 'rgba(255,255,255,0.58)';
    ctx.fillText(rangeLabel(LEAGUES[i]), cx, rangeY);
    ctx.globalAlpha = 1;
  }

  for (let i = 0; i < LEAGUES.length; i++) {
    if (i !== currentIndex) drawColumn(i);
  }
  drawColumn(currentIndex);

  const trackY = rangeY + 38;
  const firstX = rowLeft + slot / 2;
  const lastX = rowLeft + slot * (LEAGUES.length - 1) + slot / 2;
  const currentX = rowLeft + slot * currentIndex + slot / 2;

  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(255,255,255,0.16)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(firstX, trackY);
  ctx.lineTo(lastX, trackY);
  ctx.stroke();

  if (currentIndex > 0) {
    ctx.strokeStyle = resolved.accent;
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(firstX, trackY);
    ctx.lineTo(currentX, trackY);
    ctx.stroke();
  }

  for (let i = 0; i < LEAGUES.length; i++) {
    const cx = rowLeft + slot * i + slot / 2;
    const isCurrent = i === currentIndex;
    const reached = i <= currentIndex;
    const r = isCurrent ? 9 : 7;

    if (reached) {
      ctx.beginPath();
      ctx.arc(cx, trackY, r, 0, Math.PI * 2);
      ctx.fillStyle = resolved.accent;
      ctx.fill();
      if (isCurrent) {
        ctx.beginPath();
        ctx.arc(cx, trackY, r + 5, 0, Math.PI * 2);
        ctx.strokeStyle = resolved.accent;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    } else {
      ctx.beginPath();
      ctx.arc(cx, trackY, r, 0, Math.PI * 2);
      ctx.fillStyle = '#0b0f19';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.38)';
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
  }

  const burstGap = 32;
  const burstSize = 92;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, trackY + burstGap, width, height - (trackY + burstGap));
  ctx.clip();
  drawConfettiBurst(ctx, partyPopper, {
    originX: 10,
    originY: height - burstSize - 14,
    flip: false,
    popperSize: burstSize,
    accent: resolved.accent
  });
  drawConfettiBurst(ctx, partyPopper, {
    originX: width - 10,
    originY: height - burstSize - 14,
    flip: true,
    popperSize: burstSize,
    accent: resolved.accent
  });
  ctx.restore();

  ctx.fillStyle = 'rgba(255,255,255,0.78)';
  ctx.font = `500 32px ${medium}`;
  const congrats = 'Tebrikler!';
  const emojiSize = 36;
  const emojiGap = 10;
  const textW = ctx.measureText(congrats).width;
  const rowW = star
    ? emojiSize + emojiGap + textW + emojiGap + emojiSize
    : textW;
  let drawX = (width - rowW) / 2;
  const congratsY = 1246;
  if (star) {
    ctx.drawImage(star, drawX, congratsY - emojiSize / 2, emojiSize, emojiSize);
    drawX += emojiSize + emojiGap;
  }
  ctx.textAlign = 'left';
  ctx.fillText(congrats, drawX, congratsY);
  drawX += textW + emojiGap;
  if (star) {
    ctx.drawImage(star, drawX, congratsY - emojiSize / 2, emojiSize, emojiSize);
  }
  ctx.textAlign = 'center';

  ctx.font = `500 24px ${medium}`;
  ctx.fillStyle = 'rgba(255,255,255,0.62)';
  ctx.fillText('Toplam okuma gününüz arttıkça daha yüksek liglere yükselirsiniz.', width / 2, 1312);

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
  generateLeagueCongratulationImage: generateLeagueCongratulationImage,
  resolveLeague,
  LEAGUES
};
