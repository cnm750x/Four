'use strict';
/**
 * maker.js — 真实交易发起人（maker / GMGN 口径）解析
 *
 * ── 为什么交易明细地址会和 GMGN 个别不一致 ────────────────────────────────
 *   four.meme 的 TOKEN_BUY / TOKEN_SELL 事件（chain.js: decoded[1]）和
 *   FLAP 的 TokenBought / TokenSold 事件（flap.js: decoded[2]）里记录的地址，
 *   是「合约入账地址」（account / recipient / payer），不是交易签名者。
 *
 *   绝大多数散户直连合约时：入账地址 === tx.from  → 两边一致。
 *   但下列情况下二者不同（就是你看到的"个别不一致"）：
 *     ① 通过路由 / 聚合器买卖（GMGN、OKX Web3、Bullx、Pancake 路由等）
 *        → 事件里记录的是路由合约或收币地址
 *     ② 抢跑 / 狙击机器人（Maestro、Banana、自建合约）代持买入
 *     ③ 合约钱包 / 多签 / EIP-7702 委托钱包
 *     ④ 一笔交易帮别人买（recipient ≠ 签名者）
 *   GMGN 交易明细展示的"交易者"= 这笔交易的签名者 tx.from（maker）。
 *
 * ── 修正方式 ──────────────────────────────────────────────────────────────
 *   不阻塞毫秒级首屏：交易先按事件地址即时上屏，随后异步用 txHash 查
 *   eth_getTransactionByHash 的 from（= GMGN 的交易者）；若与事件地址不同，
 *   回写 store 中的这条交易并向前端推送补丁事件 trade_maker。
 *   同时用 tx.from 复查追踪(KOL)钱包 —— 之前走路由的 KOL 买入会被漏掉。
 */

const { ethers } = require('ethers');

class MakerResolver {
  /**
   * @param {object} opts
   *   rpcUrl        BSC HTTP RPC
   *   provider      可选，外部已有的 ethers Provider
   *   retries       查询重试次数（日志刚落块时可能查不到）
   *   retryDelayMs  重试间隔
   *   timeoutMs     单次查询超时
   *   maxCache      txHash → from 缓存上限
   */
  constructor(opts = {}) {
    this.rpcUrl = opts.rpcUrl || '';
    this._provider = opts.provider || null;
    this.retries = opts.retries === undefined ? 3 : opts.retries;
    this.retryDelayMs = opts.retryDelayMs || 180;
    this.timeoutMs = opts.timeoutMs || 4000;
    this.maxCache = opts.maxCache || 20000;

    this._cache = new Map();      // txHash(lower) → from(lower)
    this._inflight = new Map();   // txHash(lower) → Promise
    this.stats = { asked: 0, cacheHit: 0, resolved: 0, failed: 0, mismatched: 0 };
  }

  /** 懒加载 provider（启动早期 blockchain 还没 init 也能用） */
  provider() {
    if (this._provider) return this._provider;
    if (!this.rpcUrl) return null;
    try {
      this._provider = new ethers.JsonRpcProvider(this.rpcUrl);
      console.log(`[Maker] \u2705 交易者解析已启用 | RPC: ${this.rpcUrl}`);
    } catch (err) {
      console.warn(`[Maker] \u26A0\uFE0F provider 创建失败: ${err.message}`);
      this._provider = null;
    }
    return this._provider;
  }

  setProvider(p) { if (p) this._provider = p; }

  _remember(hash, from) {
    if (this._cache.size >= this.maxCache) {
      // 简单裁剪：丢弃最早的 1/5
      let n = Math.floor(this.maxCache / 5);
      for (const k of this._cache.keys()) {
        this._cache.delete(k);
        if (--n <= 0) break;
      }
    }
    this._cache.set(hash, from);
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  _withTimeout(promise) {
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; resolve(null); } }, this.timeoutMs);
      promise.then(v => {
        if (done) return;
        done = true; clearTimeout(timer); resolve(v);
      }).catch(() => {
        if (done) return;
        done = true; clearTimeout(timer); resolve(null);
      });
    });
  }

  /**
   * 解析 txHash 的真实签名者（GMGN 展示的交易者）
   * @returns {Promise<string|null>} 小写地址，失败返回 null
   */
  resolve(txHash) {
    const hash = String(txHash || '').toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(hash)) return Promise.resolve(null);

    if (this._cache.has(hash)) {
      this.stats.cacheHit++;
      return Promise.resolve(this._cache.get(hash));
    }
    if (this._inflight.has(hash)) return this._inflight.get(hash);

    const provider = this.provider();
    if (!provider) return Promise.resolve(null);

    this.stats.asked++;
    const task = (async () => {
      for (let attempt = 0; attempt <= this.retries; attempt++) {
        const tx = await this._withTimeout(provider.getTransaction(hash));
        const from = tx && tx.from ? String(tx.from).toLowerCase() : null;
        if (from) {
          this._remember(hash, from);
          this.stats.resolved++;
          return from;
        }
        if (attempt < this.retries) await this._sleep(this.retryDelayMs);
      }
      this.stats.failed++;
      return null;
    })();

    this._inflight.set(hash, task);
    task.finally(() => this._inflight.delete(hash));
    return task;
  }

  getStats() {
    return { ...this.stats, cached: this._cache.size, inflight: this._inflight.size };
  }
}

module.exports = { MakerResolver };
