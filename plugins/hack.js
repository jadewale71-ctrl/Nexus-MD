'use strict';

const { cast, makeSmartQuote } = require('../cast');

cast({
  pattern: 'hacker',
  alias: ['fakehack', 'mockhack'],
  desc: 'Simulate a fake hacking process on a mentioned user',
  category: 'fun',
  react: '💻',
  filename: __filename,
}, async (conn, mek, m, { from, sender, reply }) => {
  
  // 1. Resolve the target (Mentioned user, quoted user, or the sender themselves)
  const mentionedJid = mek.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
  const target = mentionedJid[0] || m.quoted?.sender || sender;
  const targetName = target.split('@')[0];

  // 2. Define the hacking steps
  const steps = [
    `💻 *Initializing Hack on @${targetName}...*`,
    `🔍 *Bypassing Mainframe Security...* \n[████░░░░░░] 40%`,
    `🔓 *Decrypting WhatsApp Data...* \n[███████░░░] 70%`,
    `📂 *Stealing Memes & Chat History...* \n[█████████░] 90%`,
    `✅ *Hack Complete!* \nAll data belonging to @${targetName} has been sold on the dark web for 2 Dogecoins. 🐕`
  ];

  try {
    // 3. Send the initial message and store the message key
    const sentMsg = await conn.sendMessage(from, { 
        text: steps[0], 
        mentions: [target] 
    }, { quoted: makeSmartQuote() });

    // 4. Loop through the remaining steps and edit the message
    for (let i = 1; i < steps.length; i++) {
      await new Promise(resolve => setTimeout(resolve, 1500)); // 1.5 second delay between edits
      
      await conn.sendMessage(from, { 
          text: steps[i], 
          edit: sentMsg.key, 
          mentions: [target] 
      });
    }
    
  } catch (error) {
    console.error('Hack plugin error:', error);
    reply('❌ *Hack failed. Their firewall is too strong.*');
  }
});
