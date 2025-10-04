/**
 * Chart Manager - Unified chart rendering system
 * Handles ECharts initialization and all chart types
 */
class ChartManager {
  constructor(containerId) {
    this.containerId = containerId;
    this.echarts = null;
    this.chartInstance = null;
    this.ready = false;
    this.initPromise = null;
  }

  async init() {
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      console.log('[ChartManager] Initializing...');
      console.log('[ChartManager] Container ID:', this.containerId);

      // Wait for container
      const container = await this._waitForContainer();
      if (!container) {
        console.error('[ChartManager] Container not found after waiting');
        throw new Error('Chart container not found');
      }
      console.log('[ChartManager] Container found, dimensions:', container.clientWidth, 'x', container.clientHeight);

      // Load ECharts
      console.log('[ChartManager] Loading ECharts...');
      this.echarts = await this._loadECharts();
      if (!this.echarts) {
        console.error('[ChartManager] ECharts is null/undefined');
        throw new Error('ECharts failed to load');
      }
      console.log('[ChartManager] ECharts object:', typeof this.echarts, 'version:', this.echarts.version);

      // Initialize chart instance; if container is hidden (0x0), pass fallback size
      // Use larger fallback size when container is hidden
      const w = Math.max(320, container.clientWidth || 0) || 960;
      const h = Math.max(240, container.clientHeight || 0) || 540;
      console.log('[ChartManager] Calculated dimensions:', w, 'x', h);

      const opts = (container.clientWidth && container.clientHeight)
        ? {}
        : { width: w, height: h, renderer: 'canvas' };
      console.log('[ChartManager] Init options:', opts);

      this.chartInstance = this.echarts.init(container, undefined, opts);
      console.log('[ChartManager] Chart instance created:', !!this.chartInstance);

      this._attachAutoResize(container);
      this.ready = true;

      console.log('[ChartManager] Ready ✓');
      return true;
    })();

    return this.initPromise;
  }

  _attachAutoResize(container) {
    try {
      if (this._ro) return; // already attached
      // ResizeObserver to catch layout changes (e.g., modal open)
      if (typeof ResizeObserver !== 'undefined') {
        this._ro = new ResizeObserver(() => {
          try {
            if (!this.chartInstance) return;
            const w = container.clientWidth || Math.floor(container.getBoundingClientRect().width);
            const h = container.clientHeight || Math.floor(container.getBoundingClientRect().height);
            if (w && h) this.chartInstance.resize({ width: w, height: h });
            else this.chartInstance.resize();
          } catch {}
        });
        this._ro.observe(container);
      } else {
        // Fallback: window resize
        this._onResize = () => {
          try {
            if (!this.chartInstance) return;
            const w = container.clientWidth || Math.floor(container.getBoundingClientRect().width);
            const h = container.clientHeight || Math.floor(container.getBoundingClientRect().height);
            if (w && h) this.chartInstance.resize({ width: w, height: h });
            else this.chartInstance.resize();
          } catch {}
        };
        window.addEventListener('resize', this._onResize);
      }
    } catch {}
  }

  async _waitForContainer(timeout = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const el = document.getElementById(this.containerId);
      // Accept the element as soon as it exists; visibility not required.
      // ECharts can init with zero size; we'll resize when visible.
      if (el) { console.log('[ChartManager] Container found:', this.containerId); return el; }
      await new Promise(r => setTimeout(r, 50));
    }
    console.error('[ChartManager] Container timeout:', this.containerId);
    return null;
  }

  async _loadECharts() {
    // First check if echarts is already available (loaded by manifest content_scripts)
    if (typeof window.echarts !== 'undefined' && window.echarts) {
      console.log('[ChartManager] ECharts already loaded (from content_scripts)');
      return window.echarts;
    }

    // Fallback: try loading from various sources
    console.log('[ChartManager] ECharts not found, attempting to load...');

    const local = (typeof chrome !== 'undefined' && chrome?.runtime?.getURL)
      ? chrome.runtime.getURL('src/vendor/echarts.min.js')
      : null;
    const urls = [
      ...(local ? [local] : []),
      'https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js',
      'https://unpkg.com/echarts@5/dist/echarts.min.js',
      'https://fastly.jsdelivr.net/npm/echarts@5/dist/echarts.min.js',
      'https://cdn.bootcdn.net/ajax/libs/echarts/5.5.0/echarts.min.js'
    ];

    for (const url of urls) {
      try {
        await this._loadScript(url);
        if (window.echarts) {
          console.log('[ChartManager] ECharts loaded from:', url);
          return window.echarts;
        }
      } catch (e) {
        console.warn('[ChartManager] Failed to load from:', url, e.message);
      }
    }

    console.error('[ChartManager] All ECharts loading attempts failed');
    return null;
  }

  _loadScript(url) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = url;
      script.async = true;
      script.crossOrigin = 'anonymous';
      script.onload = () => resolve();
      script.onerror = () => reject();
      document.head.appendChild(script);
      setTimeout(() => reject(new Error('timeout')), 10000);
    });
  }

  async _loadWordCloud() {
    if (window._wisWordCloudLoaded) return true;

    const local = (typeof chrome !== 'undefined' && chrome?.runtime?.getURL)
      ? chrome.runtime.getURL('src/vendor/echarts-wordcloud.min.js')
      : null;
    const urls = [
      ...(local ? [local] : []),
      'https://cdn.jsdelivr.net/npm/echarts-wordcloud@2/dist/echarts-wordcloud.min.js',
      'https://unpkg.com/echarts-wordcloud@2/dist/echarts-wordcloud.min.js'
    ];

    for (const url of urls) {
      try {
        await this._loadScript(url);
        window._wisWordCloudLoaded = true;
        return true;
      } catch (e) {
        console.warn('[ChartManager] WordCloud plugin failed:', url);
      }
    }

    return false;
  }

  async renderTrend({ series, counts, arousal }) {
    await this.init();
    if (!this.chartInstance) return;

    console.log('[ChartManager] Rendering trend chart');

    this._ensureInstanceIntegrity();
    this.chartInstance.clear();
    try { const c = document.getElementById(this.containerId); const h = c && c.querySelector('.wis-wc2-host'); if (h) h.remove(); } catch {}

    const legend = ['情感强度(平滑)'];
    const seriesArr = [{
      name: '情感强度(平滑)',
      type: 'line',
      showSymbol: false,
      data: series,
      smooth: true,
      lineStyle: { width: 3, color: '#8b5cf6' },
      areaStyle: {
        color: new this.echarts.graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: 'rgba(139,92,246,0.3)' },
          { offset: 1, color: 'rgba(139,92,246,0.1)' }
        ])
      }
    }];

    if (arousal) {
      legend.push('兴奋度');
      seriesArr.push({
        name: '兴奋度',
        type: 'line',
        showSymbol: false,
        data: arousal,
        lineStyle: { type: 'dashed', color: '#22d3ee' }
      });
    }

    if (counts) {
      legend.push('样本数');
      seriesArr.push({
        name: '样本数',
        yAxisIndex: 1,
        type: 'bar',
        data: counts,
        itemStyle: {
          color: 'rgba(59,130,246,0.6)',
          borderRadius: [2, 2, 0, 0]
        }
      });
    }

    this.chartInstance.setOption({
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis',
        backgroundColor: 'rgba(17,24,39,.95)',
        textStyle: { color: '#e5e7eb' },
        formatter: (params) => {
          if (!params || !params[0]) return '';
          const time = params[0].value[0];
          let html = `<div style="font-size:12px;font-weight:700;margin-bottom:4px;">时间: ${Math.round(time)}s</div>`;
          params.forEach(p => {
            if (p && p.value && p.value[1] !== undefined) {
              html += `<div style="margin:2px 0;">${p.marker}${p.seriesName}: ${p.value[1].toFixed(3)}</div>`;
            }
          });
          html += `<div style="font-size:11px;color:#9ca3af;margin-top:6px;">💡 点击查看该时段详情</div>`;
          html += `<div style="font-size:10px;color:#64748b;margin-top:4px;">拖动移动 | 滚轮缩放</div>`;
          return html;
        }
      },
      legend: {
        data: legend,
        textStyle: { color: '#d1d5db', fontSize: 12 },
        right: 10,
        top: 10
      },
      grid: { left: 60, right: 30, top: 40, bottom: 64 },
      xAxis: {
        type: 'value',
        axisLabel: {
          color: '#e5e7eb',
          fontSize: 12,
          margin: 10,
          showMinLabel: true,
          showMaxLabel: true,
          formatter: (s) => `${Math.round(s)}s`,
          hideOverlap: true
        },
        axisLine: { lineStyle: { color: 'rgba(148,163,184,0.6)' } },
        axisTick: { show: false },
        splitLine: { lineStyle: { color: 'rgba(75,85,99,.25)' } },
        splitNumber: 8
      },
      yAxis: [
        {
          type: 'value',
          name: '强度',
          min: -1,
          max: 1,
          axisLabel: { color: '#9ca3af', fontSize: 11 },
          splitLine: { lineStyle: { color: 'rgba(75,85,99,.2)' } }
        },
        {
          type: 'value',
          name: '样本数',
          axisLabel: { color: '#9ca3af', fontSize: 11 },
          splitLine: { show: false }
        }
      ],
      dataZoom: [
        {
          type: 'inside',
          xAxisIndex: 0,
          zoomOnMouseWheel: true,      // 滚轮缩放
          moveOnMouseWheel: false,     // 禁止滚轮平移
          moveOnMouseMove: true,       // 左键拖动平移
          preventDefaultMouseMove: true,
          throttle: 50
        },
        { type: 'slider', xAxisIndex: 0, height: 18, bottom: 8, handleSize: 12 }
      ],
      series: seriesArr
    });

    // Click event
    this.chartInstance.off('click');
    this.chartInstance.on('click', (p) => {
      if (p && p.value) {
        const time = Array.isArray(p.value) ? p.value[0] : p.value;
        window.postMessage({ type: 'WIS_CHART_CLICK', chart: 'trend', time }, '*');
      }
    });

    this._postRender();
  }

  async renderStack({ stackSeries, labels }) {
    await this.init();
    if (!this.chartInstance) return;

    console.log('[ChartManager] Rendering stack chart');

    this._ensureInstanceIntegrity();
    this.chartInstance.clear();
    try { const c = document.getElementById(this.containerId); const h = c && c.querySelector('.wis-wc2-host'); if (h) h.remove(); } catch {}

    const colors = [
      '#8b5cf6', '#3b82f6', '#10b981', '#fbbf24',
      '#ef4444', '#ec4899', '#14b8a6', '#f97316'
    ];

    this._ensureInstanceIntegrity();
    this.chartInstance.clear();
    this.chartInstance.setOption({
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis',
        backgroundColor: 'rgba(17,24,39,.95)',
        textStyle: { color: '#e5e7eb' },
        axisPointer: { type: 'cross', label: { backgroundColor: '#6a7985' } },
        formatter: (params) => {
          if (!params || !params.length) return '';
          const time = params[0]?.value?.[0] || 0;
          let html = `<div style="font-size:12px;font-weight:700;margin-bottom:6px;">时间: ${Math.round(time)}s</div>`;
          params.forEach(p => {
            if (p && p.value && p.value[1] !== undefined) {
              html += `<div style="margin:2px 0;">${p.marker}${p.seriesName}: ${p.value[1]}</div>`;
            }
          });
          html += `<div style="font-size:11px;color:#9ca3af;margin-top:8px;">💡 点击查看该情绪的代表弹幕</div>`;
          html += `<div style="font-size:10px;color:#64748b;margin-top:4px;">拖动移动 | 滚轮缩放</div>`;
          return html;
        }
      },
      legend: {
        data: labels,
        textStyle: { color: '#d1d5db', fontSize: 12 },
        right: 10,
        top: 10,
        type: 'scroll'
      },
      grid: { left: 60, right: 30, top: 50, bottom: 64 },
      xAxis: {
        type: 'value',
        axisLabel: {
          color: '#e5e7eb',
          fontSize: 12,
          margin: 12,
          showMinLabel: true,
          showMaxLabel: true,
          formatter: (s) => `${Math.round(s)}s`,
          hideOverlap: true
        },
        axisLine: { lineStyle: { color: 'rgba(148,163,184,0.6)' } },
        axisTick: { show: false },
        splitLine: { lineStyle: { color: 'rgba(75,85,99,.25)' } },
        splitNumber: 8
      },
      yAxis: {
        type: 'value',
        name: '弹幕数',
        axisLabel: { color: '#9ca3af', fontSize: 11 },
        splitLine: { lineStyle: { color: 'rgba(75,85,99,.2)' } }
      },
      dataZoom: [
        {
          type: 'inside',
          xAxisIndex: 0,
          zoomOnMouseWheel: true,      // 滚轮缩放
          moveOnMouseWheel: false,     // 禁止滚轮平移
          moveOnMouseMove: true,       // 左键拖动平移
          preventDefaultMouseMove: true,
          throttle: 50
        },
        { type: 'slider', xAxisIndex: 0, height: 18, bottom: 8, handleSize: 14 }
      ],
      series: stackSeries.map((data, i) => ({
        name: labels[i] || `系列${i}`,
        type: 'line',
        stack: 'total',
        areaStyle: { opacity: 0.7 },
        emphasis: { focus: 'series' },
        showSymbol: false,
        smooth: true,
        lineStyle: { width: 2, color: colors[i % colors.length] },
        itemStyle: { color: colors[i % colors.length] },
        data
      }))
    });

    // Click event - 联动代表弹幕
    this.chartInstance.off('click');
    this.chartInstance.on('click', (params) => {
      if (params && params.value) {
        const time = Array.isArray(params.value) ? params.value[0] : params.value;
        const emotion = params.seriesName; // 点击的情绪标签
        console.log('[ChartManager] Stack clicked:', time, emotion);
        window.postMessage({
          type: 'WIS_CHART_CLICK',
          chart: 'stack',
          time,
          emotion
        }, '*');
      }
    });

    this._postRender();
  }

  async renderPie({ data }) {
    await this.init();
    if (!this.chartInstance) return;

    console.log('[ChartManager] Rendering pie chart');

    this._ensureInstanceIntegrity();
    this.chartInstance.clear();
    try { const c = document.getElementById(this.containerId); const h = c && c.querySelector('.wis-wc2-host'); if (h) h.remove(); } catch {}

    this.chartInstance.setOption({
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'item',
        formatter: '{b}: {c} ({d}%)',
        backgroundColor: 'rgba(17,24,39,.95)',
        textStyle: { color: '#e5e7eb' }
      },
      legend: {
        orient: 'vertical',
        left: 10,
        top: 10,
        textStyle: { color: '#d1d5db' }
      },
      series: [{
        name: '情绪占比',
        type: 'pie',
        radius: ['40%', '70%'],
        center: ['60%', '50%'],
        avoidLabelOverlap: true,
        label: { color: '#e5e7eb' },
        labelLine: { smooth: true },
        data
      }]
    });
    this._postRender();
  }

  async renderQuadrant({ points }) {
    await this.init();
    if (!this.chartInstance) return;

    console.log('[ChartManager] Rendering quadrant chart');

    this._ensureInstanceIntegrity();
    this.chartInstance.clear();
    try { const c = document.getElementById(this.containerId); const h = c && c.querySelector('.wis-wc2-host'); if (h) h.remove(); } catch {}

    // Defensive copy + jitter to reduce overplotting for identical buckets
    const jittered = (points || []).map((p, idx) => {
      const x = typeof p[0] === 'number' ? p[0] : 0;
      const y = typeof p[1] === 'number' ? p[1] : 0;
      const n = typeof p[2] === 'number' ? p[2] : 0;
      const t = typeof p[3] === 'number' ? p[3] : idx;
      // Deterministic small jitter based on time index
      const seed = Math.sin((t + 1) * 1337.17) * 10000;
      const r = (seed - Math.floor(seed));
      const angle = 2 * Math.PI * r;
      const amp = 0.015 + (n > 0 ? Math.min(0.03, Math.log10(1 + n) * 0.01) : 0);
      const jx = x + amp * Math.cos(angle);
      const jy = y + amp * Math.sin(angle);
      return [Math.max(-1, Math.min(1, jx)), Math.max(-1, Math.min(1, jy)), n, t, p[4] ?? n];
    });

    // Dynamic axis ranges focused on data with small margins
    let minX = -1, maxX = 1, minY = -1, maxY = 1;
    if (jittered.length) {
      minX = Math.min(...jittered.map(d => d[0]));
      maxX = Math.max(...jittered.map(d => d[0]));
      minY = Math.min(...jittered.map(d => d[1]));
      maxY = Math.max(...jittered.map(d => d[1]));
      const mx = (maxX - minX) || 0.2; // ensure non-zero span
      const my = (maxY - minY) || 0.2;
      const padX = mx * 0.1, padY = my * 0.1;
      minX = Math.max(-1, minX - padX);
      maxX = Math.min(1, maxX + padX);
      minY = Math.max(-1, minY - padY);
      maxY = Math.min(1, maxY + padY);
      if (minX === maxX) { minX = Math.max(-1, minX - 0.1); maxX = Math.min(1, maxX + 0.1); }
      if (minY === maxY) { minY = Math.max(-1, minY - 0.1); maxY = Math.min(1, maxY + 0.1); }
    }

    this.chartInstance.setOption({
      backgroundColor: 'transparent',
      tooltip: {
        backgroundColor: 'rgba(17,24,39,.95)',
        textStyle: { color: '#e5e7eb' },
        formatter: (p) => {
          const d = p.data;
          if (!d || d.length < 5) return '数据不完整';
          const m = Math.floor(d[3] / 60);
          const s = Math.floor(d[3] % 60);
          let html = `时间: ${m}:${String(s).padStart(2,'0')}<br/>样本: ${d[4]}<br/>正负: ${d[0].toFixed(2)} / 强弱: ${d[1].toFixed(2)}`;
          html += `<div style="font-size:10px;color:#64748b;margin-top:4px;">拖动移动 | 滚轮缩放</div>`;
          return html;
        }
      },
      xAxis: {
        type: 'value',
        min: minX,
        max: maxX,
        name: '正负(效价)',
        axisLabel: { color: '#9ca3af' },
        splitLine: { lineStyle: { color: 'rgba(75,85,99,.2)' } }
      },
      yAxis: {
        type: 'value',
        min: minY,
        max: maxY,
        name: '强弱(唤醒)',
        axisLabel: { color: '#9ca3af' },
        splitLine: { lineStyle: { color: 'rgba(75,85,99,.2)' } }
      },
      grid: { left: 48, right: 24, top: 24, bottom: 64 },
      dataZoom: [
        {
          type: 'inside',
          xAxisIndex: 0,
          yAxisIndex: 0,
          zoomOnMouseWheel: true,      // 滚轮缩放
          moveOnMouseWheel: false,     // 禁止滚轮平移
          moveOnMouseMove: true,       // 左键拖动平移
          preventDefaultMouseMove: true,
          throttle: 50
        },
        { type: 'slider', xAxisIndex: 0, height: 18, bottom: 8, handleSize: 12 },
        { type: 'slider', yAxisIndex: 0, width: 12, right: 6, handleSize: 8 }
      ],
      series: [{
        type: 'scatter',
        data: jittered,
        symbolSize: (d) => {
          if (!d || d.length < 3) return 6;
          return Math.max(6, Math.sqrt(d[2]) * 5);
        },
        large: true,
        itemStyle: { color: '#60a5fa', opacity: 0.75 },
        blendMode: 'lighter',
        emphasis: { focus: 'series' }
      }]
    });
    this._postRender();
  }

  // Word cloud removed; use renderWordBar instead

  // Public: render bar keywords (biliscope-style fallback / when cloud disabled)
  async renderWordBar({ words, topN = 120 }) {
    await this.init();
    const list = (words || []).slice(0, topN).map(w => [w.name, w.value]);
    if (!list.length) {
      this._ensureInstanceIntegrity();
      if (this.chartInstance) this.chartInstance.clear();
      this.chartInstance && this.chartInstance.setOption({
        backgroundColor: 'transparent',
        title: { text: '暂无关键词', left: 'center', top: 'middle', textStyle: { color: '#9ca3af' } }
      });
      return;
    }
    const cats = list.map(x => x[0]).reverse();
    const vals = list.map(x => x[1]).reverse();
    // remove wc2 host if any
    try { const c = document.getElementById(this.containerId); const h = c && c.querySelector('.wis-wc2-host'); if (h) h.remove(); } catch {}
    // fully reset before switching from other chart types to avoid ECharts merge glitches
    this._ensureInstanceIntegrity();
    if (this.chartInstance) this.chartInstance.clear();
    this.chartInstance.setOption({
      backgroundColor: 'transparent',
      grid: { left: 120, right: 28, top: 20, bottom: 48 },
      xAxis: { type: 'value', axisLabel: { color: '#9ca3af' }, splitLine: { lineStyle: { color: 'rgba(75,85,99,.2)' } } },
      yAxis: { type: 'category', data: cats, axisLabel: { color: '#d1d5db' } },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        backgroundColor: 'rgba(17,24,39,.95)',
        textStyle: { color: '#e5e7eb' },
        formatter: (params) => {
          if (!params || !params.length) return '';
          const word = params[0]?.name || '';
          const count = params[0]?.value || 0;
          let html = `<div style="font-size:13px;font-weight:700;margin-bottom:4px;">${word}</div>`;
          html += `<div style="margin:2px 0;">出现次数: ${count}</div>`;
          html += `<div style="font-size:11px;color:#9ca3af;margin-top:6px;">💡 点击查看相关弹幕</div>`;
          html += `<div style="font-size:10px;color:#64748b;margin-top:4px;">拖动移动 | 滚轮缩放</div>`;
          return html;
        }
      },
      dataZoom: [
        {
          type: 'inside',
          yAxisIndex: 0,
          zoomOnMouseWheel: true,      // 滚轮缩放
          moveOnMouseWheel: false,     // 禁止滚轮平移
          moveOnMouseMove: true,       // 左键拖动平移
          preventDefaultMouseMove: true,
          throttle: 50
        },
        { type: 'slider', yAxisIndex: 0, right: 6, width: 12, handleSize: 8 }
      ],
      series: [{ type: 'bar', data: vals, itemStyle: { color: '#60a5fa' }, barMaxWidth: 14 }]
    });
    this.chartInstance.off('click');
    this.chartInstance.on('click', (p) => {
      if (p && cats[p.dataIndex]) window.postMessage({ type: 'WIS_CHART_CLICK', chart: 'word', word: cats[p.dataIndex] }, '*');
    });
    this._postRender();
  }

  // _ensureWC2 removed

  _renderWordBar(list) {
    const cats = list.map(x => x[0]).reverse();
    const vals = list.map(x => x[1]).reverse();
    this.chartInstance.setOption({
      backgroundColor: 'transparent',
      grid: { left: 120, right: 20, top: 20, bottom: 20 },
      xAxis: { type: 'value', axisLabel: { color: '#9ca3af' }, splitLine: { lineStyle: { color: 'rgba(75,85,99,.2)' } } },
      yAxis: { type: 'category', data: cats, axisLabel: { color: '#d1d5db' } },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, backgroundColor: 'rgba(17,24,39,.95)', textStyle: { color: '#e5e7eb' } },
      series: [{ type: 'bar', data: vals, itemStyle: { color: '#60a5fa' }, barMaxWidth: 14 }]
    });
    this.chartInstance.off('click');
    this.chartInstance.on('click', (p) => {
      if (p && cats[p.dataIndex]) window.postMessage({ type: 'WIS_CHART_CLICK', chart: 'word', word: cats[p.dataIndex] }, '*');
    });
    this._postRender();
  }

  _ensureInstanceIntegrity() {
    try {
      const container = document.getElementById(this.containerId);
      if (!container) return;
      if (!this.chartInstance) return;
      const w = this.chartInstance.getWidth();
      const h = this.chartInstance.getHeight();
      if (!w || !h) {
        try { this.chartInstance.dispose(); } catch {}
        const cw = Math.max(320, container.clientWidth || 640);
        const ch = Math.max(240, container.clientHeight || 360);
        this.chartInstance = this.echarts.init(container, undefined, { width: cw, height: ch, renderer: 'canvas' });
      }
    } catch {}
  }

  _postRender() {
    try {
      if (this.chartInstance) {
        const container = document.getElementById(this.containerId);
        const w = container ? (container.clientWidth || Math.floor(container.getBoundingClientRect().width)) : undefined;
        const h = container ? (container.clientHeight || Math.floor(container.getBoundingClientRect().height)) : undefined;
        if (w && h) this.chartInstance.resize({ width: w, height: h });
        else this.chartInstance.resize();
        requestAnimationFrame(() => { try {
          const cw = container ? (container.clientWidth || Math.floor(container.getBoundingClientRect().width)) : undefined;
          const ch = container ? (container.clientHeight || Math.floor(container.getBoundingClientRect().height)) : undefined;
          if (cw && ch) this.chartInstance && this.chartInstance.resize({ width: cw, height: ch });
          else this.chartInstance && this.chartInstance.resize();
        } catch {} });
      }
    } catch {}
  }

  resize() {
    if (this.chartInstance) {
      this.chartInstance.resize();
    }
  }

  destroy() {
    if (this.chartInstance) {
      this.chartInstance.dispose();
      this.chartInstance = null;
    }
    try { if (this._ro) { this._ro.disconnect(); this._ro = null; } } catch {}
    try { if (this._onResize) { window.removeEventListener('resize', this._onResize); this._onResize = null; } } catch {}
    this.ready = false;
  }
}

// Export for use in content script
if (typeof window !== 'undefined') {
  window.ChartManager = ChartManager;
}
