'use strict';

const { cast, makeSmartQuote } = require('../cast');
const config = require('../config');
const axios = require('axios');
const { Sticker, StickerTypes } = require('wa-sticker-formatter');

// Telegram Bot API Token
const TG_TOKEN = '8442217476:AAHJjg8UllsnwaHgGndwTD4itUXK7xyomng'; 

cast({
  pattern: 'tgsticker',
  alias: ['telesticker', 'tgpack'],
  desc: 'Download a Telegram sticker pack to WhatsApp',
  category: 'downloader',
  react: '📲',
  filename: __filename,
}, async (conn, mek, m, { from, args, reply }) => {
  
  if (!args[0]) {
    return await conn.sendMessage(from, { 
        text: `❌ Provide a Telegram sticker pack link!\n\n*Example:*\n/tgsticker https://t.me/addstickers/AnimalPack` 
    }, { quoted: makeSmartQuote() });
  }

  const url = args[0];
  const packNameMatch = url.match(/addstickers\/(.+)/);
  if (!packNameMatch) {
    return await conn.sendMessage(from, { 
        text: `❌ Invalid link format. Use a link like:\nhttps://t.me/addstickers/PackName` 
    }, { quoted: makeSmartQuote() });
  }

  const packName = packNameMatch[1];

  await conn.sendMessage(from, { react: { text: '⏳', key: mek.key } });
  await conn.sendMessage(from, { 
      text: `⏳ Fetching Telegram pack: *${packName}*...\n_This might take a moment._` 
  }, { quoted: makeSmartQuote() });

  try {
    // 1. Get Pack Info from Telegram
    const packRes = await axios.get(`https://api.telegram.org/bot${TG_TOKEN}/getStickerSet?name=${packName}`);
    if (!packRes.data.ok) return reply(`❌ Pack not found.`);

    const stickers = packRes.data.result.stickers;
    if (!stickers || !stickers.length) {
        return await conn.sendMessage(from, { text: `❌ Empty sticker pack.` }, { quoted: makeSmartQuote() });
    }

    // Limit to 20 stickers to prevent WhatsApp from rate-limiting the bot
    const limit = Math.min(stickers.length, 20);
    await conn.sendMessage(from, { 
        text: `📥 Downloading ${limit} stickers from *${packRes.data.result.title}*...` 
    }, { quoted: makeSmartQuote() });

    let sent = 0;

    for (let i = 0; i < limit; i++) {
      const sticker = stickers[i];
      
      // Skip .tgs (Lottie) files as they require heavy external dependencies to convert to gif/webp
      if (sticker.is_animated && !sticker.is_video) {
         continue; 
      }

      try {
        // 2. Get the specific file path
        const fileRes = await axios.get(`https://api.telegram.org/bot${TG_TOKEN}/getFile?file_id=${sticker.file_id}`);
        const filePath = fileRes.data.result.file_path;

        // 3. Download the actual file buffer
        const fileUrl = `https://api.telegram.org/file/bot${TG_TOKEN}/${filePath}`;
        const fileBuffer = await axios.get(fileUrl, { responseType: 'arraybuffer' }).then(res => Buffer.from(res.data));

        // 4. Convert and format it for WhatsApp
        const waSticker = new Sticker(fileBuffer, {
          pack: config.BOT_NAME || 'NEXUS-MD',
          author: config.OWNER_NAME || 'Telegram',
          type: StickerTypes.FULL,
          quality: 70
        });

        await conn.sendMessage(from, { sticker: await waSticker.toBuffer() }, { quoted: makeSmartQuote() });
        sent++;
        
        // Short delay to avoid spamming the connection
        await new Promise(r => setTimeout(r, 1200)); 

      } catch (e) {
        console.error(`Failed to process sticker ${i}:`, e.message);
      }
    }

    await conn.sendMessage(from, { 
        text: `✅ Successfully converted ${sent} stickers!` 
    }, { quoted: makeSmartQuote() });
    
    await conn.sendMessage(from, { react: { text: '✅', key: mek.key } });

  } catch (error) {
    console.error('Telegram Sticker Error:', error.response?.data || error.message);
    await conn.sendMessage(from, { 
        text: `❌ Failed to fetch pack. Make sure the link is correct and the pack is public.` 
    }, { quoted: makeSmartQuote() });
  }
});
