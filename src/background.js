// Background service worker (MV3)
// - Proxies cross-origin fetch for Bilibili APIs
// - Calls SiliconFlow Embeddings API with API key in storage

const DEFAULT_CFG = {
  model: 'Qwen/Qwen3-Embedding-8B',
  dimensions: 4096,
  batchSize: 64,
  sampleLimit: 4000,
  binSizeSec: 30,
  classifyTemp: 0.08,
  classifyMinBest: 0.2,
  classifyMinMargin: 0.06,
  // lexicon options
  enableStopwords: true,
  stopwordsBuiltIn: 'full',
  customStopwords: '',
  enableWhitelist: false,
  customWhitelist: '',
  // label toggles
  labelsEnabled: {
    '开心': true,
    '感动': true,
    '惊讶': true,
    '中性': true,
    '悲伤': true,
    '生气': true,
    '厌恶': true,
    '紧张': true
  },
  // subtitle context options
  useSubtitleContext: false,
  subtitleWeight: 0.25,
  subtitleWindowSec: 6,
  // summary prior
  useSummaryPrior: true,
  summaryPriorWeight: 0.15,
  // rate & parallel defaults
  useCookies: true,
  embedConcurrency: 12,
  embedDelayMs: 0,
  rpmLimit: 2000,
  tpmLimit: 1000000,
  segParallel: 8,
  wordTopN: 30,
  // history danmaku
  enableHistory: true,
  historyMonths: 1,
  historyDateLimit: 30,
  historyParallel: 3
};

const STORAGE_DEFAULTS = {
  apiKey: '',
  model: DEFAULT_CFG.model,
  dimensions: DEFAULT_CFG.dimensions,
  batchSize: DEFAULT_CFG.batchSize,
  sampleLimit: DEFAULT_CFG.sampleLimit,
  binSizeSec: DEFAULT_CFG.binSizeSec,
  classifyTemp: DEFAULT_CFG.classifyTemp,
  classifyMinBest: DEFAULT_CFG.classifyMinBest,
  classifyMinMargin: DEFAULT_CFG.classifyMinMargin,
  enableStopwords: DEFAULT_CFG.enableStopwords,
  stopwordsBuiltIn: DEFAULT_CFG.stopwordsBuiltIn,
  customStopwords: DEFAULT_CFG.customStopwords,
  enableWhitelist: DEFAULT_CFG.enableWhitelist,
  customWhitelist: DEFAULT_CFG.customWhitelist,
  labelsEnabled: { ...DEFAULT_CFG.labelsEnabled },
  useSubtitleContext: DEFAULT_CFG.useSubtitleContext,
  subtitleWeight: DEFAULT_CFG.subtitleWeight,
  subtitleWindowSec: DEFAULT_CFG.subtitleWindowSec,
  useSummaryPrior: DEFAULT_CFG.useSummaryPrior,
  summaryPriorWeight: DEFAULT_CFG.summaryPriorWeight,
  useCookies: DEFAULT_CFG.useCookies,
  embedConcurrency: DEFAULT_CFG.embedConcurrency,
  embedDelayMs: DEFAULT_CFG.embedDelayMs,
  rpmLimit: DEFAULT_CFG.rpmLimit,
  tpmLimit: DEFAULT_CFG.tpmLimit,
  segParallel: DEFAULT_CFG.segParallel,
  wordTopN: DEFAULT_CFG.wordTopN,
  enableHistory: DEFAULT_CFG.enableHistory,
  historyMonths: DEFAULT_CFG.historyMonths,
  historyDateLimit: DEFAULT_CFG.historyDateLimit,
  historyParallel: DEFAULT_CFG.historyParallel
};

let configCache = null;
let configPromise = null;

function normalizeConfig(raw = {}) {
  const merged = { ...STORAGE_DEFAULTS, ...raw };
  merged.labelsEnabled = { ...DEFAULT_CFG.labelsEnabled, ...(raw.labelsEnabled || {}) };
  return merged;
}

async function loadConfig() {
  const res = await chrome.storage.sync.get(STORAGE_DEFAULTS);
  return normalizeConfig(res);
}

async function getConfig(forceReload = false) {
  if (forceReload) configCache = null;
  if (configCache) return configCache;
  if (!configPromise) {
    configPromise = loadConfig().then(cfg => {
      configCache = cfg;
      configPromise = null;
      return cfg;
    }).catch(err => {
      configPromise = null;
      throw err;
    });
  }
  return configPromise;
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync' || !configCache) return;
  let mutated = false;
  const next = { ...configCache };
  for (const [key, change] of Object.entries(changes)) {
    if (!(key in STORAGE_DEFAULTS)) continue;
    if (key === 'labelsEnabled') {
      next.labelsEnabled = { ...DEFAULT_CFG.labelsEnabled, ...(change.newValue || {}) };
    } else {
      next[key] = change.newValue !== undefined ? change.newValue : STORAGE_DEFAULTS[key];
    }
    mutated = true;
  }
  if (mutated) configCache = next;
});

async function biliFetchJson(url) {
  const { useCookies } = await getConfig();
  const r = await fetch(url, { credentials: useCookies ? 'include' : 'omit', referrer: 'https://www.bilibili.com/' });
  if (!r.ok) throw new Error(`Bili JSON ${r.status}`);
  return r.json();
}

async function biliFetchText(url) {
  const { useCookies } = await getConfig();
  const r = await fetch(url, { credentials: useCookies ? 'include' : 'omit', referrer: 'https://www.bilibili.com/' });
  if (!r.ok) throw new Error(`Bili Text ${r.status}`);
  return r.text();
}

const RETRYABLE_EMBED_ERROR = /SiliconFlow\s5\d{2}|50500|timeout|Failed to fetch/i;

async function siliconflowEmbed({ inputs, model, dimensions, encoding_format = 'float' }) {
  const { apiKey } = await getConfig();
  if (!apiKey) throw new Error('缺少 SiliconFlow API Key，请在插件选项中设置');

  const url = 'https://api.siliconflow.cn/v1/embeddings';
  const baseHeaders = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json'
  };

  async function postOnce(payload, timeoutMs = 25000) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort('timeout'), timeoutMs);
    try {
      const r = await fetch(url, { method: 'POST', headers: baseHeaders, body: JSON.stringify(payload), signal: ac.signal });
      const text = await r.text();
      if (!r.ok) {
        throw new Error(`SiliconFlow ${r.status}: ${text}`);
      }
      let j = null;
      try { j = JSON.parse(text); } catch (e) { throw new Error(`SiliconFlow parse error: ${String(e)} | body: ${text.slice(0,256)}`); }
      if (!j || !Array.isArray(j.data)) throw new Error('无效的 SiliconFlow 返回结构');
      return j.data.map((d) => d.embedding);
    } finally {
      clearTimeout(timer);
    }
  }

  async function requestWithRetry(payload, attempt = 0) {
    try {
      return await postOnce(payload);
    } catch (err) {
      const msg = String(err || '');
      if (RETRYABLE_EMBED_ERROR.test(msg) && attempt < 2) {
        const delay = 200 * (attempt + 1);
        await new Promise(res => setTimeout(res, delay));
        return requestWithRetry(payload, attempt + 1);
      }
      throw err;
    }
  }

  async function embedAdaptive(list, depth = 0) {
    if (!list.length) return [];
    const payload = { model, input: list, encoding_format, ...(dimensions ? { dimensions } : {}) };
    try {
      return await requestWithRetry(payload);
    } catch (err) {
      const msg = String(err || '');
      const retriable = RETRYABLE_EMBED_ERROR.test(msg);
      if (!retriable || list.length === 1 || depth >= 4) {
        throw err;
      }
      const mid = Math.ceil(list.length / 2);
      const head = await embedAdaptive(list.slice(0, mid), depth + 1);
      const tail = await embedAdaptive(list.slice(mid), depth + 1);
      return head.concat(tail);
    }
  }

  const safeInputs = Array.isArray(inputs) ? inputs : [];
  return embedAdaptive(safeInputs);
}

// --------- WBI 签名 & AI Summary 支持 ---------
// Minimal MD5 (hex) implementation
function md5cycle(x, k) {
  let [a,b,c,d] = x;
  a = ff(a,b,c,d, k[0], 7, -680876936);
  d = ff(d,a,b,c, k[1], 12, -389564586);
  c = ff(c,d,a,b, k[2], 17,  606105819);
  b = ff(b,c,d,a, k[3], 22, -1044525330);
  a = ff(a,b,c,d, k[4], 7, -176418897);
  d = ff(d,a,b,c, k[5], 12, 1200080426);
  c = ff(c,d,a,b, k[6], 17, -1473231341);
  b = ff(b,c,d,a, k[7], 22, -45705983);
  a = ff(a,b,c,d, k[8], 7, 1770035416);
  d = ff(d,a,b,c, k[9], 12, -1958414417);
  c = ff(c,d,a,b, k[10], 17, -42063);
  b = ff(b,c,d,a, k[11], 22, -1990404162);
  a = ff(a,b,c,d, k[12], 7, 1804603682);
  d = ff(d,a,b,c, k[13], 12, -40341101);
  c = ff(c,d,a,b, k[14], 17, -1502002290);
  b = ff(b,c,d,a, k[15], 22, 1236535329);

  a = gg(a,b,c,d, k[1], 5, -165796510);
  d = gg(d,a,b,c, k[6], 9, -1069501632);
  c = gg(c,d,a,b, k[11], 14, 643717713);
  b = gg(b,c,d,a, k[0], 20, -373897302);
  a = gg(a,b,c,d, k[5], 5, -701558691);
  d = gg(d,a,b,c, k[10], 9, 38016083);
  c = gg(c,d,a,b, k[15], 14, -660478335);
  b = gg(b,c,d,a, k[4], 20, -405537848);
  a = gg(a,b,c,d, k[9], 5, 568446438);
  d = gg(d,a,b,c, k[14], 9, -1019803690);
  c = gg(c,d,a,b, k[3], 14, -187363961);
  b = gg(b,c,d,a, k[8], 20, 1163531501);
  a = gg(a,b,c,d, k[13], 5, -1444681467);
  d = gg(d,a,b,c, k[2], 9, -51403784);
  c = gg(c,d,a,b, k[7], 14, 1735328473);
  b = gg(b,c,d,a, k[12], 20, -1926607734);

  a = hh(a,b,c,d, k[5], 4, -378558);
  d = hh(d,a,b,c, k[8], 11, -2022574463);
  c = hh(c,d,a,b, k[11], 16, 1839030562);
  b = hh(b,c,d,a, k[14], 23, -35309556);
  a = hh(a,b,c,d, k[1], 4, -1530992060);
  d = hh(d,a,b,c, k[4], 11, 1272893353);
  c = hh(c,d,a,b, k[7], 16, -155497632);
  b = hh(b,c,d,a, k[10], 23, -1094730640);
  a = hh(a,b,c,d, k[13], 4, 681279174);
  d = hh(d,a,b,c, k[0], 11, -358537222);
  c = hh(c,d,a,b, k[3], 16, -722521979);
  b = hh(b,c,d,a, k[6], 23, 76029189);
  a = hh(a,b,c,d, k[9], 4, -640364487);
  d = hh(d,a,b,c, k[12], 11, -421815835);
  c = hh(c,d,a,b, k[15], 16, 530742520);
  b = hh(b,c,d,a, k[2], 23, -995338651);

  a = ii(a,b,c,d, k[0], 6, -198630844);
  d = ii(d,a,b,c, k[7], 10, 1126891415);
  c = ii(c,d,a,b, k[14], 15, -1416354905);
  b = ii(b,c,d,a, k[5], 21, -57434055);
  a = ii(a,b,c,d, k[12], 6, 1700485571);
  d = ii(d,a,b,c, k[3], 10, -1894986606);
  c = ii(c,d,a,b, k[10], 15, -1051523);
  b = ii(b,c,d,a, k[1], 21, -2054922799);
  a = ii(a,b,c,d, k[8], 6, 1873313359);
  d = ii(d,a,b,c, k[15], 10, -30611744);
  c = ii(c,d,a,b, k[6], 15, -1560198380);
  b = ii(b,c,d,a, k[13], 21, 1309151649);
  a = ii(a,b,c,d, k[4], 6, -145523070);
  d = ii(d,a,b,c, k[11], 10, -1120210379);
  c = ii(c,d,a,b, k[2], 15, 718787259);
  b = ii(b,c,d,a, k[9], 21, -343485551);

  x[0] = add32(a, x[0]);
  x[1] = add32(b, x[1]);
  x[2] = add32(c, x[2]);
  x[3] = add32(d, x[3]);
}
function cmn(q, a, b, x, s, t) { a = add32(add32(a, q), add32(x, t)); return add32((a << s) | (a >>> (32 - s)), b); }
function ff(a, b, c, d, x, s, t) { return cmn((b & c) | ((~b) & d), a, b, x, s, t); }
function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & (~d)), a, b, x, s, t); }
function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | (~d)), a, b, x, s, t); }
function md51(s) {
  const n = s.length;
  const state = [1732584193, -271733879, -1732584194, 271733878];
  let i; for (i = 64; i <= n; i += 64) md5cycle(state, md5blk(s.substring(i - 64, i)));
  s = s.substring(i - 64);
  const tail = new Array(16).fill(0);
  for (i = 0; i < s.length; i++) tail[i >> 2] |= s.charCodeAt(i) << ((i % 4) << 3);
  tail[i >> 2] |= 0x80 << ((i % 4) << 3);
  if (i > 55) { md5cycle(state, tail); for (let j = 0; j < 16; j++) tail[j] = 0; }
  tail[14] = n * 8; md5cycle(state, tail);
  return state;
}
function md5blk(s) { const md5blks = []; for (let i = 0; i < 64; i += 4) md5blks[i >> 2] = s.charCodeAt(i) + (s.charCodeAt(i+1) << 8) + (s.charCodeAt(i+2) << 16) + (s.charCodeAt(i+3) << 24); return md5blks; }
function rhex(n) { let s = '', j = 0; for (; j < 4; j++) s += ((n >> (j * 8 + 4)) & 0x0F).toString(16) + ((n >> (j * 8)) & 0x0F).toString(16); return s; }
function hex(x) { for (let i = 0; i < x.length; i++) x[i] = rhex(x[i]); return x.join(''); }
function md5(s) { return hex(md51(s)); }
function add32(a, b) { return (a + b) & 0xFFFFFFFF; }

let _biliMixin = null; let _biliMixinTs = 0;
const WBI_OE = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
async function getBiliMixin() {
  const now = Date.now();
  if (_biliMixin && now - _biliMixinTs < 3600_000) return _biliMixin;
  const nav = await biliFetchJson('https://api.bilibili.com/x/web-interface/nav');
  const img = nav?.data?.wbi_img?.img_url || '';
  const sub = nav?.data?.wbi_img?.sub_url || '';
  const imgv = String(img).split('/').pop().split('.')[0] || '';
  const subv = String(sub).split('/').pop().split('.')[0] || '';
  const val = (imgv + subv).split('');
  let mix = '';
  for (let i = 0; i < WBI_OE.length; i++) { mix += val[WBI_OE[i]] || ''; if (mix.length >= 32) break; }
  _biliMixin = mix.slice(0, 32);
  _biliMixinTs = now;
  return _biliMixin;
}
async function biliGetWbi(url, params) {
  const mix = await getBiliMixin();
  const p = { ...(params||{}), wts: Math.floor(Date.now()/1000) };
  const keys = Object.keys(p).sort();
  const paramStr = keys.map(k => `${k}=${p[k]}`).join('&');
  const sign = md5(paramStr + mix);
  const full = `${url}?${paramStr}&w_rid=${sign}`;
  const r = await fetch(full, { credentials: 'include', referrer: 'https://www.bilibili.com/' });
  if (!r.ok) throw new Error(`Bili WBI ${r.status}`);
  return r.json();
}

// -------- Bilibili danmaku (seg.so) decoding --------
function readVarint(u8, pos) {
  let x = 0, s = 0;
  while (pos < u8.length) {
    const b = u8[pos++];
    x |= (b & 0x7f) << s;
    if (!(b & 0x80)) break;
    s += 7;
  }
  return [x >>> 0, pos];
}

function skipField(u8, pos, wireType) {
  switch (wireType) {
    case 0: return readVarint(u8, pos)[1]; // varint
    case 1: return pos + 8;               // 64-bit
    case 2: { const [len, p] = readVarint(u8, pos); return p + len; } // length-delimited
    case 5: return pos + 4;               // 32-bit
    default: return pos;                  // unsupported groups
  }
}

const textDecoder = new TextDecoder('utf-8');
function decodeDmSeg(buf) {
  const u8 = new Uint8Array(buf);
  let pos = 0; const end = u8.length; const out = [];
  while (pos < end) {
    const t = readVarint(u8, pos); pos = t[1]; const tag = t[0];
    const field = tag >>> 3; const wt = tag & 7;
    if (field === 1 && wt === 2) {
      const r = readVarint(u8, pos); const len = r[0]; pos = r[1];
      const subEnd = pos + len; let progress = 0; let content = '';
      while (pos < subEnd) {
        const tt = readVarint(u8, pos); pos = tt[1]; const f = tt[0] >>> 3; const w = tt[0] & 7;
        if (f === 2 && w === 0) { const rv = readVarint(u8, pos); progress = rv[0]; pos = rv[1]; continue; }
        if (f === 7 && w === 2) { const r2 = readVarint(u8, pos); const l2 = r2[0]; pos = r2[1]; content = textDecoder.decode(u8.subarray(pos, pos + l2)); pos += l2; continue; }
        pos = skipField(u8, pos, w);
      }
      if (content) out.push({ t: progress / 1000, text: content });
      continue;
    }
    pos = skipField(u8, pos, wt);
  }
  return out;
}

async function biliDmView(cid) {
  const url = `https://api.bilibili.com/x/v2/dm/web/view?type=1&oid=${cid}`;
  const j = await biliFetchJson(url);
  const total = j?.data?.dmSge?.total || 1;
  return { total };
}

async function biliDmSeg(cid, index, referrer) {
  const url = `https://api.bilibili.com/x/v2/dm/web/seg.so?type=1&oid=${cid}&segment_index=${index}`;
  const { useCookies } = await getConfig();
  const r = await fetch(url, {
    credentials: useCookies ? 'include' : 'omit',
    referrer: referrer || 'https://www.bilibili.com/',
    cache: 'no-cache',
    mode: 'cors',
    headers: { 'Accept': '*/*' }
  });
  const status = r.status;
  if (!r.ok) {
    return { ok: false, status, list: [] };
  }
  const buf = await r.arrayBuffer();
  return { ok: true, status, list: decodeDmSeg(buf) };
}

// -------- Bilibili history danmaku --------
async function biliHistoryIndex(cid, month) {
  const url = `https://api.bilibili.com/x/v2/dm/history/index?type=1&oid=${cid}&month=${encodeURIComponent(month)}`;
  const j = await biliFetchJson(url);
  const dates = Array.isArray(j?.data) ? j.data : (Array.isArray(j?.data?.dates) ? j.data.dates : []);
  return dates;
}

async function biliHistorySeg(cid, date) {
  const url = `https://api.bilibili.com/x/v2/dm/web/history/seg.so?type=1&oid=${cid}&date=${encodeURIComponent(date)}`;
  const { useCookies } = await getConfig();
  const r = await fetch(url, { credentials: useCookies ? 'include' : 'omit', referrer: 'https://www.bilibili.com/' });
  if (!r.ok) throw new Error(`Bili history seg.so ${r.status}`);
  const buf = await r.arrayBuffer();
  return decodeDmSeg(buf);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg && msg.type === 'bili.fetchCid') {
        const bvid = msg.bvid;
        const url = `https://api.bilibili.com/x/player/pagelist?bvid=${encodeURIComponent(bvid)}&jsonp=jsonp`;
        const j = await biliFetchJson(url);
        const cid = j && j.data && j.data[0] && j.data[0].cid;
        if (!cid) throw new Error('未获取到 cid');
        sendResponse({ ok: true, cid });
        return;
      }

      if (msg && msg.type === 'bili.fetchCids') {
        const bvid = msg.bvid;
        const url = `https://api.bilibili.com/x/player/pagelist?bvid=${encodeURIComponent(bvid)}&jsonp=jsonp`;
        const j = await biliFetchJson(url);
        const cids = Array.isArray(j?.data) ? j.data.map(p => p.cid).filter(Boolean) : [];
        if (!cids.length) throw new Error('未获取到任何 cid');
        sendResponse({ ok: true, cids });
        return;
      }

      if (msg && msg.type === 'bili.fetchXML') {
        const cid = msg.cid;
        const url = `https://api.bilibili.com/x/v1/dm/list.so?oid=${cid}`;
        const text = await biliFetchText(url);
        sendResponse({ ok: true, xml: text, source: 'api.list.so' });
        return;
      }

      if (msg && msg.type === 'bili.fetchAllDanmaku') {
        const cid = msg.cid;
        const ref = msg.ref;
        const view = await biliDmView(cid);
        const total = Math.max(1, view.total || 1);
        const { segParallel = 4 } = await getConfig();
        const limitParallel = Math.min(6, msg.parallel || segParallel || 4);
        const tasks = [];
        const out = new Array(total);
        const diag = [];
        let i = 1; let active = 0;
        const runNext = async () => {
          if (i > total) return;
          const idx = i++; active++;
          try {
            // retry on 412/403 with exponential backoff
            let attempt = 0; let res = null; let lastStatus = 0;
            while (attempt < 3) {
              res = await biliDmSeg(cid, idx, ref);
              lastStatus = res?.status || 0;
              if (res && res.ok) break;
              if (lastStatus === 412 || lastStatus === 403) {
                const delay = 300 * Math.pow(2, attempt);
                await new Promise(r => setTimeout(r, delay));
                attempt++;
              } else {
                break;
              }
            }
            if (res && res.ok) {
              out[idx - 1] = res.list;
              diag.push({ seg: idx, ok: true, status: lastStatus || 200, count: res.list.length });
            } else {
              out[idx - 1] = [];
              diag.push({ seg: idx, ok: false, status: lastStatus || -1, count: 0 });
            }
          } finally {
            active--;
            if (i <= total) await runNext();
          }
        };
        const starters = Math.min(limitParallel, total);
        for (let k = 0; k < starters; k++) tasks.push(runNext());
        await Promise.all(tasks);
        const flat = [];
        let sorted = true;
        let lastT = -Infinity;
        for (const segList of out) {
          if (!Array.isArray(segList)) continue;
          for (const item of segList) {
            if (!item) continue;
            if (sorted && typeof item.t === 'number') {
              if (item.t < lastT) {
                sorted = false;
              } else {
                lastT = item.t;
              }
            }
            flat.push(item);
          }
        }
        if (!sorted) {
          flat.sort((a, b) => {
            const ta = (a && typeof a.t === 'number') ? a.t : 0;
            const tb = (b && typeof b.t === 'number') ? b.t : 0;
            return ta - tb;
          });
        }
        sendResponse({ ok: true, list: flat, diag, totalSegments: total });
        return;
      }

      if (msg && msg.type === 'bili.fetchSummary') {
        const bvid = msg.bvid;
        if (!bvid) throw new Error('缺少 bvid');
        const view = await biliFetchJson(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`);
        const data = view?.data; if (!data) throw new Error('获取视频信息失败');
        const cid = data.cid; const up_mid = data?.owner?.mid;
        const sum = await biliGetWbi('https://api.bilibili.com/x/web-interface/view/conclusion/get', { bvid, cid, up_mid });
        const mr = sum?.data?.model_result || null;
        sendResponse({ ok: true, model_result: mr, raw: sum?.data || null });
        return;
      }

      if (msg && msg.type === 'bili.checkAuth') {
        try {
          const cookies = await chrome.cookies.getAll({ domain: '.bilibili.com' });
          const hasSess = cookies.some(c => c.name === 'SESSDATA');
          sendResponse({ ok: true, loggedIn: hasSess, count: cookies.length });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || String(e) });
        }
        return;
      }

      if (msg && msg.type === 'embed.batch') {
        const { inputs } = msg;
        const { model, dimensions } = await getConfig();
        const embeddings = await siliconflowEmbed({ inputs, model, dimensions });
        sendResponse({ ok: true, embeddings });
        return;
      }

      if (msg && msg.type === 'bili.historyIndex') {
        const { cid, month } = msg;
        const dates = await biliHistoryIndex(cid, month);
        sendResponse({ ok: true, dates });
        return;
      }

      if (msg && msg.type === 'bili.historySeg') {
        const { cid, date } = msg;
        const list = await biliHistorySeg(cid, date);
        sendResponse({ ok: true, list });
        return;
      }

      if (msg && msg.type === 'bili.fetchSubtitleList') {
        const { bvid } = msg;
        if (!bvid) throw new Error('缺少 bvid');
        const view = await biliFetchJson(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`);
        const list = Array.isArray(view?.data?.subtitle?.list) ? view.data.subtitle.list : [];
        const tracks = list.map(it => {
          let url = it?.subtitle_url || '';
          if (url && url.startsWith('//')) url = 'https:' + url;
          return { lan: it?.lan || '', lan_doc: it?.lan_doc || '', url };
        }).filter(t => t.url);
        sendResponse({ ok: true, tracks });
        return;
      }

      if (msg && msg.type === 'bili.fetchSubtitleTrack') {
        const { url } = msg;
        if (!url) throw new Error('缺少字幕 URL');
        const r = await fetch(url, { credentials: 'omit', referrer: 'https://www.bilibili.com/' });
        if (!r.ok) throw new Error(`字幕拉取失败 ${r.status}`);
        const j = await r.json();
        const body = Array.isArray(j?.body) ? j.body : [];
        const segments = body.map(x => ({ from: Number(x?.from || 0), to: Number(x?.to || 0), content: String(x?.content || '') }))
          .filter(s => s.to > s.from && s.content);
        sendResponse({ ok: true, segments });
        return;
      }

      if (msg && msg.type === 'get.config') {
        const cfg = await getConfig();
        sendResponse({ ok: true, cfg });
        return;
      }

      if (msg && msg.type === 'set.config') {
        const updates = msg.cfg || {};
        await chrome.storage.sync.set(updates);
        if (configCache) {
          const next = { ...configCache, ...updates };
          if (Object.prototype.hasOwnProperty.call(updates, 'labelsEnabled')) {
            next.labelsEnabled = { ...DEFAULT_CFG.labelsEnabled, ...(updates.labelsEnabled || {}) };
          }
          configCache = normalizeConfig(next);
        }
        sendResponse({ ok: true });
        return;
      }

      sendResponse({ ok: false, error: 'Unknown message type' });
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
  })();
  // async response
  return true;
});
