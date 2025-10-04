(() => {
  // Page-context script: loads ECharts and renders charts on request
  const EXT_BASE = (() => {
    try {
      const s = document.currentScript && document.currentScript.src;
      if (s && s.startsWith('chrome-extension://')) {
        const i = s.lastIndexOf('/src/injected.js');
        if (i >= 0) return s.slice(0, i);
        return s.substring(0, s.lastIndexOf('/'));
      }
    } catch {}
    return '';
  })();

  function ensureECharts() {
    const local = EXT_BASE ? (EXT_BASE + '/src/vendor/echarts.min.js') : null;
    const urls = [
      ...(local ? [local] : []),
      'https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js',
      'https://unpkg.com/echarts@5/dist/echarts.min.js',
      'https://fastly.jsdelivr.net/npm/echarts@5/dist/echarts.min.js',
      'https://cdn.bootcdn.net/ajax/libs/echarts/5.5.0/echarts.min.js'
    ];
    return new Promise((resolve) => {
      if (window.echarts) return resolve(window.echarts);
      const loadNext = () => {
        const u = urls.shift();
        if (!u) return resolve(null);
        const s = document.createElement('script');
        s.src = u; s.async = true; s.crossOrigin = 'anonymous';
        s.onload = () => resolve(window.echarts || null);
        s.onerror = () => { try { s.remove(); } catch {} loadNext(); };
        document.head.appendChild(s);
      };
      loadNext();
    });
  }

  async function ensureWordCloud(echarts) {
    return new Promise((resolve) => {
      // Check if wordCloud is already registered
      if (window._wisWordCloudLoaded) {
        return resolve(true);
      }

      // Try to register existing plugin
      try {
        if (typeof echarts.registerWordCloud === 'function') {
          window._wisWordCloudLoaded = true;
          return resolve(true);
        }
      } catch {}

      // Load plugin script with fallbacks
      const local = EXT_BASE ? (EXT_BASE + '/src/vendor/echarts-wordcloud.min.js') : null;
      const urls = [
        ...(local ? [local] : []),
        'https://cdn.jsdelivr.net/npm/echarts-wordcloud@2/dist/echarts-wordcloud.min.js',
        'https://unpkg.com/echarts-wordcloud@2/dist/echarts-wordcloud.min.js',
        'https://fastly.jsdelivr.net/npm/echarts-wordcloud@2/dist/echarts-wordcloud.min.js'
      ];
      const loadNext = () => {
        const u = urls.shift(); if (!u) return resolve(false);
        const s = document.createElement('script'); s.src = u; s.async = true; s.crossOrigin = 'anonymous';
        s.onload = () => { window._wisWordCloudLoaded = true; resolve(true); };
        s.onerror = () => { try { s.remove(); } catch {} loadNext(); };
        document.head.appendChild(s);
      };
      loadNext();
    });
  }

  function formatMMSS(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  function getOrInit(ecLib, el) {
    let ec = null;
    try { ec = ecLib.getInstanceByDom(el); } catch {}
    if (ec) { try { ec.clear(); } catch {} return ec; }
    return ecLib.init(el);
  }

  function renderTrend(echarts, el, payload) {
    const { series, counts, extra } = payload;
    console.log('[WIS injected] renderTrend received:', { series: series?.length, counts: counts?.length, extra });

    if (!el) {
      console.error('[WIS injected] renderTrend: el is null');
      return;
    }

    if (!series || series.length === 0) {
      el.innerHTML = '<div style="color:#9ca3af;padding:40px;text-align:center;font-size:14px;">暂无趋势数据</div>';
      return;
    }

    const ec = getOrInit(echarts, el);
    const legend = ['情感强度(平滑)'];
    const seriesArr = [{
      name: '情感强度(平滑)', type: 'line', showSymbol: false, data: series, smooth: true,
      lineStyle: { width: 3, color: '#8b5cf6' },
      areaStyle: { color: new echarts.graphic.LinearGradient(0,0,0,1,[{offset:0,color:'rgba(139,92,246,0.3)'},{offset:1,color:'rgba(139,92,246,0.1)'}]) }
    }];
    if (extra && extra.arousal) {
      legend.push('兴奋度');
      seriesArr.push({ name: '兴奋度', type: 'line', showSymbol: false, data: extra.arousal, lineStyle: { type: 'dashed', color: '#22d3ee' } });
    }
    if (counts) {
      legend.push('样本数');
      seriesArr.push({ name: '样本数', yAxisIndex: 1, type: 'bar', data: counts, itemStyle: { color: 'rgba(59,130,246,0.6)', borderRadius: [2,2,0,0] } });
    }
    ec.setOption({
      backgroundColor: '#0b122',
      tooltip: {
        trigger: 'axis',
        backgroundColor: 'rgba(17,24,39,.95)',
        textStyle: { color: '#e5e7eb' },
        formatter: (params) => {
          if (!params || !params[0] || !params[0].value) return '';
          let html = `<div style="font-size:12px;font-weight:700;margin-bottom:4px;">时间: ${formatMMSS(params[0].value[0])}</div>`;
          params.forEach(p => {
            if (p && p.value && p.value[1] !== undefined) {
              html += `<div style="margin:2px 0;">${p.marker}${p.seriesName}: ${p.value[1].toFixed(3)}</div>`;
            }
          });
          html += `<div style="font-size:11px;color:#9ca3af;margin-top:6px;">💡 点击查看该时段详情</div>`;
          return html;
        }
      },
      legend: { data: legend, textStyle: { color: '#d1d5db', fontSize: 12 }, right: 10, top: 10 },
      grid: { left: 60, right: 30, top: 40, bottom: 40 },
      xAxis: { type: 'value', axisLabel: { color: '#9ca3af', fontSize: 11, formatter: (s) => formatMMSS(s) }, splitLine: { lineStyle: { color: 'rgba(75,85,99,.2)' } } },
      yAxis: [
        { type: 'value', name: '强度', min: -1, max: 1, axisLabel: { color: '#9ca3af', fontSize: 11 }, splitLine: { lineStyle: { color: 'rgba(75,85,99,.2)' } } },
        { type: 'value', name: '样本数', axisLabel: { color: '#9ca3af', fontSize: 11 }, splitLine: { show: false } }
      ],
      series: seriesArr
    });

    // 点击曲线，通知内容脚本当前时间点
    el.style.cursor = 'pointer';
    ec.off('click');
    ec.on('click', (p) => {
      if (!p || !p.value) return;
      const t = Array.isArray(p.value) ? p.value[0] : p.value;
      window.postMessage({ type: 'WIS_TREND_CLICK', time: t }, '*');
    });
  }

  function renderStack(echarts, el, payload) {
    const { stackSeries, labels } = payload;

    if (!el) {
      console.error('[WIS injected] renderStack: el is null');
      return;
    }

    if (!stackSeries || stackSeries.length === 0 || !labels) {
      el.innerHTML = '<div style="color:#9ca3af;padding:40px;text-align:center;font-size:14px;">暂无堆叠数据</div>';
      return;
    }

    console.log('[WIS injected] renderStack:', { seriesCount: stackSeries.length, labels });
    const ec = getOrInit(echarts, el);
    const colors = ['#8b5cf6', '#3b82f6', '#10b981', '#fbbf24', '#ef4444', '#ec4899', '#14b8a6', '#f97316'];
    ec.setOption({
      backgroundColor: '#0b122',
      tooltip: {
        trigger: 'axis',
        backgroundColor: 'rgba(17,24,39,.95)',
        textStyle: { color: '#e5e7eb' },
        axisPointer: { type: 'cross', label: { backgroundColor: '#6a7985' } }
      },
      legend: {
        data: labels,
        textStyle: { color: '#d1d5db', fontSize: 12 },
        right: 10,
        top: 10,
        type: 'scroll'
      },
      grid: { left: 60, right: 30, top: 50, bottom: 40 },
      xAxis: {
        type: 'value',
        axisLabel: {
          color: '#9ca3af',
          fontSize: 11,
          formatter: (s) => formatMMSS(s)
        },
        splitLine: { lineStyle: { color: 'rgba(75,85,99,.2)' } }
      },
      yAxis: {
        type: 'value',
        name: '弹幕数',
        axisLabel: { color: '#9ca3af', fontSize: 11 },
        splitLine: { lineStyle: { color: 'rgba(75,85,99,.2)' } }
      },
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
  }

  function renderPie(echarts, el, payload) {
    if (!el) {
      console.error('[WIS injected] renderPie: el is null');
      return;
    }
    const data = (payload && payload.data) || [];
    if (!data.length) {
      el.innerHTML = '<div style="color:#9ca3af;padding:40px;text-align:center;font-size:14px;">暂无情绪占比数据</div>';
      return;
    }
    const ec = getOrInit(echarts, el);
    ec.setOption({
      backgroundColor: '#0b122',
      tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
      legend: { orient: 'vertical', left: 10, top: 10, textStyle: { color: '#d1d5db' } },
      series: [{
        name: '情绪占比', type: 'pie', radius: ['40%', '70%'], center: ['60%', '50%'],
        avoidLabelOverlap: true,
        label: { color: '#e5e7eb' },
        labelLine: { smooth: true },
        data: data
      }]
    });
  }

  function renderQuadrant(echarts, el, payload) {
    if (!el) {
      console.error('[WIS injected] renderQuadrant: el is null');
      return;
    }
    const { points } = payload; // [x,y,size,time,count]

    if (!points || points.length === 0) {
      el.innerHTML = '<div style="color:#9ca3af;padding:40px;text-align:center;font-size:14px;">暂无数据点</div>';
      return;
    }

    // Jitter same buckets slightly to reduce overlap
    const jittered = points.map((p, idx) => {
      const x = typeof p[0] === 'number' ? p[0] : 0;
      const y = typeof p[1] === 'number' ? p[1] : 0;
      const n = typeof p[2] === 'number' ? p[2] : 0;
      const t = typeof p[3] === 'number' ? p[3] : idx;
      const seed = Math.sin((t + 1) * 1337.17) * 10000;
      const r = (seed - Math.floor(seed));
      const angle = 2 * Math.PI * r;
      const amp = 0.015 + (n > 0 ? Math.min(0.03, Math.log10(1 + n) * 0.01) : 0);
      const jx = x + amp * Math.cos(angle);
      const jy = y + amp * Math.sin(angle);
      return [Math.max(-1, Math.min(1, jx)), Math.max(-1, Math.min(1, jy)), n, t, p[4] ?? n];
    });

    let minX = -1, maxX = 1, minY = -1, maxY = 1;
    if (jittered.length) {
      minX = Math.min(...jittered.map(d => d[0]));
      maxX = Math.max(...jittered.map(d => d[0]));
      minY = Math.min(...jittered.map(d => d[1]));
      maxY = Math.max(...jittered.map(d => d[1]));
      const mx = (maxX - minX) || 0.2;
      const my = (maxY - minY) || 0.2;
      const padX = mx * 0.1, padY = my * 0.1;
      minX = Math.max(-1, minX - padX);
      maxX = Math.min(1, maxX + padX);
      minY = Math.max(-1, minY - padY);
      maxY = Math.min(1, maxY + padY);
      if (minX === maxX) { minX = Math.max(-1, minX - 0.1); maxX = Math.min(1, maxX + 0.1); }
      if (minY === maxY) { minY = Math.max(-1, minY - 0.1); maxY = Math.min(1, maxY + 0.1); }
    }

    const ec = getOrInit(echarts, el);
    ec.setOption({
      backgroundColor: '#0b122',
      tooltip: {
        formatter: (p) => {
          const d = p.data;
          if (!d || d.length < 5) return '数据不完整';
          return `时间: ${formatMMSS(d[3])}<br/>样本: ${d[4]}<br/>正负: ${d[0].toFixed(2)} / 强弱: ${d[1].toFixed(2)}`;
        }
      },
      xAxis: { type: 'value', min: minX, max: maxX, name: '正负(效价)', axisLabel: { color: '#aaa' } },
      yAxis: { type: 'value', min: minY, max: maxY, name: '强弱(唤醒)', axisLabel: { color: '#aaa' } },
      grid: { left: 48, right: 24, top: 24, bottom: 36 },
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
  }

  async function renderWordCloud(echarts, el, payload) {
    if (!el) {
      console.error('[WIS injected] renderWordCloud: el is null');
      return;
    }
    const success = await ensureWordCloud(echarts);
    if (!success) {
      console.error('[WIS] WordCloud plugin not available');
      el.innerHTML = '<div style="color:#ef4444;padding:40px;text-align:center;font-size:14px;">❌ 词云插件加载失败<br/><small style="color:#9ca3af;margin-top:8px;display:block;">请检查网络连接或刷新页面重试</small></div>';
      return;
    }

    const { words } = payload; // [{name,value}]
    if (!words || words.length === 0) {
      el.innerHTML = '<div style="color:#9ca3af;padding:40px;text-align:center;font-size:14px;">暂无词汇数据</div>';
      return;
    }

    const ec = getOrInit(echarts, el);
    ec.setOption({
      backgroundColor: '#0b122',
      tooltip: {
        formatter: (params) => {
          return `<div style="font-size:13px;font-weight:700;">${params.name}</div><div style="font-size:11px;color:#9ca3af;margin-top:4px;">出现 ${params.value} 次</div><div style="font-size:11px;color:#9ca3af;margin-top:4px;">💡 点击查看相关弹幕</div>`;
        }
      },
      series: [{
        type: 'wordCloud',
        gridSize: 8,
        sizeRange: [14, 56],
        rotationRange: [-45, 45],
        shape: 'circle',
        textStyle: {
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif',
          fontWeight: 'bold',
          color: () => {
            const c = ['#93c5fd', '#c4b5fd', '#fda4af', '#6ee7b7', '#fcd34d', '#a78bfa', '#60a5fa', '#34d399'];
            return c[Math.floor(Math.random() * c.length)];
          }
        },
        emphasis: {
          textStyle: {
            shadowBlur: 10,
            shadowColor: '#8b5cf6'
          }
        },
        data: words
      }]
    });

    // 添加点击事件
    el.style.cursor = 'pointer';
    ec.off('click');
    ec.on('click', (params) => {
      if (params.componentType === 'series' && params.name) {
        console.log('[WIS] WordCloud item clicked:', params.name);
        window.postMessage({ type: 'WIS_WORD_CLICK', word: params.name }, '*');
      }
    });
  }

  function renderBarKeys(echarts, el, payload) {
    if (!el) {
      console.error('[WIS injected] renderBarKeys: el is null');
      return;
    }
    const { words = [], topN = 30 } = payload;
    if (!words.length) {
      el.innerHTML = '<div style="color:#9ca3af;padding:40px;text-align:center;font-size:14px;">暂无关键词</div>';
      return;
    }
    const data = words.slice(0, topN);
    const ec = getOrInit(echarts, el);
    const cats = data.map(d => d.name).reverse();
    const vals = data.map(d => d.value).reverse();
    ec.setOption({
      backgroundColor: '#0b122',
      grid: { left: 120, right: 20, top: 20, bottom: 20 },
      xAxis: { type: 'value', axisLabel: { color: '#9ca3af' }, splitLine: { lineStyle: { color: 'rgba(75,85,99,.2)' } } },
      yAxis: { type: 'category', data: cats, axisLabel: { color: '#d1d5db' } },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      series: [{ type: 'bar', data: vals, itemStyle: { color: '#60a5fa' }, barMaxWidth: 14 }]
    });
    el.style.cursor = 'pointer';
    ec.off('click');
    ec.on('click', (p) => {
      if (p && cats[p.dataIndex]) window.postMessage({ type: 'WIS_WORD_CLICK', word: cats[p.dataIndex] }, '*');
    });
  }

  // wordcloud2 (canvas) implementation for better performance
  async function ensureWC2() {
    if (window.WordCloud) return true;
    return new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = EXT_BASE ? (EXT_BASE + '/src/vendor/wordcloud2.min.js') : 'https://cdn.jsdelivr.net/npm/wordcloud@1.2.2/src/wordcloud2.min.js';
      s.onload = () => resolve(true);
      s.onerror = () => { console.error('[WIS] Failed to load wordcloud2'); resolve(false); };
      document.head.appendChild(s);
    });
  }

  async function renderWordCloud2(echarts, el, payload) {
    if (!el) {
      console.error('[WIS injected] renderWordCloud2: el is null');
      return;
    }
    const ok = await ensureWC2();
    const { words = [], topN = 30 } = payload || {};
    if (!ok || !words.length) {
      el.innerHTML = '<div style="color:#9ca3af;padding:40px;text-align:center;font-size:14px;">暂无词汇数据</div>';
      return;
    }
    // Prepare canvas
    el.innerHTML = '';
    const canvas = document.createElement('canvas');
    canvas.style.width = '100%';
    const h = Math.max(180, Math.floor((el.clientWidth || 640) * 0.5));
    canvas.style.height = h + 'px';
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor((el.clientWidth || 640) * dpr);
    canvas.height = Math.floor(h * dpr);
    el.appendChild(canvas);

    const list = words.slice(0, topN).map(w => [w.name, w.value]);
    const maxv = Math.max(...list.map(x => x[1]), 1);
    window.WordCloud(canvas, {
      list,
      backgroundColor: 'transparent',
      weightFactor: (100 / maxv) * dpr,
      shrinkToFit: true,
      minSize: 12 * dpr,
      drawOutOfBound: false,
      click: (item) => { if (item && item[0]) window.postMessage({ type: 'WIS_WORD_CLICK', word: item[0] }, '*'); }
    });
  }

  window.addEventListener('message', (e) => {
    const d = e.data || {};
    if (!d || !d.type || !d.type.startsWith('WIS_')) return;
    console.log('[WIS injected] Received message:', d.type, d.containerId);
    (async () => {
      try {
        const echarts = await ensureECharts();
        const containerId = d.containerId || 'wis-chart';
        // 等待容器元素出现（最多3秒）
        let el = document.getElementById(containerId);
        if (!el) {
          console.log('[WIS injected] Waiting for container:', containerId);
          for (let i = 0; i < 30 && !el; i++) {
            await new Promise(r => setTimeout(r, 100));
            el = document.getElementById(containerId);
          }
        }
        console.log('[WIS injected] Element found:', !!el, 'ECharts loaded:', !!echarts);
        if (!el) {
          console.error('[WIS injected] Container element not found after waiting:', containerId);
          return;
        }
        if (!echarts) {
          console.error('[WIS injected] ECharts failed to load');
          el.innerHTML = '<div style="color:#ef4444;padding:40px;text-align:center;font-size:14px;">❌ ECharts 加载失败<br/><small style="color:#9ca3af;margin-top:8px;display:block;">检查网络/CSP 或稍后重试</small></div>';
          return;
        }
        if (d.type === 'WIS_RENDER_TREND' || d.type === 'WIS_RENDER_CHART') return renderTrend(echarts, el, d);
        if (d.type === 'WIS_RENDER_STACK') return renderStack(echarts, el, d);
        if (d.type === 'WIS_RENDER_QUADRANT') return renderQuadrant(echarts, el, d);
        if (d.type === 'WIS_RENDER_WORDCLOUD') return renderWordCloud2(echarts, el, d);
        if (d.type === 'WIS_RENDER_BARKEYS') return renderBarKeys(echarts, el, d);
        if (d.type === 'WIS_RENDER_PIE') return renderPie(echarts, el, d);
      } catch (err) {
        console.error('[WIS injected] Error in message handler:', err);
      }
    })();
  });

  // Notify content script we're installed
  try { document.dispatchEvent(new Event('WIS_INJECTED_READY')); } catch {}
})();
