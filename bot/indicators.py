"""
Indicator engine: Supertrend + ATR take-profit ladder + optional RSI filter.

The logic mirrors the Pine Script GG-Shot clone so signals are consistent
across TradingView and this Python scanner.
"""

from dataclasses import dataclass
from typing import List, Optional

import pandas as pd
import pandas_ta as ta


@dataclass
class Signal:
    symbol: str
    timeframe: str
    direction: str           # "LONG" | "SHORT" | "PRE_LONG" | "PRE_SHORT"
    entry: float
    stop_loss: float
    take_profits: List[float]
    trend_line: float
    atr: float
    rsi: float
    timestamp: pd.Timestamp
    # Unique key for dedup — includes the candle timestamp so a flip on the
    # same candle only fires once.
    key: str = ""

    def __post_init__(self):
        self.key = f"{self.symbol}|{self.timeframe}|{self.direction}|{int(self.timestamp.timestamp())}"


def compute_supertrend(df: pd.DataFrame, length: int, multiplier: float) -> pd.DataFrame:
    """Add supertrend columns. Returns the same df with SUPERT/SUPERTd."""
    st = ta.supertrend(high=df["high"], low=df["low"], close=df["close"],
                       length=length, multiplier=multiplier)
    # pandas_ta columns: SUPERT_{length}_{mult}, SUPERTd_{length}_{mult}
    supert_col = f"SUPERT_{length}_{multiplier}"
    direction_col = f"SUPERTd_{length}_{multiplier}"
    df["supertrend"] = st[supert_col]
    df["st_dir"] = st[direction_col]   # 1 = uptrend, -1 = downtrend
    return df


def analyze(
    df: pd.DataFrame,
    symbol: str,
    timeframe: str,
    *,
    atr_length: int = 10,
    atr_mult: float = 3.0,
    rsi_length: int = 14,
    use_rsi_filter: bool = True,
    rsi_long_min: float = 50,
    rsi_short_max: float = 50,
    tp_multipliers: Optional[List[float]] = None,
    sl_multiplier: float = 1.5,
    pre_signal_threshold: float = 0.3,
    enable_pre_signal: bool = True,
) -> Optional[Signal]:
    """
    Analyze the latest CLOSED candle and return a Signal if a flip or
    pre-signal condition is met. Returns None otherwise.

    Expects a DataFrame indexed by timestamp with columns:
    open, high, low, close, volume.
    """
    if tp_multipliers is None:
        tp_multipliers = [1.0, 2.0, 3.0, 4.0]

    if len(df) < max(atr_length, rsi_length) + 5:
        return None

    df = df.copy()
    compute_supertrend(df, atr_length, atr_mult)
    df["atr"] = ta.atr(df["high"], df["low"], df["close"], length=atr_length)
    df["rsi"] = ta.rsi(df["close"], length=rsi_length)

    # Use last CLOSED candle (index -2). The live candle is -1 and still forming.
    last = df.iloc[-2]
    prev = df.iloc[-3]

    if pd.isna(last["supertrend"]) or pd.isna(last["atr"]):
        return None

    close = float(last["close"])
    atr = float(last["atr"])
    rsi = float(last["rsi"]) if not pd.isna(last["rsi"]) else 50.0
    trend = float(last["supertrend"])
    direction_now = int(last["st_dir"])
    direction_prev = int(prev["st_dir"])

    flip_long = direction_now == 1 and direction_prev == -1
    flip_short = direction_now == -1 and direction_prev == 1

    long_ok = (not use_rsi_filter) or rsi > rsi_long_min
    short_ok = (not use_rsi_filter) or rsi < rsi_short_max

    def build(direction: str, is_pre: bool = False) -> Signal:
        sign = 1 if direction.endswith("LONG") else -1
        entry = close
        tps = [entry + sign * m * atr for m in tp_multipliers]
        sl = entry - sign * sl_multiplier * atr
        label = direction if not is_pre else f"PRE_{direction}"
        return Signal(
            symbol=symbol,
            timeframe=timeframe,
            direction=label,
            entry=entry,
            stop_loss=sl,
            take_profits=tps,
            trend_line=trend,
            atr=atr,
            rsi=rsi,
            timestamp=last.name if isinstance(last.name, pd.Timestamp) else pd.Timestamp(last.name),
        )

    # Hard signals (flip) take priority over pre-signals
    if flip_long and long_ok:
        return build("LONG")
    if flip_short and short_ok:
        return build("SHORT")

    if enable_pre_signal:
        # Price close to trend line → warning
        dist = abs(close - trend)
        close_enough = dist < atr * pre_signal_threshold
        if close_enough:
            if direction_now == 1 and long_ok:
                return build("LONG", is_pre=True)
            if direction_now == -1 and short_ok:
                return build("SHORT", is_pre=True)

    return None
