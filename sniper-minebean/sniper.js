'use strict';

/**
 * MINEBEAN SNIPER v15 — CLEAN REFACTOR
 * ======================================================
 * Fitur dipertahankan:
 *   - Semua command Telegram v14.1 (setev, setboard, setbet, setswap, setpot,
 *     setmax, setsatelit, mode, bobot, status, balance, antiloss, setloss,
 *     setcooldown, setevbuffer, stop)
 *   - 3 Deploy Mode (skip / random / all)
 *   - Volume Node Radar (HEAVY_NODE_SNIPE)
 *   - Anti-loss streak + cooldown
 *   - Adaptive gas
 *   - Auto-claim ETH/BEAN + Auto-swap via KyberSwap
 *   - CSV logging per round
 *
 * Fix bug dari v14.1:
 *   - Satelit v2: filter target diperluas (tidak hanya Semut), cap benar
 *   - prevWinningBlock diambil dari /api/round/{id} (bukan /miners)
 *   - Margin lindas konsisten via MARGIN_LINDAS_PCT
 *   - Satelit internal TIDAK override HARD_MAX_SAFETY yang baru di-set user < 30 dtk lalu
 *   - ETH price fallback ke CoinGecko kalau priceNative mencurigakan
 */

require('dotenv').config();
const { ethers } = require('ethers');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');

// =============================================================
// ENV + KONFIGURASI
// =============================================================
const ENV = {
    RPC_URL: process.env.BASE_RPC_URL,
    PRIVATE_KEY: process.env.PRIVATE_KEY,
    TG_BOT_TOKEN: process.env.TG_BOT_TOKEN,
    TG_CHAT_ID: process.env.TG_CHAT_ID,
};
for (const [k, v] of Object.entries(ENV)) {
    if (!v) throw new Error(`Env tidak ditemukan: ${k}`);
}

const CFG = {
    // Dinamis (bisa diubah via Telegram command)
    DEFAULT_BET_PER_BLOCK: ethers.parseEther(process.env.DEFAULT_BET_PER_BLOCK || '0.0000029'),
    HARD_MAX_SAFETY:       ethers.parseEther(process.env.HARD_MAX_SAFETY       || '0.0000099'),
    GATEKEEPER_THRESHOLD:  parseFloat(process.env.GATEKEEPER_THRESHOLD         || '0.034'),
    MIN_PROFIT_THRESHOLD:  parseFloat(process.env.MIN_PROFIT_THRESHOLD         || '-0.15'),
    MIN_BEANPOT_THRESHOLD: parseFloat(process.env.MIN_BEANPOT_THRESHOLD        || '0'),
    MIN_EV_BUFFER_USD:     parseFloat(process.env.MIN_EV_BUFFER_USD            || '0.02'),
    AUTO_CLAIM_ETH:        ethers.parseEther(process.env.AUTO_CLAIM_ETH        || '0.0025'),
    AUTO_CLAIM_BEAN:       ethers.parseEther(process.env.AUTO_CLAIM_BEAN       || '0.25'),
    AUTO_SWAP_THRESHOLD:   ethers.parseEther(process.env.AUTO_SWAP_THRESHOLD   || '0.39'),
    MAX_LOSS_STREAK:       parseInt(process.env.MAX_LOSS_STREAK  || '4', 10),
    COOLDOWN_ROUNDS:       parseInt(process.env.COOLDOWN_ROUNDS  || '2', 10),
    LOSS_USD_TRIGGER:      -0.01,

    // Konstanta (tidak diubah runtime)
    EXPECTED_LATE_WHALES: 0.00,
    BASE_EXECUTION_TIME: 8,
    ADMIN_FEE_BPS: 0.01,
    VAULT_FEE_BPS: 0.10,
    ROASTING_FEE_BPS: 0.10,
    BEAN_PER_ROUND: 1.0,
    BEANPOT_ODDS: 1 / 777,
    MAX_CONSECUTIVE_ERRORS: 5,

    // Kalibrasi strategi (center of truth — dipakai Radar & Satelit)
    MARGIN_LINDAS_PCT: 0.15,           // +15% di atas target
    SATELIT_INTERVAL_MS: 10 * 60_000,  // pemindaian satelit tiap 10 menit
    SATELIT_SCAN_LIMIT: 50,
    SATELIT_LOTRE_MIN_BEAN: 0.9,
    SATELIT_RESPECT_MANUAL_SEC: 30,    // satelit tidak override setmax manual < 30s terakhir

    // Pool-Percentage Radar (bet = X% total pool ronde sebelumnya)
    POOL_PCT_MIN: 0.10,    // 10% dari total pool
    POOL_PCT_MAX: 0.15,    // 15% dari total pool (random antara MIN-MAX tiap ronde)
};

const FLAGS = {
    ENABLE_BOBOT_ENGINE: true,
    ENABLE_SATELIT: true,
    ENABLE_ANTI_LOSS: true,
};

const LOG_FILE = './minebean_round_log.csv';

// Alamat kontrak & API
const GRIDMINING_ADDR = '0x9632495bDb93FD6B0740Ab69cc6c71C9c01da4f0';
const BEAN_TOKEN_ADDR = '0x5c72992b83E74c4D5200A8E8920fB946214a5A5D';
const MINEBEAN_API = 'https://api.minebean.com';

const ABI = [
    'function deploy(uint8[] calldata blockIds) external payable',
    'function claimETH() external',
    'function claimBEAN() external',
    'function getCurrentRoundInfo() external view returns (uint64 roundId, uint256 startTime, uint256 endTime, uint256 totalDeployed, uint256 timeRemaining, bool isActive)',
    'function getTotalPendingRewards(address) external view returns (uint256 pendingETH, uint256 unforgedBEAN, uint256 forgedBEAN, uint64 uncheckpointedRound)',
    'function beanpotPool() external view returns (uint256)',
];
const ERC20_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function approve(address, uint256) returns (bool)',
    'function allowance(address, address) view returns (uint256)',
];

// Setup ethers
const provider = new ethers.JsonRpcProvider(ENV.RPC_URL);
const wallet = new ethers.Wallet(ENV.PRIVATE_KEY, provider);
const grid = new ethers.Contract(GRIDMINING_ADDR, ABI, wallet);
const beanToken = new ethers.Contract(BEAN_TOKEN_ADDR, ERC20_ABI, wallet);
const MY_ADDRESS = wallet.address.toLowerCase();

const bot = new TelegramBot(ENV.TG_BOT_TOKEN, { polling: true });

// =============================================================
// STATE
// =============================================================
const STATE = {
    // Round tracking
    lastR: 0,
    preDeployB: 0n,
    preDeployETH: 0n,
    lastRoundBet: 0n,
    played: false,
    deploying: false,
    isProcessing: false,
    isSwapping: false,
    pendingSwapAmount: 0n,
    lastDeployMeta: null,

    // Pasar
    currentBeanPriceUsd: 0,
    currentEthPriceUsd: 0,
    currentBeanpotBean: 0,
    currentLatency: 300,

    // Rekap
    roundCounter: 0,
    sumBean: 0n,
    sumEthChange: 0n,
    sumUsdProfit: 0,

    // Radar
    nextRoundStrategy: {
        mode: 'NORMAL',
        recommendedBet: 0n,
        shouldDeploy: true,
        source: 'DEFAULT',
        reason: 'Base bet default',
    },
    lastBobotReport: null,

    // Satelit
    isSatelitRunning: false,
    lastSatelitReport: null,
    lastManualSetMaxAt: 0, // epoch ms saat user terakhir /setmax manual

    // Anti-loss
    lossStreak: 0,
    winStreak: 0,
    cooldownUntilRound: 0,

    // Mode & block
    deployMode: 'random',
    prevWinningBlock: -1,
    radarMode: 'pool',  // 'node' = heavy-node snipe (v14.1), 'pool' = % dari total pool (v15+)
    lastPoolTotalEth: 0, // total pool ronde sebelumnya (dipakai mode pool)

    // RPC health
    consecutiveRpcErrors: 0,
    rpcAlertSent: false,
};

// =============================================================
// UTIL
// =============================================================
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const isOwner = (msg) => msg.chat.id.toString() === ENV.TG_CHAT_ID;

async function tg(msg) {
    try {
        await bot.sendMessage(ENV.TG_CHAT_ID, msg, { parse_mode: 'Markdown' });
    } catch (e) {
        console.error('Kirim TG gagal:', e.message);
    }
}

function parseDeployWei(v) {
    if (v == null) return 0n;
    const s = String(v);
    if (s.includes('.')) { try { return ethers.parseEther(s); } catch (_) { return 0n; } }
    try { return BigInt(s); } catch (_) {}
    try { return ethers.parseEther(String(Number(s) || 0)); } catch (_) { return 0n; }
}

function fmtEthFloat(n, d = 9) { return Number(n || 0).toFixed(d); }

function shortAddr(a) {
    return a ? `${a.slice(0, 6)}...${a.slice(-4)}` : 'unknown';
}

function csvEscape(v) {
    const str = String(v ?? '');
    if (str.includes(',') || str.includes('"') || str.includes('\n')) return JSON.stringify(str);
    return str;
}

function ensureLogHeader() {
    if (!fs.existsSync(LOG_FILE)) {
        const hdr = ['time','round','mode','source','bet_per_block_eth','total_bet_eth',
            'board_eth','beanpot_bean','ev_usd','gas_usd','profit_usd','bean_delta',
            'eth_delta','loss_streak','win_streak','cooldown_until','reason'].join(',') + '\n';
        fs.writeFileSync(LOG_FILE, hdr);
    }
}

function appendRoundLog(row) {
    try {
        ensureLogHeader();
        const line = [new Date().toISOString(), row.roundId, row.mode, row.source,
            row.betPerBlockEth, row.totalBetEth, row.boardEth, row.beanpotBean,
            row.evUsd, row.gasUsd, row.profitUsd, row.beanDelta, row.ethDelta,
            STATE.lossStreak, STATE.winStreak, STATE.cooldownUntilRound || '',
            row.reason].map(csvEscape).join(',') + '\n';
        fs.appendFileSync(LOG_FILE, line);
    } catch (e) { /* ignore */ }
}

// =============================================================
// HARGA & LATENSI
// =============================================================
async function measureLatency() {
    const start = Date.now();
    try {
        await provider.getBlockNumber();
        STATE.currentLatency = Date.now() - start;
    } catch (e) {
        STATE.currentLatency = 1000;
    }
}

async function updatePrices() {
    try {
        const res = await axios.get(`${MINEBEAN_API}/api/price`, { timeout: 5000 });
        if (res.data?.bean?.priceUsd) {
            STATE.currentBeanPriceUsd = parseFloat(res.data.bean.priceUsd);
            const priceNative = parseFloat(res.data.bean.priceNative);
            if (priceNative > 0) {
                const derivedEthUsd = STATE.currentBeanPriceUsd / priceNative;
                // Sanity check: ETH di Base normalnya $2000-$5000. Kalau di luar, fallback ke CoinGecko.
                if (derivedEthUsd > 1000 && derivedEthUsd < 10000) {
                    STATE.currentEthPriceUsd = derivedEthUsd;
                } else {
                    await fetchEthPriceFallback();
                }
            }
        }
    } catch (e) { /* ignore */ }
}

async function fetchEthPriceFallback() {
    try {
        const res = await axios.get(
            'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd',
            { timeout: 5000 }
        );
        if (res.data?.ethereum?.usd) STATE.currentEthPriceUsd = res.data.ethereum.usd;
    } catch (_) { /* ignore */ }
}

async function updateBeanpot() {
    try {
        const wei = await grid.beanpotPool();
        STATE.currentBeanpotBean = parseFloat(ethers.formatEther(wei));
    } catch (e) { /* ignore */ }
}

// =============================================================
// ADAPTIVE GAS
// =============================================================
async function getAdaptiveFee({ boardEth = 0, gasLimit = 750_000n, purpose = 'deploy' } = {}) {
    const fee = await provider.getFeeData();
    const latestBlock = await provider.getBlock('latest').catch(() => null);
    const fallbackBase = ethers.parseUnits('0.10', 'gwei');
    const baseFee = latestBlock?.baseFeePerGas || fee.gasPrice || fallbackBase;

    let minPriorityGwei = '0.0048';
    if (purpose === 'swap') minPriorityGwei = '0.0048';
    else if (boardEth >= CFG.GATEKEEPER_THRESHOLD * 0.75)
        minPriorityGwei = STATE.currentLatency > 700 ? '0.012' : '0.009';
    else if (boardEth >= CFG.GATEKEEPER_THRESHOLD * 0.45 || STATE.currentLatency > 700)
        minPriorityGwei = '0.0075';
    else minPriorityGwei = '0.0055';

    const minPriorityFee = ethers.parseUnits(minPriorityGwei, 'gwei');
    const rpcPriorityFee = fee.maxPriorityFeePerGas || fee.gasPrice || minPriorityFee;

    let priorityFee = rpcPriorityFee < minPriorityFee ? minPriorityFee : rpcPriorityFee;
    const priorityCap = purpose === 'swap'
        ? ethers.parseUnits('0.008', 'gwei')
        : ethers.parseUnits('0.010', 'gwei');
    if (priorityFee > priorityCap) priorityFee = priorityCap;

    let maxFee = (baseFee * 2n) + priorityFee;
    const rpcMaxFee = fee.maxFeePerGas || 0n;
    if (rpcMaxFee > 0n && rpcMaxFee >= maxFee && rpcMaxFee < (maxFee * 12n / 10n)) maxFee = rpcMaxFee;

    return {
        maxFeePerGas: maxFee,
        maxPriorityFeePerGas: priorityFee,
        gasUsd: parseFloat(ethers.formatEther(gasLimit * maxFee)) * STATE.currentEthPriceUsd,
        priorityGwei: ethers.formatUnits(priorityFee, 'gwei'),
        baseGwei: ethers.formatUnits(baseFee, 'gwei'),
        maxFeeGwei: ethers.formatUnits(maxFee, 'gwei'),
    };
}

// =============================================================
// AUTO-SWAP BEAN -> ETH (KyberSwap)
// =============================================================
async function swapBeanToEth(amount) {
    try {
        const ETH_ADDR = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
        const routeRes = await axios.get(
            'https://aggregator-api.kyberswap.com/base/api/v1/routes',
            { params: { tokenIn: BEAN_TOKEN_ADDR, tokenOut: ETH_ADDR, amountIn: amount.toString() }, timeout: 10_000 }
        );
        const routeSummary = routeRes.data?.data?.routeSummary;
        if (!routeSummary) throw new Error('Rute swap tidak ditemukan di KyberSwap');

        const buildBody = { routeSummary, sender: wallet.address, recipient: wallet.address, slippageTolerance: 100 };
        const buildRes = await axios.post(
            'https://aggregator-api.kyberswap.com/base/api/v1/route/build',
            buildBody, { timeout: 10_000 }
        );
        const txData = buildRes.data?.data;

        const allowance = await beanToken.allowance(wallet.address, txData.routerAddress);
        if (allowance < amount) {
            const txApp = await beanToken.approve(txData.routerAddress, ethers.MaxUint256);
            await txApp.wait();
        }

        const swapGas = await getAdaptiveFee({ purpose: 'swap', gasLimit: 900_000n });
        const txSwap = await wallet.sendTransaction({
            to: txData.routerAddress,
            data: txData.data,
            value: txData.value || 0n,
            gasLimit: 900_000,
            maxFeePerGas: swapGas.maxFeePerGas,
            maxPriorityFeePerGas: swapGas.maxPriorityFeePerGas,
        });
        await txSwap.wait();
        await tg(
            `🔄 *AUTO-SWAP SUKSES!*\n` +
            `Menukar *${ethers.formatEther(amount)}* BEAN ➡️ ETH.\n` +
            `\`${txSwap.hash.slice(0, 18)}...\``
        );
    } catch (e) {
        STATE.pendingSwapAmount = amount;
        throw e;
    }
}

// =============================================================
// CEK REWARD + AUTO-CLAIM
// =============================================================
function applyRiskAfterRound(roundId, profitUsd) {
    if (!FLAGS.ENABLE_ANTI_LOSS) return;
    if (profitUsd <= CFG.LOSS_USD_TRIGGER) { STATE.lossStreak++; STATE.winStreak = 0; }
    else if (profitUsd > 0) { STATE.winStreak++; STATE.lossStreak = 0; }
    if (STATE.lossStreak >= CFG.MAX_LOSS_STREAK) {
        STATE.cooldownUntilRound = Number(roundId) + CFG.COOLDOWN_ROUNDS;
    }
}

async function checkReward(rId) {
    try {
        const r = await grid.getTotalPendingRewards(wallet.address);
        const totalBeanNow = r[1] + r[2];
        const dBean = totalBeanNow >= STATE.preDeployB ? totalBeanNow - STATE.preDeployB : 0n;
        const netEthChange = (r[0] - STATE.preDeployETH) - STATE.lastRoundBet;

        const profitUsd =
            parseFloat(ethers.formatEther(dBean)) * STATE.currentBeanPriceUsd +
            parseFloat(ethers.formatEther(netEthChange)) * STATE.currentEthPriceUsd;

        applyRiskAfterRound(rId - 1, profitUsd);
        appendRoundLog({
            roundId: rId - 1,
            mode: STATE.lastDeployMeta?.mode || STATE.nextRoundStrategy.mode,
            source: STATE.lastDeployMeta?.source || STATE.nextRoundStrategy.source,
            betPerBlockEth: STATE.lastDeployMeta?.betPerBlockEth || '',
            totalBetEth: ethers.formatEther(STATE.lastRoundBet),
            boardEth: STATE.lastDeployMeta?.boardEth ?? '',
            beanpotBean: STATE.lastDeployMeta?.beanpotBean ?? '',
            evUsd: STATE.lastDeployMeta?.evUsd ?? '',
            gasUsd: STATE.lastDeployMeta?.gasUsd ?? '',
            profitUsd: profitUsd.toFixed(6),
            beanDelta: ethers.formatEther(dBean),
            ethDelta: ethers.formatEther(netEthChange),
            reason: STATE.lastDeployMeta?.reason || '',
        });

        STATE.sumBean += dBean;
        STATE.sumEthChange += netEthChange;
        STATE.sumUsdProfit += profitUsd;
        STATE.roundCounter++;

        await tg(
            `🎯 *R#${rId - 1} SELESAI!*\n` +
            `💸 *Profit:* *$${profitUsd.toFixed(4)}*\n` +
            `💰 *BEAN:* \`${ethers.formatEther(dBean)}\`\n` +
            `📈 *ETH:* \`${ethers.formatEther(netEthChange)}\` ETH`
        );

        if (STATE.roundCounter >= 10) {
            await tg(
                `📊 *REKAP 10 RONDE*\n` +
                `💸 *Total Profit:* *$${STATE.sumUsdProfit.toFixed(4)}*\n` +
                `📈 *Total P&L ETH:* \`${ethers.formatEther(STATE.sumEthChange)}\` ETH`
            );
            STATE.roundCounter = 0;
            STATE.sumBean = 0n;
            STATE.sumEthChange = 0n;
            STATE.sumUsdProfit = 0;
        }

        if (r[0] >= CFG.AUTO_CLAIM_ETH) {
            try {
                const tx = await grid.claimETH();
                await tx.wait();
                await tg(`💸 *AUTO-CLAIM ETH SUKSES!*\nJumlah: ${ethers.formatEther(r[0])} ETH`);
            } catch (e) { /* ignore */ }
        }

        if (totalBeanNow >= CFG.AUTO_CLAIM_BEAN) {
            try {
                const tx = await grid.claimBEAN();
                await tx.wait();
                await tg(`🫘 *AUTO-CLAIM BEAN SUKSES!*\nJumlah: ${ethers.formatEther(totalBeanNow)} BEAN`);
            } catch (e) { /* ignore */ }
        }

        const myBeanBalance = await beanToken.balanceOf(wallet.address);
        if (
            myBeanBalance >= CFG.AUTO_SWAP_THRESHOLD &&
            !STATE.isSwapping &&
            STATE.pendingSwapAmount === 0n
        ) {
            STATE.pendingSwapAmount = myBeanBalance;
        }
    } catch (e) { /* ignore */ }
}

// =============================================================
// RADAR VOLUME (HEAVY NODE)
// =============================================================
async function buildBobotDecision(roundId, { notify = false } = {}) {
    // Ambil summary ronde dulu (winning block dari sini, bukan /miners)
    try {
        const sumRes = await axios.get(`${MINEBEAN_API}/api/round/${roundId}`, { timeout: 5000 });
        const wb = sumRes.data?.winningBlock ?? sumRes.data?.data?.winningBlock;
        if (wb != null && wb >= 0 && wb <= 24) {
            STATE.prevWinningBlock = Number(wb);
            console.log(`🎯 Prev winning block: ${STATE.prevWinningBlock}`);
        }
    } catch (_) { /* ignore, tidak fatal */ }

    const res = await axios.get(`${MINEBEAN_API}/api/round/${roundId}/miners`, { timeout: 7000 });
    let miners = res.data?.miners || res.data?.data?.miners || res.data?.data || res.data;
    if (!Array.isArray(miners) && miners && typeof miners === 'object') miners = Object.values(miners);
    if (!Array.isArray(miners) || miners.length === 0) throw new Error('Data miner kosong');

    let totalDeploy = 0;
    let selfDeploy = 0;
    let selfCount = 0;
    const nominalNodes = {};
    const rows = [];

    for (const m of miners) {
        let rawAddr = m.address || m.walletAddress || m.deployer || m.user || m.miner || m.wallet || m.account;
        if (typeof rawAddr === 'object' && rawAddr !== null) {
            rawAddr = rawAddr.address || rawAddr.wallet || rawAddr.id;
        }
        const addr = String(rawAddr || 'unknown').toLowerCase();

        const deployWei = parseDeployWei(m.deployedFormatted ?? m.deployed ?? 0);
        const deploy = parseFloat(ethers.formatEther(deployWei));
        if (deploy <= 0) continue;

        if (addr === MY_ADDRESS) {
            selfDeploy += deploy;
            selfCount++;
            continue;
        }

        totalDeploy += deploy;
        const betKey = deploy.toFixed(6);
        if (!nominalNodes[betKey]) {
            nominalNodes[betKey] = { betWei: deployWei, betEth: deploy, totalWei: 0n, count: 0 };
        }
        nominalNodes[betKey].totalWei += deployWei;
        nominalNodes[betKey].count += 1;
        rows.push({ addr, deploy, deployWei });
    }

    let heaviestNodeWei = 0n;
    let maxWeightWei = 0n;
    let heaviestCount = 0;
    for (const key in nominalNodes) {
        if (nominalNodes[key].totalWei > maxWeightWei) {
            maxWeightWei = nominalNodes[key].totalWei;
            heaviestNodeWei = nominalNodes[key].betWei;
            heaviestCount = nominalNodes[key].count;
        }
    }

    // Gunakan margin tunggal (MARGIN_LINDAS_PCT) supaya konsisten di semua engine
    const marginBP = BigInt(Math.round((1 + CFG.MARGIN_LINDAS_PCT) * 100));
    let recommendedBet = (heaviestNodeWei * marginBP) / 100n;

    if (recommendedBet < CFG.DEFAULT_BET_PER_BLOCK) recommendedBet = CFG.DEFAULT_BET_PER_BLOCK;

    let capped = false;
    if (recommendedBet > CFG.HARD_MAX_SAFETY) {
        recommendedBet = CFG.HARD_MAX_SAFETY;
        capped = true;
    }

    const pct = (CFG.MARGIN_LINDAS_PCT * 100).toFixed(0);
    const reason =
        `Titik kumpul terberat di bet ${ethers.formatEther(heaviestNodeWei)} ETH ` +
        `(${heaviestCount} wlt, total bobot: ${ethers.formatEther(maxWeightWei)} ETH). ` +
        `Menembak +${pct}% di atasnya.`;

    const decision = {
        roundId,
        mode: 'HEAVY_NODE_SNIPE',
        shouldDeploy: true,
        recommendedBet,
        reason,
        source: 'VOLUME_ENGINE',
        capped,
        totalDeploy,
        selfDeploy,
        selfCount,
        rows,
        heaviestNodeWei,
        maxWeightWei,
        heaviestCount,
    };

    STATE.lastBobotReport = decision;
    if (notify) await tg(formatVolumeTelegram(decision));
    return decision;
}

function formatVolumeTelegram(d) {
    const rec = d.recommendedBet > 0n ? ethers.formatEther(d.recommendedBet) : 'SKIP';
    const pct = (CFG.MARGIN_LINDAS_PCT * 100).toFixed(0);
    return [
        `🧠 *RADAR VOLUME NODE R#${d.roundId}*`,
        `👥 Lawan: *${d.rows.length}* | Pool: *${fmtEthFloat(d.totalDeploy)} ETH*`,
        `🙋 Self skipped: *${d.selfCount || 0}* wlt | ${fmtEthFloat(d.selfDeploy || 0)} ETH`,
        '',
        `🏋️ *TITIK KUMPUL TERBERAT (HEAVY NODE)*`,
        `   ↳ Nominal Bet : \`${ethers.formatEther(d.heaviestNodeWei)}\` ETH`,
        `   ↳ Jml Wallet  : ${d.heaviestCount} player`,
        `   ↳ Total Bobot : *${ethers.formatEther(d.maxWeightWei)}* ETH`,
        '',
        `🎯 Mode: *${String(d.mode).replaceAll('_', '-')}*`,
        `💡 Taktik: Overtake +${pct}% dari Nominal Terberat`,
        `💸 Eksekusi: *${rec}* ${d.capped ? '(CAP)' : ''}`,
        `🧾 ${d.reason}`,
    ].join('\n');
}

async function updateStrategyFromPreviousRound(roundId) {
    try {
        await delay(2500); // tunggu API settle
        if (!FLAGS.ENABLE_BOBOT_ENGINE) {
            STATE.nextRoundStrategy = {
                mode: 'NORMAL',
                recommendedBet: CFG.DEFAULT_BET_PER_BLOCK,
                shouldDeploy: true,
                source: 'DEFAULT',
                reason: 'Radar Off',
            };
            return;
        }

        // MODE POOL: bet = 10-15% total pool ronde sebelumnya
        if (STATE.radarMode === 'pool') {
            await buildPoolPctDecision(roundId);
            return;
        }

        // MODE NODE: heavy-node snipe (v14.1 logic)
        const decision = await buildBobotDecision(roundId, { notify: false });
        STATE.nextRoundStrategy = {
            mode: decision.mode,
            recommendedBet: decision.recommendedBet,
            shouldDeploy: decision.shouldDeploy,
            source: decision.source,
            reason: decision.reason,
        };
        console.log(
            `🧠 Radar R#${roundId}: ${decision.mode} | ` +
            `bet=${ethers.formatEther(decision.recommendedBet)} | ` +
            `HeavyNode=${ethers.formatEther(decision.heaviestNodeWei)}`
        );
    } catch (e) {
        console.error('Radar Engine Error:', e.message);
        STATE.nextRoundStrategy = {
            mode: 'NORMAL',
            recommendedBet: CFG.DEFAULT_BET_PER_BLOCK,
            shouldDeploy: true,
            source: 'FALLBACK',
            reason: `Radar error: ${e.message}`,
        };
    }
}

// =============================================================
// POOL PERCENTAGE RADAR — bet = 10-15% total pool ronde sebelumnya
// Logika: ambil totalDeployed dari ronde lalu, kalkulasi bet total
// sebagai % dari pool tsb, lalu bagi rata ke jumlah block yang dideploy.
// =============================================================
async function buildPoolPctDecision(roundId) {
    // Ambil summary ronde (untuk winning block + totalDeployed)
    let poolEth = 0;
    try {
        const sumRes = await axios.get(`${MINEBEAN_API}/api/round/${roundId}`, { timeout: 5000 });
        const data = sumRes.data?.data || sumRes.data;

        // Winning block
        const wb = data?.winningBlock;
        if (wb != null && wb >= 0 && wb <= 24) {
            STATE.prevWinningBlock = Number(wb);
        }

        // Total pool dari ronde ini
        const totalRaw = data?.totalDeployedFormatted || data?.totalDeployed;
        if (totalRaw) {
            poolEth = parseFloat(String(totalRaw).includes('.') ? totalRaw : ethers.formatEther(BigInt(totalRaw)));
        }
    } catch (e) {
        console.warn(`⚠️ [POOL] Gagal ambil data ronde #${roundId}:`, e.message);
    }

    // Kalau pool 0 (ronde kosong), fallback ke default bet
    if (poolEth <= 0) {
        STATE.lastPoolTotalEth = 0;
        STATE.nextRoundStrategy = {
            mode: 'POOL_PCT',
            recommendedBet: CFG.DEFAULT_BET_PER_BLOCK,
            shouldDeploy: true,
            source: 'POOL_ENGINE',
            reason: `Pool ronde #${roundId} kosong/error, pakai base bet.`,
        };
        return;
    }

    STATE.lastPoolTotalEth = poolEth;

    // Random % antara POOL_PCT_MIN dan POOL_PCT_MAX (10-15%)
    const pctUsed = CFG.POOL_PCT_MIN + Math.random() * (CFG.POOL_PCT_MAX - CFG.POOL_PCT_MIN);
    const totalBetEth = poolEth * pctUsed;

    // Bagi ke jumlah block yang akan di-deploy
    let blockCount = 25;
    if (STATE.deployMode === 'skip' || STATE.deployMode === 'random') blockCount = 24;

    const betPerBlockEth = totalBetEth / blockCount;
    let recommendedBet = ethers.parseEther(betPerBlockEth.toFixed(18));

    // Floor: jangan di bawah DEFAULT_BET
    if (recommendedBet < CFG.DEFAULT_BET_PER_BLOCK) {
        recommendedBet = CFG.DEFAULT_BET_PER_BLOCK;
    }

    // Ceiling: jangan di atas HARD_MAX_SAFETY
    let capped = false;
    if (recommendedBet > CFG.HARD_MAX_SAFETY) {
        recommendedBet = CFG.HARD_MAX_SAFETY;
        capped = true;
    }

    const reason =
        `Pool R#${roundId}: ${poolEth.toFixed(6)} ETH. ` +
        `Bet ${(pctUsed * 100).toFixed(1)}% = ${totalBetEth.toFixed(6)} ETH total ` +
        `(÷${blockCount} blk = ${betPerBlockEth.toFixed(6)}/blk)` +
        (capped ? ' [CAPPED]' : '');

    STATE.nextRoundStrategy = {
        mode: 'POOL_PCT',
        recommendedBet,
        shouldDeploy: true,
        source: 'POOL_ENGINE',
        reason,
    };

    console.log(
        `📊 Pool Radar R#${roundId}: pool=${poolEth.toFixed(6)} | ` +
        `pct=${(pctUsed * 100).toFixed(1)}% | ` +
        `bet/blk=${ethers.formatEther(recommendedBet)}`
    );
}

// =============================================================
// SATELIT V2 (DYNAMIC SETMAX AUTO-UPDATER)
// =============================================================
// Perubahan dari v1:
// - Filter target diperluas: semua kelas di bawah Whale (<0.000300 ETH),
//   bukan hanya kelas Semut. Whale AutoMine-All dapat terdeteksi.
// - Hard cap typo diperbaiki (pake konstanta tunggal).
// - Tidak override HARD_MAX_SAFETY yang baru di-set manual <30 detik lalu.
// - Laporkan dua target (konservatif + dominan) untuk transparansi.
async function runSatelitEngine() {
    if (!FLAGS.ENABLE_SATELIT || STATE.isSatelitRunning) return;
    STATE.isSatelitRunning = true;

    try {
        console.log(`\n🛰️ [SATELIT v2] Memulai pemindaian ${CFG.SATELIT_SCAN_LIMIT} ronde...`);
        const roundsRes = await axios.get(
            `${MINEBEAN_API}/api/rounds?page=1&limit=${CFG.SATELIT_SCAN_LIMIT}&settled=true`,
            { timeout: 8000 }
        );
        const roundsList = roundsRes.data?.rounds || roundsRes.data?.data || [];
        if (roundsList.length === 0) return;

        const leaderboard = {};

        for (let i = 0; i < roundsList.length; i++) {
            const rId = roundsList[i].roundId || roundsList[i].id;
            try {
                const detailRes = await axios.get(
                    `${MINEBEAN_API}/api/round/${rId}/miners`,
                    { timeout: 5000 }
                );
                let miners = detailRes.data?.data || detailRes.data?.miners || detailRes.data;
                if (!Array.isArray(miners) && typeof miners === 'object') miners = Object.values(miners);
                if (!miners || miners.length === 0) continue;

                // Hanya hitung mode lotre (single winner dapat >= 0.9 BEAN penuh)
                const winner = miners.find(
                    (m) => m.beanReward && parseFloat(m.beanReward) >= CFG.SATELIT_LOTRE_MIN_BEAN
                );
                if (!winner) continue;

                const winDeploy = parseFloat(winner.deployedFormatted || winner.deployed || 0);
                if (winDeploy <= 0) continue;

                const addr = String(winner.address || winner.wallet || winner.user || 'unknown').toLowerCase();
                if (!leaderboard[addr]) leaderboard[addr] = { menang: 0, totalModal: 0 };
                leaderboard[addr].menang++;
                leaderboard[addr].totalModal += winDeploy;
            } catch (_) { /* skip per-ronde error */ }
            await delay(200);
        }

        const topPlayers = Object.keys(leaderboard)
            .map((k) => ({
                addr: k,
                menang: leaderboard[k].menang,
                avg: leaderboard[k].totalModal / leaderboard[k].menang,
            }))
            .sort((a, b) => b.menang - a.menang);

        // --- Target DOMINAN: pemenang terbanyak (kecuali Whale >= 0.000300) ---
        const dominan = topPlayers.find(
            (p) => p.addr !== MY_ADDRESS && p.avg < 0.000300
        );

        if (!dominan) {
            console.log(`ℹ️ [SATELIT] Tidak ada target valid, SetMax tetap.`);
            STATE.lastSatelitReport = { ts: Date.now(), target: null };
            return;
        }

        // Kalibrasi +MARGIN_LINDAS_PCT, cap ke HARD_CAP absolute
        let targetHit = dominan.avg * (1 + CFG.MARGIN_LINDAS_PCT);
        const ABSOLUTE_CAP = 0.000250; // cap keras absolut
        if (targetHit > ABSOLUTE_CAP) targetHit = ABSOLUTE_CAP;

        const newMaxWei = ethers.parseEther(targetHit.toFixed(6));

        // Hormati setmax manual: kalau user baru /setmax < 30 detik lalu, skip override
        const sinceManualSec = (Date.now() - STATE.lastManualSetMaxAt) / 1000;
        if (sinceManualSec < CFG.SATELIT_RESPECT_MANUAL_SEC) {
            console.log(`🙅 [SATELIT] Skip override: user baru /setmax ${sinceManualSec.toFixed(0)}s lalu.`);
            return;
        }

        // Kalau hasil sama persis dengan nilai sekarang, tidak usah kirim notif
        if (CFG.HARD_MAX_SAFETY === newMaxWei) {
            console.log(`✅ [SATELIT] SetMax sudah optimal di ${targetHit.toFixed(6)}.`);
            return;
        }

        CFG.HARD_MAX_SAFETY = newMaxWei;
        STATE.lastSatelitReport = { ts: Date.now(), target: dominan, targetHit };

        console.log(`✅ [SATELIT v2] SetMax diupdate ke ${targetHit.toFixed(6)} ETH (vs ${shortAddr(dominan.addr)})`);

        const pct = (CFG.MARGIN_LINDAS_PCT * 100).toFixed(0);
        await tg(
            `🛰️ *SATELIT v2 — KALIBRASI*\n` +
            `🎯 Target dominan: \`${shortAddr(dominan.addr)}\`\n` +
            `   ↳ Menang: *${dominan.menang}x* dari ${CFG.SATELIT_SCAN_LIMIT} ronde\n` +
            `   ↳ Avg modal: ${dominan.avg.toFixed(6)} ETH\n\n` +
            `🛡️ *SetMax baru:* *${targetHit.toFixed(6)} ETH/blok*\n` +
            `   _(+${pct}% dari avg target)_`
        );
    } catch (error) {
        console.error('❌ [SATELIT] Error:', error.message);
    } finally {
        STATE.isSatelitRunning = false;
    }
}

// =============================================================
// EV KALKULATOR
// =============================================================
function computeEv({ myBetEth, betPerBlockEth, blockCount = 25, boardEth, beanpotBean, gasUsd }) {
    const simulatedTotal = boardEth + CFG.EXPECTED_LATE_WHALES + myBetEth;
    if (!simulatedTotal || simulatedTotal <= 0) {
        return { totalEvUsd: -gasUsd, beanUsd: 0, ethPnLUsd: -gasUsd, ourShare: 0 };
    }

    const coveredBlocks = Math.max(1, Math.min(25, Number(blockCount || 25)));
    const blockCoverageProb = coveredBlocks / 25;
    const opponentAvgPerBlock = (boardEth + CFG.EXPECTED_LATE_WHALES) / 25;
    const myWinBlockShare = betPerBlockEth / (opponentAvgPerBlock + betPerBlockEth);
    const ourTotalWeightShare = myBetEth / simulatedTotal;

    const netBeanExpected = CFG.BEAN_PER_ROUND * ourTotalWeightShare * (1 - CFG.ROASTING_FEE_BPS);
    const beanpotEv = CFG.BEANPOT_ODDS * beanpotBean * ourTotalWeightShare * (1 - CFG.ROASTING_FEE_BPS);
    const beanUsd = (netBeanExpected + beanpotEv) * STATE.currentBeanPriceUsd;

    const adminFeeEth = simulatedTotal * CFG.ADMIN_FEE_BPS;
    const losersPool = Math.max(0, simulatedTotal - (simulatedTotal / 25));
    const vaultFeeEth = Math.max(0, (losersPool - (losersPool * CFG.ADMIN_FEE_BPS)) * CFG.VAULT_FEE_BPS);
    const claimablePool = Math.max(0, simulatedTotal - adminFeeEth - vaultFeeEth);

    const expectedEthReturn = blockCoverageProb * claimablePool * myWinBlockShare;
    const expectedEthPnL = expectedEthReturn - myBetEth;
    const ethPnLUsd = expectedEthPnL * STATE.currentEthPriceUsd;

    const distributionHaircutUsd = Math.abs(ethPnLUsd) * 0.05;
    const totalEvUsd = beanUsd + ethPnLUsd - gasUsd - distributionHaircutUsd;

    return {
        totalEvUsd, beanUsd, ethPnLUsd, ourShare: ourTotalWeightShare,
        blockCoverageProb, myWinBlockShare, distributionHaircutUsd,
    };
}

// =============================================================
// TELEGRAM COMMANDS (semua dari v14.1 dipertahankan)
// =============================================================
bot.onText(/\/setev (.+)/, (msg, m) => {
    if (!isOwner(msg)) return;
    const v = parseFloat(m[1]);
    if (!isNaN(v)) { CFG.MIN_PROFIT_THRESHOLD = v; tg(`✅ *TARGET EV* ➡️ *$${v}*`); }
});

bot.onText(/\/setboard (.+)/, (msg, m) => {
    if (!isOwner(msg)) return;
    const v = parseFloat(m[1]);
    if (!isNaN(v)) { CFG.GATEKEEPER_THRESHOLD = v; tg(`✅ *MAX BOARD* ➡️ *${v} ETH*`); }
});

bot.onText(/\/setbet (.+)/, (msg, m) => {
    if (!isOwner(msg)) return;
    try {
        const betVal = m[1].split(' ')[0];
        CFG.DEFAULT_BET_PER_BLOCK = ethers.parseEther(betVal);
        tg(`✅ *BASE BET DIUBAH*\nBet awal: *${betVal} ETH/blok*`);
    } catch (e) {
        tg(`❌ Format salah. Contoh: /setbet 0.000015`);
    }
});

bot.onText(/\/setswap (.+)/, (msg, m) => {
    if (!isOwner(msg)) return;
    try {
        const val = parseFloat(m[1].trim());
        if (isNaN(val) || val <= 0) throw new Error('invalid');
        CFG.AUTO_SWAP_THRESHOLD = ethers.parseEther(val.toString());
        tg(`✅ *AUTO-SWAP THRESHOLD* ➡️ *${val} BEAN*`);
    } catch (e) {
        tg(`❌ Format salah. Contoh: /setswap 5`);
    }
});

bot.onText(/\/setpot (.+)/, (msg, m) => {
    if (!isOwner(msg)) return;
    const v = parseFloat(m[1]);
    if (!isNaN(v)) { CFG.MIN_BEANPOT_THRESHOLD = v; tg(`✅ *MIN BEANPOT* ➡️ *${v} BEAN*`); }
    else tg(`❌ Format salah. Contoh: /setpot 2.5`);
});

bot.onText(/\/setmax (.+)/, (msg, m) => {
    if (!isOwner(msg)) return;
    try {
        const val = parseFloat(m[1].trim());
        if (isNaN(val) || val <= 0) throw new Error('invalid');
        CFG.HARD_MAX_SAFETY = ethers.parseEther(val.toString());
        STATE.lastManualSetMaxAt = Date.now(); // mark manual override
        tg(`✅ *HARD MAX BET* ➡️ *${val} ETH/blok*\n_(Satelit tidak akan override selama ${CFG.SATELIT_RESPECT_MANUAL_SEC}s)_`);
    } catch (e) {
        tg(`❌ Format salah. Contoh: /setmax 0.000115`);
    }
});

bot.onText(/\/setsatelit (on|off)/, (msg, m) => {
    if (!isOwner(msg)) return;
    FLAGS.ENABLE_SATELIT = m[1].toLowerCase() === 'on';
    tg(`✅ *SATELIT ENGINE* ➡️ *${FLAGS.ENABLE_SATELIT ? 'ON' : 'OFF'}*`);
});

bot.onText(/\/mode (.+)/, (msg, m) => {
    if (!isOwner(msg)) return;
    const v = m[1].trim().toLowerCase();
    if (v === 'all') {
        STATE.deployMode = 'all';
        tg(`✅ *DEPLOY MODE* ➡️ *ALL (25 block)*`);
    } else if (v === 'skip') {
        STATE.deployMode = 'skip';
        tg(`✅ *DEPLOY MODE* ➡️ *SKIP (24 block, skip prev winner: ${STATE.prevWinningBlock})*`);
    } else if (v === 'random') {
        STATE.deployMode = 'random';
        tg(`✅ *DEPLOY MODE* ➡️ *RANDOM (24 block random)*`);
    } else {
        tg(`❌ Format salah. Gunakan: /mode all, /mode skip, atau /mode random`);
    }
});

bot.onText(/\/setradar (.+)/, (msg, m) => {
    if (!isOwner(msg)) return;
    const v = m[1].trim().toLowerCase();
    if (v === 'pool') {
        STATE.radarMode = 'pool';
        tg(`✅ *RADAR MODE* ➡️ *POOL PCT*\nBet = ${(CFG.POOL_PCT_MIN*100).toFixed(0)}-${(CFG.POOL_PCT_MAX*100).toFixed(0)}% dari total pool ronde sebelumnya.`);
    } else if (v === 'node') {
        STATE.radarMode = 'node';
        tg(`✅ *RADAR MODE* ➡️ *HEAVY NODE*\nBet = +${(CFG.MARGIN_LINDAS_PCT*100).toFixed(0)}% dari nominal terberat.`);
    } else {
        tg(`❌ Format salah. Gunakan: /setradar pool atau /setradar node`);
    }
});

bot.onText(/\/setpoolpct (.+)/, (msg, m) => {
    if (!isOwner(msg)) return;
    const parts = m[1].trim().split(/\s+/);
    const minPct = parseFloat(parts[0]);
    const maxPct = parts.length > 1 ? parseFloat(parts[1]) : minPct;
    if (isNaN(minPct) || isNaN(maxPct) || minPct <= 0 || maxPct <= 0 || minPct > maxPct || maxPct > 1) {
        tg(`❌ Format salah. Contoh: /setpoolpct 0.10 0.15\n(min max, dalam desimal. 0.10 = 10%, 0.15 = 15%)`);
        return;
    }
    CFG.POOL_PCT_MIN = minPct;
    CFG.POOL_PCT_MAX = maxPct;
    tg(`✅ *POOL PCT* ➡️ *${(minPct*100).toFixed(1)}% — ${(maxPct*100).toFixed(1)}%*\nBet total = random antara ${(minPct*100).toFixed(1)}-${(maxPct*100).toFixed(1)}% pool ronde sebelumnya.`);
});

bot.onText(/\/bobot/, async (msg) => {
    if (!isOwner(msg)) return;
    try {
        const info = await grid.getCurrentRoundInfo();
        const rid = Number(info.roundId);
        const targetRound = rid > 0 ? rid - 1 : 0;
        const decision = await buildBobotDecision(targetRound, { notify: false });
        await tg(formatVolumeTelegram(decision));
    } catch (e) {
        await tg(`❌ Gagal cek radar volume: ${e.message}`);
    }
});

bot.onText(/\/status/, (msg) => {
    if (!isOwner(msg)) return;
    const safe = (v) => String(v ?? '-').replaceAll('_', '-');
    const recBet =
        STATE.nextRoundStrategy?.recommendedBet && STATE.nextRoundStrategy.recommendedBet > 0n
            ? ethers.formatEther(STATE.nextRoundStrategy.recommendedBet)
            : '0';

    const lines = [
        '📊 *STATUS KONFIGURASI v15*',
        '',
        `💳 *Wallet:* \`${wallet.address}\``,
        `🎮 *Deploy Mode:* ${String(STATE.deployMode || 'random').toUpperCase()}`,
        '',
        '*Filter Utama:*',
        `🍲 *Min Beanpot:* ${CFG.MIN_BEANPOT_THRESHOLD} BEAN`,
        `🎯 *Target EV:* $${CFG.MIN_PROFIT_THRESHOLD}`,
        `🛑 *Max Board:* ${CFG.GATEKEEPER_THRESHOLD} ETH`,
        '',
        '*Bet Config:*',
        `💸 *Base Bet:* ${ethers.formatEther(CFG.DEFAULT_BET_PER_BLOCK)} ETH/blok`,
        `🛡️ *Safety Cap:* ${ethers.formatEther(CFG.HARD_MAX_SAFETY)} ETH/blok`,
        `🎯 *Target Deploy:* ${recBet} ETH/blok`,
        '',
        '*Volume Engine:*',
        `🛰️ *Satelit Mode:* ${FLAGS.ENABLE_SATELIT ? 'ON' : 'OFF'}`,
        `📡 *Radar Mode:* ${STATE.radarMode.toUpperCase()} ${STATE.radarMode === 'pool' ? `(${(CFG.POOL_PCT_MIN*100).toFixed(0)}-${(CFG.POOL_PCT_MAX*100).toFixed(0)}% pool)` : `(+${(CFG.MARGIN_LINDAS_PCT*100).toFixed(0)}% heavy node)`}`,
        `🧠 *Strategy:* ${safe(STATE.nextRoundStrategy?.mode)}`,
        `✅ *Aman Tembak:* ${STATE.nextRoundStrategy?.shouldDeploy ? 'YES' : 'NO'}`,
        `📊 *Last Pool:* ${STATE.lastPoolTotalEth ? STATE.lastPoolTotalEth.toFixed(6) + ' ETH' : '-'}`,
        `🧾 *Reason:* ${safe(STATE.nextRoundStrategy?.reason)}`,
        '',
        '*Anti Loss:*',
        `🛡️ *Status:* ${FLAGS.ENABLE_ANTI_LOSS ? 'ON' : 'OFF'}`,
        `📉 *Loss Streak:* ${STATE.lossStreak}/${CFG.MAX_LOSS_STREAK}`,
        `📈 *Win Streak:* ${STATE.winStreak}`,
        `⏸️ *Cooldown Until:* ${STATE.cooldownUntilRound || '-'}`,
        '',
        '*Engine Stats:*',
        `⏱️ *Eksekusi:* detik ke-${CFG.BASE_EXECUTION_TIME}`,
        `📶 *Latensi:* ${STATE.currentLatency}ms`,
        `💲 *BEAN:* $${STATE.currentBeanPriceUsd.toFixed(5)}`,
        `⟠ *ETH:* $${STATE.currentEthPriceUsd.toFixed(2)}`,
        `🫘 *Beanpot:* ${STATE.currentBeanpotBean.toFixed(2)} BEAN`,
        `🎯 *Prev Winner Block:* ${STATE.prevWinningBlock >= 0 ? STATE.prevWinningBlock : '-'}`,
    ].join('\n');
    tg(lines);
});

bot.onText(/\/balance/, async (msg) => {
    if (!isOwner(msg)) return;
    try {
        await updatePrices();
        let usdIdr = 16000;
        try {
            const fxRes = await axios.get('https://open.er-api.com/v6/latest/USD', { timeout: 5000 });
            if (fxRes.data?.rates?.IDR) usdIdr = Number(fxRes.data.rates.IDR);
        } catch (e) { /* ignore */ }

        const [ethBalWei, beanBalWei] = await Promise.all([
            provider.getBalance(wallet.address),
            beanToken.balanceOf(wallet.address),
        ]);

        const ethBal = Number(ethers.formatEther(ethBalWei));
        const beanBal = Number(ethers.formatEther(beanBalWei));
        const totalUsd =
            ethBal * STATE.currentEthPriceUsd + beanBal * STATE.currentBeanPriceUsd;

        const lines = [
            '💰 *TOTAL SALDO WALLET*',
            '',
            `⟠ *ETH:* ${ethBal.toFixed(6)}`,
            `🫘 *BEAN:* ${beanBal.toFixed(6)}`,
            '',
            `📦 *TOTAL VALUE:* *$${totalUsd.toFixed(2)}* (~Rp${(totalUsd * usdIdr).toLocaleString('id-ID')})`,
        ].join('\n');
        await tg(lines);
    } catch (e) {
        await tg(`❌ Gagal cek saldo: ${e.message}`);
    }
});

bot.onText(/\/antiloss (on|off)/, (msg, m) => {
    if (!isOwner(msg)) return;
    FLAGS.ENABLE_ANTI_LOSS = m[1] === 'on';
    tg(`✅ *ANTI-LOSS* ➡️ *${FLAGS.ENABLE_ANTI_LOSS ? 'ON' : 'OFF'}*`);
});

bot.onText(/\/setloss (.+)/, (msg, m) => {
    if (!isOwner(msg)) return;
    const v = parseInt(m[1], 10);
    if (!Number.isNaN(v) && v >= 1) { CFG.MAX_LOSS_STREAK = v; tg(`✅ *MAX LOSS STREAK* ➡️ *${v}*`); }
});

bot.onText(/\/setcooldown (.+)/, (msg, m) => {
    if (!isOwner(msg)) return;
    const v = parseInt(m[1], 10);
    if (!Number.isNaN(v) && v >= 0) { CFG.COOLDOWN_ROUNDS = v; tg(`✅ *COOLDOWN ROUNDS* ➡️ *${v}*`); }
});

bot.onText(/\/setevbuffer (.+)/, (msg, m) => {
    if (!isOwner(msg)) return;
    const v = parseFloat(m[1]);
    if (!Number.isNaN(v) && v >= 0) { CFG.MIN_EV_BUFFER_USD = v; tg(`✅ *EV BUFFER* ➡️ *${v}*`); }
});

bot.onText(/\/stop/, async (msg) => {
    if (!isOwner(msg)) return;
    await tg('🛑 *BOT DIMATIKAN*\nScript dihentikan dari jarak jauh.');
    process.exit(0);
});

// =============================================================
// MAIN LOOP
// =============================================================
async function main() {
    console.log('🚀 MINEBEAN SNIPER v15 (VOLUME NODE + SATELIT v2)');
    await updatePrices();
    if (!STATE.currentEthPriceUsd) await fetchEthPriceFallback();
    await updateBeanpot();
    measureLatency();
    ensureLogHeader();
    await tg(
        '🤖 *Bot v15 (Clean Refactor)* Dinyalakan!\n' +
        '🛰️ Satelit v2 aktif — deteksi target dominan, auto-setmax tiap 10 menit.\n' +
        '⚙️ Command manual `/setmax` akan dihormati 30 detik sebelum override.'
    );

    // Interval berkala
    setInterval(measureLatency, 60_000);
    setInterval(updatePrices, 30_000);
    setInterval(updateBeanpot, 15_000);

    // Satelit: jalan pertama + interval 10 menit
    runSatelitEngine();
    setInterval(runSatelitEngine, CFG.SATELIT_INTERVAL_MS);

    // Main deploy loop
    setInterval(async () => {
        try {
            const info = await grid.getCurrentRoundInfo();
            STATE.consecutiveRpcErrors = 0;
            STATE.rpcAlertSent = false;

            if (!info.isActive) return;
            const rid = Number(info.roundId);
            const timeLeft = Number(info.timeRemaining);

            // === PHASE 1: di awal ronde baru, hitung reward & refresh radar ===
            if (timeLeft > 50 && timeLeft < 58 && rid > STATE.lastR && !STATE.isProcessing) {
                STATE.isProcessing = true;
                try {
                    if (STATE.played && STATE.lastR > 0) await checkReward(rid);
                    await updateStrategyFromPreviousRound(rid - 1);
                } finally {
                    STATE.played = false;
                    STATE.lastR = rid;
                    STATE.isProcessing = false;
                }
            }

            // === PHASE 2: auto-swap kalau pending ===
            if (
                STATE.pendingSwapAmount > 0n &&
                !STATE.isSwapping &&
                !STATE.isProcessing &&
                timeLeft > 55 &&
                timeLeft < 59
            ) {
                STATE.isSwapping = true;
                const amountToSwap = STATE.pendingSwapAmount;
                STATE.pendingSwapAmount = 0n;
                setTimeout(async () => {
                    try { await swapBeanToEth(amountToSwap); }
                    catch (e) { /* ignore */ }
                    finally { STATE.isSwapping = false; }
                }, 2000);
            }

            // === PHASE 3: eksekusi deploy ===
            const DYNAMIC_TRIGGER =
                STATE.currentLatency > 700 ? CFG.BASE_EXECUTION_TIME + 1 : CFG.BASE_EXECUTION_TIME;

            if (
                timeLeft <= DYNAMIC_TRIGGER &&
                timeLeft >= 2 &&
                rid === STATE.lastR &&
                !STATE.deploying &&
                !STATE.played &&
                !STATE.isProcessing
            ) {
                STATE.deploying = true;
                try {
                    if (STATE.currentBeanpotBean < CFG.MIN_BEANPOT_THRESHOLD) {
                        console.log(`❌ R#${rid} SKIP: beanpot kering ${STATE.currentBeanpotBean.toFixed(2)} BEAN`);
                        return;
                    }

                    const boardEth = parseFloat(ethers.formatEther(info.totalDeployed));
                    if (boardEth > CFG.GATEKEEPER_THRESHOLD) {
                        console.log(`❌ R#${rid} SKIP: papan ${boardEth.toFixed(4)} ETH > limit`);
                        return;
                    }

                    if (FLAGS.ENABLE_ANTI_LOSS && STATE.cooldownUntilRound && rid <= STATE.cooldownUntilRound) {
                        console.log(`🛡️ R#${rid} SKIP: anti-loss cooldown aktif`);
                        return;
                    }

                    if (FLAGS.ENABLE_BOBOT_ENGINE && STATE.nextRoundStrategy.shouldDeploy === false) {
                        console.log(`⛔ R#${rid} RADAR SKIP: ${STATE.nextRoundStrategy.reason}`);
                        return;
                    }

                    let betPerBlock =
                        STATE.nextRoundStrategy.recommendedBet && STATE.nextRoundStrategy.recommendedBet > 0n
                            ? STATE.nextRoundStrategy.recommendedBet
                            : CFG.DEFAULT_BET_PER_BLOCK;

                    if (betPerBlock > CFG.HARD_MAX_SAFETY) {
                        console.log('⚠️ Bet diturunkan sesuai Safety Cap.');
                        betPerBlock = CFG.HARD_MAX_SAFETY;
                    }

                    console.log(
                        `🧠 Volume Decision: ${STATE.nextRoundStrategy.mode} | ` +
                        `bet/blk=${ethers.formatEther(betPerBlock)} | ` +
                        `${STATE.nextRoundStrategy.reason}`
                    );

                    // === Pilih block sesuai mode ===
                    let blockIds = Array.from({ length: 25 }, (_, i) => i);
                    if (STATE.deployMode === 'skip') {
                        if (STATE.prevWinningBlock >= 0 && STATE.prevWinningBlock <= 24) {
                            blockIds = blockIds.filter((b) => b !== STATE.prevWinningBlock);
                            console.log(`⚡ SKIP MODE: ${blockIds.length} block (skip prev winner: ${STATE.prevWinningBlock})`);
                        } else {
                            console.log(`⚠️ SKIP MODE: prevWinningBlock unknown, deploy ALL 25`);
                        }
                    } else if (STATE.deployMode === 'random') {
                        const randomSkip = Math.floor(Math.random() * 25);
                        blockIds = blockIds.filter((b) => b !== randomSkip);
                        console.log(`🎲 RANDOM MODE: ${blockIds.length} block (skip random ${randomSkip})`);
                    } else if (STATE.deployMode === 'all') {
                        console.log(`🎯 ALL MODE: deploy 25 block`);
                    }

                    const currentRoundBetAdjusted = betPerBlock * BigInt(blockIds.length);
                    const myBetEth = parseFloat(ethers.formatEther(currentRoundBetAdjusted));

                    const gas = await getAdaptiveFee({
                        boardEth, gasLimit: 1_000_000n, purpose: 'deploy',
                    });

                    const ev = computeEv({
                        myBetEth,
                        betPerBlockEth: parseFloat(ethers.formatEther(betPerBlock)),
                        blockCount: blockIds.length,
                        boardEth,
                        beanpotBean: STATE.currentBeanpotBean,
                        gasUsd: gas.gasUsd,
                    });

                    if (ev.totalEvUsd > (CFG.MIN_PROFIT_THRESHOLD + CFG.MIN_EV_BUFFER_USD)) {
                        console.log(
                            `✅ R#${rid} FIRE! bet/blk=${ethers.formatEther(betPerBlock)} | ` +
                            `EV=$${ev.totalEvUsd.toFixed(3)}`
                        );

                        const preR = await grid.getTotalPendingRewards(wallet.address);
                        STATE.preDeployB = preR[1] + preR[2];
                        STATE.preDeployETH = preR[0];
                        STATE.lastRoundBet = currentRoundBetAdjusted;

                        STATE.lastDeployMeta = {
                            roundId: rid,
                            mode: STATE.nextRoundStrategy.mode,
                            source: STATE.nextRoundStrategy.source,
                            betPerBlockEth: ethers.formatEther(betPerBlock),
                            boardEth: boardEth.toFixed(9),
                            beanpotBean: STATE.currentBeanpotBean.toFixed(6),
                            evUsd: ev.totalEvUsd.toFixed(6),
                            gasUsd: gas.gasUsd.toFixed(6),
                            reason: STATE.nextRoundStrategy.reason,
                        };

                        const tx = await grid.deploy(blockIds, {
                            value: currentRoundBetAdjusted,
                            gasLimit: 1_000_000,
                            maxFeePerGas: gas.maxFeePerGas,
                            maxPriorityFeePerGas: gas.maxPriorityFeePerGas,
                        });
                        const receipt = await tx.wait();
                        STATE.played = receipt?.status === 1;
                        if (STATE.played) console.log(`🔥 DEPLOY CONFIRMED! ${tx.hash.slice(0, 18)}...`);
                        else console.log(`❌ DEPLOY FAILED ONCHAIN!`);
                    } else {
                        console.log(
                            `❌ R#${rid} SKIP: EV $${ev.totalEvUsd.toFixed(3)} < Target ` +
                            `$${CFG.MIN_PROFIT_THRESHOLD + CFG.MIN_EV_BUFFER_USD}`
                        );
                    }
                } catch (e) {
                    console.error('Error deploy:', e.message);
                } finally {
                    STATE.deploying = false;
                }
            }
        } catch (e) {
            STATE.consecutiveRpcErrors++;
            if (STATE.consecutiveRpcErrors >= CFG.MAX_CONSECUTIVE_ERRORS && !STATE.rpcAlertSent) {
                STATE.rpcAlertSent = true;
                tg(`⚠️ *RPC ERROR!*\nError: \`${e.message.slice(0, 100)}\``);
            }
        }
    }, 1000);
}

process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));

main().catch((e) => {
    console.error('fatal:', e);
    process.exit(1);
});
