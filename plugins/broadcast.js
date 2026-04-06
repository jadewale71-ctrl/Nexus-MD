// plugins/broadcast.js — NEXUS-MD
'use strict';

const { cast, makeSmartQuote } = require('../cast');
const config = require('../config');

function isOwner(sender, conn) {
  const ownerNum = (config.OWNER_NUMBER || '2348084644182').replace(/\D/g,'');
  const botNum   = conn.user.id.split(':')[0];
  const senderNum = sender.split('@')[0].split(':')[0];
  return senderNum === ownerNum || senderNum === botNum;
}

// ── broadcastgroup ────────────────────────────────────────────────────────────
cast({
  pattern:  'broadcastgroup',
  alias:    ['bcgroup', 'bgcast'],
  desc:     'Broadcast a message to all group chats',
  category: 'owner',
  filename: __filename,
}, async (conn, mek, m, { sender, q, reply }) => {
  if (!isOwner(sender, conn)) return reply('❌ Owner only.');
  if (!q) return reply('Usage: broadcastgroup <message>');

  // Fetch all groups directly from Baileys
  let groups = [];
  try {
    const allGroups = await conn.groupFetchAllParticipating();
    groups = Object.keys(allGroups || {});
  } catch {}
  // Fallback to store if API fails
  if (!groups.length) {
    try {
      const _s = require('../index').store;
      groups = Object.keys(_s?.messages || {}).filter(c => c.endsWith('@g.us'));
    } catch {}
  }
  if (!groups.length) return reply('❌ No group chats found. Make sure the bot is in at least one group.');

  await reply(`⏳ Broadcasting to *${groups.length}* groups...`);
  let sent = 0, failed = 0;

  for (const chat of groups) {
    try {
      await conn.sendMessage(chat, { text: q });
      sent++;
      await new Promise(r => setTimeout(r, 500)); // avoid spam ban
    } catch { failed++; }
  }

  reply(`✅ Broadcast complete!\nSent: *${sent}* | Failed: *${failed}*`);
});

// ── broadcastprivate ──────────────────────────────────────────────────────────
cast({
  pattern:  'broadcastprivate',
  alias:    ['bcprivate', 'bpdm'],
  desc:     'Broadcast a message to all private chats',
  category: 'owner',
  filename: __filename,
}, async (conn, mek, m, { sender, q, reply }) => {
  if (!isOwner(sender, conn)) return reply('❌ Owner only.');
  if (!q) return reply('Usage: broadcastprivate <message>');

  let private_ = [];
  try {
    const _s = require('../index').store;
    private_ = Object.keys(_s?.messages || {}).filter(c =>
      !c.endsWith('@g.us') && !c.endsWith('@broadcast') && c.endsWith('@s.whatsapp.net')
    );
  } catch {}
  if (!private_.length) return reply('❌ No private chats found. Send the bot a DM first so it learns the chat.');

  await reply(`⏳ Broadcasting to *${private_.length}* private chats...`);
  let sent = 0, failed = 0;

  for (const chat of private_) {
    try {
      await conn.sendMessage(chat, { text: q });
      sent++;
      await new Promise(r => setTimeout(r, 500));
    } catch { failed++; }
  }

  reply(`✅ Broadcast complete!\nSent: *${sent}* | Failed: *${failed}*`);
});

// ── broadcastall ──────────────────────────────────────────────────────────────
cast({
  pattern:  'broadcastall',
  alias:    ['bcall', 'bcast'],
  desc:     'Broadcast a message to ALL chats (groups + private)',
  category: 'owner',
  filename: __filename,
}, async (conn, mek, m, { sender, q, reply }) => {
  if (!isOwner(sender, conn)) return reply('❌ Owner only.');
  if (!q) return reply('Usage: broadcastall <message>');

  let _groups = [];
  try {
    const allGroups = await conn.groupFetchAllParticipating();
    _groups = Object.keys(allGroups || {});
  } catch {}
  let _private = [];
  try {
    const _s = require('../index').store;
    _private = Object.keys(_s?.messages || {}).filter(c =>
      !c.endsWith('@g.us') && !c.endsWith('@broadcast') && c.endsWith('@s.whatsapp.net')
    );
  } catch {}
  const chats = [...new Set([..._groups, ..._private])];
  if (!chats.length) return reply('❌ No chats found.');

  await reply(`⏳ Broadcasting to *${chats.length}* chats...`);
  let sent = 0, failed = 0;

  for (const chat of chats) {
    try {
      await conn.sendMessage(chat, { text: q });
      sent++;
      await new Promise(r => setTimeout(r, 500));
    } catch { failed++; }
  }

  reply(`✅ Broadcast complete!\nSent: *${sent}* | Failed: *${failed}*`);
});
