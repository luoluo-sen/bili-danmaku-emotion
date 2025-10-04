// Lightweight utility helpers shared across content scripts
// Exposes under a single global namespace: window.WIS.utils
(function() {
  const WIS = (window.WIS = window.WIS || {});
  const utils = {};

  utils.formatMMSS = function(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  };

  utils.fnv1a = function(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h += (h<<1) + (h<<4) + (h<<7) + (h<<8) + (h<<24);
    }
    return (h >>> 0).toString(16);
  };

  utils.norm = function(v) {
    let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * v[i];
    const n = Math.sqrt(s) || 1;
    return v.map(x => x / n);
  };

  utils.dot = function(a, b) {
    let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
  };

  utils.sum = function(arr) { return (arr || []).reduce((x, y) => x + y, 0); };

  utils.getExtURL = function(path) {
    try { if (chrome && chrome.runtime && chrome.runtime.getURL) return chrome.runtime.getURL(path); } catch {}
    return path;
  };

  utils.downloadBlob = function(filename, blob) {
    if (!(blob instanceof Blob)) {
      throw new Error('downloadBlob 需要传入 Blob 对象');
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || `download-${Date.now()}`;
    a.style.display = 'none';
    a.rel = 'noopener';
    a.target = '_blank';

    document.body.appendChild(a);
    requestAnimationFrame(() => {
      a.dispatchEvent(new MouseEvent('click'));
      setTimeout(() => {
        try { URL.revokeObjectURL(url); } catch {}
        try { a.remove(); } catch {}
      }, 1000);
    });
  };

  WIS.utils = utils;
})();
