# 🤖 Telegram AI Agent — Setup Guide

Bot Telegram interaktif yang menggunakan **Claude AI** (Anthropic) untuk menjawab pertanyaan seputar crypto trading, analisis teknikal, dan lainnya.

---

## Fitur

- **Conversational AI** — Claude menjawab pesan dengan konteks percakapan sebelumnya
- **Crypto-focused** — System prompt dioptimalkan untuk trading & analisis teknikal
- **Memory per-chat** — Setiap chat punya riwayat sendiri (max 20 pesan)
- **Rate limiting** — Proteksi dari spam (default: 10 pesan/menit per user)
- **Access control** — Bisa dibatasi hanya chat ID tertentu
- **Commands** — `/start`, `/clear`, `/help`, `/status`

---

## Cara Setup

### 1. Buat Bot Telegram

1. Buka Telegram, cari **@BotFather**
2. Kirim `/newbot` dan ikuti instruksi
3. Salin **Bot Token** yang diberikan

### 2. Dapatkan API Key Claude

Gunakan API key dari endpoint custom:
```
Base URL: https://www.ccode.dev/v1
API Key:  sk-xxxxxxxx (API key Anda)
```

### 3. Konfigurasi Environment

Copy file `.env.example` menjadi `.env`:

```bash
cp .env.example .env
```

Edit `.env` dan isi minimal:

```env
# WAJIB
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz
AI_API_KEY=sk-your-api-key-here

# OPSIONAL (sudah ada default)
AI_API_BASE_URL=https://www.ccode.dev/v1
AI_MODEL=claude-sonnet-4-20250514
AI_MAX_TOKENS=4096
AI_TEMPERATURE=0.7
```

### 4. Install Dependencies

```bash
pip install -r requirements.txt
```

### 5. Jalankan Bot

```bash
python -m bot.ai_agent
```

Output jika sukses:
```
2025-xx-xx  INFO  ai_agent: Starting AI Agent bot...
2025-xx-xx  INFO  ai_agent: Model: claude-sonnet-4-20250514 | Endpoint: https://www.ccode.dev/v1
2025-xx-xx  INFO  ai_agent: Bot connected: @your_bot_name
```

---

## Konfigurasi Lengkap

| Variable | Default | Deskripsi |
|----------|---------|-----------|
| `TELEGRAM_BOT_TOKEN` | *(wajib)* | Token dari BotFather |
| `AI_API_KEY` | *(wajib)* | API key untuk Claude |
| `AI_API_BASE_URL` | `https://www.ccode.dev/v1` | Endpoint API |
| `AI_MODEL` | `claude-sonnet-4-20250514` | Model yang digunakan |
| `AI_MAX_TOKENS` | `4096` | Max token respons |
| `AI_TEMPERATURE` | `0.7` | Kreativitas (0.0-1.0) |
| `AI_MAX_HISTORY` | `20` | Max pesan dalam memori per chat |
| `AI_AGENT_ALLOWED_CHATS` | *(kosong = semua)* | Chat ID yang diizinkan (pisah koma) |
| `AI_RATE_LIMIT` | `10` | Max pesan per menit per user |
| `AI_POLL_TIMEOUT` | `30` | Timeout long polling (detik) |
| `AI_SYSTEM_PROMPT` | *(default crypto)* | Custom system prompt |

---

## Deploy di Termux (Android)

```bash
# Install Python
pkg install python

# Clone repo
git clone https://github.com/schoemy/gofood.git
cd gofood

# Install deps
pip install -r requirements.txt

# Setup env
cp .env.example .env
nano .env  # isi TELEGRAM_BOT_TOKEN dan AI_API_KEY

# Jalankan (background)
nohup python -m bot.ai_agent > ai_agent.log 2>&1 &

# Cek log
tail -f ai_agent.log
```

---

## Deploy di VPS / Server

### Menggunakan systemd:

Buat file `/etc/systemd/system/ai-agent.service`:

```ini
[Unit]
Description=Telegram AI Agent Bot
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/path/to/gofood
ExecStart=/usr/bin/python3 -m bot.ai_agent
Restart=always
RestartSec=10
EnvironmentFile=/path/to/gofood/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable ai-agent
sudo systemctl start ai-agent
sudo systemctl status ai-agent
```

---

## Jalankan Bersamaan dengan Scanner

Bot AI Agent dan Scanner berjalan terpisah. Untuk menjalankan keduanya:

```bash
# Terminal 1: Scanner (sinyal trading)
python -m bot.scanner

# Terminal 2: AI Agent (chatbot)
python -m bot.ai_agent
```

Atau dengan background processes:
```bash
nohup python -m bot.scanner > scanner.log 2>&1 &
nohup python -m bot.ai_agent > ai_agent.log 2>&1 &
```

---

## Commands Bot

| Command | Fungsi |
|---------|--------|
| `/start` | Mulai percakapan, tampilkan welcome |
| `/clear` | Reset riwayat chat |
| `/help` | Panduan penggunaan |
| `/status` | Status bot (model, endpoint, dll) |

---

## Custom System Prompt

Anda bisa mengubah kepribadian bot via env variable `AI_SYSTEM_PROMPT`:

```env
AI_SYSTEM_PROMPT=Kamu adalah analis crypto profesional. Jawab hanya tentang Bitcoin dan Ethereum. Gunakan data teknikal dalam analisis.
```

Atau biarkan kosong untuk menggunakan default prompt yang mencakup semua topik crypto.

---

## Troubleshooting

| Problem | Solusi |
|---------|--------|
| Bot tidak merespons | Cek `TELEGRAM_BOT_TOKEN` dan `AI_API_KEY` di `.env` |
| Error "401 Unauthorized" | API key salah atau expired |
| Error "429 Too Many Requests" | Rate limit dari API — kurangi `AI_RATE_LIMIT` |
| Bot lambat | Naikkan `AI_POLL_TIMEOUT`, turunkan `AI_MAX_TOKENS` |
| Pesan terpotong | Telegram limit 4096 char — bot otomatis split |
| Hanya chat tertentu yang bisa | Isi `AI_AGENT_ALLOWED_CHATS` dengan chat ID |

---

## Keamanan

- **Jangan commit file `.env`** — sudah ada di `.gitignore`
- Gunakan `AI_AGENT_ALLOWED_CHATS` untuk membatasi akses
- Rate limiter mencegah abuse
- API key hanya digunakan server-side, tidak terekspos ke user
