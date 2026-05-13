"""
GG-Shot Scanner — main entrypoint.

Loops over watchlist × timeframes, pulls OHLCV from the exchange via ccxt,
runs the indicator engine, and dispatches any fresh signal to Telegram.
Signals are deduplicated via a local JSON state file.

Usage:
    python -m bot.scanner              # run forever
    python -m bot.scanner --once       # single scan, useful for cron

Environment variables (see .env.example):
    TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
    EXCHANGE_ID (default: binance)
    WATCHLIST (comma-separated ccxt symbols)
    TIMEFRAMES (e.g. 30m,1h,4h)
"""

import argparse
import json
import logging
import os
import sys
import time
from pathlib import Path
from typing import Set

import ccxt
import pandas as pd

from bot import telegram
from bot.config import settings
from bot.indicators import Signal, analyze

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(name)s: %(message)s",
)
log = logging.getLogger("scanner")


# ─────────────────────────── State (dedup) ────────────────────────────

def load_state(path: str) -> Set[str]:
    p = Path(path)
    if not p.exists():
        return set()
    try:
        return set(json.loads(p.read_text()).get("sent", []))
    except (json.JSONDecodeError, OSError):
        return set()


def save_state(path: str, sent: Set[str]) -> None:
    # Keep at most the most recent 2000 keys to bound file size
    trimmed = list(sent)[-2000:]
    Path(path).write_text(json.dumps({"sent": trimmed}))


# ─────────────────────────── Exchange helper ──────────────────────────

def make_exchange():
    klass = getattr(ccxt, settings.exchange_id)
    params = {"enableRateLimit": True}
    if settings.market_type == "future":
        params["options"] = {"defaultType": "future"}
    return klass(params)


def fetch_ohlcv(exchange, symbol: str, timeframe: str, limit: int) -> pd.DataFrame:
    raw = exchange.fetch_ohlcv(symbol, timeframe=timeframe, limit=limit)
    df = pd.DataFrame(raw, columns=["ts", "open", "high", "low", "close", "volume"])
    df["ts"] = pd.to_datetime(df["ts"], unit="ms", utc=True)
    df = df.set_index("ts")
    return df


# ─────────────────────────── Scan loop ────────────────────────────────

def scan_once(exchange, sent_keys: Set[str]) -> None:
    for symbol in settings.watchlist:
        for tf in settings.timeframes:
            try:
                df = fetch_ohlcv(exchange, symbol, tf, settings.lookback)
            except Exception as e:
                log.warning("fetch %s %s failed: %s", symbol, tf, e)
                continue

            sig: Signal = analyze(
                df, symbol, tf,
                atr_length=settings.atr_length,
                atr_mult=settings.atr_mult,
                rsi_length=settings.rsi_length,
                use_rsi_filter=settings.use_rsi_filter,
                rsi_long_min=settings.rsi_long_min,
                rsi_short_max=settings.rsi_short_max,
                tp_multipliers=settings.tp_multipliers,
                sl_multiplier=settings.sl_multiplier,
                pre_signal_threshold=settings.pre_signal_threshold,
                enable_pre_signal=settings.enable_pre_signal,
            )
            if sig is None:
                continue
            if sig.key in sent_keys:
                continue

            log.info("SIGNAL %s %s %s @ %.5f", sig.symbol, sig.timeframe,
                     sig.direction, sig.entry)
            ok = telegram.send_signal(
                settings.telegram_bot_token,
                settings.telegram_chat_id,
                sig,
            )
            if ok:
                sent_keys.add(sig.key)
                save_state(settings.state_file, sent_keys)


def main():
    parser = argparse.ArgumentParser(description="GG-Shot Signal Scanner")
    parser.add_argument("--once", action="store_true",
                        help="Run a single scan then exit (for cron).")
    args = parser.parse_args()

    if not settings.telegram_bot_token or not settings.telegram_chat_id:
        log.warning("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — signals will only print to stdout.")

    exchange = make_exchange()
    log.info("Exchange: %s (%s)  Watchlist: %s  Timeframes: %s",
             settings.exchange_id, settings.market_type,
             settings.watchlist, settings.timeframes)

    sent_keys = load_state(settings.state_file)

    if args.once:
        scan_once(exchange, sent_keys)
        return

    while True:
        try:
            scan_once(exchange, sent_keys)
        except KeyboardInterrupt:
            log.info("Interrupted, exiting.")
            sys.exit(0)
        except Exception:
            log.exception("Scan cycle crashed; sleeping and retrying.")
        time.sleep(settings.poll_interval)


if __name__ == "__main__":
    main()
