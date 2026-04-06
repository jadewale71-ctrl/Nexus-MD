// plugins/antidelete.js
'use strict';

const { cast } = require('../cast');
const { getAnti, setAnti, initializeAntiDeleteSettings } = require('../data'); // Adjust path if it's strictly ../data/antidel

initializeAntiDeleteSettings();

// ── antidelete command ────────────────────────────────────────────────────────
cast({
  pattern: 'antidelete',
  alias:   ['antidel', 'ad'],
  desc:    'Toggle antidelete for groups/DMs/status',
  category: 'owner',
  filename: __filename,
}, async (conn, mek, m, { isOwner, args, reply }) => {
  if (!isOwner) return reply('⛔ Owner only.');
  
  const action = (args[0] || '').toLowerCase();
  const type   = (args[1] || '').toLowerCase();

  if (action === 'on') {
    if (type === 'gc')     { await setAnti('gc', true);     return reply('✅ AntiDelete enabled for *Groups*.'); }
    if (type === 'dm')     { await setAnti('dm', true);     return reply('✅ AntiDelete enabled for *DMs*.'); }
    if (type === 'status') { await setAnti('status', true); return reply('✅ AntiDelete enabled for *Status*.'); }
    
    await setAnti('gc', true); 
    await setAnti('dm', true); 
    await setAnti('status', true);
    return reply('✅ AntiDelete enabled everywhere.');
  }
  
  if (action === 'off') {
    if (type === 'gc')     { await setAnti('gc', false);     return reply('❌ AntiDelete disabled for *Groups*.'); }
    if (type === 'dm')     { await setAnti('dm', false);     return reply('❌ AntiDelete disabled for *DMs*.'); }
    if (type === 'status') { await setAnti('status', false); return reply('❌ AntiDelete disabled for *Status*.'); }
    
    await setAnti('gc', false); 
    await setAnti('dm', false); 
    await setAnti('status', false);
    return reply('❌ AntiDelete disabled everywhere.');
  }
  
  if (action === 'status') {
    const gc = await getAnti('gc');
    const dm = await getAnti('dm');
    const st = await getAnti('status');
    return reply(
      `*AntiDelete Status*\n\n` +
      `👥 Groups : ${gc ? 'ON ✅' : 'OFF ❌'}\n` +
      `💬 DM     : ${dm ? 'ON ✅' : 'OFF ❌'}\n` +
      `📸 Status : ${st ? 'ON ✅' : 'OFF ❌'}`
    );
  }
  
  return reply(
    `*AntiDelete*\n\n` +
    `antidelete on       — enable everywhere\n` +
    `antidelete off      — disable everywhere\n` +
    `antidelete on gc    — groups only\n` +
    `antidelete on dm    — DMs only\n` +
    `antidelete on status — status only\n` +
    `antidelete status   — show current settings`
  );
});

// ── antideletestatus command ──────────────────────────────────────────────────
cast({
  pattern: 'antideletestatus',
  alias:   ['adstatus', 'antistatus'],
  desc:    'Toggle antidelete for status specifically',
  category: 'owner',
  filename: __filename,
}, async (conn, mek, m, { isOwner, args, reply }) => {
  if (!isOwner) return reply('⛔ Owner only.');
  
  const action = (args[0] || '').toLowerCase();
  
  if (action === 'on')  { await setAnti('status', true);  return reply('✅ AntiDelete enabled for *Status*.'); }
  if (action === 'off') { await setAnti('status', false); return reply('❌ AntiDelete disabled for *Status*.'); }
  
  const st = await getAnti('status');
  return reply(`📸 Status AntiDelete: ${st ? 'ON ✅' : 'OFF ❌'}`);
});
