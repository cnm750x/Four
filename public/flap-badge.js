/**
 * flap-badge.js — 前端补丁脚本（由 src/index.js 在返回 index.html 时自动注入）
 *
 * 包含两个模块：
 *   A. 平台角标 + 买税/卖税/分红两行 + IPFS 图片多网关回退 + CA 字号放大
 *      • 图片右下角：FLAP（金色）/ FOUR（蓝色）
 *      • 图片下方 CA 之下：第一行「买税 1% · 卖税 1%」，第二行「分红 100%」
 *        颜色/字体直接取 CA 元素的 computedStyle，与 CA 完全一致
 *      • CA（及税率/分红两行）字号 = 原字号 x 1.5
 *      • IPFS 图片加载失败（专用网关 403 / 超时）时自动换公共网关重试
 *   B. 市值口径与 K 线修正 + 交易明细放大 + KOL 钱包金黄色整行高亮
 *      • K线市值与交易明细市值统一用后端 USD 原值，K / M 保留2位小数
 *      • K线横坐标：每根蜡烛 = 5 秒，每 6 根（30秒）一个时间刻度
 *      • 交易明细内所有数字字号 = 原字号 x 1.5
 *      • 命中追踪(KOL)钱包：整条背景金黄色 + 地址位置直接显示 KOL 名字
 */

/* ══════ 模块 A：平台角标 + 买税/卖税/分红两行 + 图片网关回退 ══════ */
(function () {
  'use strict';

  var MAP = Object.create(null);
  var RE_ADDR = /0x[a-fA-F0-9]{40}/;
  var RE_FULL = /^0x[a-f0-9]{40}$/;
  var CA_SCALE = 1.5;   // ★ CA 与税率/分红行字号放大倍数

  // IPFS 网关回退链（flap 专用网关对浏览器 Referer 常返回 403）
  var GATEWAYS = [
    'https://flap.mypinata.cloud/ipfs/',
    'https://ipfs.io/ipfs/',
    'https://cloudflare-ipfs.com/ipfs/',
    'https://dweb.link/ipfs/',
    'https://gateway.pinata.cloud/ipfs/'
  ];

  function norm(v) { return String(v == null ? '' : v).toLowerCase(); }

  function inferPlatform(ca) { return /(7777|8888)$/.test(ca) ? 'flap' : 'four'; }

  function pick(a, b) { return (a !== undefined && a !== null) ? a : b; }

  function put(ca, info) {
    var k = norm(ca);
    if (!RE_FULL.test(k)) return;
    var cur = MAP[k] || {};
    MAP[k] = {
      platform: (info && info.platform) || cur.platform || null,
      taxRate: pick(info && info.taxRate, cur.taxRate),
      buyTaxRate: pick(info && info.buyTaxRate, cur.buyTaxRate),
      sellTaxRate: pick(info && info.sellTaxRate, cur.sellTaxRate),
      dividendBps: pick(info && info.dividendBps, cur.dividendBps),
      dividendPct: pick(info && info.dividendPct, cur.dividendPct)
    };
  }

  function metaOf(ca) {
    var k = norm(ca);
    var e = MAP[k];
    var div = null, buy = null, sell = null, tax = null;
    if (e) {
      if (e.dividendPct != null) div = e.dividendPct;
      else if (e.dividendBps != null) div = e.dividendBps / 100;
      tax = e.taxRate != null ? e.taxRate : null;
      // ★ 买税/卖税取后端真实值；旧版只有单一 taxRate 时买卖同税
      buy = e.buyTaxRate != null ? e.buyTaxRate : tax;
      sell = e.sellTaxRate != null ? e.sellTaxRate : tax;
    }
    return {
      platform: (e && e.platform) ? e.platform : inferPlatform(k),
      taxRate: tax,
      buyTax: buy,
      sellTax: sell,
      dividendPct: div
    };
  }

  function trimNum(n) {
    var v = Number(n);
    if (!isFinite(v)) return null;
    return (Math.round(v * 100) / 100).toString();
  }

  function injectCss() {
    if (document.getElementById('pf-badge-css')) return;
    var css = ''
      + '.pf-wrap{position:relative;display:inline-block;line-height:0;max-width:100%}'
      + '.pf-badge{position:absolute;right:2px;bottom:2px;z-index:7;pointer-events:none;'
      + 'font-size:9px;line-height:1;font-weight:700;letter-spacing:.3px;padding:2px 3px;'
      + 'border-radius:4px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;'
      + 'box-shadow:0 0 0 1px rgba(0,0,0,.45);white-space:nowrap}'
      + '.pf-badge-flap{background:#f0b90b;color:#1b1b1b}'
      + '.pf-badge-four{background:#2b6cff;color:#fff}'
      + '.pf-line{display:block;white-space:nowrap;overflow:visible;margin:0;padding:0}'
      + '.pf-line-hide{display:none}'
      // CA 字号放大后，内部子元素跟随继承
      + '.addr-under-img *{font-size:inherit !important}'
      // ★ 交易明细里所有数字 x1.5（原 9px → 13.5px）
      + '.fm-trade-item{font-size:13.5px !important;line-height:1.45 !important;padding:1px 2px !important}'
      + '.fm-trade-item span{font-size:13.5px !important}'
      + '.fm-trade-item .fm-addr{max-width:none !important}'
      // ★ KOL 钱包命中：整条金黄色背景
      + '.fm-kol{background:linear-gradient(90deg,#ffd700 0%,#ffc107 100%) !important;'
      + 'border-left:3px solid #ff9800 !important;border-radius:3px !important;'
      + 'box-shadow:0 0 6px rgba(255,193,7,.35) !important}'
      + '.fm-kol span{color:#1b1b1b !important;font-weight:800 !important}';
    var el = document.createElement('style');
    el.id = 'pf-badge-css';
    el.textContent = css;
    (document.head || document.documentElement).appendChild(el);
  }

  var ATTRS = ['data-ca', 'data-token', 'data-address', 'data-token-address', 'data-id', 'data-key', 'id', 'title', 'href', 'alt'];

  function findCA(el) {
    var node = el, hops = 0;
    while (node && hops < 8) {
      if (node.getAttribute) {
        for (var i = 0; i < ATTRS.length; i++) {
          var v = node.getAttribute(ATTRS[i]);
          if (v) {
            var m = String(v).match(RE_ADDR);
            if (m) return m[0].toLowerCase();
          }
        }
      }
      var txt = node.textContent;
      if (txt && txt.length < 5000) {
        var m2 = txt.match(RE_ADDR);
        if (m2) return m2[0].toLowerCase();
      }
      node = node.parentElement;
      hops++;
    }
    return null;
  }

  function taxText(m) {
    var b = trimNum(m.buyTax), s = trimNum(m.sellTax);
    if (b !== null && s !== null) return '买税 ' + b + '% · 卖税 ' + s + '%';
    if (b !== null) return '买税 ' + b + '%';
    if (s !== null) return '卖税 ' + s + '%';
    var t = trimNum(m.taxRate);
    return t === null ? null : '税率 ' + t + '%';
  }

  function tipOf(m) {
    var tip = m.platform === 'flap' ? 'FLAP (flap.sh)' : 'FOUR.MEME';
    var tt = taxText(m);
    if (tt) tip += ' · ' + tt;
    if (m.dividendPct != null) tip += ' · 分红 ' + trimNum(m.dividendPct) + '%';
    return tip;
  }

  function paintBadge(badge, m) {
    badge.className = 'pf-badge pf-badge-' + m.platform;
    badge.textContent = m.platform === 'flap' ? 'FLAP' : 'FOUR';
    badge.title = tipOf(m);
  }

  /* ──── 买税/卖税 + 分红：CA 下面两行，颜色与 CA 一致 ──── */

  // 找到图片下方的 CA 元素（.addr-under-img）
  function findAddrEl(img) {
    var n = img.parentElement, hops = 0;
    while (n && hops < 6) {
      if (n.querySelector) {
        var a = n.querySelector('.addr-under-img');
        if (a) return a;
      }
      n = n.parentElement;
      hops++;
    }
    return null;
  }

  // ★ CA 字号 x1.5（只做一次，以原始 computedStyle 为基准）
  function scaleCA(addr) {
    try {
      if (addr.__pfScaled) return;
      var base = parseFloat(window.getComputedStyle(addr).fontSize) || 9;
      addr.__pfBaseFont = base;
      addr.style.fontSize = (Math.round(base * CA_SCALE * 10) / 10) + 'px';
      addr.style.lineHeight = '1.35';
      addr.__pfScaled = true;
    } catch (_) {}
  }

  function styleLike(el, addr) {
    try {
      var cs = window.getComputedStyle(addr);
      el.style.color = cs.color;                 // ★ 颜色与 CA 完全一致
      el.style.fontSize = cs.fontSize;           // ★ 同步放大后的字号
      el.style.fontFamily = cs.fontFamily;
      el.style.fontWeight = cs.fontWeight;
      el.style.letterSpacing = cs.letterSpacing;
      el.style.textAlign = cs.textAlign;
      el.style.lineHeight = cs.lineHeight;
      el.style.opacity = cs.opacity;
    } catch (_) {}
  }

  function makeLine(cls) {
    var el = document.createElement('div');
    el.className = 'pf-line ' + cls;
    return el;
  }

  function paintLines(img, m) {
    var addr = findAddrEl(img);
    if (!addr || !addr.parentNode) return;

    scaleCA(addr);

    // 避免被容器裁切
    try {
      var host = addr.parentElement;
      if (host && window.getComputedStyle(host).overflow === 'hidden') host.style.overflow = 'visible';
    } catch (_) {}

    var tax = addr.__pfTax;
    var dvd = addr.__pfDvd;
    if (!tax || !tax.parentNode) {
      tax = makeLine('pf-line-tax');
      addr.parentNode.insertBefore(tax, addr.nextSibling);   // 第一行：买税/卖税（紧跟 CA）
      addr.__pfTax = tax;
    }
    if (!dvd || !dvd.parentNode) {
      dvd = makeLine('pf-line-div');
      tax.parentNode.insertBefore(dvd, tax.nextSibling);     // 第二行：分红（税率下面）
      addr.__pfDvd = dvd;
    }

    styleLike(tax, addr);
    styleLike(dvd, addr);

    var tt = taxText(m);
    var d = trimNum(m.dividendPct);
    tax.textContent = tt === null ? '' : tt;
    dvd.textContent = d === null ? '' : '分红 ' + d + '%';
    tax.className = 'pf-line pf-line-tax' + (tt === null ? ' pf-line-hide' : '');
    dvd.className = 'pf-line pf-line-div' + (d === null ? ' pf-line-hide' : '');
    tax.title = tipOf(m);
    dvd.title = tipOf(m);
  }

  // 旧版本的头像内部蒙层（税率/分红）已废弃，遇到就清理
  function killLegacyInfo() {
    var olds = document.querySelectorAll('.pf-info');
    for (var i = 0; i < olds.length; i++) {
      if (olds[i].parentNode) olds[i].parentNode.removeChild(olds[i]);
    }
  }

  /* ──── IPFS 图片多网关回退 ──── */

  function ipfsPathOf(src) {
    var s = String(src || '');
    var i = s.indexOf('/ipfs/');
    if (i < 0) return null;
    var p = s.slice(i + 6).replace(/^\/+/, '');
    return p || null;
  }

  function gwIndexOf(src) {
    var s = String(src || '');
    for (var i = 0; i < GATEWAYS.length; i++) {
      if (s.indexOf(GATEWAYS[i]) === 0) return i;
    }
    return 0;
  }

  function nextGateway(img) {
    var p = img.__pfIpfs;
    if (!p) return false;
    var cur = (img.__pfGw == null) ? 0 : img.__pfGw;
    var next = cur + 1;
    if (next >= GATEWAYS.length) return false;
    img.__pfGw = next;
    var url = GATEWAYS[next] + p;
    img.__pfSrc = url;
    try { img.src = url; } catch (_) { return false; }
    try { console.log('[flap-img] 网关回退 -> ' + url); } catch (_) {}
    return true;
  }

  function watchImage(img) {
    try {
      if (img.getAttribute && img.getAttribute('data-pf-skip')) return;
      var cur = (img.getAttribute && img.getAttribute('src')) || img.src || '';
      var p = ipfsPathOf(cur);
      if (p && img.__pfIpfs !== p) {
        img.__pfIpfs = p;
        img.__pfSrc = cur;
        img.__pfGw = gwIndexOf(cur);
      }
      if (!img.__pfErrHook) {
        img.__pfErrHook = true;
        // 内联 onerror 可能把 src 换成占位图，所以延后一拍用缓存的 CID 重试
        img.addEventListener('error', function () {
          setTimeout(function () { nextGateway(img); }, 0);
        });
      }
      // 已经加载失败（含被占位图替换的情况）
      if (img.__pfIpfs && img.complete && img.naturalWidth === 0) nextGateway(img);
    } catch (_) {}
  }

  /* ──── 主流程 ──── */

  function apply(img) {
    try {
      if (!img || (img.getAttribute && img.getAttribute('data-pf-skip'))) return;
      var w = img.clientWidth || img.width || 0;
      var h = img.clientHeight || img.height || 0;
      if (w < 26 || h < 26) return;

      var ca = findCA(img);
      if (!ca) return;
      var m = metaOf(ca);
      var stamp = m.platform + '|' + m.buyTax + '|' + m.sellTax + '|' + m.dividendPct;

      if (img.__pfBadge && img.__pfBadge.parentNode && img.__pfCA === ca) {
        if (img.__pfStamp !== stamp) {
          paintBadge(img.__pfBadge, m);
          paintLines(img, m);
          img.__pfStamp = stamp;
          img.setAttribute('data-pf-badged', m.platform);
        } else {
          paintLines(img, m);   // 行可能因行重建而丢失
        }
        return;
      }
      if (img.__pfBadge && img.__pfBadge.parentNode) img.__pfBadge.parentNode.removeChild(img.__pfBadge);

      var badge = document.createElement('span');
      paintBadge(badge, m);

      var host = img.parentElement;
      var mount = null;
      if (host && host.classList && host.classList.contains('pf-wrap')) {
        mount = host;
      } else if (host && host.childElementCount === 1) {
        try { if (window.getComputedStyle(host).position === 'static') host.style.position = 'relative'; } catch (_) {}
        mount = host;
      } else if (host) {
        var wrap = document.createElement('span');
        wrap.className = 'pf-wrap';
        host.insertBefore(wrap, img);
        wrap.appendChild(img);
        mount = wrap;
      } else {
        return;
      }

      mount.appendChild(badge);

      img.__pfBadge = badge;
      img.__pfCA = ca;
      img.__pfStamp = stamp;
      img.setAttribute('data-pf-badged', m.platform);

      paintLines(img, m);
    } catch (_) {}
  }

  var scanQueued = false;
  function scan() {
    scanQueued = false;
    killLegacyInfo();
    var imgs = document.querySelectorAll('img');
    for (var i = 0; i < imgs.length; i++) {
      watchImage(imgs[i]);
      apply(imgs[i]);
    }
  }
  function queueScan() {
    if (scanQueued) return;
    scanQueued = true;
    setTimeout(scan, 120);
  }

  function absorb(t) {
    if (!t) return;
    var ca = t.tokenId || t.tokenAddress || t.ca || t.address;
    if (!ca) return;
    put(ca, {
      platform: t.platform,
      taxRate: t.taxRate,
      buyTaxRate: t.buyTaxRate,
      sellTaxRate: t.sellTaxRate,
      dividendBps: t.dividendBps,
      dividendPct: t.dividendPct
    });
  }

  function absorbList(json) {
    var list = (json && (json.tokens || json.list || json.data)) || (Array.isArray(json) ? json : []);
    for (var i = 0; i < list.length; i++) absorb(list[i]);
  }

  function loadMap() {
    try {
      fetch('/api/platform-map').then(function (r) { return r.json(); }).then(function (json) {
        absorbList(json);
        queueScan();
      }).catch(function () {});
      // ★ FLAP 真实买税/卖税（刷新页面后也能拿到）
      fetch('/api/flap/tokens?all=1').then(function (r) { return r.json(); }).then(function (json) {
        absorbList(json);
        queueScan();
      }).catch(function () {});
    } catch (_) {}
  }

  function hookSocket() {
    if (typeof window.io !== 'function') return false;
    try {
      var s = window.io();
      s.on('init', function (d) {
        var list = (d && d.tokens) || [];
        for (var i = 0; i < list.length; i++) absorb(list[i]);
        var pm = (d && d.platformMap) || [];
        for (var j = 0; j < pm.length; j++) absorb(pm[j]);
        queueScan();
      });
      s.on('new_token', function (t) { absorb(t); queueScan(); });
      s.on('token_enriched', function (t) { absorb(t); queueScan(); });
      s.on('matched_token', function (t) { absorb(t); queueScan(); });
      s.on('fm_trade', function (t) { absorb(t); queueScan(); });
      s.on('flap_token', function (t) { absorb(t); queueScan(); });
      return true;
    } catch (_) { return false; }
  }

  function boot() {
    injectCss();
    loadMap();
    if (!hookSocket()) setTimeout(hookSocket, 1500);

    try {
      var mo = new MutationObserver(function () { queueScan(); });
      mo.observe(document.body || document.documentElement, { childList: true, subtree: true });
    } catch (_) {}

    setInterval(scan, 1200);
    setInterval(loadMap, 60000);
    scan();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();


/* ══════ 模块 B：市值口径统一 + K线 5 秒横坐标 + 交易明细放大/KOL 高亮 ══════ */
(function () {
  'use strict';

  var CANDLE_SEC = 5;        // 每根蜡烛 = 5 秒
  var LABEL_EVERY = 6;       // 每 6 根（30 秒）一个时间刻度
  var MAX_CANDLES = 720;     // 720 * 5s = 60 分钟
  var FS = '13.5px';         // ★ 交易明细字号（原 9px x 1.5）

  // 统一市值格式：K / M，固定 2 位小数
  function fmtMC2(usd) {
    var v = Number(usd);
    if (!isFinite(v) || v <= 0) return '—';
    if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    return (v / 1000).toFixed(2) + 'K';
  }

  // 安全读取 index.html 内联脚本的全局声明（const/let 不在 window 上）
  function safe(fn, dflt) {
    try { var v = fn(); return v === undefined ? dflt : v; } catch (_) { return dflt; }
  }

  function esc(s) {
    var f = safe(function () { return escHtml; }, null);
    if (typeof f === 'function') return f(s);
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function shortA(a) {
    var f = safe(function () { return shortAddr; }, null);
    if (typeof f === 'function') return f(a);
    if (!a) return '—';
    return a.slice(0, 4) + '...' + a.slice(-4);
  }

  function states() { return safe(function () { return chartDataMap; }, null) || window.chartDataMap || {}; }

  function stateOf(tokenId) {
    var f = safe(function () { return getChartState; }, null);
    if (typeof f === 'function') return f(tokenId);
    var m = states();
    if (!m[tokenId]) m[tokenId] = { candles: [], startSec: null, allTimeMC: 0 };
    return m[tokenId];
  }

  function sel(tokenId) {
    try { return 'canvas[data-token-id="' + CSS.escape(tokenId) + '"]'; }
    catch (_) { return 'canvas[data-token-id="' + tokenId + '"]'; }
  }

  function timeLabel(ms) {
    var d = new Date(ms);
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  // ── 新 pushMCData：不再除 BNB 价，5 秒一根蜡烛 ──
  function pushMCData(tokenId, mcUSD) {
    var mc = Number(mcUSD);
    if (!tokenId || !isFinite(mc) || mc <= 0) return;
    var st = stateOf(tokenId);
    if (!st.candles) st.candles = [];
    var bucket = Math.floor(Date.now() / 1000 / CANDLE_SEC) * CANDLE_SEC;  // 5 秒对齐
    if (st.startSec === null || st.startSec === undefined) st.startSec = bucket;
    var t = Math.floor((bucket - st.startSec) / CANDLE_SEC);
    if (mc > (st.allTimeMC || 0)) st.allTimeMC = mc;
    st.lastMC = mc;

    var last = st.candles[st.candles.length - 1];
    if (last && last.t === t) {
      last.h = Math.max(last.h, mc);
      last.l = Math.min(last.l, mc);
      last.c = mc;
    } else {
      var open = last ? last.c : mc;
      st.candles.push({ t: t, o: open, h: Math.max(open, mc), l: Math.min(open, mc), c: mc });
      if (st.candles.length > MAX_CANDLES) st.candles.shift();
    }

    document.querySelectorAll(sel(tokenId)).forEach(function (cv) { window.drawChart(cv, tokenId); });
  }

  // ── 新 drawChart：Y 轴用 K/M(2位小数)，X 轴 5 秒/格 ──
  function drawChart(canvas, tokenId) {
    if (!canvas) return;
    var st = states()[tokenId];
    if (!st || !st.candles || !st.candles.length) return;

    var dpr = window.devicePixelRatio || 1;
    var rect = canvas.getBoundingClientRect();
    var W = Math.round(rect.width) || canvas.offsetWidth || 320;
    var H = Math.round(rect.height) || canvas.offsetHeight || 160;
    if (W < 10 || H < 10) return;
    var pxW = Math.round(W * dpr), pxH = Math.round(H * dpr);
    if (canvas.width !== pxW || canvas.height !== pxH) { canvas.width = pxW; canvas.height = pxH; }
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    var PAD_LEFT = 4, PAD_RIGHT = 56, PAD_TOP = 6, PAD_BOT = 13;
    var chartW = W - PAD_LEFT - PAD_RIGHT;
    var priceH = H - PAD_TOP - PAD_BOT;
    if (chartW < 20 || priceH < 20) return;

    ctx.fillStyle = '#0a0e14';
    ctx.fillRect(0, 0, W, H);

    var CANDLE_W = Math.max(2, Math.min(8, Math.floor(chartW / 60)));
    var GAP = Math.max(1, Math.floor(CANDLE_W * 0.35));
    var UNIT = CANDLE_W + GAP;
    var maxVisible = Math.max(1, Math.floor(chartW / UNIT));
    var visible = st.candles.slice(-maxVisible);
    var N = visible.length;

    var yMin = Infinity, yMax = -Infinity;
    visible.forEach(function (c) { yMin = Math.min(yMin, c.l); yMax = Math.max(yMax, c.h); });
    if (yMin === yMax) { yMin *= 0.95; yMax *= 1.05; }
    var pad = (yMax - yMin) * 0.12;
    yMin = Math.max(0, yMin - pad);
    yMax = yMax + pad;
    var yRange = (yMax - yMin) || 1;

    function niceStep(range, maxTicks) {
      var raw = range / maxTicks;
      var mag = Math.pow(10, Math.floor(Math.log10(raw)));
      var n = raw / mag;
      if (n <= 1) return mag;
      if (n <= 2) return 2 * mag;
      if (n <= 5) return 5 * mag;
      return 10 * mag;
    }
    function yPos(v) { return PAD_TOP + priceH - ((v - yMin) / yRange) * priceH; }

    var step = niceStep(yRange, 4);
    var firstTick = Math.ceil(yMin / step) * step;

    // 水平网格 + 右侧市值刻度（K/M 两位小数）
    ctx.font = "10px 'Inter', sans-serif";
    ctx.textAlign = 'right';
    ctx.setLineDash([]);
    for (var v = firstTick; v <= yMax + step * 0.01; v += step) {
      var y = Math.round(yPos(v));
      if (y < PAD_TOP - 2 || y > PAD_TOP + priceH + 2) continue;
      ctx.strokeStyle = 'rgba(26,45,71,0.6)';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(PAD_LEFT, y + 0.5);
      ctx.lineTo(PAD_LEFT + chartW, y + 0.5);
      ctx.stroke();
      ctx.fillStyle = '#5a7a9a';
      ctx.fillText(fmtMC2(v), W - 2, y + 3.5);
    }

    // 垂向时间网格 + X 轴刻度（每 6 根 = 30 秒）
    var xStart = PAD_LEFT;
    ctx.font = "9px 'Inter', sans-serif";
    ctx.textAlign = 'center';
    for (var i = 0; i < N; i++) {
      if ((N - 1 - i) % LABEL_EVERY !== 0) continue;
      var cx = Math.round(xStart + i * UNIT + CANDLE_W / 2) + 0.5;
      ctx.strokeStyle = 'rgba(26,45,71,0.45)';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(cx, PAD_TOP);
      ctx.lineTo(cx, PAD_TOP + priceH);
      ctx.stroke();
      if (st.startSec != null) {
        ctx.fillStyle = '#4a6580';
        ctx.fillText(timeLabel((st.startSec + visible[i].t * CANDLE_SEC) * 1000), cx, H - 3);
      }
    }
    // 左下角周期标注
    ctx.textAlign = 'left';
    ctx.fillStyle = '#3c556f';
    ctx.fillText(CANDLE_SEC + 's', PAD_LEFT + 1, H - 3);

    // 蜡烛
    for (var k = 0; k < N; k++) {
      var c = visible[k];
      var isGreen = c.c >= c.o;
      var color = isGreen ? '#26a69a' : '#ef5350';
      var x = xStart + k * UNIT + CANDLE_W / 2;
      var bodyTop = yPos(Math.max(c.o, c.c));
      var bodyBot = yPos(Math.min(c.o, c.c));
      var bodyH = bodyBot - bodyTop;
      if (bodyH < 1) bodyH = 1;

      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, yPos(c.h));
      ctx.lineTo(x, bodyTop);
      ctx.moveTo(x, bodyBot);
      ctx.lineTo(x, yPos(c.l));
      ctx.stroke();

      ctx.fillStyle = color;
      ctx.fillRect(x - CANDLE_W / 2, bodyTop, CANDLE_W, bodyH);
    }

    // 当前市值标签（与交易明细同口径同格式）
    var lastC = visible[N - 1];
    if (lastC) {
      var curY = yPos(lastC.c);
      var pColor = lastC.c >= lastC.o ? '#26a69a' : '#ef5350';
      var lbl = fmtMC2(lastC.c);
      ctx.font = "bold 10px 'Inter', sans-serif";
      var lblW = ctx.measureText(lbl).width + 8;
      var lastX = xStart + (N - 1) * UNIT + CANDLE_W / 2;
      var lblX = Math.round(Math.min(lastX + CANDLE_W / 2 + 2, PAD_LEFT + chartW - lblW));
      var lblY = Math.round(Math.max(PAD_TOP + 7, curY - 9));
      ctx.fillStyle = pColor;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(lblX, lblY - 7, lblW, 15, 2);
      else ctx.rect(lblX, lblY - 7, lblW, 15);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'left';
      ctx.fillText(lbl, lblX + 4, lblY + 4);
    }

    // 历史最高市值
    if (st.allTimeMC > 0) {
      ctx.font = "bold 10px 'Inter', sans-serif";
      ctx.textAlign = 'right';
      ctx.fillStyle = '#f59e0b';
      ctx.fillText('▲' + fmtMC2(st.allTimeMC), W - PAD_RIGHT - 2, PAD_TOP + 11);
    }
    ctx.textAlign = 'center';
  }

  // ── 新 renderFmTradePanel：市值用后端 USD 原值；字号 x1.5；KOL 金黄色整行 + 显示钱包名 ──
  function renderFmTradePanel(tokenId) {
    var key = String(tokenId || '').toLowerCase();
    var panel = document.getElementById('fm-trades-' + key);
    if (!panel) return;

    var cache = safe(function () { return fmTradesCache; }, null) || {};
    var trades = (cache[key] || []).slice();
    var mode = safe(function () { return tradeColMode; }, 'all');
    var wSet = safe(function () { return watchWalletSet; }, null);
    var wMap = safe(function () { return watchWalletMap; }, null);
    var bnb = Number(safe(function () { return bnbPrice; }, 0)) || 0;

    // 是否 KOL(追踪)钱包：后端标记 or 前端钱包表命中
    function kolName(t) {
      var a = String(t.userAddress || t.walletAddress || '').toLowerCase();
      if (t.walletName) return t.walletName;
      if (a && wMap && wMap.get && wMap.get(a)) return wMap.get(a);
      return null;
    }
    function isKol(t) {
      var a = String(t.userAddress || t.walletAddress || '').toLowerCase();
      if (t.isWatch || t.walletName) return true;
      return !!(a && wSet && wSet.has && wSet.has(a));
    }

    if (mode === 'wallet') {
      trades = trades.filter(isKol);
    }

    if (!trades.length) {
      panel.innerHTML = mode === 'wallet'
        ? '<div style="color:#ffd700;font-size:' + FS + ';padding:4px 0;">无跟踪钱包交易</div>'
        : '<div style="color:var(--muted);font-size:' + FS + ';padding:4px 0;">等待交易流...</div>';
      return;
    }

    // 成交额：稳定币报价（数值明显偏大）时换算为 BNB 展示；市值不参与任何换算
    var firstRaw = parseFloat(trades[0].volume !== undefined ? trades[0].volume : (trades[0].bnbAmount || '0')) || 0;
    var volDivGlobal = firstRaw > 12 && bnb > 0;

    panel.innerHTML = '';
    trades.forEach(function (t) {
      var ts = t._ts || '';
      var isBuy = t.side === 1 || t.side === 'buy';
      var sym = t.symbol || t.tokenSymbol || 'BNB';
      var addr = t.userAddress || t.walletAddress || t.userName || '';
      var rawVol = parseFloat(t.volume !== undefined ? t.volume : (t.bnbAmount || '0')) || 0;
      var volDiv = volDivGlobal || (sym !== 'BNB' && bnb > 0);
      var vol = volDiv ? (rawVol / bnb) : rawVol;
      var dispSym = (sym !== 'BNB' && bnb > 0) ? 'BNB*' : sym;
      var mcStr = fmtMC2(t.marketCapUSD || 0);

      var watch = isKol(t);
      var name = kolName(t);
      var addrDisp = (watch && name) ? name : shortA(addr);   // ★ KOL 显示名字

      var div = document.createElement('div');
      div.className = 'fm-trade-item' + (watch ? ' fm-kol' : '');
      div.innerHTML = '<span class="fm-time-sep" style="font-size:' + FS + ';">' + esc(ts) + '</span>'
        + '<span class="' + (isBuy ? 'fm-side-buy' : 'fm-side-sell') + '" style="font-size:' + FS + ';font-weight:700;">' + (isBuy ? '买' : '卖') + '</span>'
        + '<span class="fm-mc" style="color:' + (watch ? '#1b1b1b' : '#7a9fc0') + ';font-size:' + FS + ';flex-shrink:0;">' + esc(mcStr) + '</span>'
        + '<span class="fm-addr" title="' + esc(addr) + '" style="font-size:' + FS + ';' + (watch ? 'color:#1b1b1b;font-weight:800;max-width:none;' : '') + '">' + esc(addrDisp) + '</span>'
        + '<span class="fm-vol" style="font-size:' + FS + ';">' + (vol > 0 ? vol.toFixed(4) : '—') + ' ' + esc(dispSym) + '</span>';
      panel.appendChild(div);
    });
  }

  function applyPatch() {
    if (window.__mcFixApplied) return;
    if (typeof window.pushMCData !== 'function' || typeof window.drawChart !== 'function') {
      return setTimeout(applyPatch, 200);
    }
    window.__mcFixApplied = true;

    // 旧蜡烛的时间基准是“1 秒/格”，清空重建为 5 秒/格
    var m = states();
    Object.keys(m).forEach(function (k) {
      if (m[k]) { m[k].candles = []; m[k].startSec = null; }
    });

    window.fmtMC = fmtMC2;
    window.pushMCData = pushMCData;
    window.drawChart = drawChart;
    window.renderFmTradePanel = renderFmTradePanel;

    // 每笔成交同步写入 K 线：保证 K线最新值 ≡ 交易明细第一行市值
    var sk = safe(function () { return socket; }, null) || window.socket;
    if (sk && typeof sk.on === 'function') {
      sk.on('fm_trade', function (d) {
        var ca = String((d && d.tokenAddress) || '').toLowerCase();
        if (ca && d && Number(d.marketCapUSD) > 0) pushMCData(ca, Number(d.marketCapUSD));
      });
    }

    // 重绘已存在的图表与交易面板
    document.querySelectorAll('canvas[data-token-id]').forEach(function (cv) {
      drawChart(cv, cv.dataset.tokenId);
    });
    document.querySelectorAll('[id^="fm-trades-"]').forEach(function (p) {
      renderFmTradePanel(p.id.replace('fm-trades-', ''));
    });

    console.log('[mc-fix] 市值统一(USD)、K线5秒/格、交易明细字号x1.5、KOL钱包金黄色整行高亮');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(applyPatch, 0); });
  } else {
    setTimeout(applyPatch, 0);
  }
})();
