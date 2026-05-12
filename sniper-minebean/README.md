# Minebean Sniper v15 — Clean Refactor

Versi refactor dari sniper v14.1, fokus pada struktur lebih bersih dan mesin satelit yang diperbaiki.

## Yang Dipertahankan

**Semua Telegram commands v14.1:**
- `/setev <n>` — target EV USD
- `/setboard <n>` — max board ETH
- `/setbet <n>` — base bet per block
- `/setswap <n>` — auto-swap threshold BEAN
- `/setpot <n>` — min beanpot BEAN
- `/setmax <n>` — hard max safety cap
- `/setsatelit on|off` — toggle satelit engine
- `/mode all|skip|random` — deploy mode (3 mode utuh)
- `/bobot` — cek radar volume manual
- `/status` — status konfigurasi lengkap
- `/balance` — cek saldo ETH + BEAN + USD
- `/antiloss on|off` — toggle anti-loss
- `/setloss <n>` — max loss streak
- `/setcooldown <n>` — cooldown rounds
- `/setevbuffer <n>` — EV buffer USD
- `/stop` — matikan bot

**3 Deploy Mode:**
- `all` — deploy ke 25 block
- `skip` — deploy ke 24 block, skip prev winner
- `random` — deploy ke 24 block, skip random

## Perubahan dari v14.1

### Satelit Engine v2 (logic baru)
- **Filter target diperluas** — tidak lagi hanya kelas Semut (`< 0.000010`). Sekarang deteksi pemain dominan di semua kelas di bawah Whale (`< 0.000300`). Whale AutoMine-All yang menguasai 50% kemenangan akan terdeteksi.
- **Cap typo diperbaiki** — hard cap absolut sekarang `0.000250` dan diterapkan konsisten.
- **Respect manual override** — kalau Anda baru `/setmax` manual < 30 detik lalu, satelit tidak override.
- **Margin tunggal** — `MARGIN_LINDAS_PCT = 0.15` dipakai di Radar & Satelit (sebelumnya inkonsisten 10% vs 15%).

### Bug fixes
- `prevWinningBlock` diambil dari `/api/round/{id}` (sebelumnya `/miners` yang tidak punya field itu).
- Sanity check ETH price — fallback ke CoinGecko kalau `priceNative` mencurigakan.
- Skip mode dengan `prevWinningBlock = -1` sekarang fallback ke ALL 25 block (dengan warning log), sebelumnya silently bug.

### Struktur kode
- Semua config di satu objek `CFG`, semua state di objek `STATE`, semua flag di `FLAGS`.
- Tidak ada lagi global variable berserakan.
- Env-driven config (override via `.env`).

## Setup

```bash
cd sniper-minebean
npm install
cp .env.example .env
# edit .env:
# - BASE_RPC_URL (https://mainnet.base.org atau RPC private)
# - PRIVATE_KEY (WALLET TERPISAH, bukan wallet utama!)
# - TG_BOT_TOKEN (dari @BotFather)
# - TG_CHAT_ID (dari @userinfobot)
npm start
```

## Keamanan

- **Jangan commit `.env`**. Sudah di `.gitignore`.
- **Gunakan wallet terpisah** khusus untuk bot ini. Isi secukupnya. Private key di filesystem = risk.
- `chmod 600 .env` di Termux.
- Jangan share screenshot `.env` atau output `/balance` dengan address lengkap.

## Catatan Strategi

Bot ini beroperasi di Minebean, game dengan komponen random (Chainlink VRF). Tidak ada strategi yang menjamin profit. Expected value bisa negatif tergantung kondisi pasar (beanpot size, BEAN price, jumlah whale AutoMine). Main dengan bankroll yang Anda siap kehilangan.
