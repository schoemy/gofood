'use strict';

/**
 * SATELIT INTELIJEN MINEBEAN
 * =============================================================
 * - Memantau 50 ronde terakhir (lotre, split, distribusi kelas).
 * - Mengambil snapshot ronde LIVE via /api/round/current.
 * - Radar beanpot + kalkulasi EV memakai /api/price.
 * - Leaderboard top 5 (dikecualikan wallet sendiri).
 * - Saran setmax berbasis avg modal lawan + cap keamanan.
 * - Caching settled rounds untuk menghemat request.
 * - Kredensial dari .env (jangan di-hardcode).
 *
 * Jalankan:
 *   node satelit.js          // loop terus menerus
 *   node satelit.js --once   // sekali saja lalu exit
 */

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');

// ==========================================
// KONFIGURASI
// ==========================================
const CONFIG = {
    BASE_URL: process.env.BASE_URL || 'https://api.minebean.com',
    TELE_TOKEN: process.env.TELE_TOKEN,
    TELE_CHAT_ID: process.env.TELE_CHAT_ID,
    MY_ADDRESS: (process.env.MY_ADDRESS || '').toLowerCase(),
    INTERVAL_MENIT: parseInt(process.env.INTERVAL_MENIT || '5', 10),
    SCAN_LIMIT: Math.min(parseInt(process.env.SCAN_LIMIT || '50', 10), 100),
    REQUEST_DELAY_MS: parseInt(process.env.REQUEST_DELAY_MS || '500', 10),
    CACHE_FILE: path.join(__dirname, '.cache', 'rounds.json'),
    // Kalibrasi strategi
    MARGIN_LINDAS_PCT: 0.15,      // +15% di atas avg lawan (sesuai niat komentar asli)
    HARD_CAP_SETMAX: 0.000250,    // Batas atas absolut setmax (naik untuk cover whale dominan)
    LOTRE_MIN_BEAN: 0.9,          // BEAN reward >= 0.9 dianggap mode "single winner/lotre"

    // Pool-Percentage Radar
    POOL_PCT_MIN: 0.10,    // 10% dari total pool
    POOL_PCT_MAX: 0.15,    // 15% dari total pool
};

// === KATEGORI MODAL (ETH per-wallet, satuan ETH desimal) ===
// Catatan: 1 gwei = 1e-9 ETH. 0.000004 ETH = 4000 gwei = "4k gwei".
const THRESHOLDS = {
    MICRO:          0.000004,
    SEMUT_BAWAH:    0.000006,
    SEMUT_ATAS:     0.000010,
    MID_MARATHON:   0.000050,
    HIGH_MARATHON:  0.000080,
    MARATHON_ATAS:  0.000099,
    WHALE:          0.000300,
};

// Label terpusat — dipakai konsisten di getKelasModal() dan template laporan.
const LABELS = {
    MICRO:       'Micro (< 4k)',
    SEMUT_BAWAH: 'Semut Bawah (4k-6k)',
    SEMUT_ATAS:  'Semut Atas (6k-10k)',
    MID_MARA:    'Mid Marathon (10k-50k)',
    HIGH_MARA:   'High Marathon (50k-80k)',
    MARA_ATAS:   'Marathon Atas (80k-99k)',
    MIDDLE:      'Middleweight (99k-300k)',
    WHALE:       'Whale (> 300k)',
};

// Validasi env
if (!CONFIG.TELE_TOKEN || !CONFIG.TELE_CHAT_ID) {
    console.error('❌ TELE_TOKEN dan TELE_CHAT_ID wajib di-set di .env');
    process.exit(1);
}
if (!CONFIG.MY_ADDRESS || CONFIG.MY_ADDRESS.length !== 42) {
    console.warn('⚠️  MY_ADDRESS kosong/invalid — tag "(Anda)" dan skip-self tidak akan bekerja.');
}

const bot = new TelegramBot(CONFIG.TELE_TOKEN, { polling: false });
const http = axios.create({ baseURL: CONFIG.BASE_URL, timeout: 10000 });

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ==========================================
// HELPERS
// ==========================================
function getKelasModal(deploy) {
    if (deploy < THRESHOLDS.MICRO)         return LABELS.MICRO;
    if (deploy < THRESHOLDS.SEMUT_BAWAH)   return LABELS.SEMUT_BAWAH;
    if (deploy < THRESHOLDS.SEMUT_ATAS)    return LABELS.SEMUT_ATAS;
    if (deploy < THRESHOLDS.MID_MARATHON)  return LABELS.MID_MARA;
    if (deploy < THRESHOLDS.HIGH_MARATHON) return LABELS.HIGH_MARA;
    if (deploy < THRESHOLDS.MARATHON_ATAS) return LABELS.MARA_ATAS;
    if (deploy < THRESHOLDS.WHALE)         return LABELS.MIDDLE;
    return LABELS.WHALE;
}

function getFaksiUtama(deploy) {
    if (deploy < THRESHOLDS.SEMUT_ATAS)     return 'SEMUT';
    if (deploy < THRESHOLDS.HIGH_MARATHON)  return 'MENENGAH';
    return 'PAUS';
}

// Markdown (legacy) — escape underscore & bracket di address/text bebas.
function escMd(s) {
    return String(s).replace(/([_*\[\]`])/g, '\\$1');
}

function shortAddr(addr) {
    if (!addr) return 'Unknown';
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function pctOf(part, whole) {
    return whole > 0 ? ((part / whole) * 100).toFixed(1) : '0.0';
}

// ==========================================
// CACHE (settled rounds data)
// ==========================================
function loadCache() {
    try {
        if (!fs.existsSync(CONFIG.CACHE_FILE)) return {};
        return JSON.parse(fs.readFileSync(CONFIG.CACHE_FILE, 'utf8'));
    } catch (e) {
        console.warn('⚠️  Cache corrupt, reset:', e.message);
        return {};
    }
}

function saveCache(cache) {
    try {
        fs.mkdirSync(path.dirname(CONFIG.CACHE_FILE), { recursive: true });
        fs.writeFileSync(CONFIG.CACHE_FILE, JSON.stringify(cache));
    } catch (e) {
        console.warn('⚠️  Gagal simpan cache:', e.message);
    }
}

// ==========================================
// API FETCHERS
// ==========================================
async function fetchCurrentRound() {
    const res = await http.get('/api/round/current');
    return res.data;
}

async function fetchPrice() {
    try {
        const res = await http.get('/api/price');
        return res.data?.bean || null;
    } catch (e) {
        console.warn('⚠️  Gagal tarik harga BEAN:', e.message);
        return null;
    }
}

async function fetchRoundsList(limit) {
    const res = await http.get(`/api/rounds?page=1&limit=${limit}&settled=true`);
    return res.data?.rounds || res.data?.data || [];
}

async function fetchRoundMiners(roundId) {
    const res = await http.get(`/api/round/${roundId}/miners`, { timeout: 8000 });
    let miners = res.data?.data || res.data?.miners || res.data;
    if (!Array.isArray(miners) && typeof miners === 'object') miners = Object.values(miners);
    return Array.isArray(miners) ? miners : [];
}

// ==========================================
// ANALYZER
// ==========================================
function analyzeRoundMiners(miners) {
    // Kembalikan: { isLotre, isSplit, isNoWinner, winner, totalETH, winningBlockETH }
    if (!miners || miners.length === 0) {
        return { isLotre: false, isSplit: false, isNoWinner: true, winner: null };
    }

    // Mode single winner/lotre: ada miner dengan beanReward >= 0.9
    const winner = miners.find((m) =>
        m.beanReward != null && parseFloat(m.beanReward) >= CONFIG.LOTRE_MIN_BEAN
    );

    if (winner) {
        return { isLotre: true, isSplit: false, isNoWinner: false, winner };
    }

    // Kalau ada miner dengan BEAN reward > 0 tapi < 0.9 → mode split (ada pemenang block)
    const anyBeanPaid = miners.some(
        (m) => m.beanReward != null && parseFloat(m.beanReward) > 0
    );
    if (anyBeanPaid) {
        return { isLotre: false, isSplit: true, isNoWinner: false, winner: null };
    }

    // Tidak ada BEAN dibayar → no-winner round (winning block kosong)
    return { isLotre: false, isSplit: false, isNoWinner: true, winner: null };
}

function analyzeCurrentRound(current) {
    const snap = {
        roundId: current?.roundId || current?.id || '?',
        totalPemain: 0,
        totalPool: 0,
        faksi: { SEMUT: { w: 0, eth: 0 }, MENENGAH: { w: 0, eth: 0 }, PAUS: { w: 0, eth: 0 } },
        kelas: {},
        blockCrowding: [],
        beanpotPool: parseFloat(current?.beanpotPoolFormatted || '0'),
    };

    // Hitung per-block crowding (least crowded = opportunity)
    const blocks = current?.blocks || [];
    snap.blockCrowding = blocks.map((b) => ({
        id: b.id,
        eth: parseFloat(b.deployedFormatted || '0'),
        miners: b.minerCount || 0,
    }));

    // Total pool sudah tersedia
    snap.totalPool = parseFloat(current?.totalDeployedFormatted || '0');

    // Agregasi miner per block (API ga expose list wallet di /current, jadi kita estimasi total pemain dari sum minerCount)
    // Catatan: ini over-count karena 1 wallet bisa deploy ke banyak block. API live tidak kasih unique user count.
    // Untuk snapshot LIVE yang akurat per-wallet, perlu miners endpoint yang belum exist untuk live round.
    snap.totalPemain = snap.blockCrowding.reduce((s, b) => s + b.miners, 0);

    return snap;
}

// ==========================================
// MESIN UTAMA
// ==========================================
async function jalankanSatelit() {
    const cache = loadCache();
    console.log(`[${new Date().toLocaleTimeString()}] 🛰️  Mulai pemindaian Macro-Radar...`);

    // --- 1. Live snapshot + harga ---
    const [current, price] = await Promise.all([
        fetchCurrentRound().catch(() => null),
        fetchPrice(),
    ]);

    const snap = current ? analyzeCurrentRound(current) : null;

    // --- 2. Ronde settled history ---
    const roundsList = await fetchRoundsList(CONFIG.SCAN_LIMIT);
    if (roundsList.length === 0) throw new Error('Data ronde kosong dari API.');

    const roundTerbaru = roundsList[0].roundId || roundsList[0].id;

    let totalLotre = 0;
    let totalSplit = 0;
    let totalNoWinner = 0;
    const statsKelasMenang = {};
    const leaderboard = {};

    console.log(`⏳ Menarik detail ${roundsList.length} ronde...`);

    for (let i = 0; i < roundsList.length; i++) {
        const rId = String(roundsList[i].roundId || roundsList[i].id);

        let miners;
        if (cache[rId]) {
            miners = cache[rId];
        } else {
            try {
                miners = await fetchRoundMiners(rId);
                // Simpan hanya field yang kita butuh (hemat disk)
                const slim = miners.map((m) => ({
                    address: (m.address || m.wallet || m.user || '').toLowerCase(),
                    beanReward: m.beanReward,
                    deployedFormatted: m.deployedFormatted,
                    deployed: m.deployed,
                }));
                cache[rId] = slim;
                miners = slim;
                process.stdout.write(`[${rId}✔] `);
            } catch (e) {
                process.stdout.write(`[${rId}❌] `);
                await delay(CONFIG.REQUEST_DELAY_MS);
                continue;
            }
            await delay(CONFIG.REQUEST_DELAY_MS);
        }

        const result = analyzeRoundMiners(miners);

        if (result.isLotre && result.winner) {
            const w = result.winner;
            const winDeploy = parseFloat(w.deployedFormatted || w.deployed || '0');
            if (winDeploy > 0) {
                totalLotre++;
                const kelas = getKelasModal(winDeploy);
                statsKelasMenang[kelas] = (statsKelasMenang[kelas] || 0) + 1;

                const addr = (w.address || '').toLowerCase();
                if (!leaderboard[addr]) leaderboard[addr] = { menang: 0, totalModal: 0 };
                leaderboard[addr].menang++;
                leaderboard[addr].totalModal += winDeploy;
            }
        } else if (result.isSplit) {
            totalSplit++;
        } else {
            totalNoWinner++;
        }
    }

    console.log('\n✅ Pemindaian selesai.');
    saveCache(cache);

    // --- 3. Snapshot live: agregasi faksi dari blockCrowding ---
    let snapText = '_(Snapshot live tidak tersedia)_';
    if (snap) {
        // Karena /current tidak expose per-wallet, kita gunakan data block-level:
        // - Total pool ETH live
        // - Crowding per-block (least → most)
        const sortedBlocks = [...snap.blockCrowding].sort((a, b) => a.eth - b.eth);
        const leastCrowded = sortedBlocks.slice(0, 5);
        const topCrowded = sortedBlocks.filter((b) => b.eth > 0).slice(-3).reverse();

        snapText =
            `👥 Total Deploy (block-level): ${snap.totalPemain} slot\n` +
            `💰 Total Pool Live: ${snap.totalPool.toFixed(6)} ETH\n` +
            `🫘 Beanpot Pool: *${snap.beanpotPool.toFixed(3)} BEAN*\n\n` +
            `*🎯 Block Paling Sepi (peluang share besar):*\n` +
            leastCrowded
                .map((b) => `  \`#${String(b.id).padStart(2, '0')}\` → ${b.eth.toFixed(6)} ETH (${b.miners} slot)`)
                .join('\n') +
            `\n\n*🔥 Block Paling Ramai:*\n` +
            (topCrowded.length
                ? topCrowded
                      .map((b) => `  \`#${String(b.id).padStart(2, '0')}\` → ${b.eth.toFixed(6)} ETH (${b.miners} slot)`)
                      .join('\n')
                : '  _(semua block kosong)_');
    }

    // --- 4. EV calc ---
    let evText = '_(Harga BEAN tidak tersedia)_';
    if (price && snap) {
        const priceNativeEth = parseFloat(price.priceNative || '0');
        const priceUsd = parseFloat(price.priceUsd || '0');
        const beanValue = 1 * priceNativeEth; // 1 BEAN per ronde (lotre/split)
        const beanpotEV = (1 / 777) * snap.beanpotPool * priceNativeEth;
        const totalEV = beanValue + beanpotEV;

        evText =
            `💹 Harga BEAN: $${priceUsd.toFixed(4)} (${priceNativeEth.toFixed(8)} ETH)\n` +
            `🎁 Value BEAN/ronde: ${beanValue.toFixed(8)} ETH\n` +
            `🎰 Beanpot EV (1/777): ${beanpotEV.toFixed(8)} ETH\n` +
            `📈 *Total EV reward*: ${totalEV.toFixed(8)} ETH\n` +
            `   ↳ Break-even bet (edge ~11%): ${(totalEV / 0.11).toFixed(8)} ETH`;
    }

    // --- 5. Triple Radar: Heavy Node + Dominan/Semut + Pool % ---
    const topPlayers = Object.keys(leaderboard)
        .map((k) => ({
            addr: k,
            menang: leaderboard[k].menang,
            avg: leaderboard[k].totalModal / leaderboard[k].menang,
        }))
        .sort((a, b) => b.menang - a.menang)
        .slice(0, 5);

    // --- 5A. HEAVY NODE: cari titik kumpul nominal terberat dari ronde terakhir ---
    let heavyNodeText = null;
    try {
        const lastRId = String(roundsList[0].roundId || roundsList[0].id);
        const lastMiners = cache[lastRId] || [];
        if (lastMiners.length > 0) {
            const nominalNodes = {};
            for (const m of lastMiners) {
                if ((m.address || '') === CONFIG.MY_ADDRESS) continue;
                const dep = parseFloat(m.deployedFormatted || m.deployed || '0');
                if (dep <= 0) continue;
                const key = dep.toFixed(6);
                if (!nominalNodes[key]) nominalNodes[key] = { bet: dep, count: 0, total: 0 };
                nominalNodes[key].count++;
                nominalNodes[key].total += dep;
            }
            let heaviest = { bet: 0, count: 0, total: 0 };
            for (const k in nominalNodes) {
                if (nominalNodes[k].total > heaviest.total) heaviest = nominalNodes[k];
            }
            if (heaviest.bet > 0) {
                let hitHeavy = heaviest.bet * (1 + CONFIG.MARGIN_LINDAS_PCT);
                if (hitHeavy > CONFIG.HARD_CAP_SETMAX) hitHeavy = CONFIG.HARD_CAP_SETMAX;
                heavyNodeText =
                    `*🏋️ Heavy Node:* \`/setmax ${hitHeavy.toFixed(6)}\`\n` +
                    `   ↳ Titik kumpul terberat: ${heaviest.bet.toFixed(6)} ETH (${heaviest.count} wlt, bobot ${heaviest.total.toFixed(6)} ETH)`;
            }
        }
    } catch (_) { /* ignore */ }

    // --- 5B. DOMINAN / SEMUT (leaderboard lotre) ---
    const dominan = topPlayers.find((p) => p.addr !== CONFIG.MY_ADDRESS);
    const targetKons = topPlayers.find(
        (p) => p.addr !== CONFIG.MY_ADDRESS && p.avg < THRESHOLDS.MARATHON_ATAS
    );

    const fmtSaran = (target, label) => {
        if (!target) return null;
        let hit = target.avg * (1 + CONFIG.MARGIN_LINDAS_PCT);
        const capped = hit > CONFIG.HARD_CAP_SETMAX;
        if (capped) hit = CONFIG.HARD_CAP_SETMAX;
        return (
            `*${label}:* \`/setmax ${hit.toFixed(6)}\`${capped ? ' _(dicap)_' : ''}\n` +
            `   ↳ vs \`${shortAddr(target.addr)}\` — ${target.menang}x menang, avg ${target.avg.toFixed(6)} ETH`
        );
    };

    // --- 5C. POOL %: bet = 10-15% total pool ronde terakhir ---
    let poolPctText = null;
    const poolRef = snap ? snap.totalPool : 0;
    if (poolRef > 0) {
        const pctUsed = (CONFIG.POOL_PCT_MIN + CONFIG.POOL_PCT_MAX) / 2; // pakai rata-rata untuk saran
        const totalBet = poolRef * pctUsed;
        const blockCount = 24; // asumsi mode skip/random
        let betPerBlock = totalBet / blockCount;
        if (betPerBlock > CONFIG.HARD_CAP_SETMAX) betPerBlock = CONFIG.HARD_CAP_SETMAX;
        poolPctText =
            `*📊 Pool %:* \`/setmax ${betPerBlock.toFixed(6)}\`\n` +
            `   ↳ ${(pctUsed * 100).toFixed(0)}% dari pool ${poolRef.toFixed(6)} ETH (÷${blockCount} blk = ${betPerBlock.toFixed(6)}/blk)`;
    }

    // --- Gabungkan 3 saran ---
    const saranList = [];
    if (heavyNodeText) saranList.push(heavyNodeText);
    if (targetKons) saranList.push(fmtSaran(targetKons, '🛡️ Semut (vs Kons)'));
    if (dominan && dominan.addr !== targetKons?.addr) {
        saranList.push(fmtSaran(dominan, '⚔️ Dominan (vs Whale)'));
    }
    if (poolPctText) saranList.push(poolPctText);

    const saranSetmax =
        saranList.length > 0
            ? saranList.join('\n\n')
            : '_Tidak ada target jelas. Pertahankan setmax saat ini._';

    // --- 6. Susun laporan ---
    const laporan = [
        `🛰️ *SATELIT INTELIJEN MINEBEAN*`,
        `📡 _Ronde Radar Terakhir: ${roundTerbaru} | Live: ${snap?.roundId || '?'}_`,
        `========================`,
        ``,
        `1️⃣ *SNAPSHOT RONDE LIVE*`,
        snapText,
        ``,
        `========================`,
        `2️⃣ *EV CALCULATOR*`,
        evText,
        ``,
        `========================`,
        `3️⃣ *META ${roundsList.length} RONDE TERAKHIR*`,
        `⚠️ *No-Winner:* ${totalNoWinner}x  |  🔀 *Split:* ${totalSplit}x  |  🎯 *Lotre (1 BEAN):* ${totalLotre}x`,
        ``,
        `🏆 *Distribusi Kelas Lotre:*`,
        `- ${LABELS.MICRO}: ${statsKelasMenang[LABELS.MICRO] || 0}x`,
        `- ${LABELS.SEMUT_BAWAH}: ${statsKelasMenang[LABELS.SEMUT_BAWAH] || 0}x`,
        `- ${LABELS.SEMUT_ATAS}: ${statsKelasMenang[LABELS.SEMUT_ATAS] || 0}x`,
        `- ${LABELS.MID_MARA}: ${statsKelasMenang[LABELS.MID_MARA] || 0}x`,
        `- ${LABELS.HIGH_MARA}: ${statsKelasMenang[LABELS.HIGH_MARA] || 0}x`,
        `- ${LABELS.MARA_ATAS}: ${statsKelasMenang[LABELS.MARA_ATAS] || 0}x`,
        `- ${LABELS.MIDDLE}: ${statsKelasMenang[LABELS.MIDDLE] || 0}x`,
        `- ${LABELS.WHALE}: ${statsKelasMenang[LABELS.WHALE] || 0}x`,
        ``,
        `🥇 *TOP 5 PENGUASA LOTRE:*`,
        topPlayers.length > 0
            ? topPlayers
                  .map((p, i) => {
                      const tag = p.addr === CONFIG.MY_ADDRESS ? ' *(Anda)*' : '';
                      return (
                          `${i + 1}. \`${shortAddr(p.addr)}\`${tag}\n` +
                          `   ↳ Menang: ${p.menang}x | Avg: ${p.avg.toFixed(6)} ETH`
                      );
                  })
                  .join('\n\n')
            : '_Belum ada pemenang lotre valid di window ini._',
        ``,
        `========================`,
        `💡 *KESIMPULAN TAKTIS (3 Strategi):*`,
        saranSetmax,
    ].join('\n');

    // --- 7. Kirim ---
    await bot.sendMessage(CONFIG.TELE_CHAT_ID, laporan, { parse_mode: 'Markdown' });
    console.log('✈️  Laporan Satelit terkirim ke Telegram.');

    // Cleanup cache: simpan max 500 entri terbaru untuk hindari bloat
    const keys = Object.keys(cache);
    if (keys.length > 500) {
        const sorted = keys.sort((a, b) => Number(b) - Number(a)).slice(0, 500);
        const trimmed = {};
        sorted.forEach((k) => { trimmed[k] = cache[k]; });
        saveCache(trimmed);
    }
}

// ==========================================
// ENTRYPOINT
// ==========================================
async function main() {
    const runOnce = process.argv.includes('--once');

    if (runOnce) {
        console.log('🛰️  Mode: sekali jalan (--once)');
        try {
            await jalankanSatelit();
        } catch (e) {
            console.error('❌ Error:', e.message);
            process.exitCode = 1;
        }
        return;
    }

    console.log(`🛰️  Mode: loop. Interval ${CONFIG.INTERVAL_MENIT} menit.`);
    while (true) {
        try {
            await jalankanSatelit();
        } catch (e) {
            console.error('❌ Error pada Satelit:', e.message);
            // Kirim notifikasi ringan kalau bisa
            try {
                await bot.sendMessage(
                    CONFIG.TELE_CHAT_ID,
                    `⚠️ Satelit error: ${escMd(e.message)}`,
                    { parse_mode: 'Markdown' }
                );
            } catch (_) { /* ignore */ }
        }
        console.log(`💤 Istirahat ${CONFIG.INTERVAL_MENIT} menit...\n`);
        await delay(CONFIG.INTERVAL_MENIT * 60 * 1000);
    }
}

main().catch((e) => {
    console.error('❌ Fatal:', e);
    process.exit(1);
});
