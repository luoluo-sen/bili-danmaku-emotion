// Content script injected on Bilibili video pages
// - Builds a floating panel UI
// - Asks background to fetch danmaku XML
// - Uses SiliconFlow embeddings (Qwen3) zero-shot classify emotions
// - Aggregates by time and asks injected page script to render ECharts

(function() {
  // Initialize chart manager
  let chartManager = null;

  // 默认标签原型定义
  const DEFAULT_LABELS = [
    { key: '开心',  prompt: '这条弹幕表达了开心、快乐、愉快的情绪。', polarity: 1.0,  valence: 0.9,  arousal: 0.6 },
    { key: '感动',  prompt: '这条弹幕表达了感动、温暖、被触动的情绪。', polarity: 1.0,  valence: 0.8,  arousal: 0.4 },
    { key: '惊讶',  prompt: '这条弹幕表达了惊讶、意外、震惊的情绪。', polarity: 0.0,  valence: 0.0,  arousal: 0.8 },
    { key: '中性',  prompt: '这条弹幕表达的是中性、客观、没有明显情绪。', polarity: 0.0,  valence: 0.0, arousal: 0.0 },
    { key: '悲伤',  prompt: '这条弹幕表达了悲伤、难过、失落的情绪。', polarity: -1.0, valence: -0.9, arousal: -0.5 },
    { key: '生气',  prompt: '这条弹幕表达了生气、愤怒、不满的情绪。', polarity: -1.0, valence: -0.8, arousal: 0.8 },
    { key: '厌恶',  prompt: '这条弹幕表达了厌恶、反感、讨厌的情绪。', polarity: -0.8, valence: -0.7, arousal: 0.6 },
    { key: '紧张',  prompt: '这条弹幕表达了紧张、担忧、焦虑的情绪。', polarity: -0.3, valence: -0.5, arousal: 0.7 }
  ];

  const state = {
    cfg: null,
    labels: DEFAULT_LABELS.slice(),
    labelEmbeds: null
  };
  // 暴露给跨文件工具（导出等）
  try { window.WIS = window.WIS || {}; window.WIS.state = state; } catch {}

  const formatTime = (sec) => {
    if (!Number.isFinite(sec)) return '--:--';
    const t = Math.max(0, Math.floor(sec));
    const m = Math.floor(t / 60);
    const s = t % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  const escapeHTML = (input) => String(input ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  const renderRepresentative = (rep) => {
    const label = escapeHTML(rep?.label || '情绪');
    const text = escapeHTML(rep?.text || '');
    const time = formatTime(rep?.t);
    const headerParts = [`<span class="wis-rep-label">${label}</span>`];
    if (time !== '--:--') headerParts.push(`<span class="wis-rep-time">${time}</span>`);
    if (typeof rep?.conf === 'number' && isFinite(rep.conf)) {
      headerParts.push(`<span class="wis-rep-conf">置信 ${Math.round(rep.conf * 100)}%</span>`);
    }
    return `
      <div class="wis-rep-item">
        <div class="wis-rep-header">${headerParts.join('')}</div>
        <div class="wis-rep-text">${text}</div>
      </div>
    `.trim();
  };

  // ---------- UI ----------
  const style = document.createElement('style');
  style.textContent = `
    /* ===== 简略模式：电子显示屏风格 ===== */
    .wis-mini {
      position: fixed;
      right: 20px;
      bottom: 20px;
      z-index: 2147483646;
      width: 320px;
      background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
      border: 2px solid #334155;
      border-radius: 16px;
      padding: 0;
      box-shadow:
        0 0 40px rgba(139, 92, 246, 0.15),
        0 20px 60px rgba(0, 0, 0, 0.6),
        inset 0 1px 0 rgba(255, 255, 255, 0.05);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei', monospace;
      overflow: hidden;
      transition: box-shadow 0.3s ease, border-color 0.3s ease;
      backdrop-filter: blur(20px);
      cursor: default;
    }

    .wis-mini.dragging {
      transition: none;
      opacity: 0.9;
    }

    .wis-mini:hover {
      border-color: #8b5cf6;
      box-shadow:
        0 0 50px rgba(139, 92, 246, 0.3),
        0 20px 60px rgba(0, 0, 0, 0.6);
    }

    /* 电子屏头部 */
    .wis-mini-header {
      background: linear-gradient(135deg, #8b5cf6 0%, #3b82f6 100%);
      padding: 12px 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 2px solid rgba(139, 92, 246, 0.3);
      cursor: move;
      user-select: none;
    }

    .wis-mini-header:active {
      cursor: grabbing;
    }

    .wis-mini-title {
      font-size: 14px;
      font-weight: 700;
      color: #fff;
      display: flex;
      align-items: center;
      gap: 8px;
      letter-spacing: 0.5px;
    }

    .wis-mini-badge {
      font-size: 9px;
      background: rgba(255, 255, 255, 0.2);
      padding: 3px 8px;
      border-radius: 10px;
      font-weight: 600;
      text-transform: uppercase;
    }

    .wis-mini-expand {
      all: unset;
      width: 28px;
      height: 28px;
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.15);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s ease;
      color: #fff;
      font-size: 16px;
    }

    .wis-mini-expand:hover {
      background: rgba(255, 255, 255, 0.25);
      transform: scale(1.05);
    }

    /* 电子屏数据区 */
    .wis-mini-body {
      padding: 16px;
    }

    .wis-mini-stats {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin-bottom: 16px;
    }

    .wis-stat-card {
      background: rgba(15, 23, 42, 0.6);
      border: 1px solid rgba(51, 65, 85, 0.8);
      border-radius: 12px;
      padding: 12px;
      position: relative;
      overflow: hidden;
    }

    .wis-stat-card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 2px;
      background: linear-gradient(90deg, #8b5cf6, #3b82f6);
      opacity: 0;
      transition: opacity 0.3s ease;
    }

    .wis-stat-card:hover::before {
      opacity: 1;
    }

    .wis-stat-label {
      font-size: 11px;
      color: #94a3b8;
      margin-bottom: 6px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .wis-stat-value {
      font-size: 24px;
      font-weight: 700;
      font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
      background: linear-gradient(135deg, #8b5cf6, #3b82f6);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      line-height: 1.2;
    }

    .wis-stat-value.positive {
      background: linear-gradient(135deg, #10b981, #3b82f6);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .wis-stat-value.negative {
      background: linear-gradient(135deg, #ef4444, #fb923c);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .wis-stat-unit {
      font-size: 12px;
      color: #64748b;
      margin-left: 4px;
    }

    /* 操作按钮 */
    .wis-mini-actions {
      display: flex;
      gap: 8px;
    }

    .wis-mini-btn {
      all: unset;
      flex: 1;
      padding: 10px;
      border-radius: 10px;
      text-align: center;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s ease;
      border: 1px solid;
    }

    .wis-mini-btn.primary {
      background: linear-gradient(135deg, #8b5cf6, #3b82f6);
      border-color: transparent;
      color: #fff;
      box-shadow: 0 4px 12px rgba(139, 92, 246, 0.3);
    }

    .wis-mini-btn.primary:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 16px rgba(139, 92, 246, 0.4);
    }

    .wis-mini-btn.secondary {
      background: rgba(51, 65, 85, 0.4);
      border-color: #475569;
      color: #cbd5e1;
    }

    .wis-mini-btn.secondary:hover {
      background: rgba(71, 85, 105, 0.5);
      border-color: #64748b;
    }

    .wis-mini-btn:active {
      transform: translateY(0);
    }

    .wis-mini-btn[disabled] {
      opacity: 0.5;
      cursor: not-allowed;
      transform: none !important;
    }

    /* 状态指示 */
    .wis-mini-status {
      font-size: 11px;
      color: #94a3b8;
      margin-top: 12px;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px;
      background: rgba(15, 23, 42, 0.4);
      border-radius: 8px;
    }

    .wis-mini-status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #10b981;
      animation: pulse-mini 2s infinite;
    }

    .wis-mini-status-dot.idle { background: #64748b; animation: none; }
    .wis-mini-status-dot.error { background: #ef4444; animation: none; }

    @keyframes pulse-mini {
      0%, 100% { opacity: 1; box-shadow: 0 0 8px currentColor; }
      50% { opacity: 0.6; }
    }

    /* ===== 详细模式：全屏弹窗 ===== */
    .wis-detail-modal {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: 2147483647;
      background: rgba(0, 0, 0, 0.85);
      backdrop-filter: blur(10px);
      display: none;
      align-items: center;
      justify-content: center;
      animation: fadeIn 0.3s ease;
    }

    .wis-detail-modal.active {
      display: flex;
    }

    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    .wis-detail-container {
      width: min(96vw, 1600px);
      height: min(96vh, 1000px);
      background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
      border: 2px solid #334155;
      border-radius: 24px;
      box-shadow: 0 25px 100px rgba(0, 0, 0, 0.8);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      animation: slideUp 0.4s cubic-bezier(0.4, 0, 0.2, 1);
    }

    @keyframes slideUp {
      from { opacity: 0; transform: translateY(40px) scale(0.96); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }

    .wis-detail-header {
      background: linear-gradient(135deg, #8b5cf6 0%, #3b82f6 100%);
      padding: 20px 28px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 2px solid rgba(139, 92, 246, 0.3);
    }

    .wis-detail-title {
      font-size: 20px;
      font-weight: 700;
      color: #fff;
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .wis-detail-badge {
      font-size: 11px;
      background: rgba(255, 255, 255, 0.2);
      padding: 5px 12px;
      border-radius: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .wis-detail-close {
      all: unset;
      width: 36px;
      height: 36px;
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.15);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s ease;
      color: #fff;
      font-size: 20px;
    }

    .wis-detail-close:hover {
      background: rgba(255, 255, 255, 0.25);
      transform: rotate(90deg);
    }

    .wis-detail-body {
      flex: 1;
      display: flex;
      padding: 24px;
      gap: 24px;
      overflow: hidden;
    }

    .wis-detail-sidebar {
      width: 320px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      overflow-y: auto;
      padding-right: 8px;
    }

    .wis-detail-main {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 16px;
      overflow: hidden;
    }

    /* 工具栏 */
    .wis-toolbar {
      background: rgba(15, 23, 42, 0.6);
      border: 1px solid rgba(51, 65, 85, 0.8);
      border-radius: 16px;
      padding: 12px;
      display: flex;
      gap: 12px;
      align-items: center;
    }

    .wis-tabs {
      display: flex;
      gap: 8px;
      flex: 1;
      flex-wrap: wrap;
    }

    .wis-tab {
      padding: 10px 16px;
      border-radius: 10px;
      background: rgba(30, 41, 59, 0.6);
      border: 1px solid rgba(51, 65, 85, 0.9);
      color: #cbd5e1;
      cursor: pointer;
      font-weight: 600;
      font-size: 13px;
      user-select: none;
      transition: all 0.2s ease;
    }

    .wis-tab:hover {
      background: rgba(51, 65, 85, 0.8);
      border-color: #64748b;
    }

    .wis-tab.active {
      background: linear-gradient(135deg, #8b5cf6, #3b82f6);
      border-color: transparent;
      color: #fff;
      box-shadow: 0 4px 12px rgba(139, 92, 246, 0.3);
    }

    /* 设置面板 */
    .wis-settings {
      background: rgba(15, 23, 42, 0.6);
      border: 1px solid rgba(51, 65, 85, 0.8);
      border-radius: 16px;
      padding: 20px;
      max-height: 0;
      overflow: hidden;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      opacity: 0;
    }

    .wis-settings.expanded {
      max-height: 500px;
      opacity: 1;
      margin-bottom: 16px;
    }

    .wis-settings-title {
      font-size: 14px;
      font-weight: 700;
      color: #e5e7eb;
      margin-bottom: 16px;
      padding-bottom: 12px;
      border-bottom: 1px solid rgba(51, 65, 85, 0.8);
    }

    .wis-row {
      display: grid;
      grid-template-columns: 88px 1fr;
      gap: 10px;
      align-items: center;
      margin: 12px 0;
    }

    .wis-row-buttons {
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
    }

    .wis-input {
      flex: 1;
      min-width: 0;
      background: rgba(15, 23, 42, 0.8);
      color: #e5e7eb;
      border: 1px solid rgba(51, 65, 85, 0.8);
      border-radius: 10px;
      padding: 10px 14px;
      font-size: 13px;
      transition: all 0.2s ease;
    }

    .wis-input:focus {
      outline: none;
      border-color: #8b5cf6;
      box-shadow: 0 0 0 3px rgba(139, 92, 246, 0.2);
    }

    .wis-label {
      min-width: 80px;
      color: #94a3b8;
      font-size: 13px;
      font-weight: 600;
      text-align: right;
    }

    .wis-btn {
      all: unset;
      padding: 8px 16px;
      border-radius: 10px;
      cursor: pointer;
      font-weight: 600;
      font-size: 13px;
      transition: all 0.2s ease;
      text-align: center;
    }

    .wis-row-buttons .wis-btn {
      justify-self: stretch;
    }

    .wis-btn.primary {
      background: linear-gradient(135deg, #8b5cf6, #3b82f6);
      color: #fff;
      box-shadow: 0 4px 12px rgba(139, 92, 246, 0.3);
    }

    .wis-btn.primary:hover {
      transform: translateY(-1px);
      box-shadow: 0 6px 16px rgba(139, 92, 246, 0.4);
    }

    .wis-btn.secondary {
      background: rgba(51, 65, 85, 0.8);
      color: #cbd5e1;
      border: 1px solid rgba(71, 85, 105, 0.5);
    }

    .wis-btn.secondary:hover {
      background: rgba(71, 85, 105, 0.8);
    }

    /* 图表容器 */
    #wis-chart {
      flex: 1;
      min-height: 640px;
      border-radius: 16px;
      overflow: hidden;
      background: rgba(11, 18, 34, 0.8);
      border: 1px solid rgba(31, 41, 55, 0.6);
    }

    /* 代表弹幕 */
    #wis-reps {
      background: rgba(15, 23, 42, 0.6);
      border: 1px solid rgba(51, 65, 85, 0.8);
      border-radius: 16px;
      padding: 12px;
      min-height: 320px;
      max-height: 500px;
      flex: 1 1 auto;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 8px;
      position: relative;
      order: -1;
    }

    #wis-reps::after {
      content: '向下滚动查看更多 ↓';
      position: sticky;
      bottom: 0;
      left: 0;
      right: 0;
      background: linear-gradient(to bottom, transparent, rgba(15, 23, 42, 0.95) 30%);
      color: #64748b;
      font-size: 11px;
      text-align: center;
      padding: 12px 0 6px 0;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.2s ease;
    }

    #wis-reps:hover::after,
    #wis-reps.has-scroll::after {
      opacity: 1;
    }

    .wis-rep-title {
      font-weight: 700;
      color: #cbd5e1;
      margin-bottom: 0;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      position: sticky;
      top: 0;
      background: rgba(15, 23, 42, 0.95);
      backdrop-filter: blur(8px);
      padding: 8px 0;
      z-index: 10;
      border-bottom: 1px solid rgba(100, 116, 139, 0.2);
    }

    .wis-rep-item {
      padding: 10px 12px;
      border: 1px solid rgba(75, 85, 99, 0.4);
      border-radius: 8px;
      color: #e5e7eb;
      background: rgba(2, 6, 23, 0.5);
      font-size: 12px;
      line-height: 1.6;
      transition: all 0.2s ease;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .wis-rep-item:hover {
      background: rgba(51, 65, 85, 0.4);
      border-color: #8b5cf6;
    }

    .wis-rep-header {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    .wis-rep-label {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 10px;
      font-weight: 600;
      background: linear-gradient(135deg, #8b5cf6, #3b82f6);
      color: #fff;
    }

    .wis-rep-time {
      font-size: 11px;
      font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
      color: #a5b4fc;
      background: rgba(79, 70, 229, 0.12);
      border-radius: 999px;
      padding: 2px 8px;
    }

    .wis-rep-conf {
      font-size: 10px;
      color: #94a3b8;
      background: rgba(148, 163, 184, 0.15);
      border-radius: 999px;
      padding: 2px 6px;
    }

    .wis-rep-text {
      color: #e2e8f0;
      line-height: 1.7;
      word-break: break-word;
      font-size: 13px;
      padding-top: 2px;
    }

    /* 日志 */
    .wis-log {
      font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
      font-size: 14px;
      line-height: 1.8;
      letter-spacing: 0.2px;
      max-height: 280px;
      flex-shrink: 0;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
      background: linear-gradient(135deg, rgba(22, 30, 48, 0.92), rgba(28, 43, 75, 0.88));
      border: 1px solid rgba(148, 163, 184, 0.35);
      box-shadow:
        inset 0 0 30px rgba(30, 64, 175, 0.18),
        0 12px 30px rgba(15, 23, 42, 0.45);
      border-radius: 18px;
      padding: 20px;
      color: #f8fafc;
      text-shadow: 0 0 6px rgba(8, 14, 28, 0.5);
      order: 999;
    }

    .wis-log-line {
      display: flex;
      gap: 10px;
      align-items: flex-start;
      padding: 6px 0;
      border-bottom: 1px solid rgba(148, 163, 184, 0.18);
    }

    .wis-log-line::before {
      content: '';
      flex: 0 0 6px;
      height: 6px;
      margin-top: 8px;
      border-radius: 50%;
      background: linear-gradient(135deg, #8b5cf6, #3b82f6);
      box-shadow: 0 0 6px rgba(59, 130, 246, 0.6);
    }

    .wis-log-line:last-child {
      border-bottom: none;
      font-weight: 600;
      color: #e0e7ff;
    }

    .wis-log-line:last-child::before {
      background: linear-gradient(135deg, #22d3ee, #3b82f6);
    }

    /* 进度条 */
    .wis-progress {
      width: 100%;
      height: 4px;
      background: rgba(51, 65, 85, 0.4);
      border-radius: 2px;
      margin: 12px 0;
      overflow: hidden;
    }

    .wis-progress-bar {
      height: 100%;
      background: linear-gradient(90deg, #8b5cf6, #3b82f6);
      border-radius: 2px;
      transition: width 0.3s ease;
      width: 0%;
      box-shadow: 0 0 10px rgba(139, 92, 246, 0.5);
    }

    /* 统计卡片（侧边栏） */
    .wis-info-card {
      background: rgba(15, 23, 42, 0.6);
      border: 1px solid rgba(51, 65, 85, 0.8);
      border-radius: 16px;
      padding: 16px;
      flex-shrink: 0;
    }

    .wis-info-card.collapsible {
      cursor: pointer;
      user-select: none;
    }

    .wis-info-card.collapsible .wis-info-title::before {
      content: '▼ ';
      font-size: 10px;
      display: inline-block;
      transition: transform 0.2s ease;
      margin-right: 4px;
      color: #8b5cf6;
    }

    .wis-info-card.collapsible.collapsed .wis-info-title::before {
      transform: rotate(-90deg);
    }

    .wis-info-card.collapsible.collapsed .wis-info-content {
      display: none;
    }

    .wis-info-title {
      font-size: 12px;
      color: #94a3b8;
      margin-bottom: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .wis-info-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }

    .wis-info-item {
      text-align: center;
    }

    .wis-info-value {
      font-size: 20px;
      font-weight: 700;
      font-family: 'SF Mono', Monaco, monospace;
      background: linear-gradient(135deg, #8b5cf6, #3b82f6);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 4px;
    }

    .wis-info-label {
      font-size: 11px;
      color: #64748b;
    }

    /* AI Summary */
    .wis-summary-list {
      display: flex;
      flex-direction: column;
      gap: 12px;
      position: relative;
      padding-left: 18px;
    }

    .wis-summary-list::before {
      content: '';
      position: absolute;
      left: 8px;
      top: 4px;
      bottom: 4px;
      width: 2px;
      background: linear-gradient(180deg, rgba(139, 92, 246, 0.35), rgba(59, 130, 246, 0.15));
    }

    .wis-summary-item {
      position: relative;
      padding: 12px 16px 12px 20px;
      border-radius: 12px;
      background: rgba(15, 23, 42, 0.65);
      border: 1px solid rgba(51, 65, 85, 0.65);
      color: #cbd5e1;
      cursor: pointer;
      transition: all 0.2s ease;
      line-height: 1.6;
    }

    .wis-summary-item::before {
      content: '';
      position: absolute;
      left: -12px;
      top: 14px;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: linear-gradient(135deg, #8b5cf6, #3b82f6);
      box-shadow: 0 0 0 4px rgba(139, 92, 246, 0.15);
    }

    .wis-summary-item:hover {
      background: rgba(39, 51, 77, 0.75);
      border-color: rgba(100, 116, 139, 0.9);
    }

    .wis-summary-item.active {
      box-shadow: 0 0 0 2px rgba(139, 92, 246, 0.45);
      border-color: rgba(139, 92, 246, 0.6);
    }

    .wis-summary-item.active::before {
      box-shadow: 0 0 0 4px rgba(139, 92, 246, 0.35);
    }

    .wis-summary-time {
      color: #93c5fd;
      font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
      margin-right: 6px;
    }

    .wis-summary-sub {
      margin-top: 8px;
      margin-left: 0;
      padding-left: 16px;
      border-left: 1px dashed rgba(148, 163, 184, 0.35);
      opacity: 0.85;
      display: block;
    }

    .wis-summary-sub.active {
      color: #f8fafc;
      font-weight: 600;
    }

    /* 滚动条美化 */
    .wis-detail-sidebar::-webkit-scrollbar,
    #wis-reps::-webkit-scrollbar,
    .wis-log::-webkit-scrollbar {
      width: 6px;
    }

    .wis-detail-sidebar::-webkit-scrollbar-track,
    #wis-reps::-webkit-scrollbar-track,
    .wis-log::-webkit-scrollbar-track {
      background: rgba(30, 41, 59, 0.4);
      border-radius: 3px;
    }

    .wis-detail-sidebar::-webkit-scrollbar-thumb,
    #wis-reps::-webkit-scrollbar-thumb,
    .wis-log::-webkit-scrollbar-thumb {
      background: rgba(139, 92, 246, 0.4);
      border-radius: 3px;
    }

    .wis-detail-sidebar::-webkit-scrollbar-thumb:hover,
    #wis-reps::-webkit-scrollbar-thumb:hover,
    .wis-log::-webkit-scrollbar-thumb:hover {
      background: rgba(139, 92, 246, 0.6);
    }

    /* 响应式 */
    @media (max-width: 768px) {
      .wis-detail-body {
        flex-direction: column;
      }
      .wis-detail-sidebar {
        width: 100%;
        max-height: 200px;
      }
    }

    /* Toast 通知 */
    .wis-toast {
      position: fixed;
      top: 80px;
      right: 20px;
      z-index: 2147483648;
      min-width: 280px;
      max-width: 400px;
      background: linear-gradient(135deg, #1f2937 0%, #111827 100%);
      border: 2px solid #8b5cf6;
      border-radius: 12px;
      padding: 16px 20px;
      box-shadow: 0 10px 40px rgba(139, 92, 246, 0.4);
      display: flex;
      align-items: center;
      gap: 12px;
      animation: slideInRight 0.3s ease;
      pointer-events: auto;
    }

    .wis-toast.success { border-color: #10b981; box-shadow: 0 10px 40px rgba(16, 185, 129, 0.4); }
    .wis-toast.error { border-color: #ef4444; box-shadow: 0 10px 40px rgba(239, 68, 68, 0.4); }
    .wis-toast.warning { border-color: #f59e0b; box-shadow: 0 10px 40px rgba(245, 158, 11, 0.4); }

    .wis-toast-icon {
      font-size: 24px;
      flex-shrink: 0;
    }

    .wis-toast-content {
      flex: 1;
      color: #e5e7eb;
      font-size: 14px;
      line-height: 1.5;
    }

    .wis-toast-title {
      font-weight: 700;
      margin-bottom: 4px;
      font-size: 15px;
    }

    .wis-toast-message {
      color: #9ca3af;
      font-size: 13px;
    }

    .wis-toast-close {
      all: unset;
      cursor: pointer;
      color: #9ca3af;
      font-size: 18px;
      padding: 4px;
      transition: color 0.2s ease;
    }

    .wis-toast-close:hover {
      color: #e5e7eb;
    }

    @keyframes slideInRight {
      from { opacity: 0; transform: translateX(100px); }
      to { opacity: 1; transform: translateX(0); }
    }

    /* 骨架屏 */
    .wis-skeleton {
      position: absolute;
      inset: 0;
      background: rgba(11, 18, 34, 0.95);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      z-index: 10;
      border-radius: 16px;
    }

    .wis-skeleton-box {
      width: 80%;
      max-width: 400px;
      background: linear-gradient(90deg, rgba(51, 65, 85, 0.3) 0%, rgba(71, 85, 105, 0.5) 50%, rgba(51, 65, 85, 0.3) 100%);
      background-size: 200% 100%;
      animation: skeleton-loading 1.5s infinite;
      border-radius: 8px;
      margin: 8px 0;
    }

    .wis-skeleton-box.h-12 { height: 12px; }
    .wis-skeleton-box.h-20 { height: 20px; }
    .wis-skeleton-box.h-32 { height: 32px; }
    .wis-skeleton-box.h-64 { height: 64px; }
    .wis-skeleton-box.w-60 { width: 60%; }
    .wis-skeleton-box.w-80 { width: 80%; }

    @keyframes skeleton-loading {
      0% { background-position: 200% 0; }
      100% { background-position: -200% 0; }
    }

    .wis-skeleton-spinner {
      width: 48px;
      height: 48px;
      border: 4px solid rgba(139, 92, 246, 0.2);
      border-top-color: #8b5cf6;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin-bottom: 24px;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .wis-skeleton-text {
      color: #9ca3af;
      font-size: 14px;
      margin-top: 16px;
      text-align: center;
    }
  `;
  document.documentElement.appendChild(style);

  // 简略模式面板（电子显示屏）
  const miniPanel = document.createElement('div');
  miniPanel.className = 'wis-mini';
  miniPanel.innerHTML = `
    <div class="wis-mini-header">
      <div class="wis-mini-title">
        弹幕情绪分析
        <span class="wis-mini-badge">AI</span>
      </div>
      <button class="wis-mini-expand" id="wis-expand" title="展开详情">⇱</button>
    </div>
    <div class="wis-mini-body">
      <div class="wis-mini-stats">
        <div class="wis-stat-card">
          <div class="wis-stat-label">弹幕数</div>
          <div class="wis-stat-value" id="mini-count">-</div>
        </div>
        <div class="wis-stat-card">
          <div class="wis-stat-label">平均情感</div>
          <div class="wis-stat-value" id="mini-sentiment">-</div>
        </div>
      </div>
      <div class="wis-mini-actions">
        <button class="wis-mini-btn primary" id="mini-run">
          <span id="mini-run-text">开始分析</span>
        </button>
        <button class="wis-mini-btn secondary" id="mini-settings">⚙️</button>
      </div>
      <div class="wis-mini-status">
        <div class="wis-mini-status-dot idle" id="mini-status-dot"></div>
        <span id="mini-status-text">准备就绪</span>
      </div>
    </div>
  `;
  document.body.appendChild(miniPanel);

  // 详细模式弹窗
  const detailModal = document.createElement('div');
  detailModal.className = 'wis-detail-modal';
  detailModal.innerHTML = `
    <div class="wis-detail-container">
      <div class="wis-detail-header">
        <div class="wis-detail-title">
          弹幕情绪分析
          <span class="wis-detail-badge">Qwen Embedding</span>
        </div>
        <button class="wis-detail-close" id="detail-close">✕</button>
      </div>
      <div class="wis-detail-body">
        <div class="wis-detail-sidebar">
          <!-- 统计卡片 -->
          <div class="wis-info-card">
            <div class="wis-info-title">数据统计</div>
            <div class="wis-info-grid">
              <div class="wis-info-item">
                <div class="wis-info-value" id="detail-total">-</div>
                <div class="wis-info-label">总弹幕</div>
              </div>
              <div class="wis-info-item">
                <div class="wis-info-value" id="detail-analyzed">-</div>
                <div class="wis-info-label">已分析</div>
              </div>
              <div class="wis-info-item">
                <div class="wis-info-value" id="detail-positive">-</div>
                <div class="wis-info-label">积极</div>
              </div>
              <div class="wis-info-item">
                <div class="wis-info-value" id="detail-negative">-</div>
                <div class="wis-info-label">消极</div>
              </div>
            </div>
          </div>

          <!-- 速率监测 -->
          <div class="wis-info-card collapsible collapsed" id="wis-rate-card">
            <div class="wis-info-title">速率监测</div>
            <div class="wis-info-content">
              <div class="wis-info-grid">
                <div class="wis-info-item" style="grid-column: span 2">
                  <div class="wis-info-value" id="wis-rate">RPM 0/2000 · TPM 0/1000000</div>
                  <div class="wis-info-label">近 60 秒用量（页面侧估算）</div>
                </div>
              </div>
            </div>
          </div>

          <!-- AI 总结 -->
          <div class="wis-info-card collapsible" id="wis-summary" style="display:none;">
            <div class="wis-info-title">AI 总结</div>
            <div class="wis-info-content">
              <div id="wis-summary-abstract" class="wis-info-text" style="color:#94a3b8;font-size:12px;line-height:1.6;margin-bottom:8px;"></div>
              <div id="wis-summary-list" class="wis-summary-list"></div>
            </div>
          </div>

          <!-- 设置面板 -->
          <div class="wis-settings" id="wis-settings">
            <div class="wis-settings-title">🔧 快速设置</div>
            <div class="wis-row">
              <div class="wis-label">API Key</div>
              <input class="wis-input" id="wis-apiKey" type="password" placeholder="输入 API Key" />
            </div>
            <div class="wis-row">
              <div class="wis-label">温度 τ</div>
              <input class="wis-input" id="wis-clsTemp" type="number" value="0.08" min="0.01" max="1" step="0.01" />
            </div>
            <div class="wis-row">
              <div class="wis-label">最佳下限</div>
              <input class="wis-input" id="wis-clsBest" type="number" value="0.20" min="0" max="1" step="0.01" />
            </div>
            <div class="wis-row">
              <div class="wis-label">差距下限</div>
              <input class="wis-input" id="wis-clsMargin" type="number" value="0.06" min="0" max="1" step="0.01" />
            </div>
            <div class="wis-row wis-row-buttons">
              <button class="wis-btn secondary" id="wis-eye">👁️</button>
              <button class="wis-btn secondary" id="wis-reset-params" title="重置分类参数为默认值">重置默认</button>
              <button class="wis-btn primary" id="wis-save">保存</button>
            </div>
            <div class="wis-progress">
              <div class="wis-progress-bar" id="wis-progress-bar"></div>
            </div>
          </div>

          <!-- 代表弹幕 -->
          <div id="wis-reps" style="display:none"></div>

          <!-- 日志 -->
          <div class="wis-log" id="wis-log"></div>
        </div>

        <div class="wis-detail-main">
          <!-- 工具栏 -->
          <div class="wis-toolbar">
            <div class="wis-tabs" id="wis-tabs">
              <div class="wis-tab active" data-view="trend">📈 强度曲线</div>
              <div class="wis-tab" data-view="stack">📊 情绪分布</div>
              <div class="wis-tab" data-view="quadrant">🎯 情绪二维图</div>
              <div class="wis-tab" data-view="cloud">🔎 关键词</div>
              <div class="wis-tab" data-view="pie">🥧 占比</div>
            </div>
            <button class="wis-btn secondary" id="wis-export" title="导出数据">📥 导出</button>
            <button class="wis-btn secondary" id="wis-toggle">⚙️ 设置</button>
          </div>

          <!-- 图表区域 -->
          <div id="wis-chart"></div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(detailModal);

  // DOM 元素引用
  // 简略模式
  const $miniRun = miniPanel.querySelector('#mini-run');
  const $miniRunText = miniPanel.querySelector('#mini-run-text');
  const $miniSettings = miniPanel.querySelector('#mini-settings');
  const $miniCount = miniPanel.querySelector('#mini-count');
  const $miniSentiment = miniPanel.querySelector('#mini-sentiment');
  const $miniStatusDot = miniPanel.querySelector('#mini-status-dot');
  const $miniStatusText = miniPanel.querySelector('#mini-status-text');
  const $expandBtn = miniPanel.querySelector('#wis-expand');

  // 详细模式
  const $detailClose = detailModal.querySelector('#detail-close');
  const $toggle = detailModal.querySelector('#wis-toggle');
  const $exportBtn = detailModal.querySelector('#wis-export');
  const $tabs = detailModal.querySelector('#wis-tabs');
  const $settings = detailModal.querySelector('#wis-settings');
  const $apiKey = detailModal.querySelector('#wis-apiKey');
  const $saveBtn = detailModal.querySelector('#wis-save');
  const $eyeBtn = detailModal.querySelector('#wis-eye');
  const $clsTemp = detailModal.querySelector('#wis-clsTemp');
  const $clsBest = detailModal.querySelector('#wis-clsBest');
  const $clsMargin = detailModal.querySelector('#wis-clsMargin');
  const $resetParams = detailModal.querySelector('#wis-reset-params');
  const $log = detailModal.querySelector('#wis-log');
  const $progressBar = detailModal.querySelector('#wis-progress-bar');
  const $reps = detailModal.querySelector('#wis-reps');
  const $detailTotal = detailModal.querySelector('#detail-total');
  const $detailAnalyzed = detailModal.querySelector('#detail-analyzed');
  const $detailPositive = detailModal.querySelector('#detail-positive');
  const $detailNegative = detailModal.querySelector('#detail-negative');
  const $rateUI = detailModal.querySelector('#wis-rate');
  const $summaryCard = detailModal.querySelector('#wis-summary');
  const $summaryAbstract = detailModal.querySelector('#wis-summary-abstract');
  const $summaryList = detailModal.querySelector('#wis-summary-list');

  // 速率监控变量
  let rateWindow = [];
  const RATE_WINDOW_MS = 60_000;

  const pruneRateWindow = (now = Date.now()) => {
    const cutoff = now - RATE_WINDOW_MS;
    while (rateWindow.length && rateWindow[0].t < cutoff) rateWindow.shift();
    return cutoff;
  };

  const recordRateSample = (tokens, now = Date.now()) => {
    rateWindow.push({ t: now, tokens });
    pruneRateWindow(now);
  };

  // 导出按钮菜单
  $exportBtn.addEventListener('click', () => {
    const menu = document.createElement('div');
    menu.style.cssText = `
      position: absolute;
      background: linear-gradient(135deg, #1f2937 0%, #111827 100%);
      border: 2px solid #8b5cf6;
      border-radius: 12px;
      padding: 8px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.6);
      z-index: 99999;
      min-width: 160px;
    `;
    menu.innerHTML = `
      <div style="padding:8px 12px;cursor:pointer;border-radius:8px;color:#e5e7eb;font-size:13px;font-weight:600;transition:all 0.2s ease;" onmouseover="this.style.background='rgba(139,92,246,0.2)'" onmouseout="this.style.background='transparent'" data-action="json">📄 导出 JSON</div>
      <div style="padding:8px 12px;cursor:pointer;border-radius:8px;color:#e5e7eb;font-size:13px;font-weight:600;transition:all 0.2s ease;" onmouseover="this.style.background='rgba(139,92,246,0.2)'" onmouseout="this.style.background='transparent'" data-action="csv">📊 导出 CSV</div>
      <div style="padding:8px 12px;cursor:pointer;border-radius:8px;color:#e5e7eb;font-size:13px;font-weight:600;transition:all 0.2s ease;" onmouseover="this.style.background='rgba(139,92,246,0.2)'" onmouseout="this.style.background='transparent'" data-action="markdown">📝 生成报告</div>
    `;
    const rect = $exportBtn.getBoundingClientRect();
    menu.style.top = `${rect.bottom + 8}px`;
    menu.style.right = `${window.innerWidth - rect.right}px`;
    document.body.appendChild(menu);

    menu.addEventListener('click', (e) => {
      const action = e.target.getAttribute('data-action');
      try {
        if (action && window.WIS && WIS.exporter && typeof WIS.exporter[action] === 'function') {
          WIS.state = state;
          WIS.exporter[action](state);
          showToast('导出成功', `${action.toUpperCase()} 文件已下载`, 'success');
        }
      } catch (err) {
        console.error('[WIS] 导出失败:', err);
        showToast('导出失败', (err && err.message) || '未知错误', 'error');
      } finally {
        menu.remove();
      }
    });

    const closeMenu = (e) => {
      if (!menu.contains(e.target) && e.target !== $exportBtn) {
        menu.remove();
        document.removeEventListener('click', closeMenu);
      }
    };
    setTimeout(() => document.addEventListener('click', closeMenu), 100);
  });

  const log = (m) => {
    if (!$log) return;
    const line = document.createElement('div');
    line.className = 'wis-log-line';
    line.textContent = m;
    $log.appendChild(line);
    $log.scrollTop = $log.scrollHeight;
  };

  const updateMiniStatus = (status, text) => {
    $miniStatusDot.className = `wis-mini-status-dot ${status}`;
    $miniStatusText.textContent = text;
  };

  const updateProgress = (percent) => {
    $progressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  };

  

  const updateMiniStats = (count, avgSentiment) => {
    $miniCount.textContent = count || '-';
    if (avgSentiment !== null && avgSentiment !== undefined) {
      const formatted = avgSentiment.toFixed(2);
      $miniSentiment.textContent = formatted;
      $miniSentiment.className = 'wis-stat-value';
      if (avgSentiment > 0.1) $miniSentiment.classList.add('positive');
      else if (avgSentiment < -0.1) $miniSentiment.classList.add('negative');
    } else {
      $miniSentiment.textContent = '-';
    }
  };

  const updateDetailStats = (total, analyzed, positive, negative) => {
    $detailTotal.textContent = total || '-';
    $detailAnalyzed.textContent = analyzed || '-';
    $detailPositive.textContent = positive || '-';
    $detailNegative.textContent = negative || '-';
  };

  const updateRateUI = () => {
    if (!$rateUI) return;
    const now = Date.now();
    pruneRateWindow(now);
    let req = 0, tok = 0;
    for (const r of rateWindow) {
      req++;
      tok += r.tokens;
    }
    const rpmLimit = state.cfg?.rpmLimit || 2000;
    const tpmLimit = state.cfg?.tpmLimit || 1000000;
    $rateUI.textContent = `RPM ${req}/${rpmLimit} · TPM ${tok}/${tpmLimit}`;
  };

  // Toast 通知系统
  const showToast = (title, message, type = 'info', duration = 3000) => {
    const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
    const toast = document.createElement('div');
    toast.className = `wis-toast ${type}`;
    toast.innerHTML = `
      <div class="wis-toast-icon">${icons[type] || icons.info}</div>
      <div class="wis-toast-content">
        <div class="wis-toast-title">${title}</div>
        ${message ? `<div class="wis-toast-message">${message}</div>` : ''}
      </div>
      <button class="wis-toast-close">✕</button>
    `;
    document.body.appendChild(toast);

    const closeBtn = toast.querySelector('.wis-toast-close');
    const remove = () => {
      toast.style.animation = 'slideInRight 0.3s ease reverse';
      setTimeout(() => toast.remove(), 300);
    };
    closeBtn.addEventListener('click', remove);
    if (duration > 0) setTimeout(remove, duration);
  };

  // 拖拽功能
  const initDrag = () => {
    const header = miniPanel.querySelector('.wis-mini-header');
    let isDragging = false;
    let startX, startY, startLeft, startTop;

    // 从 localStorage 恢复位置
    const savedPos = localStorage.getItem('wis-mini-position');
    if (savedPos) {
      try {
        const { left, top } = JSON.parse(savedPos);
        miniPanel.style.left = `${left}px`;
        miniPanel.style.top = `${top}px`;
        miniPanel.style.right = 'auto';
        miniPanel.style.bottom = 'auto';
      } catch {}
    }

    header.addEventListener('mousedown', (e) => {
      if (e.target.closest('.wis-mini-expand')) return;
      isDragging = true;
      miniPanel.classList.add('dragging');

      const rect = miniPanel.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      startLeft = rect.left;
      startTop = rect.top;

      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;

      const deltaX = e.clientX - startX;
      const deltaY = e.clientY - startY;
      let newLeft = startLeft + deltaX;
      let newTop = startTop + deltaY;

      // 边界限制
      const maxX = window.innerWidth - miniPanel.offsetWidth;
      const maxY = window.innerHeight - miniPanel.offsetHeight;
      newLeft = Math.max(0, Math.min(maxX, newLeft));
      newTop = Math.max(0, Math.min(maxY, newTop));

      miniPanel.style.left = `${newLeft}px`;
      miniPanel.style.top = `${newTop}px`;
      miniPanel.style.right = 'auto';
      miniPanel.style.bottom = 'auto';
    });

    document.addEventListener('mouseup', () => {
      if (!isDragging) return;
      isDragging = false;
      miniPanel.classList.remove('dragging');

      // 吸附边缘
      const rect = miniPanel.getBoundingClientRect();
      const snapThreshold = 50;
      let finalLeft = rect.left;
      let finalTop = rect.top;

      if (rect.left < snapThreshold) finalLeft = 0;
      if (rect.top < snapThreshold) finalTop = 0;
      if (window.innerWidth - rect.right < snapThreshold) finalLeft = window.innerWidth - miniPanel.offsetWidth;
      if (window.innerHeight - rect.bottom < snapThreshold) finalTop = window.innerHeight - miniPanel.offsetHeight;

      miniPanel.style.left = `${finalLeft}px`;
      miniPanel.style.top = `${finalTop}px`;

      // 保存位置
      localStorage.setItem('wis-mini-position', JSON.stringify({ left: finalLeft, top: finalTop }));
    });
  };

  // 键盘快捷键
  const initKeyboardShortcuts = () => {
    document.addEventListener('keydown', (e) => {
      // Ctrl+Shift+E: 打开/关闭详细模式
      if (e.ctrlKey && e.shiftKey && e.key === 'E') {
        e.preventDefault();
        const willOpen = !detailModal.classList.contains('active');
        detailModal.classList.toggle('active');
        if (willOpen) {
          try { ensureChartManager().then(() => pokeResize()); } catch {}
        }
        showToast('快捷键', detailModal.classList.contains('active') ? '详细模式已打开' : '详细模式已关闭', 'info', 1500);
        return;
      }

      // Esc: 关闭详细模式
      if (e.key === 'Escape' && detailModal.classList.contains('active')) {
        detailModal.classList.remove('active');
        return;
      }

      // 数字键切换视图（仅当详细模式打开时）
      if (detailModal.classList.contains('active') && /^[1-5]$/.test(e.key)) {
        const views = ['trend', 'stack', 'quadrant', 'cloud', 'pie'];
        const view = views[parseInt(e.key) - 1];
        if (view) {
          setActive(view);
          if (state._trend) {
            if (view==='trend') renderTrend(state._trend.series, state._trend.count, state._trend.arousal);
            else if (view==='stack') renderStack(state._stack.stackSeries, state._stack.labels);
            else if (view==='quadrant') renderQuadrant(state._quad.points);
            else if (view==='cloud') renderWordCloud(state._words);
            else if (view==='pie') renderPie(state._pie.data);
          }
        }
        return;
      }

      // Ctrl+Enter: 开始分析
      if (e.ctrlKey && e.key === 'Enter' && !$miniRun.disabled) {
        e.preventDefault();
        $miniRun.click();
        return;
      }
    });
  };

  // 性能监控
  const perfMonitor = {
    startTime: 0,
    stages: {},
    apiCalls: 0,
    start() {
      this.startTime = Date.now();
      this.stages = {};
      this.apiCalls = 0;
    },
    mark(stage) {
      this.stages[stage] = Date.now() - this.startTime;
    },
    addAPI() {
      this.apiCalls++;
    },
    end() {
      const total = Date.now() - this.startTime;
      return { total, stages: this.stages, apiCalls: this.apiCalls };
    }
  };

  // 数据导出功能
  // 导出实现已移至 WIS.exporter（见 src/exporter.js）

  function pokeResize(times = [60, 250, 800]) {
    try { times.forEach(t => setTimeout(() => { try { chartManager && chartManager.resize(); } catch {} }, t)); } catch {}
  }

  // 展开/关闭详细模式
  $expandBtn.addEventListener('click', async () => {
    detailModal.classList.add('active');
    try { await ensureChartManager(); pokeResize(); } catch {}
  });

  $detailClose.addEventListener('click', () => {
    detailModal.classList.remove('active');
  });

  // 简略模式设置按钮打开详细模式设置
  $miniSettings.addEventListener('click', async () => {
    detailModal.classList.add('active');
    $settings.classList.add('expanded');
    try { await ensureChartManager(); pokeResize(); } catch {}
  });

  // 设置面板切换
  $toggle.addEventListener('click', () => {
    $settings.classList.toggle('expanded');
  });

  async function saveApiKey() {
    const key = ($apiKey.value || '').trim();
    const temp = Math.max(0.01, Math.min(1, Number($clsTemp?.value || '0.08')));
    const best = Math.max(0, Math.min(1, Number($clsBest?.value || '0.2')));
    const margin = Math.max(0, Math.min(1, Number($clsMargin?.value || '0.06')));
    await callBG('set.config', { cfg: { apiKey: key, classifyTemp: temp, classifyMinBest: best, classifyMinMargin: margin } });
    const cfgResp = await callBG('get.config');
    if (cfgResp.ok) state.cfg = cfgResp.cfg;
    log('✅ 设置已保存（API/分类参数）');
    updateMiniStatus('idle', '配置已更新');
  }

  $saveBtn.addEventListener('click', saveApiKey);
  $eyeBtn.addEventListener('click', () => {
    $apiKey.type = ($apiKey.type === 'password') ? 'text' : 'password';
  });
  if ($resetParams) {
    $resetParams.addEventListener('click', async () => {
      if ($clsTemp) $clsTemp.value = '0.08';
      if ($clsBest) $clsBest.value = '0.20';
      if ($clsMargin) $clsMargin.value = '0.06';
      await callBG('set.config', { cfg: { classifyTemp: 0.08, classifyMinBest: 0.2, classifyMinMargin: 0.06 } });
      const cfgResp = await callBG('get.config');
      if (cfgResp.ok) state.cfg = cfgResp.cfg;
      log('🔄 已恢复分类参数默认值');
      updateMiniStatus('idle', '配置已更新');
    });
  }

  // ---------- helpers ----------
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const chunk = (arr, n=64) => arr.reduce((acc,_,i)=> (i % n ? acc : [...acc, arr.slice(i, i+n)]), []);
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  // sum 已迁移至 WIS.utils.sum

  // 分类参数与函数（默认值，实际以选项页为准）
  const CLASSIFY_DEFAULT = { temp: 0.08, minBest: 0.2, minMargin: 0.06, neutralKey: '中性' };
  function getClassifyCfg() {
    const cfg = state.cfg || {};
    const clampNum = (v, a, b, d) => {
      const n = Number(v); if (!isFinite(n)) return d; return Math.max(a, Math.min(b, n));
    };
    return {
      temp: clampNum(cfg.classifyTemp, 0.01, 1.0, CLASSIFY_DEFAULT.temp),
      minBest: clampNum(cfg.classifyMinBest, 0.0, 1.0, CLASSIFY_DEFAULT.minBest),
      minMargin: clampNum(cfg.classifyMinMargin, 0.0, 1.0, CLASSIFY_DEFAULT.minMargin),
      neutralKey: CLASSIFY_DEFAULT.neutralKey
    };
  }
  function softmax(arr, temp = 1.0) {
    if (!arr.length) return [];
    const t = Math.max(1e-6, temp);
    const mx = Math.max(...arr);
    const exps = arr.map(v => Math.exp((v - mx) / t));
    const s = exps.reduce((a,b)=>a+b,0) || 1;
    return exps.map(v => v / s);
  }

  // Stopwords & whitelist (from options)
  state.stopwords = new Set();
  state.whitelist = new Set();
  const STOP_BUILTIN_MAP = { cn:'stopwords_cn.txt', hit:'stopwords_hit.txt', baidu:'stopwords_baidu.txt', scu:'stopwords_scu.txt', full:'stopwords_full.txt', english:'stopwords_english.txt' };
  async function ensureLexicons() {
    state.stopwords = new Set();
    state.whitelist = new Set();
    const cfg = state.cfg || {};
    if (cfg.enableStopwords) {
      const file = STOP_BUILTIN_MAP[cfg.stopwordsBuiltIn || 'full'];
      if (file) {
        try { const url = chrome.runtime.getURL(file); const txt = await fetch(url).then(r=>r.text()); txt.split(/\r?\n/).forEach(w=>{ w=w.trim(); if (w) state.stopwords.add(w); }); } catch {}
      }
      if (cfg.customStopwords) String(cfg.customStopwords).split(/\r?\n/).forEach(w=>{ w=w.trim(); if (w) state.stopwords.add(w); });
    }
    if (cfg.enableWhitelist && cfg.customWhitelist) String(cfg.customWhitelist).split(/\r?\n/).forEach(w=>{ w=w.trim(); if (w) state.whitelist.add(w); });
  }

  // 常见无信息词（词云/分词忽略）
  const IGNORE_WORDS = new Set(['视频','关注','点赞','投币','收藏','三连','转发']);

  // 文本规范化（表情/梗/重复等）
  function normalizeText(text) {
    if (!text) return '';
    let t = String(text);
    // 去链接、BV/AV、方括号表情
    t = t.replace(/(?:https?|ftp):\/\/[^\s]+/g, '');
    t = t.replace(/[bB][vV]1[0-9A-Za-z]{9}/g, '').replace(/[aA][vV]\d+/g, '');
    t = t.replace(/\[([^\]]+)\]/g, '$1');
    // 哈哈/233/xswl/笑死 -> 哈哈
    t = t.replace(/哈{3,}/g, '哈哈');
    t = t.replace(/2{3,}/g, '233');
    t = t.replace(/(xswl|笑死|笑疯|笑翻|笑到|乐死|笑不活|xddl)/gi, '哈哈');
    // 555/呜呜 -> 哭
    t = t.replace(/(5{3,}|呜{2,}|555+)/g, '哭');
    // awsl -> 爱了；orz/otz -> orz
    t = t.replace(/a\W*w\W*s\W*l/ig, '爱了');
    t = t.replace(/(otz|orz)/ig, 'orz');
    // 重复标点、多空白
    t = t.replace(/([。！？!?,，~、])\1+/g, '$1');
    t = t.replace(/\s{2,}/g, ' ');
    return t.trim();
  }

  function tokensCN(text) {
    const orig = normalizeText(text || '');
    const out = [];
    const presentWL = new Set();
    for (const term of state.whitelist) { if (term && orig.includes(term)) { out.push(term); presentWL.add(term); } }
    try {
      if (typeof Intl !== 'undefined' && Intl.Segmenter) {
        const seg = new Intl.Segmenter('zh', { granularity: 'word' });
        for (const s of seg.segment(orig)) {
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
    // 回退：汉字块 + 2-gram
    const segs = (orig.match(/[\u4e00-\u9fa5]+/g) || []);
    for (const s of segs) {
      if (s.length === 1) continue;
      if (s.length <= 4) { if (!state.stopwords.has(s)) out.push(s); }
      else { for (let i=0;i<s.length-1;i++){ const bg=s.slice(i,i+2); let covered=false; for (const t of presentWL){ if (t.includes(bg)){ covered=true; break; } } if(!covered && !state.stopwords.has(bg)) out.push(bg);} }
    }
    return out;
  }

  function parseXMLToBullets(xmlText) {
    const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
    const nodes = Array.from(doc.getElementsByTagName('d'));
    const bullets = nodes.map(n => {
      const p = (n.getAttribute('p') || '').split(',');
      const t = parseFloat(p[0] || '0');
      const text = (n.textContent || '').replace(/\u0000/g, '').trim();
      return { t, text };
    }).filter(x => x.text && x.t >= 0);
    return bullets;
  }

  // 使用 utils.norm/dot

  function binAndSmooth(items, binSize = 30, smoothK = 2) {
    if (!items.length) return { series: [], count: [] };
    const maxT = Math.max(...items.map(x => x.t));
    const bins = Math.ceil((maxT + 1) / binSize);
    const agg = Array.from({ length: bins }, () => ({ sum: 0, n: 0 }));
    items.forEach(({ t, score }) => {
      const idx = Math.floor(t / binSize);
      if (!agg[idx]) return;
      agg[idx].sum += score;
      agg[idx].n += 1;
    });
    const series = agg.map((b, i) => [ (i + 0.5) * binSize, b.n ? (b.sum / b.n) : 0 ]);
    const smoothed = series.map(([x,_], i) => {
      const L = Math.max(0, i - smoothK);
      const R = Math.min(series.length - 1, i + smoothK);
      let s=0,c=0; for (let k=L;k<=R;k++){ s+=series[k][1]; c++; }
      return [x, c ? s/c : 0];
    });
    const count = agg.map((b, i) => [ (i + 0.5) * binSize, b.n ]);
    return { series: smoothed, count };
  }

  async function callBG(type, payload = {}, opts = {}) {
    return new Promise((resolve) => {
      try {
        if (!chrome || !chrome.runtime || !chrome.runtime.id) {
          return resolve({ ok: false, error: 'Extension context invalidated' });
        }
        let done = false;
        const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 25000;
        let timer = null;
        if (timeoutMs > 0) {
          timer = setTimeout(() => {
            if (done) return;
            done = true;
            resolve({ ok: false, error: 'Timeout' });
          }, timeoutMs);
        }
        chrome.runtime.sendMessage({ type, ...payload }, (resp) => {
          if (done) return;
          done = true;
          if (timer) clearTimeout(timer);
          const err = chrome.runtime.lastError;
          if (err) return resolve({ ok: false, error: err.message || String(err) });
          if (!resp || !resp.ok) resolve({ ok: false, error: resp?.error || 'Unknown' });
          else resolve(resp);
        });
      } catch (e) {
        resolve({ ok: false, error: e?.message || String(e) });
      }
    });
  }

  // ---------- injected page script for chart ----------
  async function ensureChartManager() {
    if (chartManager) {
      console.log('[WIS] ChartManager already exists, reusing instance');
      return chartManager;
    }

    console.log('[WIS] Creating ChartManager instance');
    console.log('[WIS] window.ChartManager available:', typeof window.ChartManager);
    console.log('[WIS] window.echarts available:', typeof window.echarts);

    if (typeof window.ChartManager === 'undefined') {
      const err = 'ChartManager class not found on window object. Check if chart-manager.js loaded correctly.';
      console.error('[WIS]', err);
      log('❌ ' + err);
      return null;
    }

    try {
      chartManager = new window.ChartManager('wis-chart');
      console.log('[WIS] ChartManager instance created');

      await chartManager.init();
      console.log('[WIS] ChartManager initialized successfully ✓');
      return chartManager;
    } catch (e) {
      console.error('[WIS] ChartManager initialization failed:', e);
      console.error('[WIS] Error stack:', e.stack);
      log('❌ 图表系统初始化失败: ' + e.message);
      chartManager = null; // Reset on failure
      return null;
    }
  }

  async function renderTrend(series, count, arousal) {
    console.log('[WIS] renderTrend called:', { series: series?.length, count: count?.length, arousal: arousal?.length });
    try {
      const cm = await ensureChartManager();
      if (!cm) {
        log('❌ 图表管理器未就绪');
        return;
      }
      await cm.renderTrend({ series, counts: count, arousal });
    } catch (e) {
      console.error('[WIS] renderTrend error:', e);
      log('❌ 趋势图渲染失败: ' + e.message);
    }
  }

  async function renderStack(stackSeries, labels) {
    console.log('[WIS] renderStack called:', { stackSeries: stackSeries?.length, labels: labels?.length });
    try {
      const cm = await ensureChartManager();
      if (!cm) return;
      await cm.renderStack({ stackSeries, labels });
    } catch (e) {
      console.error('[WIS] renderStack error:', e);
      log('❌ 堆叠图渲染失败: ' + e.message);
    }
  }

  async function renderQuadrant(points) {
    console.log('[WIS] renderQuadrant called');
    try {
      const cm = await ensureChartManager();
      if (!cm) return;
      await cm.renderQuadrant({ points });
    } catch (e) {
      console.error('[WIS] renderQuadrant error:', e);
      log('❌ 情绪二维图渲染失败: ' + e.message);
    }
  }

  async function renderWordCloud(words) {
    // Render keyword bar only (word cloud removed)
    try {
      const cm = await ensureChartManager();
      if (!cm) return;
      await cm.renderWordBar({ words, topN: state.cfg?.wordTopN || 120 });
    } catch (e) {
      console.error('[WIS] render keywords error:', e);
      log('❌ 关键词渲染失败: ' + e.message);
    }
  }

  async function renderPie(pieData) {
    console.log('[WIS] renderPie called');
    try {
      const cm = await ensureChartManager();
      if (!cm) return;
      await cm.renderPie({ data: pieData });
    } catch (e) {
      console.error('[WIS] renderPie error:', e);
      log('❌ 饼图渲染失败: ' + e.message);
    }
  }

  function showRepresentatives(centerTime) {
    if (!state._outputs) return;
    const bin = state.cfg.binSizeSec || 30;
    const left = centerTime - bin/2, right = centerTime + bin/2;
    const slice = state._outputs.filter(o => o.t >= left && o.t < right);
    // top by confidence, unique text
    const uniq = new Map();
    for (const o of slice) { if (!uniq.has(o.text)) uniq.set(o.text, o); }
    const reps = Array.from(uniq.values()).sort((a,b)=>b.conf-a.conf).slice(0,12);
    if (!reps.length) { $reps.style.display='none'; return; }
    $reps.style.display='block';
    const html = [
      `<div class="wis-rep-title">代表弹幕（${reps.length}）@ ${formatTime(centerTime)}</div>`,
      ...reps.map(renderRepresentative)
    ];
    $reps.innerHTML = html.join('');

    // 添加滚动提示逻辑
    setTimeout(() => {
      if ($reps.scrollHeight > $reps.clientHeight) {
        $reps.classList.add('has-scroll');
      } else {
        $reps.classList.remove('has-scroll');
      }
    }, 50);
  }

  // ---------- main flow ----------
  async function ensureConfig() {
    const resp = await callBG('get.config');
    if (!resp.ok) throw new Error(resp.error || '无法读取配置');
    state.cfg = resp.cfg;
    // 根据配置筛选参与分析的情绪标签
    try {
      const en = state.cfg.labelsEnabled || {};
      const filtered = DEFAULT_LABELS.filter(l => en[l.key] !== false);
      if (filtered && filtered.length) {
        const before = state.labels.map(x=>x.key).join('|');
        const after = filtered.map(x=>x.key).join('|');
        if (before !== after) {
          state.labels = filtered;
          state.labelEmbeds = null; // 标签发生变更，重算嵌入
          console.log('[WIS] 激活情绪标签:', after);
        }
      }
    } catch {}
    // 填充面板设置
    if ($apiKey && typeof state.cfg.apiKey === 'string') {
      $apiKey.value = state.cfg.apiKey;
      // 若已配置过 API Key 折叠设置面板
      if (state.cfg.apiKey) {
        $settings.classList.remove('expanded');
      }
    }
    // 填充分类参数
    if ($clsTemp) $clsTemp.value = String(state.cfg.classifyTemp ?? 0.08);
    if ($clsBest) $clsBest.value = String(state.cfg.classifyMinBest ?? 0.2);
    if ($clsMargin) $clsMargin.value = String(state.cfg.classifyMinMargin ?? 0.06);
  }

  async function ensureLabelEmbeddings() {
    if (state.labelEmbeds) return;
    const inputs = state.labels.map(l => l.prompt);
    const key = (() => {
      const model = state.cfg?.model || '';
      const dim = state.cfg?.dimensions || 0;
      const h = (window.WIS && WIS.utils && WIS.utils.fnv1a) ? WIS.utils.fnv1a(inputs.join('|')) : Math.random().toString(16).slice(2);
      return `wis_label_embeds:${model}:${dim}:${h}`;
    })();
    try {
      const cached = await new Promise(res => chrome.storage.local.get(key, v => res(v && v[key])));
      if (cached && Array.isArray(cached) && cached.length === inputs.length) {
        state.labelEmbeds = cached;
        return;
      }
    } catch {}
    const resp = await callBG('embed.batch', { inputs });
    if (!resp.ok) throw new Error('标签嵌入失败：' + resp.error);
    state.labelEmbeds = resp.embeddings.map((WIS && WIS.utils && WIS.utils.norm) ? WIS.utils.norm : (x=>x));
    try { await new Promise(r => chrome.storage.local.set({ [key]: state.labelEmbeds }, r)); } catch {}
  }

  // 计算并缓存“AI 总结/大纲”先验的标签权重
  async function ensureSummaryPriors() {
    if (!state.cfg?.useSummaryPrior) return;
    if (!state._modelResult) return;
    if (!state.labelEmbeds) return; // 需先有标签嵌入
    if (state._summaryPriors) return; // cached
    const mr = state._modelResult;
    const items = [];
    try {
      if (Array.isArray(mr.outline)) {
        for (const sec of mr.outline) {
          const t = Math.max(0, sec?.timestamp || 0);
          const title = String(sec?.title || '').trim();
          if (title) items.push({ t, text: title });
          if (Array.isArray(sec?.part_outline)) {
            sec.part_outline.slice(0,3).forEach(p => {
              const ts = Math.max(0, p?.timestamp || t);
              const tt = String(p?.title || '').trim();
              if (tt) items.push({ t: ts, text: tt });
            });
          }
        }
      }
    } catch {}
    if (!items.length) return;
    const resp = await callBG('embed.batch', { inputs: items.map(x => x.text) });
    if (!resp.ok) return;
    const embs = resp.embeddings.map((WIS && WIS.utils && WIS.utils.norm) ? WIS.utils.norm : (x=>x));
    const labelEmbeds = state.labelEmbeds;
    const weightsList = [];
    for (let i = 0; i < embs.length; i++) {
      const e = embs[i];
      const sims = new Array(labelEmbeds.length);
      for (let k = 0; k < labelEmbeds.length; k++) sims[k] = WIS.utils.dot(e, labelEmbeds[k]);
      const clsCfg = getClassifyCfg();
      const w = softmax(sims, clsCfg.temp);
      weightsList.push(w);
    }
    state._summaryPriors = items.map((it, idx) => ({ t: it.t, weights: weightsList[idx] }));
  }

  async function analyze() {
    perfMonitor.start();
    $miniRun.disabled = true;
    $miniRunText.textContent = '分析中...';
    $log.textContent = '';
    updateMiniStatus('idle', '分析中...');
    updateProgress(0);

    try {
      await ensureConfig();
      perfMonitor.mark('配置加载');
      await ensureLexicons();
      perfMonitor.mark('词表加载');
      // 检测是否已登录（Cookies）
      try {
        const ck = await callBG('bili.checkAuth', {});
        if (ck.ok && !ck.loggedIn) {
          log('⚠️ 未检测到 B 站登录 Cookie，某些接口可能受限（尝试在新标签登录后重试）');
        }
      } catch {}
      // Remove old injected.js dependency
      log('📊 初始化图表系统 ...');

      if (!state.cfg.apiKey) {
        detailModal.classList.add('active');
        $settings.classList.add('expanded');
        log('❌ 请先在上方输入 SiliconFlow API Key 并点击保存');
        updateMiniStatus('error', '需要配置 API Key');
        showToast('配置错误', '请先设置 SiliconFlow API Key', 'error');
        throw new Error('缺少 API Key');
      }

      updateMiniStatus('idle', '获取视频信息...');
      const m = location.pathname.match(/\/video\/(BV\w+)/i);
      if (!m) {
        showToast('视频错误', '未找到视频 BVID，请确保在 B 站视频页面', 'error');
        throw new Error('未在 URL 中找到 BVID');
      }
      const bvid = m[1];
      log('📡 获取所有分P cid ...');
      const cidResp = await callBG('bili.fetchCids', { bvid });
      perfMonitor.addAPI();
      if (!cidResp.ok) {
        showToast('网络错误', 'B 站 API 请求失败，请检查网络连接', 'error');
        throw new Error(cidResp.error);
      }
      const cids = cidResp.cids || [];
      log(`✅ 分P数量：${cids.length}`);
      perfMonitor.mark('获取CID');

      // 拉取 AI 总结（并行，不影响主流程），并可作为先验
      try {
        callBG('bili.fetchSummary', { bvid }).then(async (r)=>{
          if (r && r.ok && r.model_result) {
            state._modelResult = r.model_result;
            renderSummary(r.model_result);
            try { if (state.cfg?.useSummaryPrior) await ensureSummaryPriors(); } catch {}
          } else {
            $summaryCard.style.display='none';
          }
        }).catch(()=>{ $summaryCard.style.display='none'; });
      } catch {}

      updateMiniStatus('idle', '拉取弹幕数据...');
      let bullets = [];
      const fetchDiags = [];
      let usedFallback = false;
      for (let i = 0; i < cids.length; i++) {
        const cid = cids[i];
        const ref = `https://www.bilibili.com/video/${bvid}/?p=${i+1}`;
        try {
          updateMiniStatus('idle', `分P ${i+1}/${cids.length}：seg.so 抓取...`);
          const segTimeout = Math.max(90000, (state.cfg.segParallel || 4) * 22000);
          const segResp = await callBG('bili.fetchAllDanmaku', { cid, parallel: state.cfg.segParallel || 4, ref }, { timeoutMs: segTimeout });
          perfMonitor.addAPI();
          if (segResp.ok) {
            bullets = bullets.concat(segResp.list || []);
            if (Array.isArray(segResp.diag)) fetchDiags.push({ p: i+1, cid, diag: segResp.diag, total: segResp.totalSegments || 0 });
          }
          else throw new Error(segResp.error || 'seg.so 失败');
        } catch (e) {
          usedFallback = true;
          log(`⚠️ 分P${i+1} seg.so 未成功，自动回退 XML 抓取`);
          try {
            const diagStatus = (e?.message || e?.error || 'fallback').toString().slice(0, 80);
            fetchDiags.push({ p: i+1, cid, diag: [{ seg: 0, ok: false, status: diagStatus, count: 0 }], total: 0, fallback: true });
          } catch {}
          const xmlResp = await callBG('bili.fetchXML', { cid });
          perfMonitor.addAPI();
          if (xmlResp.ok) {
            const parsed = parseXMLToBullets(xmlResp.xml);
            bullets = bullets.concat(parsed);
            if (!parsed.length) {
              log(`⚠️ 分P${i+1} XML 回退结果为空，可能包含不可解析字符`);
            }
          }
        }
      }

      // 历史弹幕：按月取可用日期，再逐日抓取 seg.so
      if (state.cfg.enableHistory) {
        const months = [];
        const mCount = Math.max(1, state.cfg.historyMonths || 1);
        const now = new Date();
        for (let i = 0; i < mCount; i++) {
          const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
          const mm = String(d.getMonth() + 1).padStart(2, '0');
          months.push(`${d.getFullYear()}-${mm}`);
        }
        const dateSet = new Set();
        for (const cid of cids) {
          for (const month of months) {
            try {
              const idxResp = await callBG('bili.historyIndex', { cid, month });
              perfMonitor.addAPI();
              if (idxResp.ok && Array.isArray(idxResp.dates)) idxResp.dates.forEach(d => dateSet.add(d));
            } catch {}
          }
        }
        let dates = Array.from(dateSet);
        // 仅保留最近的若干天
        dates.sort((a,b)=> new Date(b) - new Date(a));
        const limit = Math.max(1, state.cfg.historyDateLimit || 30);
        dates = dates.slice(0, limit);

        log(`📚 历史弹幕：可用日期 ${dates.length} 天，开始抓取...`);
        const hParallel = Math.max(1, state.cfg.historyParallel || 3);
        let ptr = 0;
        async function histWorker() {
          while (ptr < dates.length) {
            const idx = ptr++;
            const date = dates[idx];
            for (const cid of cids) {
              try {
                const hResp = await callBG('bili.historySeg', { cid, date }, { timeoutMs: 60000 });
                perfMonitor.addAPI();
                if (hResp.ok && Array.isArray(hResp.list)) bullets = bullets.concat(hResp.list);
              } catch {}
            }
          }
        }
        const workers = Array.from({ length: Math.min(hParallel, dates.length) }, ()=>histWorker());
        await Promise.all(workers);
        log(`📚 历史弹幕抓取完成，总量（含历史、去重前）≈ ${bullets.length}`);
      }
      // 合并去重并排序
      bullets = Array.from(new Map(bullets.map(b => [`${Math.round((b.t||0)*1000)}|${b.text}`, b])).values()).sort((a,b)=>a.t-b.t);
      log(`📊 弹幕数（合并去重）：${bullets.length}${usedFallback ? '（部分分P使用XML回退，可能非全量）' : ''}`);
      // 抓取报告
      try {
        const rep = summarizeFetchDiag(fetchDiags);
        renderFetchReport(rep);
        if (rep.statusCounts[412] > 0) {
          showToast('提示', `检测到 ${rep.statusCounts[412]} 次 412（风控），建议降低“分段抓取并发”到 3–4 或刷新后重试`, 'warning', 4000);
        }
      } catch {}
      updateDetailStats(bullets.length, '-', '-', '-');
      perfMonitor.mark('拉取弹幕');

      if (bullets.length === 0) {
        showToast('弹幕为空', '该视频暂无弹幕数据', 'warning');
        throw new Error('弹幕数据为空');
      }

      // cleaning + sampling
      const cleaned = bullets
        .filter(b => b.text.length >= 2 && b.text.length <= 80)
        .filter(b => !/^https?:\/\//i.test(b.text))
        .slice(0, Math.max(100, Math.min(5000, state.cfg.sampleLimit || 4000)));
      log(`🔍 采样处理：${cleaned.length}`);

      updateMiniStatus('idle', '计算标签嵌入...');
      log('🏷️ 计算标签嵌入 ...');
      await ensureLabelEmbeddings();
      perfMonitor.addAPI();
      perfMonitor.mark('标签嵌入');
      const labelEmbeds = state.labelEmbeds;
      // 计算章节先验（若启用）
      try { await ensureSummaryPriors(); } catch {}

      updateMiniStatus('idle', '分析弹幕情绪...');
      log('🧠 请求远端嵌入（并发+限速） ...');
      const batches = chunk(cleaned, state.cfg.batchSize || 64);
      const outputs = [];
      // 速率与并发控制
      const concurrency = Math.max(1, state.cfg.embedConcurrency || 4);
      const delayMs = Math.max(0, state.cfg.embedDelayMs || 0);
      const rpmLimit = Math.max(1, state.cfg.rpmLimit || 2000);
      const tpmLimit = Math.max(1, state.cfg.tpmLimit || 1000000);
      let doneBatches = 0; rateWindow = [];

      function estimateTokens(list) {
        const chars = list.reduce((s,x)=> s + (x.text || '').length, 0);
        return Math.ceil(chars * 1.1); // 粗略估算
      }
      function rateStats() {
        const now = Date.now();
        pruneRateWindow(now);
        let req = 0;
        let tok = 0;
        for (const r of rateWindow) { req++; tok += r.tokens; }
        return { req, tok };
      }
      async function acquire(tokens) {
        while (true) {
          const { req, tok } = rateStats();
          if (req + 1 <= rpmLimit && tok + tokens <= tpmLimit) return;
          await sleep(30);
        }
      }

      // 准备字幕上下文（可选）
      let subCenters = null; let subEmbeds = null;
      const useSub = !!state.cfg.useSubtitleContext;
      if (useSub) {
        try {
          const sub = await prepareSubtitleContext(bvid);
          if (sub && sub.centers && sub.embeds) {
            subCenters = sub.centers; subEmbeds = sub.embeds;
          }
        } catch {}
      }

      let cursor = 0;
      async function worker(id) {
        while (true) {
          const i = cursor++;
          if (i >= batches.length) break;
          const group = batches[i];
          const tokens = estimateTokens(group);
          await acquire(tokens);
          const resp = await callBG('embed.batch', { inputs: group.map(x => x.text) });
          perfMonitor.addAPI();
          if (!resp.ok) {
            showToast('API 错误', `嵌入请求失败: ${resp.error}。请检查 API Key 是否有效`, 'error');
            throw new Error('嵌入失败：' + resp.error);
          }
          recordRateSample(tokens);
          updateRateUI();
          const embs = resp.embeddings.map((WIS && WIS.utils && WIS.utils.norm) ? WIS.utils.norm : (x=>x));
          for (let j = 0; j < group.length; j++) {
            let e = embs[j];
            // 字幕向量融合（向量级）：e = norm(e + beta * s)
            if (useSub && subCenters && subEmbeds) {
              try {
                const win = Math.max(1, Number(state.cfg.subtitleWindowSec || 6));
                const beta = Math.max(0, Math.min(0.6, Number(state.cfg.subtitleWeight || 0.25)));
                const tnow = group[j].t || 0;
                let idx = binaryNearest(subCenters, tnow);
                if (idx >= 0 && Math.abs(subCenters[idx] - tnow) <= win) {
                  const s = subEmbeds[idx];
                  if (Array.isArray(s) && s.length === e.length) {
                    const mix = new Array(e.length);
                    for (let q = 0; q < e.length; q++) mix[q] = e[q] + beta * s[q];
                    e = (WIS && WIS.utils && WIS.utils.norm) ? WIS.utils.norm(mix) : mix;
                  }
                }
              } catch {}
            }
            const sims = new Array(labelEmbeds.length);
            let bestIdx = 0, best = -Infinity, second = -Infinity;
            for (let k = 0; k < labelEmbeds.length; k++) {
              const s = (WIS && WIS.utils && WIS.utils.dot) ? WIS.utils.dot(e, labelEmbeds[k]) : 0;
              sims[k] = s;
              if (s > best) { second = best; best = s; bestIdx = k; }
              else if (s > second) { second = s; }
            }
            const clsCfg = getClassifyCfg();
            const conf = clamp((best - second), 0, 1);
            let weights = softmax(sims, clsCfg.temp);
            // 混合 AI 总结先验（按最近章节时间）
            if (state.cfg?.useSummaryPrior && Array.isArray(state._summaryPriors) && state._summaryPriors.length) {
              try {
                const tcur = group[j].t || 0;
                let bestIdxPrior = 0; let bestDist = Infinity;
                for (let q = 0; q < state._summaryPriors.length; q++) {
                  const d = Math.abs((state._summaryPriors[q].t || 0) - tcur);
                  if (d < bestDist) { bestDist = d; bestIdxPrior = q; }
                }
                const prior = state._summaryPriors[bestIdxPrior]?.weights || null;
                const alpha = Math.max(0, Math.min(0.8, Number(state.cfg.summaryPriorWeight || 0.15)));
                if (prior && alpha > 0) {
                  const mix = new Array(weights.length);
                  let sum = 0;
                  for (let k = 0; k < weights.length; k++) { const v = weights[k]*(1-alpha) + (prior[k]||0)*alpha; mix[k] = v; sum += v; }
                  if (sum > 0) weights = mix.map(v => v / sum);
                }
              } catch {}
            }
            const pol = state.labels.map(l => l.polarity);
            const val = state.labels.map(l => l.valence);
            const aro = state.labels.map(l => l.arousal);
            const wsum = (arr) => arr.reduce((acc, v, idx) => acc + v * (weights[idx] || 0), 0);
            let scoreW = clamp(wsum(pol), -1, 1);
            let vW = clamp(wsum(val), -1, 1);
            let aW = clamp(wsum(aro), -1, 1);

            const neutralIdx = Math.max(0, state.labels.findIndex(l => l.key === clsCfg.neutralKey));
            // 使用混合后的概率选择最终类别
            let labelIdx = 0; { let m=-1; for (let k=0;k<weights.length;k++){ if (weights[k]>m){m=weights[k]; labelIdx=k;} } }
            let labelKey = state.labels[labelIdx]?.key || state.labels[0].key;

            if (best < clsCfg.minBest || (best - second) < clsCfg.minMargin) {
              // 低置信度：归为中性并将强度置零
              labelIdx = neutralIdx >= 0 ? neutralIdx : bestIdx;
              labelKey = state.labels[labelIdx].key;
              outputs.push({ t: group[j].t, label: labelKey, labelIdx, score: 0, valence: 0, arousal: 0, conf: 0, text: group[j].text });
            } else {
              // 置信度门控下的加权得分（减小极端值）
              const gate = 0.5 + 0.5 * conf;
              const score = clamp(scoreW * gate, -1, 1);
              const v = clamp(vW * gate, -1, 1);
              const a = clamp(aW * gate, -1, 1);
              outputs.push({ t: group[j].t, label: labelKey, labelIdx, score, valence: v, arousal: a, conf, text: group[j].text });
            }
          }
          doneBatches++;
          const progress = (doneBatches / batches.length) * 80;
          updateProgress(progress);
          if (delayMs) {
            const dt = Date.now() - t0; if (dt < delayMs) await sleep(delayMs - dt);
          }
        }
      }
      const workers = Array.from({ length: Math.min(concurrency, batches.length) }, (_,i)=>worker(i));
      await Promise.all(workers);
      perfMonitor.mark('情感分析');

      updateMiniStatus('idle', '生成可视化...');
      updateProgress(90);
      log('📈 聚合与绘图 ...');

      // 缓存输出，构建多视图数据
      state._outputs = outputs;
      const bin = state.cfg.binSizeSec || 30;
      const maxT = Math.max(...outputs.map(o=>o.t), 0);
      const bins = Math.ceil((maxT + 1) / bin);
      const labelN = state.labels.length;
      const agg = Array.from({length: bins}, () => ({ n:0, sumPol:0, sumVal:0, sumAro:0, labelCnt: Array(labelN).fill(0) }));
      outputs.forEach(o => {
        const idx = Math.floor(o.t/bin); const a = agg[idx]; if(!a) return;
        a.n++; a.sumPol+=o.score; a.sumVal+=o.valence; a.sumAro+=o.arousal; a.labelCnt[o.labelIdx]++;
      });
      const series = agg.map((a,i)=>[(i+0.5)*bin, a.n? a.sumPol/a.n:0]);
      const arousal = agg.map((a,i)=>[(i+0.5)*bin, a.n? a.sumAro/a.n:0]);
      const count = agg.map((a,i)=>[(i+0.5)*bin, a.n]);
      state._trend = { series, count, arousal };

      const stackSeries = Array.from({length: labelN}, (_,li) => agg.map((a,i)=>[(i+0.5)*bin, a.labelCnt[li]]));
      state._stack = { stackSeries, labels: state.labels.map(x=>x.key) };

      // 总体占比（饼图）
      const labelCounts = new Array(labelN).fill(0);
      outputs.forEach(o => { if (o.labelIdx>=0 && o.labelIdx<labelN) labelCounts[o.labelIdx]++; });
      const pieData = state.labels.map((l, idx) => ({ name: l.key, value: labelCounts[idx] || 0 })).filter(d => d.value > 0);
      state._pie = { data: pieData };

      const points = agg.map((a,i)=>{ const x=a.n? a.sumVal/a.n:0; const y=a.n? a.sumAro/a.n:0; return [x,y,a.n,(i+0.5)*bin,a.n]; });
      state._quad = { points };

      const freq = new Map();
      for (const o of outputs) {
        for (const w of tokensCN(o.text)) { freq.set(w, (freq.get(w)||0)+1); }
      }
      const topN = Math.max(10, Math.min(300, state.cfg.wordTopN || 120));
      const words = Array.from(freq.entries()).sort((a,b)=>b[1]-a[1]).slice(0, topN).map(([name,value])=>({name,value}));
      state._words = words;

      const avgSentiment = (WIS && WIS.utils && WIS.utils.sum) ? (WIS.utils.sum(outputs.map(o => o.score)) / outputs.length) : 0;
      const positive = outputs.filter(o => o.score > 0.1).length;
      const negative = outputs.filter(o => o.score < -0.1).length;

      updateMiniStats(cleaned.length, avgSentiment);
      updateDetailStats(bullets.length, cleaned.length, positive, negative);

      renderTrend(series, count, arousal);

      updateProgress(100);
      perfMonitor.mark('可视化完成');
      const perf = perfMonitor.end();
      log(`✅ 分析完成！耗时 ${(perf.total / 1000).toFixed(2)}s, API 调用 ${perf.apiCalls} 次`);
      updateMiniStatus('idle', '分析完成');
      showToast('分析完成', `共分析 ${cleaned.length} 条弹幕，耗时 ${(perf.total/1000).toFixed(1)}s`, 'success');

    } catch (e) {
      console.error(e);
      const msg = (e && e.message) ? String(e.message) : String(e);
      log('❌ 出错：' + msg);
      const isCtx = /Extension context invalidated|Receiving end does not exist/i.test(msg);
      updateMiniStatus('error', isCtx ? '扩展已重载，请刷新页面重试' : '分析失败');
      // 若图表未加载，显示占位提示，便于用户感知错误状态
      try {
        const cm = await ensureChartManager();
        if (cm && cm.chartInstance) {
          cm.chartInstance.clear();
          cm.chartInstance.setOption({
            backgroundColor: 'transparent',
            title: { text: isCtx ? '扩展已重载，请刷新页面后重试' : '嵌入服务暂时不可用，稍后重试', left: 'center', top: 'middle', textStyle: { color: '#ef4444', fontSize: 14 } }
          });
          detailModal.classList.add('active');
        }
      } catch {}
      try { if (isCtx) showToast('扩展已重载', '请刷新页面后重试分析', 'warning', 4000); } catch {}
      // 其他错误已在各阶段显示 Toast，这里不重复
    } finally {
      $miniRun.disabled = false;
      $miniRunText.textContent = '开始分析';
    }
  }

  // 初始化所有功能
  initDrag();
  initKeyboardShortcuts();
  ensureConfig().catch(()=>{});
  $miniRun.addEventListener('click', analyze);

  // 折叠卡片功能
  document.querySelectorAll('.wis-info-card.collapsible').forEach(card => {
    card.addEventListener('click', (e) => {
      // 避免子元素交互时触发折叠
      if (e.target.closest('.wis-summary-list, .wis-info-grid')) return;
      card.classList.toggle('collapsed');
      // 保存折叠状态到 localStorage
      const id = card.id;
      if (id) {
        const isCollapsed = card.classList.contains('collapsed');
        try { localStorage.setItem(`wis-collapse-${id}`, isCollapsed ? '1' : '0'); } catch {}
      }
    });

    // 恢复折叠状态
    const id = card.id;
    if (id) {
      try {
        const saved = localStorage.getItem(`wis-collapse-${id}`);
        if (saved === '1') card.classList.add('collapsed');
        else if (saved === '0') card.classList.remove('collapsed');
      } catch {}
    }
  });

  // 切换视图
  function setActive(view){
    $tabs.querySelectorAll('.wis-tab').forEach(el=>{
      el.classList.toggle('active', el.getAttribute('data-view')===view);
    });
  }

  $tabs.addEventListener('click', (ev)=>{
    const el = ev.target.closest('.wis-tab'); if(!el) return;
    const view = el.getAttribute('data-view'); setActive(view);
    if (!state._trend) { log('请先点击"分析弹幕"'); return; }
    if (view==='trend') return renderTrend(state._trend.series, state._trend.count, state._trend.arousal);
    if (view==='stack') return renderStack(state._stack.stackSeries, state._stack.labels);
    if (view==='quadrant') return renderQuadrant(state._quad.points);
    if (view==='cloud') return renderWordCloud(state._words);
    if (view==='pie') return renderPie(state._pie.data);
  });

  // 接收图表点击事件
  window.addEventListener('message', (e) => {
    const d = e.data || {};
    if (d.type === 'WIS_CHART_CLICK') {
      // 趋势图点击
      if (d.chart === 'trend' && d.time !== undefined) {
        const t = d.time;
        console.log('[WIS] Trend click:', t);
        // 更新词云（该时间窗）
        const bin = state.cfg.binSizeSec || 30;
        const left = t - bin/2, right = t + bin/2;
        const freq = new Map();
        for (const o of (state._outputs||[])) {
          if (o.t >= left && o.t < right) {
            for (const w of tokensCN(o.text)) { freq.set(w, (freq.get(w)||0)+1); }
          }
        }
        const topN = Math.max(10, Math.min(300, state.cfg.wordTopN || 120));
        const words = Array.from(freq.entries()).sort((a,b)=>b[1]-a[1]).slice(0, topN).map(([name,value])=>({name,value}));

        // 自动切换到关键词视图
        setActive('cloud');
        renderWordCloud(words);
        showRepresentatives(t);

        // 高亮最接近的 AI 总结条目
        try {
          const items = Array.from(($summaryList||{}).children||[]);
          if (items.length) {
            let bestEl=null, best=1e9;
            for (const el of items) {
              const ts = parseFloat(el.getAttribute('data-ts')||'0')||0;
              const diff = Math.abs(ts - t);
              if (diff < best) { best = diff; bestEl = el; }
              for (const sub of Array.from(el.querySelectorAll('[data-ts]'))) {
                const subts = parseFloat(sub.getAttribute('data-ts')||'0')||0;
                const d2 = Math.abs(subts - t); if (d2 < best) { best = d2; bestEl = sub; }
              }
            }
            items.forEach(el=>el.classList.remove('active'));
            if (bestEl) bestEl.classList.add('active');
          }
        } catch {}
      }

      // 堆叠图点击 - 新增
      if (d.chart === 'stack' && d.time !== undefined) {
        const t = d.time;
        const emotion = d.emotion; // 点击的情绪标签
        console.log('[WIS] Stack click:', t, emotion);

        // 计算该时间段的词云（可选：仅过滤该情绪）
        const bin = state.cfg.binSizeSec || 30;
        const left = t - bin/2, right = t + bin/2;
        const freq = new Map();
        for (const o of (state._outputs||[])) {
          // 如果点击了特定情绪，只统计该情绪的弹幕
          if (o.t >= left && o.t < right) {
            if (!emotion || o.label === emotion) {
              for (const w of tokensCN(o.text)) { freq.set(w, (freq.get(w)||0)+1); }
            }
          }
        }
        const topN = Math.max(10, Math.min(300, state.cfg.wordTopN || 120));
        const words = Array.from(freq.entries()).sort((a,b)=>b[1]-a[1]).slice(0, topN).map(([name,value])=>({name,value}));

        // 自动切换到关键词视图
        setActive('cloud');
        renderWordCloud(words);
        showRepresentatives(t);

        // 日志提示
        log(`📊 堆叠图点击：${formatTime(t)}${emotion ? ` [${emotion}]` : ''}`);
      }

      // 词云点击
      if (d.chart === 'word' && d.word) {
        const word = d.word;
        console.log('[WIS] Word cloud click:', word);

        if (!state._outputs) {
          console.warn('[WIS] No outputs available');
          showToast('无数据', '请先完成弹幕分析', 'warning', 2000);
          return;
        }

      // 过滤包含该词的弹幕
      const matches = state._outputs.filter(o => o.text.includes(word)).sort((a,b)=>b.conf-a.conf).slice(0,12);
      console.log('[WIS] Found matches:', matches.length);

      if (!matches.length) {
        $reps.style.display='none';
        showToast('无匹配', `未找到包含"${word}"的弹幕`, 'info', 2000);
        return;
      }

      $reps.style.display='block';
      const html = [
        `<div class="wis-rep-title">包含"${escapeHTML(word)}"的弹幕（${matches.length}）</div>`,
        ...matches.map(renderRepresentative)
      ];
      $reps.innerHTML = html.join('');

      // 添加滚动提示逻辑
      setTimeout(() => {
        if ($reps.scrollHeight > $reps.clientHeight) {
          $reps.classList.add('has-scroll');
        } else {
          $reps.classList.remove('has-scroll');
        }
      }, 50);

      log(`💬 点击关键词："${word}"，共 ${matches.length} 条弹幕`);

      // 确保详细模式打开且可见代表弹幕区
      if (!detailModal.classList.contains('active')) {
        detailModal.classList.add('active');
      }

      // 滚动到代表弹幕区域
      setTimeout(() => {
        $reps.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 100);
      }
    }
  });

  // -------- 抓取诊断报告渲染 --------
  function summarizeFetchDiag(items) {
    const statusCounts = {};
    let totalSeg = 0, okSeg = 0;
    const perP = [];
    for (const it of items) {
      const diag = it.diag || [];
      const ok = diag.filter(d=>d.ok).length;
      const tot = it.total || diag.length;
      totalSeg += tot; okSeg += ok;
      diag.forEach(d => { statusCounts[d.status] = (statusCounts[d.status]||0) + 1; });
      perP.push({ p: it.p, ok, tot });
    }
    return { totalSeg, okSeg, statusCounts, perP };
  }

  function renderFetchReport(rep) {
    let $report = document.getElementById('wis-fetch-report');
    if (!$report) {
      $report = document.createElement('div');
      $report.id = 'wis-fetch-report';
      $report.className = 'wis-info-card';
      const sidebar = detailModal.querySelector('.wis-detail-sidebar');
      sidebar.insertBefore($report, sidebar.querySelector('#wis-reps'));
    }
    const rows = Object.entries(rep.statusCounts).sort((a,b)=>b[1]-a[1]).slice(0,5)
      .map(([s,c])=>`<div style="display:flex;justify-content:space-between"><span>HTTP ${s}</span><span>${c}</span></div>`).join('');
    const per = rep.perP.map(x=>`<div style="display:flex;justify-content:space-between"><span>P${x.p}</span><span>${x.ok}/${x.tot}</span></div>`).join('');
    $report.innerHTML = `
      <div class="wis-info-title">抓取报告</div>
      <div class="wis-info-grid" style="grid-template-columns:1fr;gap:8px">
        <div><div class="wis-info-label">分段成功/总数</div><div class="wis-info-value">${rep.okSeg}/${rep.totalSeg}</div></div>
        <div><div class="wis-info-label">Top 状态码</div>${rows || '<div style="color:#9ca3af">无</div>'}</div>
        <div><div class="wis-info-label">各分P成功率</div>${per || '<div style="color:#9ca3af">无</div>'}</div>
      </div>`;
  }

  // ========== AI 总结渲染 ==========
  function secondsToTimeLink(sec) {
    sec = Math.max(0, Math.floor(sec||0));
    if (sec < 60) return `${sec}s`;
    if (sec < 3600) return `${Math.floor(sec/60)}m${sec%60}s`;
    return `${Math.floor(sec/3600)}h${Math.floor(sec/60)%60}m${sec%60}s`;
  }
  function formatMMSSLocal(sec) {
    const m = Math.floor(sec/60), s = Math.floor(sec%60);
    return `${m}:${String(s).padStart(2,'0')}`;
  }
  function renderSummary(modelResult) {
    try {
      const summary = modelResult?.summary;
      const outline = modelResult?.outline;
      if (!summary && !Array.isArray(outline)) { $summaryCard.style.display='none'; return; }
      $summaryCard.style.display='block';
      $summaryAbstract.textContent = summary || '';
      $summaryList.innerHTML='';
      if (Array.isArray(outline)) {
        const frag = document.createDocumentFragment();
        outline.forEach(sec => {
          const item = document.createElement('div');
          item.className = 'wis-summary-item';
          const t = Math.max(0, sec?.timestamp || 0);
          item.setAttribute('data-ts', String(t));
          item.innerHTML = `<span class="wis-summary-time">${formatMMSSLocal(t)}</span>${(sec?.title||'').replace(/</g,'&lt;')}`;
          if (Array.isArray(sec?.part_outline)) {
            sec.part_outline.slice(0,3).forEach(p => {
              const sub = document.createElement('div');
              const ts = Math.max(0, p?.timestamp || t);
              sub.className = 'wis-summary-sub';
              sub.setAttribute('data-ts', String(ts));
              sub.innerHTML = `<span class="wis-summary-time">${formatMMSSLocal(ts)}</span>${(p?.title||'').replace(/</g,'&lt;')}`;
              item.appendChild(sub);
            });
          }
          frag.appendChild(item);
        });
        $summaryList.appendChild(frag);
        $summaryList.onclick = (ev) => {
          const el = ev.target.closest('[data-ts]'); if (!el) return;
          const ts = parseInt(el.getAttribute('data-ts')||'0',10);
          const link = `${location.origin}${location.pathname}?t=${secondsToTimeLink(ts)}`;
          window.open(link, '_blank');
        };
      }
    } catch { $summaryCard.style.display='none'; }
  }
})();
  // 二分查找最近值索引
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
    // lo 是第一个大于 x 的位置，比较 lo 与 lo-1
    if (lo <= 0) return 0;
    if (lo >= arr.length) return arr.length - 1;
    return (Math.abs(arr[lo] - x) < Math.abs(arr[lo-1] - x)) ? lo : (lo - 1);
  }

  // 准备字幕：选择轨道、拉取分段、嵌入并返回 { centers, embeds }
  async function prepareSubtitleContext(bvid) {
    try {
      const listResp = await callBG('bili.fetchSubtitleList', { bvid });
      if (!listResp.ok || !Array.isArray(listResp.tracks) || !listResp.tracks.length) return null;
      // 选择中文优先轨道
      const pref = (t) => {
        const l = (t.lan || '').toLowerCase();
        const d = (t.lan_doc || '').toLowerCase();
        if (l.includes('zh') || d.includes('中文') || d.includes('chinese')) return 2;
        if (l.includes('en') || d.includes('english')) return 1;
        return 0;
      };
      const tracks = listResp.tracks.slice().sort((a,b)=>pref(b)-pref(a));
      const url = tracks[0].url;
      if (!url) return null;
      const segResp = await callBG('bili.fetchSubtitleTrack', { url });
      if (!segResp.ok || !Array.isArray(segResp.segments) || !segResp.segments.length) return null;
      const segs = segResp.segments.slice().sort((a,b)=>a.from-b.from);
      // 为降低 token，截断字幕长度
      const texts = segs.map(s => String(s.content || '').slice(0, 120));
      const chunks = chunk(texts, state.cfg.batchSize || 64);
      const embeds = [];
      for (const c of chunks) {
        const r = await callBG('embed.batch', { inputs: c });
        if (!r.ok) return null;
        r.embeddings.forEach(e => embeds.push((WIS && WIS.utils && WIS.utils.norm) ? WIS.utils.norm(e) : e));
      }
      const centers = segs.map(s => (Number(s.from||0)+Number(s.to||0))/2);
      return { centers, embeds };
    } catch { return null; }
  }
