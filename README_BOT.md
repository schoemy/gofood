# GG-Shot Clone — Python Signal Scanner

Auto-scan crypto pairs and push GG-Shot-style signals to Telegram.

Teknik: **Supertrend (ATR trailing)** untuk arah trend + **flip detection** untuk entry + **ATR × multiplier** untuk TP1-TP4 + **RSI filter** opsional + **pre-signal warning** saat harga mendekati trend line.

## Struktur

```
bot/
├── __init__.py
├── config.py        # Settings dari .env
├── indicators.py    # Supertrend / ATR / RSI / Signal builder
├── telegram.py      # Formatter + Telegram sender
└── scanner.py       # Main loop (entrypoint)
requirements.txt
.env.example
```

## Setup

```bash
# 1. Install dependencies
python -m venv .venv
source .venv/bin/activate          # di Windows: .venv\Scripts\activate
pip install -r requirements.txt

# 2. Buat .env dari template
cp .env.example .env
# Edit .env → isi TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, WATCHLIST, TIMEFRAMES

# 3. Jalankan
python -m bot.scanner              # loop terus (Ctrl+C untuk berhenti)
python -m bot.scanner --once       # sekali jalan (cocok buat cron)
```

## Dapat Telegram Bot Token

1. Chat `@BotFather` di Telegram → `/newbot` → ikuti instruksi → copy token.
2. Chat `@userinfobot` untuk dapetin `chat_id` (atau add bot ke grup dan kirim pesan apa aja, lalu cek `https://api.telegram.org/bot<TOKEN>/getUpdates`).

## Contoh Output

```
📩 #PYTHUSDT 30m | Mid-Term
📉 SHORT SIGNAL
📉 Entry Zone: 0.05408 - 0.05770

⏳ Signal details:
Target 1:  0.05308
Target 2:  0.05209
Target 3:  0.05109
Target 4:  0.05010
_____
🧲 Trend-Line: 0.05770
❌ Stop-Loss: 0.05876
📊 ATR: 0.00100  |  RSI: 42.3
💡 After TP1, move the rest of the position to breakeven.
```

## Jalankan Sebagai Service (Linux)

`/etc/systemd/system/ggshot-bot.service`:

```ini
[Unit]
Description=GG-Shot Signal Bot
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/path/to/gofood
Environment=PATH=/path/to/gofood/.venv/bin
ExecStart=/path/to/gofood/.venv/bin/python -m bot.scanner
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now ggshot-bot
sudo journalctl -u ggshot-bot -f
```

## Atau Pakai Cron (`--once` mode)

```cron
# Scan tiap 5 menit
*/5 * * * * cd /path/to/gofood && .venv/bin/python -m bot.scanner --once >> /var/log/ggshot.log 2>&1
```

## Anti-Spam / Dedup

Setiap sinyal punya `key` unik = `symbol|timeframe|direction|candle_timestamp`.
State disimpan di `bot_state.json` — sinyal yang sama tidak akan dikirim dua kali.
Hapus file ini untuk reset.

## Tuning

| Parameter | Efek |
|---|---|
| `ATR_MULT` tinggi (3.0-5.0) | Trend line jauh dari harga → sinyal lebih jarang, lebih akurat |
| `ATR_MULT` rendah (1.5-2.5) | Lebih sensitif, lebih sering flip, lebih banyak false signal |
| `USE_RSI_FILTER=true` | Hanya ambil sinyal yang sejalan dengan momentum RSI |
| `TP_MULTIPLIERS` | TP bertingkat, kelipatan ATR |
| `SL_MULTIPLIER` | Jarak stop-loss dari entry (× ATR) |

## ⚠️ Disclaimer

Ini adalah alat analisis teknis, **bukan financial advice**.
Selalu pakai money management & risk per trade < 2% modal.
Backtest dulu sebelum live trading.
