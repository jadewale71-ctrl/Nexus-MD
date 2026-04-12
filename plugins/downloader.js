'use strict';

const { cast, makeSmartQuote, applyFont } = require('../cast');
const config = require('../config');
const axios  = require('axios');
const yts    = require('yt-search');
const fs     = require('fs');
const path   = require('path');

// Ensure temp dir exists
const tmpDir = path.join(__dirname, '../temp');
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

const BOT = () => config.BOT_NAME || 'NEXUS-MD';

// ════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════

const FB_PATTERNS = [
  /https?:\/\/(?:www\.|m\.)?facebook\.com\//,
  /https?:\/\/(?:www\.|m\.)?fb\.com\//,
  /https?:\/\/fb\.watch\//,
  /https?:\/\/(?:www\.)?facebook\.com\/watch/,
  /https?:\/\/(?:www\.)?facebook\.com\/.*\/videos\//,
  /https?:\/\/(?:www\.)?facebook\.com\/reel\//,
  /https?:\/\/(?:www\.)?facebook\.com\/share\//,
];

const PH_PATTERNS = [
  /https?:\/\/(?:www\.)?pornhub\.com\/view_video/,
  /https?:\/\/(?:www\.)?pornhub\.com\/.*\/video/,
  /https?:\/\/(?:www\.)?pornhubpremium\.com\/view_video/,
];

const EMOJIS = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣'];

function sq() { return makeSmartQuote(); }

function fmtNum(n) {
  if (!n) return '?';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function fmtDuration(secs) {
  const m = Math.floor(secs / 60);
  const s = String(secs % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function getField(obj, ...keys) {
  for (const k of keys) {
    const val = k.split('.').reduce((o, p) => o?.[p], obj);
    if (val !== undefined && val !== null && val !== '') return val;
  }
  return null;
}

function isValidFbUrl(url) {
  return FB_PATTERNS.some(p => p.test(url));
}

function isValidPhUrl(url) {
  return PH_PATTERNS.some(p => p.test(url));
}

// Unified davidxtech FB response extractor
function extractFbLinks(data) {
  const links = [];
  const root  = data?.data || data?.result || data;
  if (root?.hd) links.push({ quality: 'HD', url: root.hd });
  if (root?.sd) links.push({ quality: 'SD', url: root.sd });
  if (!links.length && root?.url) links.push({ quality: 'SD', url: root.url });
  const arr = root?.links || root?.videos || root?.medias || root?.items || root?.result;
  if (Array.isArray(arr)) {
    for (const item of arr) {
      const url = item?.url || item?.download || item?.src;
      if (!url) continue;
      const q = String(item?.quality || 'SD').toUpperCase();
      links.push({ quality: q.includes('HD') || q.includes('720') ? 'HD' : 'SD', url });
    }
  }
  if (!links.length && root?.video) links.push({ quality: 'SD', url: root.video });
  return links;
}

async function sendVideo(conn, from, mek, videoUrl, caption) {
  try {
    await conn.sendMessage(from, { video: { url: videoUrl }, mimetype: 'video/mp4', caption }, { quoted: makeSmartQuote() });
  } catch {
    const buf = await axios.get(videoUrl, {
      responseType: 'arraybuffer', timeout: 90000,
      maxContentLength: 150 * 1024 * 1024,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    }).then(r => Buffer.from(r.data));
    await conn.sendMessage(from, { video: buf, mimetype: 'video/mp4', caption }, { quoted: makeSmartQuote() });
  }
}

async function downloadByUrl(videoUrl) {
  const res = await axios.get(
    `https://www.tikwm.com/api/?url=${encodeURIComponent(videoUrl)}`,
    { timeout: 30000 }
  );
  const d = res.data?.data;
  if (!d?.play) throw new Error('Could not get download link');
  return d;
}

// ── Multi-API YouTube audio downloaders ───────────────────────────────────────
async function getAudioUrl(videoUrl) {
  const encodedUrl = encodeURIComponent(videoUrl);

  // API 1: giftedtech ytmp3
  try {
    const r = await axios.get(
      `https://api.giftedtech.co.ke/api/download/ytmp3?apikey=gifted&url=${encodedUrl}&quality=128kbps`,
      { timeout: 20000 }
    );
    if (r.data?.success && r.data?.result?.download_url) return r.data.result.download_url;
  } catch {}

  // API 2: giftedtech savetubemp3
  try {
    const r = await axios.get(
      `https://api.giftedtech.co.ke/api/download/savetubemp3?apikey=gifted&url=${encodedUrl}`,
      { timeout: 20000 }
    );
    if (r.data?.success && r.data?.result?.download_url) return r.data.result.download_url;
  } catch {}

  // API 3: cobalt
  try {
    const r = await axios.post(
      'https://cobalt-api.kwiatekkamilek.pl/',
      { url: videoUrl, isAudioOnly: true, aFormat: 'mp3' },
      { headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' }, timeout: 20000 }
    );
    if (r.data?.url) return r.data.url;
  } catch {}

  return null;
}

// ── Multi-API YouTube video downloaders ───────────────────────────────────────
async function getVideoUrl(videoUrl) {
  const encodedUrl = encodeURIComponent(videoUrl);

  // API 1: giftedtech savetubemp4
  try {
    const r = await axios.get(
      `https://api.giftedtech.co.ke/api/download/savetubemp4?apikey=gifted&url=${encodedUrl}`,
      { timeout: 20000 }
    );
    if (r.data?.success && r.data?.result?.download_url) return r.data.result.download_url;
  } catch {}

  // API 2: giftedtech ytmp4
  try {
    const r = await axios.get(
      `https://api.giftedtech.co.ke/api/download/ytmp4?apikey=gifted&url=${encodedUrl}&quality=720p`,
      { timeout: 20000 }
    );
    if (r.data?.success && r.data?.result?.download_url) return r.data.result.download_url;
  } catch {}

  // API 3: cobalt
  try {
    const r = await axios.post(
      'https://cobalt-api.kwiatekkamilek.pl/',
      { url: videoUrl, vQuality: '720' },
      { headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' }, timeout: 20000 }
    );
    if (r.data?.url) return r.data.url;
  } catch {}

  return null;
}

// ════════════════════════════════════════════════════════════════════
// COMMANDS
// ════════════════════════════════════════════════════════════════════

// ── YOUTUBE AUDIO — play ──────────────────────────────────────────────────────
cast({
  pattern:  'play',
  alias:    ['mp3', 'song'],
  desc:     'Download audio from YouTube by search query',
  category: 'downloader',
  filename: __filename,
  use:      '<search text>',
}, async (conn, mek, m, { from, q, reply }) => {
  try {
    if (!q) return reply('🎵 Give me a song name or search query.\n*Example:* play Never Gonna Give You Up');

    const { data: res } = await axios.get(
      `https://meta.davidxtech.de/api/yt/play?q=${encodeURIComponent(q)}`,
      { timeout: 30000, headers: { 'User-Agent': 'Mozilla/5.0' } }
    );

    if (!res?.success || !res?.data?.downloadUrl) {
      return reply('❌ Could not find or download that song. Try a different search.');
    }

    const track = res.data;

    await conn.sendMessage(from, {
      image:   { url: track.thumbnail },
      caption: `*🎵 ${BOT()} Music Downloader 🎵*\n\n` +
               `*🎧 Title:* ${track.title}\n` +
               `*🎙️ Artist:* ${track.channel}\n` +
               `*⏳ Duration:* ${fmtDuration(track.duration)}\n` +
               `*🎶 Quality:* ${track.quality || '128k'}\n\n` +
               `_Sending audio..._`
    }, { quoted: makeSmartQuote() });

    await conn.sendMessage(from, {
      audio:    { url: track.downloadUrl },
      mimetype: 'audio/mpeg',
      fileName: `${track.title}.mp3`,
      ptt:      false
    }, { quoted: makeSmartQuote() });

  } catch (err) {
    console.error('[play]', err.message);
    reply('❌ Something went wrong. Try again later.');
  }
});

// ── YOUTUBE VIDEO — video ─────────────────────────────────────────────────────
cast({
  pattern:  'video',
  alias:    ['video2', 'play2', 'yt'],
  desc:     'Download YouTube audio or video — reply with 1 or 2',
  category: 'downloader',
  filename: __filename
}, async (conn, mek, m, { from, q, reply }) => {
  try {
    if (!q) return reply('❌ Please provide a search query or YouTube URL!');

    const search = await yts(q);
    const video  = search.videos[0];
    if (!video) return reply('❌ No results found!');

    const videoUrl = video.url;
    const infoText =
      `*🎵 YT DOWNLOADER 🎵*\n\n` +
      `*📝 Title:* ${video.title}\n` +
      `*⏳ Duration:* ${video.timestamp}\n` +
      `*👁️ Views:* ${Number(video.views || 0).toLocaleString()}\n\n` +
      `*Reply with a number:*\n` +
      `1️⃣ *Audio (MP3)*\n` +
      `2️⃣ *Video (MP4)*\n\n` +
      `_I am waiting for your reply..._`;

    const sentMsg = await conn.sendMessage(from, {
      image:   { url: video.thumbnail },
      caption: infoText
    }, { quoted: makeSmartQuote() });

    const messageId = sentMsg.key.id;

    const handler = async (update) => {
      const msg = update.messages[0];
      if (!msg?.message) return;
      if (msg.key.remoteJid !== from) return;
      if (msg.key.id === messageId) return;

      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption || '';

      const ctx =
        msg.message?.extendedTextMessage?.contextInfo ||
        msg.message?.imageMessage?.contextInfo        ||
        msg.message?.videoMessage?.contextInfo        || null;

      if (!ctx || ctx.stanzaId !== messageId) return;
      if (text !== '1' && text !== '2') return;

      conn.ev.off('messages.upsert', handler);
      clearTimeout(killTimer);

      if (text === '1') {
        await conn.sendMessage(from, { react: { text: '⏳', key: msg.key } });
        await conn.sendMessage(from, { text: '🎧 Fetching audio...' }, { quoted: makeSmartQuote() });

        // Try davidxtech first, fall back to multi-api
        let audioUrl = null;
        try {
          const r = await axios.get(
            `https://meta.davidxtech.de/api/yt/play?q=${encodeURIComponent(video.title)}`,
            { timeout: 25000, headers: { 'User-Agent': 'Mozilla/5.0' } }
          );
          if (r.data?.success && r.data?.data?.downloadUrl) audioUrl = r.data.data.downloadUrl;
        } catch {}
        if (!audioUrl) audioUrl = await getAudioUrl(videoUrl);

        if (audioUrl) {
          await conn.sendMessage(from, {
            audio: { url: audioUrl }, mimetype: 'audio/mpeg',
            fileName: `${video.title}.mp3`, ptt: false
          }, { quoted: makeSmartQuote() });
          await conn.sendMessage(from, { react: { text: '✅', key: msg.key } });
        } else {
          await conn.sendMessage(from, { react: { text: '❌', key: msg.key } });
          reply('❌ All audio APIs failed. Try again later.');
        }

      } else if (text === '2') {
        await conn.sendMessage(from, { react: { text: '⏳', key: msg.key } });
        await conn.sendMessage(from, { text: '🎬 Fetching video...' }, { quoted: makeSmartQuote() });

        const videoDownloadUrl = await getVideoUrl(videoUrl);

        if (videoDownloadUrl) {
          await conn.sendMessage(from, {
            video:    { url: videoDownloadUrl },
            mimetype: 'video/mp4',
            caption:  `🎵 *${video.title}*\n_${BOT()}_`
          }, { quoted: makeSmartQuote() });
          await conn.sendMessage(from, { react: { text: '✅', key: msg.key } });
        } else {
          await conn.sendMessage(from, { react: { text: '❌', key: msg.key } });
          reply('❌ All video APIs failed. Try again or use a shorter video.');
        }
      }
    };

    conn.ev.on('messages.upsert', handler);
    const killTimer = setTimeout(() => {
      conn.ev.off('messages.upsert', handler);
    }, 300000);

  } catch (error) {
    console.error('[video]', error);
    reply('❌ An error occurred. Try again.');
  }
});

// ── TIKTOK SEARCH — ttsearch ──────────────────────────────────────────────────
cast({
  pattern:  'ttsearch',
  alias:    ['tiktoksearch', 'searchtt'],
  desc:     'Search TikTok — reply to any preview to download',
  category: 'downloader',
  react:    '🔍',
  filename: __filename
}, async (conn, mek, m, { from, q, reply }) => {
  if (!q) return reply(
    `🎵 *TikTok Search*\n\n` +
    `*Usage:* ttsearch <keyword>\n` +
    `*Example:* ttsearch afrobeats 2025\n\n` +
    `_Bot will send previews — just reply to any one to download it._`
  );

  await conn.sendMessage(from, { react: { text: '⏳', key: mek.key } });

  let items = [];

  try {
    const res = await axios.get(
      `https://meta.davidxtech.de/api/tiktokv2/search?q=${encodeURIComponent(q)}`,
      { timeout: 20000, headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const raw  = res.data;
    const list =
      raw?.data?.videos || raw?.data?.items || raw?.results ||
      raw?.items || (Array.isArray(raw?.data) ? raw.data : null) ||
      (Array.isArray(raw) ? raw : null);

    if (Array.isArray(list) && list.length) {
      items = list.slice(0, 5).map(v => ({
        title:    getField(v, 'desc', 'title', 'video_description', 'caption') || 'No title',
        author:   getField(v, 'author.unique_id', 'author.nickname', 'username', 'author_name') || 'unknown',
        likes:    getField(v, 'digg_count', 'statistics.diggCount', 'like_count'),
        plays:    getField(v, 'play_count', 'statistics.playCount', 'view_count'),
        duration: getField(v, 'duration'),
        cover:    getField(v, 'cover', 'origin_cover', 'thumbnail', 'cover_image_url', 'video.cover'),
        url:      getField(v, 'share_url', 'url', 'video_url',
                    v.id || v.aweme_id
                      ? `https://www.tiktok.com/@${getField(v, 'author.unique_id', 'username') || 'user'}/video/${v.id || v.aweme_id}`
                      : null),
      })).filter(v => v.url);
    }
  } catch (e) {
    console.error('[ttsearch] davidxtech error:', e.message);
  }

  if (!items.length) {
    try {
      const res = await axios.get(
        `https://www.tikwm.com/api/feed/search?keywords=${encodeURIComponent(q)}&count=5&cursor=0`,
        { timeout: 20000, headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      const list = res.data?.data?.videos || res.data?.data || [];
      if (Array.isArray(list) && list.length) {
        items = list.slice(0, 5).map(v => ({
          title:    v.title || v.desc || 'No title',
          author:   v.author?.unique_id || v.author?.nickname || 'unknown',
          likes:    v.digg_count,
          plays:    v.play_count,
          duration: v.duration,
          cover:    v.cover || v.origin_cover,
          url:      `https://www.tiktok.com/@${v.author?.unique_id || 'user'}/video/${v.video_id || v.id}`,
        }));
      }
    } catch (e2) {
      console.error('[ttsearch] tikwm fallback error:', e2.message);
    }
  }

  if (!items.length) {
    await conn.sendMessage(from, { react: { text: '❌', key: mek.key } });
    return reply(`❌ No results found for *"${q}"*.\nTry a different keyword.`);
  }

  const sentIds = new Map();

  await conn.sendMessage(from, {
    text: `🔍 *TikTok: "${q}"* — ${items.length} results\n_↩️ Reply to any preview below to download it_`
  }, { quoted: makeSmartQuote() });

  for (let i = 0; i < items.length; i++) {
    const v   = items[i];
    const dur = v.duration
      ? `⏱ ${Math.floor(v.duration / 60)}:${String(v.duration % 60).padStart(2, '0')}`
      : '';

    const caption =
      `${EMOJIS[i]} *${v.title.length > 80 ? v.title.substring(0, 77) + '...' : v.title}*\n\n` +
      `👤 @${v.author}\n` +
      [dur, v.likes ? `❤️ ${fmtNum(v.likes)}` : '', v.plays ? `▶️ ${fmtNum(v.plays)}` : '']
        .filter(Boolean).join('  ') +
      `\n\n_↩️ Reply to download this video_`;

    try {
      const sent = v.cover
        ? await conn.sendMessage(from, { image: { url: v.cover }, caption }, { quoted: makeSmartQuote() })
        : await conn.sendMessage(from, { text: caption }, { quoted: makeSmartQuote() });
      if (sent?.key?.id) sentIds.set(sent.key.id, i);
    } catch (e) {
      console.error(`[ttsearch] send preview ${i + 1} error:`, e.message);
    }
  }

  await conn.sendMessage(from, { react: { text: '✅', key: mek.key } });

  const handler = async ({ messages }) => {
    const msg = messages[0];
    if (!msg?.message) return;
    if (msg.key.remoteJid !== from) return;
    if (sentIds.has(msg.key.id)) return;

    const ctx =
      msg.message?.extendedTextMessage?.contextInfo ||
      msg.message?.imageMessage?.contextInfo        ||
      msg.message?.videoMessage?.contextInfo        ||
      msg.message?.audioMessage?.contextInfo        ||
      msg.message?.stickerMessage?.contextInfo      || null;

    const stanzaId = ctx?.stanzaId;
    if (!stanzaId || !sentIds.has(stanzaId)) return;

    conn.ev.off('messages.upsert', handler);
    clearTimeout(killTimer);

    const video = items[sentIds.get(stanzaId)];

    await conn.sendMessage(from, {
      text: `⏳ Downloading *${video.title.substring(0, 50)}...*`
    }, { quoted: makeSmartQuote() });

    try {
      const d = await downloadByUrl(video.url);
      const caption =
        `🎵 *${video.title.substring(0, 80)}${video.title.length > 80 ? '...' : ''}*\n\n` +
        `👤 @${video.author}\n` +
        (d.duration ? `⏱ ${Math.floor(d.duration / 60)}:${String(d.duration % 60).padStart(2, '0')}\n` : '') +
        (d.digg_count ? `❤️ ${fmtNum(d.digg_count)}\n` : '') +
        `\n_${BOT()}_`;

      await conn.sendMessage(from, {
        video: { url: d.play }, mimetype: 'video/mp4', caption
      }, { quoted: makeSmartQuote() });

    } catch (e) {
      console.error('[ttsearch] download error:', e.message);
      await conn.sendMessage(from, {
        text: `❌ Download failed: ${e.message}\nSearch again with *ttsearch*.`
      }, { quoted: makeSmartQuote() });
    }
  };

  conn.ev.on('messages.upsert', handler);
  const killTimer = setTimeout(() => {
    conn.ev.off('messages.upsert', handler);
  }, 5 * 60 * 1000);
});

// ── FACEBOOK DOWNLOADER ───────────────────────────────────────────────────────
cast({
  pattern:  'facebook',
  alias:    ['fb', 'fbdl', 'facebookdl'],
  desc:     'Download Facebook videos and reels',
  category: 'downloader',
  react:    '🔄',
  filename: __filename,
}, async (conn, mek, m, { from, args, reply }) => {
  try {
    if (!args[0]) return reply('📘 *Facebook Downloader*\n\nUsage: facebook <url>\nSupports: videos, reels, fb.watch');
    const url = args.join(' ').trim();
    if (!isValidFbUrl(url)) return reply('❌ Not a valid Facebook link.');

    await conn.sendMessage(from, { react: { text: '⏳', key: mek.key } });
    let links = [];

    try {
      const res = await axios.get(
        `https://meta.davidxtech.de/api/facebook/download?url=${encodeURIComponent(url)}`,
        { timeout: 20000, headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      links = extractFbLinks(res.data);
    } catch {}

    if (!links.length) {
      try {
        const home = await axios.get('https://snapsave.app/', { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 });
        const tm = home.data.match(/name="token"\s+value="([^"]+)"/);
        if (tm) {
          const form = new URLSearchParams();
          form.append('url', url); form.append('token', tm[1]);
          const res = await axios.post('https://snapsave.app/action.php', form.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://snapsave.app/', 'User-Agent': 'Mozilla/5.0' },
            timeout: 20000
          });
          const hdM = res.data.match(/href="(https:\/\/[^"]+)"[^>]*>\s*(?:HD|High)/i);
          const sdM = res.data.match(/href="(https:\/\/[^"]+)"[^>]*>\s*(?:SD|Normal)/i);
          if (hdM) links.push({ quality: 'HD', url: hdM[1] });
          if (sdM) links.push({ quality: 'SD', url: sdM[1] });
        }
      } catch {}
    }

    if (!links.length) {
      await conn.sendMessage(from, { react: { text: '❌', key: mek.key } });
      return reply('❌ Could not download. Make sure the video is public.');
    }

    const best = links.find(l => l.quality === 'HD') || links[0];
    const cap  = `📘 *Facebook Video*\n📹 Quality: ${best.quality}`;

    try {
      await conn.sendMessage(from, { video: { url: best.url }, mimetype: 'video/mp4', caption: cap }, { quoted: makeSmartQuote() });
    } catch {
      const buf = await axios.get(best.url, { responseType: 'arraybuffer', timeout: 90000, headers: { 'User-Agent': 'Mozilla/5.0' } }).then(r => Buffer.from(r.data));
      await conn.sendMessage(from, { video: buf, mimetype: 'video/mp4', caption: cap }, { quoted: makeSmartQuote() });
    }
    await conn.sendMessage(from, { react: { text: '✅', key: mek.key } });
  } catch (e) {
    console.error('[FB]', e.message);
    await conn.sendMessage(from, { react: { text: '❌', key: mek.key } }).catch(() => {});
    reply('❌ Failed. Make sure the video is public and try again.');
  }
});

// ── PORNHUB DOWNLOADER ────────────────────────────────────────────────────────
cast({
  pattern:  'pornhub',
  alias:    ['ph', 'phdl'],
  desc:     'Download PornHub videos — paste the video URL',
  category: 'downloader',
  react:    '🔞',
  filename: __filename,
}, async (conn, mek, m, { from, args, reply }) => {
  try {
    if (!args[0]) return reply(
      '🔞 *PornHub Downloader*\n\n' +
      'Usage: pornhub <url>\n' +
      'Example: pornhub https://www.pornhub.com/view_video.php?viewkey=...\n\n' +
      '_Supports 240p, 480p, 720p, 1080p_'
    );

    const url = args.join(' ').trim();
    if (!isValidPhUrl(url)) return reply('❌ Not a valid PornHub video link.');

    await conn.sendMessage(from, { react: { text: '⏳', key: mek.key } });

    const { data: res } = await axios.get(
      `https://meta.davidxtech.de/api/pornhub/download?url=${encodeURIComponent(url)}`,
      { timeout: 25000, headers: { 'User-Agent': 'Mozilla/5.0' } }
    );

    if (!res?.success || !Array.isArray(res?.data?.formats) || !res.data.formats.length) {
      await conn.sendMessage(from, { react: { text: '❌', key: mek.key } });
      return reply('❌ Could not fetch video. Make sure the link is valid and the video is public.');
    }

    const info    = res.data;
    const formats = info.formats;

    // Prefer direct MP4 formats (not HLS) — pick best quality available
    const directFormats = formats.filter(f => !f.format_id.startsWith('hls'));
    const preferred     = ['1080p', '720p', '480p', '240p'];
    let best = null;
    for (const q of preferred) {
      best = directFormats.find(f => f.format_id === q);
      if (best) break;
    }
    if (!best) best = directFormats[0] || formats[0];

    const mins = Math.floor(info.duration / 60);
    const secs = String(info.duration % 60).padStart(2, '0');

    // Send info card with thumbnail
    const caption =
      `🔞 *PornHub Video*\n\n` +
      `*📝 Title:* ${info.title}\n` +
      `*⏳ Duration:* ${mins}:${secs}\n` +
      `*👁️ Views:* ${fmtNum(info.views)}\n` +
      `*⭐ Rating:* ${info.rating?.toFixed(1)}%\n` +
      `*📹 Quality:* ${best.format_id}\n\n` +
      `_Sending video..._`;

    if (info.thumbnail) {
      await conn.sendMessage(from, {
        image: { url: info.thumbnail }, caption
      }, { quoted: makeSmartQuote() });
    } else {
      await conn.sendMessage(from, { text: caption }, { quoted: makeSmartQuote() });
    }

    // Send video using proxyDownload URL (more reliable for PH's CDN)
    const videoUrl = best.proxyDownload || best.url;

    try {
      await conn.sendMessage(from, {
        video:    { url: videoUrl },
        mimetype: 'video/mp4',
        caption:  `🔞 *${info.title}*\n_${BOT()}_`
      }, { quoted: makeSmartQuote() });
    } catch {
      // Fall back to buffering
      const buf = await axios.get(videoUrl, {
        responseType: 'arraybuffer',
        timeout: 120000,
        maxContentLength: 200 * 1024 * 1024,
        headers: { 'User-Agent': 'Mozilla/5.0' }
      }).then(r => Buffer.from(r.data));
      await conn.sendMessage(from, {
        video:    buf,
        mimetype: 'video/mp4',
        caption:  `🔞 *${info.title}*\n_${BOT()}_`
      }, { quoted: makeSmartQuote() });
    }

    await conn.sendMessage(from, { react: { text: '✅', key: mek.key } });

  } catch (e) {
    console.error('[pornhub]', e.message);
    await conn.sendMessage(from, { react: { text: '❌', key: mek.key } }).catch(() => {});
    reply('❌ Failed to download. Try again later.');
  }
});
