// Web Worker for heavy danmaku analysis
// - Classifies batches of embeddings into emotions
// - Computes aggregations and keyword frequency

const IGNORE_WORDS = new Set(['视频', '关注', '点赞', '投币', '收藏', '三连', '转发']);

const zhSegmenter = (typeof Intl !== 'undefined' && Intl.Segmenter)
  ? new Intl.Segmenter('zh', { granularity: 'word' })
  : null;

const state = {
  labels: [],
  polArr: [],
  valArr: [],
  aroArr: [],
  protoMode: 'max',
  clsCfg: null,
  labelProtoEmbeds: null,
  labelProtoIndex: null,
  labelCentroids: null,
  summaryPriors: null,
  useSubtitleContext: false,
  subtitleCenters: null,
  subtitleEmbeds: null,
  subtitleWeight: 0.25,
  subtitleWindowSec: 6,
  stopwords: new Set(),
  whitelist: new Set()
};

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function norm(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s) || 1;
  const out = new Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function softmax(arr, temp = 1.0) {
  if (!arr.length) return [];
  const t = Math.max(1e-6, temp);
  let mx = -Infinity;
  for (let i = 0; i < arr.length; i++) if (arr[i] > mx) mx = arr[i];
  const exps = new Array(arr.length);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    const e = Math.exp((arr[i] - mx) / t);
    exps[i] = e;
    sum += e;
  }
  sum = sum || 1;
  for (let i = 0; i < exps.length; i++) exps[i] /= sum;
  return exps;
}

function normEntropy(weights) {
  if (!weights || !weights.length) return 0;
  if (weights.length === 1) return 0;
  let ent = 0;
  for (let i = 0; i < weights.length; i++) {
    const p = weights[i] || 0;
    if (p > 0) ent -= p * Math.log(p);
  }
  return ent / Math.log(weights.length);
}

function gateFromCfg(conf, entropy, gateMode) {
  const mode = (gateMode === 'margin' || gateMode === 'entropy' || gateMode === 'mixed') ? gateMode : 'mixed';
  const gMargin = clamp(conf / 0.12, 0, 1);
  const gEntropy = clamp(1 - entropy, 0, 1);
  const base = (mode === 'margin') ? gMargin : (mode === 'entropy' ? gEntropy : (0.5 * gMargin + 0.5 * gEntropy));
  return clamp(0.25 + 0.75 * base, 0, 1);
}

function computeLabelSims(emb, mode = 'max') {
  const labelN = state.labels.length;
  const sims = new Array(labelN).fill(0);

  if (mode === 'max' && state.labelProtoEmbeds && state.labelProtoIndex) {
    for (let i = 0; i < labelN; i++) {
      const idx = state.labelProtoIndex[i];
      const start = idx ? idx.start : 0;
      const len = idx ? idx.len : 0;
      let best = -Infinity;
      for (let k = 0; k < len; k++) {
        const p = state.labelProtoEmbeds[start + k];
        if (!p) continue;
        const s = dot(emb, p);
        if (s > best) best = s;
      }
      sims[i] = (best === -Infinity) ? 0 : best;
    }
    return sims;
  }

  const cents = state.labelCentroids;
  for (let i = 0; i < labelN; i++) {
    const c = cents && cents[i];
    sims[i] = c ? dot(emb, c) : 0;
  }
  return sims;
}

function normalizeText(text) {
  if (!text) return '';
  let t = String(text);
  t = t.replace(/(?:https?|ftp):\/\/[^\s]+/g, '');
  t = t.replace(/[bB][vV]1[0-9A-Za-z]{9}/g, '').replace(/[aA][vV]\d+/g, '');
  t = t.replace(/\[([^\]]+)\]/g, '$1');
  t = t.replace(/哈{3,}/g, '哈哈');
  t = t.replace(/2{3,}/g, '233');
  t = t.replace(/(xswl|笑死|笑疯|笑翻|笑到|乐死|笑不活|xddl)/gi, '哈哈');
  t = t.replace(/(5{3,}|呜{2,}|555+)/g, '哭');
  t = t.replace(/a\W*w\W*s\W*l/ig, '爱了');
  t = t.replace(/(otz|orz)/ig, 'orz');
  t = t.replace(/([。！？!?,，~、])\1+/g, '$1');
  t = t.replace(/\s{2,}/g, ' ');
  return t.trim();
}

function tokensCN(text) {
  const orig = normalizeText(text || '');
  const out = [];
  const presentWL = new Set();
  for (const term of state.whitelist) {
    if (term && orig.includes(term)) {
      out.push(term);
      presentWL.add(term);
    }
  }

  try {
    if (zhSegmenter) {
      for (const s of zhSegmenter.segment(orig)) {
        const w = s.segment && String(s.segment).trim();
        if (!w) continue;
        if (w.length <= 1) continue;
        if (IGNORE_WORDS.has(w)) continue;
        if (state.stopwords.has(w)) continue;
        if (!presentWL.has(w)) out.push(w);
      }
      return out;
    }
  } catch {}

  const segs = (orig.match(/[\u4e00-\u9fa5]+/g) || []);
  for (const s of segs) {
    if (s.length === 1) continue;
    if (s.length <= 4) {
      if (!state.stopwords.has(s)) out.push(s);
    } else {
      for (let i = 0; i < s.length - 1; i++) {
        const bg = s.slice(i, i + 2);
        let covered = false;
        for (const t of presentWL) {
          if (t.includes(bg)) { covered = true; break; }
        }
        if (!covered && !state.stopwords.has(bg)) out.push(bg);
      }
    }
  }
  return out;
}

function binaryNearest(arr, x) {
  if (!arr || !arr.length) return -1;
  let lo = 0, hi = arr.length - 1;
  if (x <= arr[0]) return 0;
  if (x >= arr[hi]) return hi;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = arr[mid];
    if (v === x) return mid;
    if (v < x) lo = mid + 1; else hi = mid - 1;
  }
  if (lo <= 0) return 0;
  if (lo >= arr.length) return arr.length - 1;
  return (Math.abs(arr[lo] - x) < Math.abs(arr[lo - 1] - x)) ? lo : (lo - 1);
}

function classifyBatch(group, embeddings) {
  const outputs = [];
  const diag = {
    n: 0,
    lowConf: 0,
    lowByP: 0,
    lowByH: 0,
    argmaxNeutral: 0,
    pMaxs: [],
    entropies: [],
    gates: []
  };

  const labelN = state.labels.length;
  const neutralIdx = Math.max(0, state.labels.findIndex(l => l.key === (state.clsCfg?.neutralKey || '中性')));

  for (let j = 0; j < group.length; j++) {
    let e = embeddings[j];
    if (!e || !e.length) continue;
    // ensure normalized embedding
    e = norm(e);

    // Subtitle context mixing
    if (state.useSubtitleContext && state.subtitleCenters && state.subtitleEmbeds) {
      try {
        const win = Math.max(1, Number(state.subtitleWindowSec || 6));
        const beta = Math.max(0, Math.min(0.6, Number(state.subtitleWeight || 0.25)));
        const tnow = group[j].t || 0;
        let idx = binaryNearest(state.subtitleCenters, tnow);
        if (idx >= 0 && Math.abs(state.subtitleCenters[idx] - tnow) <= win) {
          const s = state.subtitleEmbeds[idx];
          if (Array.isArray(s) && s.length === e.length) {
            const mix = new Array(e.length);
            for (let q = 0; q < e.length; q++) mix[q] = e[q] + beta * s[q];
            e = norm(mix);
          }
        }
      } catch {}
    }

    const sims = computeLabelSims(e, state.protoMode);
    let weights = softmax(sims, state.clsCfg?.temp ?? 0.08);

    // Summary prior mixing
    if (state.summaryPriors && state.summaryPriors.length) {
      try {
        const tcur = group[j].t || 0;
        let bestIdxPrior = 0; let bestDist = Infinity;
        for (let q = 0; q < state.summaryPriors.length; q++) {
          const d = Math.abs((state.summaryPriors[q].t || 0) - tcur);
          if (d < bestDist) { bestDist = d; bestIdxPrior = q; }
        }
        const prior = state.summaryPriors[bestIdxPrior]?.weights || null;
        const alpha = Math.max(0, Math.min(0.8, Number(state.clsCfg?.summaryPriorWeight ?? 0.15)));
        if (prior && alpha > 0) {
          const mix = new Array(weights.length);
          let sum = 0;
          for (let k = 0; k < weights.length; k++) {
            const v = weights[k] * (1 - alpha) + (prior[k] || 0) * alpha;
            mix[k] = v; sum += v;
          }
          if (sum > 0) weights = mix.map(v => v / sum);
        }
      } catch {}
    }

    const wsum = (arr) => {
      let s = 0;
      for (let k = 0; k < labelN; k++) s += (arr[k] || 0) * (weights[k] || 0);
      return s;
    };
    let scoreW = clamp(wsum(state.polArr), -1, 1);
    let vW = clamp(wsum(state.valArr), -1, 1);
    let aW = clamp(wsum(state.aroArr), -1, 1);

    // argmax label
    let labelIdx = 0;
    { let m = -1; for (let k = 0; k < weights.length; k++) { if (weights[k] > m) { m = weights[k]; labelIdx = k; } } }
    let labelKey = state.labels[labelIdx]?.key || (state.labels[0] && state.labels[0].key) || '情绪';

    // pMax / p2
    let pMax = -1, p2 = -1;
    for (let k = 0; k < weights.length; k++) {
      const p = weights[k] || 0;
      if (p > pMax) { p2 = pMax; pMax = p; }
      else if (p > p2) { p2 = p; }
    }
    const entropy = normEntropy(weights);

    let pMin = state.clsCfg?.pMin ?? 0.22;
    let hMax = state.clsCfg?.hMax ?? 0.78;
    if (state.clsCfg?.adaptiveByLength) {
      const len = String(group[j].text || '').trim().length;
      const bonus = (len <= 4) ? 0.05 : 0;
      pMin = clamp(pMin - bonus, 0, 1);
      hMax = clamp(hMax + bonus, 0, 1);
    }

    const lowConf = (pMax < pMin) || (entropy > hMax);
    const conf = clamp((pMax - p2), 0, 1);
    const gate = gateFromCfg(conf, entropy, state.clsCfg?.gateMode);

    diag.n++;
    diag.pMaxs.push(pMax);
    diag.entropies.push(entropy);
    diag.gates.push(gate);
    if (labelKey === (state.clsCfg?.neutralKey || '中性')) diag.argmaxNeutral++;
    if (lowConf) {
      diag.lowConf++;
      if (pMax < pMin) diag.lowByP++;
      if (entropy > hMax) diag.lowByH++;
    }

    if (lowConf) {
      labelIdx = neutralIdx >= 0 ? neutralIdx : labelIdx;
      labelKey = state.labels[labelIdx]?.key || labelKey;
      const ng = clamp(state.clsCfg?.neutralGate ?? 0.22, 0, 1);
      outputs.push({
        t: group[j].t,
        label: labelKey,
        labelIdx,
        score: clamp(scoreW * ng, -1, 1),
        valence: clamp(vW * ng, -1, 1),
        arousal: clamp(aW * ng, -1, 1),
        conf, pMax, entropy, gate, lowConf: true,
        text: group[j].text
      });
    } else {
      outputs.push({
        t: group[j].t,
        label: labelKey,
        labelIdx,
        score: clamp(scoreW * gate, -1, 1),
        valence: clamp(vW * gate, -1, 1),
        arousal: clamp(aW * gate, -1, 1),
        conf, pMax, entropy, gate, lowConf: false,
        text: group[j].text
      });
    }
  }

  return { outputs, diag };
}

function finalizeOutputs(outputs, binSizeSec, wordTopN) {
  const list = (outputs || []).slice().sort((a, b) => (a.t || 0) - (b.t || 0));
  const bin = binSizeSec || 30;
  const labelN = state.labels.length;
  const maxT = Math.max(0, ...list.map(o => o.t || 0));
  const bins = Math.ceil((maxT + 1) / bin);
  const agg = Array.from({ length: bins }, () => ({ n: 0, sumPol: 0, sumVal: 0, sumAro: 0, labelCnt: Array(labelN).fill(0) }));

  for (const o of list) {
    const idx = Math.floor((o.t || 0) / bin);
    const a = agg[idx];
    if (!a) continue;
    a.n++;
    a.sumPol += (o.score || 0);
    a.sumVal += (o.valence || 0);
    a.sumAro += (o.arousal || 0);
    if (o.labelIdx >= 0 && o.labelIdx < labelN) a.labelCnt[o.labelIdx]++;
  }

  const series = agg.map((a, i) => [(i + 0.5) * bin, a.n ? a.sumPol / a.n : 0]);
  const arousal = agg.map((a, i) => [(i + 0.5) * bin, a.n ? a.sumAro / a.n : 0]);
  const count = agg.map((a, i) => [(i + 0.5) * bin, a.n]);
  const stackSeries = Array.from({ length: labelN }, (_, li) => agg.map((a, i) => [(i + 0.5) * bin, a.labelCnt[li]]));

  const labelCounts = new Array(labelN).fill(0);
  for (const o of list) if (o.labelIdx >= 0 && o.labelIdx < labelN) labelCounts[o.labelIdx]++;
  const pieData = state.labels.map((l, idx) => ({ name: l.key, value: labelCounts[idx] || 0 })).filter(d => d.value > 0);

  const points = agg.map((a, i) => {
    const x = a.n ? a.sumVal / a.n : 0;
    const y = a.n ? a.sumAro / a.n : 0;
    return [x, y, a.n, (i + 0.5) * bin, a.n];
  });

  const freq = new Map();
  for (const o of list) {
    for (const w of tokensCN(o.text)) {
      freq.set(w, (freq.get(w) || 0) + 1);
    }
  }
  const topN = Math.max(10, Math.min(300, wordTopN || 120));
  const words = Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([name, value]) => ({ name, value }));

  return {
    trend: { series, count, arousal },
    stack: { stackSeries, labels: state.labels.map(x => x.key) },
    pie: { data: pieData },
    quad: { points },
    words
  };
}

self.onmessage = (ev) => {
  const msg = ev.data || {};
  const type = msg.type;
  if (type === 'init') {
    state.labels = Array.isArray(msg.labels) ? msg.labels : [];
    state.polArr = state.labels.map(l => Number(l.polarity || 0));
    state.valArr = state.labels.map(l => Number(l.valence || 0));
    state.aroArr = state.labels.map(l => Number(l.arousal || 0));
    state.protoMode = String(msg.protoMode || 'max');
    state.clsCfg = msg.clsCfg || {};
    // allow summaryPriorWeight to flow through clsCfg for mixing scale
    if (msg.summaryPriorWeight !== undefined) state.clsCfg.summaryPriorWeight = msg.summaryPriorWeight;
    state.labelProtoEmbeds = msg.labelProtoEmbeds || null;
    state.labelProtoIndex = msg.labelProtoIndex || null;
    state.labelCentroids = msg.labelCentroids || null;
    state.summaryPriors = Array.isArray(msg.summaryPriors) ? msg.summaryPriors : null;
    state.useSubtitleContext = !!msg.useSubtitleContext;
    state.subtitleCenters = msg.subtitleCenters || null;
    state.subtitleEmbeds = msg.subtitleEmbeds || null;
    state.subtitleWeight = msg.subtitleWeight ?? state.subtitleWeight;
    state.subtitleWindowSec = msg.subtitleWindowSec ?? state.subtitleWindowSec;
    state.stopwords = new Set(Array.isArray(msg.stopwords) ? msg.stopwords : []);
    state.whitelist = new Set(Array.isArray(msg.whitelist) ? msg.whitelist : []);
    self.postMessage({ type: 'inited', id: msg.id });
    return;
  }
  if (type === 'classify') {
    const group = Array.isArray(msg.group) ? msg.group : [];
    const embeddings = Array.isArray(msg.embeddings) ? msg.embeddings : [];
    const res = classifyBatch(group, embeddings);
    self.postMessage({ type: 'batchResult', id: msg.id, outputs: res.outputs, diag: res.diag });
    return;
  }
  if (type === 'finalize') {
    const outputs = Array.isArray(msg.outputs) ? msg.outputs : [];
    const binSizeSec = Number(msg.binSizeSec || 30);
    const wordTopN = Number(msg.wordTopN || 120);
    const res = finalizeOutputs(outputs, binSizeSec, wordTopN);
    self.postMessage({ type: 'finalResult', id: msg.id, ...res });
  }
};

