require('dotenv').config();
const { ethers } = require('ethers');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const RPC_URL = process.env.BASE_RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
for (const [k, v] of Object.entries({ BASE_RPC_URL: RPC_URL, PRIVATE_KEY, TG_BOT_TOKEN, TG_CHAT_ID })) { if (!v) throw new Error(`Env: ${k}`); }
const bot = new TelegramBot(TG_BOT_TOKEN, { polling: true });
let MY_ADDRESS = '0x70114f99F5B5F8068a9f4fDD01f9350CE866a709';
let DEFAULT_BET_PER_BLOCK = ethers.parseEther('0.0000029');
let HARD_MAX_SAFETY = ethers.parseEther('0.0000099');
let GATEKEEPER_THRESHOLD = 0.034;
let MIN_PROFIT_THRESHOLD = -0.15;
let MIN_BEANPOT_THRESHOLD = 0;
const ENABLE_BOBOT_ENGINE = true;
let ENABLE_SATELIT = true;
const THRESHOLDS_SATELIT = { SEMUT_ATAS: 0.000010, MARATHON_ATAS: 0.000099 };
let isSatelitRunning = false;
let ENABLE_AUTO_STRATEGY = true;
const STRATEGY_WEIGHTS = { heavyNode: 1.0, semutVsKons: 1.0, microDominasi: 1.0, poolPercent: 1.0 };
let strategyPerformance = { heavyNode: { wins:0, losses:0, totalProfit:0, timesSelected:0 }, semutVsKons: { wins:0, losses:0, totalProfit:0, timesSelected:0 }, microDominasi: { wins:0, losses:0, totalProfit:0, timesSelected:0 }, poolPercent: { wins:0, losses:0, totalProfit:0, timesSelected:0 } };
let lastChosenStrategy = 'heavyNode';
let ENABLE_ANTI_LOSS = true, MAX_LOSS_STREAK = 4, COOLDOWN_ROUNDS = 2, LOSS_USD_TRIGGER = -0.01, MIN_EV_BUFFER_USD = 0.02;
let lossStreak = 0, winStreak = 0, cooldownUntilRound = 0, lastDeployMeta = null;
const LOG_FILE = './minebean_round_log.csv';
let lastBobotReport = null;
const BASE_EXECUTION_TIME = 8, EXPECTED_LATE_WHALES = 0.00;
const AUTO_CLAIM_ETH = ethers.parseEther('0.0025'), AUTO_CLAIM_BEAN = ethers.parseEther('0.25');
let AUTO_SWAP_THRESHOLD = ethers.parseEther('0.39');
const ADMIN_FEE_BPS = 0.01, VAULT_FEE_BPS = 0.10, ROASTING_FEE_BPS = 0.10, BEAN_PER_ROUND = 1.0, BEANPOT_ODDS = 1/777;
const MAX_CONSECUTIVE_ERRORS = 5; let consecutiveRpcErrors = 0, rpcAlertSent = false;
const GRIDMINING_ADDR = '0x9632495bDb93FD6B0740Ab69cc6c71C9c01da4f0';
const BEAN_TOKEN_ADDR = '0x5c72992b83E74c4D5200A8E8920fB946214a5A5D';
const MINEBEAN_API = 'https://api.minebean.com';
const ABI = ['function deploy(uint8[] calldata blockIds) external payable','function claimETH() external','function claimBEAN() external','function getCurrentRoundInfo() external view returns (uint64 roundId, uint256 startTime, uint256 endTime, uint256 totalDeployed, uint256 timeRemaining, bool isActive)','function getTotalPendingRewards(address) external view returns (uint256 pendingETH, uint256 unforgedBEAN, uint256 forgedBEAN, uint64 uncheckpointedRound)','function beanpotPool() external view returns (uint256)'];
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)','function approve(address, uint256) returns (bool)','function allowance(address, address) view returns (uint256)'];
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const grid = new ethers.Contract(GRIDMINING_ADDR, ABI, wallet);
const beanToken = new ethers.Contract(BEAN_TOKEN_ADDR, ERC20_ABI, wallet);
MY_ADDRESS = wallet.address.toLowerCase();
let lastR = 0, preDeployB = 0n, preDeployETH = 0n, lastRoundBet = 0n;
let played = false, deploying = false, isProcessing = false, isSwapping = false;
let currentBeanPriceUsd = 0, currentEthPriceUsd = 0, currentBeanpotBean = 0, currentLatency = 300;
let roundCounter = 0, sumBean = 0n, sumEthChange = 0n, sumUsdProfit = 0, pendingSwapAmount = 0n;
let nextRoundStrategy = { mode:'NORMAL', recommendedBet:0n, shouldDeploy:true, source:'DEFAULT', reason:'Base', strategyId:'heavyNode' };
let deployMode = "random", prevWinningBlock = -1;


// === 4-STRATEGY EVALUATORS ===
function evaluateSemutVsKons(miners, totalDeployEth) {
  if (!miners || miners.length < 2) return { score:0, bet:0n, reason:'Data kurang' };
  const th = 0.000015; let sC=0, kC=0, sT=0, kT=0;
  for (const m of miners) { const d=parseFloat(m.deploy||0); if(d<=0)continue; if(d<=th){sC++;sT+=d;}else{kC++;kT+=d;} }
  const total=sC+kC; if(!total) return {score:0,bet:0n,reason:'Kosong'};
  const imb = Math.abs((sC/(kC||1))-1);
  let score=0; if(imb>=2)score=90; else if(imb>=1.5)score=75; else if(imb>=1)score=55; else if(imb>=0.5)score=35; else score=10;
  const side = sC<=kC?'semut':'kons';
  const avg = side==='semut'?(sC>0?sT/sC:0):(kC>0?kT/kC:0);
  let bet = ethers.parseEther(Math.max(avg*1.15, 0.0000029).toFixed(9));
  if(bet>HARD_MAX_SAFETY) bet=HARD_MAX_SAFETY;
  return { score, bet, reason:`${side} minoritas (${sC} vs ${kC}) +15%` };
}
function evaluateMicroDominasi(miners, totalDeployEth) {
  let score=0;
  if(lossStreak>=3) score+=30; else if(lossStreak>=2) score+=20; else if(lossStreak>=1) score+=10;
  if(totalDeployEth<0.005) score+=25; else if(totalDeployEth<0.01) score+=15; else if(totalDeployEth<0.02) score+=5;
  const pc = miners?miners.length:0; if(pc<=3) score+=20; else if(pc<=5) score+=10;
  score+=10;
  const mb = (DEFAULT_BET_PER_BLOCK*60n)/100n;
  const bet = mb<ethers.parseEther('0.0000029')?ethers.parseEther('0.0000029'):mb;
  return { score:Math.min(score,100), bet, reason:`Micro (loss:${lossStreak}, board:${totalDeployEth.toFixed(6)}, plyr:${pc})` };
}
function evaluatePoolPercent(miners, totalDeployEth, nominalNodes) {
  if(!nominalNodes||!Object.keys(nominalNodes).length) return {score:0,bet:0n,reason:'No data'};
  const evs=[]; for(const k in nominalNodes){const n=nominalNodes[k]; evs.push({...n,ev:parseFloat(ethers.formatEther(n.totalWei))/(n.count||1),betKey:k});}
  if(!evs.length) return {score:0,bet:0n,reason:'No EVs'};
  evs.sort((a,b)=>b.ev-a.ev); const best=evs[0]; const avg=evs.reduce((s,n)=>s+n.ev,0)/evs.length;
  const gap=best.ev/(avg||0.0001); let score=0;
  if(gap>=3)score=95; else if(gap>=2.5)score=80; else if(gap>=2)score=65; else if(gap>=1.5)score=45; else score=20;
  if(totalDeployEth>0.02) score+=10; else if(totalDeployEth>0.005) score+=5;
  let bet=(best.betWei*110n)/100n; if(bet<DEFAULT_BET_PER_BLOCK)bet=DEFAULT_BET_PER_BLOCK; if(bet>HARD_MAX_SAFETY)bet=HARD_MAX_SAFETY;
  return { score:Math.min(score,100), bet, reason:`Pool% best: ${best.betKey} (${best.count}wlt, gap:${gap.toFixed(1)}x)` };
}
function autoSelectStrategy(heavyDec, miners, totalDeploy, nominalNodes) {
  if(!ENABLE_AUTO_STRATEGY) return {chosen:'heavyNode',bet:heavyDec.recommendedBet,reason:heavyDec.reason,mode:heavyDec.mode};
  const hScore=heavyDec.shouldDeploy?70:10;
  const svk=evaluateSemutVsKons(miners,totalDeploy);
  const mic=evaluateMicroDominasi(miners,totalDeploy);
  const pool=evaluatePoolPercent(miners,totalDeploy,nominalNodes);
  function pb(id){const p=strategyPerformance[id];if(!p||!p.timesSelected)return 5;return(p.wins/p.timesSelected)*15+(p.totalProfit>0?Math.min(p.totalProfit/p.timesSelected*100,10):Math.max(p.totalProfit/p.timesSelected*50,-5));}
  const c=[{id:'heavyNode',score:hScore+pb('heavyNode'),bet:heavyDec.recommendedBet,reason:heavyDec.reason,w:STRATEGY_WEIGHTS.heavyNode},{id:'semutVsKons',score:svk.score+pb('semutVsKons'),bet:svk.bet,reason:svk.reason,w:STRATEGY_WEIGHTS.semutVsKons},{id:'microDominasi',score:mic.score+pb('microDominasi'),bet:mic.bet,reason:mic.reason,w:STRATEGY_WEIGHTS.microDominasi},{id:'poolPercent',score:pool.score+pb('poolPercent'),bet:pool.bet,reason:pool.reason,w:STRATEGY_WEIGHTS.poolPercent}];
  c.forEach(x=>{x.fs=Math.min(x.score*x.w,100);}); c.sort((a,b)=>b.fs-a.fs);
  const win=c[0]; lastChosenStrategy=win.id;
  console.log(`\n🧠 AUTO-STRAT: ${c.map((x,i)=>`${i===0?'★':' '}${x.id}:${x.fs.toFixed(0)}`).join(' | ')}`);
  return {chosen:win.id,bet:win.bet,reason:win.reason,mode:win.id==='heavyNode'?'HEAVY_NODE':win.id==='semutVsKons'?'SEMUT_VS_KONS':win.id==='microDominasi'?'MICRO_DOMINASI':'POOL_PERCENT'};
}
function recordStrategyOutcome(id, profitUsd) {
  const p=strategyPerformance[id]; if(!p)return; p.timesSelected++; p.totalProfit+=profitUsd;
  if(profitUsd>0)p.wins++; else p.losses++;
  const adj=profitUsd>0?0.05:-0.03; STRATEGY_WEIGHTS[id]=Math.max(0.3,Math.min(2.0,(STRATEGY_WEIGHTS[id]||1)+adj));
}
// === TELEGRAM ===
async function tg(msg){try{await bot.sendMessage(TG_CHAT_ID,msg,{parse_mode:'Markdown'});}catch(e){}}
const isOwner=(msg)=>msg.chat.id.toString()===TG_CHAT_ID;
bot.onText(/\/setev (.+)/,(msg,m)=>{if(!isOwner(msg))return;const v=parseFloat(m[1]);if(!isNaN(v)){MIN_PROFIT_THRESHOLD=v;tg(`✅ EV=$${v}`);}});
bot.onText(/\/setboard (.+)/,(msg,m)=>{if(!isOwner(msg))return;const v=parseFloat(m[1]);if(!isNaN(v)){GATEKEEPER_THRESHOLD=v;tg(`✅ Board=${v}`);}});
bot.onText(/\/setbet (.+)/,(msg,m)=>{if(!isOwner(msg))return;try{DEFAULT_BET_PER_BLOCK=ethers.parseEther(m[1].split(' ')[0]);tg(`✅ Bet=${m[1].split(' ')[0]}`);}catch(e){tg('❌');}});
bot.onText(/\/setmax (.+)/,(msg,m)=>{if(!isOwner(msg))return;try{HARD_MAX_SAFETY=ethers.parseEther(m[1].trim());tg(`✅ Max=${m[1].trim()}`);}catch(e){tg('❌');}});
bot.onText(/\/setswap (.+)/,(msg,m)=>{if(!isOwner(msg))return;try{AUTO_SWAP_THRESHOLD=ethers.parseEther(m[1].trim());tg(`✅ Swap=${m[1].trim()}`);}catch(e){tg('❌');}});
bot.onText(/\/setpot (.+)/,(msg,m)=>{if(!isOwner(msg))return;const v=parseFloat(m[1]);if(!isNaN(v)){MIN_BEANPOT_THRESHOLD=v;tg(`✅ Pot=${v}`);}});
bot.onText(/\/setsatelit (on|off)/,(msg,m)=>{if(!isOwner(msg))return;ENABLE_SATELIT=m[1]==='on';tg(`✅ Satelit=${ENABLE_SATELIT?'ON':'OFF'}`);});
bot.onText(/\/autostrat (on|off)/,(msg,m)=>{if(!isOwner(msg))return;ENABLE_AUTO_STRATEGY=m[1]==='on';tg(`✅ AutoStrat=${ENABLE_AUTO_STRATEGY?'ON':'OFF'}`);});
bot.onText(/\/mode (.+)/,(msg,m)=>{if(!isOwner(msg))return;const v=m[1].trim().toLowerCase();if(['all','skip','random'].includes(v)){deployMode=v;tg(`✅ Mode=${v}`);}else tg('❌ all/skip/random');});
bot.onText(/\/antiloss (on|off)/,(msg,m)=>{if(!isOwner(msg))return;ENABLE_ANTI_LOSS=m[1]==='on';tg(`✅ AntiLoss=${ENABLE_ANTI_LOSS?'ON':'OFF'}`);});
bot.onText(/\/setloss (.+)/,(msg,m)=>{if(!isOwner(msg))return;const v=parseInt(m[1]);if(v>=1){MAX_LOSS_STREAK=v;tg(`✅ MaxLoss=${v}`);}});
bot.onText(/\/setcooldown (.+)/,(msg,m)=>{if(!isOwner(msg))return;const v=parseInt(m[1]);if(v>=0){COOLDOWN_ROUNDS=v;tg(`✅ CD=${v}`);}});
bot.onText(/\/stop/,async(msg)=>{if(!isOwner(msg))return;await tg('🛑 *STOP*');process.exit(0);});
bot.onText(/\/strategy/,async(msg)=>{if(!isOwner(msg))return;let l=['🧠 *4-STRATEGY* '+(ENABLE_AUTO_STRATEGY?'ON':'OFF'),'Last: '+lastChosenStrategy,''];for(const[id,p]of Object.entries(strategyPerformance)){const wr=p.timesSelected?(p.wins/p.timesSelected*100).toFixed(0)+'%':'N/A';l.push(`${id}: WR ${wr} | W:${(STRATEGY_WEIGHTS[id]||1).toFixed(2)}`);}await tg(l.join('\n'));});
bot.onText(/\/bobot/,async(msg)=>{if(!isOwner(msg))return;try{const info=await grid.getCurrentRoundInfo();const d=await buildBobotDecision(Number(info.roundId)-1,{notify:false});await tg(`🧠 *R#${d.roundId}* [${d.strategyId}]\n${d.rows.length} lawan | Heavy: ${ethers.formatEther(d.heaviestNodeWei)}\n💸 Bet: ${ethers.formatEther(d.recommendedBet)}\n🧾 ${d.reason}`);}catch(e){await tg(`❌ ${e.message}`);}});
bot.onText(/\/status/,(msg)=>{if(!isOwner(msg))return;const rb=nextRoundStrategy.recommendedBet>0n?ethers.formatEther(nextRoundStrategy.recommendedBet):'0';tg(['📊 *v15.0 STATUS*','',`Wallet: \`${wallet.address}\``,`Mode: ${deployMode} | AutoStrat: ${ENABLE_AUTO_STRATEGY?'ON':'OFF'}`,`Strategy: ${lastChosenStrategy}`,`Bet: base=${ethers.formatEther(DEFAULT_BET_PER_BLOCK)} cap=${ethers.formatEther(HARD_MAX_SAFETY)} deploy=${rb}`,`Board: ${GATEKEEPER_THRESHOLD} | EV: $${MIN_PROFIT_THRESHOLD} | Pot: ${MIN_BEANPOT_THRESHOLD}`,`Loss: ${lossStreak}/${MAX_LOSS_STREAK} | Win: ${winStreak}`,`Satelit: ${ENABLE_SATELIT?'ON':'OFF'} | Latency: ${currentLatency}ms`,`BEAN: $${currentBeanPriceUsd.toFixed(5)} | ETH: $${currentEthPriceUsd.toFixed(2)} | Beanpot: ${currentBeanpotBean.toFixed(2)}`].join('\n'));});
bot.onText(/\/balance/,async(msg)=>{if(!isOwner(msg))return;try{await updatePrices();const[eb,bb]=await Promise.all([provider.getBalance(wallet.address),beanToken.balanceOf(wallet.address)]);const e=Number(ethers.formatEther(eb)),b=Number(ethers.formatEther(bb));await tg(`💰 ETH:${e.toFixed(6)} BEAN:${b.toFixed(4)} Total:$${((e*currentEthPriceUsd)+(b*currentBeanPriceUsd)).toFixed(2)}`);}catch(e){tg(`❌ ${e.message}`);}});
// === CORE UTILS ===
async function measureLatency(){const s=Date.now();try{await provider.getBlockNumber();currentLatency=Date.now()-s;}catch(e){currentLatency=1000;}}
setInterval(measureLatency,60000);
async function updatePrices(){try{const r=await axios.get(`${MINEBEAN_API}/api/price`,{timeout:5000});if(r.data?.bean?.priceUsd){currentBeanPriceUsd=parseFloat(r.data.bean.priceUsd);const pn=parseFloat(r.data.bean.priceNative);if(pn>0)currentEthPriceUsd=currentBeanPriceUsd/pn;}}catch(e){}}
setInterval(updatePrices,30000);
async function updateBeanpot(){try{currentBeanpotBean=parseFloat(ethers.formatEther(await grid.beanpotPool()));}catch(e){}}
setInterval(updateBeanpot,15000);
async function getAdaptiveFee({boardEth=0,gasLimit=750000n,purpose='deploy'}={}){const fee=await provider.getFeeData();const lb=await provider.getBlock('latest').catch(()=>null);const bf=lb?.baseFeePerGas||fee.gasPrice||ethers.parseUnits('0.10','gwei');let mg='0.0048';if(purpose!=='swap'){if(boardEth>=GATEKEEPER_THRESHOLD*0.75)mg=currentLatency>700?'0.012':'0.009';else if(boardEth>=GATEKEEPER_THRESHOLD*0.45||currentLatency>700)mg='0.0075';else mg='0.0055';}const mp=ethers.parseUnits(mg,'gwei');let pf=fee.maxPriorityFeePerGas||fee.gasPrice||mp;if(pf<mp)pf=mp;const cap=purpose==='swap'?ethers.parseUnits('0.008','gwei'):ethers.parseUnits('0.010','gwei');if(pf>cap)pf=cap;let mf=(bf*2n)+pf;const rm=fee.maxFeePerGas||0n;if(rm>0n&&rm>=mf&&rm<(mf*12n/10n))mf=rm;return{maxFeePerGas:mf,maxPriorityFeePerGas:pf,gasUsd:parseFloat(ethers.formatEther(gasLimit*mf))*currentEthPriceUsd};}
async function swapBeanToEth(amount){try{const r=await axios.get('https://aggregator-api.kyberswap.com/base/api/v1/routes',{params:{tokenIn:BEAN_TOKEN_ADDR,tokenOut:'0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',amountIn:amount.toString()},timeout:10000});const rs=r.data?.data?.routeSummary;if(!rs)throw new Error('No route');const br=await axios.post('https://aggregator-api.kyberswap.com/base/api/v1/route/build',{routeSummary:rs,sender:wallet.address,recipient:wallet.address,slippageTolerance:100},{timeout:10000});const td=br.data?.data;const al=await beanToken.allowance(wallet.address,td.routerAddress);if(al<amount){const ta=await beanToken.approve(td.routerAddress,ethers.MaxUint256);await ta.wait();}const sg=await getAdaptiveFee({purpose:'swap',gasLimit:900000n});const tx=await wallet.sendTransaction({to:td.routerAddress,data:td.data,value:td.value||0n,gasLimit:900000,maxFeePerGas:sg.maxFeePerGas,maxPriorityFeePerGas:sg.maxPriorityFeePerGas});await tx.wait();await tg(`🔄 *SWAP* ${ethers.formatEther(amount)} BEAN➡️ETH`);}catch(e){pendingSwapAmount=amount;throw e;}}
function ensureLogHeader(){if(!fs.existsSync(LOG_FILE))fs.writeFileSync(LOG_FILE,'time,round,strategy,mode,bet,total,board,pot,ev,gas,profit,bean,eth,loss,win,reason\n');}
function appendRoundLog(r){try{ensureLogHeader();fs.appendFileSync(LOG_FILE,[new Date().toISOString(),r.rid,r.strat,r.mode,r.bet,r.total,r.board,r.pot,r.ev,r.gas,r.profit,r.bean,r.eth,lossStreak,winStreak,`"${r.reason||''}"`].join(',')+'\n');}catch(e){}}
function applyRisk(rid,p){if(!ENABLE_ANTI_LOSS)return;if(p<=LOSS_USD_TRIGGER){lossStreak++;winStreak=0;}else if(p>0){winStreak++;lossStreak=0;}if(lossStreak>=MAX_LOSS_STREAK)cooldownUntilRound=Number(rid)+COOLDOWN_ROUNDS;}
async function checkReward(rId){try{const r=await grid.getTotalPendingRewards(wallet.address);const tb=r[1]+r[2];const dB=tb>=preDeployB?tb-preDeployB:0n;const ne=(r[0]-preDeployETH)-lastRoundBet;const p=parseFloat(ethers.formatEther(dB))*currentBeanPriceUsd+parseFloat(ethers.formatEther(ne))*currentEthPriceUsd;recordStrategyOutcome(lastChosenStrategy,p);applyRisk(rId-1,p);appendRoundLog({rid:rId-1,strat:lastChosenStrategy,mode:lastDeployMeta?.mode||'',bet:lastDeployMeta?.betPerBlockEth||'',total:ethers.formatEther(lastRoundBet),board:lastDeployMeta?.boardEth||'',pot:lastDeployMeta?.beanpotBean||'',ev:lastDeployMeta?.evUsd||'',gas:lastDeployMeta?.gasUsd||'',profit:p.toFixed(6),bean:ethers.formatEther(dB),eth:ethers.formatEther(ne),reason:lastDeployMeta?.reason||''});sumBean+=dB;sumEthChange+=ne;sumUsdProfit+=p;roundCounter++;await tg(`🎯 *R#${rId-1}* [${lastChosenStrategy}]\n💸 $${p.toFixed(4)} | BEAN:${ethers.formatEther(dB)} | ETH:${ethers.formatEther(ne)}`);if(roundCounter>=10){await tg(`📊 *10R* $${sumUsdProfit.toFixed(4)}`);roundCounter=0;sumBean=0n;sumEthChange=0n;sumUsdProfit=0;}if(r[0]>=AUTO_CLAIM_ETH){try{await(await grid.claimETH()).wait();await tg(`💸 Claim ETH ${ethers.formatEther(r[0])}`);}catch(e){}}if(tb>=AUTO_CLAIM_BEAN){try{await(await grid.claimBEAN()).wait();await tg(`🫘 Claim BEAN ${ethers.formatEther(tb)}`);}catch(e){}}const mb=await beanToken.balanceOf(wallet.address);if(mb>=AUTO_SWAP_THRESHOLD&&!isSwapping&&pendingSwapAmount===0n)pendingSwapAmount=mb;}catch(e){}}


// === RADAR + 4-STRAT ===
function parseDeployWei(v){if(v==null)return 0n;const s=String(v);if(s.includes('.')){try{return ethers.parseEther(s);}catch(_){return 0n;}}try{return BigInt(s);}catch(_){}try{return ethers.parseEther(String(Number(s)||0));}catch(_){return 0n;}}
async function buildBobotDecision(roundId,{notify=false}={}){
  const res=await axios.get(`${MINEBEAN_API}/api/round/${roundId}/miners`,{timeout:7000});
  if(res.data?.winningBlock!=null)prevWinningBlock=Number(res.data.winningBlock);
  let miners=res.data?.miners||res.data?.data?.miners||res.data?.data||res.data;
  if(!Array.isArray(miners)&&miners&&typeof miners==='object')miners=Object.values(miners);
  if(!Array.isArray(miners)||!miners.length)throw new Error('Data kosong');
  let totalDeploy=0,totalDeployWei=0n,selfDeploy=0,selfCount=0;const nominalNodes={};const rows=[];
  for(const m of miners){let ra=m.address||m.walletAddress||m.deployer||m.user||m.miner||m.wallet||m.account;if(typeof ra==='object'&&ra!==null)ra=ra.address||ra.wallet||ra.id;const addr=String(ra||'?').toLowerCase();const dw=parseDeployWei(m.deployedFormatted??m.deployed??0);const d=parseFloat(ethers.formatEther(dw));if(d<=0)continue;if(addr===MY_ADDRESS){selfDeploy+=d;selfCount++;continue;}totalDeploy+=d;totalDeployWei+=dw;const bk=d.toFixed(6);if(!nominalNodes[bk])nominalNodes[bk]={betWei:dw,betEth:d,totalWei:0n,count:0};nominalNodes[bk].totalWei+=dw;nominalNodes[bk].count++;rows.push({addr,deploy:d,deployWei:dw});}
  let heaviestNodeWei=0n,maxWeightWei=0n,heaviestCount=0;
  for(const k in nominalNodes){if(nominalNodes[k].totalWei>maxWeightWei){maxWeightWei=nominalNodes[k].totalWei;heaviestNodeWei=nominalNodes[k].betWei;heaviestCount=nominalNodes[k].count;}}
  let recBet=(heaviestNodeWei*110n)/100n;if(recBet<DEFAULT_BET_PER_BLOCK)recBet=DEFAULT_BET_PER_BLOCK;let capped=false;if(recBet>HARD_MAX_SAFETY){recBet=HARD_MAX_SAFETY;capped=true;}
  const heavyDec={roundId,mode:'HEAVY_NODE',shouldDeploy:true,recommendedBet:recBet,reason:`Heavy:${ethers.formatEther(heaviestNodeWei)}(${heaviestCount}wlt)+10%`,source:'RADAR',capped,totalDeploy,selfDeploy,selfCount,rows,heaviestNodeWei,maxWeightWei,heaviestCount,nominalNodes};
  const auto=autoSelectStrategy(heavyDec,rows,totalDeploy,nominalNodes);
  const final={...heavyDec,mode:auto.mode,recommendedBet:auto.bet,reason:`[${auto.chosen}] ${auto.reason}`,source:'AUTO_4STRAT',strategyId:auto.chosen};
  lastBobotReport=final;if(notify)await tg(`🧠 *R#${roundId}* [${final.strategyId}] Bet:${ethers.formatEther(final.recommendedBet)} | ${final.reason}`);
  return final;
}
async function updateStrategyFromPreviousRound(roundId){try{await new Promise(r=>setTimeout(r,2500));if(!ENABLE_BOBOT_ENGINE){nextRoundStrategy={mode:'NORMAL',recommendedBet:DEFAULT_BET_PER_BLOCK,shouldDeploy:true,source:'DEFAULT',reason:'Off',strategyId:'heavyNode'};return;}const d=await buildBobotDecision(roundId,{notify:false});nextRoundStrategy={mode:d.mode,recommendedBet:d.recommendedBet,shouldDeploy:d.shouldDeploy,source:d.source,reason:d.reason,strategyId:d.strategyId};console.log(`🧠 R#${roundId}: [${d.strategyId}] ${d.mode} bet=${ethers.formatEther(d.recommendedBet)}`);}catch(e){console.error('Radar:',e.message);nextRoundStrategy={mode:'NORMAL',recommendedBet:DEFAULT_BET_PER_BLOCK,shouldDeploy:true,source:'FALLBACK',reason:e.message,strategyId:'heavyNode'};}}
// === SATELIT ===
async function runSatelitEngine(){if(!ENABLE_SATELIT||isSatelitRunning)return;isSatelitRunning=true;try{const rr=await axios.get(`${MINEBEAN_API}/api/rounds?page=1&limit=50&settled=true`);const rl=rr.data?.rounds||rr.data?.data||[];if(!rl.length){isSatelitRunning=false;return;}const lb={};for(let i=0;i<rl.length;i++){const rId=rl[i].roundId||rl[i].id;try{const dr=await axios.get(`${MINEBEAN_API}/api/round/${rId}/miners`,{timeout:5000});let ms=dr.data?.data||dr.data?.miners||dr.data;if(!Array.isArray(ms)&&typeof ms==='object')ms=Object.values(ms);if(!ms||!ms.length)continue;let w=ms.find(m=>m.beanReward&&parseFloat(m.beanReward)>=0.9);if(w){const wd=parseFloat(w.deployedFormatted||w.deployed);if(wd>0){const a=(w.address||w.wallet||w.user||'?').toLowerCase();if(!lb[a])lb[a]={menang:0,tot:0};lb[a].menang++;lb[a].tot+=wd;}}}catch(e){}await new Promise(r=>setTimeout(r,200));}const tp=Object.keys(lb).map(k=>({addr:k,menang:lb[k].menang,avg:lb[k].tot/lb[k].menang})).sort((a,b)=>b.menang-a.menang);let tl=tp.find(p=>p.addr!==MY_ADDRESS&&p.avg<THRESHOLDS_SATELIT.SEMUT_ATAS);if(tl){let th=tl.avg*1.10;if(th>0.000150)th=0.000120;HARD_MAX_SAFETY=ethers.parseEther(th.toFixed(6));await tg(`🛰️ *SATELIT* Target:${tl.addr.slice(0,6)}... SetMax:${th.toFixed(6)}`);};}catch(e){}finally{isSatelitRunning=false;}}
// === EV ===
function computeEv({myBetEth,betPerBlockEth,blockCount=25,boardEth,beanpotBean,gasUsd}){const st=boardEth+EXPECTED_LATE_WHALES+myBetEth;if(!st||st<=0)return{totalEvUsd:-gasUsd};const bc=Math.max(1,Math.min(25,blockCount));const bcp=bc/25;const oab=(boardEth+EXPECTED_LATE_WHALES)/25;const mws=betPerBlockEth/(oab+betPerBlockEth);const ots=myBetEth/st;const nb=BEAN_PER_ROUND*ots*(1-ROASTING_FEE_BPS);const bpe=BEANPOT_ODDS*beanpotBean*ots*(1-ROASTING_FEE_BPS);const bu=(nb+bpe)*currentBeanPriceUsd;const af=st*ADMIN_FEE_BPS;const lp=Math.max(0,st-(st/25));const vf=Math.max(0,(lp-(lp*ADMIN_FEE_BPS))*VAULT_FEE_BPS);const cp=Math.max(0,st-af-vf);const er=bcp*cp*mws;const ep=er-myBetEth;const eu=ep*currentEthPriceUsd;return{totalEvUsd:bu+eu-gasUsd-Math.abs(eu)*0.05};}
// === MAIN LOOP ===
async function main(){
  console.log('🚀 MINEBEAN SNIPER v15.0 (4-STRATEGY AUTO-SELECT)');
  await updatePrices();await updateBeanpot();measureLatency();ensureLogHeader();
  await tg('🤖 *v15.0* ON! 4-Strategy Auto tanpa /setmax manual.');
  runSatelitEngine();setInterval(runSatelitEngine,600000);
  setInterval(async()=>{try{const info=await grid.getCurrentRoundInfo();consecutiveRpcErrors=0;rpcAlertSent=false;if(!info.isActive)return;const rid=Number(info.roundId);const tl=Number(info.timeRemaining);
  if(tl>50&&tl<58&&rid>lastR&&!isProcessing){isProcessing=true;try{if(played&&lastR>0)await checkReward(rid);await updateStrategyFromPreviousRound(rid-1);}finally{played=false;lastR=rid;isProcessing=false;}}
  if(pendingSwapAmount>0n&&!isSwapping&&!isProcessing&&tl>55&&tl<59){isSwapping=true;const a=pendingSwapAmount;pendingSwapAmount=0n;setTimeout(async()=>{try{await swapBeanToEth(a);}catch(e){}finally{isSwapping=false;}},2000);}
  const dt=currentLatency>700?BASE_EXECUTION_TIME+1:BASE_EXECUTION_TIME;
  if(tl<=dt&&tl>=2&&rid===lastR&&!deploying&&!played&&!isProcessing){deploying=true;try{
    if(currentBeanpotBean<MIN_BEANPOT_THRESHOLD)return;
    const be=parseFloat(ethers.formatEther(info.totalDeployed));if(be>GATEKEEPER_THRESHOLD)return;
    if(ENABLE_ANTI_LOSS&&cooldownUntilRound&&rid<=cooldownUntilRound)return;
    if(ENABLE_BOBOT_ENGINE&&nextRoundStrategy.shouldDeploy===false)return;
    let bp=nextRoundStrategy.recommendedBet&&nextRoundStrategy.recommendedBet>0n?nextRoundStrategy.recommendedBet:DEFAULT_BET_PER_BLOCK;
    if(bp>HARD_MAX_SAFETY)bp=HARD_MAX_SAFETY;
    console.log(`🧠 [${nextRoundStrategy.strategyId}] R#${rid} bet=${ethers.formatEther(bp)}`);
    let bl=Array.from({length:25},(_,i)=>i);
    if(deployMode==='skip'&&prevWinningBlock>=0&&prevWinningBlock<=24)bl=bl.filter(b=>b!==prevWinningBlock);
    else if(deployMode==='random'){const rs=Math.floor(Math.random()*25);bl=bl.filter(b=>b!==rs);}
    const tb=bp*BigInt(bl.length);const mbe=parseFloat(ethers.formatEther(tb));
    const gas=await getAdaptiveFee({boardEth:be,gasLimit:1000000n,purpose:'deploy'});
    const ev=computeEv({myBetEth:mbe,betPerBlockEth:parseFloat(ethers.formatEther(bp)),blockCount:bl.length,boardEth:be,beanpotBean:currentBeanpotBean,gasUsd:gas.gasUsd});
    if(ev.totalEvUsd>(MIN_PROFIT_THRESHOLD+MIN_EV_BUFFER_USD)){const pr=await grid.getTotalPendingRewards(wallet.address);preDeployB=pr[1]+pr[2];preDeployETH=pr[0];lastRoundBet=tb;
      lastDeployMeta={roundId:rid,mode:nextRoundStrategy.mode,source:nextRoundStrategy.source,betPerBlockEth:ethers.formatEther(bp),boardEth:be.toFixed(9),beanpotBean:currentBeanpotBean.toFixed(6),evUsd:ev.totalEvUsd.toFixed(6),gasUsd:gas.gasUsd.toFixed(6),reason:nextRoundStrategy.reason};
      const tx=await grid.deploy(bl,{value:tb,gasLimit:1000000,maxFeePerGas:gas.maxFeePerGas,maxPriorityFeePerGas:gas.maxPriorityFeePerGas});const rc=await tx.wait();played=rc?.status===1;
      if(played)console.log(`🔥 DEPLOYED [${nextRoundStrategy.strategyId}] ${tx.hash.slice(0,18)}...`);}
    else console.log(`❌ R#${rid} EV ${ev.totalEvUsd.toFixed(3)} < target`);
  }catch(e){console.error('Deploy:',e.message);}finally{deploying=false;}}
  }catch(e){consecutiveRpcErrors++;if(consecutiveRpcErrors>=MAX_CONSECUTIVE_ERRORS&&!rpcAlertSent){rpcAlertSent=true;tg(`⚠️ RPC: ${e.message.slice(0,80)}`);}}},1000);
}
process.on('unhandledRejection',(e)=>console.error('UR:',e));
process.on('uncaughtException',(e)=>console.error('UE:',e));
main().catch(e=>{console.error('fatal:',e);process.exit(1);});
