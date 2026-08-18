'use strict';
/**
 * flap-config.js — FLAP(flap.sh) 监控 / 交易配置
 *
 * 与 config.js 解耦：four.meme 的配置完全不变，FLAP 相关参数集中在此。
 * 所有值均可用环境变量覆盖（.env）。
 */

const { NETWORK } = require('./config');

const MAX_TAX_RATE    = Number(process.env.FLAP_MAX_TAX_RATE    || 5);    // %
const TARGET_DIVIDEND = Number(process.env.FLAP_TARGET_DIVIDEND || 100);  // % -> dividendBps === 10000

module.exports = {
  // 合约地址
  PORTAL:     process.env.FLAP_PORTAL     || '0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0',
  TAX_HELPER: process.env.FLAP_TAX_HELPER || '0x53841c73217735F37BC1775538b03b23feFD8346',
  IPFS:       process.env.FLAP_IPFS       || 'https://flap.mypinata.cloud/ipfs/',

  // 事件 Topics
  // TokenCreated(uint256 ts,address creator,uint256 nonce,address token,string name,string symbol,string meta)
  TOPIC_CREATED: '0x504e7f360b2e5fe33cbaaae4c593bc55305328341bf79009e43e0e3b7f699603',
  // TokenBought(uint256 ts,address token,address buyer,uint256 amount,uint256 eth,uint256 fee,uint256 postPrice)
  TOPIC_BOUGHT:  '0xa800a2038683844fac66747f771bfdfae862eb28b16bcfa387afa9fbacce8ff7',
  // TokenSold(uint256 ts,address token,address seller,uint256 amount,uint256 eth,uint256 fee,uint256 postPrice)
  TOPIC_SOLD:    '0x03a4693e592f5e75dc7c136acb39b146d2b4966c0e509c34f362dee02b3b861a',

  // 前端显示过滤（后端仍监控全部）
  MAX_TAX_RATE,
  TARGET_DIVIDEND,
  MAX_TAX_BPS:         Math.round(MAX_TAX_RATE * 100),     // 5%   -> 500 bps
  TARGET_DIVIDEND_BPS: Math.round(TARGET_DIVIDEND * 100),  // 100% -> 10000 bps

  // 节点（复用 four.meme 的 BSC 节点）
  wssCreateUrl: process.env.FLAP_WSS_CREATE || NETWORK.bscWssCreate,
  wssTradeUrl:  process.env.FLAP_WSS_TRADE  || NETWORK.bscWssTrade,
  rpcUrl:       process.env.FLAP_RPC        || NETWORK.bscRpcUrl,

  // 市值 / 元数据
  bnbPriceUSD:      Number(process.env.FLAP_BNB_PRICE_USD || 600),
  defaultSupply:    1000000000,   // FLAP 标准发行量 1B（真实值仍以 totalSupply() 为准）
  ipfsTimeoutMs:    4000,
  ipfsRetries:      8,
  ipfsRetryDelayMs: 400,
  taxRetries:       5,
  taxRetryDelayMs:  250,
  maxTrackedTokens: 8000,

  // 交易（与 four.meme 同一钱包 / 同一 nonce 管理）
  buyGasLimit:     Number(process.env.FLAP_BUY_GAS     || 700000),
  sellGasLimit:    Number(process.env.FLAP_SELL_GAS    || 900000),
  approveGasLimit: Number(process.env.FLAP_APPROVE_GAS || 120000),

  // 稳定币计价（quoteToken 命中时市值按 U 计算，不再乘 BNB 价）
  stableQuoteTokens: [
    '0x55d398326f99059ff775485246999027b3197955', // USDT
    '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', // USDC
    '0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d', // USD1
  ],
};
