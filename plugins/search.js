'use strict';

const { cast, makeSmartQuote, applyFont } = require('../cast');
const config = require('../config');
const axios = require('axios');
const fetch = require('node-fetch');
const APIs     = require('../lib/apiUtils');

const { Sticker, StickerTypes } = require('wa-sticker-formatter');

// ── SEARCH — lyrics/github/imdb/weather/npm/image/couplepp 

const bot = config.BOT_NAME || 'NEXUS-MD';

// ── lyrics ────────────────────────────────────────────────────────────
// Free lyrics using lrclib.net (3M+ songs, no key, no rate limit)
// Fallback: api.lyrics.ovh (no key)
// Pattern: lyrics2 — avoids conflict with any existing lyrics c

// ── Strip LRC timestamps from synced lyrics ───────────────────────────
// Converts "[00:27.93] Listen to the wind blow" → "Listen to the wind blow"
function stripTimestamps(lrc) {
  return lrc
    .split('\n')
    .map(l => l.replace(/^\[\d{2}:\d{2}\.\d{2,3}\]\s?/, '').trim())
    .filter(Boolean)
    .join('\n');
}

// ── Split long lyrics into WhatsApp-safe chunks (max 4000 chars) ──────
function chunkLyrics(text, size = 3800) {
  const lines  = text.split('\n');
  const chunks = [];
  let   cur    = '';
  for (const line of lines) {
    if ((cur + '\n' + line).length > size) {
      if (cur) chunks.push(cur.trim());
      cur = line;
    } else {
      cur += (cur ? '\n' : '') + line;
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}

cast({
  pattern:  'lyrics',
  alias:    ['lyric', 'lyr', 'getlyrics', 'songlyrics'],
  desc:     'Get song lyrics. Usage: lyrics2 <song name> or lyrics2 <artist> - <song>',
  category: 'search',
  react:    '🎵',
  filename: __filename
}, async (conn, mek, m, { from, q, reply }) => {
  try {
    if (!q) return reply(
      `🎵 *Lyrics Finder*\n\n` +
      `*Usage:*\n` +
      `• lyrics2 <song name>\n` +
      `• lyrics2 <artist> - <song>\n\n` +
      `*Examples:*\n` +
      `lyrics2 Blinding Lights\n` +
      `lyrics2 The Weeknd - Blinding Lights`
    );

    await conn.sendMessage(from, { react: { text: '⏳', key: mek.key } });

    // Parse "artist - song" format if given
    let artistQuery = '';
    let trackQuery  = q;
    if (q.includes(' - ')) {
      const parts = q.split(' - ');
      artistQuery  = parts[0].trim();
      trackQuery   = parts.slice(1).join(' - ').trim();
    }

    let result = null;
    let source = '';

    // ── Method 1: lrclib.net search ─────────────────────────────────
    // No key, no rate limit, 3M+ songs
    try {
      const params = new URLSearchParams({ q });
      if (artistQuery) params.set('artist_name', artistQuery);
      if (trackQuery !== q) params.set('track_name', trackQuery);

      const res  = await axios.get(`https://lrclib.net/api/search?${params.toString()}`, {
        timeout: 15000,
        headers: { 'User-Agent': 'NEXUS-MD-Bot/1.0 (WhatsApp Bot)' }
      });

      const hits = res.data;
      if (Array.isArray(hits) && hits.length) {
        // Prefer results that have actual lyrics
        const withLyrics = hits.find(h => h.plainLyrics && !h.instrumental);
        const best       = withLyrics || hits[0];

        if (best && (best.plainLyrics || best.syncedLyrics)) {
          result = {
            title:  best.trackName  || trackQuery,
            artist: best.artistName || artistQuery || 'Unknown',
            album:  best.albumName  || '',
            lyrics: best.plainLyrics || stripTimestamps(best.syncedLyrics || ''),
            instrumental: best.instrumental
          };
          source = 'lrclib';
        }
      }
    } catch (e) {
      console.error('[lyrics] lrclib error:', e.message);
    }

    // ── Method 2: lyrics.ovh fallback ───────────────────────────────
    if (!result && artistQuery && trackQuery) {
      try {
        const res = await axios.get(
          `https://api.lyrics.ovh/v1/${encodeURIComponent(artistQuery)}/${encodeURIComponent(trackQuery)}`,
          { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } }
        );
        if (res.data?.lyrics) {
          result = {
            title:  trackQuery,
            artist: artistQuery,
            album:  '',
            lyrics: res.data.lyrics.trim(),
            instrumental: false
          };
          source = 'lyrics.ovh';
        }
      } catch (e) {
        console.error('[lyrics] lyrics.ovh error:', e.message);
      }
    }

    // ── Method 3: giftedtech lyrics fallback ────────────────────────
    if (!result) {
      try {
        const res = await axios.get(
          `https://api-gifted-tech.onrender.com/api/search/lyrics?query=${encodeURIComponent(q)}&apikey=gifteddevskk`,
          { timeout: 20000, headers: { 'User-Agent': 'Mozilla/5.0' } }
        );
        const d = res.data;
        if (d?.result?.lyrics || d?.lyrics) {
          result = {
            title:  d?.result?.title || d?.title || trackQuery,
            artist: d?.result?.artist || d?.artist || '',
            album:  '',
            lyrics: (d?.result?.lyrics || d?.lyrics || '').trim(),
            instrumental: false
          };
          source = 'gifted';
        }
      } catch (e) {
        console.error('[lyrics] giftedtech error:', e.message);
      }
    }

    // ── Not found ────────────────────────────────────────────────────
    if (!result) {
      await conn.sendMessage(from, { react: { text: '❌', key: mek.key } });
      return reply(
        `❌ Lyrics not found for *"${q}"*.\n\n` +
        `_Tips:_\n` +
        `• Try: lyrics2 <artist> - <song>\n` +
        `• Check your spelling\n` +
        `• Use the English song title`
      );
    }

    // ── Instrumental track ───────────────────────────────────────────
    if (result.instrumental) {
      await conn.sendMessage(from, { react: { text: '🎼', key: mek.key } });
      return reply(`🎼 *${result.title}* by *${result.artist}* is an instrumental track — no lyrics available.`);
    }

    // ── Send lyrics ──────────────────────────────────────────────────
    const header =
      `🎵 *${result.title}*\n` +
      `👤 ${result.artist}\n` +
      (result.album ? `💿 ${result.album}\n` : '') +
      `${'─'.repeat(28)}`;

    const fullLyrics = `${header}\n\n${result.lyrics}`;
    const chunks     = chunkLyrics(fullLyrics);

    // Send first chunk as reply to the command
    await conn.sendMessage(from, { text: chunks[0] }, { quoted: makeSmartQuote() });

    // Send remaining chunks sequentially
    for (let i = 1; i < chunks.length; i++) {
      await new Promise(r => setTimeout(r, 600)); 
      await conn.sendMessage(from, { text: chunks[i] }, { quoted: makeSmartQuote() });
    }

    await conn.sendMessage(from, { react: { text: '✅', key: mek.key } });

  } catch (err) {
    console.error('[lyrics] Fatal:', err.message);
    await conn.sendMessage(from, { react: { text: '❌', key: mek.key } }).catch(() => {});
    reply('❌ Something went wrong. Try again.');
  }
});

// ── github ────────────────────────────────────────────────────────────
cast({ pattern: 'github', alias: ['gsearch'], desc: 'GitHub user info', category: 'search', filename: __filename },
async (conn, mek, m, { from, q, reply }) => {
  try {
    if (!q) return reply('*Provide a GitHub username!*\nExample: /github torvalds');
    const { data } = await axios.get(`https://api.github.com/users/${q}`);
    const msg = `👤 *GitHub User Info*\n\n🆔 *ID:* ${data.id}\n📛 *Name:* ${data.name || 'N/A'}\n🔗 *Login:* ${data.login}\n📝 *Bio:* ${data.bio || 'N/A'}\n🏢 *Company:* ${data.company || 'N/A'}\n📍 *Location:* ${data.location || 'N/A'}\n📧 *Email:* ${data.email || 'N/A'}\n📁 *Repos:* ${data.public_repos}\n❤️ *Followers:* ${data.followers}\n👉 *Following:* ${data.following}\n📅 *Joined:* ${data.created_at?.split('T')[0]}`;
    if (data.avatar_url) {
      await conn.sendMessage(from, { image: { url: data.avatar_url }, caption: msg }, { quoted: makeSmartQuote() });
    } else {
      await conn.sendMessage(from, { text: msg }, { quoted: makeSmartQuote() });
    }
  } catch (e) { reply(`❌ Error: ${e.message}`); }
});

// ── coffe ─────────────────────────────────────────────────────────────
cast({ pattern: 'coffe', alias: ['coffee'], react: '☕', desc: 'Random coffee image', category: 'search', filename: __filename },
async (conn, mek, m, { from, reply }) => {
  try {
    await conn.sendMessage(from, { image: { url: 'https://coffee.alexflipnote.dev/random' }, caption: '☕ *Here is your coffee!*' }, { quoted: makeSmartQuote() });
  } catch (e) { reply(`❌ Error: ${e.message}`); }
});

// ── imdb ──────────────────────────────────────────────────────────────
cast({ pattern: 'imdb', desc: 'Movie/series info from IMDB', category: 'search', filename: __filename },
async (conn, mek, m, { from, q, reply }) => {
  try {
    if (!q) return reply('*Provide a movie/series title!*\nExample: /imdb Avengers');
    const { data } = await axios.get(`http://www.omdbapi.com/?apikey=742b2d09&t=${encodeURIComponent(q)}&plot=full`);
    if (!data || data.Response === 'False') return reply('*Movie/series not found!*');
    const msg = `🎬 *${data.Title}* (${data.Year})\n\n⭐ *Rated:* ${data.Rated}\n📅 *Released:* ${data.Released}\n⏳ *Runtime:* ${data.Runtime}\n🎭 *Genre:* ${data.Genre}\n🎬 *Director:* ${data.Director}\n👨 *Actors:* ${data.Actors}\n📝 *Plot:* ${data.Plot}\n🌐 *Language:* ${data.Language}\n🌍 *Country:* ${data.Country}\n🏆 *Awards:* ${data.Awards}\n📦 *Box Office:* ${data.BoxOffice}\n🌟 *IMDB Rating:* ${data.imdbRating}/10`;
    if (data.Poster && data.Poster !== 'N/A') {
      await conn.sendMessage(from, { image: { url: data.Poster }, caption: msg }, { quoted: makeSmartQuote() });
    } else {
      await conn.sendMessage(from, { text: msg }, { quoted: makeSmartQuote() });
    }
  } catch (e) { reply(`❌ Error: ${e.message}`); }
});

// ── weather ───────────────────────────────────────────────────────────
cast({ pattern: 'weather', desc: 'Weather info for a city', category: 'search', filename: __filename },
async (conn, mek, m, { from, q, reply }) => {
  try {
    if (!q) return reply('*Provide a city name!*\nExample: /weather Johannesburg');
    const { data } = await axios.get(`https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(q)}&units=metric&appid=060a6bcfa19809c2cd4d97a212b19273`);
    if (!data || data.cod === '404') return reply('*City not found!*');
    const msg = `🌍 *Weather in ${q}*\n\n☁️ *Condition:* ${data.weather[0].main} — ${data.weather[0].description}\n🌡️ *Temperature:* ${data.main.temp}°C (Feels like ${data.main.feels_like}°C)\n💧 *Humidity:* ${data.main.humidity}%\n💨 *Wind:* ${data.wind.speed} m/s\n📍 *Lat/Lon:* ${data.coord.lat}, ${data.coord.lon}\n🌐 *Country:* ${data.sys.country}`;
    await conn.sendMessage(from, { text: msg }, { quoted: makeSmartQuote() });
  } catch (e) { reply(`❌ Error: ${e.message}`); }
});

// ── npm ────────────────────────────────────────────────────────────────
cast({ pattern: 'npm', desc: 'Search npm packages', category: 'search', filename: __filename },
async (conn, mek, m, { from, q, reply }) => {
  try {
    if (!q) return reply('*Provide a package name!*\nExample: /npm axios');
    const { data } = await axios.get(`https://api.npms.io/v2/search?q=${encodeURIComponent(q)}`);
    if (!data?.results?.length) return reply('*No packages found.*');
    const txt = data.results.slice(0, 5).map(({ package: pkg }) =>
      `📦 *${pkg.name}* (v${pkg.version})\n📝 ${pkg.description || 'No description'}\n🔗 ${pkg.links?.npm}`
    ).join('\n\n');
    await conn.sendMessage(from, { text: txt }, { quoted: makeSmartQuote() });
  } catch (e) { reply(`❌ Error: ${e.message}`); }
});

// ── couplepp ──────────────────────────────────────────────────────────
cast({ pattern: 'couplepp', desc: 'Random couple profile pictures', category: 'search', filename: __filename },
async (conn, mek, m, { from, reply }) => {
  try {
    const res = await fetch('https://raw.githubusercontent.com/iamriz7/kopel_/main/kopel.json');
    const anu = await res.json();
    const random = anu[Math.floor(Math.random() * anu.length)];
    await conn.sendMessage(from, { image: { url: random.male }, caption: '💙 *Couple Male Profile*' }, { quoted: makeSmartQuote() });
    await conn.sendMessage(from, { image: { url: random.female }, caption: '💗 *Couple Female Profile*' }, { quoted: makeSmartQuote() });
  } catch (e) { reply(`❌ Error: ${e.message}`); }
});

// ── image ──────────────────────────────────────────────────────────────
cast({ pattern: 'image', alias: ['img', 'pic'], desc: 'Search and send images', category: 'search', filename: __filename },
async (conn, mek, m, { from, q, reply }) => {
  try {
    if (!q) return reply('*Provide a search query!*\nExample: /image Godzilla');
    const [query, countStr] = q.split('|').map(s => s.trim());
    const count = Math.min(parseInt(countStr) || 3, 5);

    await conn.sendMessage(from, { react: { text: '🔍', key: mek.key } });

    // Use davidxtech Google image search API
    const res = await axios.get('https://meta.davidxtech.de/api/google/search', {
      params: { q: query },
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    const images = res.data?.images || res.data?.results || res.data;
    const urls = Array.isArray(images)
      ? images.map(i => i?.url || i?.link || i?.original || i).filter(u => typeof u === 'string' && u.startsWith('http'))
      : [];

    if (!urls.length) {
      await conn.sendMessage(from, { react: { text: '❌', key: mek.key } });
      return reply('❌ No images found. Try a different keyword.');
    }

    let sent = 0;
    for (let i = 0; i < urls.length && sent < count; i++) {
      try {
        await conn.sendMessage(from, { image: { url: urls[i] }, caption: `🔍 *${query}*` }, { quoted: makeSmartQuote() });
        sent++;
        await new Promise(r => setTimeout(r, 700));
      } catch {}
    }

    if (sent === 0) return reply('❌ Could not load images. Try a different keyword.');
    await conn.sendMessage(from, { react: { text: '✅', key: mek.key } });
  } catch (e) {
    console.error('[image]', e.message);
    reply(`❌ Error: ${e.message}`);
  }
});

cast({
    pattern: "define",
    desc: "📖 Get the definition of a word",
    react: "🔍",
    category: 'search',
    filename: __filename
}, 
async (conn, mek, m, { from, q, reply }) => {
    try {
        if (!q) {
            const noWordMsg = "Please provide a word to define.\n\n📌 *Usage:* .define [word]";
            if (m.isGroup) {
                return await reply(noWordMsg);
            } else {
                return await conn.sendMessage(from, { text: noWordMsg }, { quoted: makeSmartQuote() });
            }
        }

        const word = q.trim();
        const url = `https://api.dictionaryapi.dev/api/v2/entries/en/${word}`;

        const response = await axios.get(url);
        const definitionData = response.data[0];

        const definition = definitionData.meanings[0].definitions[0].definition;
        const example = definitionData.meanings[0].definitions[0].example || '❌ No example available';
        const synonyms = definitionData.meanings[0].definitions[0].synonyms.join(', ') || '❌ No synonyms available';
        const phonetics = definitionData.phonetics[0]?.text || '🔇 No phonetics available';
        const audio = definitionData.phonetics[0]?.audio || null;

        const wordInfo = `
📖 *Word*: *${definitionData.word}* 🗣️ *Pronunciation*: _${phonetics}_  
📚 *Definition*: ${definition}  
✍️ *Example*: ${example}  
📝 *Synonyms*: ${synonyms}  

🔗 *Powered By Pʟᴀᴛɪɴᴜᴍ-V1*`;

        if (audio) {
            await conn.sendMessage(from, { audio: { url: audio }, mimetype: 'audio/mpeg' }, { quoted: makeSmartQuote() });
        }

        return await conn.sendMessage(from, { text: wordInfo }, { quoted: makeSmartQuote() });

    } catch (e) {
        console.error("❌ Error:", e);
        if (e.response && e.response.status === 404) {
            return reply("🚫 *Word not found.* Please check the spelling and try again.");
        }
        return reply("⚠️ An error occurred while fetching the definition. Please try again later.");
    }
});

// ── STICKER SEARCH ────────────────────────────────────

cast({
  pattern: 'stickersearch',
  alias: ['sticsearch', 'sticksearch'],
  desc: 'Search for animated stickers/GIFs',
  category: 'search',
  filename: __filename
}, async (conn, mek, m, { from, q, reply }) => {
  try {
    if (!q) return reply(`*Provide a search term!*\nExample: ${config.PREFIX || ':'}stickersearch happy`);

    await conn.sendMessage(from, { react: { text: '🔍', key: mek.key } });

    let gifUrls = [];

    // Method 1: GIPHY public keys (try all)
    for (const key of ['dc6zaTOxFJmzC', 'GlEB2oiMRimVbg', 'sXgGIPHIKIo40']) {
      if (gifUrls.length) break;
      try {
        const res = await axios.get('https://api.giphy.com/v1/gifs/search', {
          params: { api_key: key, q, limit: 6, rating: 'g' },
          timeout: 10000
        });
        gifUrls = (res.data?.data || [])
          .map(g => g?.images?.downsized?.url || g?.images?.fixed_height?.url)
          .filter(Boolean);
      } catch {}
    }

    // Method 2: Tenor v1 official demo key
    if (!gifUrls.length) {
      try {
        const res = await axios.get('https://api.tenor.com/v1/search', {
          params: { q, key: 'LIVDSRZULELA', limit: 6, media_filter: 'minimal' },
          timeout: 10000
        });
        gifUrls = (res.data?.results || [])
          .map(r => r?.media?.[0]?.gif?.url)
          .filter(Boolean);
      } catch (e) { console.error('[stickersearch] Tenor:', e.message); }
    }

    if (!gifUrls.length) {
      await conn.sendMessage(from, { react: { text: '❌', key: mek.key } });
      return reply(`❌ Could not find stickers for "*${q}*". Try a different keyword.`);
    }

    const count = Math.min(gifUrls.length, 4);
    await conn.sendMessage(from, { text: `🎭 Sending *${count}* sticker(s) for "*${q}*"...` }, { quoted: makeSmartQuote() });

    let sent = 0;
    for (let i = 0; i < gifUrls.length && sent < count; i++) {
      try {
        const buf = await axios.get(gifUrls[i], { responseType: 'arraybuffer', timeout: 15000 })
          .then(r => Buffer.from(r.data));
        const sticker = new Sticker(buf, {
          pack:    config.BOT_NAME   || 'NEXUS-MD',
          author:  config.OWNER_NAME || 'Bot',
          type:    StickerTypes.FULL,
          quality: 70
        });
        await conn.sendMessage(from, { sticker: await sticker.toBuffer() }, { quoted: makeSmartQuote() });
        sent++;
        await new Promise(r => setTimeout(r, 800));
      } catch (e) { console.error('[stickersearch] convert:', e.message); }
    }

    if (sent === 0) return reply('❌ Could not convert to stickers. Try again.');
    await conn.sendMessage(from, { react: { text: '✅', key: mek.key } });
  } catch (e) {
    console.error('[stickersearch]', e.message);
    reply(`❌ Error: ${e.message}`);
  }
});

// ── SCREENSHOT WEB ────────────────────────────────────

cast({
  pattern: 'ssweb',
  alias: ['screenshot', 'ss', 'webss'],
  desc: 'Take a screenshot of a website',
  category: 'search',
  filename: __filename,
}, async (conn, mek, m, { from, args, reply }) => {
  if (!args.length) return reply('❌ Provide a URL!\nExample: :ssweb https://github.com');
  const url = args.join(' ');
  if (!url.startsWith('http://') && !url.startsWith('https://'))
    return reply('❌ URL must start with http:// or https://');

  await conn.sendMessage(from, { react: { text: '📸', key: mek.key } });
  try {
    const buf = await APIs.screenshotWebsite(url);
    await conn.sendMessage(from, { image: buf }, { quoted: makeSmartQuote() });
  } catch (e) {
    reply(`❌ Screenshot failed: ${e.message}`);
  }
});

// ── TRANSLATE ─────────────────────────────────────────

// Valid ISO 639-1 language codes (common ones)
const LANG_CODES = new Set([
  'af','sq','am','ar','hy','az','eu','be','bn','bs','bg','ca','ceb','ny','zh','zh-TW',
  'co','hr','cs','da','nl','en','eo','et','tl','fi','fr','fy','gl','ka','de','el','gu',
  'ht','ha','haw','he','hi','hmn','hu','is','ig','id','ga','it','ja','jw','kn','kk','km',
  'ko','ku','ky','lo','la','lv','lt','lb','mk','mg','ms','ml','mt','mi','mr','mn','my',
  'ne','no','ps','fa','pl','pt','pa','ro','ru','sm','gd','sr','st','sn','sd','si','sk',
  'sl','so','es','su','sw','sv','tg','ta','te','th','tr','uk','ur','uz','vi','cy','xh',
  'yi','yo','zu'
]);

cast({
  pattern: 'translate',
  alias: ['tr', 'trans'],
  desc: 'Translate text. Usage: translate <text> OR translate <lang> <text>',
  category: 'search',
  filename: __filename,
}, async (conn, mek, m, { from, args, q, reply }) => {
  if (!args.length) return reply(
    '❌ Usage:\n' +
    '• *translate <text>* — translates to English\n' +
    '• *translate <lang> <text>* — translates to specified language\n\n' +
    'Examples:\n' +
    '• translate Buenos Dias\n' +
    '• translate en Bonjour\n' +
    '• translate fr Hello world\n\n' +
    'Lang codes: en, es, fr, de, it, pt, ru, ja, ko, zh, ar...'
  );

  // If first arg is a known language code, use it — otherwise default to English
  let lang, text;
  if (LANG_CODES.has(args[0].toLowerCase())) {
    lang = args[0].toLowerCase();
    text = args.slice(1).join(' ');
    if (!text) return reply('❌ Provide text to translate after the language code.');
  } else {
    lang = 'en';
    text = args.join(' ');
  }

  try {
    const result = await APIs.translate(text, lang);
    const translated = result?.translation || result?.data?.translatedText || result;
    const detectedFrom = result?.from ? ` _(detected: ${result.from.toUpperCase()})_` : '';
    await reply(
      `🌐 *Translation*\n\n` +
      `📝 *Original:* ${text}\n` +
      `🔤 *Translated:* ${translated}\n` +
      `🌍 *Language:* ${lang.toUpperCase()}${detectedFrom}`
    );
  } catch (e) {
    reply(`❌ Translation failed: ${e.message}`);
  }
});
