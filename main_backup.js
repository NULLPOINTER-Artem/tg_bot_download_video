/**
 * Video Download → Telegram Bot (Node.js)
 * ----------------------------------------
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
  
  if (urlLower.includes('youtube.com') || urlLower.includes('youtu.be')) {
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

// Функция для получения подходящего формата видео
function getVideoFormat(linkType, maxHeight) {
  const formats = [];
  
  if (linkType === 'youtube') {
    // Для YouTube используем более агрессивную стратегию
    formats.push(`best[height<=${maxHeight}][ext=mp4]`);
    formats.push(`best[height<=${maxHeight}]`);
    formats.push(`worst[height<=${maxHeight}][ext=mp4]`);
    formats.push(`bestvideo[height<=${maxHeight}]+bestaudio/best[height<=${maxHeight}]`);
    formats.push('best[ext=mp4]');
    formats.push('worst[ext=mp4]');
    formats.push('best');
    formats.push('worst');
  } else if (linkType === 'instagram') {
    // Для Instagram простые форматы работают лучше
    formats.push('best[ext=mp4]');
    formats.push('best');
    formats.push('worst');
  } else {
    // Для других платформ универсальный подход
    formats.push(`best[height<=${maxHeight}][ext=mp4]`);
    formats.push(`best[height<=${maxHeight}]`);
    formats.push('best[ext=mp4]');
    formats.push('best');
    formats.push('worst');
  }
  
  return formats.join('/');
}

async function downloadVideo(url) {
  const linkType = detectLinkType(url);
  const videoFormat = getVideoFormat(linkType, MAX_HEIGHT);
  
  let ytdlpOptions = {
    dumpSingleJson: true,
    noWarnings: true,
    noCallHome: true,
    noCheckCertificates: true,
    preferFreeFormats: true,
    format: videoFormat,
  };

  // Специальные настройки для YouTube
  if (linkType === 'youtube') {
    ytdlpOptions = {
      ...ytdlpOptions,
      // Дополнительные опции для обхода ограничений YouTube
      addHeader: ['User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'],
      extractFlat: false,
      writeInfoJson: false,
      writeDescription: false,
      writeThumbnail: false,
      writeAllThumbnails: false,
    };
  }

  // Специальные настройки для Instagram
  if (linkType === 'instagram') {
    ytdlpOptions = {
      ...ytdlpOptions,
      addHeader: ['User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'],
      cookiesFromBrowser: 'chrome',
      noCheckCertificates: true,
    };
  }

  let info;
  let finalFormat = videoFormat;
  
  // Массив fallback стратегий
  const fallbackStrategies = [
    // Стратегия 1: Оригинальный формат
    () => ({ ...ytdlpOptions }),
    
    // Стратегия 2: Простой best формат
    () => ({ ...ytdlpOptions, format: 'best' }),
    
    // Стратегия 3: Worst формат (может быть доступен когда best недоступен)
    () => ({ ...ytdlpOptions, format: 'worst' }),
    
    // Стратегия 4: Без ограничений по высоте
    () => ({ ...ytdlpOptions, format: 'best[ext=mp4]/best' }),
    
    // Стратегия 5: Любой доступный формат
    () => ({ 
      ...ytdlpOptions, 
      format: 'best/worst',
      preferFreeFormats: false 
    }),
    
    // Стратегия 6: Для Instagram без cookies
    () => {
      const opts = { ...ytdlpOptions, format: 'best' };
      if (linkType === 'instagram') {
        delete opts.cookiesFromBrowser;
      }
      return opts;
    },
    
    // Стратегия 7: Минимальные опции
    () => ({
      dumpSingleJson: true,
      noWarnings: true,
      format: 'best',
    })
  ];

  // Пробуем каждую стратегию
  for (let i = 0; i < fallbackStrategies.length; i++) {
    try {
      const currentOptions = fallbackStrategies[i]();
      console.log(`Trying strategy ${i + 1}/${fallbackStrategies.length}: format=${currentOptions.format}`);
      
      info = await ytdlp(url, currentOptions);
      finalFormat = currentOptions.format;
      ytdlpOptions = currentOptions; // Сохраняем успешные опции для скачивания
      console.log(`Strategy ${i + 1} succeeded!`);
      break;
      
    } catch (error) {
      console.log(`Strategy ${i + 1} failed: ${error.message}`);
      
      // Если это последняя стратегия, выбрасываем ошибку
      if (i === fallbackStrategies.length - 1) {
        if (linkType === 'instagram') {
          throw new Error(`Не удалось загрузить видео из Instagram. Возможно, видео приватное или требует авторизации.`);
        } else if (error.message.includes('Requested format is not available')) {
          throw new Error(`Видео недоступно в поддерживаемом формате. Возможно, видео имеет ограничения доступа.`);
        } else if (error.message.includes('Private video')) {
          throw new Error(`Видео приватное или недоступно.`);
        } else if (error.message.includes('Video unavailable')) {
          throw new Error(`Видео недоступно или было удалено.`);
        } else {
          throw new Error(`Не удалось загрузить видео: ${error.message}`);
        }
      }
    }
  }

  const duration = info.duration || 0;
  if (duration > MAX_DURATION) {
    throw new Error(`Видео слишком длинное: ${duration}s > ${MAX_DURATION}s`);
  }

  const outFile = path.join(__dirname, `${info.id}.mp4`);
  
  // Настройки для скачивания с тем же форматом, который сработал
  let downloadOptions = {
    output: outFile,
    format: finalFormat,
    noWarnings: true,
    noCallHome: true,
    noCheckCertificates: true,
  };

  // Копируем дополнительные опции из успешного запроса
  if (ytdlpOptions.addHeader) {
    downloadOptions.addHeader = ytdlpOptions.addHeader;
  }
  if (ytdlpOptions.cookiesFromBrowser) {
    downloadOptions.cookiesFromBrowser = ytdlpOptions.cookiesFromBrowser;
  }

  try {
    await ytdlp(url, downloadOptions);
  } catch (downloadError) {
    console.log('Download failed, trying with simplest options...');
    
    // Последняя попытка с минимальными опциями
    const simpleDownloadOptions = {
      output: outFile,
      format: 'best',
      noWarnings: true,
    };
    
    await ytdlp(url, simpleDownloadOptions);
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
    
    if (e.message.includes('Instagram') && e.message.includes('empty media response')) {
      errorMessage = 'Instagram видео недоступно. Возможно, аккаунт приватный или видео удалено.';
    } else if (e.message.includes('Instagram') && e.message.includes('приватное')) {
      errorMessage = e.message;
    } else if (e.message.includes('слишком длинное')) {
      errorMessage = e.message;
    } else if (e.message.includes('недоступно в поддерживаемом формате')) {
      errorMessage = e.message;
    } else if (e.message.includes('Private video')) {
      errorMessage = 'Видео приватное или недоступно.';
    } else if (e.message.includes('Video unavailable')) {
      errorMessage = 'Видео недоступно или было удалено.';
    } else if (e.message.includes('Requested format is not available')) {
      errorMessage = 'Формат видео не поддерживается. Попробуйте другую ссылку.';
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
console.log('Bot is running…');