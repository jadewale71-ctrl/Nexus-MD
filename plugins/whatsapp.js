// plugins/whatsapp.js — NEXUS-MD
// WhatsApp settings: archive, pin, markread, clear, privacy + AFK/BGM/pmpermit/block/setsticker
'use strict';

const { cast, makeSmartQuote } = require('../cast');
const config  = require('../config');
const botdb   = require('../lib/botdb');
const { lidToPhone } = require('../lib/lid');
const { downloadMediaMessage, jidNormalizedUser } = require('@whiskeysockets/baileys');
const fs   = require('fs');
const path = require('path');

function sq() { return makeSmartQuote(); }

// ─────────────────────────────────────────────────────────────────────────────
// CHAT MANAGEMENT — archive/unarchive/pin/unpin/markread/markunread/mute/unmute/clear/delete
// ─────────────────────────────────────────────────────────────────────────────

function resolveChat(from, m, args) {
  if (args[0] && /^\d{5,}$/.test(args[0].replace(/\D/g,'')))
    return args[0].replace(/\D/g,'') + '@s.whatsapp.net';
  if (m.quoted?.sender) return m.quoted.sender;
  return from;
}

cast({ pattern: 'archive', alias: ['archivechat'], desc: 'Archive a chat', category: 'whatsapp', filename: __filename },
async (conn, mek, m, { from, isOwner, args, reply }) => {
  if (!isOwner) return reply('⛔ Owner only.');
  try { await conn.chatModify({ archive: true, lastMessages: [] }, resolveChat(from, m, args)); reply('✅ Chat archived.'); }
  catch (e) { reply(`❌ Failed: ${e.message}`); }
});

cast({ pattern: 'unarchive', alias: ['unarchivechat'], desc: 'Unarchive a chat', category: 'whatsapp', filename: __filename },
async (conn, mek, m, { from, isOwner, args, reply }) => {
  if (!isOwner) return reply('⛔ Owner only.');
  try { await conn.chatModify({ archive: false, lastMessages: [] }, resolveChat(from, m, args)); reply('✅ Chat unarchived.'); }
  catch (e) { reply(`❌ Failed: ${e.message}`); }
});

cast({ pattern: 'pin', alias: ['pinchat'], desc: 'Pin a chat', category: 'whatsapp', filename: __filename },
async (conn, mek, m, { from, isOwner, args, reply }) => {
  if (!isOwner) return reply('⛔ Owner only.');
  try { await conn.chatModify({ pin: true }, resolveChat(from, m, args)); reply('📌 Chat pinned.'); }
  catch (e) { reply(`❌ Failed: ${e.message}`); }
});

cast({ pattern: 'unpin', alias: ['unpinchat'], desc: 'Unpin a chat', category: 'whatsapp', filename: __filename },
async (conn, mek, m, { from, isOwner, args, reply }) => {
  if (!isOwner) return reply('⛔ Owner only.');
  try { await conn.chatModify({ pin: false }, resolveChat(from, m, args)); reply('✅ Chat unpinned.'); }
  catch (e) { reply(`❌ Failed: ${e.message}`); }
});

cast({ pattern: 'markread', alias: ['read', 'readchat'], desc: 'Mark a chat as read', category: 'whatsapp', filename: __filename },
async (conn, mek, m, { from, isOwner, args, reply }) => {
  if (!isOwner) return reply('⛔ Owner only.');
  try { await conn.chatModify({ markRead: true, lastMessages: [] }, resolveChat(from, m, args)); reply('✅ Marked as read.'); }
  catch (e) { reply(`❌ Failed: ${e.message}`); }
});

cast({ pattern: 'markunread', alias: ['unread'], desc: 'Mark a chat as unread', category: 'whatsapp', filename: __filename },
async (conn, mek, m, { from, isOwner, args, reply }) => {
  if (!isOwner) return reply('⛔ Owner only.');
  try { await conn.chatModify({ markRead: false, lastMessages: [] }, resolveChat(from, m, args)); reply('✅ Marked as unread.'); }
  catch (e) { reply(`❌ Failed: ${e.message}`); }
});

cast({ pattern: 'mutechat', alias: ['silentchat'], desc: 'Mute a chat. Duration: 8h | 1w | 1y', use: '<8h|1w|1y>', category: 'whatsapp', filename: __filename },
async (conn, mek, m, { from, isOwner, args, reply }) => {
  if (!isOwner) return reply('⛔ Owner only.');
  const dur = (args[0] || '8h').toLowerCase();
  const durations = { '8h': 8*3600000, '1w': 7*86400000, '1y': 365*86400000 };
  if (!durations[dur]) return reply('❗ Use: mutechat 8h | 1w | 1y');
  try { await conn.chatModify({ mute: Date.now() + durations[dur] }, resolveChat(from, m, args.slice(1))); reply(`🔇 Muted for *${dur}*.`); }
  catch (e) { reply(`❌ Failed: ${e.message}`); }
});

cast({ pattern: 'unmutechat', alias: ['unsilentchat'], desc: 'Unmute a chat', category: 'whatsapp', filename: __filename },
async (conn, mek, m, { from, isOwner, args, reply }) => {
  if (!isOwner) return reply('⛔ Owner only.');
  try { await conn.chatModify({ mute: null }, resolveChat(from, m, args)); reply('🔊 Chat unmuted.'); }
  catch (e) { reply(`❌ Failed: ${e.message}`); }
});

cast({ pattern: 'clearchat', desc: 'Clear all messages in a chat (local)', category: 'whatsapp', filename: __filename },
async (conn, mek, m, { from, isOwner, args, reply }) => {
  if (!isOwner) return reply('⛔ Owner only.');
  try { await conn.chatModify({ clear: { messages: [] } }, resolveChat(from, m, args)); reply('🗑️ Chat cleared.'); }
  catch (e) { reply(`❌ Failed: ${e.message}`); }
});

cast({ pattern: 'deletechat', desc: 'Delete a chat entirely', category: 'whatsapp', filename: __filename },
async (conn, mek, m, { from, isOwner, args, reply }) => {
  if (!isOwner) return reply('⛔ Owner only.');
  const jid = resolveChat(from, m, args);
  if (jid === from) return reply('⚠️ Pass a number — cannot delete current chat from itself.');
  try { await conn.chatModify({ delete: true, lastMessages: [] }, jid); reply('🗑️ Chat deleted.'); }
  catch (e) { reply(`❌ Failed: ${e.message}`); }
});

// ─────────────────────────────────────────────────────────────────────────────
// PRIVACY SETTINGS
// ─────────────────────────────────────────────────────────────────────────────

cast({ pattern: 'privacy', desc: 'View or change WhatsApp privacy settings', use: '<setting> <value>', category: 'whatsapp', filename: __filename },
async (conn, mek, m, { isOwner, args, reply }) => {
  if (!isOwner) return reply('⛔ Owner only.');
  if (!args[0]) {
    try {
      const p = await conn.fetchPrivacySettings(true);
      return conn.sendMessage(mek.key.remoteJid, {
        text:
          `🔒 *Privacy Settings*\n\n` +
          `Last Seen : ${p.last || 'unknown'}\n` +
          `Online    : ${p.online || 'unknown'}\n` +
          `Profile   : ${p.profile || 'unknown'}\n` +
          `Status    : ${p.status || 'unknown'}\n` +
          `Read Rcpt : ${p.readreceipts || 'unknown'}\n` +
          `Groups    : ${p.groupadd || 'unknown'}\n\n` +
          `*Usage:* privacy <setting> <value>\n` +
          `Settings: lastseen | online | profile | status | readreceipts | groupadd\n` +
          `Values: all | contacts | contact_blacklist | none`
      }, { quoted: sq() });
    } catch (e) { return reply(`❌ ${e.message}`); }
  }
  const map = { lastseen: 'last', online: 'online', profile: 'profile', status: 'status', readreceipts: 'readreceipts', groupadd: 'groupadd' };
  const setting = args[0].toLowerCase(); const value = (args[1] || '').toLowerCase();
  if (!map[setting]) return reply(`❗ Valid: ${Object.keys(map).join(', ')}`);
  if (!['all','contacts','contact_blacklist','none'].includes(value)) return reply('❗ Valid values: all | contacts | contact_blacklist | none');
  try { await conn.updatePrivacySettings(map[setting], value); reply(`✅ *${setting}* → *${value}*`); }
  catch (e) { reply(`❌ ${e.message}`); }
});

cast({ pattern: 'lastseen', alias: ['setlastseen'], desc: 'Set last seen privacy', use: '<all|contacts|none>', category: 'whatsapp', filename: __filename },
async (conn, mek, m, { isOwner, args, reply }) => {
  if (!isOwner) return reply('⛔ Owner only.');
  const val = (args[0]||'').toLowerCase();
  if (!['all','contacts','none'].includes(val)) return reply('❗ Use: lastseen all | contacts | none');
  try { await conn.updatePrivacySettings('last', val); reply(`✅ Last seen → *${val}*`); }
  catch (e) { reply(`❌ ${e.message}`); }
});

cast({ pattern: 'profileprivacy', alias: ['setprofile'], desc: 'Set profile photo privacy', use: '<all|contacts|none>', category: 'whatsapp', filename: __filename },
async (conn, mek, m, { isOwner, args, reply }) => {
  if (!isOwner) return reply('⛔ Owner only.');
  const val = (args[0]||'').toLowerCase();
  if (!['all','contacts','none'].includes(val)) return reply('❗ Use: profileprivacy all | contacts | none');
  try { await conn.updatePrivacySettings('profile', val); reply(`✅ Profile photo → *${val}*`); }
  catch (e) { reply(`❌ ${e.message}`); }
});

cast({ pattern: 'readreceipts', alias: ['bluetick', 'setreceipts'], desc: 'Toggle read receipts', use: '<all|none>', category: 'whatsapp', filename: __filename },
async (conn, mek, m, { isOwner, args, reply }) => {
  if (!isOwner) return reply('⛔ Owner only.');
  const val = (args[0]||'').toLowerCase();
  if (!['all','none'].includes(val)) return reply('❗ Use: readreceipts all | none');
  try { await conn.updatePrivacySettings('readreceipts', val); reply(`✅ Read receipts → *${val}* ${val==='none'?'_(blue ticks hidden)_':'_(blue ticks visible)_'}`); }
  catch (e) { reply(`❌ ${e.message}`); }
});

cast({ pattern: 'groupadd', alias: ['whocanaddme'], desc: 'Set who can add you to groups', use: '<all|contacts|none>', category: 'whatsapp', filename: __filename },
async (conn, mek, m, { isOwner, args, reply }) => {
  if (!isOwner) return reply('⛔ Owner only.');
  const val = (args[0]||'').toLowerCase();
  if (!['all','contacts','contact_blacklist','none'].includes(val)) return reply('❗ Use: groupadd all | contacts | contact_blacklist | none');
  try { await conn.updatePrivacySettings('groupadd', val); reply(`✅ Group add → *${val}*`); }
  catch (e) { reply(`❌ ${e.message}`); }
});

// ─────────────────────────────────────────────────────────────────────────────
// EDITMSG / SLOG / FWD
// ─────────────────────────────────────────────────────────────────────────────

cast({ pattern: 'editmsg', fromMe: true, desc: 'Edit a message the bot sent', category: 'whatsapp', filename: __filename },
async (conn, mek, m, { q, reply }) => {
  try {
    if (!m.quoted?.fromMe) return conn.sendMessage(mek.key.remoteJid, { text: '*Reply to a message sent by the bot!*' }, { quoted: sq() });
    if (!q)                return conn.sendMessage(mek.key.remoteJid, { text: '*Provide the new text!*' }, { quoted: sq() });
    await conn.sendMessage(mek.key.remoteJid, { text: q, edit: m.quoted.fakeObj?.key || m.quoted.key });
  } catch (e) { conn.sendMessage(mek.key.remoteJid, { text: `❌ Error: ${e.message}` }, { quoted: sq() }); }
});

async function _sendByType(conn, to, q) {
  const type = q.type || ''; const caption = q.text || q.caption || '';
  if (type === 'conversation' || type === 'extendedTextMessage') return conn.sendMessage(to, { text: caption });
  const buf = await q.download();
  if (type === 'imageMessage')    return conn.sendMessage(to, { image: buf, caption });
  if (type === 'videoMessage')    return conn.sendMessage(to, { video: buf, caption });
  if (type === 'audioMessage')    return conn.sendMessage(to, { audio: buf, mimetype: 'audio/ogg; codecs=opus', ptt: q.msg?.ptt||false });
  if (type === 'stickerMessage')  return conn.sendMessage(to, { sticker: buf });
  if (type === 'documentMessage') return conn.sendMessage(to, { document: buf, mimetype: q.msg?.mimetype||'application/octet-stream', fileName: q.msg?.fileName||'file' });
  if (['viewOnceMessage','viewOnceMessageV2','viewOnceMessageV2Extension'].includes(type)) {
    const inner = q.msg?.message?.imageMessage || q.msg?.message?.videoMessage || q.msg?.imageMessage || q.msg?.videoMessage || {};
    return conn.sendMessage(to, inner.seconds ? { video: buf, caption: inner.caption||'' } : { image: buf, caption: inner.caption||'' });
  }
  throw new Error(`Unsupported type: ${type||'unknown'}`);
}

cast({ pattern: 'slog', desc: 'Save a message to your own number as a log', category: 'whatsapp', filename: __filename },
async (conn, mek, m, { reply }) => {
  try {
    if (!m.quoted) return conn.sendMessage(mek.key.remoteJid, { text: '*Reply to a message to save it!*' }, { quoted: sq() });
    const botNum = conn.user.id.split(':')[0] + '@s.whatsapp.net';
    await _sendByType(conn, botNum, m.quoted);
    conn.sendMessage(mek.key.remoteJid, { text: '✅ *Message saved to your log!*' }, { quoted: sq() });
  } catch (e) { conn.sendMessage(mek.key.remoteJid, { text: `❌ ${e.message}` }, { quoted: sq() }); }
});

cast({ pattern: 'fwd', desc: 'Forward replied message to your DM', category: 'whatsapp', filename: __filename },
async (conn, mek, m, { reply }) => {
  try {
    if (!m.quoted) return conn.sendMessage(mek.key.remoteJid, { text: '*Reply to a message to forward it.*' }, { quoted: sq() });
    const botNum = conn.user.id.split(':')[0] + '@s.whatsapp.net';
    await _sendByType(conn, botNum, m.quoted);
    conn.sendMessage(mek.key.remoteJid, { text: '✅ *Forwarded to your DM.*' }, { quoted: sq() });
  } catch (e) { conn.sendMessage(mek.key.remoteJid, { text: `❌ Failed: ${e.message}` }, { quoted: sq() }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// JOIN / LEAVE
// ─────────────────────────────────────────────────────────────────────────────

cast({ pattern: 'joingc', desc: 'Join a group by link', category: 'whatsapp', filename: __filename },
async (conn, mek, m, { from, args, q, reply }) => {
  try {
    const groupLink = q || m.quoted?.text || '';
    if (!groupLink) return conn.sendMessage(from, { text: '*Provide a group link!*' }, { quoted: sq() });
    const match = groupLink.match(/https:\/\/chat\.whatsapp\.com\/([\w\d]+)/);
    if (!match)    return conn.sendMessage(from, { text: '*Invalid group link!*' }, { quoted: sq() });
    try {
      await conn.groupAcceptInvite(match[1]);
      conn.sendMessage(from, { text: '✅ *Joined successfully!*' }, { quoted: sq() });
    } catch (err) {
      const msg = err.message || '';
      if (msg.includes('request sent')) return conn.sendMessage(from, { text: '*Request sent to admin. Waiting for approval.*' }, { quoted: sq() });
      if (msg.includes('removed'))      return conn.sendMessage(from, { text: "*Can't join — you were previously removed.*" }, { quoted: sq() });
      conn.sendMessage(from, { text: "*Can't join — an error occurred.*" }, { quoted: sq() });
    }
  } catch (e) { conn.sendMessage(mek.key.remoteJid, { text: "*Can't join — group not found.*" }, { quoted: sq() }); }
});

cast({ pattern: 'left', desc: 'Leave a group (requires confirmation)', category: 'whatsapp', filename: __filename },
async (conn, mek, m, { from, isGroup, q, reply }) => {
  if (!isGroup) return conn.sendMessage(from, { text: '*Groups only!*' }, { quoted: sq() });
  if ((q||'').toLowerCase() === 'yes') {
    await conn.groupLeave(from);
    return conn.sendMessage(from, { text: '*Left... 👋*' }, { quoted: sq() });
  }
  conn.sendMessage(from, { text: "*Are you sure? Type *left yes* to confirm.*" }, { quoted: sq() });
});

// ─────────────────────────────────────────────────────────────────────────────
// STORAGE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const botdb_store = {
  get(key, fallback = {}) { return botdb.kvGetJson(`chat:${key}`, fallback); },
  set(key, data)          { botdb.kvSetJson(`chat:${key}`, data); }
};

let afkData    = botdb_store.get('afk');
let permitData = botdb_store.get('pmpermit');
let userData   = botdb_store.get('permitusers');
let bgmData    = botdb_store.get('bgm');
let bioData    = botdb_store.get('autobio');

function timeDiff(date) {
  const ms = Date.now() - new Date(date).getTime();
  const d = Math.floor(ms/86400000), h = Math.floor((ms%86400000)/3600000), m = Math.floor((ms%3600000)/60000);
  return (d?`${d}d `:'')+`${h}h ${m}m`;
}

async function fillBioTemplate(tmpl) {
  const now = new Date();
  return tmpl.replace(/@time/gi,now.toLocaleTimeString()).replace(/@date/gi,now.toDateString()).replace(/@bot/gi,config.BOT_NAME||'NEXUS-MD').replace(/@owner/gi,config.OWNER_NAME||'Owner');
}

// ─────────────────────────────────────────────────────────────────────────────
// AFK
// ─────────────────────────────────────────────────────────────────────────────

cast({ pattern: 'afk', desc: 'Set yourself as AFK', use: '[reason]', category: 'whatsapp', filename: __filename },
async (conn, mek, m, { from, sender, pushname, q }) => {
  const reason = (q||'No reason given').replace(/@time/gi,new Date().toLocaleTimeString()).replace(/@date/gi,new Date().toDateString());
  if (!afkData[sender]) afkData[sender] = { users: {} };
  afkData[sender].reason = reason; afkData[sender].lastseen = new Date().toISOString(); afkData[sender].users = {};
  botdb_store.set('afk', afkData);
  conn.sendMessage(from, {
    text: `✅ *${pushname} is now AFK*\n*Reason:* ${reason}\n\n_Anyone who mentions or replies to you will be notified._\n_Your AFK is removed automatically when you send a message._`
  }, { quoted: sq() });
});

cast({ pattern: 'unafk', alias: ['back','iamback'], desc: 'Remove your AFK status', category: 'whatsapp', filename: __filename },
async (conn, mek, m, { from, sender, pushname }) => {
  if (!afkData[sender]) return conn.sendMessage(from, { text: '*You are not AFK.*' }, { quoted: sq() });
  const diff = timeDiff(afkData[sender].lastseen);
  delete afkData[sender]; botdb_store.set('afk', afkData);
  conn.sendMessage(from, { text: `✅ *Welcome back ${pushname}!*\n*You were AFK for:* ${diff}` }, { quoted: sq() });
});

async function checkAfkMention(conn, mek, from, sender) {
  try {
    if (mek.key?.fromMe) return;
    const mentioned = mek.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    const replied   = mek.message?.extendedTextMessage?.contextInfo?.participant;
    const targets   = [...new Set([...mentioned, ...(replied?[replied]:[])])];
    for (const jid of targets) {
      if (!afkData[jid] || jid === sender) continue;
      const afk = afkData[jid];
      if (!afk.users) afk.users = {};
      if (!afk.users[sender]) afk.users[sender] = 0;
      afk.users[sender]++;
      if (afk.users[sender] > 3) continue;
      const prefix = afk.users[sender]===2?'*Hey, I already told you!*\n':afk.users[sender]===3?'*Stop spamming!*\n':'';
      await conn.sendMessage(from, { text: `${prefix}*@${jid.split('@')[0]} is AFK*\n*Reason:* ${afk.reason}\n*Last seen:* ${timeDiff(afk.lastseen)} ago`, mentions: [jid] }, { quoted: mek });
      botdb_store.set('afk', afkData);
    }
    if (afkData[sender]) {
      const diff = timeDiff(afkData[sender].lastseen);
      await conn.sendMessage(from, { text: `*Welcome back @${sender.split('@')[0]}!* You were AFK for ${diff}`, mentions: [sender] }, { quoted: mek });
      delete afkData[sender]; botdb_store.set('afk', afkData);
    }
  } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTOBIO
// ─────────────────────────────────────────────────────────────────────────────

let bioJob = null, bioJobBotNumber = null;
try { require('node-cron'); } catch { console.warn('node-cron not installed — autobio cron disabled'); }

cast({ pattern: 'autobio', alias: ['abio'], desc: 'Auto-update WhatsApp bio on a timer', use: '<on|off|template>', category: 'whatsapp', filename: __filename },
async (conn, mek, m, { botNumber, isOwner, q }) => {
  if (!isOwner) return conn.sendMessage(mek.key.remoteJid, { text: '🚫 Owner only.' }, { quoted: sq() });
  const cur = bioData[botNumber] || 'false';
  if (!q) return conn.sendMessage(mek.key.remoteJid, {
    text: `*AutoBio:* ${cur==='false'?'OFF ❌':`ON ✅\n*Template:* ${cur}`}\n\nautobio on  → default\nautobio off → disable\nautobio @time — @bot is alive → custom\n\n*Tags:* @time @date @bot @owner`
  }, { quoted: sq() });
  const arg = q.toLowerCase().trim();
  if (['off','disable','deact'].includes(arg)) {
    if (bioJob) { try{bioJob.stop();}catch{} bioJob=null; }
    bioData[botNumber]='false'; botdb_store.set('autobio',bioData);
    return conn.sendMessage(mek.key.remoteJid, { text: '✅ *AutoBio disabled*' }, { quoted: sq() });
  }
  const template = (arg==='on'||arg==='true') ? 'Auto Bio | ⏰ @time | 🤖 @bot' : q;
  bioData[botNumber]=template; botdb_store.set('autobio',bioData);
  const preview = await fillBioTemplate(template);
  try { await conn.updateProfileStatus(preview); } catch {}
  try {
    const cron = require('node-cron');
    if (bioJob) { try{bioJob.stop();}catch{} }
    bioJobBotNumber=botNumber;
    bioJob=cron.schedule('*/2 * * * *', async()=>{
      try { const tmpl=bioData[bioJobBotNumber]; if(!tmpl||tmpl==='false'){bioJob.stop();return;} await conn.updateProfileStatus(await fillBioTemplate(tmpl)); } catch{}
    },{scheduled:true});
    conn.sendMessage(mek.key.remoteJid, { text: `✅ *AutoBio enabled*\n*Template:* ${template}\n*Preview:* ${preview}\n\n_Updates every 2 minutes_` }, { quoted: sq() });
  } catch {
    conn.sendMessage(mek.key.remoteJid, { text: `✅ *AutoBio saved*\n*Preview:* ${preview}` }, { quoted: sq() });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PMPERMIT
// ─────────────────────────────────────────────────────────────────────────────

cast({ pattern: 'pmpermit', alias: ['permit'], desc: 'Enable/disable PM permit', use: '<on|off>', category: 'whatsapp', filename: __filename },
async (conn, mek, m, { botNumber, isOwner, q }) => {
  if (!isOwner) return conn.sendMessage(mek.key.remoteJid, { text: '🚫 Owner only.' }, { quoted: sq() });
  const s=permitData[botNumber]||{enabled:false,values:'all'}, arg=q?q.toLowerCase().trim():'';
  if (!arg) return conn.sendMessage(mek.key.remoteJid, {
    text: `*PM Permit:* ${s.enabled?`ON ✅ (${s.values})`:'OFF ❌'}\n\npmpermit on — block all\npmpermit on | 234,27 — by country code\npmpermit off — disable`
  }, { quoted: sq() });
  const action=arg.split('|')[0].trim(), codes=(arg.split('|')[1]||'').trim();
  const values=codes.startsWith('all')||!codes?'all':codes.split(',').map(c=>parseInt(c)).filter(n=>!isNaN(n)).join(',')||'all';
  if (['on','enable','act'].includes(action)) {
    permitData[botNumber]={enabled:true,values}; botdb_store.set('pmpermit',permitData);
    return conn.sendMessage(mek.key.remoteJid, { text: `✅ *PM Permit ON* — blocking ${values==='all'?'everyone':`country codes: ${values}`}` }, { quoted: sq() });
  }
  if (['off','disable','deact'].includes(action)) {
    permitData[botNumber]={enabled:false,values:s.values}; botdb_store.set('pmpermit',permitData);
    return conn.sendMessage(mek.key.remoteJid, { text: '✅ *PM Permit OFF*' }, { quoted: sq() });
  }
  conn.sendMessage(mek.key.remoteJid, { text: '*Use: on / on | all / on | 234,27 / off*' }, { quoted: sq() });
});

cast({ pattern: 'approve', alias: ['a'], desc: 'Approve a user to DM the bot', category: 'whatsapp', filename: __filename },
async (conn, mek, m, { isOwner }) => {
  if (!isOwner) return conn.sendMessage(mek.key.remoteJid, { text: '🚫 Owner only.' }, { quoted: sq() });
  const ctx=mek.message?.extendedTextMessage?.contextInfo;
  if (!ctx?.quotedMessage) return conn.sendMessage(mek.key.remoteJid, { text: '*Reply to a message from the user to approve.*' }, { quoted: sq() });
  const target=ctx.participant||ctx.remoteJid;
  if (!target) return conn.sendMessage(mek.key.remoteJid, { text: '*Could not determine user.*' }, { quoted: sq() });
  if (!userData[target]) userData[target]={permit:'false',times:0};
  if (userData[target].permit==='true') return conn.sendMessage(mek.key.remoteJid, { text: '*Already approved.*' }, { quoted: sq() });
  userData[target].permit='true'; userData[target].times=0; botdb_store.set('permitusers',userData);
  conn.sendMessage(mek.key.remoteJid, { text: `✅ *Approved @${target.split('@')[0]} for DMs.*` }, { quoted: sq() });
});

cast({ pattern: 'disapprove', alias: ['da','unapprove'], desc: 'Revoke DM permission', category: 'whatsapp', filename: __filename },
async (conn, mek, m, { isOwner }) => {
  if (!isOwner) return conn.sendMessage(mek.key.remoteJid, { text: '🚫 Owner only.' }, { quoted: sq() });
  const ctx=mek.message?.extendedTextMessage?.contextInfo;
  if (!ctx?.quotedMessage) return conn.sendMessage(mek.key.remoteJid, { text: '*Reply to a message from the user to disapprove.*' }, { quoted: sq() });
  const target=ctx.participant||ctx.remoteJid;
  if (!target) return conn.sendMessage(mek.key.remoteJid, { text: '*Could not determine user.*' }, { quoted: sq() });
  if (!userData[target]) userData[target]={permit:'false',times:0};
  userData[target].permit='false'; botdb_store.set('permitusers',userData);
  conn.sendMessage(mek.key.remoteJid, { text: `✅ *Revoked DM permission for @${target.split('@')[0]}.*` }, { quoted: sq() });
});

async function checkPmPermit(conn, mek, from, sender, isGroup, isOwner, botNumber) {
  try {
    if (isGroup||isOwner||mek.key?.fromMe) return false;
    const s=permitData[botNumber]; if (!s||!s.enabled) return false;
    const senderNum=sender.split('@')[0];
    const shouldCheck=s.values==='all'||s.values.split(',').some(c=>senderNum.startsWith(c.trim()));
    if (!shouldCheck) return false;
    if (!userData[sender]) userData[sender]={permit:'false',times:0};
    if (userData[sender].permit==='true') return false;
    if (userData[sender].permit==='blocked') return true;
    const times=parseInt(userData[sender].times)||0;
    let msg = times===0
      ? `*Hi! This is ${config.BOT_NAME||'NEXUS-MD'}, a Personal Assistant.*\n\n*Please do not DM. You may be blocked automatically.*\n_Wait for the owner to respond._`
      : `*Please do not spam. You have ${times+1} warning(s).*${times===1?'\n*You will be blocked automatically.*':''}`;
    userData[sender].times=times+1; botdb_store.set('permitusers',userData);
    await conn.sendMessage(from,{text:msg},{quoted:mek});
    if (userData[sender].times>=3) {
      const jid=senderNum.replace(/\D/g,'')+'@s.whatsapp.net';
      try {
        await conn.updateBlockStatus(jid,'block');
        await conn.sendMessage(from,{text:'🚫 *You have been blocked for spamming.*'});
        userData[sender].permit='blocked';
      } catch { userData[sender].times=3; }
      botdb_store.set('permitusers',userData);
    }
    return true;
  } catch { return false; }
}

// ─────────────────────────────────────────────────────────────────────────────
// BGM
// ─────────────────────────────────────────────────────────────────────────────

cast({ pattern: 'bgm', desc: 'Enable/disable BGM sound triggers', use: '<on|off>', category: 'whatsapp', filename: __filename },
async (conn, mek, m, { botNumber, isOwner, q }) => {
  if (!isOwner) return conn.sendMessage(mek.key.remoteJid, { text: '🚫 Owner only.' }, { quoted: sq() });
  if (!bgmData[botNumber]) bgmData[botNumber]={enabled:false,songs:{}};
  const cur=bgmData[botNumber].enabled, arg=(q||'').toLowerCase().trim();
  if (!arg) return conn.sendMessage(mek.key.remoteJid, { text: `*BGM:* ${cur?'ON ✅':'OFF ❌'}\nUse bgm on / bgm off` }, { quoted: sq() });
  if (['on','enable','act'].includes(arg))  { bgmData[botNumber].enabled=true;  botdb_store.set('bgm',bgmData); return conn.sendMessage(mek.key.remoteJid,{text:'✅ *BGM enabled*'},{quoted:sq()}); }
  if (['off','disable','deact'].includes(arg)) { bgmData[botNumber].enabled=false; botdb_store.set('bgm',bgmData); return conn.sendMessage(mek.key.remoteJid,{text:'✅ *BGM disabled*'},{quoted:sq()}); }
  conn.sendMessage(mek.key.remoteJid,{text:'*Use: on / off*'},{quoted:sq()});
});

cast({ pattern: 'addbgm', alias: ['abgm','newbgm'], desc: 'Add an audio URL as a BGM trigger', use: '<songname> (reply to audio)', category: 'whatsapp', filename: __filename },
async (conn, mek, m, { botNumber, isOwner, q }) => {
  if (!isOwner) return conn.sendMessage(mek.key.remoteJid,{text:'🚫 Owner only.'},{quoted:sq()});
  if (!q)       return conn.sendMessage(mek.key.remoteJid,{text:'*Provide a song name.*\nExample: addbgm kylie (reply to audio)'},{quoted:sq()});
  const ctx=mek.message?.extendedTextMessage?.contextInfo;
  if (!ctx?.quotedMessage?.audioMessage) return conn.sendMessage(mek.key.remoteJid,{text:'*Reply to an audio message!*'},{quoted:sq()});
  const FormData=require('form-data'), axios=require('axios');
  try {
    await conn.sendMessage(mek.key.remoteJid,{text:'_Uploading audio..._'},{quoted:sq()});
    const target={key:{remoteJid:mek.key.remoteJid,id:ctx.stanzaId,participant:ctx.participant},message:ctx.quotedMessage};
    const buf=await downloadMediaMessage(target,'buffer',{},{logger:undefined,reuploadRequest:conn.updateMediaMessage});
    const form=new FormData();
    form.append('reqtype','fileupload'); form.append('userhash',''); form.append('fileToUpload',buf,{filename:q+'.mp3'});
    const res=await axios.post('https://catbox.moe/user/api.php',form,{headers:form.getHeaders(),timeout:60000});
    const url=res.data?.trim();
    if (!url?.startsWith('https')) throw new Error('Upload failed');
    if (!bgmData[botNumber]) bgmData[botNumber]={enabled:false,songs:{}};
    bgmData[botNumber].songs[q.toLowerCase()]=url; botdb_store.set('bgm',bgmData);
    conn.sendMessage(mek.key.remoteJid,{text:`✅ *BGM song added: ${q}*`},{quoted:sq()});
  } catch (e) { conn.sendMessage(mek.key.remoteJid,{text:'❌ Failed: '+e.message},{quoted:sq()}); }
});

cast({ pattern: 'delbgm', desc: 'Remove a BGM song by name', use: '<songname>', category: 'whatsapp', filename: __filename },
async (conn, mek, m, { botNumber, isOwner, q }) => {
  if (!isOwner) return conn.sendMessage(mek.key.remoteJid,{text:'🚫 Owner only.'},{quoted:sq()});
  if (!q)       return conn.sendMessage(mek.key.remoteJid,{text:'*Provide the song name to delete.*'},{quoted:sq()});
  if (!bgmData[botNumber]?.songs?.[q.toLowerCase()]) return conn.sendMessage(mek.key.remoteJid,{text:`*No song named "${q}" found.*`},{quoted:sq()});
  delete bgmData[botNumber].songs[q.toLowerCase()]; botdb_store.set('bgm',bgmData);
  conn.sendMessage(mek.key.remoteJid,{text:`✅ *Removed BGM: ${q}*`},{quoted:sq()});
});

cast({ pattern: 'allbgm', alias: ['listbgm','getbgm'], desc: 'List all BGM songs', category: 'whatsapp', filename: __filename },
async (conn, mek, m, { botNumber }) => {
  const songs=bgmData[botNumber]?.songs||{}, keys=Object.keys(songs);
  if (!keys.length) return conn.sendMessage(mek.key.remoteJid,{text:'*No BGM songs yet.*\nUse addbgm to add one.'},{quoted:sq()});
  conn.sendMessage(mek.key.remoteJid,{text:`*BGM Songs (${keys.length}):*\n\n`+keys.map((k,i)=>`${i+1}. ${k}`).join('\n')},{quoted:sq()});
});

async function checkBgm(conn, mek, body, from, botNumber) {
  try {
    if (mek.key?.fromMe||!body) return;
    const d=bgmData[botNumber]; if (!d?.enabled||!d.songs) return;
    const lower=' '+body.toLowerCase()+' ';
    for (const [name,url] of Object.entries(d.songs)) {
      if (lower.includes(name+' ')||lower.includes(' '+name)) {
        await conn.sendMessage(from,{audio:{url},mimetype:'audio/mpeg',ptt:true},{quoted:mek}); break;
      }
    }
  } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// BLOCK / UNBLOCK
// ─────────────────────────────────────────────────────────────────────────────

async function resolveTarget(conn, mek, m, body) {
  const ctx=mek.message?.extendedTextMessage?.contextInfo;
  let target = m.quoted?.sender || ctx?.participant ||
    (ctx?.remoteJid&&!ctx.remoteJid.endsWith('@g.us')?ctx.remoteJid:null) ||
    m.mentionedJid?.[0] || ctx?.mentionedJid?.[0] || null;
  if (!target) { const raw=(body||'').split(' ').slice(1).join('').replace(/\D/g,'').trim(); if (raw) target=raw+'@s.whatsapp.net'; }
  if (!target) return null;
  let num = target.endsWith('@lid') ? await lidToPhone(conn,target) : (target.includes(':')?target.split(':')[0]:target.split('@')[0]);
  return num.replace(/\D/g,'');
}

// Resolve a raw JID (including @lid) to a proper @s.whatsapp.net JID for block/unblock
async function resolveToBlockableJid(conn, raw) {
  if (!raw) return null;
  // Already a proper JID
  if (raw.endsWith('@s.whatsapp.net')) return raw;
  // LID format — resolve to phone number first
  if (raw.endsWith('@lid')) {
    const phone = await lidToPhone(conn, raw);
    if (phone && /^\d+$/.test(phone)) return phone + '@s.whatsapp.net';
    return null; // couldn't resolve
  }
  // Plain number or number@g.us participant — strip to digits
  const digits = raw.split('@')[0].split(':')[0].replace(/\D/g,'');
  if (digits.length >= 7) return digits + '@s.whatsapp.net';
  return null;
}

// Resolve any JID format to @s.whatsapp.net for block
async function toBlockJid(conn, raw) {
  if (!raw) return null;
  if (raw.endsWith('@s.whatsapp.net')) return raw;
  if (raw.endsWith('@lid')) {
    try {
      const phone = await lidToPhone(conn, raw);
      if (phone && phone.length >= 7) return phone.replace(/\D/g,'') + '@s.whatsapp.net';
    } catch {}
  }
  // strip device suffix e.g. 234xxx:5@s.whatsapp.net
  const digits = raw.split('@')[0].split(':')[0].replace(/\D/g,'');
  if (digits.length >= 7) return digits + '@s.whatsapp.net';
  return null;
}

cast({ pattern: 'block', alias: ['blockuser','blk'], desc: 'Block a user — reply or mention', category: 'whatsapp', filename: __filename },
async (conn, mek, m, { from, isGroup, isOwner, isAdmins }) => {
  if (!isOwner && !isAdmins) return conn.sendMessage(from, { text: '⛔ Admins only.' }, { quoted: sq() });

  // Get raw JID from reply or mention
  const ctx = mek.message?.extendedTextMessage?.contextInfo;
  const raw = m.quoted?.sender
    || ctx?.participant
    || (ctx?.mentionedJid?.[0])
    || (!isGroup ? from : null);

  if (!raw) return conn.sendMessage(from, { text: '❌ Reply to or mention the user you want to block.' }, { quoted: sq() });

  const jid = await toBlockJid(conn, raw);
  if (!jid) return conn.sendMessage(from, { text: `❌ Could not resolve JID: ${raw}` }, { quoted: sq() });

  const num = jid.split('@')[0];
  try {
    await conn.updateBlockStatus(jid, 'block');
    conn.sendMessage(from, { text: `✅ @${num} has been blocked.`, mentions: [jid] }, { quoted: sq() });
  } catch (e) {
    conn.sendMessage(from, { text: `❌ Block failed: ${e.message}\nJID: ${jid}` }, { quoted: sq() });
  }
});

cast({ pattern: 'unblock', alias: ['unblockuser','ublk'], desc: 'Unblock a user — reply or mention', category: 'whatsapp', filename: __filename },
async (conn, mek, m, { from, isGroup, isOwner, isAdmins }) => {
  if (!isOwner && !isAdmins) return conn.sendMessage(from, { text: '⛔ Admins only.' }, { quoted: sq() });

  const ctx = mek.message?.extendedTextMessage?.contextInfo;
  const raw = m.quoted?.sender
    || ctx?.participant
    || (ctx?.mentionedJid?.[0])
    || (!isGroup ? from : null);

  if (!raw) return conn.sendMessage(from, { text: '❌ Reply to or mention the user you want to unblock.' }, { quoted: sq() });

  const jid = await toBlockJid(conn, raw);
  if (!jid) return conn.sendMessage(from, { text: `❌ Could not resolve JID: ${raw}` }, { quoted: sq() });

  const num = jid.split('@')[0];
  try {
    await conn.updateBlockStatus(jid, 'unblock');
    conn.sendMessage(from, { text: `✅ @${num} has been unblocked.`, mentions: [jid] }, { quoted: sq() });
  } catch (e) {
    conn.sendMessage(from, { text: `❌ Unblock failed: ${e.message}\nJID: ${jid}` }, { quoted: sq() });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// LOGOUT
// ─────────────────────────────────────────────────────────────────────────────

cast({ pattern: 'logout', desc: 'Log out the bot from WhatsApp', category: 'whatsapp', filename: __filename },
async (conn, mek, m, { isOwner }) => {
  if (!isOwner) return conn.sendMessage(mek.key.remoteJid,{text:'🚫 Owner only.'},{quoted:sq()});
  await conn.sendMessage(mek.key.remoteJid,{text:'*Logging out... Bye! 👋*'},{quoted:sq()});
  try { await conn.logout(); } catch (e) { console.error('logout error:',e.message); }
});

// ─────────────────────────────────────────────────────────────────────────────
// SETSTICKER
// ─────────────────────────────────────────────────────────────────────────────

cast({ pattern: 'setsticker', alias: ['stickercommand','stickertrigger'], desc: 'Set a sticker as a command trigger', category: 'owner', filename: __filename },
async (conn, mek, m, { from, q, botNumber, isOwner }) => {
  if (!isOwner) return conn.sendMessage(from,{text:'⛔ Owner only.'},{quoted:sq()});
  if ((q||'').toLowerCase()==='clear'||(q||'').toLowerCase()==='off') {
    botdb.clearStickerTrigger(botNumber);
    return conn.sendMessage(from,{text:'✅ Sticker trigger cleared.'},{quoted:sq()});
  }
  if (!q&&!m.quoted) {
    const cur=botdb.getStickerTrigger(botNumber);
    if (!cur) return conn.sendMessage(from,{text:'📭 No sticker trigger set.\n\nUsage: Reply to a sticker + setsticker <command>\nExample: setsticker alive\n\nTo clear: setsticker clear'},{quoted:sq()});
    return conn.sendMessage(from,{text:`Current trigger runs: *${cur.command}*\n\nTo change: reply to a sticker + setsticker <command>\nTo clear: setsticker clear`},{quoted:sq()});
  }
  if (!m.quoted) return conn.sendMessage(from,{text:'❗ Reply to a sticker first, then type: setsticker <command>'},{quoted:sq()});
  const qType=m.quoted?.type;
  const isSticker=qType==='stickerMessage'||!!m.quoted?.stickerMessage||!!(m.quoted?.message?.stickerMessage);
  if (!isSticker) return conn.sendMessage(from,{text:`❗ That's not a sticker. Detected type: *${qType||'unknown'}*`},{quoted:sq()});
  const command=(q||'').trim().replace(/^[:.!\/]/,'').toLowerCase();
  if (!command) return conn.sendMessage(from,{text:'❗ Provide the command name.\nExample: setsticker alive'},{quoted:sq()});
  const stickerData=(qType==='stickerMessage'?m.quoted.msg:null)||m.quoted?.stickerMessage||m.quoted?.message?.stickerMessage||{};
  function toHex(val) {
    if (!val) return null;
    if (typeof val==='string') return /^[0-9a-f]{16,}$/i.test(val)?val.toLowerCase():Buffer.from(val,'latin1').toString('hex');
    return Buffer.from(val).toString('hex');
  }
  const fileSha256=toHex(stickerData.fileSha256), fileEncSha256=toHex(stickerData.fileEncSha256), directPath=stickerData.directPath||null;
  if (!fileSha256&&!fileEncSha256&&!directPath) return conn.sendMessage(from,{text:'❌ Could not fingerprint that sticker. Try a different one.'},{quoted:sq()});
  botdb.setStickerTrigger(botNumber,{command,fileSha256,fileEncSha256,directPath,setAt:Date.now()});
  conn.sendMessage(from,{text:`✅ *Sticker trigger set!*\n\nSend that sticker and the bot will run *${command}*.\n\nTo clear: setsticker clear`},{quoted:sq()});
});

module.exports = { checkAfkMention, checkBgm, checkPmPermit };
