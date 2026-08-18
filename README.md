# BitSticker — 优先级驱动 Four.meme + FLAP 自动交易机器人

BSC 链上 MEME 代币自动发现、匹配、买入、止盈系统。支持 **four.meme** 与 **FLAP** 两个平台。

---

## 架构概览

```
┌─────────── WSS-1: TOKEN_CREATE + 钱包监控 (publicnode) ────────────┐
│  subscribe#A: {address: FACTORY, topics: [TOKEN_CREATE_TOPIC]}      │
│    └─ TOKEN_CREATE → store.register (新币发现)                      │
│  subscribe#B: {topics: [Transfer, [wallets]]}  ← 钱包卖出(补漏)    │
│  subscribe#C: {topics: [Transfer, null, [wallets]]} ← 钱包买入     │
└─────────────────────────────────────────────────────────┘

┌─────────── WSS-2: TOKEN_BUY (drpc) ──────────────────────┐
│  subscribe: {address: FACTORY, topics: [TOKEN_BUY_TOPIC]}          │
│    └─ TOKEN_BUY → store.updatePrice + store.addWalletSignal        │
└─────────────────────────────────────────────────────────┘

┌─────────── WSS-3: TOKEN_SELL (nodereal) ──────────────────┐
│  subscribe: {address: FACTORY, topics: [TOKEN_SELL_TOPIC]}         │
│    └─ TOKEN_SELL → store.updatePrice (市值更新)                    │
└─────────────────────────────────────────────────────────┘

┌─────────── WSS-4: FourMeme (完全独立) ──────────────────┐
│  @TOKEN_EVENT@0 → store.enrich (image, twitterUrl, symbol)         │
│  匿名URL → oEmbed(~500ms) ∥ socialdata(~4s) 并发竞速              │
└─────────────────────────────────────────────────────────┘

┌─────────── WSS-5/6: FLAP Portal (创建 / 买卖，毫秒级) ────────┐
│  subscribe: {address: PORTAL, topics: [TOPIC_CREATED]}             │
│    └─ TokenCreated → IPFS 元数据 + TaxHelper 税率/分红 → store    │
│  subscribe: {address: PORTAL, topics: [[BOUGHT, SOLD]]}            │
│    └─ TokenBought/TokenSold → updatePrice(实时价×总量) + addTrade  │
└─────────────────────────────────────────────────────────┘

         ↓ 所有数据写入（CA MAP 匹配）
┌─────────── TokenStore (唯一数据中心) ─────────────────────┐
│  tokenMap: Map<CA, Token>  ← CA 为唯一索引，token.platform 区分平台 │
│  每次写入 → _tryWalletBuy(token) → 满足条件 → trader.onMatched()  │
└─────────────────────────────────────────────────────────┘

         ↓ matched (同步直调)
┌─────────── TradingEngine + TradeRouter ──────────────────┐
│  platform=four → blockchain.buyToken (four.meme Proxy)             │
│  platform=flap → FlapTradeService.buyToken (FLAP Portal)          │
│  止盈五档与买入阈值两平台完全一致                                 │
└─────────────────────────────────────────────────────────┘
```

---

## 3 WSS 独立供应商架构

### 设计动机

单 WSS 连接订阅工厂全部事件（CREATE + BUY + SELL），在交易量大时产生数据洪流，
导致单供应商配额耗尽 → 限速 → 断连 → 丢失关键事件。

### 解决方案

将 3 种事件分流到 3 条独立 WSS 连接，**各用不同 RPC 供应商**，彻底消除共享配额：

| 通道 | 事件类型 | 流量级别 | 供应商 | 端点 |
|------|---------|----------|--------|------|
| WSS-1 | TOKEN_CREATE + Transfer(钱包监控) | 低 | publicnode | `wss://bsc-rpc.publicnode.com` |
| WSS-2 | TOKEN_BUY | **高** | drpc | `wss://bsc.drpc.org` |
| WSS-3 | TOKEN_SELL | **高** | nodereal | `wss://bsc.nodereal.io/ws/v1/...` |
| WSS-5 | FLAP TokenCreated | 低 | 可配置 | `FLAP_WSS_CREATE` |
| WSS-6 | FLAP TokenBought/Sold | **高** | 可配置 | `FLAP_WSS_TRADE` |

### 核心特性

- **独立配额**：各供应商各自独立的请求配额，单通道限速不影响其他
- **独立重连**：每条 WSS 各自管理连接生命周期，断线后 1s 自动重连
- **独立容错**：WSS-3 断了不影响 WSS-1 发现新币 + WSS-2 钱包买入信号
- **状态聚合**：任一通道连接成功即视为系统可用，全部断开才 emit disconnected
- **零代码侵入**：对外事件接口不变，store / index / trader 无需修改

### WssChannel 复用设计

```js
class WssChannel {
  constructor(name, url, subscriptions, onLog, onStatus) { ... }
  // 轻量连接管理：start/stop/reconnect
  // 所有通道共享同一个 _dispatch 分发函数
}
```

---

## FLAP 平台监控（毫秒级）

### 链上合约与事件

| 项 | 值 |
|----|-----|
| Portal | `0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0` |
| TaxTokenHelper | `0x53841c73217735F37BC1775538b03b23feFD8346` |
| IPFS 网关 | `https://flap.mypinata.cloud/ipfs/` |
| TOPIC_CREATED | `0x504e7f360b2e5fe33cbaaae4c593bc55305328341bf79009e43e0e3b7f699603` |
| TOPIC_BOUGHT | `0xa800a2038683844fac66747f771bfdfae862eb28b16bcfa387afa9fbacce8ff7` |
| TOPIC_SOLD | `0x03a4693e592f5e75dc7c136acb39b146d2b4966c0e509c34f362dee02b3b861a` |

### 处理链路

1. **新币创建**（`TokenCreated`）：解码 tokenId / creator / token / name / symbol / metaURI，
   立即并发拉取：
   - `TaxTokenHelper.getTaxTokenInfo(token)` → `taxRate` / `dividendBps` / `quoteToken` / `marketingWallet`
   - `token.totalSupply()` → 总发行量（市值基数）
   - `IPFS + metaCid` → image / description / twitter / telegram / website
2. **媒体时间**：`mediaAddressTime` = 媒体（IPFS 元数据）返回那一刻的实时时间（毫秒级）
3. **交易明细**（`TokenBought` / `TokenSold`）：字段与前端 `fm_trade` 一一对应
   （side / sideLabel / volume / userAddress / txHash / blockNumber / time / marketCapUSD）
4. **市值**：`实时价格（买/卖事件推导） × 总发行量`；稳定币计价对不乘 BNB 价

### 前后端职责差异

- **后端**：监控 FLAP 链上 **全部** 新币创建事件与全部买/卖交易事件
- **前端**：仅展示 `税率 ≤ 5%` 且 `分红 = 100%（dividendBps === 10000）` 的代币
- 图片右下角角标区分平台：`FLAP`（金色）/ `FOUR`（蓝色），由 `public/flap-badge.js` 自动注入，
  不修改 `public/index.html`（由 `GET /` 服务端注入 script 标签）
- 交易逻辑（追踪钱包买入 + 市值阈值买入 + 五档止盈）与 four.meme 完全一致

### 新增接口

| 接口 | 说明 |
|------|------|
| `GET /api/platform-map` | `{tokens:[{tokenAddress, platform, taxRate, dividendBps}]}`，前端角标用 |
| `GET /api/flap/tokens?all=1` | FLAP 代币列表（默认仅可见，`all=1` 返回全量） |
| `GET /api/tokens?platform=flap` | 按平台筛选代币分页 |
| socket `flap_created` / `flap_token` / `flap_stats` | FLAP 专属事件 |

---

## 优先级原则

| 优先级 | 职责 | 实现方式 |
|--------|------|----------|
| ① 匹配 | 条件评估 | store 写入方法末尾同步调用 `_tryWalletBuy` |
| ② 条件判断 | 布尔值读取 | 纯同步，~0.01ms |
| ③ 瞬间买卖 | 发送交易 | `_onMatched` 同步直调 trader，不经事件循环 |
| ④ 前端推送 | Socket.IO | `setImmediate` 后置，永不阻塞主路径 |
| ⑤ 文件写入 | state.json | 2s debounce 批量写，异步追加 events.ndjson |

---

## 狙击条件（两平台一致）

| # | 条件 | 数据来源 | 触发写入方法 |
|---|------|----------|-------------|
| ① | 监控钱包对该 CA 有买入记录 | Chain WSS / FLAP WSS | `store.addWalletSignal()` |
| ② | 市值 < `walletBuyMCThreshold` | 买/卖事件价格计算 | `store.updatePrice()` |
| ③ | 名称未重复 | store 内部去重 | `_tryWalletBuy()` |
| ④ | （仅 FLAP）税率≤5% 且分红=100% | TaxTokenHelper | `flap.js` 入库前过滤 |

---

## 文件结构

```
src/
├── index.js         # 瘦编排层：接线 + 前端推送 + REST + 退出
├── config.js        # 统一配置：3条WSS端点/钱包/交易参数
├── chain.js         # 3条独立BSC WSS：WssChannel复用 + 统一_dispatch
├── fourmeme.js      # FourMeme WSS：TOKEN_EVENT 媒体补充
├── flap-config.js   # FLAP 配置：Portal/TaxHelper/IPFS/Topics/过滤阈值
├── flap.js          # FLAP 毫秒级监控：创建/买/卖 + IPFS元数据 + 税率分红过滤
├── flap-trade.js    # FLAP Portal 买/卖执行 + TradeRouter 平台路由
├── store.js         # TokenStore：唯一数据中心（含 platform 字段）
├── trader.js        # TradingEngine：纯买卖策略
├── blockchain.js    # BlockchainService：链上交互（nonce管理/发tx）
├── storage.js       # 持久化：state.json + events.ndjson
└── utils.js         # 公共工具函数

public/
├── index.html       # 前端页面（未修改）
└── flap-badge.js    # 图片右下角 FLAP/FOUR 平台角标（自动注入）
```

---

## 环境变量

```bash
# 3 条 BSC WSS（可按需替换供应商）
BSC_WSS_CREATE=wss://bsc-rpc.publicnode.com
BSC_WSS_BUY=wss://bsc.drpc.org
BSC_WSS_SELL=wss://bsc.nodereal.io/ws/v1/64a9df0874fb4a93b9d0a3849de012d3

# HTTP RPC（发交易/查余额）
BSC_RPC_URL=https://bsc-dataseed1.binance.org

# FLAP（均有默认值，可不配）
FLAP_PORTAL=0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0
FLAP_TAX_HELPER=0x53841c73217735F37BC1775538b03b23feFD8346
FLAP_IPFS=https://flap.mypinata.cloud/ipfs/
FLAP_WSS_CREATE=wss://bsc-rpc.publicnode.com
FLAP_WSS_TRADE=wss://bsc.drpc.org
FLAP_RPC=https://bsc-dataseed1.binance.org
FLAP_MAX_TAX_RATE=5          # 前端展示税率上限（%）
FLAP_TARGET_DIVIDEND=100     # 前端展示分红要求（%，100 → dividendBps===10000）
FLAP_BNB_PRICE_USD=600
FLAP_BUY_GAS=700000
FLAP_SELL_GAS=900000
FLAP_APPROVE_GAS=120000

# 其他配置见 src/config.js
```

---

## 运行

```bash
npm install
node src/index.js
```

---

## 数据流时间线示例

### four.meme

```
T+0ms      WSS-1: TOKEN_CREATE → store.register(ca)
T+200ms    WSS-4: TOKEN_EVENT → store.enrich(ca, {twitterUrl, image})
T+800ms    WSS-2: TOKEN_BUY(路人) → store.updatePrice(ca) → MC=$3200
T+1200ms   WSS-2: TOKEN_BUY(监控钱包) → addWalletSignal → \u{1F3AF} 触发买入
T+1203ms   buyToken 返回 tx hash（不等确认）
T+1204ms   setImmediate → io.emit('matched_token') → 前端显示
```

### FLAP

```
T+0ms      WSS-5: TokenCreated → 解码 token/name/symbol/metaCid
T+~80ms    TaxHelper.getTaxTokenInfo → taxRate=3% dividendBps=10000 → 通过过滤
T+~120ms   totalSupply → 市值基数
T+~250ms   IPFS 元数据返回 → image/twitter/telegram
           mediaAddressTime = 媒体返回那一刻的实时时间
T+~260ms   store.register(platform:'flap') → io.emit('new_token')
T+xxx      WSS-6: TokenBought/TokenSold → updatePrice(价×总量) + addTrade
           → io.emit('fm_trade', {platform:'flap', ...})
```
