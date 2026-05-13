"""
Indicator engine: Supertrend + ATR TP ladder + RSI/MACD/EMA confluence filters.

Implemented in pure pandas/numpy to avoid the pandas-ta packaging mess on PyPI.
Supertrend math mirrors TradingView's ta.supertrend so signals line up with
the Pine Script clone.
"""

from dataclasses import dataclass, field
from typing import List, Optional

import numpy as np
import pandas as pd


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
    # Confluence context (for Telegram message + debugging)
    confluence: dict = field(default_factory=dict)
    key: str = ""

    def __post_init__(self):
        self.key = (
            f"{self.symbol}|{self.timeframe}|{self.direction}|"
            f"{int(self.timestamp.timestamp())}"
        )


# ─────────────────────────── Core indicators ──────────────────────────

def wilder_rma(series: pd.Series, length: int) -> pd.Series:
    """Wilder's smoothing (RMA) — same as TradingView's ta.rma."""
    return series.ewm(alpha=1 / length, adjust=False, min_periods=length).mean()


def compute_ema(series: pd.Series, length: int) -> pd.Series:
    """Standard EMA — same as TradingView's ta.ema."""
    return series.ewm(span=length, adjust=False, min_periods=length).mean()


def compute_atr(high: pd.Series, low: pd.Series, close: pd.Series,
                length: int) -> pd.Series:
    prev_close = close.shift(1)
    tr = pd.concat([
        high - low,
        (high - prev_close).abs(),
        (low - prev_close).abs(),
    ], axis=1).max(axis=1)
    return wilder_rma(tr, length)


def compute_rsi(close: pd.Series, length: int) -> pd.Series:
    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = wilder_rma(gain, length)
    avg_loss = wilder_rma(loss, length)
    rs = avg_gain / avg_loss.replace(0, np.nan)
    rsi = 100 - (100 / (1 + rs))
    return rsi.fillna(50)


def compute_macd(close: pd.Series, fast: int = 12, slow: int = 26,
                 signal: int = 9) -> pd.DataFrame:
    """
    MACD = EMA(fast) - EMA(slow).  Signal = EMA(MACD, signal_len).
    Histogram = MACD - Signal. Returns df with columns macd, signal, hist.
    """
    ema_fast = compute_ema(close, fast)
    ema_slow = compute_ema(close, slow)
    macd = ema_fast - ema_slow
    sig = compute_ema(macd, signal)
    hist = macd - sig
    return pd.DataFrame({"macd": macd, "signal": sig, "hist": hist})


def compute_supertrend(df: pd.DataFrame, length: int,
                       multiplier: float) -> pd.DataFrame:
    """
    Supertrend identical to TradingView's ta.supertrend().
    Adds columns: 'supertrend' (the line) and 'st_dir' (1=up, -1=down).
    """
    high, low, close = df["high"], df["low"], df["close"]
    hl2 = (high + low) / 2.0
    atr = compute_atr(high, low, close, length)

    upper_basic = hl2 + multiplier * atr
    lower_basic = hl2 - multiplier * atr

    n = len(df)
    upper = np.full(n, np.nan)
    lower = np.full(n, np.nan)
    direction = np.full(n, 1, dtype=int)
    supert = np.full(n, np.nan)

    close_arr = close.to_numpy()
    ub = upper_basic.to_numpy()
    lb = lower_basic.to_numpy()

    for i in range(n):
        if i == 0 or np.isnan(ub[i]) or np.isnan(lb[i]):
            upper[i] = ub[i] if not np.isnan(ub[i]) else np.nan
            lower[i] = lb[i] if not np.isnan(lb[i]) else np.nan
            continue

        # Trailing bands — never loosen
        prev_upper = upper[i - 1] if not np.isnan(upper[i - 1]) else ub[i]
        prev_lower = lower[i - 1] if not np.isnan(lower[i - 1]) else lb[i]

        upper[i] = min(ub[i], prev_upper) if close_arr[i - 1] <= prev_upper else ub[i]
        lower[i] = max(lb[i], prev_lower) if close_arr[i - 1] >= prev_lower else lb[i]

        # Direction flip
        if not np.isnan(supert[i - 1]):
            if direction[i - 1] == 1 and close_arr[i] < lower[i]:
                direction[i] = -1
            elif direction[i - 1] == -1 and close_arr[i] > upper[i]:
                direction[i] = 1
            else:
                direction[i] = direction[i - 1]
        else:
            direction[i] = 1 if close_arr[i] > hl2.iloc[i] else -1

        supert[i] = lower[i] if direction[i] == 1 else upper[i]

    df = df.copy()
    df["atr"] = atr
    df["supertrend"] = supert
    df["st_dir"] = direction
    return df


# ─────────────────────────── Analyze ──────────────────────────────────

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
    # ── MACD confluence ──
    use_macd_filter: bool = False,
    macd_fast: int = 12,
    macd_slow: int = 26,
    macd_signal: int = 9,
    # ── EMA 200 confluence ──
    use_ema_filter: bool = False,
    ema_length: int = 200,
    # ── Take-profit / stop-loss ──
    tp_multipliers: Optional[List[float]] = None,
    sl_multiplier: float = 1.5,
    # ── Pre-signal ──
    pre_signal_threshold: float = 0.3,
    enable_pre_signal: bool = True,
) -> Optional[Signal]:
    """Analyze the latest CLOSED candle. Returns a Signal or None."""
    if tp_multipliers is None:
        tp_multipliers = [1.0, 2.0, 3.0, 4.0]

    min_bars_needed = max(
        atr_length,
        rsi_length,
        macd_slow + macd_signal if use_macd_filter else 0,
        ema_length if use_ema_filter else 0,
    ) + 5
    if len(df) < min_bars_needed:
        return None

    df = compute_supertrend(df, atr_length, atr_mult)
    df["rsi"] = compute_rsi(df["close"], rsi_length)

    if use_macd_filter:
        macd_df = compute_macd(df["close"], macd_fast, macd_slow, macd_signal)
        df["macd_hist"] = macd_df["hist"]

    if use_ema_filter:
        df[f"ema_{ema_length}"] = compute_ema(df["close"], ema_length)

    # Use last CLOSED candle (index -2); -1 is still forming
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

    # ── Confluence filters ──
    long_ok = (not use_rsi_filter) or rsi > rsi_long_min
    short_ok = (not use_rsi_filter) or rsi < rsi_short_max

    confluence: dict = {"rsi": round(rsi, 1)}

    if use_macd_filter:
        hist_now = last.get("macd_hist")
        hist_prev = prev.get("macd_hist")
        if pd.isna(hist_now) or pd.isna(hist_prev):
            return None
        confluence["macd_hist"] = round(float(hist_now), 4)
        # Long: hist > 0 and rising.  Short: hist < 0 and falling.
        long_ok = long_ok and (hist_now > 0 and hist_now > hist_prev)
        short_ok = short_ok and (hist_now < 0 and hist_now < hist_prev)

    if use_ema_filter:
        ema_val = last.get(f"ema_{ema_length}")
        if pd.isna(ema_val):
            return None
        confluence[f"ema_{ema_length}"] = round(float(ema_val), 4)
        # Long only above EMA; short only below
        long_ok = long_ok and close > ema_val
        short_ok = short_ok and close < ema_val

    def build(direction: str, is_pre: bool = False) -> Signal:
        sign = 1 if direction.endswith("LONG") else -1
        entry = close
        tps = [entry + sign * m * atr for m in tp_multipliers]
        sl = entry - sign * sl_multiplier * atr
        label = direction if not is_pre else f"PRE_{direction}"
        ts = last.name if isinstance(last.name, pd.Timestamp) else pd.Timestamp(last.name)
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
            timestamp=ts,
            confluence=confluence,
        )

    # Hard flip beats pre-signal
    if flip_long and long_ok:
        return build("LONG")
    if flip_short and short_ok:
        return build("SHORT")

    if enable_pre_signal:
        dist = abs(close - trend)
        if dist < atr * pre_signal_threshold:
            if direction_now == 1 and long_ok:
                return build("LONG", is_pre=True)
            if direction_now == -1 and short_ok:
                return build("SHORT", is_pre=True)

    return None
