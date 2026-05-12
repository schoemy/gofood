# Satelit Intelijen Minebean

Pengintai [Minebean](https://minebean.com) (game deploy ETH di Base mainnet) yang mengirim laporan ke Telegram setiap N menit.

**Fitur:**
- 📸 Snapshot ronde live (pool, beanpot, crowding per-block)
- 💹 EV calculator (harga BEAN + beanpot jackpot EV)
- 🎯 Block paling sepi & paling ramai untuk pilih target deploy
- 🏆 Meta N ronde terakhir: lotre vs split vs no-winner
- 🥇 Top 5 penguasa lotre + saran `/setmax` vs lawan terkuat
- 💾 Caching settled rounds (hemat rate-limit API)
- 🔐 Kredensial di `.env` (tidak di-hardcode)

---

## Persyaratan

- Node.js ≥ 18
- Telegram Bot Token ([@BotFather](https://t.me/BotFather))
- Chat ID Anda ([@userinfobot](https://t.me/userinfobot))
- Wallet address (EVM) yang Anda pakai di Minebean

## Setup

```bash
cd satelit-minebean
npm install
cp .env.example .env
# Edit .env dengan nilai Anda
```

Isi `.env`:

```
TELE_TOKEN=8628241414:AA...             # dari @BotFather
TELE_CHAT_ID=487626736                  # dari @userinfobot
MY_ADDRESS=0xabc...                     # lowercase. Dikecualikan dari target lawan.
INTERVAL_MENIT=5                        # interval loop
SCAN_LIMIT=50                           # jumlah ronde yang ditarik (max 100)
REQUEST_DELAY_MS=500                    # delay antar request ke API Minebean
```

## Jalankan

```bash
# Mode loop (terus menerus, interval dari .env)
npm start

# Atau sekali jalan, untuk testing
npm run once
```

## Contoh Output Telegram

```
🛰️ SATELIT INTELIJEN MINEBEAN
📡 Ronde Radar Terakhir: 2451 | Live: 2452

1️⃣ SNAPSHOT RONDE LIVE
👥 Total Deploy (block-level): 42 slot
💰 Total Pool Live: 0.012345 ETH
🫘 Beanpot Pool: 4.500 BEAN

🎯 Block Paling Sepi:
  #03 → 0.000000 ETH (0 slot)
  #11 → 0.000000 ETH (0 slot)
  ...

2️⃣ EV CALCULATOR
💹 Harga BEAN: $0.0234 (0.00000812 ETH)
🎁 Value BEAN/ronde: 0.00000812 ETH
🎰 Beanpot EV (1/777): 0.00004703 ETH
📈 Total EV reward: 0.00005515 ETH

3️⃣ META 50 RONDE TERAKHIR
⚠️ No-Winner: 3x  |  🔀 Split: 22x  |  🎯 Lotre (1 BEAN): 25x

🥇 TOP 5 PENGUASA LOTRE:
1. 0xabcd...1234
   ↳ Menang: 4x | Avg: 0.000007 ETH
...

💡 KESIMPULAN TAKTIS:
👉 /setmax 0.000008
   (Melindas target 0xabcd... — 4x menang, avg 0.000007 ETH)
```

## Cara Kerja

- **Ronde Live** diambil dari `GET /api/round/current` → snapshot tanpa menunggu settle.
- **N ronde settled** ditarik dari `GET /api/rounds?limit=N&settled=true`, lalu detail miners dari `GET /api/round/{id}/miners`. Data di-cache (`.cache/rounds.json`) supaya request berikutnya tidak mengulang.
- **Lotre vs Split** dibedakan dari `beanReward` per-miner:
  - `>= 0.9 BEAN` → mode single-winner (lotre)
  - `> 0 && < 0.9` → mode split
  - semua `== 0` → no-winner round (winning block kosong)
- **EV** pakai `priceNative` (BEAN dalam ETH) dari `/api/price`.

## Tuning

Edit konstanta di `satelit.js`:

| Konstanta | Default | Arti |
|---|---|---|
| `MARGIN_LINDAS_PCT` | `0.15` | Saran setmax = avg_lawan × (1 + margin) |
| `HARD_CAP_SETMAX` | `0.000120` | Batas atas absolut saran setmax |
| `LOTRE_MIN_BEAN` | `0.9` | Threshold BEAN reward untuk deteksi lotre |
| `THRESHOLDS` | — | Batas kelas modal (ETH desimal, 0.000004 = 4k gwei) |

## Catatan Keamanan

- **Jangan commit `.env`**. `.gitignore` sudah exclude.
- Kalau token bot pernah bocor, generate ulang via `@BotFather` → `/revoke`.
- Script ini **read-only**: tidak memegang private key, tidak melakukan transaksi on-chain. Hanya baca API publik + kirim Telegram.

## Disclaimer

Minebean adalah game dengan unsur random (VRF uniform). Tidak ada strategi yang bisa menjamin menang. Skrip ini hanya alat analisis — keputusan deploy tetap di Anda. Bermainlah dalam batas bankroll Anda.
