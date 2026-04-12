'use strict';

const { cast, makeSmartQuote, applyFont } = require('../cast');
const config = require('../config');
const { lidToPhone } = require('../lib/lid');
const axios = require('axios');

// ── GROUP SETTINGS — ginfo/setdesc/setgname/gpp/lock/unlock/kik/num/poll/ship 

const P = config.PREFIX || '/';

// ── ginfo ─────────────────────────────────────────────────────────────
// ── getjids ───────────────────────────────────────────────────────────
cast({
  pattern: 'getjids',
  alias: ['gjid', 'allgc', 'gclist'],
  desc: 'List all group JIDs and names (owner only)',
  category: 'group',
  filename: __filename
}, async (conn, mek, m, { from, q, isOwner, isSudo, reply }) => {
  try {
    if (!isOwner) return reply('*Owner only!*');
    const groups  = await conn.groupFetchAllParticipating();
    const entries = Object.entries(groups);
    const onlyJids  = (q || '').includes('jid');
    const onlyNames = (q || '').includes('name');
    let txt = `📋 *All Groups (${entries.length})*\n\n`;
    for (const [id, meta] of entries) {
      if (!onlyJids)  txt += `*Group:* ${meta.subject}  `;
      if (!onlyNames) txt += `*JID:* ${id}`;
      txt += '\n';
    }
    await conn.sendMessage(from, { text: txt }, { quoted: makeSmartQuote() });
  } catch (e) { reply(`❌ Error: ${e.message}`); }
});

// ── rejectall ─────────────────────────────────────────────────────────
cast({
  pattern: 'rejectall',
  alias: ['rejectjoin'],
  desc: 'Reject all pending join requests',
  category: 'group',
  filename: __filename
}, async (conn, mek, m, { from, isGroup, isAdmins, isOwner, isSudo, reply }) => {
  try {
    if (!isGroup) return reply('*Groups only!*');
    if (!isAdmins && !isOwner && !isSudo) return reply('*Admins only!*');
    const list = await conn.groupRequestParticipantsList(from);
    if (!list?.length) return reply('*No pending join requests!*');
    const jids = [];
    for (const req of list) {
      try { await conn.groupRequestParticipantsUpdate(from, [req.jid], 'reject'); jids.push(req.jid); } catch {}
    }
    let txt = `✅ *Rejected ${jids.length} join request(s):*\n`;
    jids.forEach(jid => { txt += `• @${jid.split('@')[0]}\n`; });
    await conn.sendMessage(from, { text: txt, mentions: jids }, { quoted: makeSmartQuote() });
  } catch (e) { reply(`❌ Error: ${e.message}`); }
});

// ── acceptall ─────────────────────────────────────────────────────────
cast({
  pattern: 'acceptall',
  alias: ['acceptjoin'],
  desc: 'Accept all pending join requests',
  category: 'group',
  filename: __filename
}, async (conn, mek, m, { from, isGroup, isAdmins, isOwner, isSudo, reply }) => {
  try {
    if (!isGroup) return reply('*Groups only!*');
    if (!isAdmins && !isOwner && !isSudo) return reply('*Admins only!*');
    const list = await conn.groupRequestParticipantsList(from);
    if (!list?.length) return reply('*No pending join requests!*');
    const jids = [];
    for (const req of list) {
      try { await conn.groupRequestParticipantsUpdate(from, [req.jid], 'approve'); jids.push(req.jid); } catch {}
    }
    let txt = `✅ *Accepted ${jids.length} join request(s):*\n`;
    jids.forEach(jid => { txt += `• @${jid.split('@')[0]}\n`; });
    await conn.sendMessage(from, { text: txt, mentions: jids }, { quoted: makeSmartQuote() });
  } catch (e) { reply(`❌ Error: ${e.message}`); }
});

// ── listrequest ───────────────────────────────────────────────────────
cast({
  pattern: 'listrequest',
  alias: ['requestjoin'],
  desc: 'List all pending join requests',
  category: 'group',
  filename: __filename
}, async (conn, mek, m, { from, isGroup, isAdmins, isOwner, isSudo, reply }) => {
  try {
    if (!isGroup) return reply('*Groups only!*');
    if (!isAdmins && !isOwner && !isSudo) return reply('*Admins only!*');
    const list = await conn.groupRequestParticipantsList(from);
    if (!list?.length) return reply('*No pending join requests!*');
    const jids = list.map(r => r.jid);
    let txt = `📋 *Pending Join Requests (${jids.length}):*\n\n`;
    jids.forEach((jid, i) => { txt += `${i + 1}. @${jid.split('@')[0]}\n`; });
    await conn.sendMessage(from, { text: txt, mentions: jids }, { quoted: makeSmartQuote() });
  } catch (e) { reply(`❌ Error: ${e.message}`); }
});

// ── pick ──────────────────────────────────────────────────────────────
cast({
  pattern: 'pick',
  desc: 'Pick a random group member',
  category: 'group',
  filename: __filename
}, async (conn, mek, m, { from, q, isGroup, participants, reply }) => {
  try {
    if (!isGroup) return reply('*Groups only!*');
    if (!q) return reply(`*What type of person?*\nExample: ${P}pick most active`);
    const ids    = participants.map(p => p.id);
    const picked = ids[Math.floor(Math.random() * ids.length)];
    await conn.sendMessage(from, {
      text: `🎯 The most *${q}* person around us is @${picked.split('@')[0]}!`,
      mentions: [picked]
    }, { quoted: makeSmartQuote() });
  } catch (e) { reply(`❌ Error: ${e.message}`); }
});

// ── common ────────────────────────────────────────────────────────────
cast({
  pattern: 'common',
  desc: 'Find common members between two groups (owner only)',
  category: 'group',
  filename: __filename
}, async (conn, mek, m, { from, q, isOwner, isSudo, reply }) => {
  try {
    if (!isOwner) return reply('*Owner only!*');
    const jids = (q || '').match(/\d+@g\.us/g);
    if (!jids || jids.length < 2) return reply(`*Provide 2 group JIDs!*\nExample: ${P}common 123@g.us 456@g.us`);
    const [g1, g2] = await Promise.all([conn.groupMetadata(jids[0]), conn.groupMetadata(jids[1])]);
    const common = g1.participants.filter(p => g2.participants.some(p2 => p2.id === p.id));
    if (!common.length) return reply('*No common members found!*');
    const ids = common.map(p => p.id);
    let txt = `🔗 *Common Members (${ids.length})*\n*${g1.subject}* ↔ *${g2.subject}*\n\n`;
    ids.forEach((id, i) => { txt += `${i + 1}. @${id.split('@')[0]}\n`; });
    await conn.sendMessage(from, { text: txt, mentions: ids }, { quoted: makeSmartQuote() });
  } catch (e) { reply(`❌ Error: ${e.message}`); }
});

// ── diff ──────────────────────────────────────────────────────────────
cast({
  pattern: 'diff',
  desc: 'Members in group 1 but not in group 2 (owner only)',
  category: 'group',
  filename: __filename
}, async (conn, mek, m, { from, q, isOwner, isSudo, reply }) => {
  try {
    if (!isOwner) return reply('*Owner only!*');
    const jids = (q || '').match(/\d+@g\.us/g);
    if (!jids || jids.length < 2) return reply(`*Provide 2 group JIDs!*`);
    const [g1, g2] = await Promise.all([conn.groupMetadata(jids[0]), conn.groupMetadata(jids[1])]);
    const diff = g1.participants.filter(p => !g2.participants.some(p2 => p2.id === p.id));
    if (!diff.length) return reply('*No unique members found!*');
    const ids = diff.map(p => p.id);
    let txt = `📊 *Members only in "${g1.subject}" (${ids.length}):*\n\n`;
    ids.forEach((id, i) => { txt += `${i + 1}. @${id.split('@')[0]}\n`; });
    await conn.sendMessage(from, { text: txt, mentions: ids }, { quoted: makeSmartQuote() });
  } catch (e) { reply(`❌ Error: ${e.message}`); }
});

// ── GROUP TOOLS — listadmins/members/invitelink/revoke/ephemeral2/kickall 
// Extra group management tools

// ── listadmins ────────────────────────────────────────────────────────
cast({
  pattern:  'listadmins',
  alias:    ['admins', 'groupadmins'],
  desc:     'List all group admins',
  category: 'group',
  react:    '👑',
  filename: __filename
}, async (conn, mek, m, { from, isGroup, groupAdmins, participants, reply }) => {
  if (!isGroup) return reply('🚫 Groups only.');
  if (!participants?.length) return reply('❌ Could not fetch group info.');
  const admins = participants.filter(p => p.admin);
  if (!admins.length) return reply('❌ No admins found.');
  const lines = admins.map((a, i) =>
    `${i + 1}. ${a.admin === 'superadmin' ? '👑 Creator' : '⭐ Admin'} — @${a.id.split('@')[0]}`
  );
  await conn.sendMessage(from, {
    text: `👑 *Group Admins (${admins.length})*\n\n${lines.join('\n')}`,
    mentions: admins.map(a => a.id)
  }, { quoted: makeSmartQuote() });
});

// ── members ───────────────────────────────────────────────────────────
cast({
  pattern:  'members',
  alias:    ['memberlist'],
  desc:     'List all group members',
  category: 'group',
  react:    '👥',
  filename: __filename
}, async (conn, mek, m, { from, isGroup, groupName, participants, reply }) => {
  if (!isGroup) return reply('🚫 Groups only.');
  if (!participants?.length) return reply('❌ Could not fetch group info.');
  const lines = participants.map((p, i) => {
    const badge = p.admin === 'superadmin' ? '👑' : p.admin ? '⭐' : '👤';
    return `${i + 1}. ${badge} +${p.id.split('@')[0]}`;
  });
  const text = `👥 *${groupName} (${participants.length} members)*\n\n${lines.join('\n')}`;
  await conn.sendMessage(from, { text: text.substring(0, 4000) }, { quoted: makeSmartQuote() });
});

// ── invitelink ────────────────────────────────────────────────────────
cast({
  pattern:  'invitelink',
  alias:    ['getlink', 'glink'],
  desc:     'Get the group invite link (admins only)',
  category: 'group',
  react:    '🔗',
  filename: __filename
}, async (conn, mek, m, { from, isGroup, isAdmins, isOwner, isSudo, reply }) => {
  if (!isGroup) return reply('🚫 Groups only.');
  if (!isAdmins && !isOwner && !isSudo) return reply('❌ Admins only.');
  try {
    const code = await conn.groupInviteCode(from);
    await conn.sendMessage(from, {
      text: `🔗 *Group Invite Link*\n\nhttps://chat.whatsapp.com/${code}`
    }, { quoted: makeSmartQuote() });
  } catch { reply('❌ Failed to get link. Make sure I am an admin.'); }
});

// ── revoke ────────────────────────────────────────────────────────────
cast({
  pattern:  'revoke',
  alias:    ['revokelink', 'resetlink'],
  desc:     'Revoke and reset the group invite link',
  category: 'group',
  react:    '🔗',
  filename: __filename
}, async (conn, mek, m, { from, isGroup, isAdmins, isOwner, isSudo, isBotAdmins, reply }) => {
  if (!isGroup) return reply('🚫 Groups only.');
  if (!isAdmins && !isOwner && !isSudo) return reply('❌ Admins only.');
  if (!isBotAdmins) return reply('❌ I need to be an admin.');
  try {
    await conn.groupRevokeInvite(from);
    const newCode = await conn.groupInviteCode(from);
    await conn.sendMessage(from, {
      text: `✅ *Invite link revoked!*\n\nNew link:\nhttps://chat.whatsapp.com/${newCode}`
    }, { quoted: makeSmartQuote() });
  } catch { reply('❌ Failed to revoke link.'); }
});

// ── ephemeral2 ────────────────────────────────────────────────────────
// Renamed to ephemeral2 to avoid conflict with updates.js ephemeral command
cast({
  pattern:  'ephemeral2',
  alias:    ['disappear2'],
  desc:     'Set disappearing messages: ephemeral2 off|24h|7d|90d',
  category: 'group',
  react:    '⏱️',
  filename: __filename
}, async (conn, mek, m, { from, isGroup, isAdmins, isOwner, isSudo, isBotAdmins, args, reply }) => {
  if (!isGroup) return reply('🚫 Groups only.');
  if (!isAdmins && !isOwner && !isSudo) return reply('❌ Admins only.');
  if (!isBotAdmins) return reply('❌ I need to be an admin.');
  const opts = { off: 0, '24h': 86400, '7d': 604800, '90d': 7776000 };
  const key  = (args[0] || '').toLowerCase();
  if (!key || !(key in opts)) return reply('❗ Usage: ephemeral2 off|24h|7d|90d');
  try {
    await conn.groupToggleEphemeral(from, opts[key]);
    reply(`✅ Disappearing messages: *${key === 'off' ? 'OFF' : key}*`);
  } catch { reply('❌ Failed to set disappearing messages.'); }
});

// ── kickall ───────────────────────────────────────────────────────────
cast({
  pattern:  'kickall',
  alias:    ['removemembers'],
  desc:     'Kick all non-admin members (admin only)',
  category: 'group',
  react:    '🦾',
  filename: __filename
}, async (conn, mek, m, { from, isGroup, isAdmins, isOwner, isSudo, participants, reply }) => {
  if (!isGroup) return reply('🚫 Groups only.');
  if (!isAdmins && !isOwner && !isSudo) return reply('❌ Admins only.');
  const botId     = conn.user.id.split(':')[0] + '@s.whatsapp.net';
  const nonAdmins = (participants || []).filter(p => !p.admin && p.id !== botId);
  if (!nonAdmins.length) return reply('✅ No non-admin members to remove.');
  await conn.sendMessage(from, {
    text: `⏳ Kicking ${nonAdmins.length} members...`
  }, { quoted: makeSmartQuote() });
  let kicked = 0;
  for (const p of nonAdmins) {
    try { await conn.groupParticipantsUpdate(from, [p.id], 'remove'); kicked++; } catch {}
    await new Promise(r => setTimeout(r, 600));
  }
  reply(`✅ Kicked *${kicked}/${nonAdmins.length}* members.`);
});

// ── DELETE ────────────────────────────────────────────────────────────────────
cast({
  pattern:  'delete',
  alias:    ['del', 'delmsg'],
  desc:     'Delete a replied message',
  category: 'group',
  filename: __filename,
}, async (conn, mek, m, { from, isAdmins, isOwner, isSudo, reply }) => {
  if (!isAdmins && !isOwner && !isSudo) return reply('⚠️ Admins only.');
  if (!m.quoted) return reply('❗ Reply to a message to delete it.');
  try {
    await conn.sendMessage(from, { delete: m.quoted.fakeObj?.key || {
      remoteJid: from,
      fromMe: m.quoted.fromMe,
      id: m.quoted.id,
      participant: m.quoted.sender,
    }});
  } catch (e) {
    reply('❌ Could not delete. I may need admin rights.');
  }
});
