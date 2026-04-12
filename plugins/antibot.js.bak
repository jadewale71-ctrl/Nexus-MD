// plugins/antibot.js — NEXUS-MD
'use strict';

const { cast }                         = require('../cast');
const { getFeature, setFeature,
        incrementFeatureWarn,
        resetFeatureWarn,
        getGroupSettings }             = require('../lib/botdb');

const FEATURE = 'antibot';

// ── Bot detection — checks multiple signals ───────────────────────────────────
function isBotMessage(mek) {
  const msgId  = mek?.key?.id || '';
  const sender = mek?.key?.participant || mek?.key?.remoteJid || '';

  // 1. Known bot message ID prefixes (Baileys/WA-multi-device bots)
  const botIdPrefixes = ['3EB0', 'FALSE', 'TRUE', 'BAE5', 'NEXUS', 'BOT'];
  if (botIdPrefixes.some(p => msgId.toUpperCase().startsWith(p))) return true;

  // 2. Verified business / bot badge
  if (mek?.verifiedBizName) return true;

  // 3. Message ID length — real WA IDs are typically 16–32 chars,
  //    many bot frameworks generate shorter or patterned IDs
  if (msgId.length < 10 && msgId.length > 0) return true;

  // 4. Message has no pushName (bots often send without a display name)
  //    combined with a numeric-only JID pattern typical of bot numbers
  const num = sender.split('@')[0].split(':')[0];
  const hasPushName = !!(mek?.pushName);
  if (!hasPushName && /^\d+$/.test(num) && num.length > 10) {
    // Extra check: message is not from a human typing pattern
    const msg = mek?.message;
    const hasOnlyAutomatedTypes = msg && (
      msg.protocolMessage ||
      msg.senderKeyDistributionMessage ||
      (msg.extendedTextMessage?.contextInfo?.isForwarded && !hasPushName)
    );
    if (hasOnlyAutomatedTypes) return true;
  }

  // 5. Bot-like message ID patterns (all uppercase hex, exactly 32 chars — common in bot frameworks)
  if (/^[0-9A-F]{32}$/.test(msgId)) return true;

  return false;
}

async function handleAntiBot(conn, mek, { from, sender, groupAdmins } = {}) {
  try {
    if (!from?.endsWith('@g.us')) return;
    if (mek.key?.fromMe) return;

    const f = getFeature(from, FEATURE);
    if (!f.enabled || !f.mode || f.mode === 'off') return;

    const participant = sender || mek.key?.participant;
    if (!participant) return;

    // Skip reactions
    if (mek.message?.reactionMessage) return;

    // ── Handle edits (protocolMessage) ───────────────────────────────────
    // When a bot sends "checking..." then edits to "51ms",
    // the edit arrives as protocolMessage with proto.key = original message key
    // Check original key id for 3EB0 prefix
    if (mek.message?.protocolMessage) {
      const proto   = mek.message.protocolMessage;
      const origKey = proto.key;
      if ((proto.type === 14 || proto.editedMessage) && origKey) {
        const origId = origKey.id || '';
        const botPrefixes = ['3EB0', 'FALSE', 'TRUE'];
        if (botPrefixes.some(p => origId.toUpperCase().startsWith(p))) {
          await conn.sendMessage(from, { delete: mek.key }).catch(() => {});
          await conn.sendMessage(from, { delete: origKey }).catch(() => {});
        }
      }
      return;
    }

    // ── Skip admins ───────────────────────────────────────────────────────
    if (Array.isArray(groupAdmins) && groupAdmins.some(a =>
      a.split('@')[0].split(':')[0] === participant.split('@')[0].split(':')[0]
    )) return;

    // ── Detect bot ────────────────────────────────────────────────────────
    if (!isBotMessage(mek)) return;

    const mode      = f.mode;
    const settings  = getGroupSettings(from) || {};
    const warnLimit = settings.warn_limit || 3;
    const num       = participant.split('@')[0];

    if (mode === 'delete') {
      await conn.sendMessage(from, { delete: mek.key }).catch(() => {});
      await conn.sendMessage(from, {
        text: `🤖 @${num} — bot accounts are not allowed here.`,
        mentions: [participant]
      }).catch(() => {});

    } else if (mode === 'kick') {
      await conn.sendMessage(from, { delete: mek.key }).catch(() => {});
      await conn.groupParticipantsUpdate(from, [participant], 'remove').catch(() => {});
      await conn.sendMessage(from, {
        text: `🤖 @${num} — bot account removed.`,
        mentions: [participant]
      }).catch(() => {});

    } else if (mode === 'warn') {
      const count = incrementFeatureWarn(from, FEATURE, participant);
      await conn.sendMessage(from, { delete: mek.key }).catch(() => {});
      if (count >= warnLimit) {
        await conn.groupParticipantsUpdate(from, [participant], 'remove').catch(() => {});
        await conn.sendMessage(from, {
          text: `🤖 @${num} removed after ${count}/${warnLimit} warnings.`,
          mentions: [participant]
        }).catch(() => {});
        resetFeatureWarn(from, FEATURE, participant);
      } else {
        await conn.sendMessage(from, {
          text: `🤖 @${num} — warning *${count}/${warnLimit}*. Bot accounts not allowed.`,
          mentions: [participant]
        }).catch(() => {});
      }
    }
  } catch (e) {
    console.error('[antibot]', e.message);
  }
}

// ── antibot command ───────────────────────────────────────────────────────────
cast({
  pattern:  'antibot',
  desc:     'Manage antibot. Modes: warn | kick | delete | off',
  category: 'moderation',
  filename: __filename,
}, async (conn, mek, m, { from, isGroup, isAdmins, isOwner, args, reply }) => {
  if (!isGroup)              return reply('🚫 Groups only.');
  if (!isAdmins && !isOwner) return reply('⚠️ Admins only.');

  const mode = (args[0] || '').toLowerCase();

  if (!mode) {
    const f = getFeature(from, FEATURE);
    return reply(
      `🤖 *Antibot Status*\n` +
      `Status: ${f.enabled ? '✅ ON' : '❌ OFF'}\n` +
      `Mode: *${f.mode || 'off'}*\n\n` +
      `*Usage:* antibot <mode>\n` +
      `  *warn*   — warn bot accounts\n` +
      `  *kick*   — remove immediately\n` +
      `  *delete* — delete messages only\n` +
      `  *off*    — disable`
    );
  }

  if (!['warn','kick','delete','off'].includes(mode))
    return reply('❗ Valid modes: warn | kick | delete | off');

  if (mode === 'off') {
    setFeature(from, FEATURE, false, 'off');
    return reply('❌ Antibot *disabled*.');
  }

  setFeature(from, FEATURE, true, mode);
  return reply(`✅ Antibot set to *${mode}* mode.`);
});

module.exports = { handleAntiBot };
