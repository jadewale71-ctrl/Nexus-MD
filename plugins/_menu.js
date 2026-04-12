const { cast, makeSmartQuote, commands } = require('../cast');
const config = require('../config');
const { formatBytes, runtime, getBuffer } = require('../lib/functions');
const { totalmem, freemem } = require('os');
const botdb = require('../lib/botdb');

function loadSettings() { return botdb.getBotSettings(); }
async function saveSettings(obj) { botdb.saveBotSettings(obj); }

// ── Small-caps map ─────────────────────────────────────────────────────────────
function sc(str) {
  const m = {
    a:'ᴀ',b:'ʙ',c:'ᴄ',d:'ᴅ',e:'ᴇ',f:'ғ',g:'ɢ',h:'ʜ',i:'ɪ',
    j:'ᴊ',k:'ᴋ',l:'ʟ',m:'ᴍ',n:'ɴ',o:'ᴏ',p:'ᴘ',q:'ǫ',r:'ʀ',
    s:'s',t:'ᴛ',u:'ᴜ',v:'ᴠ',w:'ᴡ',x:'x',y:'ʏ',z:'ᴢ'
  };
  return str.toLowerCase().split('').map(c => m[c] || c).join('');
}

// ── Categorise commands ────────────────────────────────────────────────────────
function categorizeCommands(list) {
  const out = {};
  list.forEach(cmd => {
    if (!cmd || !cmd.pattern || cmd.dontAddCommandList) return;
    const cat = (cmd.category || 'misc').toLowerCase();
    (out[cat] = out[cat] || []).push(cmd.pattern);
  });
  return out;
}

// ── Detect media type ──────────────────────────────────────────────────────────
function detectMediaType(url) {
  const ext = (url.split('?')[0].split('.').pop() || '').toLowerCase();
  if (ext === 'gif') return 'gif';
  if (['mp4', 'mov', 'mkv', 'webm', 'avi'].includes(ext)) return 'video';
  return 'image';
}

// ── RAM bar ────────────────────────────────────────────────────────────────────
function ramBar(pct, len = 10) {
  const f = Math.round((pct / 100) * len);
  return '[' + '█'.repeat(f) + '░'.repeat(len - f) + `] ${pct}%`;
}

// ── Core renderer — returns ONE long text string (like Cypher X) ───────────────
async function renderMenu({ layout = 1, pushname = 'User' }) {
  const settings = await loadSettings();
  const botName  = config.BOT_NAME || 'NEXUS-MD';
  const prefix   = config.PREFIX   || config.prefix || '.';
  const mode     = config.MODE     || 'Unknown';
  const version  = config.VERSION  || '1.0.0';
  const uptime   = runtime(process.uptime());
  const memUsed  = formatBytes(totalmem() - freemem());
  const memPct   = Math.round(((totalmem() - freemem()) / totalmem()) * 100);
  const plugins  = commands.length;
  const cats     = categorizeCommands(commands);
  const catKeys  = Object.keys(cats);

  const rows = [
    [sc('user'),    pushname],
    [sc('prefix'),  `[ ${prefix} ]`],
    [sc('mode'),    mode],
    [sc('uptime'),  uptime],
    [sc('plugins'), String(plugins)],
    [sc('version'), version],
    [sc('memory'),  memUsed],
    [sc('ram'),     ramBar(memPct)],
  ];

  // Helpers per layout
  const H = {
    open:    (n, name) => ({ 1:`┏◈ ≺ *${name}* ≻ ◈`, 2:`▛▀ ❰ *${name}* ❱`, 3:`╔═❮ *${name}* ❯`, 4:`⟦ *${name}* ⟧`, 5:`✦ ≪ *${name}* ≫ ✦`, 6:`◤◢ *${name}* ◢◤`, 7:`━ *${name}* ━`, 8:`【 *${name}* 】`, 9:`⎯ *${name}* ⎯` }[n] || `*${name}*`),
    row:     (n, k, v) => ({ 1:`┃ *${k}* : ${v}`, 2:`▌ *${k}* : ${v}`, 3:`╟ *${k}* : ${v}`, 4:`│ *${k}* : ${v}`, 5:`✧ *${k}* : ${v}`, 6:`◈ *${k}* : ${v}`, 7:`  *${k}* : ${v}`, 8:`〉*${k}* : ${v}`, 9:`⌁ *${k}* : ${v}` }[n] || `${k}: ${v}`),
    close:   (n) => ({ 1:'┗◈', 2:'▙▟', 3:'╚═', 4:'⟦⟧', 5:'✦✦', 6:'◤◢', 7:'━━', 8:'【】', 9:'⎯⎯' }[n] || ''),
    catOpen: (n, cat) => ({ 1:`┏◈ ≺ *${cat}*`, 2:`▛▀ ❰ *${cat}* ❱`, 3:`╔═❮ *${cat}*`, 4:`⟦ *${cat}* ⟧`, 5:`✦ ≪ *${cat}* ≫`, 6:`◤◢ *${cat}*`, 7:`━ *${cat}*`, 8:`【 *${cat}* 】`, 9:`⎯ *${cat}* ⎯` }[n] || `*${cat}*`),
    bullet:  (n, p) => ({ 1:`┃⇒ ${p}`, 2:`▌⟡ ${p}`, 3:`║◦ ${p}`, 4:`│› ${p}`, 5:`✧▸ ${p}`, 6:`◈➤ ${p}`, 7:`  ▹${p}`, 8:`〉${p}`, 9:`⌁${p}` }[n] || ` • ${p}`),
    catClose:(n) => ({ 1:'┗◈', 2:'▙▟', 3:'╚═', 4:'⟦⟧', 5:'✦✦', 6:'◤◢', 7:'━━', 8:'【】', 9:'⎯⎯' }[n] || ''),
  };

  const L = Number(layout);
  let text = '';

  // ── Header ───────────────────────────────────────────────────────────────────
  text += H.open(L, botName) + '\n';
  rows.forEach(([k, v]) => { text += H.row(L, k, v) + '\n'; });
  text += H.close(L) + '\n';

  // ── Invisible separator to push categories below readmore threshold ───────────
  // 700+ invisible chars forces WhatsApp to show "Read more" before categories
  text += '\u200B'.repeat(750) + '\n';

  // ── All categories in one block (like Cypher X — one long message) ───────────
  catKeys.forEach(cat => {
    text += '\n' + H.catOpen(L, cat.toUpperCase()) + '\n';
    cats[cat].forEach(p => { text += H.bullet(L, p) + '\n'; });
    text += H.catClose(L) + '\n';
  });

  // ── Media ────────────────────────────────────────────────────────────────────
  let mediaBuffer = null;
  let mediaType   = 'image';
  const mediaUrl  = settings.menuImage;
  if (mediaUrl && /^https?:\/\//i.test(mediaUrl)) {
    mediaType = detectMediaType(mediaUrl);
    try { mediaBuffer = await getBuffer(mediaUrl); } catch { mediaBuffer = null; }
  }

  return { text, mediaBuffer, mediaType };
}

// ── MENU command ───────────────────────────────────────────────────────────────
cast(
  {
    pattern: 'menu',
    desc: 'Show all commands (9 slim layouts)',
    category: 'main',
    filename: __filename
  },
  async (conn, mek, m, { from, pushname, reply }) => {
    try {
      const settings = await loadSettings();
      const layout = settings.menuLayout || 1;
      const { text, mediaBuffer, mediaType } = await renderMenu({ layout, pushname });
      const q = { quoted: makeSmartQuote() };

      if (mediaBuffer) {
        if (mediaType === 'video') {
          await conn.sendMessage(from, { video: mediaBuffer, caption: text }, q);
        } else if (mediaType === 'gif') {
          await conn.sendMessage(from, { video: mediaBuffer, gifPlayback: true, caption: text }, q);
        } else {
          await conn.sendMessage(from, { image: mediaBuffer, caption: text }, q);
        }
      } else {
        await conn.sendMessage(from, { text }, q);
      }
    } catch (err) {
      console.error(err);
      reply('An error occurred while generating the menu.');
    }
  }
);

// ── SETMENU command ────────────────────────────────────────────────────────────
cast(
  {
    pattern: 'setmenu',
    desc: 'Set menu layout or media. Usage: setmenu <1-9> | setmenu image/video/gif <url> | setmenu removeimage | setmenu show',
    category: 'settings',
    filename: __filename
  },
  async (conn, mek, m, { from, args, reply }) => {
    try {
      const settings = await loadSettings();

      if (!args || args.length === 0) {
        return reply(
          '*setmenu* options:\n' +
          '  setmenu *1-9*          — change layout\n' +
          '  setmenu *image* <url>  — set image header\n' +
          '  setmenu *video* <url>  — set video header\n' +
          '  setmenu *gif* <url>    — set GIF header\n' +
          '  setmenu *removeimage*  — remove media\n' +
          '  setmenu *show*         — current settings'
        );
      }

      const sub = args[0].toLowerCase();

      if (/^[1-9]$/.test(sub)) {
        settings.menuLayout = Number(sub);
        await saveSettings(settings);
        return reply(`✅ Menu layout set to *${sub}*.`);
      }

      if (['image', 'video', 'gif', 'media'].includes(sub)) {
        const url = (args[1] || '').trim();
        if (!url || !/^https?:\/\//i.test(url)) {
          return reply('Provide a valid http(s) URL.\nExample: setmenu image https://i.imgur.com/xyz.jpg');
        }
        settings.menuImage = url;
        await saveSettings(settings);
        return reply(`✅ Menu media saved as *${detectMediaType(url)}*.\nApplied next time *.menu* is run.`);
      }

      if (sub === 'removeimage') {
        delete settings.menuImage;
        await saveSettings(settings);
        return reply('✅ Menu media removed.');
      }

      if (sub === 'show') {
        const mu = settings.menuImage || '(none)';
        const mt = settings.menuImage ? detectMediaType(settings.menuImage) : '—';
        return reply(
          `*Menu settings:*\n` +
          `  Layout : ${settings.menuLayout || 1}\n` +
          `  Media  : ${mu}\n` +
          `  Type   : ${mt}`
        );
      }

      return reply('Unknown option. Type *setmenu* alone to see usage.');
    } catch (err) {
      console.error(err);
      reply('Failed to update menu settings.');
    }
  }
);
