"""
Signal outcome tracker.

Records every signal we dispatch, then on each scan checks the OHLCV history
since the signal was sent to see which target (TP1-TP4) or stop-loss hit first.
Outcomes are persisted to a JSON ledger so the data survives across GHA runs
via the cache action.

On resolution, posts a short summary to Telegram and prints win-rate stats.
"""

import json
import logging
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Dict, List, Optional

import pandas as pd

from bot.indicators import Signal

log = logging.getLogger(__name__)


@dataclass
class TrackedSignal:
    key: str
    symbol: str
    timeframe: str
    direction: str           # "LONG" or "SHORT" (pre-signals are not tracked)
    entry: float
    stop_loss: float
    take_profits: List[float]
    created_ts: int          # unix seconds (signal candle timestamp)
    # Resolution
    status: str = "open"     # "open" | "tp1" | "tp2" | "tp3" | "tp4" | "sl"
    resolved_ts: Optional[int] = None
    max_tp_hit: int = 0      # highest TP index reached (for partial wins)

    @classmethod
    def from_signal(cls, sig: Signal) -> "TrackedSignal":
        return cls(
            key=sig.key,
            symbol=sig.symbol,
            timeframe=sig.timeframe,
            direction=sig.direction,
            entry=sig.entry,
            stop_loss=sig.stop_loss,
            take_profits=list(sig.take_profits),
            created_ts=int(sig.timestamp.timestamp()),
        )


class Ledger:
    """Persistent JSON store of tracked signals."""

    def __init__(self, path: str):
        self.path = Path(path)
        self.signals: Dict[str, TrackedSignal] = {}
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            data = json.loads(self.path.read_text())
            for item in data.get("signals", []):
                ts = TrackedSignal(**item)
                self.signals[ts.key] = ts
        except (json.JSONDecodeError, OSError, TypeError) as e:
            log.warning("Ledger %s unreadable (%s); starting fresh", self.path, e)

    def save(self) -> None:
        trimmed = list(self.signals.values())
        # Keep last 500 entries to bound growth
        trimmed.sort(key=lambda s: s.created_ts, reverse=True)
        trimmed = trimmed[:500]
        self.path.write_text(json.dumps(
            {"signals": [asdict(s) for s in trimmed]},
            indent=2,
        ))

    def add(self, sig: Signal) -> None:
        """Record a new signal (skips pre-signals)."""
        if sig.direction.startswith("PRE_"):
            return
        if sig.key in self.signals:
            return
        self.signals[sig.key] = TrackedSignal.from_signal(sig)
        log.info("tracker: added %s", sig.key)

    def open_signals(self) -> List[TrackedSignal]:
        return [s for s in self.signals.values() if s.status == "open"]

    def stats(self) -> dict:
        """Win-rate breakdown by TP level, aggregated over all resolved signals."""
        total = 0
        hits = {"tp1": 0, "tp2": 0, "tp3": 0, "tp4": 0, "sl": 0}
        for s in self.signals.values():
            if s.status == "open":
                continue
            total += 1
            hits[s.status] = hits.get(s.status, 0) + 1
        if total == 0:
            return {"total": 0}
        # A signal that hits TP2 also counts as a TP1 hit
        tp1_or_better = sum(1 for s in self.signals.values()
                             if s.status != "open" and s.status != "sl")
        return {
            "total": total,
            "tp1_plus": tp1_or_better,
            "tp1_only": hits["tp1"],
            "tp2_plus": sum(1 for s in self.signals.values()
                             if s.status in ("tp2", "tp3", "tp4")),
            "tp3_plus": sum(1 for s in self.signals.values()
                             if s.status in ("tp3", "tp4")),
            "tp4": hits["tp4"],
            "sl": hits["sl"],
            "tp1_winrate": round(100 * tp1_or_better / total, 1),
        }


# ─────────────────────────── Resolution logic ─────────────────────────

def resolve_signal(ts: TrackedSignal, df: pd.DataFrame) -> bool:
    """
    Given OHLCV since the signal was created, determine whether TP or SL hit.
    Mutates `ts` in place; returns True if the status changed.

    Conservative: if both SL and TP hit in the same candle, we assume SL hit
    first (worst-case). This matches standard backtest convention.
    """
    if ts.status != "open":
        return False
    if df is None or len(df) == 0:
        return False

    # Only bars strictly after the signal candle
    post = df[df.index.astype("int64") // 10**9 > ts.created_ts]
    if post.empty:
        return False

    is_long = ts.direction == "LONG"
    sl = ts.stop_loss
    tps = ts.take_profits
    changed = False

    for idx, row in post.iterrows():
        high, low = float(row["high"]), float(row["low"])

        # Stop loss first (conservative)
        if is_long and low <= sl:
            ts.status = "sl"
            ts.resolved_ts = int(idx.timestamp())
            changed = True
            break
        if not is_long and high >= sl:
            ts.status = "sl"
            ts.resolved_ts = int(idx.timestamp())
            changed = True
            break

        # TP ladder — mark highest TP touched in this candle
        for i, tp in enumerate(tps, start=1):
            hit = (is_long and high >= tp) or (not is_long and low <= tp)
            if hit and i > ts.max_tp_hit:
                ts.max_tp_hit = i
                ts.status = f"tp{i}"
                ts.resolved_ts = int(idx.timestamp())
                changed = True

        # Stop once TP4 hit — can't go further
        if ts.max_tp_hit >= len(tps):
            break

    return changed


def format_resolution(ts: TrackedSignal) -> str:
    """Short Telegram message when a signal resolves."""
    if ts.status == "sl":
        icon = "❌"
        headline = "Hit Stop-Loss"
    else:
        icon = "✅"
        n = int(ts.status.replace("tp", ""))
        headline = f"Hit Target {n}"

    coin = ts.symbol.split("/")[0].replace(":", "")
    lines = [
        f"{icon} #{coin}USDT {ts.timeframe} — {headline}",
        f"Direction: {ts.direction}  Entry: <code>{ts.entry}</code>",
    ]
    if ts.max_tp_hit > 0:
        lines.append(f"Max TP reached: TP{ts.max_tp_hit}")
    return "\n".join(lines)


def format_stats(stats: dict) -> str:
    if stats.get("total", 0) == 0:
        return ""
    return (
        f"📈 <b>Bot stats</b>\n"
        f"Total resolved: <code>{stats['total']}</code>\n"
        f"TP1+: <code>{stats['tp1_plus']}</code> "
        f"({stats['tp1_winrate']}%)\n"
        f"TP2+: <code>{stats['tp2_plus']}</code>  "
        f"TP3+: <code>{stats['tp3_plus']}</code>  "
        f"TP4: <code>{stats['tp4']}</code>\n"
        f"SL: <code>{stats['sl']}</code>"
    )
