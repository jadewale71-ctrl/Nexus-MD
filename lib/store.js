// lib/store.js — NEXUS-MD
// Tracks both messages (for antidelete) and chats (for listpc/listdms)
const fs = require('fs');

function createStore() {
  const messages = {}; // { jid: { messageId: messageObj } }
  const chats    = {}; // { jid: { id, unreadCount, conversationTimestamp, name } }

  // ── Chats API — compatible with store.chats.all() ─────────────────────────
  const chatsApi = {
    all() {
      return Object.values(chats);
    },
    get(jid) {
      return chats[jid] || null;
    },
    set(jid, data) {
      chats[jid] = { ...(chats[jid] || {}), ...data };
    },
  };

  return {
    messages,
    chats: chatsApi,

    bind(ev) {
      // ── Track incoming messages ───────────────────────────────────────────
      ev.on('messages.upsert', async ({ messages: msgs, type }) => {
        for (const m of (msgs || [])) {
          const jid = m.key?.remoteJid;
          if (!jid || !m.message) continue;

          // Store message for antidelete
          if (!messages[jid]) messages[jid] = {};
          messages[jid][m.key.id] = m;

          // Update chat metadata
          const ts = m.messageTimestamp;
          const t  = typeof ts === 'object' && ts?.toNumber ? ts.toNumber() : Number(ts || 0);

          if (!chats[jid]) {
            chats[jid] = {
              id:                    jid,
              unreadCount:           0,
              conversationTimestamp: t,
              name:                  m.pushName || null,
            };
          } else {
            // Update timestamp if newer
            if (t > (chats[jid].conversationTimestamp || 0)) {
              chats[jid].conversationTimestamp = t;
            }
            // Update name if available
            if (m.pushName && !chats[jid].name) {
              chats[jid].name = m.pushName;
            }
          }

          // Increment unread for incoming messages (not bot's own)
          if (!m.key.fromMe && type === 'notify') {
            chats[jid].unreadCount = (chats[jid].unreadCount || 0) + 1;
          }
        }
      });

      // ── Track chat updates (read receipts reset unreadCount) ──────────────
      ev.on('messages.update', (updates) => {
        for (const update of (updates || [])) {
          const jid = update.key?.remoteJid;
          if (!jid) continue;
          // When bot reads messages, reset unread
          if (update.update?.status === 4 && update.key?.fromMe === false) {
            if (chats[jid]) chats[jid].unreadCount = 0;
          }
        }
      });

      // ── Track chat-level updates (mute, pin, archive etc) ────────────────
      ev.on('chats.update', (updates) => {
        for (const update of (updates || [])) {
          const jid = update.id;
          if (!jid) continue;
          if (!chats[jid]) chats[jid] = { id: jid, unreadCount: 0, conversationTimestamp: 0 };
          if (update.unreadCount !== undefined) chats[jid].unreadCount = update.unreadCount;
          if (update.conversationTimestamp) chats[jid].conversationTimestamp = update.conversationTimestamp;
          if (update.name) chats[jid].name = update.name;
        }
      });

      // ── Track new chats ───────────────────────────────────────────────────
      ev.on('chats.upsert', (newChats) => {
        for (const chat of (newChats || [])) {
          const jid = chat.id;
          if (!jid) continue;
          chats[jid] = {
            id:                    jid,
            unreadCount:           chat.unreadCount || 0,
            conversationTimestamp: chat.conversationTimestamp || 0,
            name:                  chat.name || null,
          };
        }
      });

      // ── Track chat deletions ──────────────────────────────────────────────
      ev.on('chats.delete', (deletedJids) => {
        for (const jid of (deletedJids || [])) {
          delete chats[jid];
        }
      });
    },

    async loadMessage(jid, id) {
      return messages[jid]?.[id] || null;
    },

    readFromFile(filePath) {
      if (fs.existsSync(filePath)) {
        try {
          const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          if (data.messages) Object.assign(messages, data.messages);
          if (data.chats)    Object.assign(chats,    data.chats);
          // Legacy format — just messages at root
          if (!data.messages && !data.chats) Object.assign(messages, data);
        } catch (e) {
          console.error('[store] Failed to read store file:', e.message);
        }
      }
    },

    writeToFile(filePath) {
      try {
        fs.writeFileSync(filePath, JSON.stringify({ messages, chats }, null, 2), 'utf8');
      } catch (e) {
        console.error('[store] Failed to write store file:', e.message);
      }
    }
  };
}

module.exports = { createStore };
