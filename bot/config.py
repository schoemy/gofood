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


@dataclass
class Settings:
    # ───── Telegram ─────
    telegram_bot_token: str = os.getenv("TELEGRAM_BOT_TOKEN", "")
    telegram_chat_id: str = os.getenv("TELEGRAM_CHAT_ID", "")

    # ───── Exchange (ccxt) ─────
    exchange_id: str = os.getenv("EXCHANGE_ID", "kraken")
    market_type: str = os.getenv("MARKET_TYPE", "auto")
    fallback_exchanges: List[str] = field(default_factory=lambda: [
        s.strip() for s in os.getenv(
            "FALLBACK_EXCHANGES",
            "kraken,mexc,bingx,bitget,coinbase"
        ).split(",") if s.strip()
    ])

    # ───── Scanner ─────
    watchlist: List[str] = field(default_factory=lambda: [
        s.strip() for s in os.getenv(
            "WATCHLIST",
            "BTC/USDT:USDT,ETH/USDT:USDT,BNB/USDT:USDT,SOL/USDT:USDT,PYTH/USDT:USDT"
        ).split(",") if s.strip()
    ])
    timeframes: List[str] = field(default_factory=lambda: [
        s.strip() for s in os.getenv("TIMEFRAMES", "30m,1h,4h").split(",") if s.strip()
    ])
    lookback: int = int(os.getenv("LOOKBACK", "300"))
    poll_interval: int = int(os.getenv("POLL_INTERVAL", "60"))

    # ───── Indicator defaults ─────
    atr_length: int = int(os.getenv("ATR_LENGTH", "10"))
    atr_mult: float = float(os.getenv("ATR_MULT", "3.0"))

    # RSI filter
    rsi_length: int = int(os.getenv("RSI_LENGTH", "14"))
    rsi_long_min: float = float(os.getenv("RSI_LONG_MIN", "50"))
    rsi_short_max: float = float(os.getenv("RSI_SHORT_MAX", "50"))
    use_rsi_filter: bool = os.getenv("USE_RSI_FILTER", "true").lower() == "true"

    # MACD confluence filter
    use_macd_filter: bool = os.getenv("USE_MACD_FILTER", "false").lower() == "true"
    macd_fast: int = int(os.getenv("MACD_FAST", "12"))
    macd_slow: int = int(os.getenv("MACD_SLOW", "26"))
    macd_signal: int = int(os.getenv("MACD_SIGNAL", "9"))

    # EMA 200 trend confluence filter
    use_ema_filter: bool = os.getenv("USE_EMA_FILTER", "false").lower() == "true"
    ema_length: int = int(os.getenv("EMA_LENGTH", "200"))

    # TP multipliers (× ATR) and SL
    tp_multipliers: List[float] = field(default_factory=lambda: [
        float(x) for x in os.getenv("TP_MULTIPLIERS", "1,2,3,4").split(",")
    ])
    sl_multiplier: float = float(os.getenv("SL_MULTIPLIER", "1.5"))

    # Pre-signal
    pre_signal_threshold: float = float(os.getenv("PRE_SIGNAL_THRESHOLD", "0.3"))
    enable_pre_signal: bool = os.getenv("ENABLE_PRE_SIGNAL", "true").lower() == "true"

    # ───── State / dedup ─────
    state_file: str = os.getenv("STATE_FILE", "bot_state.json")


settings = Settings()
