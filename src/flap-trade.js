'use strict';
/**
 * flap-trade.js — FLAP 交易执行 + 平台路由
 *
 * 交易逻辑与 four.meme(blockchain.js) 完全一致：
 *   买入：提交后立即返回 txHash，链上确认异步回填（不阻塞主流程）
 *   卖出：首次 approve MAX（对 Portal），随后按持仓比例调用 Portal.sell
 *   GAS / nonce：复用 BlockchainService 的同一钱包与同一本地 nonce，
 *                避免两个平台并发下单时 nonce 冲突。
 *
 * 仅合约入口不同：
 *   four.meme -> TokenManager2.buyTokenAMAP / sell
 *   FLAP      -> Portal.buy(token,recipient,minAmount) / Portal.sell(token,amount,minEth)
 */

const { ethers } = require('ethers');

const PORTAL_ABI = [
  'function buy(address token, address recipient, uint256 minAmount) payable returns (uint256 amount)',
  'function sell(address token, uint256 amount, uint256 minEth) returns (uint256 eth)',
];

const ERC20_ABI = [
  'function balanceOf(address account) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

const MAX_UINT256 = (1n << 256n) - 1n;

class FlapTradeService {
  /**
   * @param {object} blockchainService 已初始化的 BlockchainService（共享 wallet / nonce / gasPrice）
   * @param {object} flapConfig       src/flap-config.js
   */
  constructor(blockchainService, flapConfig) {
    this.bs = blockchainService;
    this.cfg = flapConfig || require('./flap-config');
    this._portal = null;
    this._approved = new Set();
  }

  get initialized() { return !!(this.bs && this.bs.initialized); }

  _portalContract() {
    if (!this._portal && this.bs && this.bs.wallet) {
      this._portal = new ethers.Contract(this.cfg.PORTAL, PORTAL_ABI, this.bs.wallet);
    }
    return this._portal;
  }

  _gasPrice() { return this.bs ? this.bs._gasPrice : undefined; }
  _nonce()    { return this.bs && typeof this.bs._nextNonce === 'function' ? this.bs._nextNonce() : undefined; }
  _rollbackNonce() { if (this.bs && this.bs._nonce != null) this.bs._nonce -= 1; }

  // ── 买入 ───────────────────────────────────────────────────────
  async buyToken(tokenAddress, bnbAmount, onConfirmed) {
    const portal = this._portalContract();
    if (!this.initialized || !portal) {
      return { success: false, error: 'FLAP 交易服务未初始化', simulated: true };
    }
    try {
      const valueWei = ethers.parseEther(bnbAmount.toString());
      const nonce = this._nonce();

      console.log(`[FLAP-Buy] Portal.buy ${tokenAddress} | ${bnbAmount} BNB | nonce:${nonce}`);

      const tx = await portal.buy(tokenAddress, this.bs.wallet.address, 0n, {
        value: valueWei,
        gasLimit: BigInt(this.cfg.buyGasLimit),
        gasPrice: this._gasPrice(),
        nonce,
      });

      console.log(`[FLAP-Buy] 交易已发送: ${tx.hash}`);

      tx.wait(1).then(async (receipt) => {
        let tokenReceived = '0';
        try {
          const erc20 = new ethers.Contract(tokenAddress, ERC20_ABI, this.bs.provider);
          const dec = await erc20.decimals().catch(() => 18);
          const bal = await erc20.balanceOf(this.bs.wallet.address);
          tokenReceived = ethers.formatUnits(bal, Number(dec) || 18);
        } catch (_) {}
        console.log(`[FLAP-Buy] 已确认 block:${receipt.blockNumber} gas:${receipt.gasUsed}`);
        if (typeof onConfirmed === 'function') {
          onConfirmed({ txHash: tx.hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed.toString(), tokenReceived, status: receipt.status });
        }
      }).catch((err) => {
        console.error('[FLAP-Buy] 等待确认失败:', err.message);
        if (typeof onConfirmed === 'function') onConfirmed({ txHash: tx.hash, error: err.message, status: 0 });
      });

      return { success: true, txHash: tx.hash, pending: true };
    } catch (err) {
      console.error('[FLAP-Buy] 购买失败:', err.message);
      this._rollbackNonce();
      return { success: false, error: err.message || '未知错误' };
    }
  }

  // ── 卖出 ───────────────────────────────────────────────────────
  async sellToken(tokenAddress, ratio = 1.0, onConfirmed) {
    const portal = this._portalContract();
    if (!this.initialized || !portal) {
      return { success: false, error: 'FLAP 交易服务未初始化', simulated: true };
    }
    try {
      const erc20 = new ethers.Contract(tokenAddress, ERC20_ABI, this.bs.wallet);
      const dec = Number(await erc20.decimals().catch(() => 18)) || 18;
      const bal = await erc20.balanceOf(this.bs.wallet.address);
      if (bal === 0n) return { success: false, error: '代币余额为 0，无法出售' };

      const r = Math.max(0, Math.min(1, ratio));
      const amount = (bal * BigInt(Math.round(r * 10000))) / 10000n;
      if (amount === 0n) return { success: false, error: '出售数量为 0' };

      const key = String(tokenAddress).toLowerCase();
      if (!this._approved.has(key)) {
        try {
          const allowance = await erc20.allowance(this.bs.wallet.address, this.cfg.PORTAL);
          if (allowance < amount) {
            const approveTx = await erc20.approve(this.cfg.PORTAL, MAX_UINT256, {
              gasLimit: BigInt(this.cfg.approveGasLimit),
              gasPrice: this._gasPrice(),
              nonce: this._nonce(),
            });
            console.log(`[FLAP-Sell] approve MAX: ${approveTx.hash}`);
            await approveTx.wait(1);
          }
          this._approved.add(key);
        } catch (e) {
          console.warn('[FLAP-Sell] approve 失败:', e.message);
          return { success: false, error: 'approve 失败: ' + e.message };
        }
      }

      const tx = await portal.sell(tokenAddress, amount, 0n, {
        gasLimit: BigInt(this.cfg.sellGasLimit),
        gasPrice: this._gasPrice(),
        nonce: this._nonce(),
      });

      const soldAmountStr = ethers.formatUnits(amount, dec);
      console.log(`[FLAP-Sell] 交易已发送: ${tx.hash} | ratio:${(r * 100).toFixed(1)}% | 数量:${soldAmountStr}`);

      tx.wait(1).then((receipt) => {
        let bnbReceived = '0';
        try {
          if (this.bs && typeof this.bs._estimateBnbFromReceipt === 'function') {
            bnbReceived = this.bs._estimateBnbFromReceipt(receipt, this.bs.wallet.address);
          }
        } catch (_) {}
        console.log(`[FLAP-Sell] 已确认 block:${receipt.blockNumber} gas:${receipt.gasUsed} bnb:${bnbReceived}`);
        if (typeof onConfirmed === 'function') {
          onConfirmed({ txHash: tx.hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed.toString(), bnbReceived, status: receipt.status });
        }
      }).catch((err) => {
        console.error('[FLAP-Sell] 等待确认失败:', err.message);
        if (typeof onConfirmed === 'function') onConfirmed({ txHash: tx.hash, error: err.message, status: 0 });
      });

      return { success: true, txHash: tx.hash, soldAmount: soldAmountStr, pending: true };
    } catch (err) {
      console.error('[FLAP-Sell] 出售失败:', err.message);
      this._rollbackNonce();
      return { success: false, error: err.message || '未知错误' };
    }
  }

  async getTokenBalance(tokenAddress) {
    if (!this.bs || !this.bs.wallet) return '0';
    try {
      const erc20 = new ethers.Contract(tokenAddress, ERC20_ABI, this.bs.provider);
      const dec = Number(await erc20.decimals().catch(() => 18)) || 18;
      const bal = await erc20.balanceOf(this.bs.wallet.address);
      return ethers.formatUnits(bal, dec);
    } catch (_) { return '0'; }
  }
}

/**
 * TradeRouter — 按代币所属平台把买/卖路由到对应服务。
 * 对 TradingEngine 暴露与 BlockchainService 相同的接口，所以 5 档止盈等
 * 交易逻辑完全不需要改动。
 */
class TradeRouter {
  constructor({ four, flap, resolvePlatform }) {
    this.four = four;
    this.flap = flap;
    this.resolve = typeof resolvePlatform === 'function' ? resolvePlatform : () => 'four';
  }

  _pick(tokenAddress) {
    let platform = 'four';
    try { platform = this.resolve(tokenAddress) || 'four'; } catch (_) {}
    return platform === 'flap' && this.flap ? { svc: this.flap, platform: 'flap' } : { svc: this.four, platform: 'four' };
  }

  async init() { return this.four.init(); }
  get initialized() { return !!(this.four && this.four.initialized); }

  async buyToken(tokenAddress, bnbAmount, onConfirmed) {
    const picked = this._pick(tokenAddress);
    console.log(`[TradeRouter] 买入路由 -> ${picked.platform.toUpperCase()} | ${tokenAddress}`);
    return picked.svc.buyToken(tokenAddress, bnbAmount, onConfirmed);
  }

  async sellToken(tokenAddress, ratio, onConfirmed) {
    const picked = this._pick(tokenAddress);
    console.log(`[TradeRouter] 卖出路由 -> ${picked.platform.toUpperCase()} | ${tokenAddress} | ${(Math.max(0, Math.min(1, ratio)) * 100).toFixed(0)}%`);
    return picked.svc.sellToken(tokenAddress, ratio, onConfirmed);
  }

  getTokenBalance(tokenAddress) { return this.four.getTokenBalance(tokenAddress); }
  getBNBBalance()   { return this.four.getBNBBalance(); }
  getWalletAddress() { return this.four.getWalletAddress(); }
}

module.exports = { FlapTradeService, TradeRouter };
