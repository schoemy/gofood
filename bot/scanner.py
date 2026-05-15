"""
GG-Shot Scanner — main entrypoint.

Loops over watchlist × timeframes, pulls OHLCV via ccxt, runs the indicator
engine, and dispatches any fresh signal to Telegram. Signals are deduplicated
via a local JSON state file.

Exchange selection is resilient: a comma-separated fallback chain is tried in
order until one works. This matters because many large exchanges (Binance,
Bybit, OKX) geoblock the AWS US IPs used by GitHub Actions runners.

Usage:
    python -m bot.scanner              # run forever
    python -m bot.scanner --once       # single scan, useful for cron
"""

import argparse
import json
import logging
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional, Set, Tuple

import ccxt
import pandas as pd

import os

from bot import telegram
from bot.config import settings
from bot.executor import BybitExecutor, ExecutorConfig, format_execution_msg
from bot.indicators import Signal, analyze
from bot.tracker import Ledger, format_resolution, format_stats, resolve_signal

log_level = logging.DEBUG if os.getenv("DEBUG", "").lower() in ("1", "true") else logging.INFO
logging.basicConfig(
    level=log_level,
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
    trimmed = list(sent)[-2000:]
    Path(path).write_text(json.dumps({"sent": trimmed}))


# ─────────────────────────── Exchange helpers ─────────────────────────

# Exchanges that normally accept AWS US IPs (GHA runners). Ordered by
# reliability & OHLCV coverage. We try them in sequence.
DEFAULT_FALLBACK_CHAIN = ["kraken", "mexc", "bingx", "bitget", "coinbase"]

# Default market type per exchange. Some exchanges don't have perps for
# every symbol, so we drop the :USDT suffix and fall back to spot when
# needed (see normalize_symbol below).
MARKET_TYPE_BY_EXCHANGE = {
    "binance": "future",
    "binanceusdm": "future",
    "bybit": "swap",
    "okx": "swap",
    "kucoinfutures": "swap",
    "bitget": "swap",
    "gate": "swap",
    "mexc": "swap",
    "bingx": "swap",
    "kraken": "spot",        # kraken spot has USDT pairs; perps need krakenfutures
    "coinbase": "spot",
}


def normalize_symbol(symbol: str, exchange_id: str, market_type: str) -> str:
    """
    Rewrite ccxt symbol format so spot-only exchanges (kraken/coinbase) work
    with a perp-style watchlist like 'BTC/USDT:USDT'.
    """
    if market_type == "spot" and ":" in symbol:
        return symbol.split(":")[0]
    return symbol


@dataclass
class ExchangeHandle:
    id: str
    market_type: str
    client: "ccxt.Exchange"


def _try_exchange(exchange_id: str, market_type_override: str) -> Optional[ExchangeHandle]:
    """Try to initialize + load_markets() for one exchange. Return None on failure."""
    if not hasattr(ccxt, exchange_id):
        log.warning("ccxt has no exchange '%s'", exchange_id)
        return None

    market_type = (
        market_type_override
        if market_type_override not in ("auto", "")
        else MARKET_TYPE_BY_EXCHANGE.get(exchange_id, "spot")
    )

    params = {"enableRateLimit": True, "timeout": 30000}
    if market_type in ("future", "swap"):
        params["options"] = {"defaultType": market_type}

    klass = getattr(ccxt, exchange_id)
    try:
        ex = klass(params)
        ex.load_markets()
        log.info("✓ Exchange OK: %s (%s) — %d markets", exchange_id, market_type, len(ex.markets))
        return ExchangeHandle(id=exchange_id, market_type=market_type, client=ex)
    except Exception as e:
        # Most common reason: 403 CloudFront geoblock. Log short form so chain stays readable.
        msg = str(e)
        if len(msg) > 200:
            msg = msg[:200] + "..."
        log.warning("✗ Exchange %s (%s) failed: %s", exchange_id, market_type, msg)
        return None


def select_exchange() -> ExchangeHandle:
    """
    Try EXCHANGE_ID first, then fall through FALLBACK_EXCHANGES.
    Raises RuntimeError if none work.
    """
    tried = []
    candidates: list[str] = []

    if settings.exchange_id:
        candidates.append(settings.exchange_id)

    for ex_id in settings.fallback_exchanges or DEFAULT_FALLBACK_CHAIN:
        if ex_id and ex_id not in candidates:
            candidates.append(ex_id)

    for ex_id in candidates:
        tried.append(ex_id)
        handle = _try_exchange(ex_id, settings.market_type)
        if handle is not None:
            return handle

    raise RuntimeError(
        f"No usable exchange. Tried: {tried}. Most likely cause is "
        "geoblocking (403 CloudFront) on all candidates."
    )


def fetch_ohlcv(exchange: "ccxt.Exchange", symbol: str, timeframe: str, limit: int) -> pd.DataFrame:
    raw = exchange.fetch_ohlcv(symbol, timeframe=timeframe, limit=limit)
    df = pd.DataFrame(raw, columns=["ts", "open", "high", "low", "close", "volume"])
    df["ts"] = pd.to_datetime(df["ts"], unit="ms", utc=True)
    df = df.set_index("ts")
    return df


# ─────────────────────────── Scan loop ────────────────────────────────

def scan_once(handle: ExchangeHandle, sent_keys: Set[str], ledger: "Ledger",
              executor: Optional["BybitExecutor"] = None) -> None:
    scanned = 0
    errors = 0
    signals = 0
    resolutions = 0

    for raw_symbol in settings.watchlist:
        symbol = normalize_symbol(raw_symbol, handle.id, handle.market_type)
        if symbol not in handle.client.markets:
            log.info("skip %s: not listed on %s", symbol, handle.id)
            continue

        for tf in settings.timeframes:
            try:
                df = fetch_ohlcv(handle.client, symbol, tf, settings.lookback)
                scanned += 1
            except Exception as e:
                errors += 1
                log.warning("fetch %s %s failed: %s", symbol, tf, e)
                continue

            # ── Resolve any previously-open signals for this symbol/tf ──
            # Compare base symbol (strip :USDT suffix) to handle exchange switches
            base_symbol = symbol.split(":")[0]
            for ts in ledger.open_signals():
                ts_base = ts.symbol.split(":")[0]
                if ts_base != base_symbol or ts.timeframe != tf:
                    continue
                try:
                    log.info("Attempting resolve: %s (entry=%.5f, TP1=%.5f, SL=%.5f, dir=%s, "
                             "signal_ts=%d, df_last=%s, high=%.5f, low=%.5f)",
                             ts.key, ts.entry,
                             ts.take_profits[0] if ts.take_profits else 0,
                             ts.stop_loss, ts.direction, ts.created_ts,
                             str(df.index[-1]) if len(df) > 0 else "?",
                             float(df["high"].iloc[-1]) if len(df) > 0 else 0,
                             float(df["low"].iloc[-1]) if len(df) > 0 else 0)
                    if resolve_signal(ts, df):
                        resolutions += 1
                        log.info("RESOLVED %s -> %s", ts.key, ts.status)
                        telegram.send_message(
                            settings.telegram_bot_token,
                            settings.telegram_chat_id,
                            format_resolution(ts),
                        )
                except Exception as e:
                    log.warning("resolve error for %s: %s", ts.key, e)

            try:
                sig: Optional[Signal] = analyze(
                    df, symbol, tf,
                    atr_length=settings.atr_length,
                    atr_mult=settings.atr_mult,
                    rsi_length=settings.rsi_length,
                    use_rsi_filter=settings.use_rsi_filter,
                    rsi_long_min=settings.rsi_long_min,
                    rsi_short_max=settings.rsi_short_max,
                    use_macd_filter=settings.use_macd_filter,
                    macd_fast=settings.macd_fast,
                    macd_slow=settings.macd_slow,
                    macd_signal=settings.macd_signal,
                    use_ema_filter=settings.use_ema_filter,
                    ema_length=settings.ema_length,
                    tp_multipliers=settings.tp_multipliers,
                    sl_multiplier=settings.sl_multiplier,
                    sl_mode=settings.sl_mode,
                    sl_buffer_atr=settings.sl_buffer_atr,
                    pre_signal_threshold=settings.pre_signal_threshold,
                    enable_pre_signal=settings.enable_pre_signal,
                )
            except Exception as e:
                errors += 1
                log.warning("analyze %s %s failed: %s", symbol, tf, e)
                continue

            if sig is None or sig.key in sent_keys:
                continue

            signals += 1
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
                ledger.add(sig)
                ledger.save()

                # Auto-execute trade on Bybit if executor is enabled
                if executor and executor.config.enabled:
                    trade_ok = executor.execute_signal(sig)
                    exec_msg = format_execution_msg(sig, trade_ok, executor.config.testnet)
                    telegram.send_message(
                        settings.telegram_bot_token,
                        settings.telegram_chat_id,
                        exec_msg,
                    )

    # Persist ledger after resolutions
    if resolutions > 0:
        ledger.save()

    stats = ledger.stats()
    open_count = len(ledger.open_signals())
    log.info("Scan complete on %s: %d pairs scanned, %d signals, %d resolved, %d errors",
             handle.id, scanned, signals, resolutions, errors)
    if stats.get("total", 0) > 0:
        log.info("Ledger stats: total=%d  TP1+=%d (%.1f%%)  SL=%d",
                 stats["total"], stats["tp1_plus"], stats["tp1_winrate"], stats["sl"])
    # Always report stats to Telegram (including open signal count)
    if stats.get("total", 0) > 0 or open_count > 0:
        stats_msg = format_stats(stats, open_count)
        if stats_msg:
            telegram.send_message(
                settings.telegram_bot_token,
                settings.telegram_chat_id,
                stats_msg,
            )

    # Report live trade PnL from Bybit if executor is active
    if executor and executor.config.enabled:
        pnl_msg = executor.get_pnl_summary()
        if pnl_msg:
            telegram.send_message(
                settings.telegram_bot_token,
                settings.telegram_chat_id,
                pnl_msg,
            )


def main():
    parser = argparse.ArgumentParser(description="GG-Shot Signal Scanner")
    parser.add_argument("--once", action="store_true",
                        help="Run a single scan then exit (for cron).")
    args = parser.parse_args()

    log.info("ccxt %s  pandas %s", ccxt.__version__, pd.__version__)

    if not settings.telegram_bot_token or not settings.telegram_chat_id:
        log.warning("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — signals will only print to stdout.")

    try:
        handle = select_exchange()
    except Exception:
        log.exception("Could not initialize any exchange — aborting.")
        sys.exit(1)

    log.info("Using exchange: %s (%s)  Watchlist: %s  Timeframes: %s",
             handle.id, handle.market_type, settings.watchlist, settings.timeframes)

    sent_keys = load_state(settings.state_file)
    ledger = Ledger(settings.ledger_file)
    log.info("Loaded ledger: %d total signals, %d still open",
             len(ledger.signals), len(ledger.open_signals()))

    # Initialize Bybit executor (auto-trade)
    executor = None
    if settings.executor_enabled:
        exec_config = ExecutorConfig(
            enabled=settings.executor_enabled,
            api_key=settings.bybit_api_key,
            api_secret=settings.bybit_api_secret,
            order_size_usdt=settings.order_size_usdt,
            use_percent_balance=settings.use_percent_balance,
            percent_balance=settings.percent_balance,
            leverage=settings.leverage,
            max_position_usdt=settings.max_position_usdt,
            max_concurrent_positions=settings.max_concurrent_positions,
            use_tp1_only=settings.use_tp1_only,
            set_sl=settings.executor_set_sl,
            testnet=settings.bybit_testnet,
        )
        executor = BybitExecutor(exec_config)
        if executor.config.enabled:
            log.info("Executor ACTIVE: %s, size=%.1f USDT, leverage=%dx",
                     "TESTNET" if exec_config.testnet else "LIVE",
                     exec_config.order_size_usdt, exec_config.leverage)

    if args.once:
        scan_once(handle, sent_keys, ledger, executor)
        return

    while True:
        try:
            scan_once(handle, sent_keys, ledger, executor)
        except KeyboardInterrupt:
            log.info("Interrupted, exiting.")
            sys.exit(0)
        except Exception:
            log.exception("Scan cycle crashed; sleeping and retrying.")
        time.sleep(settings.poll_interval)


if __name__ == "__main__":
    main()
