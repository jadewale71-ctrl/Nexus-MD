// plugins/missing-commands.js — NEXUS-MD
// rpp, setabout, blocklist, location, vcard, forward, antitag, translate, tts, define, autoreact, mode
'use strict';

const { cast, makeSmartQuote } = require('../cast');
const { getGroupSettings, setGroupSetting } = require('../lib/botdb');
const { lidToPhone } = require('../lib/lid'); // Imported LID helper
const config = require('../config');
const axios  = require('axios');

function sq() { return makeSmartQuote(); }
function s(from, text, conn, mek) { return conn.sendMessage(from, { text }, { quoted: sq() }); }

// ── RPP — remove bot profile picture ─────────────────────────────────────────
cast({ pattern: 'rpp', alias: ['removepp'], desc: 'Remove bot profile picture', category: 'whatsapp', filename: __filename },
async (conn, mek, m, { from, isOwner }) => {
  if (!isOwner) return s(from, '⛔ Owner only.', conn, mek);
  try { await conn.removeProfilePicture(conn.user.id); s(from, '✅ *Profile picture removed!*', conn, mek); }
  catch (e) { s(from, `❌ Failed: ${e.message}`, conn, mek); }
});

// ── SETABOUT — set bot about (formerly bio) ───────────────────────────────────
cast({ pattern: 'setabout', alias: ['setbio', 'setstatus'], desc: 'Update bot WhatsApp About section', use: '<text>', category: 'whatsapp', filename: __filename },
async (conn, mek, m, { from, isOwner, q }) => {
  if (!isOwner) return s(from, '⛔ Owner only.', conn, mek);
  if (!q) return s(from, `*Example:* setabout I am NEXUS-MD!`, conn, mek);
  try {
    // updateProfileStatus updates the "Status" story bar, NOT the About field.
    // The About field requires a direct WABinary IQ to the status server.
    await conn.query({
      tag: 'iq',
      attrs: { to: 's.whatsapp.net', type: 'set', xmlns: 'status' },
      content: [{ tag: 'status', attrs: {}, content: Buffer.from(q, 'utf-8') }]
    });
    s(from, `✅ *About updated:*\n${q}`, conn, mek);
  } catch (err) {
    // Fallback to updateProfileStatus if query fails
    try {
      await conn.updateProfileStatus(q);
      s(from, `✅ *About updated:*\n${q}`, conn, mek);
    } catch (e2) {
      s(from, `❌ Failed: ${e2.message}`, conn, mek);
    }
  }
});

// ── BLOCKLIST — view blocked contacts (LID Resolved) ─────────────────────────
cast({ pattern: 'blocklist', alias: ['blocked'], desc: 'View all blocked numbers', category: 'whatsapp', filename: __filename },
async (conn, mek, m, { from, isOwner }) => {
  if (!isOwner) return s(from, '⛔ Owner only.', conn, mek);
  try {
    const list = await conn.fetchBlocklist();
    if (!list?.length) return s(from, '*No blocked numbers.*', conn, mek);

    let txt = `🚫 *Blocked (${list.length})*\n\n`;
    const mentions = [];

    for (let i = 0; i < list.length; i++) {
      let jid = list[i];
      let displayNum = '';
      let resolvedJid = jid;

      // Resolve LID to real phone number
      if (jid.includes('@lid')) {
        try {
          const phone = await lidToPhone(conn, jid);
          // lidToPhone may return "1234567890@s.whatsapp.net" or just digits
          displayNum = phone.includes('@')
            ? phone.split('@')[0].replace(/\D/g, '')
            : phone.replace(/\D/g, '');
          resolvedJid = displayNum + '@s.whatsapp.net';
        } catch {
          // LID resolution failed — skip or show raw
          displayNum = jid.split('@')[0];
          resolvedJid = jid;
        }
      } else {
        displayNum = jid.split('@')[0].split(':')[0].replace(/\D/g, '');
        resolvedJid = displayNum + '@s.whatsapp.net';
      }

      mentions.push(resolvedJid);
      txt += `${i + 1}. @${displayNum}\n`;
    }

    conn.sendMessage(from, { text: txt.trim(), mentions }, { quoted: sq() });
  } catch (e) { s(from, `❌ Failed: ${e.message}`, conn, mek); }
});

// ── LOCATION — send GPS coordinates ──────────────────────────────────────────
cast({ pattern: 'location', alias: ['loc'], desc: 'Send a location by coordinates', use: '<lat,lon>', category: 'whatsapp', filename: __filename },
async (conn, mek, m, { from, isOwner, q }) => {
  if (!isOwner) return s(from, '⛔ Owner only.', conn, mek);
  if (!q) return s(from, '*Example:* location -26.2041,28.0473', conn, mek);
  const [lat, lon] = q.split(',').map(parseFloat);
  if (isNaN(lat) || isNaN(lon)) return s(from, '*Invalid format.* Example: location -26.2041,28.0473', conn, mek);
  try { await conn.sendMessage(from, { location: { degreesLatitude: lat, degreesLongitude: lon } }, { quoted: sq() }); }
  catch (e) { s(from, `❌ Failed: ${e.message}`, conn, mek); }
});

// ── VCARD — send a contact card ───────────────────────────────────────────────
cast({ pattern: 'vcard', alias: ['contact'], desc: 'Send a contact card for a replied user', use: '<display name>', category: 'whatsapp', filename: __filename },
async (conn, mek, m, { from, isOwner, q }) => {
  if (!isOwner) return s(from, '⛔ Owner only.', conn, mek);
  if (!m.quoted?.sender) return s(from, '*Reply to a user\'s message first!*', conn, mek);
  if (!q) return s(from, '*Provide a display name.*\nExample: vcard John Doe', conn, mek);
  const num = m.quoted.sender.split('@')[0].split(':')[0];
  const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${q}\nORG:;\nTEL;type=CELL;type=VOICE;waid=${num}:+${num}\nEND:VCARD`;
  try { conn.sendMessage(from, { contacts: { displayName: q, contacts: [{ vcard }] } }, { quoted: sq() }); }
  catch (e) { s(from, `❌ Failed: ${e.message}`, conn, mek); }
});

// ── FORWARD — forward a message to a number/link/jid ──────────────────────────
cast({ pattern: 'forward', alias: ['send'], desc: 'Forward a replied message to a number or group', use: '<number | jid | link>', category: 'whatsapp', filename: __filename },
async (conn, mek, m, { from, isOwner, q }) => {
  if (!isOwner) return s(from, '⛔ Owner only.', conn, mek);
  if (!m.quoted) return s(from, '*Reply to a message to forward!*', conn, mek);
  if (!q) return s(from, '*Provide a number, JID, or group link.*\nExamples:\n• forward 2348012345678\n• forward 120363423034374615@g.us\n• forward https://chat.whatsapp.com/xxxxx', conn, mek);

  const input = q.trim();
  let targetJid = '';

  try {
    // 1. Group invite link
    if (input.includes('chat.whatsapp.com/')) {
      const code = input.split('chat.whatsapp.com/').pop().split(/[\s\n?]/)[0].trim();
      const info = await conn.groupGetInviteInfo(code).catch(() => null);
      if (!info?.id) return s(from, '❌ Invalid or expired group link.', conn, mek);
      targetJid = info.id;

    // 2. Already a full JID — preserve it exactly as-is
    } else if (input.includes('@g.us')) {
      targetJid = input; // keep @g.us intact
    } else if (input.includes('@s.whatsapp.net')) {
      targetJid = input;
    } else if (input.includes('@lid')) {
      // Resolve LID to real phone JID
      try {
        const phone = await lidToPhone(conn, input);
        targetJid = phone.includes('@') ? phone : phone.replace(/\D/g, '') + '@s.whatsapp.net';
      } catch {
        return s(from, '❌ Could not resolve LID to a phone number.', conn, mek);
      }

    // 3. Raw phone number
    } else {
      const digits = input.replace(/\D/g, '');
      if (digits.length < 7) return s(from, '❌ Invalid number. Use full international format e.g. 2348012345678', conn, mek);
      targetJid = digits + '@s.whatsapp.net';
    }

    // Get the actual message object to forward
    // m.quoted.fakeObj is the reconstructed Baileys message object
    const msgToForward = m.quoted.fakeObj;
    if (!msgToForward) return s(from, '❌ Could not read the quoted message.', conn, mek);

    // Use copyNForward (defined in index.js — handles media + text properly)
    if (typeof conn.copyNForward === 'function') {
      await conn.copyNForward(targetJid, msgToForward, true);
    } else {
      // Fallback: relay the raw message
      const { generateForwardMessageContent, generateWAMessageFromContent } = require('@whiskeysockets/baileys');
      const content = await generateForwardMessageContent(msgToForward.message || msgToForward, true);
      const waMsg   = await generateWAMessageFromContent(targetJid, content, {});
      await conn.relayMessage(targetJid, waMsg.message, { messageId: waMsg.key.id });
    }

    const displayTarget = targetJid.includes('@g.us')
      ? `group ${targetJid.split('@')[0]}`
      : `+${targetJid.split('@')[0]}`;

    s(from, `✅ *Forwarded to:* ${displayTarget}`, conn, mek);
  } catch (e) {
    s(from, `❌ Failed to forward: ${e.message}`, conn, mek);
  }
});

// ── ANTITAG — anti tagall/hidetag protection ──────────────────────────────────
cast({ pattern: 'antitag', alias: ['antimention', 'at'], desc: 'Anti-tag protection for groups', use: '<on|off|set delete|set kick>', category: 'moderation', filename: __filename },
async (conn, mek, m, { from, isGroup, isAdmins, isOwner, args }) => {
  if (!isGroup)              return s(from, '🚫 Groups only.', conn, mek);
  if (!isAdmins && !isOwner) return s(from, '🚫 Admins only.', conn, mek);
  const settings = getGroupSettings(from);
  const status   = settings.antitag ? 'ON' : 'OFF';
  const action   = settings.antitag_action || 'delete';
  const opt      = (args[0] || '').toLowerCase();
  if (!opt) return s(from, `📛 *Anti-tag:* ${status} (action: ${action})\n\nantitag on\nantitag off\nantitag set delete\nantitag set kick`, conn, mek);
  if (opt === 'on')  { setGroupSetting(from, 'antitag', 1); return s(from, '✅ Anti-tag *ON*.', conn, mek); }
  if (opt === 'off') { setGroupSetting(from, 'antitag', 0); return s(from, '✅ Anti-tag *OFF*.', conn, mek); }
  if (opt === 'set') {
    const act = (args[1] || '').toLowerCase();
    if (!['delete','kick'].includes(act)) return s(from, '❌ Use: antitag set delete OR antitag set kick', conn, mek);
    setGroupSetting(from, 'antitag_action', act);
    setGroupSetting(from, 'antitag', 1);
    return s(from, `✅ Anti-tag set to *${act}* and enabled.`, conn, mek);
  }
  s(from, '❓ Unknown option. Use antitag for help.', conn, mek);
});

// ── TRANSLATE ─────────────────────────────────────────────────────────────────
cast({ pattern: 'translate', alias: ['tr', 'trans'], desc: 'Translate text to any language', use: '<lang> <text>', category: 'tools', filename: __filename },
async (conn, mek, m, { from, q }) => {
  if (!q) return s(from, '*Usage:* translate en Hello world\ntranslate fr Good morning', conn, mek);
  const parts = q.split(' ');
  const lang  = parts[0];
  const text  = m.quoted?.text || m.quoted?.caption || parts.slice(1).join(' ');
  if (!text) return s(from, '*Provide text to translate.*\nExample: translate es Good morning', conn, mek);
  try {
    const { translate } = require('@vitalets/google-translate-api');
    const result = await translate(text, { to: lang });
    s(from, `🌍 *Translation (→ ${lang})*\n\n${result.text}`, conn, mek);
  } catch (e) { s(from, `❌ Translation failed: ${e.message}`, conn, mek); }
});

// ── TTS — text to speech ──────────────────────────────────────────────────────
cast({ pattern: 'tts', alias: ['speak'], desc: 'Convert text to speech', use: '[lang] <text>', category: 'tools', filename: __filename },
async (conn, mek, m, { from, q }) => {
  if (!q) return s(from, '*Usage:* tts Hello world\ntts en-GB Hello there', conn, mek);
  const parts  = q.split(' ');
  const hasLang = /^[a-z]{2}(-[A-Z]{2})?$/.test(parts[0]);
  const lang   = hasLang ? parts[0] : 'en';
  const text   = hasLang ? parts.slice(1).join(' ') : q;
  if (!text) return s(from, '*Provide text.*\nExample: tts Hello world', conn, mek);
  try {
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=${lang}&client=tw-ob`;
    const res = await axios.get(url, { responseType: 'arraybuffer', headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 });
    await conn.sendMessage(from, { audio: Buffer.from(res.data), mimetype: 'audio/mpeg', ptt: true }, { quoted: sq() });
  } catch (e) { s(from, `❌ TTS failed: ${e.message}`, conn, mek); }
});

// ── DEFINE — dictionary definition ───────────────────────────────────────────
cast({ pattern: 'define', alias: ['dict', 'meaning'], desc: 'Get dictionary definition of a word', use: '<word>', category: 'tools', filename: __filename },
async (conn, mek, m, { from, q }) => {
  if (!q) return s(from, '*Usage:* define serendipity', conn, mek);
  try {
    const res  = await axios.get(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(q)}`, { timeout: 10000 });
    const data = res.data[0];
    const defs = data.meanings.slice(0,3).map(m =>
      `*${m.partOfSpeech}*\n` + m.definitions.slice(0,2).map((d,i) => `${i+1}. ${d.definition}${d.example?'\n_"'+d.example+'"_':''}`).join('\n')
    ).join('\n\n');
    s(from, `📖 *${data.word}*\n${data.phonetic||''}\n\n${defs}`, conn, mek);
  } catch (e) { s(from, `❌ Word not found: *${q}*`, conn, mek); }
});

// ── AUTOREACT — auto react settings ──────────────────────────────────────────
cast({ pattern: 'autoreact', alias: ['areact', 'setreact'], desc: 'Configure auto-react. Modes: off | cmd | all', use: '<off|cmd|all>', category: 'owner', filename: __filename },
async (conn, mek, m, { from, isOwner, botNumber, args }) => {
  if (!isOwner) return s(from, '⛔ Owner only.', conn, mek);
  const { setAutoReact, getAutoReact } = require('./tools');
  const arg = (args[0] || '').toLowerCase();
  if (!arg) {
    const cur = getAutoReact(botNumber);
    return s(from, `*Auto React:* ${cur === 'false' ? 'OFF' : cur}\n\nautoreact off — disable\nautoreact cmd — react to commands only\nautoreact all — react to all messages`, conn, mek);
  }
  if (!['off','cmd','all'].includes(arg)) return s(from, '❗ Use: autoreact off | cmd | all', conn, mek);
  setAutoReact(botNumber, arg === 'off' ? 'false' : arg);
  s(from, `✅ Auto react set to *${arg}*.`, conn, mek);
});

// ── MODE — get/set bot mode ───────────────────────────────────────────────────
cast({ pattern: 'setmode', alias: ['botmode'], desc: 'Set bot mode: public or private', use: '<public|private>', category: 'settings', filename: __filename },
async (conn, mek, m, { from, isOwner, args }) => {
  if (!isOwner) return s(from, '⛔ Owner only.', conn, mek);
  const mode = (args[0] || '').toLowerCase();
  if (!['public','private'].includes(mode)) return s(from, '*Usage:* setmode public | private', conn, mek);
  try {
    const botdb = require('../lib/botdb');
    const _s = botdb.getBotSettings(); _s.mode = mode; botdb.saveBotSettings(_s);
    require('../config').MODE = mode;
    s(from, `✅ Bot mode set to *${mode}*.`, conn, mek);
  } catch (e) { s(from, `❌ Failed: ${e.message}`, conn, mek); }
});
