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

// === DEPLOY MODE ===
let deployMode = 'all';          // 'all' = 25 blok | 'skip' = skip prev winning block (24 blok)
let prevWinningBlock = -1;       // tracked dari API ronde sebelumnya

// === TIMING ===
const SNAPSHOT_AT = 55;          // detik 55 = ambil snapshot
const DEPLOY_AT = 6;             // deploy saat timeRemaining = 6 detik
const DEPLOY_END = 4;             // batas akhir deploy

// === SAFETY ===
let MIN_MODAL_ETH = ethers.parseEther('0.0044'); // ~$10, stop jika < ini
let MAX_LOSS_STREAK = 5;
let lossStreak = 0;
let stopped = false;

// === AUTO SWAP CONFIG ===
let AUTO_SWAP_THRESHOLD = ethers.parseEther('0.39'); // swap BEAN→ETH jika wallet BEAN >= 0.39
let isSwapping = false;
let pendingSwapAmount = 0n;

// === BEANPOT THRESHOLD ===
let MIN_BEANPOT_THRESHOLD = 0; // skip deploy jika beanpot < ini (0 = disabled)

// === MANUAL BET MODE ===
let MANUAL_BET = null; // null = auto (adaptive), set value = fixed bet per block

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
  'function getRoundDeployed(uint64 roundId) external view returns (uint256[25])',
  'function getMinerInfo(uint64 roundId, address user) external view returns (uint256 deployedMask, uint256 amountPerBlock, bool checkpointed)',
];
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
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
// AUTO SWAP — BEAN → ETH via KyberSwap Aggregator (Base)
// ==========================================================
async function swapBeanToEth(amount) {
  try {
    // 1. Get route dari KyberSwap
    const r = await axios.get('https://aggregator-api.kyberswap.com/base/api/v1/routes', {
      params: {
        tokenIn: BEAN_TOKEN_ADDR,
        tokenOut: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', // native ETH
        amountIn: amount.toString(),
      },
      timeout: 10000,
    });
    const routeSummary = r.data?.data?.routeSummary;
    if (!routeSummary) throw new Error('No route found');

    // 2. Build route
    const br = await axios.post('https://aggregator-api.kyberswap.com/base/api/v1/route/build', {
      routeSummary,
      sender: wallet.address,
      recipient: wallet.address,
      slippageTolerance: 100, // 1%
    }, { timeout: 10000 });
    const txData = br.data?.data;
    if (!txData) throw new Error('Build route failed');

    // 3. Check & approve allowance
    const currentAllowance = await beanToken.allowance(wallet.address, txData.routerAddress);
    if (currentAllowance < amount) {
      const approveTx = await beanToken.approve(txData.routerAddress, ethers.MaxUint256);
      await approveTx.wait();
      console.log('✅ Approved BEAN for KyberSwap router');
    }

    // 4. Execute swap dengan gas rendah (bukan last-second, bisa santai)
    const sg = await getAdaptiveFee({ gasLimit: 900000n });
    const tx = await wallet.sendTransaction({
      to: txData.routerAddress,
      data: txData.data,
      value: txData.value || 0n,
      gasLimit: 900000,
      maxFeePerGas: sg.maxFeePerGas,
      maxPriorityFeePerGas: sg.maxPriorityFeePerGas,
    });
    await tx.wait();

    const swappedEth = ethers.formatEther(amount);
    console.log(`🔄 SWAP done: ${swappedEth} BEAN → ETH`);
    await tg(`🔄 *AUTO SWAP*\n${parseFloat(swappedEth).toFixed(4)} BEAN ➡️ ETH\n\`${tx.hash.slice(0, 20)}...\``);
  } catch (e) {
    // Simpan pending amount untuk retry nanti
    pendingSwapAmount = amount;
    console.error('Swap error:', e.message);
    await tg(`❌ Swap error: ${e.message.slice(0, 80)}`);
  }
}

// ==========================================================
// SNAPSHOT — ambil data dari ronde sebelumnya (N-1, settled)
// Pakai /api/round/{id}/miners untuk breakdown per wallet
// ==========================================================
async function takeSnapshot(roundId) {
  try {
    const res = await axios.get(`${MINEBEAN_API}/api/round/${roundId}/miners`, { timeout: 4000 });

    // Track winning block dari ronde sebelumnya (kalau API kasih)
    if (res.data?.winningBlock != null) {
      const wb = Number(res.data.winningBlock);
      if (wb >= 0 && wb <= 24) prevWinningBlock = wb;
    }

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
  if (MIN_BEANPOT_THRESHOLD > 0 && currentBeanpotBean < MIN_BEANPOT_THRESHOLD) {
    return { skip: true, reason: `Beanpot ${currentBeanpotBean.toFixed(2)} < ${MIN_BEANPOT_THRESHOLD}`, snapshot };
  }
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
  // Strategy: cari zona kosong yang profitable
  // - Ada MID player (0.00005-0.0001) → bet 0.00004 (di bawah mereka, share besar)
  // - Tidak ada siapapun di zona 0.00008 → bet 0.00008 (dominasi total)
  // - Manual override via /setbet

  let optimalBetEth = 0;
  let strategy = '';

  if (MANUAL_BET !== null) {
    // Manual mode — fixed bet per block
    optimalBetEth = parseFloat(ethers.formatEther(MANUAL_BET));
    strategy = `MANUAL (${optimalBetEth.toFixed(6)} ETH/blok)`;
  } else {
    // === AUTO: IKUT BOBOT TERBESAR (per-wallet dari API + validated by on-chain) ===
    const microTotal = stats.MICRO.total || 0;
    const semutTotal = stats.SEMUT.total || 0;
    const midTotal = stats.MID.total || 0;

    // Cari kelas dengan bobot terbesar
    if (midTotal >= semutTotal && midTotal >= microTotal && midTotal > 0) {
      optimalBetEth = 0.000080;
      strategy = `IKUT-MID: bobot MID ${midTotal.toFixed(6)} > SEMUT ${semutTotal.toFixed(6)} > MICRO ${microTotal.toFixed(6)}`;
    } else if (semutTotal >= microTotal && semutTotal > 0) {
      optimalBetEth = 0.000040;
      strategy = `IKUT-SEMUT: bobot SEMUT ${semutTotal.toFixed(6)} > MID ${midTotal.toFixed(6)} > MICRO ${microTotal.toFixed(6)}`;
    } else if (microTotal > 0) {
      optimalBetEth = 0.000080;
      strategy = `DOMINATE-MICRO: hanya MICRO ${microTotal.toFixed(6)}, kita 0.00008`;
    } else {
      optimalBetEth = 0.000080;
      strategy = `NO-OPPONENT: board ${totalBoardEth.toFixed(6)}, bet 0.00008`;
    }
  }

  // No MIN/MAX cap untuk auto — strategy sudah fixed nominal
  let capped = false;

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
    `📊 *R#${s.roundId} SNAPSHOT* (det 52, ref R#${s.roundId - 1})`,
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

    // === Tentukan block IDs sesuai deployMode ===
    let blockIds = Array.from({ length: 25 }, (_, i) => i);
    let modeUsed = 'ALL (25 blok)';
    if (deployMode === 'skip' && prevWinningBlock >= 0 && prevWinningBlock <= 24) {
      blockIds = blockIds.filter(b => b !== prevWinningBlock);
      modeUsed = `SKIP (24 blok, skip blok ${prevWinningBlock})`;
    }

    const totalBet = decision.betPerBlockWei * BigInt(blockIds.length);
    lastRoundBet = totalBet;

    const gas = await getAdaptiveFee({ boardEth: decision.snapshot.totalBoardEth });

    const tx = await grid.deploy(blockIds, {
      value: totalBet,
      gasLimit: 1000000,
      maxFeePerGas: gas.maxFeePerGas,
      maxPriorityFeePerGas: gas.maxPriorityFeePerGas,
    });

    console.log(`🔥 DEPLOY tx sent: ${tx.hash.slice(0, 18)}... [${modeUsed}]`);
    await tg(`🔥 *DEPLOYED R#${decision.snapshot.roundId}*\nMode: ${modeUsed}\nBet: ${decision.betPerBlockEth.toFixed(6)}/blok × ${blockIds.length} = ${(decision.betPerBlockEth * blockIds.length).toFixed(6)} ETH ($${(decision.betPerBlockEth * blockIds.length * currentEthPriceUsd).toFixed(2)})\n\`${tx.hash.slice(0, 20)}...\``);

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

    // Auto-swap: cek wallet BEAN balance setelah claim
    const walletBean = await beanToken.balanceOf(wallet.address);
    if (walletBean >= AUTO_SWAP_THRESHOLD && !isSwapping && pendingSwapAmount === 0n) {
      pendingSwapAmount = walletBean;
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
    `Deploy Mode  : ${deployMode.toUpperCase()}${deployMode==='skip'?` (skip blok ${prevWinningBlock})`:''}`,
    `Budget/ronde: $${(parseFloat(ethers.formatEther(BUDGET_PER_RONDE)) * currentEthPriceUsd).toFixed(2)}`,
    `Bet/blok min: ${ethers.formatEther(MIN_BET_PER_BLOCK)}`,
    `Bet/blok max: ${ethers.formatEther(MAX_BET_PER_BLOCK)}`,
    `Skip whale  : ${SKIP_IF_WHALE ? 'YES' : 'NO'}`,
    `Skip if HIGH≥: ${SKIP_IF_HIGH_GTE}`,
    `Skip if board>: $${SKIP_IF_BOARD_USD}`,
    `Auto-swap   : ${parseFloat(ethers.formatEther(AUTO_SWAP_THRESHOLD)) < 999999 ? ethers.formatEther(AUTO_SWAP_THRESHOLD) + ' BEAN' : 'OFF'}`,
    `Min beanpot : ${MIN_BEANPOT_THRESHOLD > 0 ? MIN_BEANPOT_THRESHOLD + ' BEAN' : 'OFF'}`,
    `Bet mode    : ${MANUAL_BET !== null ? 'MANUAL ' + ethers.formatEther(MANUAL_BET) + ' ETH/blok' : 'AUTO'}`,
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

bot.onText(/\/setswap (.+)/, (msg, m) => {
  if (!isOwner(msg)) return;
  try {
    const val = m[1].trim().toLowerCase();
    if (val === 'off' || val === '0') {
      AUTO_SWAP_THRESHOLD = ethers.parseEther('999999'); // effectively disabled
      tg(`✅ Auto-swap: *OFF*`);
    } else {
      AUTO_SWAP_THRESHOLD = ethers.parseEther(val);
      tg(`✅ Auto-swap threshold: *${val} BEAN*`);
    }
  } catch (e) { tg(`❌ Format: /setswap 0.39 atau /setswap off`); }
});

bot.onText(/\/setloss (.+)/, (msg, m) => {
  if (!isOwner(msg)) return;
  const v = parseInt(m[1]);
  if (!isNaN(v) && v >= 1) {
    MAX_LOSS_STREAK = v;
    tg(`✅ Max loss streak: *${v}*`);
  } else { tg(`❌ Format: /setloss 5`); }
});

bot.onText(/\/setbet (.+)/, (msg, m) => {
  if (!isOwner(msg)) return;
  const val = m[1].trim().toLowerCase();
  if (val === 'auto' || val === 'off') {
    MANUAL_BET = null;
    tg(`✅ Bet mode: *AUTO* (adaptive berdasarkan lawan)`);
  } else {
    try {
      const parsed = ethers.parseEther(val);
      MANUAL_BET = parsed;
      tg(`✅ Bet mode: *MANUAL*\nFixed: *${val} ETH/blok* (${(parseFloat(val) * 25).toFixed(6)} ETH total/ronde)`);
    } catch (e) { tg(`❌ Format: /setbet 0.00004 atau /setbet auto`); }
  }
});

bot.onText(/\/setpot (.+)/, (msg, m) => {
  if (!isOwner(msg)) return;
  const v = parseFloat(m[1]);
  if (!isNaN(v) && v >= 0) {
    MIN_BEANPOT_THRESHOLD = v;
    tg(`✅ Min beanpot threshold: *${v} BEAN*${v === 0 ? ' (disabled)' : ''}`);
  } else { tg(`❌ Format: /setpot 50 atau /setpot 0 (disable)`); }
});

bot.onText(/\/mode (.+)/, (msg, m) => {
  if (!isOwner(msg)) return;
  const v = m[1].trim().toLowerCase();
  if (v === 'all') {
    deployMode = 'all';
    tg(`✅ *DEPLOY MODE* ➡️ *ALL (25 blok)*`);
  } else if (v === 'skip') {
    deployMode = 'skip';
    tg(`✅ *DEPLOY MODE* ➡️ *SKIP (24 blok, prev winner: ${prevWinningBlock})*`);
  } else {
    tg(`❌ Format: /mode all atau /mode skip`);
  }
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
    `/setbet [ETH] - fixed bet per blok (atau /setbet auto)`,
    `/setminmodal [USD] - min modal stop-loss`,
    `/setswap [BEAN] - threshold auto-swap (atau /setswap off)`,
    `/setpot [BEAN] - min beanpot utk deploy (0 = off)`,
    `/setloss [N] - max loss streak sebelum pause`,
    `/mode all - deploy 25 blok`,
    `/mode skip - skip prev winning block (24 blok)`,
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

      // ===== AUTO SWAP phase (saat idle, tl > 50) =====
      if (pendingSwapAmount > 0n && !isSwapping && !isProcessing && !deploying && tl > 50 && tl < 59) {
        isSwapping = true;
        const swapAmt = pendingSwapAmount;
        pendingSwapAmount = 0n;
        setTimeout(async () => {
          try { await swapBeanToEth(swapAmt); }
          catch (e) { console.error('Swap exec err:', e.message); }
          finally { isSwapping = false; }
        }, 2000);
      }

      // ===== SNAPSHOT phase (detik ~52, tl = 7-9) =====
      // Snap langsung dari /api/round/current — data real-time ronde aktif
      if (!snapshotDone && tl >= 5 && tl <= 9 && rid === lastR) {
        snapshotDone = true;
        console.log(`\n📸 SNAPSHOT R#${rid} (tl=${tl}s, ref R#${rid - 1})`);
        const snap = await takeSnapshot(rid - 1);
        if (snap) {
          snap.roundId = rid;
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
