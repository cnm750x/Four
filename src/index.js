'use strict';
/**
 * index.js — 编排层（已移除策略一、策略二；狙击 = 追踪钱包买入）
 *
 * 双平台：
 *   - four.meme：chain.js + fourmeme.js
 *   - FLAP    ：flap.js（毫秒级 WSS 监控新币创建/买/卖）+ flap-trade.js（Portal 买卖）
 *   后端监控 FLAP 链上全部新币与交易；仅税率≤MAX_TAX_RATE 且分红=100% 的代币入库展示。
 *
 * 本版要点：
 *   ① 媒体竞速：只在 1200ms 后请求一次（已删除 800ms / 1000ms 两轮）
 *   ② four.meme WSS 媒体链接：直接按 CA 匹配 store，不命中直接丢弃（无缓冲）
 *   ③ 交易明细地址与 GMGN 对齐：用 maker.js 解析 tx.from 后推送 trade_maker 补丁
 *   ④ 税率/分红：只下发 FLAP 代币，four.meme 不再下发/展示
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const fsSync = require('fs');
const { Server } = require('socket.io');
const path = require('path');

const BlockchainService = require('./blockchain');
const TokenStore = require('./store');
const ChainWatcher = require('./chain');
const FourMemeWatcher = require('./fourmeme');
const FlapWatcher = require('./flap');
const { FlapTradeService, TradeRouter } = require('./flap-trade');
const { MakerResolver } = require('./maker');
const flapConfig = require('./flap-config');
const TradingEngine = require('./trader');
const Storage = require('./storage');
const { TRADE, NETWORK, WATCH_WALLETS } = require('./config');
const { formatBeijingTimeMs, toReadableTwitter, extractTweetId } = require('./utils');

// ─── 配置组合 ───────────────────────────────
const config = {
  privateKey:            TRADE.privateKey,
  bscRpcUrl:             NETWORK.bscRpcUrl,
  port:                  TRADE.port,
  buyAmountBNB:          TRADE.buyAmountBNB,
  walletBuyMCThreshold:  TRADE.walletBuyMCThreshold,
  sellThreshold1USD:     TRADE.sellThreshold1USD,
  sellRatio1:            TRADE.sellRatio1,
  sellThreshold2USD:     TRADE.sellThreshold2USD,
  sellRatio2:            TRADE.sellRatio2,
  sellThreshold3USD:     TRADE.sellThreshold3USD,
  sellRatio3:            TRADE.sellRatio3,
  sellThreshold4USD:     TRADE.sellThreshold4USD,
  sellRatio4:            TRADE.sellRatio4,
  sellThreshold5USD:     TRADE.sellThreshold5USD,
  sellRatio5:            TRADE.sellRatio5,
  fixedBNBPrice:         TRADE.fixedBNBPrice,
  gasPriceGwei:          TRADE.gasPriceGwei,
  buyGasLimit:           TRADE.buyGasLimit,
  sellGasLimit:          TRADE.sellGasLimit,
  approveGasLimit:       TRADE.approveGasLimit,
};

// ─── 服务初始化 ───────────────────────────
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// 首页：注入平台角标脚本（不侵入修改 public/index.html）
const PUBLIC_DIR = path.join(__dirname, '../public');
const INDEX_HTML_PATH = path.join(PUBLIC_DIR, 'index.html');
const BADGE_TAG = '<script src="/flap-badge.js"></script>';
let _indexHtmlCache = null;
let _indexHtmlMtime = 0;

function renderIndexHtml() {
  try {
    const stat = fsSync.statSync(INDEX_HTML_PATH);
    if (_indexHtmlCache && stat.mtimeMs === _indexHtmlMtime) return _indexHtmlCache;
    let html = fsSync.readFileSync(INDEX_HTML_PATH, 'utf8');
    if (!html.includes('/flap-badge.js')) {
      html = html.includes('</body>')
        ? html.replace('</body>', `${BADGE_TAG}\n</body>`)
        : html + `\n${BADGE_TAG}\n`;
    }
    _indexHtmlCache = html;
    _indexHtmlMtime = stat.mtimeMs;
    return html;
  } catch (err) {
    console.warn(`[Server] \u26A0\uFE0F 首页注入失败: ${err.message}`);
    return null;
  }
}

function serveIndex(_req, res, next) {
  const html = renderIndexHtml();
  if (!html) return next();
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Cache-Control', 'no-store');
  res.send(html);
}
app.get('/', serveIndex);
app.get('/index.html', serveIndex);

app.use(express.static(PUBLIC_DIR));

const storage = new Storage();
const blockchain = new BlockchainService(config);

// FLAP 交易服务 + 平台路由（与 four.meme 交易逻辑完全一致）
const flapTrade = new FlapTradeService(blockchain, flapConfig);
const tradeRouter = new TradeRouter({
  four: blockchain,
  flap: flapTrade,
  resolvePlatform: (ca) => (store ? store.getPlatform(ca) : 'four'),
});

const trader = new TradingEngine(config, tradeRouter, storage);

const store = new TokenStore({
  bnbPriceUSD:          config.fixedBNBPrice,
  walletBuyMCThreshold: config.walletBuyMCThreshold,
  onMatched: (token) => trader.onMatched(token),  // 追踪钱包买入触发
});

// ★ 真实交易者（GMGN 口径）解析：事件里的入账地址 → tx.from
const makerResolver = new MakerResolver({ rpcUrl: NETWORK.bscRpcUrl });
store.setMakerResolver(makerResolver);
store.setWatchWallets(WATCH_WALLETS);

const chain = new ChainWatcher();
chain.store = store;

const fourmeme = new FourMemeWatcher();
fourmeme.store = store;

const flap = new FlapWatcher({ config: flapConfig, watchWallets: WATCH_WALLETS });
flap.store = store;
if (typeof flap.setStore === 'function') flap.setStore(store);

// ─── 恢复持久化 MEME ────────────────────────────
const restoredMemes = storage.loadAllMemes();
if (restoredMemes.length > 0) {
  let restored = 0;
  for (const meme of restoredMemes) {
    if (!meme.tokenId || store.has(meme.tokenId)) continue;
    const ca = meme.tokenId.toLowerCase ? meme.tokenId.toLowerCase() : meme.tokenId;
    store.tokenMap.set(ca, {
      ...meme,
      tokenId: ca,
      tokenAddress: meme.tokenAddress || ca,
      platform: meme.platform || 'four',
      arrivalTime: meme.arrivalTime ? new Date(meme.arrivalTime) : new Date(),
      walletSignals: meme.walletSignals || [],
      trades: meme.trades || [],
      _enriched: true,
    });
    restored++;
  }
  console.log(`[Server] \u267B\uFE0F 恢复 ${restored} 个持久化MEME到内存`);
}

// ─── 运行时状态 ─────────────────────────
let bnbPriceUSD = config.fixedBNBPrice;
let wsChainStatus = false;
let wsFourmemeStatus = false;
let wsFlapStatus = false;
let walletAddress = null;
let bnbBalance = '—';

const walletTxHistory = (storage.state.walletTxHistory || []).slice(0, 500);
console.log(`[Server] \u267B\uFE0F 恢复 walletTxHistory: ${walletTxHistory.length} 条`);

// ─── 辅助 ───────────────────────────────
function syncBNBPrice(price) {
  if (price > 0) {
    bnbPriceUSD = price;
    store.setBNBPrice(price);
    trader.setBNBPrice(price);
    io.emit('bnb_price', { price: bnbPriceUSD });
  }
}

async function updateWalletBalance() {
  try {
    const bal = await blockchain.getBNBBalance();
    bnbBalance = bal || '0';
    walletAddress = blockchain.getWalletAddress();
    io.emit('wallet_balance', { address: walletAddress, balance: bnbBalance });
  } catch (_) { bnbBalance = '—'; }
}

// ★ 税率/分红只属于 FLAP：four.meme 统一下发 null，前端不再展示
function taxFieldsOf(t) {
  const platform = (t && t.platform) || 'four';
  if (platform !== 'flap') {
    return { platform, taxRate: null, buyTaxRate: null, sellTaxRate: null, dividendBps: null, dividendPct: null };
  }
  return {
    platform,
    taxRate:     t.taxRate     !== undefined ? t.taxRate     : null,
    buyTaxRate:  t.buyTaxRate  !== undefined ? t.buyTaxRate  : null,
    sellTaxRate: t.sellTaxRate !== undefined ? t.sellTaxRate : null,
    dividendBps: t.dividendBps !== undefined ? t.dividendBps : null,
    dividendPct: t.dividendPct !== undefined ? t.dividendPct : null,
  };
}

function platformMap() {
  return store.getAllTokens().map(t => ({
    tokenAddress: t.tokenAddress || t.tokenId,
    ...taxFieldsOf(t),
  }));
}

// ─── four.meme API 媒体竞速（★ 只在 1200ms 后一次）───────────
const FOUR_MEME_API_URL = NETWORK.fourMemeApi;
const API_RACE_DELAY_MS = 1200;   // 已删除 800ms / 1000ms 两轮，仅保留这一次
const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Edg/125.0.0.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
];

function getRandomHeaders() {
  return {
    'User-Agent': UA_POOL[Math.floor(Math.random() * UA_POOL.length)],
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': ['en-US,en;q=0.9', 'zh-CN,zh;q=0.9,en;q=0.8', 'ja,en;q=0.9'][Math.floor(Math.random() * 3)],
    'Referer': 'https://four.meme/',
    'Origin': 'https://four.meme',
    'sec-ch-ua-platform': ['"Windows"', '"macOS"', '"Linux"'][Math.floor(Math.random() * 3)],
  };
}

const apiPollingMap = new Map();

async function pollFourMemeApi(ca) {
  if (!ca || !FOUR_MEME_API_URL) return;
  const controller = new AbortController();
  apiPollingMap.set(ca, controller);
  const url = `${FOUR_MEME_API_URL}${ca}`;
  // ★ 单次竞速：1200ms 后只请求一次，不再重试
  await new Promise(r => setTimeout(r, API_RACE_DELAY_MS));
  if (controller.signal.aborted) { apiPollingMap.delete(ca); return; }
  const token = store.get(ca);
  if (!token || token._enriched) { apiPollingMap.delete(ca); return; }
  try {
    const res = await fetch(url, { method: 'GET', headers: getRandomHeaders(), signal: controller.signal });
    const json = await res.json();
    if (controller.signal.aborted) { apiPollingMap.delete(ca); return; }
    const data = json?.data;
    if (!data || typeof data !== 'object' || Object.keys(data).length === 0) { apiPollingMap.delete(ca); return; }
    if (token._enriched) { apiPollingMap.delete(ca); return; }
    const apiLatency = Date.now() - token.arrivalTime.getTime();
    const rawTwitter = data.twitterUrl || data.twitter || data.webUrl || null;
    const enrichData = {
      image:     data.image || data.img || data.logoUrl || null,
      fmSymbol:  data.symbol || data.ticker || null,
      fmName:    data.name || data.tokenName || null,
      tamount:   data.tamount || data.totalSupply || null,
      mediaAddressTime: formatBeijingTimeMs(new Date()),
      _source: 'api',
    };
    if (rawTwitter) {
      const readable = toReadableTwitter(rawTwitter);
      enrichData.twitterUrl     = rawTwitter;
      enrichData.twitterDisplay = readable.display;
      enrichData.twitterHref    = readable.href;
      enrichData.twitterUsername = readable.username;
    }
    store.enrich(ca, enrichData);
    io.emit('media_race', { ca, latency: apiLatency, source: 'api', channel: 'API', attempt: 1 });
    console.log(`[API竞速] \u{1F680} API获取成功(1200ms单次) | CA:${ca.slice(0, 10)}... | ${apiLatency}ms`);
    if (rawTwitter) {
      const tweetId = extractTweetId(rawTwitter);
      const readable = toReadableTwitter(rawTwitter);
      const isAnonymous = !!(rawTwitter && /\/(i)\/status\//i.test(rawTwitter) && !readable.username);
      if (isAnonymous && tweetId) fourmeme._resolveAnonymousUrl(ca, tweetId);
      else if (tweetId) fourmeme._asyncFetchContent(ca, tweetId);
      fourmeme._apiResolved.add(ca);
    }
  } catch (err) {
    if (err.name === 'AbortError') { apiPollingMap.delete(ca); return; }
    console.warn(`[API竞速] \u26A0\uFE0F 请求失败: ${err.message} | CA:${ca.slice(0, 10)}...`);
  }
  apiPollingMap.delete(ca);
}

// ─── 事件监听 ──────────────────────────
store.on('registered', (token) => {
  io.emit('new_token', token);
  io.emit('token_count', { count: store.size });
  // FLAP 代币不走 four.meme 的媒体竞速通道（已由 IPFS 元数据完成）
  // four.meme：WSS 直接按 CA 匹配（无缓冲）+ API 仅 1200ms 后一次
  if ((token.platform || 'four') === 'four') {
    pollFourMemeApi(token.tokenId);
  }
});

store.on('enriched', (token) => {
  if (token._enriched && apiPollingMap.has(token.tokenId)) {
    const ctrl = apiPollingMap.get(token.tokenId);
    ctrl.abort();
    apiPollingMap.delete(token.tokenId);
  }
  io.emit('token_enriched', {
    tokenId:            token.tokenId,
    image:              token.image,
    fmSymbol:           token.fmSymbol,
    fmName:             token.fmName,
    twitterUrl:         token.twitterUrl,
    twitterDisplay:     token.twitterDisplay,
    twitterHref:        token.twitterHref,
    twitterUsername:    token.twitterUsername,
    mediaAddressTime:   token.mediaAddressTime,
    twitterCreatedAt:   token.twitterCreatedAt,
    twitterContent:     token.twitterContent,
    twitterContentTime: token.twitterContentTime,
    tamount:            token.tamount,
    mediaSource:        token.mediaSource,
    mediaLatencyMs:     token.mediaLatencyMs,
    // 平台字段（图片右下角角标 / 税率分红展示，仅 FLAP 有值）
    ...taxFieldsOf(token),
    metaUrl:            token.metaUrl || null,
    description:        token.description || null,
    telegramUrl:        token.telegramUrl || null,
    websiteUrl:         token.websiteUrl || null,
  });
  if (token.bought || token.matchReason) {
    setImmediate(() => storage.persistMeme(token));
  }
});

store.on('price_updated', ({ token, priceBNB, marketCapUSD }) => {
  io.emit('price_update', {
    tokenId:     token.tokenId,
    marketCapUSD,
    price:       priceBNB,
    source:      'chain_trade',
    platform:    token.platform || 'four',
  });
  if (trader.hasPosition(token.tokenAddress)) {
    trader.onPriceUpdate(token.tokenAddress, marketCapUSD, token).catch(() => {});
  }
});

store.on('matched', (token) => {
  // 追踪钱包买入匹配成功 → 通知前端标记狙击记录
  io.emit('matched_token', token);
  setImmediate(() => {
    storage.appendEvent('matched_token', {
      tokenId:     token.tokenId,
      platform:    token.platform || 'four',
      symbol:      token.symbol,
      matchReason: token.matchReason,
      marketCapUSD: token.marketCapUSD,
    });
  });
});

// wallet_signal 事件：仅用于 K线列金黄高亮
store.on('wallet_signal', ({ token, signal }) => {
  io.emit('wallet_signal_mc', {
    tokenId:      token.tokenId,
    marketCapUSD: signal.marketCapUSD || token.marketCapUSD || 0,
  });
});

store.on('trade_added', ({ token, trade }) => {
  const tax = taxFieldsOf(trade.platform ? { ...token, platform: trade.platform } : token);
  io.emit('fm_trade', {
    source:          trade.source || 'chain',
    tokenAddress:    trade.tokenAddress,
    userAddress:     trade.userAddress,
    eventAddress:    trade.eventAddress || null,
    tokenName:       token.name || trade.tokenName || trade.tokenAddress,
    volume:          trade.bnbAmount,
    side:            trade.side === 'buy' ? 1 : 2,
    sideLabel:       trade.sideLabel,
    image:           token.image || trade.tokenImage || '',
    symbol:          trade.symbol || 'BNB',
    txHash:          trade.txHash,
    blockNumber:     trade.blockNumber,
    time:            trade.time,
    tokenSymbol:     token.symbol || token.fmSymbol || trade.tokenSymbol || '',
    tokenTwitterUrl: token.twitterUrl || trade.tokenTwitterUrl || '',
    tokenTwitterDisp: token.twitterDisplay || trade.tokenTwitterDisp || '',
    tokenTwitterHref: token.twitterHref || trade.tokenTwitterHref || '',
    marketCapUSD:    trade.marketCapUSD || token.marketCapUSD || 0,
    // 追踪(KOL)钱包：前端整行金黄色 + 地址位置显示 KOL 名
    walletName:      trade.walletName || null,
    isWatch:         !!trade.isWatch,
    ...tax,
  });
  if (token.bought || token.matchReason) {
    setImmediate(() => storage.persistTrade(token));
  }
});

// ★ 交易者校正补丁（事件入账地址 → tx.from，与 GMGN 一致）
store.on('trade_maker', (patch) => {
  io.emit('trade_maker', patch);
});

// 追踪钱包交易（four.meme 与 FLAP 共用）
function handleWalletTrade(record) {
  walletTxHistory.unshift(record);
  if (walletTxHistory.length > 500) walletTxHistory.length = 500;
  io.emit('wallet_tx', record);
  setImmediate(() => {
    storage.update({ walletTxHistory: walletTxHistory.slice(0, 500) });
    storage.appendEvent('wallet_trade', {
      time:         record.time,
      walletName:   record.walletName,
      action:       record.action,
      tokenAddress: record.tokenAddress,
      tokenSymbol:  record.tokenSymbol,
      bnbAmount:    record.bnbAmount,
      txHash:       record.txHash,
      marketCapUSD: record.marketCapUSD,
      platform:     record.platform || 'four',
    });
  });
}

chain.on('wallet_trade', (record) => handleWalletTrade(record));
flap.on('wallet_trade',  (record) => handleWalletTrade({ platform: 'flap', ...record }));

chain.on('connected',    () => { wsChainStatus = true;  io.emit('ws_status', { chain: true,  fourmeme: null, flap: null, status: '链上已连接' }); });
chain.on('disconnected', () => { wsChainStatus = false; io.emit('ws_status', { chain: false, fourmeme: null, flap: null, status: '链上断开重连中...' }); });
fourmeme.on('connected',    () => { wsFourmemeStatus = true;  io.emit('ws_status', { chain: null, fourmeme: true,  flap: null }); });
fourmeme.on('disconnected', () => { wsFourmemeStatus = false; io.emit('ws_status', { chain: null, fourmeme: false, flap: null }); });
flap.on('connected',    () => { wsFlapStatus = true;  io.emit('ws_status', { chain: null, fourmeme: null, flap: true,  status: 'FLAP已连接' }); });
flap.on('disconnected', () => { wsFlapStatus = false; io.emit('ws_status', { chain: null, fourmeme: null, flap: false, status: 'FLAP断开重连中...' }); });

fourmeme.on('wss_enriched', (data) => { io.emit('media_race', { ...data, channel: 'WSS' }); });
fourmeme.on('bnb_price', (price) => { syncBNBPrice(price); });

// FLAP 专属事件中继
flap.on('media_race',  (data) => { io.emit('media_race', { channel: 'FLAP-IPFS', platform: 'flap', ...data }); });
flap.on('flap_created', (data) => { io.emit('flap_created', data); });
flap.on('flap_token',   (token) => { io.emit('flap_token', token); });
flap.on('flap_stats',   (stats) => { io.emit('flap_stats', stats); });

trader.on('trade', (trade) => {
  io.emit('trade', trade);
  io.emit('trade_history', trader.getTradeHistory());
  setImmediate(() => {
    storage.appendEvent('trade', trade);
    updateWalletBalance();
  });
});
trader.on('trade_update', (patch) => { io.emit('trade_update', patch); });

// ─── Socket.IO 连接 ────────────────────────────
io.on('connection', (socket) => {
  console.log('[Server] 前端已连接:', socket.id);
  socket.emit('init', {
    tokens:          store.getAllTokens(),
    tradeHistory:    trader.getTradeHistory(),
    positions:       trader.getPositions(),
    bnbPrice:        bnbPriceUSD,
    wsStatus:        wsChainStatus ? '链上已连接' : '未连接',
    wsChain:         wsChainStatus,
    wsFourmeme:      wsFourmemeStatus,
    wsFlap:          wsFlapStatus,
    flapStats:       (typeof flap.getStats === 'function' ? flap.getStats() : null),
    platformMap:     platformMap(),
    walletAddress,
    bnbBalance,
    watchWallets:    WATCH_WALLETS,
    walletTxHistory: walletTxHistory.slice(0, 200),
    nodeStatus:      null,
    config: {
      buyAmountBNB:         config.buyAmountBNB,
      walletBuyMCThreshold: config.walletBuyMCThreshold,
      sellThreshold1USD:    config.sellThreshold1USD,
      sellThreshold2USD:    config.sellThreshold2USD,
      sellThreshold3USD:    config.sellThreshold3USD,
      sellThreshold4USD:    config.sellThreshold4USD,
      sellThreshold5USD:    config.sellThreshold5USD,
      sellRatio1:           config.sellRatio1,
      sellRatio2:           config.sellRatio2,
      sellRatio3:           config.sellRatio3,
      sellRatio4:           config.sellRatio4,
      sellRatio5:           config.sellRatio5,
      flapMaxTaxRate:       flapConfig.MAX_TAX_RATE,
      flapTargetDividend:   flapConfig.TARGET_DIVIDEND,
      mediaRaceDelayMs:     API_RACE_DELAY_MS,
    },
  });
});

// ─── REST API ────────────────────────────────
app.get('/api/status', (_req, res) => res.json({
  wsStatus:     wsChainStatus ? '链上已连接' : '未连接',
  wsChain:      wsChainStatus,
  wsFourmeme:   wsFourmemeStatus,
  wsFlap:       wsFlapStatus,
  walletAddress, bnbBalance, bnbPrice: bnbPriceUSD,
  tokenCount:   store.size,
  positions:    trader.getPositions().length,
  watchWallets: WATCH_WALLETS,
  flapStats:    (typeof flap.getStats === 'function' ? flap.getStats() : null),
  storeStats:   (typeof store.getStats === 'function' ? store.getStats() : null),
  mediaRaceDelayMs: API_RACE_DELAY_MS,
}));
app.get('/api/tokens',   (_req, res) => {
  const page = parseInt(_req.query.page) || 1;
  const limit = parseInt(_req.query.limit) || 20;
  const platform = _req.query.platform ? String(_req.query.platform).toLowerCase() : null;
  let tokens = store.getAllTokens();
  if (platform) tokens = tokens.filter(t => (t.platform || 'four') === platform);
  const total = tokens.length;
  const start = (page - 1) * limit;
  res.json({ tokens: tokens.slice(start, Math.min(start + limit, total)), page, totalPages: Math.ceil(total / limit), total });
});
app.get('/api/trades',     (_req, res) => res.json(trader.getTradeHistory()));
app.get('/api/positions',  (_req, res) => res.json(trader.getPositions()));
app.get('/api/wallet-txs', (_req, res) => res.json(walletTxHistory.slice(0, 200)));
// 前端角标用：CA → 平台/税率/分红（税率分红仅 FLAP）
app.get('/api/platform-map', (_req, res) => res.json({ tokens: platformMap() }));
app.get('/api/flap/tokens', (_req, res) => {
  const onlyVisible = _req.query.all !== '1';
  const tokens = (typeof flap.getTokens === 'function') ? flap.getTokens(onlyVisible) : [];
  res.json({ tokens, total: tokens.length, onlyVisible, stats: (typeof flap.getStats === 'function' ? flap.getStats() : null) });
});

// ─── 优雅退出 ──────────────────────────────────
function gracefulShutdown(signal) {
  console.log(`\n[Server] 收到 ${signal}，安全退出...`);
  chain.stop();
  fourmeme.stop();
  try { flap.stop(); } catch (_) {}
  const allTokens = store.getAllTokens().filter(t => t.bought || t.matchReason);
  for (const token of allTokens) {
    const ca = (token.tokenId || '').toLowerCase();
    if (!ca) continue;
    const filePath = path.join(__dirname, '..', 'data', 'memes', `${ca}.json`);
    try {
      const fs = require('fs');
      const payload = JSON.stringify({
        meta: {
          tokenId: token.tokenId, tokenAddress: token.tokenAddress,
          platform: token.platform || 'four',
          taxRate: token.taxRate ?? null, dividendBps: token.dividendBps ?? null,
          buyTaxRate: token.buyTaxRate ?? null, sellTaxRate: token.sellTaxRate ?? null,
          symbol: token.symbol, name: token.name,
          fmSymbol: token.fmSymbol, fmName: token.fmName,
          image: token.image, twitterUrl: token.twitterUrl,
          twitterDisplay: token.twitterDisplay, twitterHref: token.twitterHref,
          twitterUsername: token.twitterUsername, twitterCreatedAt: token.twitterCreatedAt,
          twitterContent: token.twitterContent, programGetTime: token.programGetTime,
          mediaAddressTime: token.mediaAddressTime, twitterContentTime: token.twitterContentTime,
          marketCapUSD: token.marketCapUSD, mediaSource: token.mediaSource,
          mediaLatencyMs: token.mediaLatencyMs,
          metaCid: token.metaCid || null, metaUrl: token.metaUrl || null,
          walletSignals: (token.walletSignals || []).slice(0, 100),
          bought: token.bought,
          sold1: token.sold1, sold2: token.sold2, sold3: token.sold3,
          sold4: token.sold4, sold5: token.sold5,
          matchReason: token.matchReason, buyStatus: token.buyStatus,
          arrivalTime: token.arrivalTime, tamount: token.tamount,
        },
        trades: (token.trades || []).slice(-200).map(t => ({
          side: t.side, userAddress: t.userAddress, eventAddress: t.eventAddress || null,
          walletName: t.walletName || null, bnbAmount: t.bnbAmount,
          tokenAmount: t.tokenAmount, txHash: t.txHash, time: t.time, marketCapUSD: t.marketCapUSD || 0,
          platform: t.platform || token.platform || 'four',
        })),
      });
      fs.writeFileSync(filePath, payload);
    } catch (_) {}
  }
  store.destroy();
  storage.flushSync();
  console.log(`[Server] 已持久化 ${allTokens.length} 个MEME，退出。`);
  process.exit(0);
}
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  console.error('[Server] 未捕获异常:', err);
  storage.flushSync();
});

// ─── 启动 ───────────────────────────────────
async function main() {
  console.log('');
  console.log('╭──────────────────────────────────────────────╮');
  console.log('│  BitSticker — 追踪钱包狙击策略自动交易机器人（four.meme + FLAP）   │');
  console.log('╰──────────────────────────────────────────────╯');
  console.log('');

  const chainOk = await blockchain.init();
  walletAddress = blockchain.getWalletAddress();
  if (chainOk) await updateWalletBalance();

  // 交易者解析复用已初始化的 provider（没有则用自建 RPC）
  if (blockchain.provider) makerResolver.setProvider(blockchain.provider);

  setInterval(updateWalletBalance, 60_000);
  setInterval(() => {
    const tokens = store.getAllTokens().filter(t => t.bought || t.matchReason);
    for (const t of tokens) storage.persistMeme(t);
    if (tokens.length > 0) console.log(`[Storage] \u{1F4E6} 定时持久化 ${tokens.length} 个狙击MEME`);
  }, 5 * 60_000);

  chain.start();
  fourmeme.start();
  flap.start();

  server.listen(config.port, () => {
    console.log(`[Server] \u{1F310} http://localhost:${config.port}`);
    console.log(`[Server] 买入: ${config.buyAmountBNB} BNB | 市值阈值: <$${config.walletBuyMCThreshold} | GAS: ${config.gasPriceGwei} Gwei`);
    console.log(`[Server] 止盈: $${config.sellThreshold1USD/1000}K→${config.sellRatio1*100}% | $${config.sellThreshold2USD/1000}K→${config.sellRatio2*100}% | $${config.sellThreshold3USD/1000}K→${config.sellRatio3*100}% | $${config.sellThreshold4USD/1000}K→${config.sellRatio4*100}% | $${config.sellThreshold5USD/1000}K→${config.sellRatio5*100}%`);
    console.log(`[Server] 钱包: ${WATCH_WALLETS.length} 个`);
    console.log(`[Server] FLAP: Portal ${flapConfig.PORTAL} | 前端过滤 税率≤${flapConfig.MAX_TAX_RATE}% 且 分红=${flapConfig.TARGET_DIVIDEND}%`);
    console.log(`[Server] 媒体竞速: 仅 ${API_RACE_DELAY_MS}ms 后一次（已删除800/1000ms）| four.meme WSS: CA直接匹配，不命中丢弃（无缓冲）`);
    console.log(`[Server] 交易者口径: 事件入账地址 → tx.from（与GMGN一致）`);
    console.log('');
  });
}

main().catch(err => {
  console.error('启动失败:', err);
  storage.flushSync();
  process.exit(1);
});
