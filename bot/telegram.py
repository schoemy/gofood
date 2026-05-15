"""
Telegram delivery layer. Formats signals to look similar to the
classic GG-Shot alert message and sends via Bot API (HTTPS).
"""

import logging
from typing import Optional

import requests

from bot.indicators import Signal

log = logging.getLogger(__name__)

TELEGRAM_API = "https://api.telegram.org/bot{token}/sendMessage"


def _fmt_price(p: float) -> str:
    # Dynamic precision based on magnitude
    if p >= 100:
        return f"{p:.2f}"
    if p >= 1:
        return f"{p:.4f}"
    return f"{p:.5f}"


def _confidence_bar(score: int) -> str:
    """Visual confidence bar + label. Score 0-100."""
    filled = score // 10
    empty = 10 - filled
    bar = "🟩" * filled + "⬜" * empty

    if score >= 80:
        label = "VERY STRONG"
    elif score >= 60:
        label = "STRONG"
    elif score >= 40:
        label = "MODERATE"
    elif score >= 25:
        label = "WEAK"
    else:
        label = "VERY WEAK"

    return f"{bar} {score}% ({label})"


def format_signal(sig: Signal) -> str:
    is_pre = sig.direction.startswith("PRE_")
    side = "LONG" if sig.direction.endswith("LONG") else "SHORT"
    arrow = "📈" if side == "LONG" else "📉"

    if is_pre:
        header = f"⚠️ <b>GET READY TO {side}</b>"
    else:
        header = f"{arrow} <b>{side} SIGNAL</b>"

    tps = "\n".join(
        f"Target {i+1}:  <code>{_fmt_price(tp)}</code>"
        for i, tp in enumerate(sig.take_profits)
    )

    # The classic "Short Entry Zone" band: between entry and trend line
    if side == "SHORT":
        zone_lo, zone_hi = sig.entry, sig.trend_line
    else:
        zone_lo, zone_hi = sig.trend_line, sig.entry

    symbol_tag = "#" + sig.symbol.split("/")[0].replace(":", "") + "USDT"

    # Confluence line — only show fields that were actually computed
    conf_parts = [f"RSI: <code>{sig.rsi:.1f}</code>"]
    if sig.confluence:
        if "macd_hist" in sig.confluence:
            conf_parts.append(f"MACD hist: <code>{sig.confluence['macd_hist']}</code>")
        for k, v in sig.confluence.items():
            if k.startswith("ema_"):
                conf_parts.append(f"{k.upper()}: <code>{_fmt_price(float(v))}</code>")

    msg = (
        f"📩 {symbol_tag} {sig.timeframe} | Mid-Term\n"
        f"{header}\n"
        f"{arrow} Entry Zone: <code>{_fmt_price(min(zone_lo, zone_hi))}"
        f" - {_fmt_price(max(zone_lo, zone_hi))}</code>\n\n"
        f"⏳ <b>Signal details:</b>\n"
        f"{tps}\n"
        f"_____\n"
        f"🧲 Trend-Line: <code>{_fmt_price(sig.trend_line)}</code>\n"
        f"❌ Stop-Loss: <code>{_fmt_price(sig.stop_loss)}</code>\n"
        f"📊 ATR: <code>{_fmt_price(sig.atr)}</code>  |  {'  |  '.join(conf_parts)}\n"
        f"🎯 Confidence: <b>{_confidence_bar(sig.confidence)}</b>\n"
        f"💡 After TP1, move the rest of the position to breakeven."
    )
    return msg


def send_message(token: str, chat_id: str, text: str) -> bool:
    """
    Send a message to one or multiple Telegram chat IDs.
    chat_id can be a single ID or comma-separated list:
        "123456789"
        "123456789,-1001234567890,@ggshot_signals"
    """
    if not token or not chat_id:
        log.warning("Telegram credentials missing; printing message instead:\n%s", text)
        return False

    # Support multiple chat IDs separated by comma
    chat_ids = [cid.strip() for cid in chat_id.split(",") if cid.strip()]
    success = False

    for cid in chat_ids:
        try:
            resp = requests.post(
                TELEGRAM_API.format(token=token),
                json={
                    "chat_id": cid,
                    "text": text,
                    "parse_mode": "HTML",
                    "disable_web_page_preview": True,
                },
                timeout=15,
            )
            resp.raise_for_status()
            success = True
        except requests.RequestException as e:
            log.error("Telegram send to %s failed: %s", cid, e)

    return success


def send_signal(token: str, chat_id: str, sig: Signal) -> bool:
    return send_message(token, chat_id, format_signal(sig))
