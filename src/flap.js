'use strict';
/**
 * flap.js — FLAP(flap.sh) 毫秒级链上监控（与 four.meme chain.js 逻辑一一对应）
 *
 * (1) 新币创建：Portal.TokenCreated  -> store.register(platform:'flap')
 *     ★ 只处理「程序启动之后」链上新创建的代币。
 * (2) 交易明细：Portal.TokenBought / TokenSold -> store.updatePrice + store.addTrade
 *     （字段格式与 four.meme 完全一致，前端 fm_trade 直接渲染；命中追踪钱包时带 walletName）
 * (3) 媒体/元数据：meta -> https://flap.mypinata.cloud/ipfs/<cid>
 *     ★ meta 可能是 JSON 的 CID / 图片本身的 CID / ipfs:// / http(s) / 内联 JSON，全部兼容。
 *     ★ 专用网关失败（403/超时）时自动换公共网关重试。
 *     「获取时间」= 媒体链接返回那一刻的实时时间（mediaAddressTime）
 * (4) 市值：实时价格(买/卖事件 eth/amount) x 真实总发行量(totalSupply) x BNB价
 * (5) 税率：★ TaxTokenHelper.getTaxTokenInfoV2 返回真实的 buyTaxRate / sellTaxRate（BPS），
 *     旧版合约回退到 getTaxTokenInfo 的单一 taxRate。
 *     显示过滤：max(买税,卖税) <= 5% 且 dividendBps === 10000
 * (6) 追踪钱包：命中 WATCH_WALLETS 时 store.addWalletSignal -> 与 four.meme 相同的狙击触发
 */

const { EventEmitter } = require('events');
const WebSocket = require('ws');
const { ethers } = require('ethers');
const { formatBeijingTimeMs, toReadableTwitter } = require('./utils');

const coder = ethers.AbiCoder.defaultAbiCoder();

// 事件签名（启动时自校验 topic hash）
const SIG_CREATED = 'TokenCreated(uint256,address,uint256,address,string,string,string)';
const SIG_BOUGHT  = 'TokenBought(uint256,address,address,uint256,uint256,uint256,uint256)';
const SIG_SOLD    = 'TokenSold(uint256,address,address,uint256,uint256,uint256,uint256)';

// ts, creator, nonce, token, name, symbol, meta
const CREATED_TYPES = ['uint256', 'address', 'uint256', 'address', 'string', 'string', 'string'];
// ts, token, user, amount(token), eth, fee, postPrice
const TRADE_TYPES   = ['uint256', 'address', 'address', 'uint256', 'uint256', 'uint256', 'uint256'];

// 备用 IPFS 网关：flap 专用网关限流/403 时轮换
const FALLBACK_GATEWAYS = [
  'https://ipfs.io/ipfs/',
  'https://cloudflare-ipfs.com/ipfs/',
  'https://dweb.link/ipfs/',
  'https://gateway.pinata.cloud/ipfs/',
];

// 元数据里可能出现的图片字段名
const IMAGE_KEYS = [
  'image', 'imageUrl', 'image_url', 'imageUri', 'image_uri', 'imageURI',
  'img', 'imgUrl', 'logo', 'logoUrl', 'logoURI', 'icon', 'iconUrl',
  'avatar', 'avatarUrl', 'picture', 'pic', 'photo', 'banner',
  'thumbnail', 'thumb', 'tokenImage', 'media', 'file', 'fileUrl', 'animation_url',
];
const NEST_KEYS = ['properties', 'metadata', 'meta', 'data', 'extensions', 'content', 'token', 'asset'];
const URL_KEYS  = ['url', 'uri', 'src', 'href', 'cid', 'gateway', 'path'];

// ★ V2：买税 / 卖税 分开返回（docs.flap.sh · ITaxTokenHelper）
const TAX_HELPER_ABI = [
  'function getTaxTokenInfo(address taxToken) view returns (tuple(uint16 marketBps,uint16 deflationBps,uint16 lpBps,uint16 dividendBps,uint16 taxRate,uint256 burntTokenAmount,uint256 totalQuoteSentToDividend,uint256 totalQuoteAddedToLiquidity,uint256 totalTokenAddedToLiquidity,uint256 totalQuoteSentToMarketing,address marketingWallet,address quoteToken,uint256 minimumShareBalance) info)',
  'function getTaxTokenInfoV2(address taxToken) view returns (tuple(uint16 marketBps,uint16 deflationBps,uint16 lpBps,uint16 dividendBps,uint16 buyTaxRate,uint16 sellTaxRate,uint256 burntTokenAmount,uint256 totalQuoteSentToDividend,uint256 totalQuoteAddedToLiquidity,uint256 totalTokenAddedToLiquidity,uint256 totalQuoteSentToMarketing,address dividendToken,address quoteToken,uint256 minimumShareBalance,tuple(address addr,address factory,uint8 riskLevel,bool isOfficialVault,bool isVault,bool isAIConsumer) vaultInfo) info)',
];

const TOKEN_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function metaURI() view returns (string)',
];

// =============================================================
//  WSS 通道（断线 1s 重连，毫秒级 eth_subscribe logs）
// =============================================================
class FlapWssChannel extends EventEmitter {
  constructor(name, url, filter) {
    super();
    this.name = name;
    this.url = url;
    this.filter = filter;
    this.ws = null;
    this.connected = false;
    this._stopped = false;
    this._reqId = 1;
    this._pingTimer = null;
  }

  start() { this._stopped = false; this._connect(); }

  stop() {
    this._stopped = true;
    this._clearPing();
    if (this.ws) {
      try { this.ws.removeAllListeners(); this.ws.close(); } catch (_) {}
      this.ws = null;
    }
    this.connected = false;
  }

  _connect() {
    if (this._stopped) return;
    if (!this.url) { console.warn(`[${this.name}] 未配置 WSS 地址，通道未启动`); return; }
    let ws;
    try {
      ws = new WebSocket(this.url, { perMessageDeflate: false, handshakeTimeout: 8000 });
    } catch (e) {
      console.warn(`[${this.name}] 连接创建失败: ${e.message}`);
      return this._retry();
    }
    this.ws = ws;

    ws.on('open', () => {
      this.connected = true;
      try {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: this._reqId++, method: 'eth_subscribe', params: ['logs', this.filter] }));
      } catch (_) {}
      this._startPing();
      console.log(`[${this.name}] WSS 已连接`);
      this.emit('connected');
    });

    ws.on('message', (raw) => {
      const arrivedAt = Date.now();   // 毫秒级：以本地收到日志的时刻为准
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
      if (msg.id && typeof msg.result === 'string') {
        console.log(`[${this.name}] 订阅成功: ${msg.result}`);
        return;
      }
      if (msg.error) { console.warn(`[${this.name}] RPC 错误: ${msg.error.message || msg.error}`); return; }
      if (msg.method === 'eth_subscription' && msg.params && msg.params.result) {
        this.emit('log', msg.params.result, arrivedAt);
      }
    });

    ws.on('close', () => {
      if (this.connected) { this.connected = false; this.emit('disconnected'); }
      this._clearPing();
      this._retry();
    });

    ws.on('error', (err) => { console.warn(`[${this.name}] WSS 错误: ${err.message}`); });
  }

  _retry() {
    if (this._stopped) return;
    const t = setTimeout(() => this._connect(), 1000);
    if (t.unref) t.unref();
  }

  _startPing() {
    this._clearPing();
    this._pingTimer = setInterval(() => {
      try { if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.ping(); } catch (_) {}
    }, 15000);
    if (this._pingTimer.unref) this._pingTimer.unref();
  }

  _clearPing() { if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; } }
}

// =============================================================
//  FlapWatcher
// =============================================================
class FlapWatcher extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.cfg = opts.config || require('./flap-config');
    this.store = opts.store || null;
    this.provider = new ethers.JsonRpcProvider(this.cfg.rpcUrl);
    this.taxHelper = new ethers.Contract(this.cfg.TAX_HELPER, TAX_HELPER_ABI, this.provider);
    this._helperV2 = true;    // getTaxTokenInfoV2 可用标记（连续失败则自动退回 V1）

    this._wallets = new Map();
    for (const w of (opts.watchWallets || [])) {
      if (w && w.address) this._wallets.set(String(w.address).toLowerCase(), w.name || w.address);
    }
    this._stables = new Set((this.cfg.stableQuoteTokens || []).map(a => String(a).toLowerCase()));

    // 只跟踪「程序启动之后」创建的代币（含被前端过滤掉的）
    this._tokens = new Map();
    this._startedAt = 0;
    this.stats = { created: 0, visible: 0, filtered: 0, taxUnknown: 0, trades: 0, tradesVisible: 0, tradesIgnoredOld: 0, mediaOk: 0, mediaFail: 0 };

    this._createCh = null;
    this._tradeCh = null;
  }

  setStore(store) { this.store = store; }

  // ── 启动 / 停止 ────────────────────────────────────────────
  start() {
    this._startedAt = Date.now();
    this._verifyTopics();

    this._createCh = new FlapWssChannel('FLAP-CREATE', this.cfg.wssCreateUrl, {
      address: this.cfg.PORTAL,
      topics: [this.cfg.TOPIC_CREATED],
    });
    this._tradeCh = new FlapWssChannel('FLAP-TRADE', this.cfg.wssTradeUrl, {
      address: this.cfg.PORTAL,
      topics: [[this.cfg.TOPIC_BOUGHT, this.cfg.TOPIC_SOLD]],
    });

    this._createCh.on('log', (log, at) => {
      this._onCreatedLog(log, at).catch(e => console.warn('[FLAP] 创建事件处理失败:', e.message));
    });
    this._tradeCh.on('log', (log, at) => {
      const t0 = String((log.topics && log.topics[0]) || '').toLowerCase();
      const side = t0 === String(this.cfg.TOPIC_BOUGHT).toLowerCase() ? 'buy'
                 : t0 === String(this.cfg.TOPIC_SOLD).toLowerCase()   ? 'sell' : null;
      if (!side) return;
      this._onTradeLog(log, side, at).catch(e => console.warn('[FLAP] 交易事件处理失败:', e.message));
    });

    const relay = (ch) => {
      ch.on('connected',    () => this.emit('connected',    { channel: ch.name }));
      ch.on('disconnected', () => this.emit('disconnected', { channel: ch.name }));
    };
    relay(this._createCh);
    relay(this._tradeCh);

    this._createCh.start();
    this._tradeCh.start();

    console.log(`[FLAP] 监控启动 | Portal:${this.cfg.PORTAL} | 起始时间:${formatBeijingTimeMs(new Date(this._startedAt))}`);
    console.log('[FLAP] 只监控启动之后新创建的代币（启动前的老币不入库、前端不显示）');
    console.log(`[FLAP] 税率源: TaxTokenHelper.getTaxTokenInfoV2（买税/卖税分开，失败退回 V1）`);
    console.log(`[FLAP] 媒体网关: ${this.cfg.IPFS} （失败自动回退 ${FALLBACK_GATEWAYS.length} 个公共网关）`);
    console.log(`[FLAP] 前端显示过滤: max(买税,卖税) <= ${this.cfg.MAX_TAX_RATE}% 且 分红 = ${this.cfg.TARGET_DIVIDEND}% (dividendBps=${this.cfg.TARGET_DIVIDEND_BPS})`);
  }

  stop() {
    if (this._createCh) this._createCh.stop();
    if (this._tradeCh) this._tradeCh.stop();
  }

  get connected() {
    return !!((this._createCh && this._createCh.connected) || (this._tradeCh && this._tradeCh.connected));
  }

  _verifyTopics() {
    const check = (topic, sig, label) => {
      try {
        const hash = ethers.id(sig);
        if (hash.toLowerCase() !== String(topic).toLowerCase()) {
          console.warn(`[FLAP] ⚠ ${label} 与 ${sig} 不一致（配置:${topic} 计算:${hash}），按配置继续监听`);
        } else {
          console.log(`[FLAP] ✓ ${label} = ${sig}`);
        }
      } catch (_) {}
    };
    check(this.cfg.TOPIC_CREATED, SIG_CREATED, 'TOPIC_CREATED');
    check(this.cfg.TOPIC_BOUGHT,  SIG_BOUGHT,  'TOPIC_BOUGHT');
    check(this.cfg.TOPIC_SOLD,    SIG_SOLD,    'TOPIC_SOLD');
  }

  // ── (1) 新币创建（只认启动之后的事件）─────────────────────────
  async _onCreatedLog(log, arrivedAt) {
    let d;
    try { d = coder.decode(CREATED_TYPES, log.data); }
    catch (e) { console.warn('[FLAP] 创建事件解码失败:', e.message); return; }

    const ca = String(d[3]).toLowerCase();
    const programGetTime = formatBeijingTimeMs(new Date(arrivedAt));
    this.stats.created++;

    const ctx = {
      creator: String(d[1]).toLowerCase(),
      name:   String(d[4] || ''),
      symbol: String(d[5] || ''),
      meta:   String(d[6] || ''),
      programGetTime,
      createdAtMs: arrivedAt,
      blockNumber: this._toNum(log.blockNumber),
      txHash: log.transactionHash,
    };

    this.emit('flap_created', Object.assign({ ca }, ctx));

    const existing = this._tokens.get(ca);
    if (existing) {
      existing.creator = existing.creator || ctx.creator;
      existing.name    = existing.name    || ctx.name;
      existing.symbol  = existing.symbol  || ctx.symbol;
      existing.meta    = existing.meta    || ctx.meta;
      existing.programGetTime = existing.programGetTime || programGetTime;
      if (existing.visible) this._fetchMeta(existing);
      return;
    }

    await this._createToken(ca, ctx);
  }

  // ── (2) 买入 / 卖出 ──────────────────────────────────────────
  async _onTradeLog(log, side, arrivedAt) {
    let d;
    try { d = coder.decode(TRADE_TYPES, log.data); }
    catch (e) { console.warn('[FLAP] 交易事件解码失败:', e.message); return; }

    const ca   = String(d[1]).toLowerCase();
    const user = String(d[2]).toLowerCase();
    this.stats.trades++;

    // ★ 只处理本次运行期间监听到「创建事件」的代币
    const rec = this._tokens.get(ca);
    if (!rec) { this.stats.tradesIgnoredOld++; return; }

    if (rec.resolving) { try { await rec.resolving; } catch (_) {} }
    if (!rec.visible) return;   // 后端已统计；税率/分红不达标，前端不显示
    if (!this.store) return;

    // ★ 计价前确保 decimals / totalSupply 已就绪 → 市值口径唯一
    try { await this._ensureSupply(rec); } catch (_) {}

    const dec         = rec.decimals || 18;
    const tokenAmount = ethers.formatUnits(d[3], dec);
    const bnbAmount   = ethers.formatEther(d[4]);
    const feeAmount   = ethers.formatEther(d[5]);
    const postPrice   = d[6].toString();
    const time        = formatBeijingTimeMs(new Date(arrivedAt));
    const blockNumber = this._toNum(log.blockNumber);
    const sideLabel   = side === 'buy' ? '买入' : '卖出';
    this.stats.tradesVisible++;

    // 市值 = 实时价格(eth/amount) x 真实总发行量 x BNB价（store.updatePrice 内完成）
    const paymentToken = this._stableQuote(rec);
    this.store.updatePrice(ca, bnbAmount, tokenAmount, paymentToken);

    const token = this.store.get(ca);
    // 与 price_update（K线市值）同一时刻、同一口径的市值
    const marketCapUSD = token ? (token.marketCapUSD || 0) : 0;

    // 追踪(KOL)钱包命中 -> 与 four.meme 完全一致的狙击链路
    const walletName = this._wallets.get(user) || null;
    if (walletName) {
      const record = {
        time, walletName, walletAddress: user, action: sideLabel,
        tokenAddress: ca,
        tokenSymbol: (token && (token.symbol || token.fmSymbol)) || rec.symbol || '',
        tokenName:   (token && (token.name || token.fmName))     || rec.name   || '',
        tokenImage:  (token && token.image) || '',
        bnbAmount, tokenAmount,
        txHash: log.transactionHash, blockNumber,
        marketCapUSD, platform: 'flap', source: 'flap',
      };
      this.emit('wallet_trade', record);
      this.store.addWalletSignal(ca, {
        time, walletName, walletAddress: user,
        bnbAmount, tokenAmount, txHash: log.transactionHash,
        marketCapUSD, action: sideLabel,
      });
    }

    // 交易明细（字段与 four.meme 一致，前端一一对应）
    this.store.addTrade(ca, {
      source: 'flap', platform: 'flap',
      side, sideLabel,
      tokenAddress: ca, userAddress: user,
      bnbAmount, tokenAmount,
      fee: feeAmount, postPrice,
      txHash: log.transactionHash, blockNumber, time,
      symbol: paymentToken ? 'USD' : 'BNB',
      marketCapUSD,
      totalSupply: rec.totalSupply || null,
      taxRate: rec.taxRate,
      buyTaxRate: rec.buyTaxRate, sellTaxRate: rec.sellTaxRate,
      dividendBps: rec.dividendBps,
      walletName, isWatch: !!walletName,          // ★ KOL 钱包名（前端金黄色高亮 + 显示名字）
    });
  }

  // ── 代币解析（税率/分红过滤 + 注册）────────────────────────────
  async _createToken(ca, ctx) {
    let rec = this._tokens.get(ca);
    if (rec) return rec;

    rec = {
      ca,
      creator: (ctx && ctx.creator) || null,
      name:   (ctx && ctx.name)   || '',
      symbol: (ctx && ctx.symbol) || '',
      meta:   (ctx && ctx.meta)   || '',
      programGetTime: (ctx && ctx.programGetTime) || formatBeijingTimeMs(new Date()),
      createdAtMs: (ctx && ctx.createdAtMs) || Date.now(),
      fromCreateEvent: true,
      decimals: 18,
      totalSupply: null,
      taxRate: null, buyTaxRate: null, sellTaxRate: null,
      buyTaxBps: null, sellTaxBps: null,
      dividendBps: null, taxInfo: null,
      visible: false, registered: false,
      image: null,
    };
    this._tokens.set(ca, rec);
    this._trim();

    rec.resolving = this._resolve(rec).catch((e) => { console.warn(`[FLAP] 解析失败 ${ca}: ${e.message}`); });
    return rec;
  }

  async _resolve(rec) {
    // 总发行量与税率并发拉取（市值口径依赖 totalSupply）
    const supplyP = this._ensureSupply(rec).catch(() => {});
    const tax = await this._fetchTax(rec.ca);
    rec.taxInfo     = tax;
    rec.buyTaxBps   = tax.buyTaxBps;
    rec.sellTaxBps  = tax.sellTaxBps;
    rec.buyTaxRate  = tax.buyTaxPct;
    rec.sellTaxRate = tax.sellTaxPct;
    rec.taxRate     = tax.taxRatePct;          // = max(买税,卖税)，兼容旧字段
    rec.dividendBps = tax.dividendBps;

    const maxBps = tax.maxTaxBps;
    rec.visible = !!(tax.ok
      && maxBps !== null
      && maxBps <= this.cfg.MAX_TAX_BPS
      && tax.dividendBps === this.cfg.TARGET_DIVIDEND_BPS);

    if (!tax.ok) this.stats.taxUnknown++;

    if (rec.visible) {
      await supplyP;            // 注册前尽量带上真实总发行量
      this._register(rec);
    } else {
      this.stats.filtered++;
      const divTxt = tax.dividendBps === null ? '-' : (tax.dividendBps / 100) + '%';
      console.log(`[FLAP] 过滤(仅后端记录) ${rec.symbol || '-'} | CA:${rec.ca} | 买税:${tax.buyTaxPct}% 卖税:${tax.sellTaxPct}% | 分红:${divTxt}`);
    }

    this.emit('flap_token', {
      ca: rec.ca, tokenAddress: rec.ca,
      symbol: rec.symbol, name: rec.name,
      platform: 'flap', visible: rec.visible,
      taxRate: rec.taxRate,
      buyTaxRate: rec.buyTaxRate, sellTaxRate: rec.sellTaxRate,
      buyTaxBps: rec.buyTaxBps, sellTaxBps: rec.sellTaxBps,
      dividendBps: rec.dividendBps,
      dividendPct: rec.dividendBps === null ? null : rec.dividendBps / 100,
      taxVersion: tax.version,
      totalSupply: rec.totalSupply || null,
      programGetTime: rec.programGetTime,
    });
    this.emit('flap_stats', this.getStats());
    return rec;
  }

  _register(rec) {
    if (!this.store || rec.registered) return null;
    rec.registered = true;
    this.stats.visible++;

    const extra = {
      platform: 'flap',
      taxRate: rec.taxRate,
      buyTaxRate: rec.buyTaxRate,
      sellTaxRate: rec.sellTaxRate,
      dividendBps: rec.dividendBps,
      dividendPct: rec.dividendBps === null ? null : rec.dividendBps / 100,
      creator: rec.creator,
      metaCid: rec.meta || null,
      quoteToken: (rec.taxInfo && rec.taxInfo.quoteToken) || null,
      marketingWallet: (rec.taxInfo && rec.taxInfo.marketingWallet) || null,
      tamount: rec.totalSupply || String(this.cfg.defaultSupply),
    };

    let token = this.store.register(rec.ca, rec.symbol, rec.name, rec.programGetTime, extra);
    if (!token) {
      // 已存在（例如持久化恢复）-> 直接补齐平台字段
      token = this.store.get(rec.ca);
      if (token) Object.assign(token, {
        platform: 'flap', taxRate: rec.taxRate,
        buyTaxRate: rec.buyTaxRate, sellTaxRate: rec.sellTaxRate,
        dividendBps: rec.dividendBps,
        dividendPct: rec.dividendBps === null ? null : rec.dividendBps / 100,
      });
    }

    console.log(`[FLAP] NEW ${rec.symbol || '-'} | CA:${rec.ca} | 买税:${rec.buyTaxRate}% 卖税:${rec.sellTaxRate}% | 分红:${(rec.dividendBps || 0) / 100}% | 总量:${rec.totalSupply || '待获取'} | ${rec.programGetTime}`);

    this._fetchMeta(rec);
    return token;
  }

  // ── 税率 / 分红（★ 买税与卖税分开取真实值）──────────────────────
  async _fetchTax(ca, attempt = 0) {
    const num = (v) => Number(v || 0);
    try {
      // 优先 V2：buyTaxRate / sellTaxRate 分开返回
      if (this._helperV2) {
        try {
          const i = await this.taxHelper.getTaxTokenInfoV2(ca);
          const buyBps  = num(i.buyTaxRate  !== undefined ? i.buyTaxRate  : i[4]);
          const sellBps = num(i.sellTaxRate !== undefined ? i.sellTaxRate : i[5]);
          const divBps  = num(i.dividendBps !== undefined ? i.dividendBps : i[3]);
          let quoteToken = '', marketingWallet = '', dividendToken = '';
          try { quoteToken = String(i.quoteToken || i[12] || '').toLowerCase(); } catch (_) {}
          try { dividendToken = String(i.dividendToken || i[11] || '').toLowerCase(); } catch (_) {}
          try {
            const vi = i.vaultInfo || i[14];
            marketingWallet = String((vi && (vi.addr || vi[0])) || '').toLowerCase();
          } catch (_) {}
          const maxBps = Math.max(buyBps, sellBps);
          return {
            ok: true, version: 'v2',
            buyTaxBps: buyBps, sellTaxBps: sellBps, maxTaxBps: maxBps,
            buyTaxPct: buyBps / 100, sellTaxPct: sellBps / 100,
            taxRateBps: maxBps, taxRatePct: maxBps / 100,
            dividendBps: divBps, dividendPct: divBps / 100,
            marketBps: num(i.marketBps !== undefined ? i.marketBps : i[0]),
            deflationBps: num(i.deflationBps !== undefined ? i.deflationBps : i[1]),
            lpBps: num(i.lpBps !== undefined ? i.lpBps : i[2]),
            quoteToken, dividendToken, marketingWallet,
          };
        } catch (e2) {
          // 合约不支持 V2（旧版 helper）-> 不再尝试
          if (attempt === 0) console.warn(`[FLAP] getTaxTokenInfoV2 不可用，退回 V1: ${e2.message}`);
          this._helperV2 = false;
        }
      }

      // V1：单一 taxRate（买卖同税）
      const info = await this.taxHelper.getTaxTokenInfo(ca);
      const pick = (name, idx) => {
        let v;
        try { v = (info[name] !== undefined && info[name] !== null) ? info[name] : info[idx]; } catch (_) { v = info[idx]; }
        return num(v);
      };
      const taxRateBps  = pick('taxRate', 4);
      const dividendBps = pick('dividendBps', 3);
      let quoteToken = '', marketingWallet = '';
      try { quoteToken = String(info.quoteToken || info[11] || '').toLowerCase(); } catch (_) {}
      try { marketingWallet = String(info.marketingWallet || info[10] || '').toLowerCase(); } catch (_) {}
      return {
        ok: true, version: 'v1',
        buyTaxBps: taxRateBps, sellTaxBps: taxRateBps, maxTaxBps: taxRateBps,
        buyTaxPct: taxRateBps / 100, sellTaxPct: taxRateBps / 100,
        taxRateBps, taxRatePct: taxRateBps / 100,
        dividendBps, dividendPct: dividendBps / 100,
        marketBps: pick('marketBps', 0),
        deflationBps: pick('deflationBps', 1),
        lpBps: pick('lpBps', 2),
        quoteToken, dividendToken: '', marketingWallet,
      };
    } catch (e) {
      if (attempt + 1 < this.cfg.taxRetries) {
        await new Promise(r => setTimeout(r, this.cfg.taxRetryDelayMs * (attempt + 1)));
        return this._fetchTax(ca, attempt + 1);
      }
      return {
        ok: false, error: e.message, version: null,
        buyTaxBps: null, sellTaxBps: null, maxTaxBps: null,
        buyTaxPct: null, sellTaxPct: null,
        taxRateBps: null, taxRatePct: null,
        dividendBps: null, dividendPct: null,
        quoteToken: '', dividendToken: '', marketingWallet: '',
      };
    }
  }

  // ── 总发行量 / decimals（市值唯一口径）──────────────────────────
  _ensureSupply(rec) {
    if (!rec._supplyPromise) rec._supplyPromise = this._fetchSupply(rec);
    return rec._supplyPromise;
  }

  async _fetchSupply(rec, attempt = 0) {
    try {
      const t = new ethers.Contract(rec.ca, TOKEN_ABI, this.provider);
      const [dec, sup] = await Promise.all([t.decimals(), t.totalSupply()]);
      rec.decimals = Number(dec) || 18;
      if (sup && sup > 0n) {
        const tamount = ethers.formatUnits(sup, rec.decimals);
        rec.totalSupply = tamount;
        const token = this.store ? this.store.get(rec.ca) : null;
        if (token) { token.tamount = tamount; token.totalSupply = tamount; }
      }
      return rec.totalSupply;
    } catch (e) {
      if (attempt + 1 < 4) {
        await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
        return this._fetchSupply(rec, attempt + 1);
      }
      console.warn(`[FLAP] 总发行量获取失败 ${rec.ca}: ${e.message}`);
      return null;
    }
  }

  // ── (3) IPFS 元数据 / 媒体链接 ───────────────────────────────────
  async _fetchMeta(rec, attempt = 0) {
    if (rec._metaDone) return;
    let cid = rec.meta;
    if (!cid) {
      try {
        const t = new ethers.Contract(rec.ca, TOKEN_ABI, this.provider);
        cid = String(await t.metaURI());
        rec.meta = cid;
      } catch (_) {}
    }
    if (!cid) return;

    // attempt 0 用 flap 专用网关；之后依次换公共网关（403 / 超时自动回退）
    const url = this._ipfsUrl(cid, attempt === 0 ? -1 : attempt - 1);
    if (!url) return;

    const t0 = Date.now();
    let timer = null;
    try {
      let meta = null;
      let directImage = '';
      let mediaAddressTime;
      const inline = String(cid).trim();

      if (inline.startsWith('{')) {
        meta = JSON.parse(inline);
        mediaAddressTime = formatBeijingTimeMs(new Date());
      } else {
        const ctrl = new AbortController();
        timer = setTimeout(() => ctrl.abort(), this.cfg.ipfsTimeoutMs);
        const res = await fetch(url, {
          headers: { Accept: 'application/json,text/plain,image/*,*/*' },
          signal: ctrl.signal,
        });
        // 「获取时间」= 媒体链接返回的实时时间
        mediaAddressTime = formatBeijingTimeMs(new Date());
        clearTimeout(timer); timer = null;
        if (!res.ok) throw new Error('HTTP ' + res.status);

        const ctype = String(res.headers.get('content-type') || '').toLowerCase();
        if (/^(image|video|audio)\//.test(ctype)) {
          directImage = url;
        } else {
          const text = await res.text();
          try {
            meta = JSON.parse(text);
          } catch (_) {
            const s = text.trim();
            if (s && s.length < 500 && /^(ipfs:\/\/|https?:\/\/|Qm[1-9A-HJ-NP-Za-km-z]{20,}|baf[a-z0-9]{20,})/i.test(s)) {
              directImage = this._ipfsUrl(s);
            } else {
              directImage = url;
            }
          }
        }
      }

      rec._metaDone = true;
      meta = meta || {};
      const image = directImage || this._ipfsUrl(this._pickImage(meta));
      rec.image = image || null;
      const rawTwitter = meta.twitter || meta.twitterUrl || meta.x || null;

      const enrich = {
        image: image || null,
        fmSymbol: meta.symbol || meta.ticker || rec.symbol || null,
        fmName:   meta.name   || rec.name   || null,
        mediaAddressTime,
        metaCid: cid,
        metaUrl: url,
        description: meta.description || null,
        telegramUrl: meta.telegram || meta.telegramUrl || null,
        websiteUrl:  meta.website  || meta.websiteUrl  || null,
        platform: 'flap',
        taxRate: rec.taxRate,
        buyTaxRate: rec.buyTaxRate,
        sellTaxRate: rec.sellTaxRate,
        dividendBps: rec.dividendBps,
        _source: 'flap-ipfs',
      };
      if (rawTwitter) {
        const r = toReadableTwitter(rawTwitter);
        enrich.twitterUrl      = rawTwitter;
        enrich.twitterDisplay  = r.display;
        enrich.twitterHref     = r.href;
        enrich.twitterUsername = r.username;
      }
      if (this.store) this.store.enrich(rec.ca, enrich);

      this.emit('media_race', {
        ca: rec.ca,
        latency: Date.now() - (rec.createdAtMs || t0),
        source: 'flap-ipfs',
        attempt: attempt + 1,
      });

      if (image) {
        this.stats.mediaOk++;
        console.log(`[FLAP] 媒体获取 ${rec.symbol || rec.ca.slice(0, 10)} | ${mediaAddressTime} | ${Date.now() - t0}ms | ${image}`);
      } else {
        this.stats.mediaFail++;
        console.warn(`[FLAP] 元数据里没有图片字段 ${rec.ca} | keys:[${Object.keys(meta).join(',')}] | ${url}`);
      }
    } catch (e) {
      if (timer) clearTimeout(timer);
      if (attempt + 1 < this.cfg.ipfsRetries) {
        const t = setTimeout(() => this._fetchMeta(rec, attempt + 1), this.cfg.ipfsRetryDelayMs * (attempt + 1));
        if (t.unref) t.unref();
      } else {
        this.stats.mediaFail++;
        console.warn(`[FLAP] 媒体获取失败 ${rec.ca}: ${e.message} | ${url}`);
      }
    }
  }

  // 从元数据对象里挖出图片字段（兼容各种命名 / 嵌套）
  _pickImage(meta) {
    const visit = (obj, depth) => {
      if (obj == null || depth > 3) return '';
      if (typeof obj === 'string') return obj.trim();
      if (Array.isArray(obj)) {
        for (const it of obj) { const v = visit(it, depth + 1); if (v) return v; }
        return '';
      }
      if (typeof obj !== 'object') return '';

      for (const k of IMAGE_KEYS) {
        const v = obj[k];
        if (typeof v === 'string' && v.trim()) return v.trim();
        if (v && typeof v === 'object') {
          for (const uk of URL_KEYS) {
            if (typeof v[uk] === 'string' && v[uk].trim()) return v[uk].trim();
          }
          const r = visit(v, depth + 1);
          if (r) return r;
        }
      }
      for (const k of NEST_KEYS) {
        if (obj[k]) { const r = visit(obj[k], depth + 1); if (r) return r; }
      }
      for (const v of Object.values(obj)) {
        if (typeof v === 'string') {
          const s = v.trim();
          if (/^(ipfs:\/\/|https?:\/\/[^\s]*\/ipfs\/|Qm[1-9A-HJ-NP-Za-km-z]{20,}|baf[a-z0-9]{20,})/i.test(s)) return s;
        }
      }
      return '';
    };
    return visit(meta, 0);
  }

  // 把任意形态的引用规范化为 CID(+路径)；不是 IPFS 引用则返回 null
  _cidPath(v) {
    let s = String(v || '').trim();
    if (!s) return null;
    if (/^data:/i.test(s)) return null;
    if (/^https?:\/\//i.test(s)) {
      const m = s.match(/\/ipfs\/([^?#]+)/i);
      return m && m[1] ? m[1].replace(/^\/+/, '') : null;
    }
    s = s.replace(/^ipfs:\/\//i, '');
    const idx = s.indexOf('/ipfs/');
    if (idx >= 0) s = s.slice(idx + 6);
    s = s.replace(/^\/+/, '');
    s = s.replace(/^ipfs\//i, '');   // ★ 修正 "ipfs/Qm..." -> 避免 /ipfs/ipfs/Qm... 404
    s = s.replace(/^\/+/, '');
    return s || null;
  }

  // gatewayIdx < 0 -> flap 专用网关；>= 0 -> 公共网关轮换
  _ipfsUrl(cid, gatewayIdx = -1) {
    const raw = String(cid || '').trim();
    if (!raw) return '';
    if (/^data:/i.test(raw)) return raw;
    const path = this._cidPath(raw);
    if (!path) return /^https?:\/\//i.test(raw) ? raw : '';
    const base = gatewayIdx >= 0
      ? FALLBACK_GATEWAYS[gatewayIdx % FALLBACK_GATEWAYS.length]
      : String(this.cfg.IPFS || FALLBACK_GATEWAYS[0]);
    return base.replace(/\/+$/, '') + '/' + path;
  }

  _stableQuote(rec) {
    const q = rec && rec.taxInfo ? String(rec.taxInfo.quoteToken || '') : '';
    return q && this._stables.has(q) ? q : null;
  }

  _toNum(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return v;
    try { return parseInt(String(v), String(v).startsWith('0x') ? 16 : 10); } catch (_) { return null; }
  }

  _trim() {
    const max = this.cfg.maxTrackedTokens || 8000;
    if (this._tokens.size <= max) return;
    let extra = this._tokens.size - max;
    for (const key of this._tokens.keys()) {
      if (extra <= 0) break;
      const rec = this._tokens.get(key);
      if (!rec || !rec.registered) { this._tokens.delete(key); extra--; }
    }
  }

  // ── 对外查询 ─────────────────────────────────────────────────
  getStats() {
    return Object.assign({}, this.stats, {
      tracked: this._tokens.size,
      connected: this.connected,
      startedAt: this._startedAt ? formatBeijingTimeMs(new Date(this._startedAt)) : null,
      taxHelperV2: this._helperV2,
      filter: { maxTaxRate: this.cfg.MAX_TAX_RATE, targetDividendBps: this.cfg.TARGET_DIVIDEND_BPS },
    });
  }

  getTokens(onlyVisible = true) {
    const out = [];
    for (const rec of this._tokens.values()) {
      if (onlyVisible && !rec.visible) continue;
      out.push({
        ca: rec.ca, tokenAddress: rec.ca,
        symbol: rec.symbol, name: rec.name,
        platform: 'flap', visible: rec.visible,
        taxRate: rec.taxRate,
        buyTaxRate: rec.buyTaxRate, sellTaxRate: rec.sellTaxRate,
        buyTaxBps: rec.buyTaxBps, sellTaxBps: rec.sellTaxBps,
        dividendBps: rec.dividendBps,
        dividendPct: rec.dividendBps === null ? null : rec.dividendBps / 100,
        totalSupply: rec.totalSupply || null,
        metaCid: rec.meta || null,
        image: rec.image || null,
        programGetTime: rec.programGetTime,
      });
    }
    return out;
  }

  isFlap(ca) { return this._tokens.has(String(ca || '').toLowerCase()); }
}

module.exports = FlapWatcher;
module.exports.FlapWatcher = FlapWatcher;
module.exports.FlapWssChannel = FlapWssChannel;
