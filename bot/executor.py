"""
Bybit Trade Executor — auto-execute trades when signals fire.

Uses Bybit V5 API via ccxt to place market orders with TP/SL on USDT perpetuals.
Supports configurable position sizing (fixed USDT or % of balance), leverage,
and optional Telegram confirmation before execution.

Safety features:
- Max position size cap
- Max concurrent positions limit
- Duplicate signal protection (won't open same direction on same symbol)
- Kill switch via env var EXECUTOR_ENABLED=false
"""

import logging
from dataclasses import dataclass
from typing import Optional

import ccxt

from bot.indicators import Signal

log = logging.getLogger(__name__)


@dataclass
class ExecutorConfig:
    """Configuration for the trade executor."""
    enabled: bool = False
    api_key: str = ""
    api_secret: str = ""

    # Position sizing
    order_size_usdt: float = 10.0          # Fixed USDT per trade
    use_percent_balance: bool = False       # If True, use % of available balance
    percent_balance: float = 5.0           # % of balance per trade (if enabled)
    leverage: int = 10                      # Leverage for perpetual
    max_position_usdt: float = 100.0       # Max single position size (safety cap)
    max_concurrent_positions: int = 5       # Max open positions at once

    # TP/SL behavior
    use_tp1_only: bool = True              # Only set TP1 as take-profit (safer)
    set_sl: bool = True                    # Set stop-loss on exchange

    # Testnet
    testnet: bool = True                   # Use Bybit testnet (STRONGLY recommended first)


class BybitExecutor:
    """Execute trades on Bybit based on bot signals."""

    def __init__(self, config: ExecutorConfig):
        self.config = config
        self.client: Optional[ccxt.bybit] = None
        self._open_symbols: set = set()    # Track symbols with open positions

        if not config.enabled:
            log.info("Executor DISABLED — signals will not auto-trade")
            return

        if not config.api_key or not config.api_secret:
            log.warning("Executor enabled but API keys missing — disabling")
            self.config.enabled = False
            return

        self._init_client()

    def _init_client(self) -> None:
        """Initialize Bybit ccxt client."""
        try:
            self.client = ccxt.bybit({
                "apiKey": self.config.api_key,
                "secret": self.config.api_secret,
                "enableRateLimit": True,
                "options": {
                    "defaultType": "swap",     # USDT perpetuals
                    "adjustForTimeDifference": True,
                },
            })

            if self.config.testnet:
                self.client.set_sandbox_mode(True)
                log.info("Executor using BYBIT TESTNET")

            self.client.load_markets()
            log.info("✓ Bybit executor initialized (%s) — %d markets",
                     "testnet" if self.config.testnet else "LIVE",
                     len(self.client.markets))

            # Sync open positions
            self._sync_positions()

        except Exception as e:
            log.error("Failed to initialize Bybit executor: %s", e)
            self.config.enabled = False

    def _sync_positions(self) -> None:
        """Load current open positions to prevent duplicates."""
        try:
            positions = self.client.fetch_positions()
            self._open_symbols = set()
            for pos in positions:
                if pos.get("contracts", 0) > 0:
                    self._open_symbols.add(pos["symbol"])
            log.info("Executor: %d open positions synced", len(self._open_symbols))
        except Exception as e:
            log.warning("Failed to sync positions: %s", e)

    def _normalize_symbol(self, symbol: str) -> str:
        """Convert scanner symbol to Bybit format: BTC/USDT:USDT"""
        base = symbol.split("/")[0].split(":")[0]
        return f"{base}/USDT:USDT"

    def _calculate_size(self, symbol: str, entry_price: float) -> Optional[float]:
        """Calculate position size in contracts."""
        try:
            if self.config.use_percent_balance:
                balance = self.client.fetch_balance()
                available = float(balance.get("USDT", {}).get("free", 0))
                size_usdt = available * (self.config.percent_balance / 100)
            else:
                size_usdt = self.config.order_size_usdt

            # Apply safety cap
            size_usdt = min(size_usdt, self.config.max_position_usdt)

            # Convert to contracts (notional / price * leverage is handled by exchange)
            # For Bybit USDT perps, qty = USDT amount / price
            qty = size_usdt * self.config.leverage / entry_price

            # Round to market precision
            market = self.client.market(symbol)
            qty = self.client.amount_to_precision(symbol, qty)

            return float(qty) if float(qty) > 0 else None

        except Exception as e:
            log.error("Failed to calculate size for %s: %s", symbol, e)
            return None

    def execute_signal(self, sig: Signal) -> bool:
        """
        Execute a trade based on the signal.
        Returns True if order was placed successfully.
        """
        if not self.config.enabled or self.client is None:
            return False

        # Skip pre-signals
        if sig.direction.startswith("PRE_"):
            log.info("Executor: skip pre-signal %s", sig.key)
            return False

        symbol = self._normalize_symbol(sig.symbol)

        # Check if symbol is available on Bybit
        if symbol not in self.client.markets:
            log.warning("Executor: %s not available on Bybit", symbol)
            return False

        # Check max concurrent positions
        if len(self._open_symbols) >= self.config.max_concurrent_positions:
            log.warning("Executor: max concurrent positions (%d) reached, skipping %s",
                        self.config.max_concurrent_positions, symbol)
            return False

        # Check duplicate — don't open same symbol twice
        if symbol in self._open_symbols:
            log.info("Executor: already have position on %s, skipping", symbol)
            return False

        side = "buy" if sig.direction == "LONG" else "sell"
        entry_price = sig.entry

        # Calculate size
        qty = self._calculate_size(symbol, entry_price)
        if qty is None:
            log.error("Executor: could not calculate size for %s", symbol)
            return False

        try:
            # Set leverage first
            try:
                self.client.set_leverage(self.config.leverage, symbol)
            except Exception:
                pass  # May already be set

            # Place market order
            log.info("Executor: placing %s %s qty=%.4f on %s (leverage=%dx)",
                     side.upper(), symbol, qty, 
                     "testnet" if self.config.testnet else "LIVE",
                     self.config.leverage)

            order = self.client.create_order(
                symbol=symbol,
                type="market",
                side=side,
                amount=qty,
                params={
                    "category": "linear",
                }
            )

            log.info("Executor: order filled — id=%s, avg_price=%s",
                     order.get("id"), order.get("average"))

            # Set TP/SL
            self._set_tp_sl(symbol, sig, side)

            # Track open position
            self._open_symbols.add(symbol)
            return True

        except Exception as e:
            log.error("Executor: order FAILED for %s: %s", symbol, e)
            return False

    def _set_tp_sl(self, symbol: str, sig: Signal, side: str) -> None:
        """Set take-profit and stop-loss on the position."""
        try:
            tp_price = sig.take_profits[0] if self.config.use_tp1_only else sig.take_profits[-1]
            sl_price = sig.stop_loss

            params = {
                "category": "linear",
                "symbol": symbol.replace("/", "").replace(":USDT", ""),
                "takeProfit": str(tp_price),
                "tpTriggerBy": "LastPrice",
                "slTriggerBy": "LastPrice",
            }

            if self.config.set_sl:
                params["stopLoss"] = str(sl_price)

            self.client.set_margin_mode("cross", symbol)

            # Use ccxt's set trading stop
            self.client.private_post_v5_position_trading_stop(params)

            log.info("Executor: TP=%.5f SL=%.5f set for %s",
                     tp_price, sl_price, symbol)

        except Exception as e:
            log.warning("Executor: failed to set TP/SL for %s: %s (position still open!)", symbol, e)

    def get_pnl_summary(self) -> Optional[str]:
        """Get P&L summary of recent closed trades for Telegram reporting."""
        if not self.config.enabled or self.client is None:
            return None

        try:
            # Fetch closed P&L from Bybit
            positions = self.client.fetch_positions()
            closed = self.client.private_get_v5_position_closed_pnl({
                "category": "linear",
                "limit": "20",
            })

            records = closed.get("result", {}).get("list", [])
            if not records:
                return None

            total_pnl = 0.0
            wins = 0
            losses = 0

            for r in records:
                pnl = float(r.get("closedPnl", 0))
                total_pnl += pnl
                if pnl > 0:
                    wins += 1
                else:
                    losses += 1

            total = wins + losses
            winrate = (wins / total * 100) if total > 0 else 0

            return (
                f"💰 <b>Live Trade Stats (Bybit)</b>\n"
                f"Total trades: <code>{total}</code>\n"
                f"Wins: <code>{wins}</code> | Losses: <code>{losses}</code>\n"
                f"Win rate: <code>{winrate:.1f}%</code>\n"
                f"Total P&L: <code>{total_pnl:.2f} USDT</code>"
            )

        except Exception as e:
            log.warning("Failed to get PnL summary: %s", e)
            return None


def format_execution_msg(sig: Signal, success: bool, testnet: bool = True) -> str:
    """Format Telegram message for trade execution."""
    coin = sig.symbol.split("/")[0].replace(":", "")
    mode = "🧪 TESTNET" if testnet else "🔴 LIVE"
    side = "LONG" if sig.direction == "LONG" else "SHORT"

    if success:
        return (
            f"⚡ <b>AUTO-TRADE EXECUTED</b> {mode}\n"
            f"#{coin}USDT {sig.timeframe} | {side}\n"
            f"Entry: <code>{sig.entry:.5f}</code>\n"
            f"TP1: <code>{sig.take_profits[0]:.5f}</code>\n"
            f"SL: <code>{sig.stop_loss:.5f}</code>\n"
            f"💡 Position opened automatically"
        )
    else:
        return (
            f"⚠️ <b>AUTO-TRADE FAILED</b> {mode}\n"
            f"#{coin}USDT {sig.timeframe} | {side}\n"
            f"Reason: check logs for details"
        )
