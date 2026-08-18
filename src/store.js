'use strict';
/**
 * store.js — TokenStore 数据中心
 *
 * 狙击逻辑：追踪钱包买入 + 市值 < walletBuyMCThreshold 即触发买入
 *
 * 多平台：每个 token 携带 platform 字段（'four' | 'flap'），
 *        FLAP 代币额外携带 taxRate / buyTaxRate / sellTaxRate / dividendBps 等。
 *
 * ★ 无缓冲原则（CA 直接匹配）：
 *   updatePrice / addWalletSignal / addTrade / enrich 均以 tokenMap 里的 CA 为唯一依据，
 *   CA 不存在 → 直接丢弃，不做任何缓存 / 延迟回放。
 *
 * ★ 真实交易者（GMGN 口径）：
 *   交易先按事件地址毫秒上屏，再用 maker.js 异步解析 tx.from 回写，
 *   不同则 emit 'trade_maker' 让前端就地修正，并用 tx.from 复查 KOL 钱包。
 */

const { EventEmitter } = require('events');
const { formatBeijingTimeMs, parseBeijingTime, extractTweetId, TWITTER_EPOCH } = require('./utils');

class TokenStore extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.tokenMap = new Map();
    this.bnbPriceUSD = opts.bnbPriceUSD || 580;
    this.walletBuyMCThreshold = opts.walletBuyMCThreshold || 5100;
    this._onMatched = opts.onMatched || null;
    this._boughtNames = new Set();
    this._defaultSupply = 1073972602.739726;

    // 真实交易者解析（由 index.js 注入 MakerResolver）
    this._maker = null;
    this.watchWallets = new Map();   // address(lower) → KOL 名

    // 丢弃/修正计数（可在 /api/status 排查）
    this.stats = { dropPrice: 0, dropSignal: 0, dropTrade: 0, makerFixed: 0, makerKol: 0 };
  }

  setBNBPrice(price) {
    if (price > 0) this.bnbPriceUSD = price;
  }

  /** 注入真实交易者解析器（src/maker.js） */
  setMakerResolver(resolver) { this._maker = resolver || null; }

  /** 注入追踪钱包（用于 tx.from 复查 KOL） */
  setWatchWallets(list) {
    this.watchWallets = new Map(
      (list || [])
        .filter(w => w && w.address)
        .map(w => [String(w.address).toLowerCase(), w.name])
    );
  }

  /**
   * @param {object} extra 可选平台字段：
   *   platform ('four'|'flap') / taxRate / buyTaxRate / sellTaxRate /
   *   dividendBps / dividendPct / creator / metaCid / quoteToken / marketingWallet / tamount
   */
  register(ca, ticker, name, programGetTime, extra = null) {
    if (!ca || this.tokenMap.has(ca)) return null;
    const token = {
      tokenId: ca,
      tokenAddress: ca,
      symbol: ticker || '',
      name: name || '',
      programGetTime,
      arrivalTime: new Date(),
      image: null,
      twitterUrl: null, twitterDisplay: null, twitterHref: null, twitterUsername: null,
      mediaAddressTime: null, twitterCreatedAt: null, twitterContent: null, twitterContentTime: null,
      fmSymbol: null, fmName: null, tamount: null,
      // 多平台字段
      platform: 'four',
      taxRate: null, buyTaxRate: null, sellTaxRate: null,
      dividendBps: null, dividendPct: null,
      creator: null, metaCid: null, metaUrl: null,
      quoteToken: null, marketingWallet: null,
      description: null, telegramUrl: null, websiteUrl: null,
      walletSignals: [],
      trades: [],
      marketCapUSD: 0, _lastPrice: 0,
      matchReason: null,
      mediaSource: null, mediaLatencyMs: null,
      bought: false, sold1: false, sold2: false, sold3: false, sold4: false, sold5: false,
      txBuy: null, buyStatus: null,
      _enriched: false,
    };
    if (extra && typeof extra === 'object') {
      for (const [k, v] of Object.entries(extra)) {
        if (v === undefined) continue;
        token[k] = v;
      }
    }
    if (!token.platform) token.platform = 'four';
    this.tokenMap.set(ca, token);
    this.emit('registered', token);
    return token;
  }

  enrich(ca, data) {
    const token = this.tokenMap.get(ca);
    if (!token) return null;   // CA 不命中 → 直接丢弃，不缓存
    let changed = false;
    if (data.image && !token.image) { token.image = data.image; changed = true; }
    if (data.fmSymbol) { const s = String(data.fmSymbol).trim(); if (s && token.fmSymbol !== s) { token.fmSymbol = s; changed = true; } }
    if (data.fmName) { const n = String(data.fmName).trim(); if (n && !token.fmName) { token.fmName = n; changed = true; } }
    if (data.tamount && !token.tamount) { token.tamount = data.tamount; changed = true; }
    // 平台/元数据附加字段（FLAP）
    if (data.platform && token.platform !== data.platform) { token.platform = data.platform; changed = true; }
    if (data.taxRate !== undefined && data.taxRate !== null && token.taxRate !== data.taxRate) { token.taxRate = data.taxRate; changed = true; }
    if (data.buyTaxRate !== undefined && data.buyTaxRate !== null && token.buyTaxRate !== data.buyTaxRate) { token.buyTaxRate = data.buyTaxRate; changed = true; }
    if (data.sellTaxRate !== undefined && data.sellTaxRate !== null && token.sellTaxRate !== data.sellTaxRate) { token.sellTaxRate = data.sellTaxRate; changed = true; }
    if (data.dividendBps !== undefined && data.dividendBps !== null && token.dividendBps !== data.dividendBps) {
      token.dividendBps = data.dividendBps;
      token.dividendPct = data.dividendBps / 100;
      changed = true;
    }
    if (data.metaCid && !token.metaCid) { token.metaCid = data.metaCid; changed = true; }
    if (data.metaUrl && !token.metaUrl) { token.metaUrl = data.metaUrl; changed = true; }
    if (data.description && !token.description) { token.description = data.description; changed = true; }
    if (data.telegramUrl && !token.telegramUrl) { token.telegramUrl = data.telegramUrl; changed = true; }
    if (data.websiteUrl && !token.websiteUrl) { token.websiteUrl = data.websiteUrl; changed = true; }
    // 媒体链接返回时间（FLAP 无推特时也需记录）
    if (data.mediaAddressTime && !token.mediaAddressTime) { token.mediaAddressTime = data.mediaAddressTime; changed = true; }
    if (!token.mediaSource && data._source && changed) {
      token.mediaSource = data._source;
      token.mediaLatencyMs = token.arrivalTime instanceof Date ? Date.now() - token.arrivalTime.getTime() : 0;
    }
    if (data.twitterUrl && !token.twitterUrl) {
      token.twitterUrl = data.twitterUrl;
      token.twitterDisplay = data.twitterDisplay || null;
      token.twitterHref = data.twitterHref || null;
      token.twitterUsername = data.twitterUsername || null;
      token.mediaAddressTime = data.mediaAddressTime || token.mediaAddressTime || formatBeijingTimeMs(new Date());
      changed = true;
      if (!token.mediaSource) {
        token.mediaSource = data._source || 'wss';
        token.mediaLatencyMs = token.arrivalTime instanceof Date ? Date.now() - token.arrivalTime.getTime() : 0;
      }
      const tweetId = extractTweetId(token.twitterUrl);
      if (tweetId) {
        try {
          const ts = Number((BigInt(tweetId) >> 22n) + TWITTER_EPOCH);
          token.twitterCreatedAt = formatBeijingTimeMs(new Date(ts));
        } catch (_) {}
      }
    }
    if (data.twitterUrlRewrite && token.twitterUrl !== data.twitterUrlRewrite) {
      token.twitterUrl = data.twitterUrlRewrite;
      if (data.twitterHref) token.twitterHref = data.twitterHref;
      if (data.twitterDisplay) token.twitterDisplay = data.twitterDisplay;
      if (data.twitterUsername) token.twitterUsername = data.twitterUsername;
      changed = true;
    }
    if (data.twitterContent && !token.twitterContent) {
      token.twitterContent = data.twitterContent;
      token.twitterContentTime = data.twitterContentTime || formatBeijingTimeMs(new Date());
      changed = true;
    }
    if (changed) { this.emit('enriched', token); }
    return token;
  }

  updatePrice(ca, bnbAmount, tokenAmount, paymentToken) {
    const token = this.tokenMap.get(ca);
    if (!token) { this.stats.dropPrice++; return null; }   // 不缓冲，直接丢弃
    const bnbNum = parseFloat(bnbAmount) || 0;
    const tokNum = parseFloat(tokenAmount) || 0;
    if (bnbNum <= 0 || tokNum <= 0) return token;
    const priceBNB = bnbNum / tokNum;
    token._lastPrice = priceBNB;
    const totalSupply = parseFloat(token.tamount) || this._defaultSupply;
    const symbol = (token.symbol || '').toUpperCase();
    const isStablePayment = !!paymentToken;
    const priceUSD = (isStablePayment || ['USDT', 'USDC', 'USD1', 'U'].includes(symbol))
      ? priceBNB * totalSupply
      : priceBNB * totalSupply * this.bnbPriceUSD;
    token.marketCapUSD = priceUSD;
    // 尝试买入触发
    this._tryWalletBuy(token);
    this.emit('price_updated', { token, priceBNB, marketCapUSD: priceUSD });
    return token;
  }

  addWalletSignal(ca, signal) {
    const token = this.tokenMap.get(ca);
    if (!token) { this.stats.dropSignal++; return null; }   // 不缓冲，直接丢弃
    if (!signal) return token;
    // 去重（同一 txHash + 同一钱包只计一次）
    if (signal.txHash && token.walletSignals.some(s =>
      s.txHash === signal.txHash &&
      String(s.walletAddress || '').toLowerCase() === String(signal.walletAddress || '').toLowerCase()
    )) return token;
    token.walletSignals.push({
      time: signal.time,
      walletName: signal.walletName,
      walletAddress: signal.walletAddress,
      bnbAmount: signal.bnbAmount,
      tokenAmount: signal.tokenAmount,
      txHash: signal.txHash,
      marketCapUSD: signal.marketCapUSD || token.marketCapUSD || 0,
      action: signal.action,
    });
    this.emit('wallet_signal', { token, signal });
    if (signal.action === '买入') this._tryWalletBuy(token);
    return token;
  }

  /**
   * 狙击逻辑：追踪钱包买入 + 市值 < threshold 即触发买入
   * FLAP 与 four.meme 完全一致（FLAP 已在入库前完成税率/分红过滤）
   */
  _tryWalletBuy(token) {
    if (token.bought) return;
    if (token._walletBuyTriggered) return;
    // 必须有追踪钱包的买入信号
    const hasBuy = token.walletSignals && token.walletSignals.some(s => s.action === '买入');
    if (!hasBuy) return;
    const mc = token.marketCapUSD;
    if (!(mc > 0 && mc < this.walletBuyMCThreshold)) return;
    if (this._isNameDuplicate(token)) {
      console.log(`[Store] \u{1F6AB} 名称重复跳过: ${token.symbol || token.name} | CA:${token.tokenAddress}`);
      return;
    }
    token._walletBuyTriggered = true;
    token.matchReason = `追踪钱包买入 | 市值 $${Math.round(mc).toLocaleString()}`;
    console.log(`[Store] \u{1F3AF} 追踪钱包触发[${(token.platform || 'four').toUpperCase()}]: ${token.symbol} | CA:${token.tokenAddress} | ${token.matchReason}`);
    this._recordBoughtNames(token);
    if (this._onMatched) this._onMatched(token);
    this.emit('matched', token);
  }

  // chain.js 调用的存根（兼容旧调用，策略一/二已删除）
  setCreatorBuy(ca, data) { /* no-op */ }

  _isNameDuplicate(token) {
    for (const n of this._getTokenNames(token)) {
      if (this._boughtNames.has(n)) return true;
    }
    return false;
  }
  _recordBoughtNames(token) {
    for (const n of this._getTokenNames(token)) this._boughtNames.add(n);
  }
  _getTokenNames(token) {
    return [token.symbol, token.name].filter(r => r && String(r).trim() && String(r).trim() !== '—').map(r => String(r).trim());
  }

  addTrade(ca, trade) {
    const token = this.tokenMap.get(ca);
    if (!token) { this.stats.dropTrade++; return null; }   // 不缓冲，直接丢弃
    if (!token.trades) token.trades = [];
    const dedupKey = `${trade.txHash}|${trade.side}`;
    if (token.trades.some(t => `${t.txHash}|${t.side}` === dedupKey)) return token;
    trade.tokenSymbol   = token.symbol   || token.fmSymbol  || trade.tokenSymbol  || '';
    trade.tokenName     = token.name     || token.fmName    || trade.tokenName    || '';
    trade.tokenImage    = token.image    || trade.tokenImage || '';
    trade.tokenTwitterUrl  = token.twitterUrl     || '';
    trade.tokenTwitterDisp = token.twitterDisplay || '';
    trade.tokenTwitterHref = token.twitterHref    || '';
    trade.marketCapUSD  = token.marketCapUSD || 0;
    trade.platform      = trade.platform || token.platform || 'four';
    if (trade.taxRate === undefined || trade.taxRate === null) trade.taxRate = token.taxRate;
    if (trade.buyTaxRate === undefined || trade.buyTaxRate === null) trade.buyTaxRate = token.buyTaxRate;
    if (trade.sellTaxRate === undefined || trade.sellTaxRate === null) trade.sellTaxRate = token.sellTaxRate;
    if (trade.dividendBps === undefined || trade.dividendBps === null) trade.dividendBps = token.dividendBps;
    // 事件里的入账地址（可能是路由/机器人合约）先存一份
    trade.eventAddress = trade.eventAddress || trade.userAddress || null;
    // 无数量上限
    token.trades.push(trade);
    this.emit('trade_added', { token, trade });
    // ★ 上屏之后再异步校正为真实交易者（GMGN 口径）
    this._resolveTradeMaker(token, trade);
    return token;
  }

  /**
   * 异步用 txHash 拿 tx.from（GMGN 展示的交易者）校正交易明细地址
   * 不阻塞首屏；不一致时回写 + emit 'trade_maker' 供前端就地更新
   */
  _resolveTradeMaker(token, trade) {
    const resolver = this._maker;
    if (!resolver || !trade || !trade.txHash) return;
    const eventAddr = String(trade.userAddress || '').toLowerCase();

    resolver.resolve(trade.txHash).then((maker) => {
      if (!maker || maker === eventAddr) return;

      // 回写为真实发起人
      trade.eventAddress = eventAddr || trade.eventAddress || null;
      trade.userAddress  = maker;
      trade.makerFixed   = true;
      this.stats.makerFixed++;
      if (resolver.stats) resolver.stats.mismatched++;

      // tx.from 复查追踪(KOL)钱包：走路由/机器人的 KOL 交易之前会被漏掉
      const kol = this.watchWallets.get(maker) || null;
      if (kol) {
        trade.walletName = kol;
        trade.isWatch = true;
        this.stats.makerKol++;
        this.addWalletSignal(token.tokenId, {
          time: trade.time,
          walletName: kol,
          walletAddress: maker,
          action: trade.side === 'buy' ? '买入' : '卖出',
          bnbAmount: trade.bnbAmount,
          tokenAmount: trade.tokenAmount,
          txHash: trade.txHash,
          marketCapUSD: trade.marketCapUSD || token.marketCapUSD || 0,
        });
      }

      console.log(`[Store] \u{1F50D} 交易者校正 | ${eventAddr.slice(0, 10)}...(事件) \u2192 ${maker.slice(0, 10)}...(tx.from${kol ? ' / KOL:' + kol : ''}) | tx:${String(trade.txHash).slice(0, 12)}...`);

      this.emit('trade_maker', {
        tokenAddress: token.tokenId,
        txHash: trade.txHash,
        side: trade.side,
        userAddress: maker,
        eventAddress: trade.eventAddress,
        walletName: kol,
        isWatch: !!kol,
        platform: trade.platform || token.platform || 'four',
      });
    }).catch(() => {});
  }

  get(ca) { return this.tokenMap.get(ca) || null; }
  has(ca) { return this.tokenMap.has(ca); }
  get size() { return this.tokenMap.size; }
  getPlatform(ca) {
    const t = this.tokenMap.get(String(ca || '').toLowerCase()) || this.tokenMap.get(ca);
    return (t && t.platform) || 'four';
  }
  getAllTokens() {
    return Array.from(this.tokenMap.values()).sort((a, b) => b.arrivalTime - a.arrivalTime);
  }
  getStats() {
    return { ...this.stats, maker: this._maker && this._maker.getStats ? this._maker.getStats() : null };
  }

  destroy() { /* 无定时器需清理（早到缓冲已删除） */ }
}

module.exports = TokenStore;
