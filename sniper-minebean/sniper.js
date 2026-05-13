require('dotenv').config();
const { ethers } = require('ethers');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');

// ==========================================================
// MINEBEAN SNIPER v16.0 — LAST-SECOND REAL-TIME SNIPER
// Snapshot detik 55, deploy detik 5-6 sebelum end
// Target: Dominasi MICRO + SEMUT class
// Skip: Whale & High class (avoid head-to-head)
// ==========================================================

// === ENV ===
const RPC_URL = process.env.BASE_RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
for (const [k, v] of Object.entries({ BASE_RPC_URL: RPC_URL, PRIVATE_KEY, TG_BOT_TOKEN, TG_CHAT_ID })) {
  if (!v) throw new Error(`Env tidak ditemukan: ${k}`);
}
const bot = new TelegramBot(TG_BOT_TOKEN, { polling: true });

// === CONFIG ===
let MY_ADDRESS = '0x70114f99F5B5F8068a9f4fDD01f9350CE866a709';
let BUDGET_PER_RONDE = ethers.parseEther('0.000222'); // $0.50 (modal $18 = 80 ronde)
let BET_PER_BLOCK_DEFAULT = ethers.parseEther('0.0000089'); // 0.000222 / 25
let MIN_BET_PER_BLOCK = ethers.parseEther('0.0000050');
let MAX_BET_PER_BLOCK = ethers.parseEther('0.0000099'); // tetap di MICRO atas

// === CLASS THRESHOLDS (ETH) ===
const CLASS_MICRO_MAX = 0.000040;
const CLASS_SEMUT_MAX = 0.000060;
const CLASS_MID_MAX = 0.000100;
const CLASS_HIGH_MAX = 0.000300;
// > 0.000300 = WHALE

// === SKIP CONDITIONS ===
let SKIP_IF_WHALE = true;       // skip kalau ada >=1 whale
let SKIP_IF_HIGH_GTE = 1;        // skip kalau >=1 HIGH player (0.0001-0.0003)
let SKIP_IF_BOARD_USD = 5.0;     // skip kalau board > $5
let SKIP_IF_PLAYER_GT = 50;      // skip kalau player > 50

// === TIMING ===
const SNAPSHOT_AT = 55;          // detik 55 = ambil snapshot
const DEPLOY_AT = 6;             // deploy saat timeRemaining = 6 detik
const DEPLOY_END = 4;             // batas akhir deploy

// === SAFETY ===
let MIN_MODAL_ETH = ethers.parseEther('0.0044'); // ~$10, stop jika < ini
let MAX_LOSS_STREAK = 5;
let lossStreak = 0;
let stopped = false;

// === STATE ===
let lastR = 0;
let snapshotDone = false;
let deployDone = false;
let lastSnapshot = null;
let lastDecision = null;
let preDeployB = 0n, preDeployETH = 0n, lastRoundBet = 0n, played = false;
let isProcessing = false, deploying = false;
let currentBeanPriceUsd = 3.52;
let currentEthPriceUsd = 2255;
let currentBeanpotBean = 0;
let currentLatency = 300;
let sessionRound = 0, sessionProfitUsd = 0, sessionDeploys = 0, sessionWins = 0;

// === CONTRACTS ===
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
];
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const grid = new ethers.Contract(GRIDMINING_ADDR, ABI, wallet);
const beanToken = new ethers.Contract(BEAN_TOKEN_ADDR, ERC20_ABI, wallet);
MY_ADDRESS = wallet.address.toLowerCase();



// ==========================================================
// HELPER FUNCTIONS
// ==========================================================
async function tg(msg) {
  try { await bot.sendMessage(TG_CHAT_ID, msg, { parse_mode: 'Markdown' }); }
  catch (e) { console.error('TG err:', e.message); }
}
const isOwner = (msg) => msg.chat.id.toString() === TG_CHAT_ID;

function parseDeployWei(v) {
  if (v == null) return 0n;
  const s = String(v);
  if (s.includes('.')) { try { return ethers.parseEther(s); } catch (_) { return 0n; } }
  try { return BigInt(s); } catch (_) {}
  try { return ethers.parseEther(String(Number(s) || 0)); } catch (_) { return 0n; }
}

function classifyBet(ethValue) {
  if (ethValue < CLASS_MICRO_MAX) return 'MICRO';
  if (ethValue < CLASS_SEMUT_MAX) return 'SEMUT';
  if (ethValue < CLASS_MID_MAX) return 'MID';
  if (ethValue < CLASS_HIGH_MAX) return 'HIGH';
  return 'WHALE';
}

async function updatePrices() {
  try {
    const r = await axios.get(`${MINEBEAN_API}/api/price`, { timeout: 5000 });
    if (r.data?.bean?.priceUsd) {
      currentBeanPriceUsd = parseFloat(r.data.bean.priceUsd);
      const pn = parseFloat(r.data.bean.priceNative);
      if (pn > 0) currentEthPriceUsd = currentBeanPriceUsd / pn;
    }
  } catch (e) {}
}
setInterval(updatePrices, 60000);

async function updateBeanpot() {
  try { currentBeanpotBean = parseFloat(ethers.formatEther(await grid.beanpotPool())); }
  catch (e) {}
}
setInterval(updateBeanpot, 30000);

async function measureLatency() {
  const s = Date.now();
  try { await provider.getBlockNumber(); currentLatency = Date.now() - s; }
  catch (e) { currentLatency = 1000; }
}
setInterval(measureLatency, 60000);

async function getAdaptiveFee({ boardEth = 0, gasLimit = 1000000n } = {}) {
  const fee = await provider.getFeeData();
  const lb = await provider.getBlock('latest').catch(() => null);
  const bf = lb?.baseFeePerGas || fee.gasPrice || ethers.parseUnits('0.10', 'gwei');
  let mg = '0.008'; // priority fee gwei (lebih tinggi untuk last-second)
  if (currentLatency > 700) mg = '0.012';
  const mp = ethers.parseUnits(mg, 'gwei');
  let pf = fee.maxPriorityFeePerGas || fee.gasPrice || mp;
  if (pf < mp) pf = mp;
  const cap = ethers.parseUnits('0.015', 'gwei');
  if (pf > cap) pf = cap;
  let mf = (bf * 2n) + pf;
  return {
    maxFeePerGas: mf,
    maxPriorityFeePerGas: pf,
    gasUsd: parseFloat(ethers.formatEther(gasLimit * mf)) * currentEthPriceUsd,
  };
}



// ==========================================================
// SNAPSHOT — ambil data live di detik 55
// ==========================================================
async function takeSnapshot(roundId) {
  try {
    const res = await axios.get(`${MINEBEAN_API}/api/round/${roundId}/miners`, { timeout: 4000 });
    let miners = res.data?.miners || res.data?.data?.miners || res.data?.data || res.data;
    if (!Array.isArray(miners) && miners && typeof miners === 'object') miners = Object.values(miners);
    if (!Array.isArray(miners)) miners = [];

    const classes = { MICRO: [], SEMUT: [], MID: [], HIGH: [], WHALE: [] };
    let totalBoardEth = 0;
    let myBetEth = 0;
    let totalPlayers = 0;

    for (const m of miners) {
      let raw = m.address || m.walletAddress || m.deployer || m.user || m.miner || m.wallet || m.account;
      if (typeof raw === 'object' && raw !== null) raw = raw.address || raw.wallet || raw.id;
      const addr = String(raw || '?').toLowerCase();
      const dw = parseDeployWei(m.deployedFormatted ?? m.deployed ?? 0);
      const dEth = parseFloat(ethers.formatEther(dw));
      if (dEth <= 0) continue;
      totalPlayers++;
      totalBoardEth += dEth;
      if (addr === MY_ADDRESS) { myBetEth += dEth; continue; }
      const cls = classifyBet(dEth);
      classes[cls].push({ addr, bet: dEth });
    }

    // hitung statistik per kelas
    const stats = {};
    for (const cls in classes) {
      const arr = classes[cls];
      stats[cls] = {
        count: arr.length,
        total: arr.reduce((s, x) => s + x.bet, 0),
        avg: arr.length > 0 ? arr.reduce((s, x) => s + x.bet, 0) / arr.length : 0,
        max: arr.length > 0 ? Math.max(...arr.map(x => x.bet)) : 0,
        min: arr.length > 0 ? Math.min(...arr.map(x => x.bet)) : 0,
      };
    }

    return {
      roundId,
      totalPlayers,
      totalBoardEth,
      totalBoardUsd: totalBoardEth * currentEthPriceUsd,
      myBetEth,
      classes,
      stats,
      timestamp: Date.now(),
    };
  } catch (e) {
    console.error('Snapshot error:', e.message);
    return null;
  }
}

// ==========================================================
// DECISION — hitung bet optimal & apakah skip
// ==========================================================
function makeDecision(snapshot) {
  if (!snapshot) return { skip: true, reason: 'No snapshot data' };

  const { totalPlayers, totalBoardEth, totalBoardUsd, stats } = snapshot;

  // === SKIP CONDITIONS ===
  if (SKIP_IF_WHALE && stats.WHALE.count > 0) {
    return { skip: true, reason: `${stats.WHALE.count} whale terdeteksi (max ${stats.WHALE.max.toFixed(6)})`, snapshot };
  }
  if (stats.HIGH.count >= SKIP_IF_HIGH_GTE) {
    return { skip: true, reason: `${stats.HIGH.count} HIGH players (>=${SKIP_IF_HIGH_GTE})`, snapshot };
  }
  if (totalBoardUsd > SKIP_IF_BOARD_USD) {
    return { skip: true, reason: `Board terlalu ramai $${totalBoardUsd.toFixed(2)}`, snapshot };
  }
  if (totalPlayers > SKIP_IF_PLAYER_GT) {
    return { skip: true, reason: `Player terlalu banyak ${totalPlayers}`, snapshot };
  }

  // === BET CALCULATION ===
  // Target: dominasi MICRO + top SEMUT
  // Hitung bet optimal:
  // - Kalau ada SEMUT, overtake top SEMUT × 1.15
  // - Kalau cuma MICRO, ambil top MICRO × 1.5
  // - Capped MIN/MAX

  let optimalBetEth = 0;
  let strategy = '';

  if (stats.SEMUT.count > 0) {
    // ada SEMUT, overtake top SEMUT
    optimalBetEth = stats.SEMUT.max * 1.15;
    strategy = `Overtake SEMUT leader (${stats.SEMUT.max.toFixed(6)}) +15%`;
  } else if (stats.MICRO.count > 0) {
    // cuma MICRO, dominasi top MICRO
    optimalBetEth = stats.MICRO.max * 1.5;
    strategy = `Dominate MICRO leader (${stats.MICRO.max.toFixed(6)}) +50%`;
  } else {
    optimalBetEth = parseFloat(ethers.formatEther(BET_PER_BLOCK_DEFAULT));
    strategy = 'Default (no opponent)';
  }

  // Apply MIN/MAX cap
  const minEth = parseFloat(ethers.formatEther(MIN_BET_PER_BLOCK));
  const maxEth = parseFloat(ethers.formatEther(MAX_BET_PER_BLOCK));
  let capped = false;
  if (optimalBetEth > maxEth) { optimalBetEth = maxEth; capped = true; }
  if (optimalBetEth < minEth) { optimalBetEth = minEth; }

  const betWei = ethers.parseEther(optimalBetEth.toFixed(9));
  const totalEth = optimalBetEth * 25;
  const totalUsd = totalEth * currentEthPriceUsd;

  return {
    skip: false,
    snapshot,
    betPerBlockEth: optimalBetEth,
    betPerBlockWei: betWei,
    totalEth,
    totalUsd,
    strategy,
    capped,
  };
}

// ==========================================================
// VISUALISASI LIVE — kirim laporan ke Telegram
// ==========================================================
async function sendSnapshotReport(decision) {
  const s = decision.snapshot;
  if (!s) return;

  const lines = [
    `📊 *R#${s.roundId} SNAPSHOT* (det 55)`,
    `Players: *${s.totalPlayers}* | Board: *${s.totalBoardEth.toFixed(6)} ETH* ($${s.totalBoardUsd.toFixed(2)})`,
    ``,
    `*Distribusi Lawan:*`,
    `  🐜 MICRO: ${s.stats.MICRO.count} (avg ${s.stats.MICRO.avg.toFixed(6)})`,
    `  🐝 SEMUT: ${s.stats.SEMUT.count} (top ${s.stats.SEMUT.max.toFixed(6)})`,
    `  🦗 MID  : ${s.stats.MID.count} (top ${s.stats.MID.max.toFixed(6)})`,
    `  🦂 HIGH : ${s.stats.HIGH.count} (top ${s.stats.HIGH.max.toFixed(6)})`,
    `  🐳 WHALE: ${s.stats.WHALE.count}`,
    ``,
  ];

  if (decision.skip) {
    lines.push(`⛔ *SKIP*: ${decision.reason}`);
  } else {
    lines.push(`🎯 *DECISION:*`);
    lines.push(`   Strategy: ${decision.strategy}${decision.capped ? ' (CAP)' : ''}`);
    lines.push(`   Bet/blok: *${decision.betPerBlockEth.toFixed(6)} ETH*`);
    lines.push(`   Total   : *${decision.totalEth.toFixed(6)} ETH* ($${decision.totalUsd.toFixed(2)})`);
    lines.push(`   Deploy in ${DEPLOY_AT}s...`);
  }

  await tg(lines.join('\n'));
}



// ==========================================================
// DEPLOY EXECUTION
// ==========================================================
async function executeDeploy(decision) {
  if (decision.skip || deployDone) return;
  deployDone = true; // lock supaya tidak deploy 2x

  try {
    // Cek modal dulu
    const ethBal = await provider.getBalance(wallet.address);
    if (ethBal < MIN_MODAL_ETH) {
      stopped = true;
      await tg(`🛑 *STOP-LOSS TRIGGERED*\nETH balance: ${ethers.formatEther(ethBal)} < ${ethers.formatEther(MIN_MODAL_ETH)}\nBot dihentikan untuk safety.`);
      return;
    }

    // Cek loss streak
    if (lossStreak >= MAX_LOSS_STREAK) {
      stopped = true;
      await tg(`🛑 *STOP-LOSS*: ${MAX_LOSS_STREAK} loss berturut-turut. Bot pause.`);
      return;
    }

    // Pre-deploy snapshot reward
    const preR = await grid.getTotalPendingRewards(wallet.address);
    preDeployB = preR[1] + preR[2];
    preDeployETH = preR[0];

    // Deploy ALL 25 blok
    const blockIds = Array.from({ length: 25 }, (_, i) => i);
    const totalBet = decision.betPerBlockWei * 25n;
    lastRoundBet = totalBet;

    const gas = await getAdaptiveFee({ boardEth: decision.snapshot.totalBoardEth });

    const tx = await grid.deploy(blockIds, {
      value: totalBet,
      gasLimit: 1000000,
      maxFeePerGas: gas.maxFeePerGas,
      maxPriorityFeePerGas: gas.maxPriorityFeePerGas,
    });

    console.log(`🔥 DEPLOY tx sent: ${tx.hash.slice(0, 18)}...`);
    await tg(`🔥 *DEPLOYED R#${decision.snapshot.roundId}*\nBet: ${decision.betPerBlockEth.toFixed(6)}/blok ($${decision.totalUsd.toFixed(2)})\n\`${tx.hash.slice(0, 20)}...\``);

    const rc = await tx.wait();
    played = rc?.status === 1;
    sessionDeploys++;

    if (played) {
      console.log(`✅ Confirmed R#${decision.snapshot.roundId}`);
    } else {
      console.log(`❌ Tx failed`);
      lossStreak++;
    }
  } catch (e) {
    console.error('Deploy error:', e.message);
    await tg(`❌ Deploy error: ${e.message.slice(0, 100)}`);
    lossStreak++;
  } finally {
    deploying = false;
  }
}

// ==========================================================
// REWARD CHECK setelah ronde selesai
// ==========================================================
async function checkReward(rId) {
  try {
    const r = await grid.getTotalPendingRewards(wallet.address);
    const totalBeanNow = r[1] + r[2];
    const dBean = totalBeanNow >= preDeployB ? totalBeanNow - preDeployB : 0n;
    const netEthChange = (r[0] - preDeployETH) - lastRoundBet;
    const beanEth = parseFloat(ethers.formatEther(dBean));
    const ethEth = parseFloat(ethers.formatEther(netEthChange));
    const profitUsd = beanEth * currentBeanPriceUsd + ethEth * currentEthPriceUsd;

    if (profitUsd > 0) { sessionWins++; lossStreak = 0; }
    else { lossStreak++; }
    sessionProfitUsd += profitUsd;

    const isLotre = beanEth >= 0.9;
    const emoji = profitUsd > 0 ? '✅' : '❌';
    const tipe = isLotre ? '🎰 LOTRE' : (beanEth > 0 ? 'SPLIT' : 'KALAH');

    await tg([
      `${emoji} *R#${rId - 1} SELESAI* [${tipe}]`,
      `💸 Profit: *$${profitUsd.toFixed(4)}*`,
      `🫘 BEAN: ${beanEth.toFixed(4)} | ⟠ ETH: ${ethEth.toFixed(6)}`,
      `📊 Session: ${sessionWins}W/${sessionDeploys} = $${sessionProfitUsd.toFixed(2)}`,
    ].join('\n'));

    // Auto-claim
    const AUTO_CLAIM_ETH = ethers.parseEther('0.0025');
    const AUTO_CLAIM_BEAN = ethers.parseEther('0.25');
    if (r[0] >= AUTO_CLAIM_ETH) {
      try { await (await grid.claimETH()).wait(); await tg(`💸 Auto-claim ETH: ${ethers.formatEther(r[0])}`); } catch (e) {}
    }
    if (totalBeanNow >= AUTO_CLAIM_BEAN) {
      try { await (await grid.claimBEAN()).wait(); await tg(`🫘 Auto-claim BEAN: ${ethers.formatEther(totalBeanNow)}`); } catch (e) {}
    }
  } catch (e) {
    console.error('Reward check err:', e.message);
  }
}



// ==========================================================
// TELEGRAM COMMANDS
// ==========================================================
bot.onText(/\/status/, async (msg) => {
  if (!isOwner(msg)) return;
  const ethBal = await provider.getBalance(wallet.address);
  const beanBal = await beanToken.balanceOf(wallet.address);
  const ethE = parseFloat(ethers.formatEther(ethBal));
  const beanE = parseFloat(ethers.formatEther(beanBal));
  const totalUsd = ethE * currentEthPriceUsd + beanE * currentBeanPriceUsd;
  const lines = [
    `📊 *SNIPER v16.0 STATUS*`,
    ``,
    `💳 Wallet: \`${wallet.address.slice(0, 10)}...\``,
    `⟠ ETH: ${ethE.toFixed(6)} ($${(ethE * currentEthPriceUsd).toFixed(2)})`,
    `🫘 BEAN: ${beanE.toFixed(4)} ($${(beanE * currentBeanPriceUsd).toFixed(2)})`,
    `💰 Total: *$${totalUsd.toFixed(2)}*`,
    ``,
    `*Settings:*`,
    `Budget/ronde: $${(parseFloat(ethers.formatEther(BUDGET_PER_RONDE)) * currentEthPriceUsd).toFixed(2)}`,
    `Bet/blok min: ${ethers.formatEther(MIN_BET_PER_BLOCK)}`,
    `Bet/blok max: ${ethers.formatEther(MAX_BET_PER_BLOCK)}`,
    `Skip whale  : ${SKIP_IF_WHALE ? 'YES' : 'NO'}`,
    `Skip if HIGH≥: ${SKIP_IF_HIGH_GTE}`,
    `Skip if board>: $${SKIP_IF_BOARD_USD}`,
    ``,
    `*Session:*`,
    `Deploys: ${sessionDeploys} | Wins: ${sessionWins}`,
    `Profit : $${sessionProfitUsd.toFixed(2)}`,
    `LossStreak: ${lossStreak}/${MAX_LOSS_STREAK}`,
    `Status: ${stopped ? '🛑 STOPPED' : '🟢 ACTIVE'}`,
    ``,
    `🫘 Beanpot: ${currentBeanpotBean.toFixed(2)} BEAN`,
    `📶 Latency: ${currentLatency}ms`,
    `💲 BEAN: $${currentBeanPriceUsd.toFixed(4)} | ⟠ETH: $${currentEthPriceUsd.toFixed(2)}`,
  ].join('\n');
  await tg(lines);
});

bot.onText(/\/setbudget (.+)/, (msg, m) => {
  if (!isOwner(msg)) return;
  try {
    const usdAmount = parseFloat(m[1]);
    const ethAmount = usdAmount / currentEthPriceUsd;
    BUDGET_PER_RONDE = ethers.parseEther(ethAmount.toFixed(9));
    BET_PER_BLOCK_DEFAULT = ethers.parseEther((ethAmount / 25).toFixed(9));
    MAX_BET_PER_BLOCK = ethers.parseEther((ethAmount / 25 * 1.2).toFixed(9));
    tg(`✅ Budget: $${usdAmount} (${ethAmount.toFixed(6)} ETH/ronde)\nBet/blok: ${(ethAmount / 25).toFixed(6)}`);
  } catch (e) { tg(`❌ Format: /setbudget 0.50`); }
});

bot.onText(/\/setminmodal (.+)/, (msg, m) => {
  if (!isOwner(msg)) return;
  try {
    const usd = parseFloat(m[1]);
    MIN_MODAL_ETH = ethers.parseEther((usd / currentEthPriceUsd).toFixed(9));
    tg(`✅ Min modal stop-loss: $${usd}`);
  } catch (e) { tg(`❌ Format: /setminmodal 10`); }
});

bot.onText(/\/skipwhale (on|off)/, (msg, m) => {
  if (!isOwner(msg)) return;
  SKIP_IF_WHALE = m[1] === 'on';
  tg(`✅ Skip whale: ${SKIP_IF_WHALE ? 'ON' : 'OFF'}`);
});

bot.onText(/\/skiphigh (.+)/, (msg, m) => {
  if (!isOwner(msg)) return;
  const v = parseInt(m[1]);
  if (v >= 0) { SKIP_IF_HIGH_GTE = v; tg(`✅ Skip if HIGH ≥${v}`); }
});

bot.onText(/\/skipboard (.+)/, (msg, m) => {
  if (!isOwner(msg)) return;
  const v = parseFloat(m[1]);
  if (v > 0) { SKIP_IF_BOARD_USD = v; tg(`✅ Skip if board > $${v}`); }
});

bot.onText(/\/resume/, (msg) => {
  if (!isOwner(msg)) return;
  stopped = false;
  lossStreak = 0;
  tg(`▶️ Bot resumed. LossStreak reset.`);
});

bot.onText(/\/pause/, (msg) => {
  if (!isOwner(msg)) return;
  stopped = true;
  tg(`⏸️ Bot paused. Use /resume to continue.`);
});

bot.onText(/\/stop/, async (msg) => {
  if (!isOwner(msg)) return;
  await tg('🛑 Bot dimatikan total.');
  process.exit(0);
});

bot.onText(/\/help/, (msg) => {
  if (!isOwner(msg)) return;
  tg([
    `📋 *COMMANDS v16.0*`,
    `/status - status & saldo`,
    `/setbudget [USD] - budget per ronde`,
    `/setminmodal [USD] - min modal stop-loss`,
    `/skipwhale on/off`,
    `/skiphigh [N] - skip if HIGH count >= N`,
    `/skipboard [USD] - skip if board > USD`,
    `/pause - pause sementara`,
    `/resume - lanjut & reset loss streak`,
    `/stop - matikan total`,
  ].join('\n'));
});



// ==========================================================
// MAIN LOOP — polling tiap 1 detik
// ==========================================================
async function main() {
  console.log('🚀 MINEBEAN SNIPER v16.0 — Last-Second Real-Time Sniper');
  console.log(`Wallet: ${wallet.address}`);
  await updatePrices();
  await updateBeanpot();
  await measureLatency();

  await tg([
    `🤖 *SNIPER v16.0 ON*`,
    `Last-second snapshot detik 55, deploy detik 5-6.`,
    `Target: dominasi MICRO + SEMUT.`,
    `Skip: WHALE + ramai HIGH.`,
    ``,
    `Budget/ronde: $${(parseFloat(ethers.formatEther(BUDGET_PER_RONDE)) * currentEthPriceUsd).toFixed(2)}`,
    `Min modal stop: $${(parseFloat(ethers.formatEther(MIN_MODAL_ETH)) * currentEthPriceUsd).toFixed(2)}`,
  ].join('\n'));

  setInterval(async () => {
    if (stopped) return;
    try {
      const info = await grid.getCurrentRoundInfo();
      if (!info.isActive) return;
      const rid = Number(info.roundId);
      const tl = Number(info.timeRemaining);

      // ===== Ronde baru detected (saat tl > 50) =====
      if (rid > lastR && !isProcessing) {
        isProcessing = true;
        try {
          // Check reward dari ronde sebelumnya
          if (played && lastR > 0) {
            await checkReward(rid);
          }
          // Reset state untuk ronde baru
          played = false;
          lastR = rid;
          snapshotDone = false;
          deployDone = false;
          lastSnapshot = null;
          lastDecision = null;
          sessionRound++;
        } finally {
          isProcessing = false;
        }
      }

      // ===== SNAPSHOT phase (detik ~55, tl = 5) =====
      // tl 4-6 = 5 detik margin
      if (!snapshotDone && tl >= 4 && tl <= 6 && rid === lastR) {
        snapshotDone = true;
        console.log(`\n📸 SNAPSHOT R#${rid} (tl=${tl}s)`);
        const snap = await takeSnapshot(rid);
        if (snap) {
          lastSnapshot = snap;
          lastDecision = makeDecision(snap);
          // kirim laporan visualisasi
          sendSnapshotReport(lastDecision); // async, jangan await
          // langsung deploy kalau tidak skip
          if (!lastDecision.skip && !deployDone && !deploying) {
            deploying = true;
            executeDeploy(lastDecision); // async, jangan await
          }
        }
      }
    } catch (e) {
      // silent
    }
  }, 500); // poll tiap 500ms untuk presisi tinggi
}

process.on('unhandledRejection', (e) => console.error('UR:', e.message));
process.on('uncaughtException', (e) => console.error('UE:', e.message));

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
