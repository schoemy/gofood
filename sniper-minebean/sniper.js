/**
 * ============================================================
 *  SNIPER MINEBEAN — Auto-Strategy Bot
 * ============================================================
 *  Strategi Terintegrasi:
 *    1. Heavy Node       — All-in di node reward terbesar
 *    2. Semut vs Kons    — Bet di sisi minoritas (miner vs consumer)
 *    3. Kuasai Semut Micro — Micro-bet bertahap dominasi node semut
 *    4. Pool %           — Bet di node dengan pool% paling profitable
 *
 *  Auto-Pilot: Bot otomatis pilih strategi terbaik tiap ronde
 *              tanpa perlu manual /setmax
 * ============================================================
 */

'use strict';

// ===================== LOAD .env FILE =====================
const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  envContent.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const [key, ...valueParts] = trimmed.split('=');
      const value = valueParts.join('=').replace(/^["']|["']$/g, '');
      if (key && value) process.env[key.trim()] = value.trim();
    }
  });
  console.log('✅ .env loaded');
}

// ===================== CONFIGURATION =====================
const CONFIG = {
  // Telegram Bot
  botToken: process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN',
  chatId: process.env.CHAT_ID || '',
  mineBeanBotUsername: '@MineBeanBot',

  // Betting
  defaultBet: 10,
  maxBet: 1000,
  minBet: 5,
  bankroll: 10000,
  riskPercent: 5,           // Max % bankroll per bet

  // Strategy Weights (auto-tuned)
  strategyWeights: {
    heavyNode: 1.0,
    semutVsKons: 1.0,
    kuasaiSemutMicro: 1.0,
    poolPercent: 1.0,
  },

  // Auto-pilot
  autoPilot: true,
  roundDelay: 2000,         // ms between rounds
  maxConsecutiveLoss: 5,    // Stop after N consecutive losses
  profitTarget: 0.3,        // 30% profit target per session

  // Logging
  verbose: true,
};

// ===================== GAME STATE =====================
class GameState {
  constructor() {
    this.reset();
  }

  reset() {
    this.round = 0;
    this.nodes = [];          // Array of node objects
    this.players = [];        // Players in current round
    this.poolTotal = 0;
    this.history = [];        // Past rounds results
    this.consecutiveLoss = 0;
    this.sessionProfit = 0;
    this.bankroll = CONFIG.bankroll;
  }

  updateFromRound(roundData) {
    this.round = roundData.round || this.round + 1;
    this.nodes = roundData.nodes || [];
    this.players = roundData.players || [];
    this.poolTotal = this.nodes.reduce((sum, n) => sum + (n.pool || 0), 0);
  }

  recordResult(result) {
    this.history.push(result);
    if (result.profit > 0) {
      this.consecutiveLoss = 0;
    } else {
      this.consecutiveLoss++;
    }
    this.sessionProfit += result.profit;
    this.bankroll += result.profit;
  }

  getWinRate() {
    if (this.history.length === 0) return 0.5;
    const wins = this.history.filter(h => h.profit > 0).length;
    return wins / this.history.length;
  }

  getRecentTrend(n = 5) {
    const recent = this.history.slice(-n);
    if (recent.length === 0) return 0;
    return recent.reduce((sum, h) => sum + h.profit, 0) / recent.length;
  }
}

// ===================== STRATEGY: HEAVY NODE =====================


/**
 * STRATEGY 1: Heavy Node
 * -----------------------
 * Fokus pada node dengan reward multiplier terbesar.
 * All-in (scaled by risk) saat peluang tinggi.
 * Cocok saat ada 1 node yang jelas dominan rewardnya.
 */
class HeavyNodeStrategy {
  constructor() {
    this.name = 'Heavy Node';
    this.id = 'heavyNode';
  }

  /**
   * Evaluate seberapa cocok strategi ini untuk kondisi saat ini
   * @returns {number} Score 0-100
   */
  evaluate(state) {
    if (state.nodes.length === 0) return 0;

    const rewards = state.nodes.map(n => n.reward || n.multiplier || 1);
    const maxReward = Math.max(...rewards);
    const avgReward = rewards.reduce((a, b) => a + b, 0) / rewards.length;

    // Semakin tinggi gap antara max dan avg, semakin cocok
    const dominanceRatio = maxReward / (avgReward || 1);

    // Score tinggi jika ada 1 node yang jauh lebih besar
    let score = 0;
    if (dominanceRatio >= 3.0) score = 90;
    else if (dominanceRatio >= 2.0) score = 70;
    else if (dominanceRatio >= 1.5) score = 50;
    else score = 20;

    // Bonus jika node tersebut punya sedikit player
    const heaviestNode = state.nodes.find(n => (n.reward || n.multiplier || 1) === maxReward);
    if (heaviestNode && heaviestNode.playerCount <= 2) {
      score += 10;
    }

    return Math.min(score, 100);
  }

  /**
   * Execute strategi — return bet decision
   */
  execute(state) {
    const rewards = state.nodes.map(n => n.reward || n.multiplier || 1);
    const maxReward = Math.max(...rewards);
    const targetNode = state.nodes.find(n => (n.reward || n.multiplier || 1) === maxReward);

    // Bet sizing: aggressive for heavy node
    const betSize = this.calculateBet(state, maxReward);

    return {
      strategy: this.name,
      node: targetNode ? targetNode.id : 0,
      nodeName: targetNode ? targetNode.name : 'unknown',
      betAmount: betSize,
      reason: `Node reward ${maxReward}x dominan — all-in scaled`,
      confidence: this.evaluate(state),
    };
  }

  calculateBet(state, multiplier) {
    const maxRisk = state.bankroll * (CONFIG.riskPercent / 100);
    // Bet lebih besar saat multiplier tinggi
    const scaleFactor = Math.min(multiplier / 2, 3);
    let bet = Math.round(CONFIG.defaultBet * scaleFactor);
    bet = Math.min(bet, maxRisk, CONFIG.maxBet);
    bet = Math.max(bet, CONFIG.minBet);
    return bet;
  }
}

// ===================== STRATEGY: SEMUT VS KONS =====================


/**
 * STRATEGY 2: Semut vs Kons (Ant vs Consumer)
 * --------------------------------------------
 * Analisis rasio pemain semut (miner) vs konsumer (consumer).
 * Bet di sisi MINORITAS — karena reward pool dibagi ke lebih sedikit orang.
 * Cocok saat ada imbalance besar antara miner dan consumer.
 */
class SemutVsKonsStrategy {
  constructor() {
    this.name = 'Semut vs Kons';
    this.id = 'semutVsKons';
  }

  evaluate(state) {
    const miners = state.players.filter(p => p.role === 'miner' || p.role === 'semut');
    const consumers = state.players.filter(p => p.role === 'consumer' || p.role === 'kons');

    const totalPlayers = miners.length + consumers.length;
    if (totalPlayers === 0) return 0;

    const ratio = miners.length / (consumers.length || 1);
    const imbalance = Math.abs(ratio - 1);

    // Semakin tidak seimbang, semakin menguntungkan
    let score = 0;
    if (imbalance >= 2.0) score = 95;
    else if (imbalance >= 1.5) score = 80;
    else if (imbalance >= 1.0) score = 60;
    else if (imbalance >= 0.5) score = 40;
    else score = 15;

    // Extra bonus from historical pattern
    const recentMinority = this.getRecentMinorityWinRate(state);
    score += recentMinority * 10;

    return Math.min(score, 100);
  }

  execute(state) {
    const miners = state.players.filter(p => p.role === 'miner' || p.role === 'semut');
    const consumers = state.players.filter(p => p.role === 'consumer' || p.role === 'kons');

    // Pilih sisi minoritas
    let targetSide, reason;
    if (miners.length <= consumers.length) {
      targetSide = 'miner';
      reason = `Semut minoritas (${miners.length} vs ${consumers.length}) — reward lebih besar per orang`;
    } else {
      targetSide = 'consumer';
      reason = `Kons minoritas (${consumers.length} vs ${miners.length}) — reward lebih besar per orang`;
    }

    // Find node for the minority side
    const targetNode = state.nodes.find(n => n.side === targetSide || n.type === targetSide) || state.nodes[0];

    const betSize = this.calculateBet(state, miners.length, consumers.length);

    return {
      strategy: this.name,
      node: targetNode ? targetNode.id : 0,
      nodeName: targetNode ? targetNode.name : targetSide,
      side: targetSide,
      betAmount: betSize,
      reason,
      confidence: this.evaluate(state),
    };
  }

  calculateBet(state, minerCount, consumerCount) {
    const maxRisk = state.bankroll * (CONFIG.riskPercent / 100);
    const totalPlayers = minerCount + consumerCount;
    const minorityCount = Math.min(minerCount, consumerCount);

    // Semakin sedikit di sisi minoritas, bet lebih besar (reward lebih banyak)
    const minorityRatio = 1 - (minorityCount / (totalPlayers || 1));
    const scaleFactor = 1 + (minorityRatio * 2);

    let bet = Math.round(CONFIG.defaultBet * scaleFactor);
    bet = Math.min(bet, maxRisk, CONFIG.maxBet);
    bet = Math.max(bet, CONFIG.minBet);
    return bet;
  }

  getRecentMinorityWinRate(state) {
    const recent = state.history.slice(-10).filter(h => h.strategy === this.name);
    if (recent.length === 0) return 0;
    return recent.filter(h => h.profit > 0).length / recent.length;
  }
}

// ===================== STRATEGY: KUASAI SEMUT MICRO =====================


/**
 * STRATEGY 3: Kuasai Semut Micro
 * --------------------------------
 * Micro-bet bertahap di node semut (miner) untuk perlahan mendominasi.
 * Strategi konservatif — bet kecil tapi sering, bangun posisi dominan.
 * Cocok saat bankroll kecil atau saat volatilitas tinggi.
 */
class KuasaiSemutMicroStrategy {
  constructor() {
    this.name = 'Kuasai Semut Micro';
    this.id = 'kuasaiSemutMicro';
    this.accumulatedPosition = 0; // Track posisi terakumulasi
    this.roundsInPosition = 0;
  }

  evaluate(state) {
    let score = 0;

    // Cocok saat bankroll rendah (perlu main aman)
    const bankrollRatio = state.bankroll / CONFIG.bankroll;
    if (bankrollRatio < 0.3) score += 30;
    else if (bankrollRatio < 0.5) score += 20;
    else if (bankrollRatio < 0.7) score += 10;

    // Cocok saat consecutive loss tinggi (perlu recovery)
    if (state.consecutiveLoss >= 3) score += 25;
    else if (state.consecutiveLoss >= 2) score += 15;

    // Cocok saat node semut punya sedikit player tapi pool cukup
    const minerNodes = state.nodes.filter(n => n.type === 'miner' || n.side === 'miner');
    if (minerNodes.length > 0) {
      const avgPlayers = minerNodes.reduce((s, n) => s + (n.playerCount || 0), 0) / minerNodes.length;
      if (avgPlayers <= 3) score += 20;
      if (avgPlayers <= 1) score += 15;
    }

    // Bonus saat sudah punya posisi terakumulasi
    if (this.roundsInPosition >= 3) score += 15;

    // Base score — strategi ini selalu punya minimal value
    score += 15;

    return Math.min(score, 100);
  }

  execute(state) {
    // Cari node semut/miner dengan player paling sedikit
    const minerNodes = state.nodes.filter(n => n.type === 'miner' || n.side === 'miner' || n.name?.includes('semut'));
    let targetNode;

    if (minerNodes.length > 0) {
      // Pilih node dengan least players
      targetNode = minerNodes.sort((a, b) => (a.playerCount || 0) - (b.playerCount || 0))[0];
    } else {
      // Fallback: node dengan pool terkecil (lebih mudah didominasi)
      targetNode = [...state.nodes].sort((a, b) => (a.pool || 0) - (b.pool || 0))[0];
    }

    // Micro bet — kecil tapi konsisten
    const betSize = this.calculateMicroBet(state);
    this.roundsInPosition++;
    this.accumulatedPosition += betSize;

    return {
      strategy: this.name,
      node: targetNode ? targetNode.id : 0,
      nodeName: targetNode ? targetNode.name : 'semut-micro',
      betAmount: betSize,
      accumulatedTotal: this.accumulatedPosition,
      roundsHeld: this.roundsInPosition,
      reason: `Micro-bet #${this.roundsInPosition} — dominasi bertahap (total akumulasi: ${this.accumulatedPosition})`,
      confidence: this.evaluate(state),
    };
  }

  calculateMicroBet(state) {
    // Micro bet = 1-2% bankroll, sangat konservatif
    const microPercent = 1.5;
    let bet = Math.round(state.bankroll * (microPercent / 100));
    bet = Math.max(bet, CONFIG.minBet);
    bet = Math.min(bet, CONFIG.defaultBet); // Never exceed default
    return bet;
  }

  resetPosition() {
    this.accumulatedPosition = 0;
    this.roundsInPosition = 0;
  }
}

// ===================== STRATEGY: POOL % =====================


/**
 * STRATEGY 4: Pool %
 * --------------------
 * Hitung persentase pool di tiap node.
 * Bet di node dengan pool% paling menguntungkan
 * (high pool, low player count = high expected value per player).
 * Cocok saat pool distribution tidak merata.
 */
class PoolPercentStrategy {
  constructor() {
    this.name = 'Pool %';
    this.id = 'poolPercent';
  }

  evaluate(state) {
    if (state.nodes.length === 0 || state.poolTotal === 0) return 0;

    // Hitung expected value per player per node
    const evScores = state.nodes.map(n => {
      const pool = n.pool || 0;
      const players = n.playerCount || 1;
      return pool / players;
    });

    const maxEV = Math.max(...evScores);
    const avgEV = evScores.reduce((a, b) => a + b, 0) / evScores.length;

    // Semakin besar gap EV, semakin profitable strategi ini
    const evGap = maxEV / (avgEV || 1);

    let score = 0;
    if (evGap >= 3.0) score = 95;
    else if (evGap >= 2.5) score = 85;
    else if (evGap >= 2.0) score = 70;
    else if (evGap >= 1.5) score = 50;
    else score = 25;

    // Bonus dari pool total yang besar
    if (state.poolTotal > 5000) score += 10;
    else if (state.poolTotal > 1000) score += 5;

    return Math.min(score, 100);
  }

  execute(state) {
    // Calculate EV for each node
    const nodeEVs = state.nodes.map(n => ({
      ...n,
      ev: (n.pool || 0) / (n.playerCount || 1),
      poolPercent: ((n.pool || 0) / (state.poolTotal || 1) * 100).toFixed(1),
    }));

    // Sort by EV descending
    nodeEVs.sort((a, b) => b.ev - a.ev);
    const bestNode = nodeEVs[0];

    if (!bestNode) {
      return {
        strategy: this.name,
        node: 0,
        betAmount: CONFIG.minBet,
        reason: 'No node data available',
        confidence: 0,
      };
    }

    const betSize = this.calculateBet(state, bestNode);

    return {
      strategy: this.name,
      node: bestNode.id,
      nodeName: bestNode.name || `node-${bestNode.id}`,
      betAmount: betSize,
      poolPercent: bestNode.poolPercent,
      expectedValue: bestNode.ev.toFixed(2),
      reason: `Pool ${bestNode.poolPercent}% | EV/player: ${bestNode.ev.toFixed(0)} | Players: ${bestNode.playerCount || '?'}`,
      confidence: this.evaluate(state),
    };
  }

  calculateBet(state, node) {
    const maxRisk = state.bankroll * (CONFIG.riskPercent / 100);
    // Scale bet by EV advantage
    const evAdvantage = node.ev / (state.poolTotal / state.nodes.length || 1);
    const scaleFactor = Math.min(evAdvantage, 2.5);

    let bet = Math.round(CONFIG.defaultBet * scaleFactor);
    bet = Math.min(bet, maxRisk, CONFIG.maxBet);
    bet = Math.max(bet, CONFIG.minBet);
    return bet;
  }
}

// ===================== AUTO-STRATEGY SELECTOR =====================


/**
 * AUTO-STRATEGY SELECTOR
 * -----------------------
 * Mengevaluasi semua 4 strategi tiap ronde, memilih yang terbaik
 * berdasarkan skor evaluasi + historical performance.
 * Menggantikan kebutuhan /setmax manual.
 */
class AutoStrategySelector {
  constructor() {
    this.strategies = [
      new HeavyNodeStrategy(),
      new SemutVsKonsStrategy(),
      new KuasaiSemutMicroStrategy(),
      new PoolPercentStrategy(),
    ];

    this.performanceTracker = {};
    this.strategies.forEach(s => {
      this.performanceTracker[s.id] = {
        wins: 0,
        losses: 0,
        totalProfit: 0,
        timesSelected: 0,
      };
    });

    this.lastStrategy = null;
  }

  /**
   * Pilih strategi terbaik berdasarkan kondisi saat ini
   */
  selectBest(state) {
    const evaluations = this.strategies.map(strategy => {
      const baseScore = strategy.evaluate(state);
      const performanceBonus = this.getPerformanceBonus(strategy.id);
      const weightMultiplier = CONFIG.strategyWeights[strategy.id] || 1.0;

      // Weighted final score
      const finalScore = (baseScore + performanceBonus) * weightMultiplier;

      return {
        strategy,
        baseScore,
        performanceBonus,
        finalScore: Math.min(finalScore, 100),
      };
    });

    // Sort by final score descending
    evaluations.sort((a, b) => b.finalScore - a.finalScore);

    const chosen = evaluations[0];
    this.lastStrategy = chosen.strategy;

    if (CONFIG.verbose) {
      console.log('\n┌─────────── STRATEGY EVALUATION ───────────┐');
      evaluations.forEach((e, i) => {
        const marker = i === 0 ? '★' : ' ';
        console.log(`│ ${marker} ${e.strategy.name.padEnd(20)} | Base: ${String(e.baseScore).padStart(3)} | Perf: ${String(e.performanceBonus.toFixed(0)).padStart(3)} | Final: ${String(e.finalScore.toFixed(0)).padStart(3)} │`);
      });
      console.log('└───────────────────────────────────────────┘');
    }

    return chosen;
  }

  /**
   * Get performance bonus dari historical win/loss
   */
  getPerformanceBonus(strategyId) {
    const perf = this.performanceTracker[strategyId];
    if (perf.timesSelected === 0) return 5; // New strategy bonus

    const winRate = perf.wins / perf.timesSelected;
    const avgProfit = perf.totalProfit / perf.timesSelected;

    // WinRate contribution (0-15 points)
    let bonus = winRate * 15;

    // Profit contribution (-5 to +10 points)
    if (avgProfit > 0) bonus += Math.min(avgProfit / 10, 10);
    else bonus += Math.max(avgProfit / 10, -5);

    return bonus;
  }

  /**
   * Update tracking setelah ronde selesai
   */
  recordOutcome(strategyId, profit) {
    const perf = this.performanceTracker[strategyId];
    perf.timesSelected++;
    perf.totalProfit += profit;
    if (profit > 0) perf.wins++;
    else perf.losses++;

    // Adaptive weight adjustment
    this.adjustWeights(strategyId, profit);
  }

  /**
   * Auto-adjust strategy weights based on performance
   */
  adjustWeights(strategyId, profit) {
    const adjustment = profit > 0 ? 0.05 : -0.03;
    CONFIG.strategyWeights[strategyId] = Math.max(
      0.3,
      Math.min(2.0, (CONFIG.strategyWeights[strategyId] || 1.0) + adjustment)
    );
  }

  getStats() {
    return Object.entries(this.performanceTracker).map(([id, perf]) => ({
      id,
      ...perf,
      winRate: perf.timesSelected > 0 ? (perf.wins / perf.timesSelected * 100).toFixed(1) + '%' : 'N/A',
      avgProfit: perf.timesSelected > 0 ? (perf.totalProfit / perf.timesSelected).toFixed(2) : '0',
      weight: (CONFIG.strategyWeights[id] || 1.0).toFixed(2),
    }));
  }
}

// ===================== MAIN BOT ENGINE =====================


/**
 * MAIN BOT ENGINE
 * ----------------
 * Orchestrates everything: round detection, strategy selection,
 * bet execution, and result tracking.
 */
class SniperBot {
  constructor() {
    this.state = new GameState();
    this.selector = new AutoStrategySelector();
    this.running = false;
    this.session = {
      startTime: null,
      rounds: 0,
      totalProfit: 0,
    };
  }

  // ---- Lifecycle ----

  start() {
    this.running = true;
    this.session.startTime = Date.now();
    console.log('═══════════════════════════════════════════');
    console.log('   🐝 SNIPER MINEBEAN — Auto Strategy');
    console.log('═══════════════════════════════════════════');
    console.log(`   Bankroll  : ${this.state.bankroll}`);
    console.log(`   Risk/Bet  : ${CONFIG.riskPercent}%`);
    console.log(`   Auto-Pilot: ${CONFIG.autoPilot ? 'ON' : 'OFF'}`);
    console.log(`   Strategies: 4 (Heavy Node, Semut vs Kons, Micro, Pool%)`);
    console.log('═══════════════════════════════════════════\n');
    this.loop();
  }

  stop(reason = 'Manual stop') {
    this.running = false;
    console.log(`\n⛔ Bot stopped: ${reason}`);
    this.printSessionSummary();
  }

  // ---- Main Loop ----

  async loop() {
    while (this.running) {
      try {
        // 1. Wait for new round data
        const roundData = await this.waitForRound();
        if (!roundData) continue;

        // 2. Update state
        this.state.updateFromRound(roundData);
        this.session.rounds++;

        console.log(`\n══════ ROUND ${this.state.round} ══════`);
        this.printRoundInfo();

        // 3. Check stop conditions
        if (this.shouldStop()) break;

        // 4. Auto-select strategy
        const evaluation = this.selector.selectBest(this.state);
        const decision = evaluation.strategy.execute(this.state);

        console.log(`\n🎯 Keputusan: [${decision.strategy}]`);
        console.log(`   Node    : ${decision.nodeName || decision.node}`);
        console.log(`   Bet     : ${decision.betAmount}`);
        console.log(`   Alasan  : ${decision.reason}`);
        console.log(`   Konfiden: ${decision.confidence}%`);

        // 5. Execute bet
        const betResult = await this.executeBet(decision);

        // 6. Record result
        const result = {
          round: this.state.round,
          strategy: evaluation.strategy.name,
          strategyId: evaluation.strategy.id,
          bet: decision.betAmount,
          profit: betResult.profit,
          node: decision.node,
        };
        this.state.recordResult(result);
        this.selector.recordOutcome(evaluation.strategy.id, betResult.profit);
        this.session.totalProfit += betResult.profit;

        // 7. Print result
        const profitStr = betResult.profit >= 0
          ? `+${betResult.profit}`
          : `${betResult.profit}`;
        console.log(`\n   Hasil   : ${profitStr} | Bankroll: ${this.state.bankroll}`);

        // 8. Delay
        await this.delay(CONFIG.roundDelay);

      } catch (err) {
        console.error(`❌ Error: ${err.message}`);
        await this.delay(5000);
      }
    }
  }

  // ---- Stop Conditions ----

  shouldStop() {
    // Consecutive loss limit
    if (this.state.consecutiveLoss >= CONFIG.maxConsecutiveLoss) {
      this.stop(`${CONFIG.maxConsecutiveLoss} consecutive losses`);
      return true;
    }

    // Bankroll depleted
    if (this.state.bankroll <= CONFIG.minBet) {
      this.stop('Bankroll depleted');
      return true;
    }

    // Profit target reached
    const profitRatio = this.session.totalProfit / CONFIG.bankroll;
    if (profitRatio >= CONFIG.profitTarget) {
      this.stop(`Profit target reached: ${(profitRatio * 100).toFixed(1)}%`);
      return true;
    }

    return false;
  }

  // ---- Round Data Interface ----

  /**
   * Tunggu dan parse data ronde baru dari MineBean.
   * Override method ini dengan implementasi aktual (WebSocket/polling/Telegram).
   */
  async waitForRound() {
    // PLACEHOLDER — implement actual data source
    // Contoh: poll Telegram bot, parse game message, atau WebSocket
    //
    // Expected return format:
    // {
    //   round: 42,
    //   nodes: [
    //     { id: 1, name: 'Gold Mine', pool: 5000, playerCount: 3, reward: 2.5, type: 'miner', side: 'miner' },
    //     { id: 2, name: 'Market', pool: 3000, playerCount: 7, reward: 1.2, type: 'consumer', side: 'consumer' },
    //   ],
    //   players: [
    //     { id: 'user1', role: 'miner' },
    //     { id: 'user2', role: 'consumer' },
    //   ],
    // }

    // Demo mode — generate mock data
    if (process.env.DEMO_MODE === '1') {
      await this.delay(1000);
      return this.generateMockRound();
    }

    // Real implementation: connect to Telegram / WebSocket
    return new Promise((resolve) => {
      if (this._roundCallback) {
        this._roundCallback = resolve;
      } else {
        this._roundCallback = resolve;
      }
    });
  }

  /**
   * Inject round data from external source (Telegram handler, etc.)
   */
  injectRoundData(data) {
    if (this._roundCallback) {
      const cb = this._roundCallback;
      this._roundCallback = null;
      cb(data);
    }
  }

  // ---- Bet Execution Interface ----

  /**
   * Execute bet. Override dengan implementasi aktual.
   */
  async executeBet(decision) {
    // PLACEHOLDER — implement actual bet execution
    // Contoh: kirim command ke MineBean Telegram bot
    //
    // Actual implementation:
    // await telegramBot.sendMessage(chatId, `/bet ${decision.node} ${decision.betAmount}`);
    // const result = await waitForBetResult();
    // return { profit: result.winnings - decision.betAmount };

    // Demo mode — simulate result
    if (process.env.DEMO_MODE === '1') {
      return this.simulateBetResult(decision);
    }

    return { profit: 0 };
  }

  // ---- Telegram Integration Hooks ----

  /**
   * Handle pesan masuk dari MineBean bot
   */
  handleMineBeanMessage(msg) {
    const text = msg.text || '';

    // Detect new round
    if (text.includes('Round') || text.includes('round') || text.includes('Ronde')) {
      const roundData = this.parseRoundMessage(text);
      if (roundData) {
        this.injectRoundData(roundData);
      }
    }

    // Detect result
    if (text.includes('Result') || text.includes('Win') || text.includes('Lose')) {
      this.parseResultMessage(text);
    }
  }

  /**
   * Parse pesan ronde dari MineBean (sesuaikan regex dengan format game)
   */
  parseRoundMessage(text) {
    try {
      // Contoh parsing — sesuaikan dengan format MineBean sesungguhnya
      const roundMatch = text.match(/[Rr]ound[:\s]*(\d+)/);
      const round = roundMatch ? parseInt(roundMatch[1]) : this.state.round + 1;

      // Parse nodes from message
      const nodes = [];
      const nodePattern = /(\w+)\s*[:\-]\s*Pool\s*(\d+)\s*\|\s*Players?\s*(\d+)/gi;
      let match;
      let nodeId = 1;
      while ((match = nodePattern.exec(text)) !== null) {
        nodes.push({
          id: nodeId++,
          name: match[1],
          pool: parseInt(match[2]),
          playerCount: parseInt(match[3]),
          reward: parseInt(match[2]) / parseInt(match[3]),
          type: match[1].toLowerCase().includes('semut') || match[1].toLowerCase().includes('mine') ? 'miner' : 'consumer',
          side: match[1].toLowerCase().includes('semut') || match[1].toLowerCase().includes('mine') ? 'miner' : 'consumer',
        });
      }

      // Parse players
      const players = [];
      const minerCount = (text.match(/[Ss]emut|[Mm]iner/g) || []).length;
      const consCount = (text.match(/[Kk]ons|[Cc]onsumer/g) || []).length;
      for (let i = 0; i < minerCount; i++) players.push({ id: `m${i}`, role: 'miner' });
      for (let i = 0; i < consCount; i++) players.push({ id: `c${i}`, role: 'consumer' });

      return { round, nodes, players };
    } catch (e) {
      console.error('Parse error:', e.message);
      return null;
    }
  }

  parseResultMessage(text) {
    // Override sesuai format MineBean
    const profitMatch = text.match(/([+-]?\d+)/);
    if (profitMatch) {
      const profit = parseInt(profitMatch[1]);
      // Auto-inject result — handled in main loop
    }
  }

  // ---- Utility ----

  printRoundInfo() {
    if (this.state.nodes.length > 0) {
      console.log('   Nodes:');
      this.state.nodes.forEach(n => {
        console.log(`     [${n.id}] ${(n.name || '').padEnd(15)} Pool: ${String(n.pool || 0).padStart(6)} | Players: ${n.playerCount || '?'} | EV: ${((n.pool || 0) / (n.playerCount || 1)).toFixed(0)}`);
      });
    }
    console.log(`   Pool Total: ${this.state.poolTotal} | Players: ${this.state.players.length}`);
  }

  printSessionSummary() {
    const duration = ((Date.now() - this.session.startTime) / 1000 / 60).toFixed(1);
    console.log('\n╔═══════════════════════════════════════════╗');
    console.log('║         SESSION SUMMARY                    ║');
    console.log('╠═══════════════════════════════════════════╣');
    console.log(`║  Duration   : ${duration} menit`);
    console.log(`║  Rounds     : ${this.session.rounds}`);
    console.log(`║  Profit     : ${this.session.totalProfit >= 0 ? '+' : ''}${this.session.totalProfit}`);
    console.log(`║  Win Rate   : ${(this.state.getWinRate() * 100).toFixed(1)}%`);
    console.log(`║  Bankroll   : ${CONFIG.bankroll} → ${this.state.bankroll}`);
    console.log('║');
    console.log('║  Strategy Performance:');
    this.selector.getStats().forEach(s => {
      console.log(`║    ${s.id.padEnd(18)} W:${s.winRate.padEnd(6)} Avg:${s.avgProfit.padStart(7)} Wt:${s.weight}`);
    });
    console.log('╚═══════════════════════════════════════════╝');
  }

  generateMockRound() {
    const round = this.state.round + 1;
    const nodeCount = 2 + Math.floor(Math.random() * 3);
    const nodes = [];
    const names = ['Gold Mine', 'Diamond Cave', 'Ruby Node', 'Emerald Pit', 'Market Hub'];
    const types = ['miner', 'miner', 'consumer', 'miner', 'consumer'];

    for (let i = 0; i < nodeCount; i++) {
      const pool = Math.floor(Math.random() * 8000) + 500;
      const playerCount = Math.floor(Math.random() * 8) + 1;
      nodes.push({
        id: i + 1,
        name: names[i] || `Node ${i + 1}`,
        pool,
        playerCount,
        reward: (pool / playerCount / 100).toFixed(1) * 1,
        multiplier: (1 + Math.random() * 4).toFixed(1) * 1,
        type: types[i] || 'miner',
        side: types[i] || 'miner',
      });
    }

    const players = [];
    nodes.forEach(n => {
      for (let p = 0; p < n.playerCount; p++) {
        players.push({ id: `p${n.id}_${p}`, role: n.type });
      }
    });

    return { round, nodes, players };
  }

  simulateBetResult(decision) {
    // Simple simulation: 55% win rate with variance
    const targetNode = this.state.nodes.find(n => n.id === decision.node);
    const winChance = targetNode
      ? Math.min(0.7, 0.3 + (decision.confidence / 200))
      : 0.4;

    const won = Math.random() < winChance;
    const multiplier = targetNode ? (targetNode.reward || targetNode.multiplier || 1.5) : 1.5;

    if (won) {
      return { profit: Math.round(decision.betAmount * (multiplier - 1)) };
    } else {
      return { profit: -decision.betAmount };
    }
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ===================== TELEGRAM COMMAND HANDLER =====================


/**
 * TELEGRAM COMMAND HANDLER
 * -------------------------
 * Handle commands dari user (opsional, karena bot sudah auto-pilot)
 */
class CommandHandler {
  constructor(bot) {
    this.bot = bot;
  }

  handle(command, args) {
    switch (command) {
      case '/start':
      case '/snipe':
        this.bot.start();
        return '🐝 Sniper started — Auto-pilot ON';

      case '/stop':
        this.bot.stop('User command');
        return '⛔ Sniper stopped';

      case '/stats':
        return this.getStatsMessage();

      case '/strategy':
        return this.getStrategyInfo();

      case '/setbank':
        if (args[0]) {
          CONFIG.bankroll = parseInt(args[0]);
          this.bot.state.bankroll = CONFIG.bankroll;
          return `💰 Bankroll set: ${CONFIG.bankroll}`;
        }
        return `💰 Current bankroll: ${this.bot.state.bankroll}`;

      case '/risk':
        if (args[0]) {
          CONFIG.riskPercent = parseFloat(args[0]);
          return `⚡ Risk set: ${CONFIG.riskPercent}%`;
        }
        return `⚡ Current risk: ${CONFIG.riskPercent}%`;

      case '/weight':
        if (args[0] && args[1]) {
          const stratId = args[0];
          const weight = parseFloat(args[1]);
          if (CONFIG.strategyWeights[stratId] !== undefined) {
            CONFIG.strategyWeights[stratId] = weight;
            return `⚖️ Weight ${stratId}: ${weight}`;
          }
        }
        return this.getWeightsMessage();

      case '/demo':
        process.env.DEMO_MODE = '1';
        this.bot.start();
        return '🎮 Demo mode started';

      default:
        return [
          '📋 Commands:',
          '/snipe   — Start auto-pilot',
          '/stop    — Stop bot',
          '/stats   — Show statistics',
          '/strategy — Strategy info',
          '/setbank [amount] — Set bankroll',
          '/risk [%] — Set risk percentage',
          '/weight [strategy] [value] — Adjust weight',
          '/demo    — Run demo mode',
        ].join('\n');
    }
  }

  getStatsMessage() {
    const s = this.bot.state;
    const stats = this.bot.selector.getStats();
    let msg = `📊 Session Stats\n`;
    msg += `Rounds: ${this.bot.session.rounds}\n`;
    msg += `Profit: ${this.bot.session.totalProfit >= 0 ? '+' : ''}${this.bot.session.totalProfit}\n`;
    msg += `Win Rate: ${(s.getWinRate() * 100).toFixed(1)}%\n`;
    msg += `Bankroll: ${s.bankroll}\n\n`;
    msg += `📈 Strategy Performance:\n`;
    stats.forEach(st => {
      msg += `  ${st.id}: WR ${st.winRate} | Avg ${st.avgProfit}\n`;
    });
    return msg;
  }

  getStrategyInfo() {
    return [
      '🧠 Strategies (Auto-Selected):',
      '',
      '1️⃣ Heavy Node — All-in ke node reward terbesar',
      '2️⃣ Semut vs Kons — Bet di sisi minoritas',
      '3️⃣ Kuasai Semut Micro — Micro-bet dominasi bertahap',
      '4️⃣ Pool % — Bet di node EV tertinggi',
      '',
      '⚙️ Bot otomatis pilih strategi terbaik tiap ronde.',
      '   Tidak perlu /setmax — semua auto!',
    ].join('\n');
  }

  getWeightsMessage() {
    let msg = '⚖️ Strategy Weights:\n';
    Object.entries(CONFIG.strategyWeights).forEach(([k, v]) => {
      msg += `  ${k}: ${v.toFixed(2)}\n`;
    });
    msg += '\nUse /weight [strategy] [value] to adjust';
    return msg;
  }
}

// ===================== EXPORTS & ENTRY POINT =====================

// Export for use as module
module.exports = {
  SniperBot,
  AutoStrategySelector,
  HeavyNodeStrategy,
  SemutVsKonsStrategy,
  KuasaiSemutMicroStrategy,
  PoolPercentStrategy,
  GameState,
  CommandHandler,
  CONFIG,
};

// Entry point — run if executed directly
if (require.main === module) {
  const bot = new SniperBot();
  const cmd = new CommandHandler(bot);

  // Check for demo mode
  if (process.argv.includes('--demo')) {
    process.env.DEMO_MODE = '1';
    console.log('🎮 Running in DEMO mode...\n');
    bot.start();
  } else if (CONFIG.botToken && CONFIG.botToken !== 'YOUR_BOT_TOKEN') {
    // ===== TELEGRAM MODE — Auto-connect dari .env =====
    let Telegraf;
    try {
      Telegraf = require('telegraf').Telegraf;
    } catch (e) {
      console.error('❌ Package "telegraf" belum di-install.');
      console.log('   Jalankan: npm install telegraf');
      console.log('   Atau test dengan: node sniper.js --demo');
      process.exit(1);
    }

    const tgBot = new Telegraf(CONFIG.botToken);
    console.log('🤖 Telegram bot connecting...');
    console.log(`   Token: ${CONFIG.botToken.slice(0, 8)}...`);
    console.log(`   Chat ID: ${CONFIG.chatId || 'auto-detect'}\n`);

    // Handle pesan dari MineBean bot
    tgBot.on('text', (ctx) => {
      const msg = ctx.message;
      const fromBot = msg.from && msg.from.is_bot;
      const text = msg.text || '';

      // Pesan dari MineBean game bot
      if (fromBot || text.includes('Round') || text.includes('round') || text.includes('Pool')) {
        bot.handleMineBeanMessage(msg);
      }

      // Command dari user
      if (text.startsWith('/')) {
        const [command, ...args] = text.split(' ');
        const reply = cmd.handle(command, args);
        if (reply) ctx.reply(reply);
      }
    });

    // Auto-start snipe
    tgBot.launch().then(() => {
      console.log('✅ Telegram bot LIVE — listening for MineBean rounds...');
      console.log('   Ketik /snipe di chat untuk mulai auto-pilot');
      console.log('   Ketik /stats untuk lihat statistik\n');
    }).catch(err => {
      console.error('❌ Gagal connect Telegram:', err.message);
      console.log('   Cek BOT_TOKEN di file .env kamu');
    });

    // Graceful stop
    process.once('SIGINT', () => { tgBot.stop('SIGINT'); bot.stop('SIGINT'); });
    process.once('SIGTERM', () => { tgBot.stop('SIGTERM'); bot.stop('SIGTERM'); });

  } else {
    // No token — show help
    console.log(cmd.handle('/help'));
    console.log('\n⚠️  BOT_TOKEN belum di-set di .env');
    console.log('   Buat file .env dengan isi:');
    console.log('   BOT_TOKEN=token_bot_telegram_kamu');
    console.log('   CHAT_ID=chat_id_kamu');
    console.log('\n   Atau test dengan: node sniper.js --demo\n');
  }
}
