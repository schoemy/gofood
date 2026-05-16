---
inclusion: always
---

# BEAN — Agent Skill (Base Mainnet)

> **Chain:** Base (8453)
> **App:** https://minebean.com
> **API:** https://api.minebean.com
> **Objective:** Deploy ETH to a 5x5 grid in 60-second rounds. Chainlink VRF picks a winning block. Winners split the pool. Earn ETH + BEAN rewards. Stake BEAN for yield.

## Contracts

| Contract   | Address                                      |
|------------|----------------------------------------------|
| GridMining | `0x9632495bDb93FD6B0740Ab69cc6c71C9c01da4f0` |
| Bean       | `0x5c72992b83E74c4D5200A8E8920fB946214a5A5D` |
| Treasury   | `0x38F6E74148D6904286131e190d879A699fE3Aeb3` |
| AutoMiner  | `0x31358496900D600B2f523d6EdC4933E78F72De89` |
| Staking    | `0xfe177128Df8d336cAf99F787b72183D1E68Ff9c2` |

## Key Constants

- ROUND_DURATION: 60s (block.timestamp, Base ~2s blocks)
- GRID_SIZE: 25 (5x5), block IDs 0-24
- MIN_DEPLOY: 0.0000025 ETH per block
- MAX_SUPPLY: 3,000,000 BEAN
- BEAN per round: 1.1 (1.0 miner + 0.1 beanpot)
- BEANPOT_CHANCE: 1/777 (~0.13%)
- ADMIN_FEE: 1% of total pool
- VAULT_FEE: 10% of losers' pool only
- ROASTING_FEE: 10% on mined BEAN claims (roasted bonus untaxed)
- One deploy per round per user (second reverts AlreadyDeployedThisRound)

## BEAN Reward Modes (50/50 VRF)

- **Split**: 1 BEAN divided proportionally among ALL winners on the winning block.
- **Single winner ("Lotre")**: One miner wins all 1 BEAN via weighted random (more ETH on winning block = higher probability).
- Forced split if >2000 unique miners deployed in the round.

## Beanpot (Jackpot)

- +0.1 BEAN accumulates per round when winning block has miners.
- Triggered when `VRF_word_2 % 777 == 0`, entire pool paid to winning-block miners proportionally.

## REST API Endpoints

- `GET /api/round/current[?user=0x...]` — grid state, beanpot, user position
- `GET /api/round/{id}/miners` — per-miner reward breakdown (settled)
- `GET /api/rounds?page=1&limit=20&settled=true` — round history
- `GET /api/price` — BEAN/ETH price (priceNative for EV)
- `GET /api/stats`, `/api/treasury/stats`
- `GET /api/user/{addr}`, `/rewards`, `/history`
- `GET /api/staking/stats`, `/api/staking/{addr}`
- `GET /api/leaderboard/miners?period=24h|7d|30d|all&limit=20`
- SSE: `GET /api/events/rounds`, `GET /api/user/{addr}/events`

Rate limits: 60 req/min default, 5 req/min on RPC-heavy endpoints.

## Reward Field Names (round/miners)

- `deployedFormatted` / `deployed` — ETH deployed by miner
- `beanReward` — BEAN paid (>= 0.9 typically indicates "single winner / lotre" mode)
- `address` — miner wallet

## EV Formula

```
ETH edge ~= 1% admin + ~10% vault on losers' portion
BEAN value = 1 * priceNative (in ETH)
Beanpot EV = (1/777) * beanpotPool * priceNative
Net EV per round ~= BEAN_value + Beanpot_EV - ETH_deployed * ~0.11
```

## Critical Gameplay Rules

1. All 25 blocks are uniform random (VRF) — NO block has better odds.
2. Strategy is about **share** (crowding on blocks), not probability.
3. Minimum deploy: 0.0000025 ETH per block.
4. Checkpoint auto-triggers on deploy / claimETH / claimBEAN.
5. Empty rounds: no VRF, no BEAN, no beanpot growth.
6. No-winner rounds: ETH -> admin + vault, NO BEAN minted, beanpot does NOT grow.

## Coding Conventions for This Repo

- Node.js scripts for Minebean monitoring ("satelit") should use `axios`, respect API rate limits (delay 300ms+ between calls), and NEVER commit Telegram tokens or private keys — use `.env` + `dotenv`.
- Kategori modal di laporan harus konsisten antara `getKelasModal()` dan template output. Pakai konstanta label terpusat.
- Untuk threshold ETH di kode Node: satuan adalah ETH desimal (mis. `0.000004`), label bisa pakai "k gwei" karena 1 gwei = 1e-9 ETH (jadi 0.000004 ETH = 4000 gwei = "4k gwei").
