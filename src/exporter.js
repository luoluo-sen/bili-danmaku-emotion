// Export helpers (JSON / CSV / Markdown)
// Usage: WIS.exporter.json(state), WIS.exporter.csv(state), WIS.exporter.markdown(state)
(function() {
  const WIS = (window.WIS = window.WIS || {});
  const { utils } = WIS;
  const exporter = {};

  exporter.json = function(state) {
    if (!state || !state._outputs) throw new Error('请先完成分析');
    const data = {
      metadata: {
        exportTime: new Date().toISOString(),
        totalDanmaku: state._outputs.length,
        videoURL: location.href
      },
      results: state._outputs,
      aggregated: {
        trend: state._trend,
        stack: state._stack,
        quadrant: state._quad,
        words: state._words || []
      }
    };
    let payload = null;
    try {
      payload = JSON.stringify(data, null, 2);
    } catch (err) {
      throw new Error('JSON 序列化失败: ' + (err && err.message ? err.message : String(err)));
    }
    const blob = new Blob([payload], { type: 'application/json' });
    utils.downloadBlob(`danmaku-sentiment-${Date.now()}.json`, blob);
  };

  exporter.csv = function(state) {
    if (!state || !state._outputs) throw new Error('请先完成分析');
    const headers = ['时间(秒)', '文本', '情绪标签', '情感分数', '效价', '唤醒度', '置信度'];
    const rows = state._outputs.map(o => [
      (o.t ?? 0).toFixed(2),
      `"${String(o.text || '').replace(/"/g, '""')}"`,
      String(o.label || ''),
      Number(o.score || 0).toFixed(3),
      Number(o.valence || 0).toFixed(3),
      Number(o.arousal || 0).toFixed(3),
      Number(o.conf || 0).toFixed(3)
    ]);
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\r\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
    utils.downloadBlob(`danmaku-sentiment-${Date.now()}.csv`, blob);
  };

  exporter.markdown = function(state) {
    if (!state || !state._outputs) throw new Error('请先完成分析');
    const avgSent = (utils.sum(state._outputs.map(o => o.score || 0)) / state._outputs.length).toFixed(3);
    const positive = state._outputs.filter(o => (o.score || 0) > 0.1).length;
    const negative = state._outputs.filter(o => (o.score || 0) < -0.1).length;
    const labelDist = state.labels.map(l => ({ label: l.key, count: state._outputs.filter(o => o.label === l.key).length }))
      .filter(x => x.count > 0).sort((a, b) => b.count - a.count);

    const md = `# 弹幕情感分析报告

## 概览
- **视频链接**: ${location.href}
- **分析时间**: ${new Date().toLocaleString('zh-CN')}
- **弹幕总数**: ${state._outputs.length}
- **平均情感**: ${avgSent}
- **积极弹幕**: ${positive} (${(positive/state._outputs.length*100).toFixed(1)}%)
- **消极弹幕**: ${negative} (${(negative/state._outputs.length*100).toFixed(1)}%)

## 情绪分布
${labelDist.map(x => `- **${x.label}**: ${x.count} (${(x.count/state._outputs.length*100).toFixed(1)}%)`).join('\n')}

## 高频词汇 (Top 10)
${(state._words || []).slice(0, 10).map((w, i) => `${i+1}. ${w.name} (${w.value}次)`).join('\n')}

## 代表弹幕 (高置信度前20)
${state._outputs.slice().sort((a,b) => (b.conf||0) - (a.conf||0)).slice(0, 20).map((o, i) => `${i+1}. [${o.label}] ${o.text} (置信度: ${Number(o.conf||0).toFixed(2)})`).join('\n')}

---
*由 B站弹幕情感分析插件 (Qwen Embedding) 生成*
`;
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    utils.downloadBlob(`danmaku-report-${Date.now()}.md`, blob);
  };

  WIS.exporter = exporter;
})();
