'use strict';
/**
 * trader.js — 交易策略引擎
 *
 * 策略：追踪钱包买入触发，市值<5.1K买入0.01BNB
 * 五档止盈：6K→30% | 8K→20% | 12K→20% | 23K→20% | 50K→10%
 */

const { EventEmitter } = require('events');

class TradingEngine extends EventEmitter {
  constructor(config, blockchainService, storage) {
    super();
    this.config = config;
    this.chain = blockchainService;
    this.storage = storage || null;
    this.positions = new Map();
    this.tradeHistory = [];
    this._processing = new Set();
    this.bnbPriceUSD = config.fixedBNBPrice || 580;
    this._restore();
  }

  _restore() {
    if (!this.storage) return;
    const s = this.storage.state;
    if (Array.isArray(s.tradeHistory)) this.tradeHistory = s.tradeHistory.slice(0, 500);
    if (Array.isArray(s.positions)) {
      for (const p of s.positions) {
        if (p && p.tokenAddress) this.positions.set(p.tokenAddress, p);
      }
      console.log(`[Trader] ♻️ 恢复 ${this.positions.size} 个持仓 / ${this.tradeHistory.length} 条记录`);
    }
  }

  _persist() {
    if (!this.storage) return;
    this.storage.update({
      positions: Array.from(this.positions.values()),
      tradeHistory: this.tradeHistory.slice(0, 500),
    });
  }

  setBNBPrice(price) { if (price > 0) this.bnbPriceUSD = price; }

  // ═══════════════════════════════════════════════════════════════════════════
  //  追踪钱包触发买入
  // ═══════════════════════════════════════════════════════════════════════════

  async onMatched(token) {
    const tokenAddress = token.tokenAddress || token.address;
    const tokenId = token.tokenId;
    if (!tokenAddress || !tokenId) return;
    if (this.positions.has(tokenAddress)) return;
    if (this._processing.has(tokenId)) return;
    this._processing.add(tokenId);

    try {
      console.log(`[Trader] 🚀 追踪钱包买入 ${token.symbol || token.name} | ${tokenAddress.slice(0,10)}... | ${this.config.buyAmountBNB} BNB | ${token.matchReason}`);

      const result = await this.chain.buyToken(tokenAddress, this.config.buyAmountBNB, (confirmed) => {
        const pos = this.positions.get(tokenAddress);
        if (pos) {
          if (confirmed.tokenReceived) pos.tokenReceived = confirmed.tokenReceived;
          if (confirmed.blockNumber)   pos.buyBlock = confirmed.blockNumber;
          pos.buyConfirmed = confirmed.status === 1;
          this._persist();
          this.emit('trade_update', { txHash: confirmed.txHash, tokenReceived: pos.tokenReceived, blockNumber: confirmed.blockNumber, status: confirmed.status });
        }
      });

      const trade = {
        type: 'BUY',
        strategy: 'wallet',
        tokenId, tokenAddress,
        symbol: token.symbol,
        name: token.name || token.fmName,
        image: token.image,
        time: new Date().toLocaleString('zh-CN', { hour12: false }),
        bnbSpent: this.config.buyAmountBNB,
        tokenReceived: '0',
        txHash: result.txHash,
        success: result.success,
        error: result.error || null,
        simulated: result.simulated || false,
        marketCapAtBuy: token.marketCapUSD || 0,
        pending: !!result.pending,
        matchReason: token.matchReason || '',
      };

      this.tradeHistory.unshift(trade);
      if (this.tradeHistory.length > 500) this.tradeHistory.length = 500;

      if (result.success) {
        this.positions.set(tokenAddress, {
          tokenId, tokenAddress,
          symbol: token.symbol,
          name: token.name || token.fmName,
          image: token.image,
          strategy: 'wallet',
          buyTime: new Date().toISOString(),
          bnbSpent: this.config.buyAmountBNB,
          tokenReceived: '0',
          buyTxHash: result.txHash,
          buyConfirmed: false,
          sold1: false, sold2: false, sold3: false, sold4: false, sold5: false,
          currentMarketCap: 0,
          marketCapAtBuy: token.marketCapUSD || 0,
        });
        token.bought = true;
        token.txBuy = result.txHash;
        token.buyStatus = 'pending';
      } else {
        token.buyStatus = 'failed';
        console.error(`[Trader] ❌ 买入失败: ${result.error}`);
      }

      this.emit('trade', trade);
      this._persist();
    } catch (err) {
      token.buyStatus = 'failed';
      console.error('[Trader] 买入异常:', err.message);
    } finally {
      this._processing.delete(tokenId);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  价格更新 → 五档止盈
  //  6K→30% | 8K→20% | 12K→20% | 23K→20% | 50K→10%
  // ═══════════════════════════════════════════════════════════════════════════

  async onPriceUpdate(tokenAddress, marketCapUSD, token) {
    if (!tokenAddress) return;
    const position = this.positions.get(tokenAddress);
    if (!position) return;
    position.currentMarketCap = marketCapUSD;

    const tiers = [
      { key: 'sold1', threshold: this.config.sellThreshold1USD, ratio: this.config.sellRatio1 },
      { key: 'sold2', threshold: this.config.sellThreshold2USD, ratio: this.config.sellRatio2 },
      { key: 'sold3', threshold: this.config.sellThreshold3USD, ratio: this.config.sellRatio3 },
      { key: 'sold4', threshold: this.config.sellThreshold4USD, ratio: this.config.sellRatio4 },
      { key: 'sold5', threshold: this.config.sellThreshold5USD, ratio: this.config.sellRatio5 },
    ];

    for (let i = 0; i < tiers.length; i++) {
      const tier   = tiers[i];
      const prevOk = i === 0 ? true : !!position[tiers[i - 1].key];
      if (prevOk && !position[tier.key] && marketCapUSD >= tier.threshold) {
        await this._sellTier(tokenAddress, token, position, i + 1, tier.ratio, marketCapUSD);
        break;
      }
    }
  }

  async _sellTier(tokenAddress, token, position, tier, ratio, marketCapUSD) {
    const tokenId = position.tokenId || tokenAddress;
    const lockKey = `${tokenId}_sell${tier}`;
    if (this._processing.has(lockKey)) return;
    this._processing.add(lockKey);

    try {
      console.log(`[Trader] 📈 第${tier}档 | MC:$${Math.round(marketCapUSD).toLocaleString()} | 卖 ${(ratio * 100).toFixed(0)}%`);

      const result = await this.chain.sellToken(tokenAddress, ratio, (confirmed) => {
        this.emit('trade_update', { txHash: confirmed.txHash, bnbReceived: confirmed.bnbReceived, status: confirmed.status });
        this._persist();
      });

      const trade = {
        type: `SELL_${tier}`,
        tokenId, tokenAddress,
        symbol: token?.symbol || position.symbol,
        name: position.name,
        image: position.image,
        time: new Date().toLocaleString('zh-CN', { hour12: false }),
        ratio,
        bnbReceived: result.bnbReceived || '0',
        soldAmount:  result.soldAmount  || '0',
        txHash: result.txHash || null,
        success: result.success,
        error: result.error || null,
        simulated: result.simulated || false,
        marketCapAtSell: marketCapUSD,
        pending: !!result.pending,
      };

      this.tradeHistory.unshift(trade);
      if (this.tradeHistory.length > 500) this.tradeHistory.length = 500;

      if (result.success) {
        position[`sold${tier}`] = true;
        if (token) { token[`sold${tier}`] = true; token[`txSell${tier}`] = result.txHash; }
        // 第5档清仓
        if (tier === 5) this.positions.delete(tokenAddress);
      }

      this.emit('trade', trade);
      this._persist();
    } catch (err) {
      console.error(`[Trader] 第${tier}档异常:`, err.message);
    } finally {
      this._processing.delete(lockKey);
    }
  }

  getPositions()    { return Array.from(this.positions.values()); }
  getTradeHistory() { return this.tradeHistory; }
  hasPosition(tokenAddress) { return this.positions.has(tokenAddress); }
}

module.exports = TradingEngine;
