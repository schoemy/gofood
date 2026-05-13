"""
Configuration for GG-Shot Signal Scanner.

All sensitive values are pulled from environment variables (.env file).
Adjust WATCHLIST / TIMEFRAMES / indicator defaults below as needed.
"""

import os
from dataclasses import dataclass, field
from typing import List

from dotenv import load_dotenv

load_dotenv()


def _default_market_type(exchange_id: str, override: str) -> str:
    """
    Map MARKET_TYPE to the ccxt option the exchange expects.
    - Bybit/OKX USDT perpetuals are 'swap', not 'future'
    - Binance uses 'future' for USDT-M perp
    """
    if override and override not in ("auto", ""):
        return override
    if exchange_id in ("bybit", "okx", "kucoinfutures", "gate", "bitget"):
        return "swap"
    return "future"


@dataclass
class Settings:
    # ───── Telegram ─────
    telegram_bot_token: str = os.getenv("TELEGRAM_BOT_TOKEN", "")
    telegram_chat_id: str = os.getenv("TELEGRAM_CHAT_ID", "")

    # ───── Exchange (ccxt) ─────
    exchange_id: str = os.getenv("EXCHANGE_ID", "binance")
    # 'auto' picks the right value per exchange; 'future'/'swap'/'spot' to force
    market_type: str = _default_market_type(
        os.getenv("EXCHANGE_ID", "binance"),
        os.getenv("MARKET_TYPE", "auto"),
    )

    # ───── Scanner ─────
    # Symbols in ccxt format, e.g. "PYTH/USDT" for spot or "PYTH/USDT:USDT" for perp
    watchlist: List[str] = field(default_factory=lambda: [
        s.strip() for s in os.getenv(
            "WATCHLIST",
            "BTC/USDT:USDT,ETH/USDT:USDT,SOL/USDT:USDT,PYTH/USDT:USDT"
        ).split(",") if s.strip()
    ])
    timeframes: List[str] = field(default_factory=lambda: [
        s.strip() for s in os.getenv("TIMEFRAMES", "30m,1h,4h").split(",") if s.strip()
    ])
    # How many candles to fetch per symbol/timeframe
    lookback: int = int(os.getenv("LOOKBACK", "300"))
    # Poll interval (seconds). 60 is a good default for 30m+ timeframes.
    poll_interval: int = int(os.getenv("POLL_INTERVAL", "60"))

    # ───── Indicator defaults ─────
    atr_length: int = int(os.getenv("ATR_LENGTH", "10"))
    atr_mult: float = float(os.getenv("ATR_MULT", "3.0"))
    rsi_length: int = int(os.getenv("RSI_LENGTH", "14"))
    rsi_long_min: float = float(os.getenv("RSI_LONG_MIN", "50"))
    rsi_short_max: float = float(os.getenv("RSI_SHORT_MAX", "50"))
    use_rsi_filter: bool = os.getenv("USE_RSI_FILTER", "true").lower() == "true"

    # TP multipliers (× ATR) and SL
    tp_multipliers: List[float] = field(default_factory=lambda: [
        float(x) for x in os.getenv("TP_MULTIPLIERS", "1,2,3,4").split(",")
    ])
    sl_multiplier: float = float(os.getenv("SL_MULTIPLIER", "1.5"))

    # Pre-signal distance threshold (× ATR)
    pre_signal_threshold: float = float(os.getenv("PRE_SIGNAL_THRESHOLD", "0.3"))
    enable_pre_signal: bool = os.getenv("ENABLE_PRE_SIGNAL", "true").lower() == "true"

    # ───── State / dedup ─────
    state_file: str = os.getenv("STATE_FILE", "bot_state.json")


settings = Settings()
