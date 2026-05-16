require('dotenv').config();
const axios = require('axios');

// ==========================================================
// MINEBEAN WINNER DEEP ANALYSIS
// Bedah per wallet di winning block — detail nominal bet
// Usage: node analyze.js [jumlah_ronde]
// Default: 20 ronde terakhir
// ==========================================================

const API = 'https://api.minebean.com';
const ROUNDS_TO_ANALYZE = parseInt(process.argv[2]) || 20;

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

async function getRoundDetail(roundId) {
  const r = await axios.get(`${API}/api/round/${roundId}`, { timeout: 10000 });
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
      if (deployedEth > 1000) deployedEth = deployedEth / 1e18;
    } catch (_) {}

    const beanReward = parseFloat(m.beanReward || m.bean_reward || 0);
    const ethReward = parseFloat(m.ethReward || m.eth_reward || 0);
    const blocks = m.blocks || m.blockIds || [];

    allMiners.push({
      addr,
      addrShort: addr.slice(0, 8) + '...' + addr.slice(-4),
      deployedEth,
      beanReward,
      ethReward,
      blocks,
      isWinner: beanReward > 0,
    });
  }

  // Winners & losers
  const winners = allMiners.filter(m => m.isWinner);
  const losers = allMiners.filter(m => !m.isWinner);

  // Mode
  const maxBean = Math.max(...winners.map(w => w.beanReward), 0);
  const isLotre = maxBean >= 0.9 && winners.length === 1;
  const isSplit = winners.length > 1;
  const mode = isLotre ? 'LOTRE' : (isSplit ? 'SPLIT' : 'UNKNOWN');

  // Total deployed di seluruh round
  const totalDeployedAll = allMiners.reduce((s, m) => s + m.deployedEth, 0);

  // Total deployed oleh winners saja (= total di winning block)
  const totalWinnerDeployed = winners.reduce((s, w) => s + w.deployedEth, 0);

  // Sort winners by bet (besar ke kecil)
  winners.sort((a, b) => b.deployedEth - a.deployedEth);

  // Hitung share tiap winner
  const winnersDetail = winners.map(w => {
    const shareOfWinBlock = totalWinnerDeployed > 0 ? (w.deployedEth / totalWinnerDeployed * 100) : 0;
    const shareOfTotal = totalDeployedAll > 0 ? (w.deployedEth / totalDeployedAll * 100) : 0;
    return {
      ...w,
      shareOfWinBlock,
      shareOfTotal,
    };
  });

  return {
    roundId,
    winningBlock,
    mode,
    totalPlayers: allMiners.length,
    totalDeployedAll,
    winnersCount: winners.length,
    losersCount: losers.length,
    totalWinnerDeployed,
    avgBetPerBlock: totalDeployedAll / 25,
    winnersDetail,
    minWinnerBet: winners.length > 0 ? winners[winners.length - 1].deployedEth : 0,
    maxWinnerBet: winners.length > 0 ? winners[0].deployedEth : 0,
  };
}

async function main() {
  console.log(`\n🔬 MINEBEAN DEEP WINNER ANALYSIS — Last ${ROUNDS_TO_ANALYZE} rounds`);
  console.log(`   Bedah nominal bet per wallet di winning block\n`);
  console.log('='.repeat(80));

  // Fetch rounds
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
  const allWinnerBets = [];
  const allLoserBets = [];
  let lotreCount = 0, splitCount = 0;

  for (let i = 0; i < rounds.length; i++) {
    const round = rounds[i];
    const roundId = round.roundId || round.id || round.round_id;
    if (!roundId) continue;

    await sleep(DELAY);

    try {
      const data = await getRoundMiners(roundId);
      const analysis = analyzeRound(data, roundId);

      if (!analysis) {
        console.log(`  R#${roundId}: ⚠️ No winner data\n`);
        continue;
      }

      results.push(analysis);
      if (analysis.mode === 'LOTRE') lotreCount++;
      if (analysis.mode === 'SPLIT') splitCount++;

      // Collect all bets
      for (const w of analysis.winnersDetail) allWinnerBets.push(w.deployedEth);
      // Losers avg (approximate)
      if (analysis.losersCount > 0) {
        const losersTotal = analysis.totalDeployedAll - analysis.totalWinnerDeployed;
        allLoserBets.push(losersTotal / analysis.losersCount);
      }

      // === PRINT DETAIL PER ROUND ===
      console.log(`┌─ R#${roundId} | 🎯 Winning Block: ${analysis.winningBlock} | Mode: ${analysis.mode}`);
      console.log(`│  Players: ${analysis.totalPlayers} | Total deployed: ${analysis.totalDeployedAll.toFixed(6)} ETH`);
      console.log(`│  Winners: ${analysis.winnersCount} | Winner pool: ${analysis.totalWinnerDeployed.toFixed(6)} ETH`);
      console.log(`│`);
      console.log(`│  📋 DETAIL PER WALLET DI WINNING BLOCK:`);
      console.log(`│  ${'─'.repeat(70)}`);
      console.log(`│  ${'Wallet'.padEnd(18)} | ${'Bet (ETH)'.padEnd(14)} | ${'BEAN Won'.padEnd(10)} | ${'Share Block'.padEnd(12)} | Notes`);
      console.log(`│  ${'─'.repeat(70)}`);

      for (const w of analysis.winnersDetail) {
        let note = '';
        if (w.deployedEth === analysis.maxWinnerBet && analysis.winnersCount > 1) note = '👑 BIGGEST';
        if (w.deployedEth === analysis.minWinnerBet && analysis.winnersCount > 1 && analysis.minWinnerBet !== analysis.maxWinnerBet) note = '🐜 SMALLEST';
        if (analysis.mode === 'LOTRE') note = '🎰 JACKPOT';

        console.log(`│  ${w.addrShort.padEnd(18)} | ${w.deployedEth.toFixed(8).padEnd(14)} | ${w.beanReward.toFixed(4).padEnd(10)} | ${w.shareOfWinBlock.toFixed(1).padStart(5)}%${' '.repeat(6)} | ${note}`);
      }

      console.log(`│  ${'─'.repeat(70)}`);
      console.log(`│  Min bet winner: ${analysis.minWinnerBet.toFixed(8)} ETH`);
      console.log(`│  Max bet winner: ${analysis.maxWinnerBet.toFixed(8)} ETH`);
      console.log(`│  Ratio max/min : ${analysis.minWinnerBet > 0 ? (analysis.maxWinnerBet / analysis.minWinnerBet).toFixed(1) + 'x' : 'N/A'}`);
      console.log(`└${'─'.repeat(79)}\n`);

    } catch (e) {
      console.log(`  R#${roundId}: ❌ ${e.message}\n`);
    }
  }

  // === AGGREGATE STATS ===
  console.log('\n' + '='.repeat(80));
  console.log('📊 AGGREGATE ANALYSIS — All winner bets combined');
  console.log('='.repeat(80));

  if (allWinnerBets.length === 0) {
    console.log('No data');
    return;
  }

  allWinnerBets.sort((a, b) => a - b);

  // Bucketing
  const buckets = {
    '< 0.000005': 0,
    '0.000005 - 0.00001': 0,
    '0.00001 - 0.00003': 0,
    '0.00003 - 0.00005': 0,
    '0.00005 - 0.0001': 0,
    '0.0001 - 0.0003': 0,
    '> 0.0003': 0,
  };

  for (const bet of allWinnerBets) {
    if (bet < 0.000005) buckets['< 0.000005']++;
    else if (bet < 0.00001) buckets['0.000005 - 0.00001']++;
    else if (bet < 0.00003) buckets['0.00001 - 0.00003']++;
    else if (bet < 0.00005) buckets['0.00003 - 0.00005']++;
    else if (bet < 0.0001) buckets['0.00005 - 0.0001']++;
    else if (bet < 0.0003) buckets['0.0001 - 0.0003']++;
    else buckets['> 0.0003']++;
  }

  console.log(`\n🎯 DISTRIBUSI BET WINNER (${allWinnerBets.length} wallets total):\n`);
  const maxCount = Math.max(...Object.values(buckets));
  for (const [range, count] of Object.entries(buckets)) {
    const pct = (count / allWinnerBets.length * 100).toFixed(0);
    const bar = '█'.repeat(Math.round(count / maxCount * 30)) || (count > 0 ? '▏' : '');
    console.log(`  ${range.padEnd(22)} | ${bar} ${count} (${pct}%)`);
  }

  // Percentiles
  const p = (pct) => allWinnerBets[Math.floor(allWinnerBets.length * pct / 100)] || 0;
  console.log(`\n📐 PERCENTILES winner bet:`);
  console.log(`  Min (P0)  : ${allWinnerBets[0].toFixed(8)} ETH`);
  console.log(`  P25       : ${p(25).toFixed(8)} ETH`);
  console.log(`  Median P50: ${p(50).toFixed(8)} ETH`);
  console.log(`  P75       : ${p(75).toFixed(8)} ETH`);
  console.log(`  Max (P100): ${allWinnerBets[allWinnerBets.length - 1].toFixed(8)} ETH`);

  // Mode stats
  console.log(`\n🎰 MODE BREAKDOWN:`);
  console.log(`  LOTRE : ${lotreCount}/${results.length} (${(lotreCount/results.length*100).toFixed(0)}%) — 1 orang menang semua BEAN`);
  console.log(`  SPLIT : ${splitCount}/${results.length} (${(splitCount/results.length*100).toFixed(0)}%) — dibagi proporsional`);

  // Optimal bet recommendation
  const median = p(50);
  const p25 = p(25);
  const p75 = p(75);
  console.log(`\n💡 REKOMENDASI BERDASARKAN DATA:`);
  console.log(`  Sweet spot bet/blok: ${p25.toFixed(6)} - ${p75.toFixed(6)} ETH`);
  console.log(`  Median winner bet  : ${median.toFixed(6)} ETH`);
  console.log(`  Total/ronde (×25)  : ${(median * 25).toFixed(6)} ETH`);
  console.log(`  Di USD (~$2500/ETH): $${(median * 25 * 2500).toFixed(4)}`);
  console.log('');
  console.log(`  💬 Untuk /setbet, gunakan range ${p25.toFixed(6)} - ${p75.toFixed(6)}`);
  console.log(`     Contoh: /setbet ${median.toFixed(6)}`);
  console.log('');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
