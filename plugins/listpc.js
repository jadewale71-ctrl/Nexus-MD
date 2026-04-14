// plugins/listpc.js — NEXUS-MD
'use strict';

const { cast } = require('../cast');
const config = require('../config');

// ── LIST PC ──────────────────────────────────────────────────────────────────
cast({
  pattern: 'listpc',
  alias: ['pmlist'],
  desc: 'Finds info about personal chats and unread counts',
  category: 'owner',
  filename: __filename,
}, async (conn, mek, m, { isOwner, reply, smartReply }) => {
  if (!isOwner) return reply('🚫 Owner only.');

  try {
    // Dynamically pull store to avoid circular dependency
    let store;
    try { store = require('../index').store; } catch (e) { }

    if (!store || !store.chats) {
      return reply('⚠️ *Store is not initialized yet!* Give the bot a few seconds after booting.');
    }

    // Access custom store safely
    let chatArray = typeof store.chats.all === 'function'
        ? store.chats.all()
        : Object.values(store.chats.dict || store.chats || {});

    // Filter for DMs only
    let pmChats = chatArray.filter(chat => chat.id && chat.id.endsWith('@s.whatsapp.net'));

    if (!pmChats.length) return reply('📭 No personal chats found.');

    // Sort by most recently active
    pmChats.sort((a, b) => {
        let tsA = a.conversationTimestamp || 0;
        let tsB = b.conversationTimestamp || 0;
        if (typeof tsA === 'object' && tsA.toNumber) tsA = tsA.toNumber();
        if (typeof tsB === 'object' && tsB.toNumber) tsB = tsB.toNumber();
        return tsB - tsA;
    });

    // Import config for bot name, fallback to NEXUS-MD if unavailable
    const botName = config.BOT_NAME || 'NEXUS-MD';
    
    let responseText = ` 「  ${botName}'s PM User List  」\n\nTotal ${pmChats.length} users are text in personal chat.`;
    let mentions = [];

    // Loop through each personal chat
    for (let userChat of pmChats) {
      let jid = userChat.id;
      let num = jid.split('@')[0];
      mentions.push(jid);

      let unread = userChat.unreadCount || 0;
      
      // Format timestamp using native JS to avoid moment-timezone crashes
      let lastChatTime = 'Unknown';
      if (userChat.conversationTimestamp) {
        let ts = typeof userChat.conversationTimestamp === 'object' && userChat.conversationTimestamp.toNumber 
            ? userChat.conversationTimestamp.toNumber() 
            : userChat.conversationTimestamp;
        lastChatTime = new Date(ts * 1000).toLocaleString(); 
      }

      responseText += `\n\nUser: @${num}`;
      responseText += `\nUnread Messages : ${unread}`;
      responseText += `\nLastchat : ${lastChatTime}`;
    }

    // Send using smartReply so mentions highlight properly
    await smartReply({ text: responseText, mentions });

  } catch (err) {
    console.error('listpc error:', err);
    return reply(`*_Didn't get any results, Sorry!_*\n\nError: ${err.message}`);
  }
});
