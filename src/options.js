const DEFAULT_CONFIG = {
  apiKey: '',
  model: 'Qwen/Qwen3-Embedding-8B',
  dimensions: 4096,
  batchSize: 64,
  sampleLimit: 4000,
  binSizeSec: 30,
  useCookies: true,
  embedConcurrency: 12,
  embedDelayMs: 0,
  rpmLimit: 2000,
  tpmLimit: 1000000,
  segParallel: 8,
  wordTopN: 30,
  enableHistory: true,
  historyMonths: 1,
  historyDateLimit: 30,
  historyParallel: 3,
  enableStopwords: true,
  stopwordsBuiltIn: 'full',
  customStopwords: '',
  enableWhitelist: false,
  customWhitelist: '',
  classifyTemp: 0.08,
  classifyMinBest: 0.2,
  classifyMinMargin: 0.06,
  useSummaryPrior: true,
  summaryPriorWeight: 0.15,
  useSubtitleContext: false,
  subtitleWeight: 0.25,
  subtitleWindowSec: 6,
  labelsEnabled: {
    '开心': true,
    '感动': true,
    '惊讶': true,
    '中性': true,
    '悲伤': true,
    '生气': true,
    '厌恶': true,
    '紧张': true
  }
};

async function load() {
  const cfg = await chrome.storage.sync.get(DEFAULT_CONFIG);
  for (const k of Object.keys(cfg)) {
    const el = document.getElementById(k);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!cfg[k];
    else el.value = cfg[k];
  }
  // 载入 Summary Prior 选项
  try {
    const cb = document.getElementById('useSummaryPrior');
    if (cb) cb.checked = !!cfg.useSummaryPrior;
    const w = document.getElementById('summaryPriorWeight');
    if (w) w.value = String(cfg.summaryPriorWeight ?? 0.15);
  } catch {}
  // 初始化情绪标签复选框
  try {
    const labelsCfg = cfg.labelsEnabled || DEFAULT_CONFIG.labelsEnabled;
    document.querySelectorAll('input[data-label-key]')
      .forEach((box) => {
        const key = box.getAttribute('data-label-key');
        box.checked = labelsCfg[key] !== false;
      });
  } catch {}
}

function showStatus(message, isSuccess = true) {
  const container = document.getElementById('status-container');
  const statusEl = document.createElement('div');
  statusEl.className = `status ${isSuccess ? 'ok' : 'err'}`;
  statusEl.textContent = message;

  container.innerHTML = '';
  container.appendChild(statusEl);

  setTimeout(() => {
    statusEl.style.opacity = '0';
    statusEl.style.transform = 'translateY(-8px)';
    setTimeout(() => container.innerHTML = '', 300);
  }, 2500);
}

async function save() {
  try {
    const apiKey = document.getElementById('apiKey').value.trim();
    const model = document.getElementById('model').value;
    const dimensions = Number(document.getElementById('dimensions').value) || 4096;
    const batchSize = Math.max(1, Number(document.getElementById('batchSize').value) || 64);
    const sampleLimit = Math.max(1, Number(document.getElementById('sampleLimit').value) || 4000);
    const binSizeSec = Math.max(5, Number(document.getElementById('binSizeSec').value) || 30);
    const useCookies = document.getElementById('useCookies').checked;
    const embedConcurrency = Math.max(1, Number(document.getElementById('embedConcurrency').value) || 12);
    const embedDelayMs = Math.max(0, Number(document.getElementById('embedDelayMs').value) || 0);
    const rpmLimit = Math.max(10, Number(document.getElementById('rpmLimit').value) || 2000);
    const tpmLimit = Math.max(1000, Number(document.getElementById('tpmLimit').value) || 1000000);
    const segParallel = Math.max(1, Number(document.getElementById('segParallel').value) || 8);
    const wordTopN = Math.max(10, Number(document.getElementById('wordTopN').value) || 30);
    const enableHistory = document.getElementById('enableHistory').checked;
    const historyMonths = Math.max(1, Number(document.getElementById('historyMonths').value) || 1);
    const historyDateLimit = Math.max(1, Number(document.getElementById('historyDateLimit').value) || 30);
    const historyParallel = Math.max(1, Number(document.getElementById('historyParallel').value) || 3);
    const enableStopwords = document.getElementById('enableStopwords').checked;
    const stopwordsBuiltIn = document.getElementById('stopwordsBuiltIn').value;
    const customStopwords = document.getElementById('customStopwords').value;
    const enableWhitelist = document.getElementById('enableWhitelist').checked;
    const customWhitelist = document.getElementById('customWhitelist').value;
    const classifyTemp = Math.max(0.01, Math.min(1, Number(document.getElementById('classifyTemp').value) || 0.08));
    const classifyMinBest = Math.max(0, Math.min(1, Number(document.getElementById('classifyMinBest').value) || 0.2));
    const classifyMinMargin = Math.max(0, Math.min(1, Number(document.getElementById('classifyMinMargin').value) || 0.06));
    const useSummaryPrior = !!document.getElementById('useSummaryPrior')?.checked;
    const summaryPriorWeight = Math.max(0, Math.min(0.8, Number(document.getElementById('summaryPriorWeight')?.value) || 0.15));
    const useSubtitleContext = !!document.getElementById('useSubtitleContext')?.checked;
    const subtitleWeight = Math.max(0, Math.min(0.6, Number(document.getElementById('subtitleWeight')?.value) || 0.25));
    const subtitleWindowSec = Math.max(1, Math.min(12, Number(document.getElementById('subtitleWindowSec')?.value) || 6));
    // 收集情绪标签选择
    const labelsEnabled = {};
    let anySelected = false;
    document.querySelectorAll('input[data-label-key]').forEach((box) => {
      const key = box.getAttribute('data-label-key');
      labelsEnabled[key] = !!box.checked;
      if (box.checked) anySelected = true;
    });
    if (!anySelected) {
      showStatus('至少选择一个情绪标签', false);
      return;
    }

    await chrome.storage.sync.set({
      apiKey,
      model,
      dimensions,
      batchSize,
      sampleLimit,
      binSizeSec,
      embedConcurrency,
      embedDelayMs,
      rpmLimit,
      tpmLimit,
      segParallel,
      wordTopN,
      enableHistory,
      historyMonths,
      historyDateLimit,
      historyParallel,
      useCookies,
      enableStopwords,
      stopwordsBuiltIn,
      customStopwords,
      enableWhitelist,
      customWhitelist,
      classifyTemp,
      classifyMinBest,
      classifyMinMargin,
      useSummaryPrior,
      summaryPriorWeight,
      useSubtitleContext,
      subtitleWeight,
      subtitleWindowSec,
      labelsEnabled
    });

    showStatus('设置已保存', true);
  } catch (error) {
    showStatus('保存失败：' + error.message, false);
  }
}

async function reset() {
  if (!confirm('确定要恢复默认设置吗？')) return;

  try {
    await chrome.storage.sync.set(DEFAULT_CONFIG);
    await load();
    showStatus('已恢复默认设置', true);
  } catch (error) {
    showStatus('重置失败：' + error.message, false);
  }
}

document.getElementById('save').addEventListener('click', save);
document.getElementById('reset').addEventListener('click', reset);
document.getElementById('exportConfig').addEventListener('click', exportConfig);
document.getElementById('importConfig').addEventListener('change', importConfigFile);

// Support Enter key to save
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
    save();
  }
});

// Import helpers for text files -> append lines into textarea
function hookFileImport(inputId, targetId) {
  const input = document.getElementById(inputId);
  const target = document.getElementById(targetId);
  if (!input || !target) return;
  input.addEventListener('change', () => {
    const f = input.files && input.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || '');
      const cur = target.value ? (target.value.trim() + '\n') : '';
      target.value = cur + text.trim();
      showStatus('导入完成', true);
    };
    reader.onerror = () => showStatus('导入失败', false);
    reader.readAsText(f, 'utf-8');
  });
}

hookFileImport('swFile', 'customStopwords');
hookFileImport('wlFile', 'customWhitelist');

load();

// ======== Tab Navigation ========
(function initTabs(){
  const tabs = Array.from(document.querySelectorAll('.tab'));
  const cards = Array.from(document.querySelectorAll('.card[data-tab]'));
  function activate(name){
    localStorage.setItem('wis-options-tab', name);
    tabs.forEach(t=>t.classList.toggle('active', t.getAttribute('data-tab')===name));
    cards.forEach(c=>c.classList.toggle('active', c.getAttribute('data-tab')===name));
  }
  tabs.forEach(t=>t.addEventListener('click', ()=>activate(t.getAttribute('data-tab'))));
  const last = localStorage.getItem('wis-options-tab') || 'api';
  // 如果无 tabs（极端情况），忽略
  if (tabs.length && cards.length) activate(last);
})();

// ======== 配置备份/导入 ========
const CONFIG_KEYS = Object.keys(DEFAULT_CONFIG);

async function exportConfig() {
  try {
    const cfg = await chrome.storage.sync.get(DEFAULT_CONFIG);
    const data = {};
    for (const k of CONFIG_KEYS) data[k] = cfg[k];
    const payload = { type: 'wis-config', version: 1, data };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'wis-config.json'; a.click();
    URL.revokeObjectURL(url);
    showStatus('配置已导出', true);
  } catch (e) {
    showStatus('导出失败：' + (e?.message || e), false);
  }
}

async function importConfigFile(ev) {
  const input = ev.target;
  const f = input.files && input.files[0];
  if (!f) return;
  try {
    const text = await f.text();
    const j = JSON.parse(text);
    const data = (j && typeof j === 'object' && j.data && typeof j.data === 'object') ? j.data : j;
    const cfg = {};
    for (const k of CONFIG_KEYS) { if (data.hasOwnProperty(k)) cfg[k] = data[k]; }
    await chrome.storage.sync.set(cfg);
    await load();
    showStatus('配置已导入', true);
  } catch (e) {
    showStatus('导入失败：' + (e?.message || e), false);
  } finally {
    input.value = '';
  }
}
