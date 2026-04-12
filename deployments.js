// plugins/deployments.js — NEXUS-MD
// Tracks all bot instances via central registry on repo-jjl7.onrender.com
'use strict';

const { cast, makeSmartQuote } = require('../cast');
const config = require('../config');
const axios  = require('axios');

function sq() { return makeSmartQuote(); }

const REGISTRY   = 'https://repo-jjl7.onrender.com';
const OWNER_NUM  = '2348084644182';

function detectPlatform() {
  if (process.env.DYNO)                  return 'Heroku';
  if (process.env.RENDER)                return 'Render';
  if (process.env.RAILWAY_STATIC_URL)    return 'Railway';
  if (process.env.KOYEB_APP_NAME)        return 'Koyeb';
  if (process.env.SPACE_ID)             return 'HuggingFace';
  if (process.env.P_SERVER_UUID || process.env.SERVER_MEMORY) return 'Pterodactyl';
  if (process.env.DOCKER_ENV)            return 'Docker';
  return 'VPS/Local';
}

function formatUptime(sec) {
  const d = Math.floor(sec/86400), h = Math.floor((sec%86400)/3600), m = Math.floor((sec%3600)/60);
  return (d?`${d}d `:'')+(h?`${h}h `:'')+ `${m}m`;
}

function isOnline(lastSeen) {
  return Date.now() - new Date(lastSeen).getTime() < 6 * 60 * 1000;
}

async function pingRegistry(conn) {
  try {
    const botNumber = conn.user?.id?.split(':')[0];
    if (!botNumber) return;
    await axios.post(`${REGISTRY}/registry/ping`, {
      botNumber,
      botName:     config.BOT_NAME || 'NEXUS-MD',
      version:     (() => { try { return require('../data/version.json').version; } catch { return '?'; } })(),
      platform:    detectPlatform(),
      ownerNumber: OWNER_NUM,
      uptime:      Math.round(process.uptime()),
      memory:      Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    }, { timeout: 8000 });
  } catch {}
}

function registerDeployment(conn) {
  pingRegistry(conn);
  setInterval(() => pingRegistry(conn), 3 * 60 * 1000);
}

cast({
  pattern:  'deployments',
  alias:    ['instances', 'bots', 'botinstances'],
  desc:     'Show all active NEXUS-MD deployments across all servers',
  category: 'owner',
  filename: __filename,
}, async (conn, mek, m, { from, isOwner }) => {
  if (!isOwner) return conn.sendMessage(from, { text: '⛔ Owner only.' }, { quoted: sq() });

  await conn.sendMessage(from, { text: '⏳ Fetching deployments...' }, { quoted: sq() });

  try {
    const res  = await axios.get(`${REGISTRY}/registry/all?key=${OWNER_NUM}`, { timeout: 10000 });
    const list = res.data;

    if (!list?.length) return conn.sendMessage(from, {
      text: '📭 No deployments registered yet.\n\n_Bots register automatically on startup once you add the deployments plugin._'
    }, { quoted: sq() });

    const online  = list.filter(d => isOnline(d.lastSeen));
    const offline = list.filter(d => !isOnline(d.lastSeen));

    let text = `📡 *NEXUS-MD Deployments*\n`;
    text += `Total: *${list.length}* | 🟢 *${online.length}* online | 🔴 *${offline.length}* offline\n`;
    text += `──────────────────────\n\n`;

    for (const [i, d] of list.entries()) {
      const status = isOnline(d.lastSeen) ? '🟢' : '🔴';
      const seen   = new Date(d.lastSeen).toLocaleTimeString('en-US', { hour12:false, hour:'2-digit', minute:'2-digit' });
      text += `${status} *${i+1}. ${d.botName}*\n`;
      text += `Number  : +${d.botNumber}\n`;
      text += `Platform: ${d.platform}\n`;
      text += `Version : v${d.version}\n`;
      text += `Uptime  : ${formatUptime(d.uptime||0)}\n`;
      text += `RAM     : ${d.memory} MB\n`;
      text += `Last seen: ${seen}\n`;
      if (i < list.length-1) text += `\n`;
    }

    conn.sendMessage(from, { text }, { quoted: sq() });
  } catch (e) {
    conn.sendMessage(from, { text: `❌ Registry unreachable: ${e.message}` }, { quoted: sq() });
  }
});

cast({
  pattern:  'removedeployment',
  alias:    ['unregisterbot'],
  desc:     'Remove a stale deployment from the registry',
  use:      '<bot number>',
  category: 'owner',
  filename: __filename,
}, async (conn, mek, m, { from, isOwner, args }) => {
  if (!isOwner) return conn.sendMessage(from, { text: '⛔ Owner only.' }, { quoted: sq() });
  const num = (args[0]||'').replace(/\D/g,'');
  if (!num) return conn.sendMessage(from, { text: '❗ Provide the bot number.\nExample: removedeployment 2348012345678' }, { quoted: sq() });
  try {
    await axios.delete(`${REGISTRY}/registry/${num}?key=${OWNER_NUM}`, { timeout: 8000 });
    conn.sendMessage(from, { text: `✅ Deployment *+${num}* removed.` }, { quoted: sq() });
  } catch (e) {
    conn.sendMessage(from, { text: `❌ Failed: ${e.message}` }, { quoted: sq() });
  }
});

module.exports = { registerDeployment };
