/**
 * Video Download → Telegram Bot (Node.js) - ULTIMATE FIXED VERSION
 * ------------------------------------------------------------------
 * Функции:
 *  1) Автоматическая загрузка видео по ссылкам (YouTube, Instagram, TikTok и др.)
 *  2) (опционально) Авто-синк новых Shorts из канала по RSS.
 *
 * Требования:
 *  - Node.js 18+
 *  - ffmpeg установлен в системе
 *
 * Установка:
 *  npm install telegraf yt-dlp-exec rss-parser dotenv
 *
 * Переменные окружения (.env):
 *  TELEGRAM_BOT_TOKEN=123456:ABC...
 *  TARGET_CHAT_ID=-1001234567890      # для автосинка
 *  YT_CHANNEL_ID=UCxxxxxxxxxxxxxxxxxx # если нужен автосинк
 *  POLL_INTERVAL=300                  # интервал проверки RSS (сек)
 *  MAX_DURATION_SECONDS=75            # максимальная длина видео
 *  MAX_HEIGHT=1080                    # ограничение по высоте видео
 */

import { Telegraf } from 'telegraf';
import { execFile } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import Parser from 'rss-parser';
import ytdlp from 'yt-dlp-exec';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TARGET_CHAT_ID = process.env.TARGET_CHAT_ID;
const YT_CHANNEL_ID = process.env.YT_CHANNEL_ID;
const POLL_INTERVAL = Number(process.env.POLL_INTERVAL || 300);
const MAX_DURATION = Number(process.env.MAX_DURATION_SECONDS || 75);
const MAX_HEIGHT = Number(process.env.MAX_HEIGHT || 1080);

if (!BOT_TOKEN) {
  console.error('Set TELEGRAM_BOT_TOKEN in .env');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const parser = new Parser();

// Функция для определения типа ссылки
function detectLinkType(url) {
  const urlLower = url.toLowerCase();
  
  if (urlLower.includes('youtube.com/shorts/') || urlLower.match(/youtube\.com.*\/shorts\//)) {
    return 'youtube_shorts';
  } else if (urlLower.includes('youtube.com') || urlLower.includes('youtu.be')) {
    return 'youtube';
  } else if (urlLower.includes('instagram.com')) {
    return 'instagram';
  } else if (urlLower.includes('tiktok.com')) {
    return 'tiktok';
  } else if (urlLower.includes('twitter.com') || urlLower.includes('x.com')) {
    return 'twitter';
  } else if (urlLower.includes('vk.com')) {
    return 'vk';
  }
  
  return 'other';
}

// Функция для проверки, является ли текст ссылкой
function isValidUrl(text) {
  try {
    new URL(text);
    return true;
  } catch {
    return false;
  }
}

async function downloadVideo(url) {
  const linkType = detectLinkType(url);
  
  let info;
  let finalOptions = {};
  
  // Проверяем доступные форматы перед скачиванием
  async function checkFormats() {
    try {
      const listResult = await ytdlp(url, {
        listFormats: true,
        noWarnings: true,
        noCheckCertificates: true,
        extractorArgs: linkType === 'youtube_shorts' ? ['youtube:player_client=android'] : undefined
      });
      console.log('Available formats:', listResult);
      return true;
    } catch (e) {
      console.log('Format check failed:', e.message);
      return false;
    }
  }
  
  // Пробуем получить список форматов
  await checkFormats();
  
  // Максимально упрощенные стратегии для разных платформ
  const strategies = [
    // Стратегия 0: Специальная для YouTube Shorts с мобильным API
    () => {
      if (linkType === 'youtube_shorts') {
        return {
          dumpSingleJson: true,
          noWarnings: true,
          format: '18/best[height<=720]',
          addHeader: [
            'User-Agent:Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1',
            'Accept:text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language:en-us'
          ],
          extractorArgs: ['youtube:player_client=android', 'youtube:player_skip=webpage'],
          noCheckCertificates: true,
          noPlaylist: true,
          concurrent: 1,
          maxDownloads: 1,
          retries: 3,
        };
      }
      return {
        dumpSingleJson: true,
        noWarnings: true,
        format: 'best',
      };
    },
    
    // Стратегия 1: Базовая для всех
    () => ({
      dumpSingleJson: true,
      noWarnings: true,
      format: 'best',
    }),
    
    // Стратегия 2: С User-Agent
    () => ({
      dumpSingleJson: true,
      noWarnings: true,
      format: 'best',
      addHeader: ['User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'],
    }),
    
    // Стратегия 3: Worst формат
    () => ({
      dumpSingleJson: true,
      noWarnings: true,
      format: 'worst',
    }),
    
    // Стратегия 4: Для YouTube с обходом ограничений
    () => {
      if (linkType === 'youtube') {
        return {
          dumpSingleJson: true,
          noWarnings: true,
          format: 'best',
          addHeader: ['User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'],
          // Опции для обхода блокировок YouTube
          extractor: 'youtube',
          ageLimit: 99,
        };
      }
      return {
        dumpSingleJson: true,
        noWarnings: true,
        format: 'best',
      };
    },
    
    // Стратегия 5: Для Instagram без cookies
    () => {
      if (linkType === 'instagram') {
        return {
          dumpSingleJson: true,
          noWarnings: true,
          format: 'best',
          addHeader: ['User-Agent:Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15'],
        };
      }
      return {
        dumpSingleJson: true,
        noWarnings: true,
        format: 'best',
      };
    },
    
    // Стратегия 6: Минимальные опции
    () => ({
      dumpSingleJson: true,
      format: 'best',
    }),
    
    // Стратегия 7: Прямой формат для YouTube Shorts
    () => {
      if (linkType === 'youtube_shorts') {
        return {
          dumpSingleJson: true,
          format: '18/22',  // Прямые форматы MP4
          noCheckCertificates: true,
          noPlaylist: true,
          extractorArgs: 'youtube:player-client=web',
        };
      }
      return {
        dumpSingleJson: true,
        format: 'worst',
      };
    },
    
    // Стратегия 8: Последняя попытка с базовыми настройками
    () => ({
      dumpSingleJson: true,
      format: '18',  // Базовый MP4 формат
      noCheckCertificates: true,
      noPlaylist: true,
    })
  ];

  // Пробуем каждую стратегию
  for (let i = 0; i < strategies.length; i++) {
    try {
      const currentOptions = strategies[i]();
      console.log(`Trying strategy ${i + 1}/${strategies.length}: ${linkType} with format=${currentOptions.format}`);
      
      info = await ytdlp(url, currentOptions);
      finalOptions = currentOptions;
      console.log(`Strategy ${i + 1} succeeded! Title: ${info.title || 'Unknown'}`);
      break;
      
    } catch (error) {
      const errorMsg = error.message.split('\n')[0];
      console.log(`Strategy ${i + 1} failed: ${errorMsg}`);
      console.log('Full error:', error.message);
      
      // Если это последняя стратегия, выбрасываем ошибку
      if (i === strategies.length - 1) {
        if (linkType === 'instagram') {
          throw new Error(`Не удалось загрузить видео из Instagram. Возможно, видео приватное или требует авторизации.`);
        } else if (linkType === 'youtube') {
          throw new Error(`Не удалось загрузить YouTube видео. Возможно, видео недоступно или имеет ограничения.`);
        } else {
          throw new Error(`Не удалось загрузить видео: ${error.message.split('\n')[0]}`);
        }
      }
    }
  }

  const duration = info.duration || 0;
  if (duration > MAX_DURATION) {
    throw new Error(`Видео слишком длинное: ${duration}s > ${MAX_DURATION}s`);
  }

  const outFile = path.join(__dirname, `${info.id}.mp4`);
  
  // Настройки для скачивания - используем те же опции, что сработали для info
  let downloadOptions = {
    output: outFile,
    format: linkType === 'youtube_shorts' 
      ? '18/best[height<=720]' 
      : (finalOptions.format || 'best'),
    noWarnings: true,
    preferFreeFormats: true,
    noCheckCertificates: true,
    addHeader: [
      'User-Agent:Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1',
      'Accept:text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language:en-us'
    ],
    extractorArgs: linkType === 'youtube_shorts' 
      ? ['youtube:player_client=android', 'youtube:player_skip=webpage', 'youtube:embed_webpage=1']
      : undefined,
    concurrent: 1,
    retries: 3,
  };

  // Копируем успешные опции
  if (finalOptions.addHeader) {
    downloadOptions.addHeader = finalOptions.addHeader;
  }
  if (finalOptions.ageLimit) {
    downloadOptions.ageLimit = finalOptions.ageLimit;
  }

  try {
    console.log(`Downloading with format: ${downloadOptions.format}`);
    await ytdlp(url, downloadOptions);
    console.log('Download completed successfully');
  } catch (downloadError) {
    console.log('Download failed, trying ultimate fallback...');
    
    // Ультимативный fallback - только самые базовые опции
    const ultimateOptions = {
      output: outFile,
      format: 'best',
    };
    
    try {
      await ytdlp(url, ultimateOptions);
      console.log('Ultimate fallback succeeded');
    } catch (ultimateError) {
      // Попробуем worst формат
      ultimateOptions.format = 'worst';
      await ytdlp(url, ultimateOptions);
      console.log('Worst format fallback succeeded');
    }
  }

  return { info, file: outFile };
}

async function sendVideo(ctx, { info, file }) {
  const platform = detectLinkType(info.webpage_url || '');
  const platformName = {
    youtube: 'YouTube',
    instagram: 'Instagram', 
    tiktok: 'TikTok',
    twitter: 'Twitter',
    vk: 'VK',
    other: 'Видео'
  }[platform] || 'Видео';

  let caption = `*${info.title || 'Видео'}*`;
  
  if (info.duration) {
    caption += `\n⏱ ${info.duration}s`;
  }
  
  if (info.uploader) {
    caption += ` • 👤 ${info.uploader}`;
  }
  
  if (info.webpage_url) {
    caption += `\n\n[${platformName}](${info.webpage_url})`;
  }

  await ctx.replyWithVideo({ source: file }, {
    caption,
    parse_mode: 'Markdown',
    supports_streaming: true,
  });
  fs.unlink(file, () => {});
}

bot.start((ctx) => ctx.reply('Привет! Пришли мне ссылку на видео и я его скачаю для тебя! 🎬\n\nПоддерживаю: YouTube, Instagram, TikTok, Twitter, VK и другие платформы.'));

// Обработка всех текстовых сообщений
bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();
  
  // Проверяем, содержит ли сообщение ссылку
  const urls = text.match(/https?:\/\/[^\s]+/g);
  
  if (!urls || urls.length === 0) {
    return ctx.reply('Пришли мне ссылку на видео, и я его скачаю! 📹');
  }

  // Обрабатываем первую найденную ссылку
  const url = urls[0];
  
  if (!isValidUrl(url)) {
    return ctx.reply('Некорректная ссылка. Проверь и попробуй ещё раз.');
  }

  const linkType = detectLinkType(url);
  const platformEmoji = {
    youtube: '📺',
    instagram: '📸',
    tiktok: '🎵',
    twitter: '🐦',
    vk: '🔵',
    other: '🎬'
  };

  try {
    await ctx.reply(`${platformEmoji[linkType]} Скачиваю видео...`);
    const result = await downloadVideo(url);
    await sendVideo(ctx, result);
    await ctx.reply('Готово ✅');
  } catch (e) {
    console.error('Download error:', e.message);
    
    // Более понятные сообщения об ошибках
    let errorMessage = 'Ошибка при скачивании видео 😔';
    
    if (e.message.includes('Instagram')) {
      errorMessage = 'Instagram видео недоступно. Возможно, аккаунт приватный или видео удалено.';
    } else if (linkType === 'youtube_shorts' && e.message.includes('YouTube')) {
      errorMessage = 'Не удалось загрузить YouTube Shorts. Попробуйте позже или проверьте доступность видео.';
    } else if (e.message.includes('YouTube')) {
      errorMessage = 'YouTube видео недоступно. Возможно, видео приватное или имеет ограничения.';
    } else if (e.message.includes('слишком длинное')) {
      errorMessage = e.message;
    } else if (e.message.includes('Private video')) {
      errorMessage = 'Видео приватное или недоступно.';
    } else if (e.message.includes('Video unavailable')) {
      errorMessage = 'Видео недоступно или было удалено.';
    } else if (e.message.includes('Sign in to confirm your age')) {
      errorMessage = 'Видео требует подтверждения возраста. Попробуйте другую ссылку.';
    }
    
    ctx.reply(errorMessage);
  }
});

async function autoSync() {
  if (!YT_CHANNEL_ID || !TARGET_CHAT_ID) return;
  const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${YT_CHANNEL_ID}`;
  const seen = new Set();

  setInterval(async () => {
    try {
      const feed = await parser.parseURL(rssUrl);
      for (const entry of feed.items) {
        const id = entry.id?.split(':').pop();
        if (!id || seen.has(id)) continue;

        const url = `https://www.youtube.com/watch?v=${id}`;
        try {
          const result = await downloadVideo(url);
          await bot.telegram.sendVideo(TARGET_CHAT_ID, { source: result.file }, {
            caption: `*${result.info.title}*\n⏱ ${result.info.duration}s\n[YouTube](${result.info.webpage_url})`,
            parse_mode: 'Markdown',
          });
          fs.unlink(result.file, () => {});
          seen.add(id);
          console.log('Posted new video', id);
        } catch (e) {
          console.log('Skip', id, e.message);
        }
      }
    } catch (err) {
      console.error('RSS error', err);
    }
  }, POLL_INTERVAL * 1000);
}

autoSync();

bot.launch();
console.log('Bot is running - ULTIMATE FIXED VERSION!');