"""
Telegram AI Agent — Interactive chatbot powered by Anthropic Claude API.

This module creates a Telegram bot that listens for incoming messages and
responds using the Claude AI model via a custom API endpoint. It supports:

- Conversational memory (per-chat session history)
- System prompt customization for crypto/trading context
- Command handling (/start, /clear, /help, /status)
- Markdown formatting for Telegram
- Rate limiting protection
- Graceful error handling

Usage:
    python -m bot.ai_agent
"""

import logging
import os
import time
import json
import signal as sig_module
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Dict, List, Optional

import requests
from dotenv import load_dotenv

load_dotenv()

log = logging.getLogger("ai_agent")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(name)s: %(message)s",
)

# ─────────────────────────── Configuration ────────────────────────────


@dataclass
class AIAgentConfig:
    """Configuration for the AI Agent bot."""
    # Telegram
    telegram_bot_token: str = os.getenv("TELEGRAM_BOT_TOKEN", "")
    # Comma-separated list of allowed chat IDs (empty = allow all)
    allowed_chat_ids: str = os.getenv("AI_AGENT_ALLOWED_CHATS", "")

    # Anthropic / Claude API
    api_base_url: str = os.getenv("AI_API_BASE_URL", "https://www.ccode.dev/v1")
    api_key: str = os.getenv("AI_API_KEY", "")
    model: str = os.getenv("AI_MODEL", "claude-sonnet-4-20250514")
    max_tokens: int = int(os.getenv("AI_MAX_TOKENS", "4096"))
    temperature: float = float(os.getenv("AI_TEMPERATURE", "0.7"))

    # Conversation
    max_history: int = int(os.getenv("AI_MAX_HISTORY", "20"))  # messages per chat
    system_prompt: str = os.getenv("AI_SYSTEM_PROMPT", "")

    # Polling
    poll_timeout: int = int(os.getenv("AI_POLL_TIMEOUT", "30"))
    poll_interval: float = float(os.getenv("AI_POLL_INTERVAL", "0.5"))

    # Rate limiting
    rate_limit_messages: int = int(os.getenv("AI_RATE_LIMIT", "10"))  # per minute
    rate_limit_window: int = 60  # seconds


DEFAULT_SYSTEM_PROMPT = """Kamu adalah AI assistant yang ahli dalam dunia crypto trading dan analisis pasar.
Kamu bisa membantu user dengan:
- Analisis teknikal (candlestick patterns, support/resistance, indicators)
- Penjelasan tentang indikator (RSI, MACD, Supertrend, EMA, Bollinger Bands, dll)
- Strategi trading (scalping, swing trading, DCA, dll)
- Manajemen risiko (position sizing, stop-loss, take-profit)
- Informasi umum tentang cryptocurrency dan blockchain
- Market sentiment dan berita crypto

Jawab dengan bahasa yang mudah dipahami. Gunakan emoji untuk memperjelas poin.
Jika user bertanya diluar topik crypto/trading, tetap jawab dengan ramah.
Selalu ingatkan bahwa ini bukan financial advice - trading mengandung risiko tinggi.

Format jawaban menggunakan HTML tags yang didukung Telegram:
- <b>bold</b> untuk penekanan
- <i>italic</i> untuk istilah
- <code>monospace</code> untuk angka/data
- Gunakan newline untuk memisahkan paragraf"""


# ─────────────────────────── Conversation Store ───────────────────────


class ConversationStore:
    """In-memory conversation history per chat ID."""

    def __init__(self, max_history: int = 20):
        self.max_history = max_history
        self._history: Dict[str, List[dict]] = defaultdict(list)

    def add_message(self, chat_id: str, role: str, content: str) -> None:
        """Add a message to the conversation history."""
        self._history[chat_id].append({"role": role, "content": content})
        # Trim to max_history (keep most recent)
        if len(self._history[chat_id]) > self.max_history:
            self._history[chat_id] = self._history[chat_id][-self.max_history:]

    def get_history(self, chat_id: str) -> List[dict]:
        """Get conversation history for a chat."""
        return self._history[chat_id].copy()

    def clear(self, chat_id: str) -> None:
        """Clear history for a specific chat."""
        self._history[chat_id] = []

    def clear_all(self) -> None:
        """Clear all conversation histories."""
        self._history.clear()


# ─────────────────────────── Rate Limiter ─────────────────────────────


class RateLimiter:
    """Simple per-chat rate limiter."""

    def __init__(self, max_messages: int = 10, window: int = 60):
        self.max_messages = max_messages
        self.window = window
        self._timestamps: Dict[str, List[float]] = defaultdict(list)

    def is_allowed(self, chat_id: str) -> bool:
        """Check if a message is allowed under the rate limit."""
        now = time.time()
        # Remove expired timestamps
        self._timestamps[chat_id] = [
            ts for ts in self._timestamps[chat_id]
            if now - ts < self.window
        ]
        if len(self._timestamps[chat_id]) >= self.max_messages:
            return False
        self._timestamps[chat_id].append(now)
        return True

    def time_until_reset(self, chat_id: str) -> float:
        """Seconds until next message is allowed."""
        if not self._timestamps[chat_id]:
            return 0
        oldest = min(self._timestamps[chat_id])
        return max(0, self.window - (time.time() - oldest))


# ─────────────────────────── Claude API Client ────────────────────────


class ClaudeClient:
    """Client for Anthropic Claude API via custom endpoint."""

    def __init__(self, config: AIAgentConfig):
        self.config = config
        self.base_url = config.api_base_url.rstrip("/")
        self.session = requests.Session()
        self.session.headers.update({
            "x-api-key": config.api_key,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        })

    def chat(self, messages: List[dict], system: str = "") -> Optional[str]:
        """
        Send messages to Claude API and return the response text.
        Uses the Messages API format.
        """
        payload = {
            "model": self.config.model,
            "max_tokens": self.config.max_tokens,
            "temperature": self.config.temperature,
            "messages": messages,
        }

        if system:
            payload["system"] = system

        try:
            url = f"{self.base_url}/messages"
            log.debug("Calling Claude API: %s with %d messages", url, len(messages))

            resp = self.session.post(url, json=payload, timeout=60)
            resp.raise_for_status()

            data = resp.json()
            # Extract text from response content blocks
            content = data.get("content", [])
            if content and len(content) > 0:
                text_parts = []
                for block in content:
                    if block.get("type") == "text":
                        text_parts.append(block["text"])
                return "\n".join(text_parts) if text_parts else None

            return None

        except requests.exceptions.Timeout:
            log.error("Claude API timeout")
            return None
        except requests.exceptions.HTTPError as e:
            log.error("Claude API HTTP error: %s — %s", e, e.response.text[:500] if e.response else "")
            return None
        except requests.exceptions.RequestException as e:
            log.error("Claude API request failed: %s", e)
            return None
        except (KeyError, json.JSONDecodeError) as e:
            log.error("Claude API response parse error: %s", e)
            return None


# ─────────────────────────── Telegram Bot ─────────────────────────────


class TelegramAIBot:
    """Telegram bot that handles incoming messages and responds via Claude AI."""

    TELEGRAM_API = "https://api.telegram.org/bot{token}"

    def __init__(self, config: AIAgentConfig):
        self.config = config
        self.api_url = self.TELEGRAM_API.format(token=config.telegram_bot_token)
        self.claude = ClaudeClient(config)
        self.store = ConversationStore(max_history=config.max_history)
        self.limiter = RateLimiter(
            max_messages=config.rate_limit_messages,
            window=config.rate_limit_window,
        )
        self.system_prompt = config.system_prompt or DEFAULT_SYSTEM_PROMPT
        self._offset = 0
        self._running = False

        # Parse allowed chat IDs
        self._allowed_chats: set = set()
        if config.allowed_chat_ids:
            self._allowed_chats = {
                cid.strip() for cid in config.allowed_chat_ids.split(",")
                if cid.strip()
            }

    def _api_call(self, method: str, **kwargs) -> Optional[dict]:
        """Make a Telegram Bot API call."""
        try:
            resp = requests.post(
                f"{self.api_url}/{method}",
                json=kwargs,
                timeout=self.config.poll_timeout + 10,
            )
            resp.raise_for_status()
            data = resp.json()
            if data.get("ok"):
                return data.get("result")
            log.warning("Telegram API error: %s", data.get("description"))
            return None
        except requests.RequestException as e:
            log.error("Telegram API call failed (%s): %s", method, e)
            return None

    def send_message(self, chat_id: str, text: str, parse_mode: str = "HTML") -> bool:
        """Send a message to a Telegram chat."""
        # Telegram has 4096 char limit per message
        if len(text) > 4000:
            # Split into chunks
            chunks = [text[i:i+4000] for i in range(0, len(text), 4000)]
            for chunk in chunks:
                self._api_call(
                    "sendMessage",
                    chat_id=chat_id,
                    text=chunk,
                    parse_mode=parse_mode,
                    disable_web_page_preview=True,
                )
            return True

        result = self._api_call(
            "sendMessage",
            chat_id=chat_id,
            text=text,
            parse_mode=parse_mode,
            disable_web_page_preview=True,
        )
        return result is not None

    def send_typing(self, chat_id: str) -> None:
        """Send typing indicator."""
        self._api_call("sendChatAction", chat_id=chat_id, action="typing")

    def _is_allowed(self, chat_id: str) -> bool:
        """Check if chat is allowed to use the bot."""
        if not self._allowed_chats:
            return True  # No restrictions
        return chat_id in self._allowed_chats

    def _handle_command(self, chat_id: str, command: str, username: str = "") -> None:
        """Handle bot commands."""
        cmd = command.split()[0].lower().split("@")[0]  # Remove @botname suffix

        if cmd == "/start":
            welcome = (
                f"🤖 <b>Halo{' ' + username if username else ''}!</b>\n\n"
                "Saya adalah AI Assistant untuk crypto trading.\n"
                "Tanyakan apapun tentang:\n\n"
                "📊 Analisis teknikal\n"
                "📈 Indikator (RSI, MACD, EMA, dll)\n"
                "💡 Strategi trading\n"
                "🛡️ Manajemen risiko\n"
                "🪙 Info cryptocurrency\n\n"
                "<b>Commands:</b>\n"
                "/start - Mulai percakapan\n"
                "/clear - Reset riwayat chat\n"
                "/help - Bantuan penggunaan\n"
                "/status - Status bot\n\n"
                "Ketik pesan apapun untuk mulai! 🚀"
            )
            self.send_message(chat_id, welcome)

        elif cmd == "/clear":
            self.store.clear(chat_id)
            self.send_message(chat_id, "🧹 Riwayat percakapan telah direset.\nMulai percakapan baru!")

        elif cmd == "/help":
            help_text = (
                "📖 <b>Cara Penggunaan</b>\n\n"
                "Cukup kirim pesan teks dan saya akan merespons.\n"
                "Saya mengingat konteks percakapan sebelumnya.\n\n"
                "<b>Tips:</b>\n"
                "• Berikan konteks yang jelas untuk jawaban lebih baik\n"
                "• Gunakan /clear jika ingin topik baru\n"
                "• Saya bisa analisis jika Anda kirimkan data harga\n\n"
                "<b>Contoh pertanyaan:</b>\n"
                "• <i>\"Apa itu Supertrend indicator?\"</i>\n"
                "• <i>\"Analisis BTC jika RSI di 72 dan MACD crossing\"</i>\n"
                "• <i>\"Strategi SL/TP untuk scalping 5m\"</i>\n"
                "• <i>\"Jelaskan risk-reward ratio\"</i>\n\n"
                "⚠️ <b>Disclaimer:</b> Bukan financial advice!"
            )
            self.send_message(chat_id, help_text)

        elif cmd == "/status":
            history_count = len(self.store.get_history(chat_id))
            status = (
                "🟢 <b>Bot Status: Online</b>\n\n"
                f"Model: <code>{self.config.model}</code>\n"
                f"Endpoint: <code>{self.config.api_base_url}</code>\n"
                f"Riwayat chat: <code>{history_count}/{self.config.max_history}</code> pesan\n"
                f"Rate limit: <code>{self.config.rate_limit_messages}</code>/menit\n"
                f"Max tokens: <code>{self.config.max_tokens}</code>"
            )
            self.send_message(chat_id, status)

        else:
            self.send_message(chat_id, "❓ Command tidak dikenal. Ketik /help untuk bantuan.")

    def _handle_message(self, chat_id: str, text: str, username: str = "") -> None:
        """Handle a regular text message — send to Claude and reply."""
        # Rate limiting
        if not self.limiter.is_allowed(chat_id):
            wait_time = self.limiter.time_until_reset(chat_id)
            self.send_message(
                chat_id,
                f"⏳ Rate limit tercapai. Coba lagi dalam <code>{int(wait_time)}</code> detik."
            )
            return

        # Send typing indicator
        self.send_typing(chat_id)

        # Add user message to history
        self.store.add_message(chat_id, "user", text)

        # Get conversation history
        messages = self.store.get_history(chat_id)

        # Call Claude API
        response = self.claude.chat(messages, system=self.system_prompt)

        if response:
            # Store assistant response
            self.store.add_message(chat_id, "assistant", response)
            # Send to Telegram
            success = self.send_message(chat_id, response)
            if not success:
                # Retry without parse_mode in case of HTML formatting issues
                self.send_message(chat_id, response, parse_mode="")
        else:
            error_msg = (
                "❌ Maaf, terjadi kesalahan saat memproses pesan Anda.\n"
                "Silakan coba lagi dalam beberapa saat."
            )
            self.send_message(chat_id, error_msg)
            # Remove the failed user message from history
            history = self.store.get_history(chat_id)
            if history and history[-1]["role"] == "user":
                self.store._history[chat_id].pop()

    def _process_update(self, update: dict) -> None:
        """Process a single Telegram update."""
        message = update.get("message")
        if not message:
            return

        chat_id = str(message.get("chat", {}).get("id", ""))
        text = message.get("text", "").strip()
        username = message.get("from", {}).get("first_name", "")

        if not chat_id or not text:
            return

        # Check access
        if not self._is_allowed(chat_id):
            log.info("Blocked message from unauthorized chat: %s", chat_id)
            return

        log.info("Message from %s (chat %s): %s", username, chat_id, text[:100])

        # Handle commands
        if text.startswith("/"):
            self._handle_command(chat_id, text, username)
        else:
            self._handle_message(chat_id, text, username)

    def run(self) -> None:
        """Start the bot with long polling."""
        log.info("Starting AI Agent bot...")
        log.info("Model: %s | Endpoint: %s", self.config.model, self.config.api_base_url)

        if self._allowed_chats:
            log.info("Allowed chats: %s", self._allowed_chats)
        else:
            log.info("No chat restrictions (open to all)")

        # Verify bot token
        me = self._api_call("getMe")
        if not me:
            log.error("Failed to connect to Telegram API. Check your bot token!")
            sys.exit(1)

        bot_name = me.get("username", "unknown")
        log.info("Bot connected: @%s", bot_name)

        self._running = True

        # Graceful shutdown
        def shutdown(signum, frame):
            log.info("Shutting down...")
            self._running = False

        sig_module.signal(sig_module.SIGINT, shutdown)
        sig_module.signal(sig_module.SIGTERM, shutdown)

        # Main polling loop
        while self._running:
            try:
                updates = self._api_call(
                    "getUpdates",
                    offset=self._offset,
                    timeout=self.config.poll_timeout,
                    allowed_updates=["message"],
                )

                if updates:
                    for update in updates:
                        update_id = update.get("update_id", 0)
                        self._offset = update_id + 1
                        try:
                            self._process_update(update)
                        except Exception as e:
                            log.error("Error processing update %d: %s", update_id, e)

            except Exception as e:
                log.error("Polling error: %s", e)
                time.sleep(5)  # Wait before retrying

            time.sleep(self.config.poll_interval)

        log.info("Bot stopped.")


# ─────────────────────────── Entry Point ──────────────────────────────


def main():
    """Main entry point for the AI Agent bot."""
    config = AIAgentConfig()

    if not config.telegram_bot_token:
        log.error("TELEGRAM_BOT_TOKEN not set! Cannot start bot.")
        sys.exit(1)

    if not config.api_key:
        log.error("AI_API_KEY not set! Cannot connect to Claude API.")
        sys.exit(1)

    bot = TelegramAIBot(config)
    bot.run()


if __name__ == "__main__":
    main()
