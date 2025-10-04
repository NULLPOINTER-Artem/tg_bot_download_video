"""
YouTube Shorts → Telegram Bot
--------------------------------
A simple bot that lets you:
  1) Send a Shorts (or any short YT video) to Telegram via /short <url> command.
  2) (Optional) Auto-sync latest shorts from a channel RSS every N minutes.

Requirements (system):
  - Python 3.10+
  - ffmpeg installed and available in PATH

Install deps:
  pip install -U yt-dlp python-telegram-bot==21.* feedparser python-dotenv

Env variables (create .env or set in your shell):
  TELEGRAM_BOT_TOKEN=123456:ABC...
  TARGET_CHAT_ID=-1001234567890          # chat/channel/user where videos are posted in auto-sync mode
  YT_CHANNEL_ID=UCxxxxxxxxxxxxxxxxxx     # optional: enables auto-sync from this channel
  POLL_INTERVAL=300                      # optional: seconds between RSS checks (default 300)
  MAX_DURATION_SECONDS=75                # optional: ignore videos longer than this (default 75)
  MAX_HEIGHT=1080                        # optional: cap video height for download (default 1080)

Notes:
  • Telegram Bot API upload size is limited (bots). Shorts are usually fine; very large files may fail.
  • Respect YouTube/Telegram Terms and copyright. Only re-share content you have rights to.
"""
from __future__ import annotations

import asyncio
import contextlib
import dataclasses
import json
import os
import re
import tempfile
import time
from pathlib import Path
from typing import Optional, Dict, Any

import feedparser
from dotenv import load_dotenv
from telegram import Update
from telegram.constants import ParseMode
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes

from yt_dlp import YoutubeDL


load_dotenv()

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
TARGET_CHAT_ID = os.getenv("TARGET_CHAT_ID", "").strip()  # used in auto-sync mode
YT_CHANNEL_ID = os.getenv("YT_CHANNEL_ID", "").strip()
POLL_INTERVAL = int(os.getenv("POLL_INTERVAL", "300"))
MAX_DURATION_SECONDS = int(os.getenv("MAX_DURATION_SECONDS", "75"))
MAX_HEIGHT = int(os.getenv("MAX_HEIGHT", "1080"))
STATE_FILE = Path(os.getenv("STATE_FILE", ".yt_shorts_state.json"))

YDL_OPTS_BASE = {
    "quiet": True,
    "noprogress": True,
    "restrictfilenames": True,
    "outtmpl": "%(id)s.%(ext)s",
    "postprocessors": [
        {"key": "FFmpegVideoConvertor", "preferedformat": "mp4"},  # ensure mp4
    ],
}


def human(s: int) -> str:
    m, s = divmod(int(s), 60)
    h, m = divmod(m, 60)
    if h:
        return f"{h:d}:{m:02d}:{s:02d}"
    return f"{m:d}:{s:02d}"


@dataclasses.dataclass
class Video:
    id: str
    title: str
    duration: int
    uploader: str
    url: str
    filepath: Path


def is_youtube_url(url: str) -> bool:
    return bool(re.search(r"(youtube\.com|youtu\.be)", url))


def build_format_selector(max_height: int) -> str:
    # Prefer mp4 up to max_height, fallback to best <= max_height, then best
    return f"bestvideo[ext=mp4][height<={max_height}]+bestaudio[ext=m4a]/best[ext=mp4][height<={max_height}]/best[height<={max_height}]/best"


def ytdl_extract(url: str, max_height: int) -> Dict[str, Any]:
    opts = {
        **YDL_OPTS_BASE,
        "format": build_format_selector(max_height),
    }
    with YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
    return info


def ytdl_download(info: Dict[str, Any]) -> Path:
    opts = {
        **YDL_OPTS_BASE,
        "format": build_format_selector(MAX_HEIGHT),
        "outtmpl": f"%(id)s.%(ext)s",
    }
    with YoutubeDL(opts) as ydl:
        res = ydl.process_ie_result(info, download=True)
        filename = ydl.prepare_filename(res)
    # Ensure mp4 extension after postprocess
    p = Path(filename)
    if p.suffix.lower() != ".mp4":
        alt = p.with_suffix(".mp4")
        if alt.exists():
            p = alt
    return p


async def send_video(context: ContextTypes.DEFAULT_TYPE, chat_id: str | int, video: Video) -> None:
    caption = (
        f"<b>{video.title}</b>\n"
        f"⏱ {human(video.duration)}  •  👤 {video.uploader}\n"
        f"\n<a href='{video.url}'>YouTube</a>"
    )
    await context.bot.send_video(
        chat_id=chat_id,
        video=video.filepath.read_bytes(),
        supports_streaming=True,
        caption=caption[:1024],
        parse_mode=ParseMode.HTML,
    )


def to_video(info: Dict[str, Any], filepath: Path) -> Video:
    return Video(
        id=str(info.get("id")),
        title=str(info.get("title", "(no title)")),
        duration=int(info.get("duration") or 0),
        uploader=str(info.get("uploader") or info.get("channel") or ""),
        url=str(info.get("webpage_url")),
        filepath=filepath,
    )


async def handle_short(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not update.message:
        return
    if not context.args:
        await update.message.reply_text("Использование: /short <ссылка на YouTube Shorts>")
        return

    url = context.args[0].strip()
    if not is_youtube_url(url):
        await update.message.reply_text("Дай ссылку на YouTube.")
        return

    await update.message.reply_text("Скачиваю…")
    try:
        info = ytdl_extract(url, MAX_HEIGHT)
        duration = int(info.get("duration") or 0)
        if duration and duration > MAX_DURATION_SECONDS:
            await update.message.reply_text(
                f"Это видео {human(duration)} — длиннее лимита {MAX_DURATION_SECONDS}s. Пропускаю."
            )
            return
        path = ytdl_download(info)
        video = to_video(info, path)
        await send_video(context, update.effective_chat.id, video)
        await update.message.reply_text("Готово ✅")
    except Exception as e:
        await update.message.reply_text(f"Ошибка: {e}")
    finally:
        with contextlib.suppress(Exception):
            # clean up downloaded files
            for f in Path.cwd().glob(f"{info.get('id','*')}.*"):
                f.unlink(missing_ok=True)


# --- Auto-sync from a channel RSS ---

def rss_url(channel_id: str) -> str:
    return f"https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}"


def load_state() -> Dict[str, float]:
    if STATE_FILE.exists():
        with STATE_FILE.open("r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_state(state: Dict[str, float]) -> None:
    with STATE_FILE.open("w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)


async def sync_loop(app: Application) -> None:
    if not (YT_CHANNEL_ID and TARGET_CHAT_ID):
        return
    state = load_state()
    url = rss_url(YT_CHANNEL_ID)
    print(f"[sync] watching {url}")
    while True:
        try:
            feed = feedparser.parse(url)
            entries = feed.entries or []
            # newest first
            entries.sort(key=lambda e: e.get("published_parsed") or time.gmtime(0))
            for e in entries:
                vid_id = e.get("yt_videoid") or e.get("id")
                if not vid_id or state.get(vid_id):
                    continue
                watch_url = f"https://www.youtube.com/watch?v={vid_id}"
                # probe
                info = ytdl_extract(watch_url, MAX_HEIGHT)
                duration = int(info.get("duration") or 0)
                if duration and duration > MAX_DURATION_SECONDS:
                    state[vid_id] = time.time()
                    continue
                path = ytdl_download(info)
                video = to_video(info, path)
                await send_video(app.bot, TARGET_CHAT_ID, video)
                state[vid_id] = time.time()
                save_state(state)
                with contextlib.suppress(Exception):
                    for f in Path.cwd().glob(f"{video.id}.*"):
                        f.unlink(missing_ok=True)
                print(f"[sync] posted {video.id} {video.title}")
        except Exception as e:
            print("[sync] error:", e)
        await asyncio.sleep(POLL_INTERVAL)


async def start_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text(
        "Привет! Пришли /short <url> чтобы выгрузить Shorts в чат.\n"
        "Могу ещё автосинхронизировать канал (env YT_CHANNEL_ID, TARGET_CHAT_ID)."
    )


async def unknown(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if update.message:
        await update.message.reply_text("Не знаю такую команду. Используй /short <url>.")


async def main() -> None:
    if not TELEGRAM_BOT_TOKEN:
        raise SystemExit("Set TELEGRAM_BOT_TOKEN env var")

    app = Application.builder().token(TELEGRAM_BOT_TOKEN).build()
    app.add_handler(CommandHandler("start", start_cmd))
    app.add_handler(CommandHandler("short", handle_short))
    app.add_handler(MessageHandler(filters.COMMAND, unknown))

    # run background sync if configured
    if YT_CHANNEL_ID and TARGET_CHAT_ID:
        app.create_task(sync_loop(app))

    print("Bot is running…")
    await app.run_polling(close_loop=False)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
