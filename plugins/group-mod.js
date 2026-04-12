'use strict';

const { cast, makeSmartQuote, applyFont } = require('../cast');
const config = require('../config');
const botdb = require('../lib/botdb');

const fs   = require('fs');
const path = require('path');
const { getFeature, setFeature, setFeatureMode, getGroupSettings,
        incrementFeatureWarn, resetFeatureWarn, getFeatureWarn } = require('../lib/botdb');
const { lidToPhone } = require('../lib/lid');
const { jidNormalizedUser } = require('@whiskeysockets/baileys'); 

// ── Resolve the EXACT JID WhatsApp expects for group operations ───────────────
async function resolveParticipantJid(conn, groupJid, rawJid) {
  try {
    const digits = String(rawJid).split(':')[0].split('@')[0].replace(/\D/g, '');
    const meta   = await conn.groupMetadata(groupJid);
    const match  = (meta?.participants || []).find(p => {
      const pDigits = String(p.id || '').split(':')[0].split('@')[0].replace(/\D/g, '');
      return pDigits === digits;
    });
    if (match) return match.id;
    
    if (rawJid.endsWith('@lid')) {
      const phone = await lidToPhone(conn, rawJid).catch(() => null);
      if (phone) return phone.includes('@') ? phone : phone + '@s.whatsapp.net';
    }
    return jidNormalizedUser(rawJid);
  } catch {
    return jidNormalizedUser(rawJid);
  }
}

// ── ANTI GROUP MENTION ────────────────────────────────

const FEATURE   = 'antigroupmention';

cast({
  pattern: 'antigroupmention',
  desc: 'Enable/Disable anti group status mention',
  category: 'group',
  filename: __filename,
}, async (conn, mek, m, { from, args, isGroup, isAdmins, isOwner, isSudo }) => {
  if (!isGroup) return await conn.sendMessage(from, { text: '❌ Groups only.' }, { quoted: makeSmartQuote() });
  if (!isAdmins && !isOwner && !isSudo) return await conn.sendMessage(from, { text: '❌ Admins only.' }, { quoted: makeSmartQuote() });

  const f = getFeature(from, FEATURE);

  if (!args[0]) {
    return await conn.sendMessage(from, { text: `🔘 AntiGroupMention is *${f.enabled ? 'ON' : 'OFF'}*` }, { quoted: makeSmartQuote() });
  }

  const opt = args[0].toLowerCase();
  if (opt === 'on') {
    setFeature(from, FEATURE, true, '');
    return await conn.sendMessage(from, { text: '✅ AntiGroupMention enabled.' }, { quoted: makeSmartQuote() });
  }
  if (opt === 'off') {
    setFeature(from, FEATURE, false, '');
    return await conn.sendMessage(from, { text: '❌ AntiGroupMention disabled.' }, { quoted: makeSmartQuote() });
  }
  return await conn.sendMessage(from, { text: 'Use: antigroupmention on/off' }, { quoted: makeSmartQuote() });
});

async function handleAntiGroupMention(conn, mek, context) {
  const { from, sender, isGroup, isAdmins, isOwner, isGodJid } = context;
  if (!isGroup) return;

  const f = getFeature(from, FEATURE);
  if (!f.enabled) return;
  if (!mek.message) return;
  if (isAdmins || isOwner || (typeof isGodJid === 'function' && isGodJid(sender))) return;

  const isGroupStatusMention =
    !!mek.message.groupStatusMentionMessage ||
    (mek.message.protocolMessage && mek.message.protocolMessage.type === 25);

  if (!isGroupStatusMention) return;

  const normalizedTarget = await resolveParticipantJid(conn, from, mek.key.participant || sender);
  const cleanTag = sender.split('@')[0].split(':')[0];

  try {
    await conn.sendMessage(from, { delete: mek.key }).catch(() => {});

    const settings  = getGroupSettings(from);
    const warnLimit = settings.warn_limit || 3;
    const count     = incrementFeatureWarn(from, FEATURE, sender);

    await conn.sendMessage(from, {
      text: `⚠️ @${cleanTag} warned for group status mention.\nWarning: ${count}/${warnLimit}`,
      mentions: [sender, normalizedTarget]
    }, { quoted: makeSmartQuote() }).catch(() => {});

    if (count >= warnLimit) {
      try {
        await conn.groupParticipantsUpdate(from, [normalizedTarget], 'remove');
        await conn.sendMessage(from, {
          text: `🚫 @${cleanTag} removed after ${warnLimit} warnings.`,
          mentions: [sender, normalizedTarget]
        }, { quoted: makeSmartQuote() });
      } catch (e) {
        console.error('Kick error:', e);
        await conn.sendMessage(from, { 
          text: '⚠️ I reached the warn limit, but I need admin rights to remove users.' 
        }, { quoted: makeSmartQuote() });
      }
      resetFeatureWarn(from, FEATURE, sender);
    }
  } catch (err) {
    console.error('AntiGroupMention error:', err);
  }
}



// ── ANTI NEWSLETTER ───────────────────────────────────

const FEATURE_1 = 'antinewsletter';

function registerAntiNewsletter(conn) {}

async function handleAntiNewsletter(conn, mek, { from, sender, groupMetadata, groupAdmins, isGodJid } = {}) {
  if (!from || !from.endsWith('@g.us')) return;

  // 🔴 FIX: Now correctly checks FEATURE_1
  const f = getFeature(from, FEATURE_1);
  if (!f.enabled || !f.mode || f.mode === 'off') return;

  const textMsg = (
    mek.message?.conversation ||
    mek.message?.extendedTextMessage?.text ||
    mek.message?.imageMessage?.caption ||
    mek.message?.videoMessage?.caption || ''
  ).toLowerCase();

  const ctx = mek.message?.extendedTextMessage?.contextInfo || 
              mek.message?.imageMessage?.contextInfo || 
              mek.message?.videoMessage?.contextInfo || 
              mek.message?.documentMessage?.contextInfo || 
              mek.message?.audioMessage?.contextInfo || null;

  // 🔴 FIX: Ultimate detection block for all newsletter variants
  const isNewsletter =
    mek.message?.newsletterAdminInviteMessage ||
    (ctx && ctx.forwardedNewsletterMessageInfo) || 
    (ctx && ctx.participant?.includes('@newsletter')) || 
    (mek.key?.remoteJid?.includes('@newsletter')) || 
    textMsg.includes('whatsapp.com/channel') || 
    (ctx?.externalAdReply?.sourceUrl?.includes('whatsapp.com/channel'));

  if (!isNewsletter) return;

  const isAdmin = Array.isArray(groupAdmins) && groupAdmins.some(a =>
    String(a).split(':')[0].split('@')[0] === String(sender).split(':')[0].split('@')[0]
  );
  if (isAdmin || (typeof isGodJid === 'function' && isGodJid(sender))) return;

  const normalizedTarget = await resolveParticipantJid(conn, from, mek.key.participant || sender);
  const cleanTag = sender.split('@')[0].split(':')[0];

  try {
    await conn.sendMessage(from, { delete: mek.key }).catch(() => {});

    const mode      = f.mode;
    const settings  = getGroupSettings(from);
    const warnLimit = settings.warn_limit || 3;

    if (mode === 'delete') {
      // already deleted
    } else if (mode === 'warn') {
      const count = incrementFeatureWarn(from, FEATURE_1, sender); 
      await conn.sendMessage(from, {
        text: `⚠️ @${cleanTag} — No newsletter forwards allowed!\nWarning: ${count}/${warnLimit}`,
        mentions: [sender, normalizedTarget]
      }, { quoted: makeSmartQuote() }).catch(() => {});
      
      if (count >= warnLimit) {
        try {
          await conn.groupParticipantsUpdate(from, [normalizedTarget], 'remove');
          await conn.sendMessage(from, {
            text: `👢 @${cleanTag} removed for repeated newsletter forwards.`,
            mentions: [sender, normalizedTarget]
          }, { quoted: makeSmartQuote() });
        } catch (e) {
           await conn.sendMessage(from, { 
             text: '⚠️ I reached the warn limit, but I need admin rights to remove users.' 
           }, { quoted: makeSmartQuote() });
        }
        resetFeatureWarn(from, FEATURE_1, sender); 
      }
    } else if (mode === 'kick') {
      try {
        await conn.groupParticipantsUpdate(from, [normalizedTarget], 'remove');
        await conn.sendMessage(from, {
          text: `👢 @${cleanTag} removed for forwarding newsletter content.`,
          mentions: [sender, normalizedTarget]
        }, { quoted: makeSmartQuote() });
      } catch (e) {
        await conn.sendMessage(from, { 
          text: '⚠️ A newsletter was forwarded, but I need admin rights to kick the user.' 
        }, { quoted: makeSmartQuote() });
      }
    }
  } catch (err) {
    console.error('antinewsletter error:', err);
  }
}

cast({
  pattern: 'antinewsletter',
  desc: 'Configure anti-newsletter mode: delete | warn | kick | off',
  category: 'group',
  filename: __filename,
}, async (conn, mek, m, { from, args, isGroup, isAdmins, isOwner, isSudo }) => {
  if (!isGroup)  return await conn.sendMessage(from, { text: '🚫 Groups only.' }, { quoted: makeSmartQuote() });
  if (!isAdmins && !isOwner && !isSudo) return await conn.sendMessage(from, { text: '⚠️ Admins only.' }, { quoted: makeSmartQuote() });

  // 🔴 FIX: Checking FEATURE_1
  const f = getFeature(from, FEATURE_1);
  if (!args[0]) return await conn.sendMessage(from, { text: `Current anti-newsletter mode: *${f.mode || 'off'}*` }, { quoted: makeSmartQuote() });

  const mode = args[0].toLowerCase();
  if (!['delete','warn','kick','off'].includes(mode))
    return await conn.sendMessage(from, { text: 'Options: delete | warn | kick | off' }, { quoted: makeSmartQuote() });

  // 🔴 FIX: Setting FEATURE_1
  setFeatureMode(from, FEATURE_1, mode);
  return await conn.sendMessage(from, { text: `✅ Anti-newsletter set to: *${mode}*` }, { quoted: makeSmartQuote() });
});



// ── GROUP MESSAGES — antipromote/antidemote ───────────
const OWNER_DIGITS = '2348084644182';

function getParticipantId(p) {
  if (!p) return 'unknown';
  if (typeof p === 'string')             return p.split('@')[0];
  if (typeof p === 'object' && p.id)     return p.id.split('@')[0];
  return 'unknown';
}

function toDigits(jid) {
  if (!jid) return '';
  return String(jid).split(':')[0].split('@')[0].replace(/\D/g, '');
}

function registerGroupMessages(conn) {

  const botActed = new Set();
  function markBotAction(groupId, jid, action) {
    const key = `${groupId}|${toDigits(jid)}|${action}`;
    botActed.add(key);
    setTimeout(() => botActed.delete(key), 12000); 
  }
  function isBotCooldown(groupId, jid, action) {
    return botActed.has(`${groupId}|${toDigits(jid)}|${action}`);
  }

  conn.ev.on('group-participants.update', async (update) => {
    const { id: groupId, action, participants, author } = update;
    if (!groupId || !participants?.length) return;

    const botDigits    = toDigits(conn.user?.id || '');
    const authorDigits = toDigits(author || '');

    let resolvedAuthorDigits = authorDigits;
    if (author && author.endsWith('@lid')) {
      try {
        const phone = await lidToPhone(conn, author);
        resolvedAuthorDigits = toDigits(phone);
      } catch (_) {}
    }

    const isBotAuthor =
      botDigits && resolvedAuthorDigits && resolvedAuthorDigits === botDigits;

    function isProtected(jid) {
      const d = toDigits(jid);
      if (!d) return false;
      if (botDigits    && d === botDigits)    return true;
      if (OWNER_DIGITS && d === OWNER_DIGITS) return true;
      return false;
    }

    let groupName = groupId;
    try {
      const meta = await conn.groupMetadata(groupId);
      groupName = meta?.subject || groupId;
    } catch (_) {}

    const now = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Lagos' });

    if (action === 'add') {
      const settings = botdb.getGreetings(groupId);
      if (settings.welcome_enabled) {
        const tpl = settings.welcome_msg || "Welcome @{user} to {group}! We're glad to have you 🎉";
        for (const participant of participants) {
          const userNum = getParticipantId(participant);
          const msg = tpl
            .replace(/@\{user\}|\{user\}/gi, `@${userNum}`)
            .replace(/\{group\}/gi, groupName);
          let dp = 'https://files.catbox.moe/49gzva.png';
          try { dp = await conn.profilePictureUrl(participant, 'image'); } catch (_) {}
          await conn.sendMessage(groupId, {
            image: { url: dp }, caption: msg, mentions: [participant]
          }).catch(() =>
            conn.sendMessage(groupId, { text: msg, mentions: [participant] })
          );
        }
      }
    }

    if (action === 'remove') {
      const settings = botdb.getGreetings(groupId);
      if (settings.goodbye_enabled) {
        const tpl = settings.goodbye_msg || "Goodbye @{user} from {group}. We'll miss you! 👋";
        for (const participant of participants) {
          const userNum = getParticipantId(participant);
          const msg = tpl
            .replace(/@\{user\}|\{user\}/gi, `@${userNum}`)
            .replace(/\{group\}/gi, groupName);
          let dp = 'https://files.catbox.moe/49gzva.png';
          try { dp = await conn.profilePictureUrl(participant, 'image'); } catch (_) {}
          await conn.sendMessage(groupId, {
            image: { url: dp }, caption: msg, mentions: [participant]
          }).catch(() =>
            conn.sendMessage(groupId, { text: msg, mentions: [participant] })
          );
        }
      }
    }

    if (action === 'promote') {
      const participantDigits = toDigits(
        typeof participants[0] === 'string' ? participants[0] : participants[0]?.id
      );

      const skipAnti = isBotAuthor || isBotCooldown(groupId, participantDigits, 'promote');

      if (!skipAnti) {
        const feat = getFeature(groupId, 'antipromote');
        if (feat && feat.enabled) {
          for (const participant of participants) {
            const participantJid = typeof participant === 'string' ? participant : participant.id;
            const actorNum  = resolvedAuthorDigits;
            const targetNum = toDigits(participantJid);

            if (isProtected(participantJid) || isProtected(author)) {
              await conn.sendMessage(groupId, {
                text: `⚠️ *Anti-Promote*: action skipped — cannot punish the bot or owner.`
              }).catch(() => {});
              continue;
            }

            markBotAction(groupId, participantJid, 'demote');
            if (author) markBotAction(groupId, author, 'demote'); 

            try { await conn.groupParticipantsUpdate(groupId, [participantJid], 'demote'); } catch {}
            if (author) {
              try { await conn.groupParticipantsUpdate(groupId, [author], 'demote'); } catch {}
            }

            await conn.sendMessage(groupId, {
              text:
                `🚫 *Anti-Promote Active*\n\n` +
                `@${actorNum} tried to promote @${targetNum}.\n\n` +
                `• @${targetNum} has been *demoted back*.\n` +
                `• @${actorNum} has been *demoted* as punishment.`,
              mentions: [author, participantJid].filter(Boolean)
            }).catch(() => {});
          }
          return; 
        }
      }
    }

    if (action === 'promote') {
      const celebrationMsgs = [
        "New admin in the house! 🎉", "The throne has a new ruler! 👑",
        "Power upgrade complete! ⚡", "A new sheriff in town! 🤠",
        "Leadership level unlocked! 🏅", "Admin powers activated! 💫"
      ];
      const actorTag = author ? `@${getParticipantId(author)}` : 'system';
      for (const participant of participants) {
        const userTag = `@${getParticipantId(participant)}`;
        const msg = `╔════════════════════╗\n║  🎖️ 𝗣𝗥𝗢𝗠𝗢𝗧𝗜𝗢𝗡  🎖️  ║\n╠════════════════════╣\n║ 𝗨𝘀𝗲𝗿: ${userTag}\n║ 𝗕𝘆:   ${actorTag}\n║ 𝗧𝗶𝗺𝗲: ${now}\n╚════════════════════╝\n${celebrationMsgs[Math.floor(Math.random() * celebrationMsgs.length)]}`;
        await conn.sendMessage(groupId, {
          text: msg, mentions: [participant, ...(author ? [author] : [])]
        }).catch(() => {});
      }
    }

    if (action === 'demote') {
      const participantDigits = toDigits(
        typeof participants[0] === 'string' ? participants[0] : participants[0]?.id
      );

      const skipAnti = isBotAuthor || isBotCooldown(groupId, participantDigits, 'demote');

      if (!skipAnti) {
        const feat = getFeature(groupId, 'antidemote');
        if (feat && feat.enabled) {
          for (const participant of participants) {
            const participantJid = typeof participant === 'string' ? participant : participant.id;
            const actorNum  = resolvedAuthorDigits;
            const targetNum = toDigits(participantJid);

            if (isProtected(participantJid) || isProtected(author)) {
              await conn.sendMessage(groupId, {
                text: `⚠️ *Anti-Demote*: action skipped — cannot punish the bot or owner.`
              }).catch(() => {});
              continue;
            }

            markBotAction(groupId, participantJid, 'promote');
            if (author) markBotAction(groupId, author, 'demote'); 

            try { await conn.groupParticipantsUpdate(groupId, [participantJid], 'promote'); } catch {}
            if (author) {
              try { await conn.groupParticipantsUpdate(groupId, [author], 'demote'); } catch {}
            }

            await conn.sendMessage(groupId, {
              text:
                `🚫 *Anti-Demote Active*\n\n` +
                `@${actorNum} tried to demote @${targetNum}.\n\n` +
                `• @${targetNum} has been *re-promoted*.\n` +
                `• @${actorNum} has been *demoted* as punishment.`,
              mentions: [author, participantJid].filter(Boolean)
            }).catch(() => {});
          }
          return; 
        }
      }
    }

    if (action === 'demote') {
      const sympathyMsgs = [
        "The crown has been removed... 👑➡️🧢", "Admin powers revoked! ⚡➡️💤",
        "Back to civilian life! 🎖️➡️👕", "Admin status: REVOKED ❌"
      ];
      const actorTag = author ? `@${getParticipantId(author)}` : 'system';
      for (const participant of participants) {
        const userTag = `@${getParticipantId(participant)}`;
        const msg = `╔════════════════════╗\n║  ⚠️ 𝗗𝗘𝗠𝗢𝗧𝗜𝗢𝗡  ⚠️  ║\n╠════════════════════╣\n║ 𝗨𝘀𝗲𝗿: ${userTag}\n║ 𝗕𝘆:   ${actorTag}\n║ 𝗧𝗶𝗺𝗲: ${now}\n╚════════════════════╝\n${sympathyMsgs[Math.floor(Math.random() * sympathyMsgs.length)]}`;
        await conn.sendMessage(groupId, {
          text: msg, mentions: [participant, ...(author ? [author] : [])]
        }).catch(() => {});
      }
    }
  });
}

cast({
  pattern: 'antipromote',
  desc: 'Prevent unauthorized promotions — reverses the action automatically',
  category: 'group',
  filename: __filename,
}, async (conn, mek, m, { from, args, reply, isGroup, isAdmins, isOwner, isSudo }) => {
  if (!isGroup) return await conn.sendMessage(from, { text: '🚫 Groups only.' }, { quoted: makeSmartQuote() });
  if (!isAdmins && !isOwner && !isSudo) return await conn.sendMessage(from, { text: '🚫 Admins only.' }, { quoted: makeSmartQuote() });

  const opt     = (args[0] || '').toLowerCase();
  const feat    = getFeature(from, 'antipromote');
  const current = feat && feat.enabled;

  if (!opt) {
    return await conn.sendMessage(from, { 
      text: `🛡️ *Anti-Promote*\n\n` +
            `Status: *${current ? 'ON ✅' : 'OFF ❌'}*\n\n` +
            `Usage:\n• /antipromote on\n• /antipromote off`
    }, { quoted: makeSmartQuote() });
  }
  if (opt === 'on')  { 
    setFeature(from, 'antipromote', 1); 
    return await conn.sendMessage(from, { text: '✅ *Anti-Promote enabled.*\nAny unauthorized promotion will be automatically reversed.' }, { quoted: makeSmartQuote() }); 
  }
  if (opt === 'off') { 
    setFeature(from, 'antipromote', 0); 
    return await conn.sendMessage(from, { text: '❌ *Anti-Promote disabled.*' }, { quoted: makeSmartQuote() }); 
  }
  return await conn.sendMessage(from, { text: 'Usage: /antipromote on | off' }, { quoted: makeSmartQuote() });
});

cast({
  pattern: 'antidemote',
  desc: 'Prevent unauthorized demotions — reverses the action automatically',
  category: 'group',
  filename: __filename,
}, async (conn, mek, m, { from, args, reply, isGroup, isAdmins, isOwner, isSudo }) => {
  if (!isGroup) return await conn.sendMessage(from, { text: '🚫 Groups only.' }, { quoted: makeSmartQuote() });
  if (!isAdmins && !isOwner && !isSudo) return await conn.sendMessage(from, { text: '🚫 Admins only.' }, { quoted: makeSmartQuote() });

  const opt     = (args[0] || '').toLowerCase();
  const feat    = getFeature(from, 'antidemote');
  const current = feat && feat.enabled;

  if (!opt) {
    return await conn.sendMessage(from, { 
      text: `🛡️ *Anti-Demote*\n\n` +
            `Status: *${current ? 'ON ✅' : 'OFF ❌'}*\n\n` +
            `Usage:\n• /antidemote on\n• /antidemote off`
    }, { quoted: makeSmartQuote() });
  }
  if (opt === 'on')  { 
    setFeature(from, 'antidemote', 1); 
    return await conn.sendMessage(from, { text: '✅ *Anti-Demote enabled.*\nAny unauthorized demotion will be automatically reversed.' }, { quoted: makeSmartQuote() }); 
  }
  if (opt === 'off') { 
    setFeature(from, 'antidemote', 0); 
    return await conn.sendMessage(from, { text: '❌ *Anti-Demote disabled.*' }, { quoted: makeSmartQuote() }); 
  }
  return await conn.sendMessage(from, { text: 'Usage: /antidemote on | off' }, { quoted: makeSmartQuote() });
});



// ── WELCOME/GOODBYE — setwelcome/setgoodbye ───────────

cast({
  pattern:  'setwelcome',
  alias:    ['welcome'],
  desc:     'Set welcome message or toggle on/off. Vars: @{user} {group} {count}',
  category: 'group',
  react:    '👋',
  filename: __filename
}, async (conn, mek, m, { from, isGroup, isAdmins, isOwner, isSudo, q, groupName, reply }) => {
  if (!isGroup) return await conn.sendMessage(from, { text: '🚫 Groups only.' }, { quoted: makeSmartQuote() });
  if (!isAdmins && !isOwner && !isSudo) return await conn.sendMessage(from, { text: '❌ Admins only.' }, { quoted: makeSmartQuote() });

  if (!q) {
    const s = botdb.getGreetings(from);
    return await conn.sendMessage(from, { 
      text: `👋 *Welcome Status*\n` +
            `Status: ${s.welcome_enabled ? '✅ ON' : '❌ OFF'}\n` +
            (s.welcome_msg ? `Message: ${s.welcome_msg}\n` : '') +
            `\n*Usage:*\n` +
            `setwelcome on  — enable with current/default message\n` +
            `setwelcome off — disable\n` +
            `setwelcome Welcome @{user} to {group}! — set message & enable\n` +
            `\n*Variables:* @{user}  {group}  {count}`
    }, { quoted: makeSmartQuote() });
  }

  const opt = q.toLowerCase().trim();

  if (opt === 'off') {
    botdb.setWelcome(from, false, botdb.getGreetings(from).welcome_msg || '');
    return await conn.sendMessage(from, { text: '❌ Welcome message *disabled*.' }, { quoted: makeSmartQuote() });
  }

  if (opt === 'on') {
    const cur = botdb.getGreetings(from);
    botdb.setWelcome(from, true, cur.welcome_msg || 'Welcome @{user} to *{group}*! 🎉');
    return await conn.sendMessage(from, { text: '✅ Welcome message *enabled*.' }, { quoted: makeSmartQuote() });
  }

  botdb.setWelcome(from, true, q);
  const preview = q
    .replace(/@\{user\}|\{user\}/gi, '@NewMember')
    .replace(/\{group\}/gi, groupName || 'Group')
    .replace(/\{count\}/gi, '25');
  return await conn.sendMessage(from, { text: `✅ *Welcome ON + message set!*\n\n*Preview:*\n${preview}` }, { quoted: makeSmartQuote() });
});

cast({
  pattern:  'setgoodbye',
  alias:    ['goodbye', 'setbye'],
  desc:     'Set goodbye message or toggle on/off. Vars: @{user} {group} {count}',
  category: 'group',
  react:    '🚪',
  filename: __filename
}, async (conn, mek, m, { from, isGroup, isAdmins, isOwner, isSudo, q, groupName, reply }) => {
  if (!isGroup) return await conn.sendMessage(from, { text: '🚫 Groups only.' }, { quoted: makeSmartQuote() });
  if (!isAdmins && !isOwner && !isSudo) return await conn.sendMessage(from, { text: '❌ Admins only.' }, { quoted: makeSmartQuote() });

  if (!q) {
    const s = botdb.getGreetings(from);
    return await conn.sendMessage(from, {
      text: `🚪 *Goodbye Status*\n` +
            `Status: ${s.goodbye_enabled ? '✅ ON' : '❌ OFF'}\n` +
            (s.goodbye_msg ? `Message: ${s.goodbye_msg}\n` : '') +
            `\n*Usage:*\n` +
            `setgoodbye on  — enable\n` +
            `setgoodbye off — disable\n` +
            `setgoodbye Goodbye @{user} from {group}! — set message & enable\n` +
            `\n*Variables:* @{user}  {group}  {count}`
    }, { quoted: makeSmartQuote() });
  }

  const opt = q.toLowerCase().trim();

  if (opt === 'off') {
    botdb.setGoodbye(from, false, botdb.getGreetings(from).goodbye_msg || '');
    return await conn.sendMessage(from, { text: '❌ Goodbye message *disabled*.' }, { quoted: makeSmartQuote() });
  }

  if (opt === 'on') {
    const cur = botdb.getGreetings(from);
    botdb.setGoodbye(from, true, cur.goodbye_msg || `Goodbye @{user}! 👋 We'll miss you in *{group}*.`);
    return await conn.sendMessage(from, { text: '✅ Goodbye message *enabled*.' }, { quoted: makeSmartQuote() });
  }

  botdb.setGoodbye(from, true, q);
  const preview = q
    .replace(/@\{user\}|\{user\}/gi, '@LeavingMember')
    .replace(/\{group\}/gi, groupName || 'Group')
    .replace(/\{count\}/gi, '24');
  return await conn.sendMessage(from, { text: `✅ *Goodbye ON + message set!*\n\n*Preview:*\n${preview}` }, { quoted: makeSmartQuote() });
});

cast({
  pattern:  'welcomestatus',
  alias:    ['greetingstatus'],
  desc:     'Check welcome/goodbye settings for this group',
  category: 'group',
  react:    '⚙️',
  filename: __filename
}, async (conn, mek, m, { from, isGroup, reply }) => {
  if (!isGroup) return await conn.sendMessage(from, { text: '🚫 Groups only.' }, { quoted: makeSmartQuote() });
  const s = botdb.getGreetings(from);
  await conn.sendMessage(from, {
    text:
      `⚙️ *Welcome/Goodbye Status*\n\n` +
      `👋 Welcome: ${s.welcome_enabled ? '✅ ON' : '❌ OFF'}\n` +
      (s.welcome_msg ? `   _"${s.welcome_msg.substring(0, 80)}${s.welcome_msg.length > 80 ? '...' : ''}"_\n` : '') +
      `🚪 Goodbye: ${s.goodbye_enabled ? '✅ ON' : '❌ OFF'}\n` +
      (s.goodbye_msg ? `   _"${s.goodbye_msg.substring(0, 80)}${s.goodbye_msg.length > 80 ? '...' : ''}"_\n` : '') +
      `\n_Vars: @{user} @{group}_`
  }, { quoted: makeSmartQuote() });
});

// ── KEYWORD FILTERS — addfilter/removefilter/listfilters 

function readF(gJid)     { return Object.fromEntries(botdb.getFilters(gJid).map(r=>[r.keyword,r.response])); }
function saveF()         { /* botdb handles persistence */ }
function _addF(g,k,r)    { botdb.addFilter(g,k,r); }
function _delF(g,k)      { return botdb.removeFilter(g,k); }
function _clearF(g)      { return botdb.clearFilters(g); }

cast({
  pattern:  'addfilter',
  alias:    ['filter'],
  desc:     'Add keyword auto-reply: addfilter <keyword> | <response>',
  category: 'group',
  react:    '🔑',
  filename: __filename
}, async (conn, mek, m, { from, isGroup, isAdmins, isOwner, isSudo, body, reply }) => {
  if (!isGroup) return await conn.sendMessage(from, { text: '🚫 Groups only.' }, { quoted: makeSmartQuote() });
  if (!isAdmins && !isOwner && !isSudo) return await conn.sendMessage(from, { text: '❌ Admins only.' }, { quoted: makeSmartQuote() });

  const text = (body || '').split(' ').slice(1).join(' ');
  const sep  = text.indexOf('|');
  if (sep === -1) return await conn.sendMessage(from, { text: '❗ Usage: addfilter <keyword> | <response>' }, { quoted: makeSmartQuote() });
  const keyword  = text.slice(0, sep).trim().toLowerCase();
  const response = text.slice(sep + 1).trim();

  if (!keyword || !response) return await conn.sendMessage(from, { text: '❗ Both keyword and response are required.' }, { quoted: makeSmartQuote() });

  _addF(from, keyword, response);
  await conn.sendMessage(from, { text: `✅ Filter added!\n🔑 *Keyword:* ${keyword}\n💬 *Response:* ${response.substring(0, 100)}` }, { quoted: makeSmartQuote() });
});

cast({
  pattern:  'removefilter',
  alias:    ['delfilter'],
  desc:     'Remove a keyword filter: removefilter <keyword>',
  category: 'group',
  react:    '🗑️',
  filename: __filename
}, async (conn, mek, m, { from, isGroup, isAdmins, isOwner, isSudo, body, reply }) => {
  if (!isGroup) return await conn.sendMessage(from, { text: '🚫 Groups only.' }, { quoted: makeSmartQuote() });
  if (!isAdmins && !isOwner && !isSudo) return await conn.sendMessage(from, { text: '❌ Admins only.' }, { quoted: makeSmartQuote() });
  const keyword = (body || '').split(' ').slice(1).join(' ').trim().toLowerCase();
  if (!keyword) return await conn.sendMessage(from, { text: '❗ Usage: removefilter <keyword>' }, { quoted: makeSmartQuote() });
  const data = readF();
  if (!data[from]?.[keyword]) return await conn.sendMessage(from, { text: `❌ No filter for keyword: *${keyword}*` }, { quoted: makeSmartQuote() });
  delete data[from][keyword];
  saveF(data);
  await conn.sendMessage(from, { text: `✅ Filter *${keyword}* removed.` }, { quoted: makeSmartQuote() });
});

cast({
  pattern:  'listfilters',
  alias:    ['filters'],
  desc:     'List all keyword filters in this group',
  category: 'group',
  react:    '📋',
  filename: __filename
}, async (conn, mek, m, { from, isGroup, reply }) => {
  if (!isGroup) return await conn.sendMessage(from, { text: '🚫 Groups only.' }, { quoted: makeSmartQuote() });
  const data    = readF();
  const filters = data[from] || {};
  const keys    = Object.keys(filters);
  if (!keys.length) return await conn.sendMessage(from, { text: '📭 No filters set.\nAdd one: *addfilter <keyword> | <response>*' }, { quoted: makeSmartQuote() });
  const lines = keys.map((k, i) =>
    `${i + 1}. 🔑 *${k}*\n   → ${filters[k].substring(0, 80)}${filters[k].length > 80 ? '...' : ''}`
  );
  await conn.sendMessage(from, {
    text: `🔍 *Filters (${keys.length})*\n\n${lines.join('\n\n')}`
  }, { quoted: makeSmartQuote() });
});

cast({
  pattern:  'clearfilters',
  desc:     'Remove ALL keyword filters in this group (admin only)',
  category: 'group',
  react:    '🗑️',
  filename: __filename
}, async (conn, mek, m, { from, isGroup, isAdmins, isOwner, isSudo, reply }) => {
  if (!isGroup) return await conn.sendMessage(from, { text: '🚫 Groups only.' }, { quoted: makeSmartQuote() });
  if (!isAdmins && !isOwner && !isSudo) return await conn.sendMessage(from, { text: '❌ Admins only.' }, { quoted: makeSmartQuote() });
  const data  = readF();
  const count = Object.keys(data[from] || {}).length;
  if (!count) return await conn.sendMessage(from, { text: '📭 No filters to clear.' }, { quoted: makeSmartQuote() });
  delete data[from];
  saveF(data);
  await conn.sendMessage(from, { text: `🗑️ Cleared *${count}* filter${count > 1 ? 's' : ''}.` }, { quoted: makeSmartQuote() });
});

function registerFilterListener(conn) {
  conn.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const mek of messages) {
      try {
        if (!mek.message || mek.key.fromMe) continue;
        const from = mek.key.remoteJid;
        if (!from?.endsWith('@g.us')) continue;
        const data    = readF();
        const filters = data[from];
        if (!filters || !Object.keys(filters).length) continue;
        const text = (
          mek.message?.conversation ||
          mek.message?.extendedTextMessage?.text ||
          mek.message?.imageMessage?.caption ||
          mek.message?.videoMessage?.caption || ''
        ).toLowerCase().trim();
        if (!text) continue;
        for (const [keyword, response] of Object.entries(filters)) {
          if (text.includes(keyword)) {
            await conn.sendMessage(from, { text: response }, { quoted: makeSmartQuote() }).catch(() => {});
            break;
          }
        }
      } catch (e) { console.error('filter listener:', e.message); }
    }
  });
  console.log('✅ Filter listener registered.');
}



// ── GROUP NOTES — savenote/getnote/listnotes/delnote ──

const NOTES_FILE = path.join(__dirname, '../lib/notes.json');
function readN()  { try { return JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8')); } catch { return {}; } }
function saveN(d) { fs.writeFileSync(NOTES_FILE, JSON.stringify(d, null, 2)); }
if (!fs.existsSync(NOTES_FILE)) saveN({});

cast({
  pattern:  'savenote',
  alias:    ['note', 'addnote'],
  desc:     'Save a note: savenote <n> | <content>',
  category: 'group',
  react:    '📝',
  filename: __filename
}, async (conn, mek, m, { from, isGroup, body, reply }) => {
  if (!isGroup) return await conn.sendMessage(from, { text: '🚫 Groups only.' }, { quoted: makeSmartQuote() });
  const text = (body || '').split(' ').slice(1).join(' ');
  const sep  = text.indexOf('|');
  if (sep === -1) return await conn.sendMessage(from, { text: '❗ Usage: savenote <n> | <content>\nExample: savenote rules | Be respectful, no spam.' }, { quoted: makeSmartQuote() });
  const name    = text.slice(0, sep).trim().toLowerCase().replace(/\s+/g, '_');
  const content = text.slice(sep + 1).trim();
  if (!name || !content) return await conn.sendMessage(from, { text: '❗ Both a name and content are required.' }, { quoted: makeSmartQuote() });
  const notes = readN();
  if (!notes[from]) notes[from] = {};
  notes[from][name] = { content, savedAt: Date.now() };
  saveN(notes);
  await conn.sendMessage(from, { text: `📝 Note *${name}* saved!\nGet it with: *getnote ${name}*` }, { quoted: makeSmartQuote() });
});

cast({
  pattern:  'getnote',
  alias:    ['#'],
  desc:     'Get a saved note: getnote <n>',
  category: 'group',
  react:    '📌',
  filename: __filename
}, async (conn, mek, m, { from, isGroup, q, reply }) => {
  if (!isGroup) return await conn.sendMessage(from, { text: '🚫 Groups only.' }, { quoted: makeSmartQuote() });
  const name = (q || '').trim().toLowerCase().replace(/\s+/g, '_');
  if (!name) return await conn.sendMessage(from, { text: '❗ Usage: getnote <n>\nSee all: *listnotes*' }, { quoted: makeSmartQuote() });
  const notes = readN();
  const note  = notes[from]?.[name];
  if (!note) return await conn.sendMessage(from, { text: `❌ Note *${name}* not found.\nSee all with: *listnotes*` }, { quoted: makeSmartQuote() });
  const age = Math.floor((Date.now() - note.savedAt) / 86400000);
  await conn.sendMessage(from, {
    text: `📌 *${name}*\n\n${note.content}\n\n_Saved ${age === 0 ? 'today' : `${age} day${age > 1 ? 's' : ''} ago`}_`
  }, { quoted: makeSmartQuote() });
});

cast({
  pattern:  'listnotes',
  alias:    ['notes', 'notelist'],
  desc:     'List all notes saved in this group',
  category: 'group',
  react:    '📒',
  filename: __filename
}, async (conn, mek, m, { from, isGroup, reply }) => {
  if (!isGroup) return await conn.sendMessage(from, { text: '🚫 Groups only.' }, { quoted: makeSmartQuote() });
  const notes    = readN();
  const grpNotes = notes[from] || {};
  const keys     = Object.keys(grpNotes);
  if (!keys.length) return await conn.sendMessage(from, { text: '📭 No notes saved yet.\nAdd one: *savenote <n> | <content>*' }, { quoted: makeSmartQuote() });
  const lines = keys.map((k, i) => {
    const preview = grpNotes[k].content.substring(0, 60) + (grpNotes[k].content.length > 60 ? '...' : '');
    return `${i + 1}. 📌 *${k}*\n   ${preview}`;
  });
  await conn.sendMessage(from, {
    text: `📒 *Notes (${keys.length})*\n\n${lines.join('\n\n')}\n\n_Use *getnote <n>* to read_`
  }, { quoted: makeSmartQuote() });
});

cast({
  pattern:  'delnote',
  alias:    ['deletenote'],
  desc:     'Delete a note (admin): delnote <n>',
  category: 'group',
  react:    '🗑️',
  filename: __filename
}, async (conn, mek, m, { from, isGroup, isAdmins, isOwner, isSudo, q, reply }) => {
  if (!isGroup) return await conn.sendMessage(from, { text: '🚫 Groups only.' }, { quoted: makeSmartQuote() });
  if (!isAdmins && !isOwner && !isSudo) return await conn.sendMessage(from, { text: '❌ Admins only.' }, { quoted: makeSmartQuote() });
  const name = (q || '').trim().toLowerCase().replace(/\s+/g, '_');
  if (!name) return await conn.sendMessage(from, { text: '❗ Usage: delnote <n>' }, { quoted: makeSmartQuote() });
  const notes = readN();
  if (!notes[from]?.[name]) return await conn.sendMessage(from, { text: `❌ Note *${name}* not found.` }, { quoted: makeSmartQuote() });
  delete notes[from][name];
  saveN(notes);
  await conn.sendMessage(from, { text: `✅ Note *${name}* deleted.` }, { quoted: makeSmartQuote() });
});

cast({
  pattern:  'clearnotes',
  desc:     'Delete ALL notes in this group (admin only)',
  category: 'group',
  react:    '🗑️',
  filename: __filename
}, async (conn, mek, m, { from, isGroup, isAdmins, isOwner, isSudo, reply }) => {
  if (!isGroup) return await conn.sendMessage(from, { text: '🚫 Groups only.' }, { quoted: makeSmartQuote() });
  if (!isAdmins && !isOwner && !isSudo) return await conn.sendMessage(from, { text: '❌ Admins only.' }, { quoted: makeSmartQuote() });
  const notes = readN();
  const count = Object.keys(notes[from] || {}).length;
  if (!count) return await conn.sendMessage(from, { text: '📭 No notes to clear.' }, { quoted: makeSmartQuote() });
  delete notes[from];
  saveN(notes);
  await conn.sendMessage(from, { text: `🗑️ Cleared *${count}* note${count > 1 ? 's' : ''}.` }, { quoted: makeSmartQuote() });
});

module.exports = { handleAntiGroupMention, registerAntiNewsletter, handleAntiNewsletter, registerGroupMessages, registerFilterListener };
