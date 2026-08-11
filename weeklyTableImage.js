const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const path = require('path');
const fs = require('fs');

// Inter Font Kaydı (Linux / Render ve tüm platformlarda Türkçe karakter desteği ve tipografi uyumu için)
const fontRegularPath = path.join(__dirname, 'fonts', 'Inter-Regular.ttf');
const fontSemiBoldPath = path.join(__dirname, 'fonts', 'Inter-SemiBold.ttf');

if (fs.existsSync(fontRegularPath)) {
  try {
    GlobalFonts.registerFromPath(fontRegularPath, 'Inter');
  } catch (e) {
    console.warn('⚠️ Inter-Regular font yüklenemedi:', e.message);
  }
}

if (fs.existsSync(fontSemiBoldPath) && fontSemiBoldPath !== fontRegularPath) {
  try {
    GlobalFonts.registerFromPath(fontSemiBoldPath, 'Inter');
  } catch (e) {
    console.warn('⚠️ Inter-SemiBold font yüklenemedi:', e.message);
  }
}

// Lig Tanımları ve Arka Plan Gradyanları (RoTaKip projesinden)
const LEAGUES = [
  { min: 0, max: 5, name: 'Bronz', color1: '#e2b07a', color2: '#ffe0b2' },
  { min: 5, max: 10, name: 'Gümüş', color1: '#d3d3d3', color2: '#e0e0e0' },
  { min: 10, max: 20, name: 'Altın', color1: '#ffd700', color2: '#ffe789' },
  { min: 20, max: 40, name: 'İnci', color1: '#b2dfdb', color2: '#c8eef3' },
  { min: 40, max: 60, name: 'Safir', color1: '#49b7ff', color2: '#bbdefb' },
  { min: 60, max: 100, name: 'Zümrüt', color1: '#58c089', color2: '#a5d6a7' },
  { min: 100, max: 150, name: 'Elmas', color1: '#36e873', color2: '#c4edb8' },
  { min: 150, max: 200, name: 'Yakut', color1: '#ffb199', color2: '#ffe0b2' },
  { min: 200, max: 365, name: 'Mercan', color1: '#ff6f63', color2: '#ffafb7' },
  { min: 365, max: 10000, name: 'Pırlanta', color1: '#ffbf00', color2: '#ffe789' }
];

const MONTH_NAMES_TR = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haz', 'Tem', 'Ağu', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
const DAY_NAMES_TR = ['Paz', 'Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cts'];
const FONT_FAMILY = 'Inter, "Segoe UI", Arial, sans-serif';

/**
 * YYYY-MM-DD tarihinden önceki günü hesaplar
 */
function getPreviousDay(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Kullanıcının aktif okuma serisini (streak) hesaplar
 */
function calculateUserStreak(userStatsMap, todayKey) {
  const todayStatus = userStatsMap[todayKey];
  let streak = 0;
  let currentDate;

  if (todayStatus === 'okudum') {
    currentDate = todayKey;
  } else if (todayStatus === 'okumadım') {
    return 0;
  } else {
    currentDate = getPreviousDay(todayKey);
  }

  while (currentDate) {
    if (userStatsMap[currentDate] === 'okudum') {
      streak++;
      currentDate = getPreviousDay(currentDate);
    } else {
      break;
    }
  }
  return streak;
}

/**
 * Son 7 günün tarihlerini hesaplar (Bugünden 7 gün öncesinden başlar, 1 gün öncesinde biter)
 */
function getWeeklyDates() {
  const dates = [];
  const now = new Date();
  for (let i = 7; i >= 1; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    dates.push(`${year}-${month}-${day}`);
  }
  return dates;
}

/**
 * Vektörel Yıldız (Star) Çizer - .weekly-fire-emoji ateşi efekti ile (Alev işiltısı & gölge)
 */
function drawStar(ctx, cx, cy, spikes = 5, outerRadius = 8.5, innerRadius = 3.6) {
  let rot = Math.PI / 2 * 3;
  let x = cx;
  let y = cy;
  const step = Math.PI / spikes;

  ctx.save();
  ctx.shadowColor = 'rgba(255, 69, 0, 0.22)';
  ctx.shadowBlur = 1.5;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0.5;

  ctx.beginPath();
  ctx.moveTo(cx, cy - outerRadius);
  for (let i = 0; i < spikes; i++) {
    x = cx + Math.cos(rot) * outerRadius;
    y = cy + Math.sin(rot) * outerRadius;
    ctx.lineTo(x, y);
    rot += step;

    x = cx + Math.cos(rot) * innerRadius;
    y = cy + Math.sin(rot) * innerRadius;
    ctx.lineTo(x, y);
    rot += step;
  }
  ctx.lineTo(cx, cy - outerRadius);
  ctx.closePath();

  // 3D Emoji Gradyanı (Açık Sarı -> Canlı Turuncu)
  const grad = ctx.createLinearGradient(cx, cy - outerRadius, cx, cy + outerRadius);
  grad.addColorStop(0, '#fff366');
  grad.addColorStop(0.4, '#ffc700');
  grad.addColorStop(1, '#ff8800');

  ctx.fillStyle = grad;
  ctx.fill();

  ctx.strokeStyle = '#d96c00';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

/**
 * Vektörel Tik (Checkmark ✔) Çizer
 */
function drawCheckmark(ctx, cx, cy, size = 14, color = '#4b0082', strokeWidth = 2.4) {
  ctx.save();
  ctx.beginPath();
  const leftX = cx - size * 0.38;
  const leftY = cy + size * 0.05;
  const midX = cx - size * 0.1;
  const midY = cy + size * 0.32;
  const rightX = cx + size * 0.38;
  const rightY = cy - size * 0.32;

  ctx.moveTo(leftX, leftY);
  ctx.lineTo(midX, midY);
  ctx.lineTo(rightX, rightY);

  ctx.strokeStyle = color;
  ctx.lineWidth = strokeWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.restore();
}

/**
 * Vektörel Çarpı (Cross ✖) Çizer
 */
function drawCross(ctx, cx, cy, size = 12, color = '#8b0000', strokeWidth = 2.4) {
  ctx.save();
  ctx.beginPath();
  const half = size * 0.32;
  ctx.moveTo(cx - half, cy - half);
  ctx.lineTo(cx + half, cy + half);
  ctx.moveTo(cx + half, cy - half);
  ctx.lineTo(cx - half, cy + half);

  ctx.strokeStyle = color;
  ctx.lineWidth = strokeWidth;
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.restore();
}

/**
 * Vektörel Eksi (Minus ➖) Çizer
 */
function drawMinus(ctx, cx, cy, size = 12, color = '#5e49b2', strokeWidth = 2.5) {
  ctx.save();
  ctx.beginPath();
  const half = size * 0.35;
  ctx.moveTo(cx - half, cy);
  ctx.lineTo(cx + half, cy);

  ctx.strokeStyle = color;
  ctx.lineWidth = strokeWidth;
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.restore();
}

/**
 * Varsayılan gri avatar çizer
 */
function drawDefaultAvatar(ctx, x, y, radius) {
  ctx.save();

  // 1. Arka Plan (Beyaz Daire)
  ctx.beginPath();
  ctx.arc(x, y, radius - 0.5, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();

  // 2. Siluet (Kafa ve Gövde)
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, radius - 0.5, 0, Math.PI * 2);
  ctx.clip();

  // Kafa
  ctx.beginPath();
  ctx.arc(x, y - radius * 0.18, radius * 0.38, 0, Math.PI * 2);
  ctx.fillStyle = '#000000';
  ctx.fill();

  // Gövde / Omuzlar
  ctx.beginPath();
  ctx.arc(x, y + radius * 0.90, radius * 0.65, 0, Math.PI * 2);
  ctx.fillStyle = '#000000';
  ctx.fill();

  ctx.restore(); // clip sonlandır

  // 3. Dış Pürüzsüz İnce Siyah Çerçeve (0.85px)
  ctx.beginPath();
  ctx.arc(x, y, radius - 0.5, 0, Math.PI * 2);
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 0.85;
  ctx.stroke();

  ctx.restore();
}


/**
 * Haftalık Okuma Tablosu Görselini Çizer ve PNG Buffer Döner
 * @param {object} db - MongoDB veritabanı referansı
 * @param {string} [passedReadingGroupId] - Okuma grubu koleksiyon eki (örn: 'mygroupid34', 'hisarkapisi16'). Verilmezse poll_config'den çekilir.
 * @returns {Promise<Buffer>} PNG Resim Buffer'ı
 */
async function generateWeeklyTableCanvas(db, passedReadingGroupId = null) {
  if (!db) throw new Error('Veritabanı bağlantısı aktif değil.');

  let readingGroupId = (passedReadingGroupId || '').trim();
  if (!readingGroupId) {
    const configKey = process.env.CONFIG_KEY?.trim();
    if (!configKey) throw new Error('CONFIG_KEY tanımlanmamış. .env dosyanıza CONFIG_KEY ekleyin.');
    try {
      const pollConfig = await db.collection('poll_config').findOne({ _id: configKey });
      if (pollConfig?.readingGroupId && typeof pollConfig.readingGroupId === 'string' && pollConfig.readingGroupId.trim() !== '') {
        readingGroupId = pollConfig.readingGroupId.trim();
      } else {
        readingGroupId = configKey;
      }
    } catch (e) {
      readingGroupId = configKey;
    }
  }

  const usersColl = db.collection(`users_${readingGroupId}`);
  const statusesColl = db.collection(`readingstatuses_${readingGroupId}`);

  const users = await usersColl.find({}).sort({ name: 1 }).toArray();
  const allStatuses = await statusesColl.find({}).toArray();

  console.log(`📊 Tablo görseli oluşturuluyor [Koleksiyon: users_${readingGroupId}] → Kullanıcı sayısı: ${users.length}`);

  // 1. Tarihleri hesapla (Son 7 gün: 7 gün öncesinden düne kadar)
  const dates = getWeeklyDates();

  // Bugün tarihi (Streak ve Bugün sütunu kontrolü için)
  const now = new Date();
  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  // 2. Kullanıcı veri haritalarını oluştur
  const statMap = {};
  const userReadingCounts = {};

  for (const s of allStatuses) {
    if (!statMap[s.userId]) statMap[s.userId] = {};
    statMap[s.userId][s.date] = s.status;

    if (s.status === 'okudum') {
      userReadingCounts[s.userId] = (userReadingCounts[s.userId] || 0) + 1;
    }
  }

  // 3. Günlük okuyan sayıları ve işaretlenen sayıları hesapla
  const dateCounts = {};
  let totalOkudumWeek = 0;
  let totalMarkedWeek = 0;

  for (const d of dates) {
    let readCount = 0;
    for (const u of users) {
      const uId = u._id.toString();
      const st = (statMap[uId] || {})[d];
      if (st === 'okudum') {
        readCount++;
        totalOkudumWeek++;
        totalMarkedWeek++;
      } else if (st === 'okumadım') {
        totalMarkedWeek++;
      }
    }
    dateCounts[d] = readCount;
  }

  const weekSuccessPct = totalMarkedWeek > 0 ? Math.round((totalOkudumWeek / totalMarkedWeek) * 100) : 0;

  // 4. Sınırlandırılmış Orijinal RoTaKip Ölçüleri ve Daraltılmış Dış Margin (10px)
  const nameColWidth = 145;
  const dayColWidth = 64;
  const streakColWidth = 88;
  const rowHeight = 52;
  const headerHeight = 54;
  const statsRowHeight = 44;
  const margin = 10; // Kenarlardaki boşluk sıkılaştırıldı (10px)

  const userCount = Math.max(users.length, 1);
  const width = margin * 2 + nameColWidth + (dayColWidth * 7) + streakColWidth;
  const height = margin * 2 + headerHeight + statsRowHeight + (userCount * rowHeight);

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Arka Plan (Beyaz)
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  // --- 5. BAŞLIK SATIRI ÇİZİMİ ---
  const headerY = margin;

  // Sütun 0: "Kullanıcılar" (145px)
  ctx.fillStyle = '#f7f7f7';
  ctx.fillRect(margin, headerY, nameColWidth, headerHeight);
  ctx.strokeStyle = '#c7c7c7';
  ctx.lineWidth = 1;
  ctx.strokeRect(margin, headerY, nameColWidth, headerHeight);

  ctx.fillStyle = '#333333';
  ctx.font = `600 14px ${FONT_FAMILY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('Kullanıcılar', margin + nameColWidth / 2, headerY + headerHeight / 2);

  // Gün Sütunları
  dates.forEach((dStr, idx) => {
    const d = new Date(dStr + 'T00:00:00Z');
    const x = margin + nameColWidth + (idx * dayColWidth);
    const isToday = dStr === todayKey;

    ctx.fillStyle = isToday ? '#ebf3fa' : '#f0f0f0';
    ctx.fillRect(x, headerY, dayColWidth, headerHeight);

    ctx.strokeStyle = isToday ? '#5b9bd5' : '#c7c7c7';
    ctx.lineWidth = isToday ? 2 : 1;
    ctx.strokeRect(x, headerY, dayColWidth, headerHeight);

    const dayNum = d.getUTCDate();
    const monthStr = MONTH_NAMES_TR[d.getUTCMonth()];
    const dayName = DAY_NAMES_TR[d.getUTCDay()];

    // Gün & Ay (Sayı kısmı aya göre daha büyük)
    if (isToday) {
      ctx.fillStyle = '#505050';
      ctx.font = `500 12.5px ${FONT_FAMILY}`;
      ctx.fillText('Bugün', x + dayColWidth / 2, headerY + 18);
    } else {
      const dayStr = `${dayNum}`;
      const monthStrText = ` ${monthStr}`;

      ctx.font = `500 13px ${FONT_FAMILY}`;
      const dayW = ctx.measureText(dayStr).width;
      ctx.font = `500 11px ${FONT_FAMILY}`;
      const monthW = ctx.measureText(monthStrText).width;

      const totalW = dayW + monthW;
      const startX = x + (dayColWidth - totalW) / 2;

      ctx.textAlign = 'left';
      // Sayı kısmı (13px)
      ctx.fillStyle = '#333333';
      ctx.font = `500 13px ${FONT_FAMILY}`;
      ctx.fillText(dayStr, startX, headerY + 18);

      // Ay kısmı (11px)
      ctx.fillStyle = '#666666';
      ctx.font = `500 11px ${FONT_FAMILY}`;
      ctx.fillText(monthStrText, startX + dayW, headerY + 18);

      ctx.textAlign = 'center';
    }

    // Gün adı (Mavi Renk #5b9bd5)
    ctx.fillStyle = '#5b9bd5';
    ctx.font = `600 14px ${FONT_FAMILY}`;
    ctx.fillText(dayName, x + dayColWidth / 2, headerY + 38);
  });

  // Okuma Serisi Sütun Başlığı
  const streakX = margin + nameColWidth + (7 * dayColWidth);
  ctx.fillStyle = '#f0f0f0';
  ctx.fillRect(streakX, headerY, streakColWidth, headerHeight);
  ctx.strokeStyle = '#c7c7c7';
  ctx.lineWidth = 1;
  ctx.strokeRect(streakX, headerY, streakColWidth, headerHeight);

  ctx.fillStyle = '#ff1717';
  ctx.font = `600 12px ${FONT_FAMILY}`;
  ctx.fillText('Okuma', streakX + streakColWidth / 2, headerY + 18);
  ctx.fillText('Serisi', streakX + streakColWidth / 2, headerY + 36);

  // --- 6. İSTATİSTİK SATIRI ÇİZİMİ ---
  const statsY = headerY + headerHeight;

  // X kişi
  ctx.fillStyle = '#f7f7f7';
  ctx.fillRect(margin, statsY, nameColWidth, statsRowHeight);
  ctx.strokeRect(margin, statsY, nameColWidth, statsRowHeight);

  ctx.fillStyle = '#333333';
  ctx.font = `600 13px ${FONT_FAMILY}`;
  ctx.fillText(`${users.length} kişi`, margin + nameColWidth / 2, statsY + statsRowHeight / 2);

  // Günlük Okuyan Sayıları (Örn: "7✔")
  dates.forEach((dStr, idx) => {
    const x = margin + nameColWidth + (idx * dayColWidth);
    const count = dateCounts[dStr] || 0;
    const isToday = dStr === todayKey;

    ctx.fillStyle = isToday ? '#ebf3fa' : '#f0f0f0';
    ctx.fillRect(x, statsY, dayColWidth, statsRowHeight);
    ctx.strokeStyle = isToday ? '#5b9bd5' : '#c7c7c7';
    ctx.lineWidth = isToday ? 2 : 1;
    ctx.strokeRect(x, statsY, dayColWidth, statsRowHeight);

    const countStr = `${count}`;
    ctx.font = `600 13px ${FONT_FAMILY}`;
    const numW = ctx.measureText(countStr).width;
    const checkSize = 10;
    const gap = 3;
    const totalW = numW + gap + checkSize;
    const startX = x + (dayColWidth - totalW) / 2;

    ctx.textAlign = 'left';
    ctx.fillStyle = '#2a9d49';
    ctx.fillText(countStr, startX, statsY + statsRowHeight / 2);
    drawCheckmark(ctx, startX + numW + gap + checkSize / 2, statsY + statsRowHeight / 2, checkSize, '#2a9d49', 1.8);
    ctx.textAlign = 'center';
  });

  // Haftalık Başarı Oranı (Örn: "%57✔")
  ctx.fillStyle = '#f0f0f0';
  ctx.fillRect(streakX, statsY, streakColWidth, statsRowHeight);
  ctx.strokeStyle = '#c7c7c7';
  ctx.lineWidth = 1;
  ctx.strokeRect(streakX, statsY, streakColWidth, statsRowHeight);

  const pctStr = `%${weekSuccessPct}`;
  ctx.font = `600 13px ${FONT_FAMILY}`;
  const numW = ctx.measureText(pctStr).width;
  const checkSize = 11;
  const gap = 3;
  const totalW = numW + gap + checkSize;
  const startX = streakX + (streakColWidth - totalW) / 2;

  ctx.textAlign = 'left';
  ctx.fillStyle = '#208a3c';
  ctx.fillText(pctStr, startX, statsY + statsRowHeight / 2);
  drawCheckmark(ctx, startX + numW + gap + checkSize / 2, statsY + statsRowHeight / 2, checkSize, '#208a3c', 1.9);
  ctx.textAlign = 'center';

  // --- 7. KULLANICI SATIRLARI ÇİZİMİ ---
  for (let i = 0; i < users.length; i++) {
    const user = users[i];
    const uId = user._id.toString();
    const rowY = statsY + statsRowHeight + (i * rowHeight);

    const totalReadCount = userReadingCounts[uId] || 0;
    const league = LEAGUES.find(l => totalReadCount >= l.min && totalReadCount < l.max) || LEAGUES[LEAGUES.length - 1];

    // İsim Kartı Arka Planı (Lig Gradyanı) - Sınırlı 145px
    const grad = ctx.createLinearGradient(margin, rowY, margin + nameColWidth, rowY);
    grad.addColorStop(0, league.color1);
    grad.addColorStop(1, league.color2);
    ctx.fillStyle = grad;
    ctx.fillRect(margin, rowY, nameColWidth, rowHeight);
    ctx.strokeStyle = '#f1f1f1';
    ctx.lineWidth = 1;
    ctx.strokeRect(margin, rowY, nameColWidth, rowHeight);

    // Profil Resmi (15px yarıçap / 30px çap)
    const avatarRadius = 15;
    const avatarX = margin + 22;
    const avatarY = rowY + rowHeight / 2;

    let imgLoaded = false;
    let imgSource = user.profileImage;

    // default.png ise veya boşsa doğrudan pürüzsüz vektörel varsayılan avatarı çiz
    const isDefaultImg = !imgSource || (typeof imgSource === 'string' && imgSource.includes('default.png'));

    if (!isDefaultImg && typeof imgSource === 'string') {
      let targetSource = imgSource;

      if (!imgSource.startsWith('http://') && !imgSource.startsWith('https://')) {
        // Yerel veya bağıntılı dosya yolu (örn: /userAvatars/9334176.jpg, groupAvatars/0.jpg vb.)
        const cleanPath = imgSource.startsWith('/') ? imgSource.substring(1) : imgSource;
        const filename = path.basename(cleanPath);

        const possiblePaths = [
          path.join(__dirname, 'userAvatars', filename),
          path.join(__dirname, 'userAvatars', cleanPath),
          path.join(__dirname, cleanPath),
          path.join(__dirname, 'public', cleanPath)
        ];

        for (const p of possiblePaths) {
          if (fs.existsSync(p)) {
            targetSource = p;
            break;
          }
        }
      }

      try {
        const img = await loadImage(targetSource);
        ctx.save();
        ctx.beginPath();
        ctx.arc(avatarX, avatarY, avatarRadius, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(img, avatarX - avatarRadius, avatarY - avatarRadius, avatarRadius * 2, avatarRadius * 2);
        ctx.restore();

        // Profil resmi dairesel çerçeve (özel resimler için)
        ctx.save();
        ctx.beginPath();
        ctx.arc(avatarX, avatarY, avatarRadius, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 0.75;
        ctx.stroke();
        ctx.restore();

        imgLoaded = true;
      } catch (err) {
        console.warn(`⚠️ Profil resmi yüklenemedi (${user.name}):`, err.message);
        imgLoaded = false;
      }
    }

    if (!imgLoaded) {
      drawDefaultAvatar(ctx, avatarX, avatarY, avatarRadius);
    }

    // Kullanıcı Adı (500 13px)
    ctx.fillStyle = '#000000';
    ctx.font = `500 14px ${FONT_FAMILY}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    let displayName = user.name || 'Kullanıcı';
    const maxTextWidth = nameColWidth - 46;
    while (displayName.length > 3 && ctx.measureText(displayName + '…').width > maxTextWidth) {
      displayName = displayName.substring(0, displayName.length - 1);
    }
    if (displayName !== (user.name || 'Kullanıcı') && !displayName.endsWith('…')) {
      displayName += '…';
    }
    ctx.fillText(displayName, margin + 44, avatarY);

    // Günlük Okuma Durumları (Vektörel İkonlar)
    const userStatsMap = statMap[uId] || {};
    ctx.textAlign = 'center';

    dates.forEach((dStr, idx) => {
      const cellX = margin + nameColWidth + (idx * dayColWidth);
      const st = userStatsMap[dStr];
      const isToday = dStr === todayKey;

      if (st === 'okudum') {
        ctx.fillStyle = 'rgb(76, 217, 100)'; // Orijinal RoTaKip Canlı Yeşil (#4cd964)
        ctx.fillRect(cellX, rowY, dayColWidth, rowHeight);
        ctx.strokeStyle = isToday ? '#5b9bd5' : '#c7c7c7';
        ctx.lineWidth = isToday ? 2 : 1;
        ctx.strokeRect(cellX, rowY, dayColWidth, rowHeight);

        // İndigo Renk Vektörel Tik (Checkmark) Simgesi
        drawCheckmark(ctx, cellX + dayColWidth / 2, rowY + rowHeight / 2, 9, '#4b0082', 2.0);
      } else if (st === 'okumadım') {
        ctx.fillStyle = 'rgb(255, 100, 60)'; // Orijinal RoTaKip Canlı Kırmızı (#ff643c)
        ctx.fillRect(cellX, rowY, dayColWidth, rowHeight);
        ctx.strokeStyle = isToday ? '#5b9bd5' : '#c7c7c7';
        ctx.lineWidth = isToday ? 2 : 1;
        ctx.strokeRect(cellX, rowY, dayColWidth, rowHeight);

        // Koyu Kırmızı Vektörel Çarpı (Cross) Simgesi
        drawCross(ctx, cellX + dayColWidth / 2, rowY + rowHeight / 2, 9, '#8b0000', 2.0);
      } else {
        // Boş / İşaretlenmemiş
        ctx.fillStyle = isToday ? '#ebf3fa' : '#f8f9fa';
        ctx.fillRect(cellX, rowY, dayColWidth, rowHeight);
        ctx.strokeStyle = isToday ? '#5b9bd5' : '#c7c7c7';
        ctx.lineWidth = isToday ? 2 : 1;
        ctx.strokeRect(cellX, rowY, dayColWidth, rowHeight);

        // İndigo Moru Vektörel Eksi (Minus) Simgesi
        drawMinus(ctx, cellX + dayColWidth / 2, rowY + rowHeight / 2, 9, '#5e49b2', 2.0);
      }
    });

    // Okuma Serisi (Streak)
    const streak = calculateUserStreak(userStatsMap, todayKey);
    ctx.fillStyle = '#f5f5f5';
    ctx.fillRect(streakX, rowY, streakColWidth, rowHeight);
    ctx.strokeStyle = '#c7c7c7';
    ctx.lineWidth = 1;
    ctx.strokeRect(streakX, rowY, streakColWidth, rowHeight);

    if (streak > 0) {
      const streakStr = `${streak}`;
      ctx.font = `600 15px ${FONT_FAMILY}`;
      const numWidth = ctx.measureText(streakStr).width;

      const starRadius = 8.5;
      const starDiameter = starRadius * 2;
      const gap = 5;
      const totalW = starDiameter + gap + numWidth;
      const startX = streakX + (streakColWidth - totalW) / 2;

      const starCX = startX + starRadius;
      const textX = startX + starDiameter + gap;

      drawStar(ctx, starCX, rowY + rowHeight / 2, 5, starRadius, starRadius * 0.42);

      ctx.fillStyle = '#ff1717';
      ctx.font = `600 15px ${FONT_FAMILY}`;
      ctx.textAlign = 'left';
      ctx.fillText(streakStr, textX, rowY + rowHeight / 2);
      ctx.textAlign = 'center';
    } else {
      ctx.fillStyle = '#ff1717';
      ctx.font = `600 15px ${FONT_FAMILY}`;
      ctx.fillText('-', streakX + streakColWidth / 2, rowY + rowHeight / 2);
    }
  }

  // En dış çerçeve
  ctx.strokeStyle = '#b5b5b5';
  ctx.lineWidth = 2;
  ctx.strokeRect(margin, margin, width - margin * 2, height - margin * 2);

  const dateRangeText = formatWeeklyDateRange(dates);
  const captionText = `${dateRangeText} haftası okuma tablosu`;

  return {
    buffer: canvas.toBuffer('image/png'),
    mimetype: 'image/png',
    dateRangeText,
    captionText,
    weekSuccessPct
  };
}

/**
 * Haftalık Tarih Aralığı Metnini Formatlar (Örn: "3 - 9 Ağustos")
 */
function formatWeeklyDateRange(dates) {
  if (!dates || dates.length < 7) return '';
  const startDate = new Date(dates[0] + 'T00:00:00Z');
  const endDate = new Date(dates[dates.length - 1] + 'T00:00:00Z');
  const months = [
    'Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran',
    'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'
  ];
  const startDay = startDate.getUTCDate();
  const endDay = endDate.getUTCDate();
  const startMonth = months[startDate.getUTCMonth()];
  const endMonth = months[endDate.getUTCMonth()];

  if (startMonth === endMonth) {
    return `${startDay} - ${endDay} ${startMonth}`;
  } else {
    return `${startDay} ${startMonth} - ${endDay} ${endMonth}`;
  }
}

module.exports = {
  generateWeeklyTableCanvas,
  formatWeeklyDateRange
};
