require('dotenv').config();
const axios = require('axios');

// ==========================================================
// MINEBEAN WINNER ANALYSIS
// Analisa history: kenapa winner bisa menang?
// Usage: node analyze.js [jumlah_ronde]
// Default: 20 ronde terakhir
// ==========================================================

const API = 'https://api.minebean.com';
const ROUNDS_TO_ANALYZE = parseInt(process.argv[2]) || 20;

// Delay antar request (ms) — respect rate limit
const DELAY = 350;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getSettledRounds(limit) {
  const r = await axios.get(`${API}/api/rounds`, {
    params: { page: 1, limit, settled: true },
    timeout: 10000,
  });
  return r.data?.rounds || r.data?.data?.rounds || r.data?.data || r.data || [];
}

async function getRoundMiners(roundId) {
  const r = await axios.get(`${API}/api/round/${roundId}/miners`, { timeout: 10000 });
  return r.data;
}

function analyzeRound(roundData, roundId) {
  const winningBlock = roundData.winningBlock ?? roundData.winner_block ?? roundData.winBlock;
  if (winningBlock == null || winningBlock < 0) return null;

  let miners = roundData.miners || roundData.data?.miners || roundData.data || [];
  if (!Array.isArray(miners) && typeof miners === 'object') miners = Object.values(miners);
  if (!Array.isArray(miners)) return null;

  // Parse semua miner
  const allMiners = [];
  for (const m of miners) {
    const addr = String(m.address || m.walletAddress || m.deployer || m.miner || m.wallet || '?').toLowerCase();
    const deployedStr = m.deployedFormatted || m.deployed || '0';
    let deployedEth = 0;
    try {
      deployedEth = parseFloat(deployedStr);
      if (deployedEth > 1000) deployedEth = deployedEth / 1e18; // wei to eth
    } catch (_) {}

    const beanReward = parseFloat(m.beanReward || m.bean_reward || 0);
    const blocks = m.blocks || m.blockIds || [];

    allMiners.push({
      addr: addr.slice(0, 10) + '...',
      addrFull: addr,
      deployedEth,
      beanReward,
      blocks,
      isWinner: beanReward > 0,
    });
  }

  // Total stats
  const totalPlayers = allMiners.length;
  const totalDeployed = allMiners.reduce((s, m) => s + m.deployedEth, 0);

  // Winners (yang dapat BEAN > 0)
  const winners = allMiners.filter(m => m.isWinner);
  const losers = allMiners.filter(m => !m.isWinner);

  // Determine mode: Lotre vs Split
  const maxBean = Math.max(...winners.map(w => w.beanReward), 0);
  const isLotre = maxBean >= 0.9 && winners.length === 1;
  const isSplit = winners.length > 1;
  const mode = isLotre ? 'LOTRE' : (isSplit ? 'SPLIT' : 'UNKNOWN');

  // Winner analysis
  const winnerAnalysis = winners.map(w => {
    const sharePercent = totalDeployed > 0 ? (w.deployedEth / totalDeployed * 100) : 0;
    const beanValue = w.beanReward;

    // Kenapa dia menang?
    let reason = '';
    if (isLotre) {
      reason = `LOTRE: weighted random, bet ${w.deployedEth.toFixed(6)} ETH = higher probability`;
    } else if (isSplit) {
      reason = `SPLIT: proporsional share (${sharePercent.toFixed(1)}% of total deployed)`;
    }

    return {
      ...w,
      sharePercent,
      reason,
    };
  });

  // Rank winners by bet size
  winnerAnalysis.sort((a, b) => b.deployedEth - a.deployedEth);

  return {
    roundId,
    winningBlock,
    mode,
    totalPlayers,
    totalDeployed,
    winnersCount: winners.length,
    losersCount: losers.length,
    winners: winnerAnalysis,
    topWinnerBet: winnerAnalysis[0]?.deployedEth || 0,
    topWinnerBean: winnerAnalysis[0]?.beanReward || 0,
    avgWinnerBet: winners.length > 0 ? winners.reduce((s, w) => s + w.deployedEth, 0) / winners.length : 0,
    avgLoserBet: losers.length > 0 ? losers.reduce((s, l) => s + l.deployedEth, 0) / losers.length : 0,
  };
}

async function main() {
  console.log(`\n🔍 MINEBEAN WINNER ANALYSIS — Last ${ROUNDS_TO_ANALYZE} rounds\n`);
  console.log('='.repeat(70));

  // Get settled rounds
  console.log('📡 Fetching settled rounds...');
  let rounds;
  try {
    rounds = await getSettledRounds(ROUNDS_TO_ANALYZE);
  } catch (e) {
    console.error('❌ Gagal fetch rounds:', e.message);
    return;
  }

  if (!rounds.length) {
    console.log('❌ Tidak ada data ronde');
    return;
  }

  console.log(`✅ Got ${rounds.length} rounds\n`);

  const results = [];
  let lotreCount = 0, splitCount = 0;
  let totalWinnerBetSum = 0, totalLoserBetSum = 0;
  let bigBetWinCount = 0, smallBetWinCount = 0;

  for (let i = 0; i < rounds.length; i++) {
    const round = rounds[i];
    const roundId = round.roundId || round.id || round.round_id;
    if (!roundId) continue;

    await sleep(DELAY);

    try {
      const data = await getRoundMiners(roundId);
      const analysis = analyzeRound(data, roundId);

      if (!analysis) {
        console.log(`  R#${roundId}: ⚠️ No winner data`);
        continue;
      }

      results.push(analysis);

      // Stats
      if (analysis.mode === 'LOTRE') lotreCount++;
      if (analysis.mode === 'SPLIT') splitCount++;
      totalWinnerBetSum += analysis.avgWinnerBet;
      totalLoserBetSum += analysis.avgLoserBet;
      if (analysis.topWinnerBet > analysis.avgLoserBet) bigBetWinCount++;
      else smallBetWinCount++;

      // Print per round
      const topW = analysis.winners[0];
      console.log(`  R#${roundId} | Block: ${analysis.winningBlock} | ${analysis.mode} | Players: ${analysis.totalPlayers} | Winners: ${analysis.winnersCount}`);
      if (topW) {
        console.log(`    👑 Top: ${topW.addr} bet ${topW.deployedEth.toFixed(6)} ETH → ${topW.beanReward.toFixed(4)} BEAN`);
        console.log(`    💡 ${topW.reason}`);
      }
      if (analysis.winners.length > 1) {
        console.log(`    📊 All winners:`);
        for (const w of analysis.winners.slice(0, 5)) {
          console.log(`       ${w.addr} | ${w.deployedEth.toFixed(6)} ETH | ${w.beanReward.toFixed(4)} BEAN | share ${w.sharePercent.toFixed(1)}%`);
        }
        if (analysis.winners.length > 5) console.log(`       ... +${analysis.winners.length - 5} more`);
      }
      console.log('');

    } catch (e) {
      console.log(`  R#${roundId}: ❌ ${e.message}`);
    }
  }

  // Summary
  console.log('\n' + '='.repeat(70));
  console.log('📊 SUMMARY');
  console.log('='.repeat(70));
  console.log(`Rounds analyzed  : ${results.length}`);
  console.log(`Mode LOTRE       : ${lotreCount} (${(lotreCount/results.length*100).toFixed(0)}%)`);
  console.log(`Mode SPLIT       : ${splitCount} (${(splitCount/results.length*100).toFixed(0)}%)`);
  console.log(`Avg winner bet   : ${(totalWinnerBetSum/results.length).toFixed(6)} ETH`);
  console.log(`Avg loser bet    : ${(totalLoserBetSum/results.length).toFixed(6)} ETH`);
  console.log(`Big bet wins     : ${bigBetWinCount} (${(bigBetWinCount/results.length*100).toFixed(0)}%)`);
  console.log(`Small bet wins   : ${smallBetWinCount} (${(smallBetWinCount/results.length*100).toFixed(0)}%)`);
  console.log('');

  // Winning block distribution
  const blockFreq = {};
  for (const r of results) {
    blockFreq[r.winningBlock] = (blockFreq[r.winningBlock] || 0) + 1;
  }
  const sorted = Object.entries(blockFreq).sort((a, b) => b[1] - a[1]);
  console.log('🎲 Winning block frequency (top 10):');
  for (const [block, count] of sorted.slice(0, 10)) {
    const bar = '█'.repeat(count);
    console.log(`   Block ${String(block).padStart(2)}: ${bar} (${count}x = ${(count/results.length*100).toFixed(0)}%)`);
  }

  // Key insights
  console.log('\n💡 KEY INSIGHTS:');
  if (lotreCount > splitCount) {
    console.log('   → Mode LOTRE dominan: bet BESAR di winning block = peluang lebih tinggi (weighted random)');
  } else {
    console.log('   → Mode SPLIT dominan: semua di winning block dapat, proporsional ke bet');
  }
  if (bigBetWinCount > smallBetWinCount) {
    console.log('   → Winner cenderung yang BET LEBIH BESAR (dominate strategy works)');
  } else {
    console.log('   → Small bet juga sering menang (luck factor tinggi, spread strategy viable)');
  }
  console.log('   → Semua 25 blok uniform random (VRF) — TIDAK ada blok "hot"');
  console.log('   → Strategy terbaik: spread ke semua blok + pastikan share besar di winning block');
  console.log('');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
