// plugins/tag.js — NEXUS-MD
'use strict';

const { cast, makeSmartQuote } = require('../cast');
const axios = require('axios');

function sq() { return makeSmartQuote(); }

// ── tag ───────────────────────────────────────────────────────────────────────
cast({
  pattern:  'tag',
  alias:    ['mention'],
  desc:     'Tag everyone silently. Works on text, media and group links.',
  category: 'group',
  filename: __filename,
}, async (conn, mek, m, { from, q, isGroup, groupMetadata, isAdmins, isOwner, isSudo, reply }) => {
  try {
    if (!isGroup)              return reply('🚫 Groups only.');
    if (!isAdmins && !isOwner && !isSudo) return reply('⚠️ Admins only.');

    const mentions    = (groupMetadata?.participants || []).map(p => p.id);
    // sms() serializer: m.quoted.msg = the content object (m.quoted[m.quoted.type])
    // For conversation: m.quoted.msg is the string itself
    // For extendedTextMessage: m.quoted.msg.text is the string
    // For media: m.quoted.msg.caption is the caption
    const _qmsg = m.quoted?.msg;
    const _quotedText = typeof _qmsg === 'string'
      ? _qmsg
      : (_qmsg?.text || _qmsg?.caption || m.quoted?.text || m.quoted?.caption || '');
    const messageText = q || _quotedText;

    // ── Quoted media — resend with mentions ──────────────────────────────
    if (m.quoted && m.quoted.type && m.quoted.type !== 'conversation' && m.quoted.type !== 'extendedTextMessage') {
      try {
        const buffer = await m.quoted.download();
        const mime   = m.quoted.mimetype || '';
        const cap    = messageText || undefined;

        if (m.quoted.type === 'imageMessage') {
          return conn.sendMessage(from, { image: buffer, caption: cap, mentions }, { quoted: sq() });
        } else if (m.quoted.type === 'videoMessage') {
          return conn.sendMessage(from, { video: buffer, caption: cap, mentions }, { quoted: sq() });
        } else if (m.quoted.type === 'audioMessage') {
          return conn.sendMessage(from, { audio: buffer, mimetype: mime || 'audio/mp4', ptt: !!m.quoted.msg?.ptt }, { quoted: mek });
        } else if (m.quoted.type === 'stickerMessage') {
          return conn.sendMessage(from, { sticker: buffer }, { quoted: mek });
        } else if (m.quoted.type === 'documentMessage') {
          return conn.sendMessage(from, { document: buffer, mimetype: mime, fileName: m.quoted.msg?.fileName || 'file', caption: cap || '', mentions }, { quoted: sq() });
        }
      } catch (e) {
        console.error('[tag] media download failed:', e.message);
        return reply('❌ Could not download that media. Try again.');
      }
    }

    // ── Group invite link — send with group DP ───────────────────────────
    const inviteMatch = messageText.match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]{20,})/);
    if (inviteMatch) {
      try {
        const groupInfo = await conn.groupGetInviteInfo(inviteMatch[1]);
        let thumb = null;
        try {
          const ppUrl = await conn.profilePictureUrl(groupInfo.id, 'image');
          const res   = await axios.get(ppUrl, { responseType: 'arraybuffer', timeout: 8000 });
          thumb = Buffer.from(res.data);
        } catch {}
        if (thumb) {
          return conn.sendMessage(from, { image: thumb, caption: messageText, mentions }, { quoted: sq() });
        }
      } catch {}
    }

    // ── Plain text ───────────────────────────────────────────────────────
    if (!messageText) return reply('❗ Reply to a message or type text after the command.\nExample: tag Good morning!');
    await conn.sendMessage(from, { text: messageText, mentions }, { quoted: sq() });

  } catch (e) { console.error('[tag]', e.message); }
});

// ── hidetag ───────────────────────────────────────────────────────────────────
cast({
  pattern:  'hidetag', alias: ['htag', 'silentag'],
  desc:     'Tag everyone silently — standalone, no reply to command',
  category: 'group',
  filename: __filename,
}, async (conn, mek, m, { from, q, isGroup, groupMetadata, isAdmins, isOwner, isSudo }) => {
  try {
    if (!isGroup || (!isAdmins && !isOwner && !isSudo)) return;
    const mentions    = (groupMetadata?.participants || []).map(p => p.id);
    const _qmsg2 = m.quoted?.msg;
    const _qText2 = typeof _qmsg2 === 'string'
      ? _qmsg2
      : (_qmsg2?.text || _qmsg2?.caption || m.quoted?.text || m.quoted?.caption || '');
    const messageText = q || _qText2 || '👀';

    // Resend media standalone
    if (m.quoted && m.quoted.type && !['conversation','extendedTextMessage'].includes(m.quoted.type)) {
      try {
        const buffer = await m.quoted.download();
        const mime   = m.quoted.mimetype || '';
        const cap    = messageText !== '👀' ? messageText : undefined;
        if (m.quoted.type === 'imageMessage') {
          return conn.sendMessage(from, { image: buffer, caption: cap, mentions });
        } else if (m.quoted.type === 'videoMessage') {
          return conn.sendMessage(from, { video: buffer, caption: cap, mentions });
        } else if (m.quoted.type === 'audioMessage') {
          return conn.sendMessage(from, { audio: buffer, mimetype: mime || 'audio/mp4' });
        } else if (m.quoted.type === 'stickerMessage') {
          return conn.sendMessage(from, { sticker: buffer });
        }
      } catch (e) { console.error('[hidetag] media:', e.message); }
    }

    await conn.sendMessage(from, { text: messageText, mentions });
  } catch (e) { console.error('[hidetag]', e.message); }
});
