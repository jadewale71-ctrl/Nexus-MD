// plugins/pluginmanager.js — NEXUS-MD
// Download plugins from GitHub/URL, install them permanently, delete at will
'use strict';

const { cast, makeSmartQuote } = require('../cast');
const { commands }              = require('../cast');
const axios  = require('axios');
const fs     = require('fs');
const path   = require('path');

const PLUGINS_DIR  = path.resolve(process.cwd(), 'plugins');
const REGISTRY_KEY = 'pm:installed'; // stored in botdb key_value
let botdb;
try { botdb = require('../lib/botdb'); } catch {}

// ── Persistence helpers ───────────────────────────────────────────────────────
// Registry: { [pluginName]: { url, installedAt, hasHooks } }

function loadRegistry() {
  try { return botdb ? (botdb.kvGetJson(REGISTRY_KEY, {}) || {}) : {}; } catch { return {}; }
}
function saveRegistry(reg) {
  try { if (botdb) botdb.kvSetJson(REGISTRY_KEY, reg); } catch {}
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Detect if a plugin exports hook functions (i.e., has module.exports with functions)
// This is a heuristic based on source code patterns
function detectHooks(source) {
  return (
    /module\.exports\s*=/.test(source) &&
    (/register[A-Z]/.test(source) || /handle[A-Z]/.test(source) || /setup[A-Z]/.test(source))
  );
}

// Convert GitHub blob URL to raw URL
function toRawUrl(url) {
  // https://github.com/user/repo/blob/branch/path -> raw.githubusercontent.com
  return url
    .replace('https://github.com/', 'https://raw.githubusercontent.com/')
    .replace('/blob/', '/');
}

// Safely derive a filename from a URL or explicit name
function deriveFilename(url, nameOverride) {
  if (nameOverride) {
    const clean = nameOverride.replace(/[^a-zA-Z0-9_-]/g, '').replace(/\.js$/i, '');
    return clean + '.js';
  }
  try {
    const base = new URL(url).pathname.split('/').pop();
    if (base && base.endsWith('.js')) return base;
  } catch {}
  return `plugin_${Date.now()}.js`;
}

// Remove commands registered from a specific file path
function unregisterCommands(filePath) {
  let removed = 0;
  for (let i = commands.length - 1; i >= 0; i--) {
    if (commands[i].filename === filePath) {
      commands.splice(i, 1);
      removed++;
    }
  }
  return removed;
}

// ── plugininstall ─────────────────────────────────────────────────────────────
cast({
  pattern:  'plugininstall',
  alias:    ['installplugin', 'pinstall', 'dlplugin'],
  desc:     'Download & install a plugin from a URL or GitHub. Usage: plugininstall <url> [name]',
  category: 'owner',
  react:    '📥',
  filename: __filename,
}, async (conn, mek, m, { from, isOwner, args, q, reply }) => {
  if (!isOwner) return reply('❌ Owner only.');
  if (!q) return reply(
    `📥 *Plugin Installer*\n\n` +
    `*Usage:*\n` +
    `plugininstall <url>\n` +
    `plugininstall <url> <name>\n\n` +
    `*Examples:*\n` +
    `plugininstall https://raw.githubusercontent.com/user/repo/main/plugins/myplugin.js\n` +
    `plugininstall https://github.com/user/repo/blob/main/plugins/myplugin.js\n` +
    `plugininstall https://example.com/myplugin.js customplugin\n\n` +
    `_Supports raw URLs and GitHub blob links._`
  );

  // Parse args: first token is URL, optional second is name override
  const parts = q.trim().split(/\s+/);
  const rawUrl = parts[0];
  const nameOverride = parts[1] || null;

  const fetchUrl = toRawUrl(rawUrl);
  const fileName = deriveFilename(fetchUrl, nameOverride);
  const filePath = path.join(PLUGINS_DIR, fileName);
  const pluginName = fileName.replace(/\.js$/i, '');

  // Check for overwrite
  const reg = loadRegistry();
  if (fs.existsSync(filePath)) {
    const existing = reg[pluginName];
    return reply(
      `⚠️ *${fileName} already exists.*\n\n` +
      (existing ? `Installed from: ${existing.url}\nInstalled: ${new Date(existing.installedAt).toLocaleString()}\n\n` : '') +
      `Use *pluginupdate ${pluginName}* to update it, or *plugindelete ${pluginName}* to remove it first.`
    );
  }

  await conn.sendMessage(from, {
    text: `⏳ Downloading *${fileName}*...`
  }, { quoted: mek });

  // Download
  let source;
  try {
    const res = await axios.get(fetchUrl, {
      timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/plain,application/javascript' },
      responseType: 'text'
    });
    source = res.data;
  } catch (e) {
    return reply(`❌ Download failed: ${e.message}\nURL tried: ${fetchUrl}`);
  }

  if (!source || typeof source !== 'string' || source.trim().length < 10) {
    return reply('❌ Downloaded file appears empty or invalid.');
  }

  // Detect hooks
  const hasHooks = detectHooks(source);

  // Write to plugins dir
  try {
    fs.writeFileSync(filePath, source, 'utf8');
  } catch (e) {
    return reply(`❌ Could not save file: ${e.message}`);
  }

  // Load it
  const before = commands.length;
  let loadError = null;
  try {
    delete require.cache[filePath];
    require(filePath);
  } catch (e) {
    loadError = e;
    // Remove the file if it failed to load
    try { fs.unlinkSync(filePath); } catch {}
    return reply(
      `❌ *Plugin downloaded but failed to load!*\n\n` +
      `💥 *Error:* ${e.message}\n\n` +
      `\`\`\`${(e.stack || '').split('\n').slice(0, 5).join('\n')}\`\`\`\n\n` +
      `_File removed. Fix the plugin and try again._`
    );
  }

  const added = commands.length - before;
  const newCmds = commands.slice(before).filter(c => typeof c.pattern === 'string').map(c => c.pattern);

  // Save to registry
  reg[pluginName] = {
    url:         rawUrl,
    fileName,
    filePath,
    hasHooks,
    installedAt: Date.now(),
    commands:    newCmds,
  };
  saveRegistry(reg);

  await conn.sendMessage(from, {
    text:
      `✅ *Plugin Installed!*\n\n` +
      `📦 *Name:* ${pluginName}\n` +
      `📋 *Commands added:* ${added}\n` +
      `🔧 *Commands:* ${newCmds.join(', ') || '(internal only)'}\n` +
      `🔗 *Source:* ${rawUrl}\n` +
      (hasHooks
        ? `\n⚠️ *Note:* This plugin exports hook functions (register*/handle*/setup*).\n` +
          `Commands are live now, but exported hooks need a *restart* to take effect.`
        : `\n✨ Fully live — no restart needed!`) +
      `\n\n_Use *plugindelete ${pluginName}* to remove it._`
  }, { quoted: mek });
});

// ── pluginupdate ──────────────────────────────────────────────────────────────
cast({
  pattern:  'pluginupdate',
  alias:    ['updateplugin', 'pupdate'],
  desc:     'Re-download and hot-reload an installed plugin from its original URL',
  category: 'owner',
  react:    '🔄',
  filename: __filename,
}, async (conn, mek, m, { from, isOwner, q, reply }) => {
  if (!isOwner) return reply('❌ Owner only.');
  if (!q) return reply('❗ Usage: pluginupdate <name>');

  const reg = loadRegistry();
  const pluginName = q.trim().replace(/\.js$/i, '');
  const entry = reg[pluginName];

  if (!entry) return reply(
    `❌ *${pluginName}* not found in installed plugins.\nUse *pluginlist* to see installed plugins.`
  );

  const fetchUrl = toRawUrl(entry.url);

  await conn.sendMessage(from, { text: `⏳ Updating *${pluginName}*...` }, { quoted: mek });

  let source;
  try {
    const res = await axios.get(fetchUrl, {
      timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
      responseType: 'text'
    });
    source = res.data;
  } catch (e) {
    return reply(`❌ Download failed: ${e.message}`);
  }

  const filePath = entry.filePath || path.join(PLUGINS_DIR, entry.fileName);

  // Unregister old commands
  const removedCount = unregisterCommands(filePath);
  delete require.cache[filePath];

  // Write new source
  try { fs.writeFileSync(filePath, source, 'utf8'); }
  catch (e) { return reply(`❌ Could not write file: ${e.message}`); }

  // Re-load
  const before = commands.length;
  try {
    require(filePath);
  } catch (e) {
    return reply(
      `❌ *Updated file failed to load!*\n💥 ${e.message}\n\n` +
      `_Old commands were removed. Fix the plugin or reinstall._`
    );
  }

  const added = commands.length - before;
  const newCmds = commands.slice(before).filter(c => typeof c.pattern === 'string').map(c => c.pattern);
  const hasHooks = detectHooks(source);

  // Update registry
  reg[pluginName] = { ...entry, hasHooks, commands: newCmds, updatedAt: Date.now() };
  saveRegistry(reg);

  await conn.sendMessage(from, {
    text:
      `🔄 *Plugin Updated!*\n\n` +
      `📦 *Name:* ${pluginName}\n` +
      `🗑️ *Old commands removed:* ${removedCount}\n` +
      `📋 *New commands added:* ${added}\n` +
      `🔧 *Commands:* ${newCmds.join(', ') || '(internal only)'}` +
      (hasHooks ? `\n\n⚠️ Exported hooks need a *restart* to fully update.` : '\n\n✨ Fully live!')
  }, { quoted: mek });
});

// ── plugindelete ──────────────────────────────────────────────────────────────
cast({
  pattern:  'plugindelete',
  alias:    ['deleteplugin', 'pdelete', 'rmplugin'],
  desc:     'Delete an installed plugin and unregister its commands',
  category: 'owner',
  react:    '🗑️',
  filename: __filename,
}, async (conn, mek, m, { from, isOwner, q, reply }) => {
  if (!isOwner) return reply('❌ Owner only.');
  if (!q) return reply('❗ Usage: plugindelete <name>');

  const reg = loadRegistry();
  const pluginName = q.trim().replace(/\.js$/i, '');
  const entry = reg[pluginName];
  const filePath = entry?.filePath || path.join(PLUGINS_DIR, pluginName + '.js');

  if (!entry && !fs.existsSync(filePath)) {
    return reply(`❌ Plugin *${pluginName}* not found in registry or filesystem.`);
  }

  // Unregister commands
  const removed = unregisterCommands(filePath);

  // Clear require cache
  try { delete require.cache[require.resolve(filePath)]; } catch {}
  try { delete require.cache[filePath]; } catch {}

  // Delete file
  let fileDeleted = false;
  try {
    if (fs.existsSync(filePath)) { fs.unlinkSync(filePath); fileDeleted = true; }
  } catch (e) {
    return reply(`❌ Could not delete file: ${e.message}`);
  }

  // Remove from registry
  delete reg[pluginName];
  saveRegistry(reg);

  const hookWarning = entry?.hasHooks
    ? `\n⚠️ This plugin had exported hooks. If those hooks were active, a *restart* is recommended.`
    : '';

  reply(
    `🗑️ *Plugin Deleted!*\n\n` +
    `📦 *Name:* ${pluginName}\n` +
    `📋 *Commands removed:* ${removed}\n` +
    `📁 *File deleted:* ${fileDeleted ? 'Yes' : 'Not found (already gone)'}` +
    hookWarning
  );
});

// ── pluginlist ────────────────────────────────────────────────────────────────
cast({
  pattern:  'pluginlist',
  alias:    ['listplugins', 'plist', 'installedplugins'],
  desc:     'List all plugins installed via plugininstall',
  category: 'owner',
  react:    '📋',
  filename: __filename,
}, async (conn, mek, m, { from, isOwner, reply }) => {
  if (!isOwner) return reply('❌ Owner only.');

  const reg = Object.entries(loadRegistry());
  if (!reg.length) return reply(
    `📭 No plugins installed yet.\n\nUse *plugininstall <url>* to install one.`
  );

  const lines = reg.map(([name, d], i) => {
    const age = d.updatedAt || d.installedAt;
    const date = age ? new Date(age).toLocaleDateString() : '?';
    const cmds = d.commands?.join(', ') || 'internal';
    const hook = d.hasHooks ? ' ⚠️' : '';
    return `${i + 1}. 📦 *${name}*${hook}\n   Commands: ${cmds}\n   Date: ${date}\n   URL: ${d.url}`;
  });

  await conn.sendMessage(from, {
    text:
      `📋 *Installed Plugins (${reg.length})*\n` +
      `_(⚠️ = has exported hooks, restart needed for full effect)_\n\n` +
      lines.join('\n\n') +
      `\n\n_plugindelete <name> to remove | pluginupdate <name> to update_`
  }, { quoted: mek });
});
