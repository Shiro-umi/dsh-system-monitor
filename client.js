/**
 * macOS 系统与会话监控插件的客户端。
 *
 * 在 conversation.composer.dock 提供 5 个可拖拽排序吸附的胶囊（Context、Tokens、CPU、GPU、MEM）。
 * 宿主端原生采样器每 200ms（5Hz）推送一帧 CPU、GPU、内存数据，客户端存入环形缓冲。
 * 全局由唯一的 unifiedClock（1000ms 周期，挂载于单 rAF 循环）同步驱动所有数字锁存更新与完整周期连续插值动画。
 */
window.__ModuleLoader__.load({
  id: 'dsh-system-monitor',
  factory(require) {
    const React = require('react');
    const ReactDOM = require('react-dom');
    const { useState, useEffect, useLayoutEffect, useRef } = React;
    const h = React.createElement;

    const NS = 'system-monitor';
    const WINDOW_MS = 60000;
    const CAPACITY = 1400; // 60s * 20Hz 加余量
    const CLOCK_MS = 1000; // 全局唯一更新时钟周期（1Hz），每次时钟更新均匀分配在整个 1000ms 周期内连续动画

    const zh = {
      cpu: 'CPU',
      gpu: 'GPU',
      memory: 'MEM',
      process: '进程',
      user: '用户',
      system: '系统',
      renderer: '渲染',
      tiler: '贴片',
      wired: '联动',
      compressed: '压缩',
      peak: '60 秒峰值',
      floor: '图底',
      upload: '上传',
      download: '下载',
      total: '总计',
      close: '关闭',
      noProcess: '暂无进程数据',
      low: '低频模式',
      lowHint: '没有 clang，采样器没编译成功，每秒更新一次',
    };
    const en = {
      cpu: 'CPU',
      gpu: 'GPU',
      memory: 'MEM',
      process: 'Processes',
      user: 'User',
      system: 'System',
      renderer: 'Renderer',
      tiler: 'Tiler',
      wired: 'Wired',
      compressed: 'Compr',
      peak: '60s peak',
      floor: 'Floor',
      upload: 'Upload',
      download: 'Download',
      total: 'Total',
      close: 'Close',
      noProcess: 'No process data',
      low: 'Low-rate mode',
      lowHint: 'clang is missing, so the native sampler did not build. Updates once per second.',
    };

    const STYLES = `
/* 隐藏右侧原本独立的 ContextMeter，已合并入 usage 胶囊 */
[data-composer-dock] > .X0HXfW_root, [data-composer-stat="activity"], [data-composer-stat="usage"] { display: none !important; }
.sm-dock { position: relative; display: flex; align-items: center; gap: 4px; }

/* 胶囊公共基底：宽度变化、背景色变化全部走三次贝塞尔曲线动画 */
.sm-ctx-pill, .sm-tok-pill, .sm-btn {
  position: relative; z-index: 1; box-sizing: border-box; height: 24px;
  border-radius: var(--dsw-radius-sm);
  opacity: 1;
  background-color: var(--dsw-alias-bg-base); border: none;
  font-family: var(--dsw-font-family);
  font-variant-numeric: tabular-nums;
  cursor: grab; overflow: hidden; user-select: none; touch-action: none;
  will-change: width, transform;
  padding: 0;
  display: inline-flex; align-items: center;
  transition:
    width 1000ms cubic-bezier(0.25, 0.46, 0.45, 0.94),
    background-color 480ms cubic-bezier(0.05, 0.52, 0.12, 1),
    color 480ms cubic-bezier(0.05, 0.52, 0.12, 1),
    box-shadow 220ms ease;
}
.sm-ctx-pill:hover, .sm-tok-pill:hover, .sm-btn:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  transition:
    width 1000ms cubic-bezier(0.25, 0.46, 0.45, 0.94),
    background-color 180ms cubic-bezier(0.12, 1, 0.22, 1),
    color 180ms cubic-bezier(0.12, 1, 0.22, 1),
    box-shadow 220ms ease;
}
.sm-pill-inner {
  display: inline-flex; align-items: center; white-space: nowrap;
  pointer-events: none; box-sizing: border-box;
}
/* 其他槽位上的胶囊在拖放过程中的自动避让贝塞尔过渡 */
.sm-ctx-pill[data-dodging="true"], .sm-tok-pill[data-dodging="true"], .sm-btn[data-dodging="true"] {
  transition:
    width 460ms cubic-bezier(0.07, 0.76, 0.16, 1),
    transform 320ms cubic-bezier(0.12, 0.8, 0.2, 1),
    background-color 480ms cubic-bezier(0.05, 0.52, 0.12, 1),
    color 480ms cubic-bezier(0.05, 0.52, 0.12, 1);
}
/* 松手后自动吸附落入目标网格槽位的贝塞尔过渡 */
.sm-ctx-pill[data-snapping="true"], .sm-tok-pill[data-snapping="true"], .sm-btn[data-snapping="true"] {
  z-index: 60;
  opacity: 1 !important;
  background-color: var(--dsw-alias-bg-base) !important;
  transition:
    width 460ms cubic-bezier(0.07, 0.76, 0.16, 1),
    transform 300ms cubic-bezier(0.12, 0.82, 0.18, 1),
    background-color 300ms cubic-bezier(0.05, 0.48, 0.12, 1),
    box-shadow 280ms ease;
}
/* 拖放进行中：100% 实心不透明背景（绝不半透明透出底下正在避让的胶囊） */
.sm-ctx-pill[data-dragging="true"], .sm-tok-pill[data-dragging="true"], .sm-btn[data-dragging="true"] {
  cursor: grabbing;
  z-index: 60;
  opacity: 1 !important;
  background-color: color-mix(in srgb, var(--dsw-alias-bg-base) 90%, var(--dsw-alias-label-primary) 10%) !important;
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.22), 0 0 0 0.5px var(--dsw-alias-border-l1);
  transition: width 460ms cubic-bezier(0.07, 0.76, 0.16, 1), box-shadow 180ms ease;
}
.sm-ctx-pill:focus-visible, .sm-tok-pill:focus-visible, .sm-btn:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);
  outline-offset: -1px;
}
.sm-ctx-pill-hidden, .sm-tok-pill-hidden, .sm-btn-hidden {
  visibility: hidden; pointer-events: none;
}

/* Context 胶囊（5x3 纵向填充微网格 + 百分比） */
.sm-ctx-pill {
  color: var(--dsw-alias-label-secondary);
  font-size: 12px; font-weight: 600; line-height: 24px; white-space: nowrap;
}
.sm-ctx-pct { color: var(--dsw-alias-label-primary); font-weight: 600; font-size: 12px; }
.sm-ctx-unit { font-size: 10px; font-weight: 400; color: var(--dsw-alias-label-secondary); margin-left: 1px; }

/* Token 当轮上传/下载实时胶囊（克制单色设计，同一时间只显示上传或下载，箭头贝塞尔旋转） */
.sm-tok-pill {
  color: var(--dsw-alias-label-secondary);
  font-size: 12px; font-weight: 600; line-height: 24px; white-space: nowrap;
}
.sm-tok-arrow-wrap {
  display: inline-flex; align-items: center; overflow: hidden;
  width: 15.5px; height: 12px; flex: none;
  will-change: width, opacity;
  transition:
    width 460ms cubic-bezier(0.07, 0.76, 0.16, 1),
    opacity 360ms cubic-bezier(0.07, 0.76, 0.16, 1);
}
.sm-tok-arrow-wrap[data-idle="true"] {
  width: 0px;
  opacity: 0;
}
.sm-tok-arrow-svg {
  width: 11px; height: 11px; flex: none;
  color: var(--dsw-alias-label-tertiary);
  transform-origin: 50% 50%;
  transform: rotate(0deg);
  will-change: transform;
  transition: transform 560ms cubic-bezier(0.07, 0.76, 0.16, 1);
}
.sm-tok-arrow-svg[data-dir="down"] {
  transform: rotate(180deg);
}
.sm-tok-arrow-up, .sm-tok-arrow-down {
  font-size: 10px; font-weight: 500;
  color: var(--dsw-alias-label-tertiary);
}
.sm-tok-reading {
  display: inline-flex; align-items: baseline;
}
.sm-tok-num {
  color: var(--dsw-alias-label-primary);
  font-weight: 600; font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.sm-tok-unit {
  color: var(--dsw-alias-label-secondary);
  font-weight: 400; font-size: 10px; margin-left: 1px;
}
.sm-pill-echo-tok { gap: 0px; padding: 0 8px; }
/* Token 浮窗内双读数与当轮分步柱状图（固定 277px 宽，单色明暗层级） */
.sm-tok-dual-hero {
  width: 277px;
  display: flex; align-items: baseline; justify-content: space-between;
  gap: 12px; margin-top: 6px;
}
.sm-tok-hero-col {
  display: flex; flex-direction: column; gap: 2px;
}
.sm-tok-hero-col-right {
  align-items: flex-end; text-align: right;
}
.sm-tok-hero-tag {
  font-size: 11px; font-weight: 500; line-height: 14px;
  color: var(--dsw-alias-label-tertiary);
  display: inline-flex; align-items: center; gap: 4px;
}
.sm-tok-ratio-bar {
  width: 277px; height: 6px;
  border-radius: 3px; overflow: hidden;
  background: var(--dsw-alias-border-l2);
  display: flex; gap: 2px;
  margin: 12px 0 10px;
}
.sm-tok-ratio-up {
  height: 100%; border-radius: 2px;
  background: var(--dsw-alias-label-secondary);
  opacity: 0.45;
  transition: width 1000ms cubic-bezier(0.25, 0.46, 0.45, 0.94);
}
.sm-tok-ratio-down {
  height: 100%; border-radius: 2px;
  background: var(--dsw-alias-label-primary);
  opacity: 0.9;
  transition: width 1000ms cubic-bezier(0.25, 0.46, 0.45, 0.94);
}
.sm-tok-steps-bars {
  width: 277px; height: 52px;
  display: grid;
  grid-template-columns: repeat(16, 1fr);
  gap: 3px;
  align-items: end;
  margin-bottom: 14px;
}
.sm-tok-step-col {
  height: 100%;
  display: flex; flex-direction: column; justify-content: flex-end;
  gap: 1.5px;
}
.sm-tok-step-up {
  width: 100%; border-radius: 1.5px;
  background: var(--dsw-alias-label-secondary);
  opacity: 0.42;
  transition: height 1000ms cubic-bezier(0.25, 0.46, 0.45, 0.94), opacity 1000ms cubic-bezier(0.25, 0.46, 0.45, 0.94);
}
.sm-tok-step-down {
  width: 100%; border-radius: 1.5px;
  background: var(--dsw-alias-label-primary);
  opacity: 0.88;
  transition: height 1000ms cubic-bezier(0.25, 0.46, 0.45, 0.94), opacity 1000ms cubic-bezier(0.25, 0.46, 0.45, 0.94);
}
.sm-tok-step-empty {
  width: 100%; height: 3px; border-radius: 1.5px;
  background: var(--dsw-alias-border-l2);
  opacity: 0.45;
}

/* CPU / GPU / 内存 胶囊（固定宽度） */
.sm-btn { display: block; width: 72px; padding: 0; }
.sm-btn[data-metric="memory"] { width: 84px; }
.sm-btn canvas { position: absolute; left: 0; right: 0; top: 3px; bottom: 3px; width: 100%; height: calc(100% - 6px); display: block; }
.sm-btn-text {
  position: absolute; left: 6px; top: 0; bottom: 0;
  display: flex; align-items: baseline; gap: 4px; pointer-events: none;
  line-height: 24px;
  text-shadow: 0 0 4px var(--dsw-alias-bg-base), 0 0 2px var(--dsw-alias-bg-base);
}
.sm-btn-label { color: var(--dsw-alias-label-secondary); font-size: 11px; }
.sm-btn-value { font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-primary); }
.sm-btn-unit { font-size: 10px; font-weight: 400; color: var(--dsw-alias-label-secondary); margin-left: 1px; }
.sm-low { font-size: 11px; color: var(--dsw-alias-label-tertiary); margin-left: 4px; }

/* 5x3 胶囊内微网格与 20x5 展开态正方形大网格（纵向优先填充 grid-auto-flow: column） */
.sm-brick-grid {
  display: grid;
  grid-template-columns: repeat(5, 3px);
  grid-template-rows: repeat(3, 3px);
  grid-auto-flow: column;
  gap: 1.5px;
  width: 21px; height: 12px;
  flex: none;
}
.sm-brick-cell {
  border-radius: 1px;
  background: var(--dsw-alias-border-l2);
  opacity: 0.55;
  transition: background-color 1000ms cubic-bezier(0.25, 0.46, 0.45, 0.94), opacity 1000ms cubic-bezier(0.25, 0.46, 0.45, 0.94);
}
.sm-brick-sys { background: var(--dsw-static-blue-450, #3b82f6); opacity: 0.92; }
.sm-brick-tools { background: #f59e0b; opacity: 0.92; }
.sm-brick-msg { background: var(--dsw-alias-label-primary); opacity: 0.88; }
.sm-brick-used { background: var(--dsw-alias-label-primary); opacity: 0.85; }
/* 未展开胶囊上的 5x3 微网格统一采用克制单色明暗层级 */
.sm-brick-grid .sm-brick-sys,
.sm-brick-grid .sm-brick-tools,
.sm-brick-grid .sm-brick-msg,
.sm-brick-grid .sm-brick-used {
  background: var(--dsw-alias-label-primary);
  opacity: 0.78;
}

/* 20x5 正方形大网格：预计算固定宽度 277px、高度 67px（单格 11x11px 正方形，间距 3px），仅左侧对齐锚点，绝不随卡片宽度缩放 */
.sm-bricks-dense {
  display: grid;
  grid-auto-flow: column;
  grid-template-columns: repeat(20, 11px);
  grid-template-rows: repeat(5, 11px);
  gap: 3px;
  width: 277px; height: 67px;
  margin: 12px 0 14px;
  flex: none;
}
.sm-bricks-dense .sm-brick-cell {
  width: 11px; height: 11px;
  border-radius: 2.2px;
}

/* 4 个胶囊完全共用的浮窗外壳与内部统一流式入场结构 */
.sm-popup {
  position: fixed; left: 0; top: 0; z-index: 9999; box-sizing: border-box;
  background: transparent;
  font-family: var(--dsw-font-family);
  will-change: transform, width, height, border-radius;
}
.sm-popup-clip {
  position: absolute; inset: 0;
  border-radius: inherit;
  overflow: hidden;
  background: var(--dsw-alias-bg-base);
  will-change: clip-path, border-radius, background-color, backdrop-filter;
}
/* 胶囊原位回声层：在展开起点与收起终点与原胶囊 1:1 对齐，随 pillAlpha 淡出/淡入 */
.sm-pill-echo {
  position: absolute; left: 0; top: 0; height: 24px;
  display: flex; align-items: center;
  pointer-events: none;
  will-change: opacity;
}
.sm-pill-echo-ctx { gap: 6px; padding: 0 7px; }
/* 展开卡片内容层：所有文字与网格图/柱状图均在同一坐标系内，左对齐 24px 锚点、固定 277px 内容宽，按同一条位移与透明度曲线同步入场/出场 */
.sm-popup-body {
  box-sizing: border-box;
  width: 325px;
  padding: 20px 24px 20px;
  transform-origin: left top;
  will-change: transform, opacity;
}
.sm-head-row {
  display: flex; align-items: center; justify-content: space-between;
  height: 18px;
}
.sm-title {
  font-size: 13px; font-weight: 600; line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.sm-close {
  border: none; background: transparent; cursor: pointer; padding: 0;
  width: 22px; height: 22px; display: grid; place-items: center;
  font-size: 17px; line-height: 1; color: var(--dsw-alias-label-tertiary);
  border-radius: var(--dsw-radius-sm);
  transition: background-color 160ms ease, color 160ms ease;
}
.sm-close:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }

/* 5 个弹窗统一的 Hero 读数行（固定 277px 宽，左 40px 大数字，右副标题/双行栈，严禁溢出） */
.sm-hero-row {
  width: 277px; box-sizing: border-box;
  display: flex; align-items: baseline; justify-content: space-between;
  gap: 8px; margin-top: 6px;
}
.sm-hero-row[data-stacked="true"] {
  align-items: flex-end;
}
.sm-big {
  color: var(--dsw-alias-label-primary);
  font-variant-numeric: tabular-nums;
  line-height: 1; white-space: nowrap; flex: none;
}
.sm-big-num { font-size: 40px; font-weight: 600; letter-spacing: -0.03em; }
.sm-big-unit { font-size: 14px; font-weight: 500; color: var(--dsw-alias-label-secondary); margin-left: 3px; }
.sm-hero-sub {
  min-width: 0; max-width: 100%;
  font-size: 12px; font-weight: 400; line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
  text-align: right; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis;
}
.sm-hero-sub-stack {
  min-width: 0; max-width: 100%;
  display: flex; flex-direction: column; align-items: flex-end;
  gap: 2px; padding-bottom: 2px;
  font-variant-numeric: tabular-nums;
  text-align: right;
}
.sm-hero-sub-primary {
  max-width: 100%;
  font-size: 11.5px; font-weight: 400; line-height: 14px;
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.sm-hero-sub-secondary {
  max-width: 100%;
  font-size: 11px; font-weight: 400; line-height: 14px;
  color: var(--dsw-alias-label-tertiary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

/* 系统监控固定 277px 宽柱状图容器（仅左侧对齐锚点，宽度不随卡片变） */
.sm-sys-chart-box {
  position: relative;
  width: 277px; height: 112px;
  margin-top: 10px;
}
.sm-sys-chart-box canvas {
  position: absolute; inset: 0; width: 100%; height: 100%; display: block;
}
.sm-axis { display: flex; justify-content: space-between; width: 277px; margin-top: 6px; font-size: 10px; line-height: 14px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.sm-procs { width: 277px; margin-top: 14px; padding-top: 12px; border-top: 0.5px solid var(--dsw-alias-border-l2); }
.sm-procs-title { font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-tertiary); margin-bottom: 6px; }
.sm-row { display: flex; align-items: baseline; gap: 10px; padding: 4px 0; font-size: 12px; line-height: 17px; }
.sm-row-i { width: 12px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; flex: none; }
.sm-row-n { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-primary); }
.sm-row-v { color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; flex: none; }
.sm-empty { font-size: 12px; color: var(--dsw-alias-label-tertiary); padding: 4px 0; }

/* Context 浮窗明细列表（同样固定 277px 宽左对齐） */
.sm-merged-dl {
  width: 277px;
  display: grid;
  grid-template-columns: minmax(84px, auto) minmax(0, 1fr);
  row-gap: 7px; column-gap: 16px;
  margin: 0;
  font-size: 12px; line-height: 18px;
}
.sm-merged-dl dt {
  margin: 0; color: var(--dsw-alias-label-secondary); font-weight: 400;
  display: inline-flex; align-items: center; gap: 7px;
}
.sm-merged-dl dd {
  margin: 0; text-align: right; color: var(--dsw-alias-label-primary);
  font-weight: 500; font-variant-numeric: tabular-nums;
}
.sm-merged-pct-sub {
  color: var(--dsw-alias-label-tertiary); font-weight: 400; font-size: 11px;
  margin-left: 6px; display: inline-block; min-width: 28px;
}
.sm-merged-dot { width: 7px; height: 7px; border-radius: 2px; flex: none; }
.sm-merged-rule { width: 277px; border-top: 0.5px solid var(--dsw-alias-border-l2); margin: 14px 0 12px; }
.sm-cache-header { width: 277px; display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 10px; }
.sm-cache-title { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.sm-cache-hit-badge { display: inline-flex; align-items: baseline; gap: 5px; font-variant-numeric: tabular-nums; }
.sm-cache-hit-label { font-size: 11px; color: var(--dsw-alias-label-tertiary); font-weight: 400; }
.sm-cache-hit-num { font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary); letter-spacing: -0.01em; }
.sm-token-dl {
  width: 277px;
  display: grid;
  grid-template-columns: minmax(84px, auto) minmax(0, 1fr);
  row-gap: 6px; column-gap: 16px;
  margin: 0;
  font-size: 12px; line-height: 17px;
}
.sm-token-dl dt { margin: 0; color: var(--dsw-alias-label-tertiary); font-weight: 400; }
.sm-token-dl dd { margin: 0; text-align: right; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; font-weight: 400; }
.sm-token-dl dd.sm-token-strong { color: var(--dsw-alias-label-primary); font-weight: 500; }
`;

    /**
     * 三个指标：从一帧取值、取量程、取细分文案。
     * 帧格式见 sampler.c：c=[user,system]，g=[device,renderer,tiler]，m=[used,wired,compressed,total]。
     */
    const METRICS = {
      cpu: {
        unit: '%',
        value: (f) => f.c[0] + f.c[1],
        max: () => 100,
        detail: (f, t) => `${t('user')} ${f.c[0].toFixed(1)}% · ${t('system')} ${f.c[1].toFixed(1)}%`,
        procKey: 'cpu',
        procList: 'cpu',
      },
      gpu: {
        unit: '%',
        value: (f) => f.g[0],
        max: () => 100,
        detail: (f, t) => `${t('renderer')} ${f.g[1].toFixed(0)}% · ${t('tiler')} ${f.g[2].toFixed(0)}%`,
        procKey: 'cpu',
        procList: 'cpu',
      },
      memory: {
        unit: 'GB',
        value: (f) => f.m[0],
        max: (f) => f.m[3],
        detail: (f, t, range) => [
          `${t('wired')} ${f.m[1].toFixed(1)} · ${t('compressed')} ${f.m[2].toFixed(1)}`,
          `${t('floor')} ${scaleOf('memory', true, range.top, range.bottom).lo.toFixed(1)} GB`,
        ],
        procKey: 'memory',
        procList: 'memory',
      },
    };
    const KEYS = ['cpu', 'gpu', 'memory'];

    /** 环形缓冲：存时间戳和三个指标的值。 */
    const store = {
      t: new Float64Array(CAPACITY),
      v: { cpu: new Float32Array(CAPACITY), gpu: new Float32Array(CAPACITY), memory: new Float32Array(CAPACITY) },
      head: 0,
      size: 0,
      last: null,
      low: false,
    };

    function push(frame) {
      const i = store.head;
      // 用宿主时间戳排布柱子，网络成批到达也不会挤成一根。
      // 浏览器和宿主在同一台机器上，时钟一致。偏差超过 2 秒才退回到达时间。
      const now = Date.now();
      store.t[i] = Math.abs(now - frame.t) < 2000 ? frame.t : now;
      for (const key of KEYS) store.v[key][i] = METRICS[key].value(frame);
      store.head = (i + 1) % CAPACITY;
      store.size = Math.min(CAPACITY, store.size + 1);
      const wasNull = store.last === null;
      store.last = frame;
      store.low = frame.low === true;
      if (wasNull && unifiedClock.sysFrame === null) {
        unifiedClock.primeSysFrame(frame);
      }
    }

    /** 取第 k 个样本（0 是最老的）。 */
    function at(k) {
      return (store.head - store.size + k + CAPACITY * 2) % CAPACITY;
    }

    /**
     * 订阅管理：第一个使用者打开流，最后一个走了关流。
     * fetch 流断了 1 秒后重连。页面隐藏时断流，回来时重连。
     */
    const hub = {
      users: 0,
      controller: null,
      retry: 0,
      retain(connection) {
        hub.connection = connection;
        hub.users += 1;
        if (hub.users === 1) hub.open();
        return () => {
          hub.users -= 1;
          if (hub.users === 0) hub.close();
        };
      },
      async open() {
        if (hub.controller !== null || document.hidden) return;
        const controller = new AbortController();
        hub.controller = controller;
        try {
          const response = await fetch('system-monitor/stream', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ type: 'client-request', rpcId: 'stream', method: 'stream', payload: {} }),
            signal: controller.signal,
          });
          if (!response.ok || response.body === null) throw new Error('HTTP ' + response.status);
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let pending = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            pending += decoder.decode(value, { stream: true });
            let index = pending.indexOf('\n');
            while (index >= 0) {
              const line = pending.slice(0, index);
              pending = pending.slice(index + 1);
              if (line !== '') {
                try {
                  push(JSON.parse(line));
                } catch {
                  // 坏行直接丢。
                }
              }
              index = pending.indexOf('\n');
            }
          }
        } catch {
          // 断流走下面的重连。
        }
        if (hub.controller === controller) hub.controller = null;
        if (hub.users > 0 && !controller.signal.aborted) {
          hub.retry = setTimeout(() => void hub.open(), 1000);
        }
      },
      close() {
        clearTimeout(hub.retry);
        if (hub.controller !== null) hub.controller.abort();
        hub.controller = null;
      },
    };
    document.addEventListener('visibilitychange', () => {
      if (hub.users === 0) return;
      if (document.hidden) hub.close();
      else void hub.open();
    });

    /**
     * 全局唯一的 rAF 循环：画所有注册的 canvas，回调文本更新。
     * 没有 canvas 注册时不排下一帧。
     */
    const painter = {
      items: new Set(),
      raf: 0,
      add(item) {
        painter.items.add(item);
        if (painter.raf === 0) painter.raf = requestAnimationFrame(painter.frame);
        return () => painter.items.delete(item);
      },
      frame(now) {
        painter.raf = 0;
        if (painter.items.size === 0) return;
        for (const item of painter.items) item(now);
        painter.raf = requestAnimationFrame(painter.frame);
      },
    };

    /** 读 CSS 变量里的颜色，缓存到下次主题变化前。 */
    const colorCache = { at: 0, values: {} };
    function themeColor(canvas, name) {
      const now = performance.now();
      if (now - colorCache.at > 2000) {
        colorCache.at = now;
        colorCache.values = {};
      }
      if (colorCache.values[name] === undefined) {
        const style = getComputedStyle(canvas);
        colorCache.values[name] = name === 'font' ? style.fontFamily : style.getPropertyValue(name).trim() || '#888';
      }
      return colorCache.values[name];
    }

    /** 按 devicePixelRatio 调整 canvas 像素尺寸，尺寸没变不动它。 */
    function fit(canvas) {
      const ratio = window.devicePixelRatio || 1;
      const w = Math.round(canvas.clientWidth * ratio);
      const hgt = Math.round(canvas.clientHeight * ratio);
      if (canvas.width !== w || canvas.height !== hgt) {
        canvas.width = w;
        canvas.height = hgt;
      }
      return ratio;
    }

    /**
     * 三次贝塞尔速度曲线求解器 P0=(0,0), P1=(x1,y1), P2=(x2,y2), P3=(1,1)。
     * 用牛顿迭代求 x(u)=t 对应的参数 u，再代入 y(u) 得到严格的速度曲线进度。
     */
    function cubicBezier(x1, y1, x2, y2) {
      const cx = 3 * x1;
      const bx = 3 * (x2 - x1) - cx;
      const ax = 1 - cx - bx;
      const cy = 3 * y1;
      const by = 3 * (y2 - y1) - cy;
      const ay = 1 - cy - by;
      const sampleX = (u) => ((ax * u + bx) * u + cx) * u;
      const sampleY = (u) => ((ay * u + by) * u + cy) * u;
      const sampleDerivX = (u) => (3 * ax * u + 2 * bx) * u + cx;
      return (t) => {
        if (t <= 0) return 0;
        if (t >= 1) return 1;
        let u = t;
        for (let i = 0; i < 6; i += 1) {
          const err = sampleX(u) - t;
          if (Math.abs(err) < 1e-6) break;
          const d = sampleDerivX(u);
          if (Math.abs(d) < 1e-6) break;
          u -= err / d;
        }
        if (u < 0 || u > 1) {
          let lo = 0;
          let hi = 1;
          u = t;
          for (let i = 0; i < 10; i += 1) {
            const x = sampleX(u);
            if (Math.abs(x - t) < 1e-6) break;
            if (t > x) lo = u;
            else hi = u;
            u = (lo + hi) * 0.5;
          }
        }
        return sampleY(u);
      };
    }

    // 展开与时钟更新共用曲线：前 50ms 快速起跳，后段长阻尼减速滑行
    const BEZIER_OPEN_Y = cubicBezier(0.07, 0.76, 0.16, 1);
    const BEZIER_OPEN_X = cubicBezier(0.12, 0.76, 0.22, 1);
    // 收起：保持初段加速不变，拉长末端落入槽位的减速缓冲段
    const BEZIER_CLOSE_Y = cubicBezier(0.14, 0.74, 0.16, 1);
    const BEZIER_CLOSE_X = cubicBezier(0.1, 0.78, 0.18, 1);
    // 切换指标：快速起跳 + 长尾减速滑移
    const BEZIER_SHIFT = cubicBezier(0.09, 0.76, 0.18, 1);
    // 背景色专属曲线：打开用短减速尽快切到菜单底色；关闭用长减速缓慢切回胶囊主题底色
    const BEZIER_BG_OPEN = cubicBezier(0.12, 1, 0.22, 1);
    const BEZIER_BG_CLOSE = cubicBezier(0.05, 0.48, 0.12, 1);

    function lerp(a, b, t) {
      return a + (b - a) * t;
    }

    /**
     * 全局唯一更新时钟发生器（unifiedClock）：
     * 1) 直接挂载在全局唯一的 painter (requestAnimationFrame) 上，整个文件零 setInterval；
     * 2) 每满 CLOCK_MS (1000ms) 触发一次 step(now)，同步锁存系统采样帧与会话 Token/Context 目标快照，并在偶数拍触发进程列表 RPC；
     * 3) 将时钟周期内的增量更新均匀分配到整个 1000ms 时钟周期内（tweenProg = (now - tickStartAt) / CLOCK_MS ∈ [0, 1]），
     *    彻底消除“动一下停一下”的瞬态阶跃感，所有柱状图滚动、新柱生长、峰值线位移和数字滚动在完整时钟周期内连续平滑演进。
     */
    const unifiedClock = {
      prevSysFrame: null,
      sysFrame: null,
      prevSysNow: Date.now() - CLOCK_MS,
      sysNow: Date.now(),
      prevSessionView: null,
      sessionView: null,
      tickId: 0,
      tickStartAt: 0,
      tweenProg: 0,
      painterUnsub: null,
      tickListeners: new Set(),
      tweenListeners: new Set(),
      procListeners: new Set(),
      totalSubscribers() {
        return unifiedClock.tickListeners.size + unifiedClock.tweenListeners.size + unifiedClock.procListeners.size;
      },
      start() {
        if (unifiedClock.painterUnsub !== null) return;
        const now = performance.now();
        unifiedClock.step(now);
        unifiedClock.painterUnsub = painter.add(unifiedClock.onFrame);
      },
      stop() {
        if (unifiedClock.painterUnsub !== null) {
          unifiedClock.painterUnsub();
          unifiedClock.painterUnsub = null;
        }
      },
      primeSysFrame(frame) {
        unifiedClock.prevSysFrame = frame;
        unifiedClock.sysFrame = frame;
        unifiedClock.tickId = (unifiedClock.tickId + 1) & 0xffff;
        for (const fn of unifiedClock.tickListeners) fn(unifiedClock.tickId);
      },
      primeSessionView() {
        const nextSession = computeClockedSessionView();
        unifiedClock.prevSessionView = nextSession;
        unifiedClock.sessionView = nextSession;
        unifiedClock.tickId = (unifiedClock.tickId + 1) & 0xffff;
        for (const fn of unifiedClock.tickListeners) fn(unifiedClock.tickId);
      },
      onFrame(now) {
        if (now - unifiedClock.tickStartAt >= CLOCK_MS) {
          unifiedClock.step(now);
        }
        const rawT = Math.min(1, Math.max(0, (now - unifiedClock.tickStartAt) / CLOCK_MS));
        unifiedClock.tweenProg = rawT;
        for (const fn of unifiedClock.tweenListeners) fn(rawT);
      },
      step(now = performance.now()) {
        const wallNow = Date.now();
        unifiedClock.prevSysFrame = unifiedClock.sysFrame || store.last;
        unifiedClock.sysFrame = store.last;
        unifiedClock.prevSysNow = unifiedClock.sysNow && (wallNow - unifiedClock.sysNow < CLOCK_MS * 4)
          ? unifiedClock.sysNow
          : wallNow - CLOCK_MS;
        unifiedClock.sysNow = wallNow;

        const nextSession = computeClockedSessionView();
        unifiedClock.prevSessionView = unifiedClock.sessionView || nextSession;
        unifiedClock.sessionView = nextSession;

        unifiedClock.tickId = (unifiedClock.tickId + 1) & 0xffff;
        unifiedClock.tickStartAt = now;
        unifiedClock.tweenProg = 0;

        for (const fn of unifiedClock.tickListeners) fn(unifiedClock.tickId);
        if ((unifiedClock.tickId & 1) === 1) {
          for (const fn of unifiedClock.procListeners) fn();
        }
      },
      subscribeTick(fn) {
        const wasEmpty = unifiedClock.totalSubscribers() === 0;
        unifiedClock.tickListeners.add(fn);
        if (wasEmpty) unifiedClock.start();
        return () => {
          unifiedClock.tickListeners.delete(fn);
          if (unifiedClock.totalSubscribers() === 0) unifiedClock.stop();
        };
      },
      subscribeTween(fn) {
        const wasEmpty = unifiedClock.totalSubscribers() === 0;
        unifiedClock.tweenListeners.add(fn);
        if (wasEmpty) unifiedClock.start();
        return () => {
          unifiedClock.tweenListeners.delete(fn);
          if (unifiedClock.totalSubscribers() === 0) unifiedClock.stop();
        };
      },
      subscribeProc(fn) {
        const wasEmpty = unifiedClock.totalSubscribers() === 0;
        unifiedClock.procListeners.add(fn);
        if (wasEmpty) unifiedClock.start();
        return () => {
          unifiedClock.procListeners.delete(fn);
          if (unifiedClock.totalSubscribers() === 0) unifiedClock.stop();
        };
      },
    };

    /** 窗口内原始值的最高和最低。 */
    function extent(key, windowMs) {
      const tEnd = unifiedClock.sysNow || Date.now();
      const from = tEnd - windowMs;
      let top = 0;
      let bottom = Infinity;
      for (let k = store.size - 1; k >= 0; k -= 1) {
        const i = at(k);
        const t = store.t[i];
        if (t > tEnd) continue;
        if (t < from) break;
        const v = store.v[key][i];
        if (v > top) top = v;
        if (v < bottom) bottom = v;
      }
      return { top, bottom: bottom === Infinity ? 0 : bottom };
    }

    /**
     * 按三次贝塞尔进度 prog ∈ [0, 1] 连续插值浮窗的背景色、毛玻璃与阴影描边：
     * 打开时从胶囊的悬停底色平滑过渡到菜单底色；关闭时从菜单底色平滑褪回透明胶囊底色。
     */
    function applyPopupSurface(pop, clip, radiusPx, prog) {
      const p = Math.max(0, Math.min(1, prog));
      const menuPct = (p * 100).toFixed(1);
      const rStr = radiusPx.toFixed(2) + 'px';
      pop.style.borderRadius = rStr;
      pop.style.boxShadow = p > 0.01
        ? `0 ${(14 * p).toFixed(1)}px ${(42 * p).toFixed(1)}px rgba(0, 0, 0, ${(0.18 * p).toFixed(3)}), 0 0 0 0.5px color-mix(in srgb, var(--dsw-alias-border-l1) ${menuPct}%, transparent)`
        : 'none';
      if (clip) {
        clip.style.borderRadius = rStr;
        clip.style.clipPath = `inset(0px round ${rStr})`;
        clip.style.webkitClipPath = `inset(0px round ${rStr})`;
        clip.style.backgroundColor = `color-mix(in srgb, var(--dsw-specific-menu) ${menuPct}%, var(--dsw-alias-bg-base))`;
        const blurPx = (20 * p).toFixed(1);
        clip.style.backdropFilter = p > 0.01 ? `blur(${blurPx}px)` : 'none';
        clip.style.webkitBackdropFilter = p > 0.01 ? `blur(${blurPx}px)` : 'none';
      }
    }

    /**
     * 柱子的量程。absMix ∈ [0, 1] 支持从胶囊自适应量程连续插值到弹窗 0..100 量程。
     */
    function scaleOf(key, absMix, top, bottom) {
      if (key === 'memory') {
        const span = Math.max(top - bottom, 1.5);
        return { lo: bottom - span * 0.6, max: top + span * 0.15 };
      }
      const relMax = Math.min(100, Math.max(30, top * 1.25));
      const mix = typeof absMix === 'number' ? absMix : (absMix ? 1 : 0);
      return { lo: 0, max: lerp(relMax, 100, mix) };
    }

    /**
     * 画按 unifiedClock 固定时钟触发、并在 460ms 窗口内沿三次贝塞尔曲线平滑推进与生长的柱状图。
     * 横向位移 tNow、新桶柱高生长、已有桶均值过渡、量程 (top/bottom) 与 60s 峰值虚线全部共用同一个进度 p = unifiedClock.tweenProg。
     */
    function draw(canvas, key, windowMs, opts) {
      const ratio = fit(canvas);
      const ctx = canvas.getContext('2d');
      const W = canvas.width;
      const H = canvas.height;
      ctx.clearRect(0, 0, W, H);
      if (store.size === 0 || W === 0 || H === 0) return;

      const step = opts.step * ratio;
      const barW = opts.bar * ratio;
      const cssW = canvas.clientWidth || W / ratio;
      // 弹窗内使用固定的目标桶宽 fixedBucketMs，防止展开/收起动画中分桶边界重切导致峰值与柱高抖动
      const bucketMs = opts.fixedBucketMs || (windowMs / (cssW / opts.step));
      const statWindowMs = opts.statWindowMs || windowMs;

      const p = unifiedClock.tweenProg;
      const tTarget = unifiedClock.sysNow || Date.now();
      const tPrev = unifiedClock.prevSysNow || tTarget;
      const tNow = lerp(tPrev, tTarget, p);
      const from = Math.min(tPrev, tNow) - statWindowMs - bucketMs;
      const curInWin = tTarget - statWindowMs;
      const prevInWin = tPrev - statWindowMs;

      const buckets = [];
      let curTop = 0;
      let curBottom = Infinity;
      let prevTop = 0;
      let prevBottom = Infinity;
      let curPeakMean = 0;
      let prevPeakMean = 0;

      for (let k = store.size - 1; k >= 0; k -= 1) {
        const i = at(k);
        const t = store.t[i];
        if (t > tTarget) continue;
        if (t < from) break;
        const v = store.v[key][i];
        if (t >= curInWin) {
          if (v > curTop) curTop = v;
          if (v < curBottom) curBottom = v;
        }
        if (t <= tPrev && t >= prevInWin) {
          if (v > prevTop) prevTop = v;
          if (v < prevBottom) prevBottom = v;
        }
        const b = Math.floor(t / bucketMs);
        const last = buckets[buckets.length - 1];
        if (last !== undefined && last.b === b) {
          last.s += v;
          last.c += 1;
          if (t <= tPrev) {
            last.ps += v;
            last.pc += 1;
            if (t >= prevInWin) last.prevInWin = true;
          }
          if (t >= curInWin) last.curInWin = true;
        } else {
          buckets.push({
            b,
            s: v,
            c: 1,
            ps: t <= tPrev ? v : 0,
            pc: t <= tPrev ? 1 : 0,
            curInWin: t >= curInWin,
            prevInWin: t <= tPrev && t >= prevInWin,
          });
        }
      }

      for (const bucket of buckets) {
        const curMean = bucket.s / bucket.c;
        const prevMean = bucket.pc > 0 ? (bucket.ps / bucket.pc) : curMean;
        bucket.v = lerp(prevMean, curMean, p);
        // 只要 tNow 正在扫过该时间桶 [b * bucketMs, (b + 1) * bucketMs]，按时间进度从底往上生长
        const rawLocal = (tNow - bucket.b * bucketMs) / Math.max(1, bucketMs);
        bucket.grow = rawLocal >= 1 ? 1 : BEZIER_OPEN_Y(Math.max(0, rawLocal));
        if (bucket.curInWin && curMean > curPeakMean) curPeakMean = curMean;
        if (bucket.prevInWin && bucket.pc > 0 && prevMean > prevPeakMean) prevPeakMean = prevMean;
      }

      if (curBottom === Infinity) curBottom = 0;
      if (prevBottom === Infinity) prevBottom = curBottom;
      if (prevTop === 0) prevTop = curTop;
      if (prevPeakMean === 0) prevPeakMean = curPeakMean;

      const top = lerp(prevTop, curTop, p);
      const bottom = lerp(prevBottom, curBottom, p);
      const peakMean = lerp(prevPeakMean, curPeakMean, p);

      const absMix = opts.absMix !== undefined ? opts.absMix : (opts.abs ? 1 : 0);
      const { lo, max } = scaleOf(key, absMix, top, bottom);
      const cap = opts.cap === undefined ? 1 : opts.cap;
      const frac = (v) => cap * Math.min(1, Math.max(0, (v - lo) / (max - lo)));
      const extraAlpha = opts.extraAlpha === undefined ? 1 : opts.extraAlpha;
      const settled = extraAlpha >= 0.995 && p >= 0.995;

      const primary = themeColor(canvas, '--dsw-alias-label-primary');
      const danger = themeColor(canvas, '--dsw-alias-state-error-primary');

      if (opts.grid && key !== 'memory' && extraAlpha > 0.01) {
        ctx.save();
        ctx.globalAlpha = extraAlpha;
        ctx.strokeStyle = themeColor(canvas, '--dsw-alias-border-l2');
        ctx.lineWidth = ratio;
        ctx.beginPath();
        for (const f of [0.5]) {
          const rawGy = H - f * (H - ratio);
          const gy = settled ? Math.round(rawGy) + 0.5 * ratio : rawGy;
          ctx.moveTo(W, gy);
          ctx.lineTo(W * 0.4, gy);
        }
        ctx.stroke();
        ctx.restore();
      }

      for (const bucket of buckets) {
        if (bucket.grow <= 0.001) continue;
        // 以 bucket.b * bucketMs 锚定画布右界 W，使正在生长的最新时间桶完整落在可视槽位 [W - 2*step, W - step] 内
        const xr = W - ((tNow - bucket.b * bucketMs) / bucketMs) * step;
        const x = xr - step;
        if (x + barW < 0) break;
        if (x > W) continue;
        const v = bucket.v;
        // 将生长系数 bucket.grow 乘在归一化高度 frac(v) 上，使 MEM（非零图底 lo）与 CPU/GPU 一样从画布底部平滑长起
        const hgt = Math.max(ratio * bucket.grow, frac(v) * bucket.grow * (H - ratio));
        if (hgt < 0.25 * ratio) continue;
        const pos = Math.min(1, Math.max(0, (x + barW) / W));
        ctx.globalAlpha = 0.1 + 0.62 * Math.pow(pos, 2);
        ctx.fillStyle = opts.peak && key !== 'memory' && v >= 90 ? danger : primary;
        ctx.fillRect(x, H - hgt, barW, hgt);
      }
      ctx.globalAlpha = 1;

      if (opts.peak && extraAlpha > 0.01) {
        ctx.save();
        ctx.globalAlpha = extraAlpha;
        // 峰值虚线按展开态目标量程定位，从右端 W 向左画到 W * 0.4 锁死虚线 dash 相位
        const { lo: pLo, max: pMax } = scaleOf(key, 1, top, bottom);
        const pCap = key === 'memory' ? 0.55 : 1;
        const pFrac = pCap * Math.min(1, Math.max(0, (peakMean - pLo) / (pMax - pLo)));
        const rawPy = H - pFrac * (H - ratio);
        const py = settled ? Math.round(rawPy) + 0.5 * ratio : rawPy;
        ctx.setLineDash([3 * ratio, 4 * ratio]);
        ctx.strokeStyle = themeColor(canvas, '--dsw-alias-label-tertiary');
        ctx.lineWidth = ratio;
        ctx.beginPath();
        ctx.moveTo(W, py);
        ctx.lineTo(W * 0.4, py);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = themeColor(canvas, '--dsw-alias-label-secondary');
        ctx.font = (10 * ratio) + 'px ' + themeColor(canvas, 'font');
        ctx.textAlign = 'right';
        const below = pFrac > 0.88;
        ctx.textBaseline = below ? 'top' : 'bottom';
        ctx.fillText(
          opts.peakText + ' ' + (key === 'memory' ? curPeakMean.toFixed(1) : curPeakMean.toFixed(0)) + METRICS[key].unit,
          W - 2 * ratio,
          py + (below ? 3 : -3) * ratio
        );
        ctx.restore();
      }
    }

    /**
     * 严格固定时钟读取器：只订阅 unifiedClock.subscribeTick，返回值在两次时钟脉冲之间完全锁存。
     */
    function useTextUpdate(render) {
      const [, setTick] = useState(0);
      const latchedRef = useRef(undefined);
      const renderRef = useRef(render);
      renderRef.current = render;
      if (latchedRef.current === undefined) {
        latchedRef.current = render(unifiedClock.sysFrame, unifiedClock.prevSysFrame);
      }
      useEffect(() => unifiedClock.subscribeTick((tickId) => {
        latchedRef.current = renderRef.current(unifiedClock.sysFrame, unifiedClock.prevSysFrame);
        setTick(tickId);
      }), []);
      return latchedRef.current;
    }

    function fmtValue(key, v) {
      return key === 'memory' ? v.toFixed(1) : v.toFixed(0);
    }

    /**
     * 柱状图画布：直接挂载到 unifiedClock.subscribeTween，与所有胶囊/卡片共用同一个 460ms 贝塞尔过渡窗口。
     */
    function Chart(props) {
      const ref = useRef(null);
      const latest = useRef(props);
      latest.current = props;
      useEffect(() => {
        const paint = () => {
          if (ref.current !== null) {
            const cur = latest.current;
            draw(ref.current, cur.metric, cur.windowMs, cur.opts);
          }
        };
        paint();
        return unifiedClock.subscribeTween(paint);
      }, []);
      return h('canvas', { ref, 'aria-hidden': true });
    }

    const DENSE_CELL_PX = 11;
    const DENSE_GAP_PX = 3;
    const PAD_X = 24;
    const DENSE_GRID_W = 20 * DENSE_CELL_PX + 19 * DENSE_GAP_PX; // 277px
    const POPUP_TARGET_W = DENSE_GRID_W + PAD_X * 2;             // 325px
    const SLOT_ORDER_KEY = 'dsh-system-monitor:slot-order-v2';
    const ALL_SLOTS = ['ctx', 'tokens', 'cpu', 'gpu', 'memory'];
    const SLOT_GAP = 4;

    function loadSlotOrder() {
      try {
        const raw = localStorage.getItem(SLOT_ORDER_KEY) || localStorage.getItem('dsh-system-monitor:slot-order-v1');
        if (!raw) return [...ALL_SLOTS];
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          const valid = parsed.filter((k) => ALL_SLOTS.includes(k));
          for (const k of ALL_SLOTS) {
            if (!valid.includes(k)) {
              const ctxIdx = valid.indexOf('ctx');
              if (k === 'tokens' && ctxIdx >= 0) valid.splice(ctxIdx + 1, 0, k);
              else valid.push(k);
            }
          }
          if (valid.length === ALL_SLOTS.length) return valid;
        }
      } catch {
        // 忽略存储异常
      }
      return [...ALL_SLOTS];
    }

    function saveSlotOrder(order) {
      try {
        localStorage.setItem(SLOT_ORDER_KEY, JSON.stringify(order));
      } catch {
        // 忽略存储异常
      }
    }

    /**
     * 全局卡片拦截状态：当有卡片处于打开状态时，点击任何外部区域（包括其他 pillow）
     * 一律在捕获阶段拦截 click 并只关闭当前卡片，绝不触发其他 pillow 打开。
     */
    const popupGuard = {
      activePopupEl: null,
      activeClose: null,
      suppressClickUntil: 0,
    };

    document.addEventListener('pointerdown', (event) => {
      if (!popupGuard.activeClose) return;
      const target = event.target;
      if (target instanceof Node && popupGuard.activePopupEl && popupGuard.activePopupEl.contains(target)) {
        return;
      }
      popupGuard.suppressClickUntil = performance.now() + 450;
      popupGuard.activeClose();
    }, true);

    document.addEventListener('click', (event) => {
      if (popupGuard.activeClose || performance.now() < popupGuard.suppressClickUntil) {
        const target = event.target;
        if (target instanceof Node && popupGuard.activePopupEl && popupGuard.activePopupEl.contains(target)) {
          return;
        }
        popupGuard.suppressClickUntil = 0;
        event.stopPropagation();
        event.preventDefault();
      }
    }, true);

    /**
     * 只测量无过渡的纯文字节点 textElRef 的真实像素宽度，加上终态常量宽度 extraWidth，
     * 避免子元素（如箭头）在 CSS transition 第 0 帧的旧宽度污染测量结果。
     */
    function useSmoothPillWidth(externalRefCb, extraWidth, deps) {
      const btnElRef = useRef(null);
      const textElRef = useRef(null);
      const initedRef = useRef(false);
      const lastWRef = useRef(0);

      const setBtnRef = (el) => {
        btnElRef.current = el;
        if (externalRefCb) externalRefCb(el);
      };

      useLayoutEffect(() => {
        const btn = btnElRef.current;
        const textEl = textElRef.current;
        if (!btn || !textEl) return;
        const textW = textEl.getBoundingClientRect().width;
        const targetW = Math.ceil(textW + extraWidth);
        if (targetW <= 0) return;
        if (!initedRef.current) {
          initedRef.current = true;
          lastWRef.current = targetW;
          const prevTrans = btn.style.transition;
          btn.style.transition = 'none';
          btn.style.width = targetW + 'px';
          void btn.offsetWidth;
          btn.style.transition = prevTrans;
          return;
        }
        if (Math.abs(targetW - lastWRef.current) >= 1) {
          lastWRef.current = targetW;
          btn.style.width = targetW + 'px';
        }
      }, deps);

      return { setBtnRef, textElRef };
    }

    const PILL_WINDOW_MS = 36000; // 胶囊柱状图窗口 36s（24 根柱，每根 1.5s，每秒仅缓慢平移 2px）

    function MetricButton(props) {
      const key = props.metric;
      const text = useTextUpdate((f) => (f === null ? '–' : fmtValue(key, METRICS[key].value(f))));
      return h('button', {
        ref: props.btnRef,
        className: 'sm-btn' + (props.hidden ? ' sm-btn-hidden' : ''),
        'data-metric': key,
        type: 'button',
        'aria-haspopup': 'dialog',
        'aria-expanded': props.hidden,
        onPointerDown: props.onPointerDown,
        onClick: props.onClick,
        'aria-label': props.label,
      },
        h(Chart, { metric: key, windowMs: PILL_WINDOW_MS, opts: { step: 3, bar: 2, cap: key === 'memory' ? 0.7 : 1 } }),
        h('span', { className: 'sm-btn-text' },
          h('span', { className: 'sm-btn-label' }, props.label),
          h('span', { className: 'sm-btn-value' }, text, h('span', { className: 'sm-btn-unit' }, METRICS[key].unit))
        )
      );
    }

    function computeTargetBox(origin, contentHeight) {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const margin = 12;
      const gap = 8;
      const width = Math.min(POPUP_TARGET_W, vw - margin * 2);
      const left = Math.max(margin, Math.min(origin.left, vw - width - margin));
      const maxAvailAbove = origin.top - gap - margin;
      const desiredH = Math.max(240, contentHeight || 340);
      let height;
      let top;
      if (maxAvailAbove >= 200) {
        height = Math.min(desiredH, maxAvailAbove);
        top = origin.top - gap - height;
      } else {
        const maxAvailBelow = vh - origin.bottom - gap - margin;
        height = Math.min(desiredH, Math.max(200, maxAvailBelow));
        top = Math.min(origin.bottom + gap, vh - height - margin);
      }
      return { left, top: Math.max(margin, top), width, height };
    }

    function useUnifiedMorph({ activeKey, getBtnEl, onClosed, onFrame, deps }) {
      const popupRef = useRef(null);
      const clipRef = useRef(null);
      const echoRef = useRef(null);
      const bodyRef = useRef(null);

      const animRef = useRef({
        mode: 'init',
        settled: false,
        startAt: 0,
        duration: 580,
        cur: null,
        from: null,
        to: null,
        openProg: 0,
        fromProg: 0,
        toProg: 1,
        bgProg: 0,
        fromBgProg: 0,
        toBgProg: 1,
      });

      const readOrigin = (k) => {
        const el = getBtnEl(k || activeKey);
        if (!el) return { left: 24, top: window.innerHeight - 60, bottom: window.innerHeight - 36, width: 72, height: 24, radius: 6 };
        const r = el.getBoundingClientRect();
        const radius = Number.parseFloat(getComputedStyle(el).borderTopLeftRadius) || 6;
        return { left: r.left, top: r.top, bottom: r.bottom, width: r.width, height: r.height, radius };
      };

      const makePillPose = (origin) => ({
        x: origin.left,
        y: origin.top,
        w: origin.width,
        h: origin.height,
        r: origin.radius || 6,
      });

      const makeOpenPose = (origin, contentH) => {
        const box = computeTargetBox(origin, contentH);
        return {
          x: box.left,
          y: box.top,
          w: box.width,
          h: box.height,
          r: 16,
        };
      };

      const applyPose = (pose, prog, bgProg) => {
        const pop = popupRef.current;
        const echo = echoRef.current;
        const body = bodyRef.current;
        if (!pop || !body) return;

        pop.style.transform = `translate3d(${pose.x.toFixed(2)}px, ${pose.y.toFixed(2)}px, 0)`;
        pop.style.width = `${pose.w.toFixed(2)}px`;
        pop.style.height = `${pose.h.toFixed(2)}px`;
        applyPopupSurface(pop, clipRef.current, pose.r, bgProg);

        const pillAlpha = Math.max(0, Math.min(1, 1 - prog / 0.28));
        if (echo) {
          echo.style.opacity = String(pillAlpha);
        }

        const contentAlpha = Math.max(0, Math.min(1, (prog - 0.14) / 0.72));
        const offsetY = (1 - prog) * 8;
        body.style.opacity = String(contentAlpha);
        body.style.transform = `translate3d(0, ${offsetY.toFixed(2)}px, 0)`;

        if (onFrame) onFrame(prog, contentAlpha);
      };

      useLayoutEffect(() => {
        const origin = readOrigin(activeKey);
        const bodyH = bodyRef.current ? bodyRef.current.offsetHeight : 340;
        const openPose = makeOpenPose(origin, bodyH);
        const pillPose = makePillPose(origin);
        const st = animRef.current;

        st.mode = 'open';
        st.settled = false;
        st.startAt = performance.now();
        st.duration = 580;
        st.from = pillPose;
        st.to = openPose;
        st.cur = pillPose;
        st.fromProg = 0;
        st.toProg = 1;
        st.openProg = 0;
        st.fromBgProg = 0;
        st.toBgProg = 1;
        st.bgProg = 0;
        applyPose(pillPose, 0, 0);
      }, [activeKey]);

      useLayoutEffect(() => {
        const st = animRef.current;
        if (st.mode === 'close' || !bodyRef.current || !st.to) return;
        const origin = readOrigin(activeKey);
        const nextOpen = makeOpenPose(origin, bodyRef.current.offsetHeight);
        if (Math.abs(nextOpen.h - st.to.h) > 1.5 || Math.abs(nextOpen.y - st.to.y) > 1.5) {
          if (st.mode === 'open' && st.openProg < 0.98) {
            st.to = nextOpen;
          } else {
            st.from = st.cur ? { ...st.cur } : st.to;
            st.to = nextOpen;
            st.fromProg = st.openProg;
            st.toProg = 1;
            st.fromBgProg = st.bgProg;
            st.toBgProg = 1;
            st.startAt = performance.now();
            st.duration = 360;
            st.mode = 'shift';
            st.settled = false;
          }
        }
      }, deps);

      const triggerClose = () => {
        const st = animRef.current;
        if (st.mode === 'close') return;
        const origin = readOrigin(activeKey);
        const pillPose = makePillPose(origin);
        st.mode = 'close';
        st.settled = false;
        st.startAt = performance.now();
        st.duration = 440;
        st.from = st.cur ? { ...st.cur } : pillPose;
        st.to = pillPose;
        st.fromProg = st.openProg;
        st.toProg = 0;
        st.fromBgProg = st.bgProg;
        st.toBgProg = 0;
      };

      useEffect(() => {
        popupGuard.activePopupEl = popupRef.current;
        popupGuard.activeClose = triggerClose;
        return () => {
          if (popupGuard.activeClose === triggerClose) {
            popupGuard.activePopupEl = null;
            popupGuard.activeClose = null;
          }
        };
      }, [activeKey]);

      useEffect(() => painter.add((now) => {
        const st = animRef.current;
        if (!st.cur || !st.from || !st.to || st.settled) return;
        const rawT = Math.min(1, Math.max(0, (now - st.startAt) / st.duration));
        let px;
        let py;
        let p;
        let pBg;
        if (st.mode === 'open') {
          px = BEZIER_OPEN_X(rawT);
          py = BEZIER_OPEN_Y(rawT);
          p = py;
          pBg = BEZIER_BG_OPEN(rawT);
        } else if (st.mode === 'close') {
          px = BEZIER_CLOSE_X(rawT);
          py = BEZIER_CLOSE_Y(rawT);
          p = py;
          pBg = BEZIER_BG_CLOSE(rawT);
        } else {
          px = BEZIER_SHIFT(rawT);
          py = px;
          p = px;
          pBg = BEZIER_BG_OPEN(rawT);
        }
        const prog = lerp(st.fromProg, st.toProg, p);
        const bgProg = lerp(st.fromBgProg, st.toBgProg, pBg);
        const pose = {
          x: lerp(st.from.x, st.to.x, px),
          y: lerp(st.from.y, st.to.y, py),
          w: lerp(st.from.w, st.to.w, px),
          h: lerp(st.from.h, st.to.h, py),
          r: lerp(st.from.r, st.to.r, p),
        };
        st.cur = pose;
        st.openProg = prog;
        st.bgProg = bgProg;
        applyPose(pose, prog, bgProg);

        if (rawT >= 1) {
          if (st.mode === 'close') {
            st.settled = true;
            onClosed();
          } else {
            st.settled = true;
          }
        }
      }), []);

      useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') triggerClose();
        };
        const onResize = () => {
          const st = animRef.current;
          if (st.mode === 'close' || !bodyRef.current) return;
          const origin = readOrigin(activeKey);
          const openPose = makeOpenPose(origin, bodyRef.current.offsetHeight);
          st.from = openPose;
          st.to = openPose;
          st.cur = openPose;
          st.openProg = 1;
          st.bgProg = 1;
          applyPose(openPose, 1, 1);
        };
        window.addEventListener('keydown', onKey);
        window.addEventListener('resize', onResize);
        return () => {
          window.removeEventListener('keydown', onKey);
          window.removeEventListener('resize', onResize);
        };
      }, [activeKey]);

      return { popupRef, clipRef, echoRef, bodyRef, triggerClose };
    }

    function Popup(props) {
      const key = props.metric;
      const t = props.t;
      const metric = METRICS[key];
      const [procs, setProcs] = useState(null);
      const echoCanvasRef = useRef(null);
      const mainCanvasRef = useRef(null);
      const keyRef = useRef(key);
      keyRef.current = key;
      const peakTextRef = useRef(t('peak'));
      peakTextRef.current = t('peak');

      const alphaRef = useRef(0);
      const paintMainChart = () => {
        const curKey = keyRef.current;
        if (mainCanvasRef.current && alphaRef.current > 0.001) {
          const fixedBucketMs = WINDOW_MS / (DENSE_GRID_W / 3);
          draw(mainCanvasRef.current, curKey, WINDOW_MS, {
            step: 3,
            bar: 2,
            fixedBucketMs,
            statWindowMs: WINDOW_MS,
            absMix: 1,
            cap: curKey === 'memory' ? 0.55 : 1,
            grid: true,
            peak: true,
            extraAlpha: alphaRef.current,
            peakText: peakTextRef.current,
          });
        }
      };

      const { popupRef, clipRef, echoRef, bodyRef, triggerClose } = useUnifiedMorph({
        activeKey: key,
        getBtnEl: props.getBtnEl,
        onClosed: props.onClosed,
        deps: [procs, key],
        onFrame: (prog, contentAlpha) => {
          alphaRef.current = contentAlpha;
          const curKey = keyRef.current;
          if (echoCanvasRef.current && prog < 0.3) {
            draw(echoCanvasRef.current, curKey, PILL_WINDOW_MS, {
              step: 3,
              bar: 2,
              cap: curKey === 'memory' ? 0.7 : 1,
            });
          }
          paintMainChart();
        },
      });

      useEffect(() => unifiedClock.subscribeTween(paintMainChart), []);

      useEffect(() => {
        let cancelled = false;
        const tick = async () => {
          try {
            const result = await props.connection.rpc.call('/system-monitor', 'processes', {});
            if (!cancelled && result.ok) setProcs(result.value);
          } catch {
            // 保持上一次的榜单。
          }
        };
        void tick();
        const unsub = unifiedClock.subscribeProc(tick);
        return () => {
          cancelled = true;
          unsub();
        };
      }, [props.connection]);

      const frame = useTextUpdate((f) => f);
      const list = procs === null ? [] : procs[metric.procList] ?? [];
      const valText = frame === null ? '–' : fmtValue(key, metric.value(frame));
      const detailVal = frame === null ? '' : metric.detail(frame, t, extent(key, WINDOW_MS));
      const isStackedDetail = Array.isArray(detailVal);
      const originW = key === 'memory' ? 84 : 72;

      const popupEl = h('div', {
        ref: popupRef,
        className: 'sm-popup',
        role: 'dialog',
        'aria-modal': false,
        'aria-label': t(key),
      },
        h('div', { ref: clipRef, className: 'sm-popup-clip' },
          h('div', { ref: echoRef, className: 'sm-pill-echo', style: { width: originW + 'px' }, 'aria-hidden': true },
            h('canvas', { ref: echoCanvasRef, style: { position: 'absolute', left: 0, right: 0, top: '3px', bottom: '3px', width: '100%', height: 'calc(100% - 6px)', display: 'block' } }),
            h('span', { className: 'sm-btn-text' },
              h('span', { className: 'sm-btn-label' }, t(key)),
              h('span', { className: 'sm-btn-value' }, valText, h('span', { className: 'sm-btn-unit' }, metric.unit))
            )
          ),
          h('div', { ref: bodyRef, className: 'sm-popup-body' },
            h('div', { className: 'sm-head-row' },
              h('span', { className: 'sm-title' }, t(key)),
              h('button', { className: 'sm-close', type: 'button', onClick: triggerClose, 'aria-label': t('close') }, '×')
            ),
            h('div', { className: 'sm-hero-row', 'data-stacked': isStackedDetail ? 'true' : 'false' },
              h('div', { className: 'sm-big' },
                h('span', { className: 'sm-big-num' }, valText),
                h('span', { className: 'sm-big-unit' }, metric.unit)
              ),
              isStackedDetail
                ? h('div', { className: 'sm-hero-sub-stack' },
                    h('span', { className: 'sm-hero-sub-primary' }, detailVal[0]),
                    h('span', { className: 'sm-hero-sub-secondary' }, detailVal[1])
                  )
                : h('span', { className: 'sm-hero-sub' }, detailVal)
            ),
            h('div', { className: 'sm-sys-chart-box' },
              h('canvas', { ref: mainCanvasRef, 'aria-hidden': true })
            ),
            h('div', { className: 'sm-axis' }, h('span', null, '-60s'), h('span', null, '-30s'), h('span', null, '0')),
            h('div', { className: 'sm-procs' },
              h('div', { className: 'sm-procs-title' }, t('process')),
              list.length > 0
                ? list.map((p, i) => h('div', { key: p.pid, className: 'sm-row' },
                    h('span', { className: 'sm-row-i' }, String(i + 1)),
                    h('span', { className: 'sm-row-n' }, p.name),
                    h('span', { className: 'sm-row-v' }, p[metric.procKey].toFixed(1) + '%')
                  ))
                : h('div', { className: 'sm-empty' }, t('noProcess'))
            )
          )
        )
      );

      return ReactDOM.createPortal(popupEl, document.body);
    }

    function LowBadge(props) {
      const low = useTextUpdate(() => store.low);
      return low ? h('span', { className: 'sm-low', title: props.t('lowHint') }, props.t('low')) : null;
    }

    function formatCacheHit(cacheRead, promptTotal) {
      if (!promptTotal || promptTotal <= 0) return null;
      if (cacheRead >= promptTotal) return '100';
      const pct = Math.round((cacheRead / promptTotal) * 100);
      return pct >= 100 ? '99.9' : String(pct);
    }

    function formatCompactTokens(v) {
      if (!Number.isFinite(v)) return '0';
      if (v < 1000) return String(v);
      const scale = (n) => (n >= 100 ? String(Math.round(n)) : String(Math.round(n * 10) / 10));
      if (v < 1e6) return scale(v / 1e3) + 'K';
      return scale(v / 1e6) + 'M';
    }

    function formatExactNum(v, sep) {
      const d = String(Math.round(v || 0));
      const out = [];
      for (let e = d.length; e > 0; e -= 3) out.unshift(d.slice(Math.max(0, e - 3), e));
      return out.join(sep || ',');
    }

    function buildBrickCells(ctxPct, breakdown, totalCells) {
      const pct = Math.max(0, Math.min(100, ctxPct || 0));
      const isCardGrid = totalCells === 100;
      const sysT = breakdown?.systemTokens || 0;
      const toolT = breakdown?.toolsTokens || 0;
      const msgT = breakdown?.messageTokens || 0;
      const sumT = sysT + toolT + msgT;

      const minCardFilled = isCardGrid
        ? Math.max(1, (sysT > 0 ? 1 : 0) + 1 + (msgT > 0 ? 1 : 0))
        : 0;
      const rawFilled = pct > 0 ? Math.max(1, Math.min(totalCells, Math.round((pct / 100) * totalCells))) : 0;
      const filled = isCardGrid ? Math.min(totalCells, Math.max(rawFilled, minCardFilled)) : rawFilled;

      const cells = new Array(totalCells).fill('sm-brick-cell');
      if (filled === 0) return cells;

      if (sumT <= 0) {
        for (let i = 0; i < filled; i += 1) {
          cells[i] = (isCardGrid && i === 0) ? 'sm-brick-cell sm-brick-tools' : 'sm-brick-cell sm-brick-used';
        }
        return cells;
      }

      const raw = [
        { cls: 'sm-brick-cell sm-brick-sys', val: (sysT / sumT) * filled },
        { cls: 'sm-brick-cell sm-brick-tools', val: (toolT / sumT) * filled },
        { cls: 'sm-brick-cell sm-brick-msg', val: (msgT / sumT) * filled },
      ];
      const counts = raw.map((r) => Math.floor(r.val));
      let rem = filled - (counts[0] + counts[1] + counts[2]);
      const order = raw
        .map((r, idx) => ({ idx, frac: r.val - counts[idx] }))
        .sort((a, b) => b.frac - a.frac);
      for (let k = 0; k < rem; k += 1) counts[order[k].idx] += 1;

      // Context 卡片 (20x5 = 100 格) 中至少保底分配 1 个工具定义颜色方格 (.sm-brick-tools)
      if (isCardGrid) {
        const ensureMinOne = (targetIdx) => {
          if (counts[targetIdx] >= 1) return;
          let donorIdx = -1;
          let maxCount = 1;
          for (let i = 0; i < 3; i += 1) {
            if (i !== targetIdx && counts[i] > maxCount) {
              maxCount = counts[i];
              donorIdx = i;
            }
          }
          if (donorIdx >= 0) {
            counts[donorIdx] -= 1;
            counts[targetIdx] = 1;
          }
        };
        ensureMinOne(1);
        if (sysT > 0) ensureMinOne(0);
        if (msgT > 0) ensureMinOne(2);
      }

      let cursor = 0;
      for (let g = 0; g < 3; g += 1) {
        for (let c = 0; c < counts[g] && cursor < filled; c += 1) {
          cells[cursor] = raw[g].cls;
          cursor += 1;
        }
      }
      return cells;
    }

    function ContextCachePopup(props) {
      const { ctxPct, usedCtx, winCtx, hasCtx, breakdown, tConv, coarseCells, denseCells, getBtnEl, onClosed } = props;

      const { popupRef, clipRef, echoRef, bodyRef, triggerClose } = useUnifiedMorph({
        activeKey: 'ctx',
        getBtnEl: () => getBtnEl(),
        onClosed,
        deps: [ctxPct, usedCtx],
      });

      const bdTotal = breakdown ? (breakdown.systemTokens + breakdown.toolsTokens + breakdown.messageTokens) : 0;
      const rows = hasCtx && breakdown && bdTotal > 0 ? [
        { key: 'sys', cls: 'sm-brick-sys', label: tConv('context.system'), tokens: breakdown.systemTokens, pct: Math.round((breakdown.systemTokens / winCtx) * 100) },
        { key: 'tools', cls: 'sm-brick-tools', label: tConv('context.tools'), tokens: breakdown.toolsTokens, pct: Math.round((breakdown.toolsTokens / winCtx) * 100) },
        { key: 'msg', cls: 'sm-brick-msg', label: tConv('context.messages'), tokens: breakdown.messageTokens, pct: Math.round((breakdown.messageTokens / winCtx) * 100) },
      ] : [];

      const popupEl = h('div', {
        ref: popupRef,
        className: 'sm-popup',
        role: 'dialog',
        'aria-modal': false,
        'aria-label': 'Context',
        onClick: (e) => e.stopPropagation(),
      },
        h('div', { ref: clipRef, className: 'sm-popup-clip' },
          h('div', { ref: echoRef, className: 'sm-pill-echo sm-pill-echo-ctx', 'aria-hidden': true },
            h('span', { className: 'sm-brick-grid' },
              coarseCells.map((cls, idx) => h('span', { key: idx, className: cls }))
            ),
            h('span', { className: 'sm-ctx-pct' },
              String(ctxPct),
              h('span', { className: 'sm-ctx-unit' }, '%')
            )
          ),
          h('div', { ref: bodyRef, className: 'sm-popup-body' },
            h('div', { className: 'sm-head-row' },
              h('span', { className: 'sm-title' }, 'Context'),
              h('button', { className: 'sm-close', type: 'button', onClick: triggerClose, 'aria-label': 'Close' }, '×')
            ),
            h('div', { className: 'sm-hero-row' },
              h('div', { className: 'sm-big' },
                h('span', { className: 'sm-big-num' }, String(ctxPct)),
                h('span', { className: 'sm-big-unit' }, '%')
              ),
              hasCtx ? h('span', { className: 'sm-hero-sub' }, `~${formatCompactTokens(usedCtx)} / ${formatCompactTokens(winCtx)}`) : null
            ),
            h('div', { className: 'sm-bricks-dense', 'aria-hidden': true },
              denseCells.map((cls, idx) => h('span', { key: idx, className: cls }))
            ),
            rows.length > 0 ? h('dl', { className: 'sm-merged-dl' },
              rows.map((r) => h(React.Fragment, { key: r.key },
                h('dt', null, h('span', { className: 'sm-merged-dot ' + r.cls }), r.label),
                h('dd', null,
                  '~' + formatCompactTokens(r.tokens),
                  h('span', { className: 'sm-merged-pct-sub' }, r.pct + '%')
                )
              ))
            ) : null,
            null
          )
        )
      );

      return ReactDOM.createPortal(popupEl, document.body);
    }

    /**
     * 把数字拆分为主数值与单位后缀：
     * - 当 live=true（正在上传或下载流式进行中）时：
     *   < 10,000 直接显示精确整数（如 842、3418），>= 10,000 显示两位小数 K（如 61.42K），使每几个 token 的实时增长都肉眼可见；
     * - 当 live=false（空闲已结算）时：使用简洁的 1 位小数 K/M。
     */
    function splitCompactTokens(v, live = false) {
      if (!Number.isFinite(v) || v <= 0) return { num: '0', unit: '' };
      const rounded = Math.round(v);
      if (live) {
        if (rounded < 10000) return { num: String(rounded), unit: '' };
        if (rounded < 1e6) return { num: (rounded / 1e3).toFixed(2), unit: 'K' };
        return { num: (rounded / 1e6).toFixed(2), unit: 'M' };
      }
      if (rounded < 1000) return { num: String(rounded), unit: '' };
      const scale = (n) => (n >= 100 ? String(Math.round(n)) : String(Math.round(n * 10) / 10));
      if (rounded < 1e6) return { num: scale(rounded / 1e3), unit: 'K' };
      return { num: scale(rounded / 1e6), unit: 'M' };
    }



    function estimateTextTokens(str) {
      if (typeof str !== 'string' || str.length === 0) return 0;
      let cjk = 0;
      for (let i = 0; i < str.length; i += 1) {
        const code = str.charCodeAt(i);
        if (code >= 0x2e80 && code <= 0x9fff) cjk += 1;
      }
      const other = str.length - cjk;
      return Math.max(1, Math.round(cjk * 0.6 + other * 0.28));
    }

    /**
     * 从 PartialArguments 或工具块中提取所有已到达的流式参数字符数（含 preparing 阶段原地追加的 args.chunks）。
     */
    function extractToolBlockStreamingTokens(block) {
      if (!block || typeof block !== 'object') return 0;
      let tok = 0;
      if (block.args && Array.isArray(block.args.chunks) && block.args.chunks.length > 0) {
        for (const ch of block.args.chunks) {
          if (typeof ch === 'string') tok += estimateTextTokens(ch);
        }
      } else if (typeof block.argsRaw === 'string' && block.argsRaw.length > 0) {
        tok += estimateTextTokens(block.argsRaw);
      }
      if (Array.isArray(block.subCalls)) {
        for (const sub of block.subCalls) {
          tok += extractToolBlockStreamingTokens(sub);
        }
      }
      return tok;
    }

    /**
     * 从块数组（text / reasoning / tool-call）中累加流式字符估算的 Token 数。
     */
    function sumBlocksTokens(blocks) {
      if (!Array.isArray(blocks)) return 0;
      let tok = 0;
      for (const b of blocks) {
        if (!b || typeof b !== 'object') continue;
        if (typeof b.text === 'string' && b.text.length > 0) tok += estimateTextTokens(b.text);
        if (typeof b.thinking === 'string' && b.thinking.length > 0) tok += estimateTextTokens(b.thinking);
        if (typeof b.content === 'string' && b.content.length > 0) tok += estimateTextTokens(b.content);
        tok += extractToolBlockStreamingTokens(b);
      }
      return tok;
    }

    /**
     * 计算当轮实时上传/下载 Token 与当前对话真实总 Token 数：
     *
     * 核心口径修正（彻底杜绝跨步重复累加历史上下文）：
     * 1) 在多步工具调用中，第 k 步发给模型的 prompt (P_k = input + cacheRead + cacheWrite) 包含了前一步结束时的全部历史 (P_{k-1} + O_{k-1})。
     *    因此第 k 步实际新增上传的 Token 数（用户新消息或工具返回结果）为：
     *      stepNetUp_k = max(0, P_k - (P_{k-1} + O_{k-1}))
     * 2) 当轮上传（turnUpload）：当轮内各步净新增上传 stepNetUp_k 之和（若第 1 步刚发起尚未结算，则取当轮用户消息估算值）。
     * 3) 当轮下载（turnDownload）：当轮内各步已结算输出 O_k 之和 + 当前正在流式下行的实时字符估算增量 liveDownDelta。
     * 4) 当前对话总计（sessionTotalTokens）：直接取当前对话实际占用的上下文总大小（优先取 contextPressure 的 usedCtx，或最新一步的 P_last + O_last + liveDownDelta），
     *    绝不使用把几百步历史 cacheRead 重复相加出来的 129M 计费累加值。
     */
    function extractCurrentTurnTokenStats(chatSnap, usedCtx) {
      let currentTurn = null;
      let streaming = false;
      let liveDownDelta = 0;

      const legacy = chatSnap?.legacy;
      const timeline = chatSnap?.timeline;

      if (legacy?.partial && typeof legacy.partial.turn === 'number') {
        currentTurn = legacy.partial.turn;
      } else if (Array.isArray(timeline?.turnOrder) && timeline.turnOrder.length > 0) {
        currentTurn = timeline.turnOrder[timeline.turnOrder.length - 1];
      } else if (Array.isArray(legacy?.nodes)) {
        for (let i = legacy.nodes.length - 1; i >= 0; i -= 1) {
          const n = legacy.nodes[i];
          if (n && typeof n.turn === 'number') {
            currentTurn = n.turn;
            break;
          }
        }
      }

      // 遍历已结算的 assistant 节点，按步计算净新增上传 stepNetUp 与输出 stepOut
      let prevStepTotal = 0;
      let turnNetUp = 0;
      let turnSettledOut = 0;
      let settledStepCount = 0;
      let latestPrompt = 0;
      let latestCacheRead = 0;
      let latestUncached = 0;
      let latestStepTotal = 0;
      const allSteps = [];
      const turnSteps = [];

      if (Array.isArray(legacy?.nodes)) {
        for (const node of legacy.nodes) {
          if (!node || node.kind !== 'assistant' || !node.usage) continue;
          const u = node.usage;
          const uIn = u.inputTokens || 0;
          const uRead = u.cacheReadTokens || 0;
          const uWrite = u.cacheWriteTokens || 0;
          const uOut = u.outputTokens || 0;
          const stepPrompt = uIn + uRead + uWrite;
          const stepUncached = uIn + uWrite;

          // 本步相对于上一步结束时的净新增上传 Token 数（若遇到压缩或首步，则用未缓存输入或差值）
          let stepNetUp;
          if (prevStepTotal === 0) {
            stepNetUp = stepUncached > 0 && uRead > 0 ? stepUncached : stepPrompt;
          } else if (stepPrompt >= prevStepTotal) {
            const delta = stepPrompt - prevStepTotal;
            stepNetUp = delta > 0 ? delta : Math.min(stepUncached, 2000);
          } else {
            stepNetUp = Math.min(stepUncached > 0 ? stepUncached : stepPrompt, 4000);
          }

          prevStepTotal = stepPrompt + uOut;
          latestPrompt = stepPrompt;
          latestCacheRead = uRead;
          latestUncached = stepUncached;
          latestStepTotal = prevStepTotal;

          if (stepNetUp > 0 || uOut > 0) {
            allSteps.push({ up: stepNetUp, down: uOut });
          }

          if (currentTurn !== null && node.turn === currentTurn) {
            turnNetUp += stepNetUp;
            turnSettledOut += uOut;
            settledStepCount += 1;
            if (stepNetUp > 0 || uOut > 0) {
              turnSteps.push({ up: stepNetUp, down: uOut });
            }
          }
        }
      }

      // 实时流式下行提取（覆盖全部 3 条路径：legacy.partial、timeline.turns.steps、chatSnap.nodes.byKey）
      if (legacy?.partial && Array.isArray(legacy.partial.blocks)) {
        streaming = true;
        liveDownDelta = Math.max(liveDownDelta, sumBlocksTokens(legacy.partial.blocks));
      }

      let turnOpen = false;
      let openStepWaitingFirstToken = false;
      if (currentTurn !== null && timeline?.turns && typeof timeline.turns.get === 'function') {
        const turnObj = timeline.turns.get(currentTurn);
        if (turnObj) {
          if (turnObj.end === undefined) turnOpen = true;
          const stepsList = Array.isArray(turnObj.steps)
            ? turnObj.steps
            : (turnObj.steps && typeof turnObj.steps.values === 'function' ? [...turnObj.steps.values()] : []);
          for (const st of stepsList) {
            if (!st) continue;
            const aData = st.data && typeof st.data.get === 'function' ? st.data.get('assistant-step') : undefined;
            if (aData && aData.status === 'running') {
              streaming = true;
              const stepTok = sumBlocksTokens(aData.blocks);
              if (stepTok > liveDownDelta) liveDownDelta = stepTok;
            }
            if (st.status === 'open' || st.end === undefined) {
              if (liveDownDelta === 0) openStepWaitingFirstToken = true;
            }
          }
        }
      }

      if (Array.isArray(legacy?.runningCalls) && legacy.runningCalls.length > 0) {
        for (const rc of legacy.runningCalls) {
          if (rc && rc.phase === 'preparing') {
            streaming = true;
            liveDownDelta += extractToolBlockStreamingTokens(rc);
          }
        }
      }
      const nodeMap = chatSnap?.nodes?.byKey;
      if (nodeMap && typeof nodeMap.values === 'function') {
        let preparingSum = 0;
        for (const node of nodeMap.values()) {
          if (!node) continue;
          if (node.kind === 'assistant-step' && node.data?.status === 'running' && (currentTurn === null || node.data.turn === currentTurn)) {
            streaming = true;
            const aTok = sumBlocksTokens(node.data.blocks);
            if (aTok > liveDownDelta) liveDownDelta = aTok;
          } else if (node.kind === 'tool-call' && node.data?.root?.phase === 'preparing' && (currentTurn === null || node.data.root.turn === currentTurn)) {
            streaming = true;
            preparingSum += extractToolBlockStreamingTokens(node.data.root);
          }
        }
        if (preparingSum > liveDownDelta) liveDownDelta = preparingSum;
      }

      // 估算当轮用户输入的文本 Token 数，用于当轮第 1 步刚发起尚未结算时的上传显示
      let userTurnInputEst = 0;
      if (currentTurn !== null && Array.isArray(legacy?.nodes)) {
        for (let i = legacy.nodes.length - 1; i >= 0; i -= 1) {
          const n = legacy.nodes[i];
          if (!n) continue;
          if (n.turn !== undefined && n.turn !== currentTurn) continue;
          if (typeof n.text === 'string' && n.text.length > 0) {
            userTurnInputEst += estimateTextTokens(n.text);
          }
        }
      }

      const isRunning = streaming || turnOpen;
      const pendingStepUpEst = Math.max(userTurnInputEst, 180);
      const uploadingNow = isRunning && liveDownDelta === 0 && (openStepWaitingFirstToken || settledStepCount === 0);
      const targetTurnUp = turnNetUp > 0
        ? (uploadingNow ? turnNetUp + pendingStepUpEst : turnNetUp)
        : (isRunning ? pendingStepUpEst : 0);
      const targetTurnDown = turnSettledOut + liveDownDelta;

      const direction = (liveDownDelta > 0 || (targetTurnDown > 0 && !uploadingNow)) ? 'down' : 'up';

      let chartSteps = turnSteps.length > 0 ? [...turnSteps] : [...allSteps];
      if (isRunning && (liveDownDelta > 0 || uploadingNow)) {
        chartSteps.push({ up: pendingStepUpEst, down: liveDownDelta });
      }

      // 当前对话真实总 Token 数：优先取 contextPressure 的 usedCtx（加上当前正在流式尚未结算的增量），否则取最新一步的上下文总量
      const baseSessionTotal = (Number.isFinite(usedCtx) && usedCtx > 0) ? usedCtx : latestStepTotal;
      const sessionTotalTokens = Math.max(baseSessionTotal + liveDownDelta, targetTurnUp + targetTurnDown);
      const cacheHitPct = latestPrompt > 0 && latestCacheRead > 0
        ? formatCacheHit(latestCacheRead, latestPrompt)
        : null;

      return {
        currentTurn,
        settledStepCount,
        direction,
        isRunning,
        settledTurnUp: turnNetUp,
        uploadTokens: targetTurnUp,
        downloadTokens: targetTurnDown,
        sessionTotalTokens,
        latestPrompt,
        latestCacheRead,
        latestUncached,
        cacheHitPct,
        streaming: isRunning,
        recentSteps: chartSteps.slice(-16),
      };
    }

    /**
     * 零 DOM 渲染的数据桥：隔离 useChat 与 useProjection 的高频不规则事件推送，
     * 只把最新快照写入 liveBridge 引用，绝不直接触发任何胶囊或大卡片重渲染。
     */
    const liveBridge = {
      usage: undefined,
      pressure: undefined,
      breakdown: undefined,
      chatSnap: undefined,
      primed: false,
    };

    function LiveDataSink(props) {
      const { useProjection, useChat } = props;
      const usage = typeof useProjection === 'function' ? useProjection('tokenUsage') : undefined;
      const pressure = typeof useProjection === 'function' ? useProjection('contextPressure') : undefined;
      const breakdown = typeof useProjection === 'function' ? useProjection('contextBreakdown') : undefined;
      const chatSnap = typeof useChat === 'function' ? useChat((s) => s) : undefined;

      liveBridge.usage = usage;
      liveBridge.pressure = pressure;
      liveBridge.breakdown = breakdown;
      liveBridge.chatSnap = chatSnap;

      useEffect(() => {
        if (!liveBridge.primed && (usage !== undefined || pressure !== undefined || chatSnap !== undefined)) {
          liveBridge.primed = true;
          unifiedClock.primeSessionView();
        }
      }, [usage, pressure, chatSnap]);

      return null;
    }

    function computeClockedSessionView() {
      const { usage, pressure, breakdown, chatSnap } = liveBridge;
      const promptTokens = usage ? (usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens) : 0;
      const settledOutputTokens = usage ? (usage.outputTokens || 0) : 0;
      const totalTokens = promptTokens + settledOutputTokens;
      const hasUsage = totalTokens > 0;

      const usedCtx = pressure?.projectedTokens ?? pressure?.pressureTokens;
      const winCtx = pressure?.contextWindow;
      const hasCtx = usedCtx !== undefined && winCtx !== undefined && winCtx > 0;
      const ctxPct = hasCtx ? Math.min(100, Math.round((usedCtx / winCtx) * 100)) : 0;

      const tokStats = extractCurrentTurnTokenStats(chatSnap, usedCtx);
      return {
        usage,
        pressure,
        breakdown,
        hasUsage,
        usedCtx: usedCtx || 0,
        winCtx: winCtx || 0,
        hasCtx,
        ctxPct,
        ...tokStats,
      };
    }

    /**
     * 严格只订阅全局唯一的 unifiedClock.subscribeTick，返回当前时钟周期的目标快照 cur 与上一周期起点快照 prev。
     */
    function useUnifiedClockSessionView() {
      const [, setTick] = useState(0);
      if (unifiedClock.sessionView === null) {
        const init = computeClockedSessionView();
        unifiedClock.prevSessionView = init;
        unifiedClock.sessionView = init;
      }
      useEffect(() => unifiedClock.subscribeTick((tickId) => {
        setTick(tickId);
      }), []);
      return {
        cur: unifiedClock.sessionView,
        prev: unifiedClock.prevSessionView || unifiedClock.sessionView,
      };
    }

    function RotatingArrow(props) {
      return h('span', {
        className: 'sm-tok-arrow-wrap',
        'data-idle': props.idle ? 'true' : 'false',
        'aria-hidden': true,
      },
        h('svg', {
          viewBox: '0 0 12 12',
          className: 'sm-tok-arrow-svg',
          'data-dir': props.direction,
        },
          h('path', {
            d: 'M6 9.75V2.25M6 2.25L2.75 5.5M6 2.25L9.25 5.5',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: '1.5',
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          })
        )
      );
    }

    /**
     * Token 上传/下载实时详情浮窗：
     * 所有数字均采用去重后的真实单轮净增量与当前对话实际总 Token 数，并在整个 1000ms 时钟周期内平滑滚动更新。
     */
    function TokenTrafficPopup(props) {
      const {
        direction,
        uploadTokens,
        downloadTokens,
        sessionTotalTokens,
        latestCacheRead,
        cacheHit,
        recentSteps,
        streaming,
        t,
        tChat,
        getBtnEl,
        onClosed,
      } = props;

      const { popupRef, clipRef, echoRef, bodyRef, triggerClose } = useUnifiedMorph({
        activeKey: 'tokens',
        getBtnEl: () => getBtnEl(),
        onClosed,
        deps: [uploadTokens, downloadTokens, sessionTotalTokens, streaming, recentSteps.length],
      });

      const sepChar = tChat('number.groupSeparator') === 'number.groupSeparator' ? ',' : tChat('number.groupSeparator');
      const upParts = splitCompactTokens(uploadTokens, streaming);
      const downParts = splitCompactTokens(downloadTokens, streaming);
      const totalParts = splitCompactTokens(sessionTotalTokens, false);
      const activeParts = streaming ? (direction === 'down' ? downParts : upParts) : totalParts;
      const turnSum = uploadTokens + downloadTokens;
      const upPct = turnSum > 0 ? Math.max(4, Math.min(96, Math.round((uploadTokens / turnSum) * 100))) : 50;
      const downPct = 100 - upPct;

      let maxStepUp = 1;
      let maxStepDown = 1;
      for (const st of recentSteps) {
        if (st.up > maxStepUp) maxStepUp = st.up;
        if (st.down > maxStepDown) maxStepDown = st.down;
      }
      const paddedSteps = new Array(16).fill(null);
      const offset = Math.max(0, 16 - recentSteps.length);
      for (let i = 0; i < recentSteps.length && offset + i < 16; i += 1) {
        paddedSteps[offset + i] = recentSteps[i];
      }

      const popupEl = h('div', {
        ref: popupRef,
        className: 'sm-popup',
        role: 'dialog',
        'aria-modal': false,
        'aria-label': 'Tokens',
        onClick: (e) => e.stopPropagation(),
      },
        h('div', { ref: clipRef, className: 'sm-popup-clip' },
          h('div', { ref: echoRef, className: 'sm-pill-echo sm-pill-echo-tok', 'aria-hidden': true },
            h(RotatingArrow, { direction, idle: !streaming }),
            h('span', { className: 'sm-tok-reading' },
              h('span', { className: 'sm-tok-num' }, activeParts.num),
              activeParts.unit ? h('span', { className: 'sm-tok-unit' }, activeParts.unit) : null
            )
          ),
          h('div', { ref: bodyRef, className: 'sm-popup-body' },
            h('div', { className: 'sm-head-row' },
              h('span', { className: 'sm-title' }, 'Tokens'),
              h('button', { className: 'sm-close', type: 'button', onClick: triggerClose, 'aria-label': t('close') }, '×')
            ),
            h('div', { className: 'sm-hero-row' },
              h('div', { className: 'sm-big', style: { display: 'inline-flex', alignItems: 'baseline', gap: streaming ? '6px' : '0px' } },
                h('span', { style: { display: 'inline-flex', alignSelf: 'center' } },
                  h(RotatingArrow, { direction, idle: !streaming })
                ),
                h('span', { className: 'sm-big-num' }, activeParts.num),
                activeParts.unit ? h('span', { className: 'sm-big-unit' }, activeParts.unit) : null
              ),
              h('span', { className: 'sm-hero-sub' },
                `↑ ${upParts.num}${upParts.unit} · ↓ ${downParts.num}${downParts.unit}`
              )
            ),
            h('div', { className: 'sm-tok-ratio-bar', 'aria-hidden': true },
              h('div', { className: 'sm-tok-ratio-up', style: { width: upPct + '%' } }),
              h('div', { className: 'sm-tok-ratio-down', style: { width: downPct + '%' } })
            ),
            h('div', { className: 'sm-tok-steps-bars', 'aria-hidden': true },
              paddedSteps.map((st, idx) => {
                if (!st) {
                  return h('div', { key: idx, className: 'sm-tok-step-col' },
                    h('span', { className: 'sm-tok-step-empty' })
                  );
                }
                const upH = Math.max(4, Math.round((st.up / maxStepUp) * 28));
                const downH = Math.max(4, Math.round((st.down / maxStepDown) * 24));
                return h('div', { key: idx, className: 'sm-tok-step-col' },
                  h('span', { className: 'sm-tok-step-up', style: { height: upH + 'px' } }),
                  h('span', { className: 'sm-tok-step-down', style: { height: downH + 'px' } })
                );
              })
            ),
            h('dl', { className: 'sm-token-dl' },
              h('dt', null, '↑ ' + t('upload')),
              h('dd', { className: 'sm-token-strong' }, formatExactNum(uploadTokens, sepChar)),
              h('dt', null, '↓ ' + t('download')),
              h('dd', { className: 'sm-token-strong' }, formatExactNum(downloadTokens, sepChar)),
              latestCacheRead > 0 ? h(React.Fragment, null,
                h('dt', null, tChat('message.turnUsage.cacheRead') + (cacheHit !== null ? ` (${cacheHit}%)` : '')),
                h('dd', null, formatExactNum(latestCacheRead, sepChar))
              ) : null,
              h('dt', null, t('total')),
              h('dd', { className: 'sm-token-strong' }, tChat('message.turnUsage.count', { count: formatExactNum(sessionTotalTokens, sepChar) }))
            )
          )
        )
      );

      return ReactDOM.createPortal(popupEl, document.body);
    }

    /**
     * 统一承载 5 个胶囊（ctx, tokens, cpu, gpu, memory）的网格槽位容器：
     * - 支持按住拖动任意胶囊；
     * - 拖放过程中其余槽位上的胶囊自动平滑避让；
     * - 松手后按网格槽位自动吸附落位并持久化顺序。
     */
    function CtxPillButton(props) {
      const { setBtnRef, textElRef } = useSmoothPillWidth(props.btnRef, 41, [props.ctxPct]);
      return h('button', {
        ref: setBtnRef,
        type: 'button',
        className: 'sm-ctx-pill' + (props.hidden ? ' sm-ctx-pill-hidden' : ''),
        'aria-haspopup': 'dialog',
        'aria-expanded': props.hidden,
        onPointerDown: props.onPointerDown,
        onClick: props.onClick,
      },
        h('span', { className: 'sm-pill-inner', style: { gap: '6px', padding: '0 7px' } },
          h('span', { className: 'sm-brick-grid', 'aria-hidden': true },
            props.coarseCells.map((cls, idx) => h('span', { key: idx, className: cls }))
          ),
          h('span', { ref: textElRef, className: 'sm-ctx-pct' },
            String(props.ctxPct),
            h('span', { className: 'sm-ctx-unit' }, '%')
          )
        )
      );
    }

    function TokPillButton(props) {
      const extraW = props.idle ? 16 : 31.5;
      const { setBtnRef, textElRef } = useSmoothPillWidth(props.btnRef, extraW, [props.num, props.unit, props.idle]);
      return h('button', {
        ref: setBtnRef,
        type: 'button',
        className: 'sm-tok-pill' + (props.hidden ? ' sm-tok-pill-hidden' : ''),
        'aria-haspopup': 'dialog',
        'aria-expanded': props.hidden,
        onPointerDown: props.onPointerDown,
        onClick: props.onClick,
      },
        h('span', { className: 'sm-pill-inner', style: { padding: '0 8px' } },
          h(RotatingArrow, { direction: props.direction, idle: props.idle }),
          h('span', { ref: textElRef, className: 'sm-tok-reading' },
            h('span', { className: 'sm-tok-num' }, props.num),
            props.unit ? h('span', { className: 'sm-tok-unit' }, props.unit) : null
          )
        )
      );
    }

    function DockEntry(props) {
      const t = props.t;
      const tChat = props.tChat;
      const tConv = props.tConv;

      // 所有状态刷新严格且唯一由 unifiedClock (1000ms) 触发，数字每秒只更新一次，绝不快速跳字
      const { cur: curView } = useUnifiedClockSessionView();
      const {
        hasUsage,
        usedCtx,
        winCtx,
        hasCtx,
        ctxPct,
        breakdown,
        direction: tokDirection,
        uploadTokens: liveUploadTokens,
        downloadTokens: liveDownloadTokens,
        sessionTotalTokens,
        latestCacheRead,
        cacheHitPct,
        streaming,
        recentSteps,
      } = curView;

      const pillTokenValue = streaming
        ? (tokDirection === 'down' ? liveDownloadTokens : liveUploadTokens)
        : sessionTotalTokens;
      const activeTokParts = splitCompactTokens(pillTokenValue, streaming);

      const showCtxPill = hasCtx || hasUsage;
      const showTokPill = liveUploadTokens > 0 || liveDownloadTokens > 0 || streaming || hasUsage || hasCtx;

      const coarseCells = buildBrickCells(ctxPct, breakdown, 15);
      const denseCells = buildBrickCells(ctxPct, breakdown, 100);

      const [order, setOrder] = useState(loadSlotOrder);
      const [open, setOpen] = useState(null);
      const btnRefs = useRef({});
      const suppressClickRef = useRef(false);
      const snapTimerRef = useRef(0);

      useEffect(() => hub.retain(props.connection), [props.connection]);
      useEffect(() => () => clearTimeout(snapTimerRef.current), []);

      const getBtnEl = (k) => btnRefs.current[k] || null;
      const visibleOrder = order.filter((k) => {
        if (k === 'ctx') return showCtxPill;
        if (k === 'tokens') return showTokPill;
        return true;
      });

      const startSlotDrag = (dragKey, downEvent) => {
        if (downEvent.button !== 0) return;
        if (popupGuard.activeClose) return;
        const dragEl = btnRefs.current[dragKey];
        if (!dragEl) return;

        clearTimeout(snapTimerRef.current);
        for (const k of visibleOrder) {
          const el = btnRefs.current[k];
          if (el) {
            el.removeAttribute('data-dragging');
            el.removeAttribute('data-dodging');
            el.removeAttribute('data-snapping');
            el.style.transform = '';
          }
        }

        const startX = downEvent.clientX;
        const startY = downEvent.clientY;
        const baseRects = {};
        const widths = {};
        for (const k of visibleOrder) {
          const el = btnRefs.current[k];
          if (!el) return;
          const r = el.getBoundingClientRect();
          baseRects[k] = r;
          widths[k] = r.width;
        }
        const rowLeft = baseRects[visibleOrder[0]].left;
        let previewOrder = [...visibleOrder];
        let dragging = false;

        const computeSlotLefts = (ord) => {
          const map = {};
          let cursor = rowLeft;
          for (const k of ord) {
            map[k] = cursor;
            cursor += widths[k] + SLOT_GAP;
          }
          return map;
        };

        const onMove = (moveEvent) => {
          const dx = moveEvent.clientX - startX;
          const dy = moveEvent.clientY - startY;
          if (!dragging) {
            if (Math.hypot(dx, dy) < 4) return;
            dragging = true;
            suppressClickRef.current = true;
            dragEl.setAttribute('data-dragging', 'true');
            for (const k of visibleOrder) {
              if (k !== dragKey && btnRefs.current[k]) {
                btnRefs.current[k].setAttribute('data-dodging', 'true');
              }
            }
          }

          const clampedDy = Math.max(-28, Math.min(28, dy * 0.55));
          dragEl.style.transform = `translate3d(${dx.toFixed(1)}px, ${clampedDy.toFixed(1)}px, 0)`;

          const dragCenterX = baseRects[dragKey].left + dx + widths[dragKey] * 0.5;
          const others = previewOrder.filter((k) => k !== dragKey);
          let insertIdx = 0;
          let accX = rowLeft;
          for (let i = 0; i < others.length; i += 1) {
            const ok = others[i];
            const mid = accX + widths[ok] * 0.5;
            if (dragCenterX > mid) {
              insertIdx = i + 1;
              accX += widths[ok] + SLOT_GAP;
            } else {
              break;
            }
          }
          const nextOrder = [...others];
          nextOrder.splice(insertIdx, 0, dragKey);
          previewOrder = nextOrder;

          const slotLefts = computeSlotLefts(previewOrder);
          for (const k of others) {
            const el = btnRefs.current[k];
            if (el) {
              const shiftX = slotLefts[k] - baseRects[k].left;
              el.style.transform = shiftX ? `translate3d(${shiftX.toFixed(1)}px, 0, 0)` : '';
            }
          }
        };

        const onUp = () => {
          window.removeEventListener('pointermove', onMove, true);
          window.removeEventListener('pointerup', onUp, true);
          window.removeEventListener('pointercancel', onUp, true);
          if (!dragging) return;

          const slotLefts = computeSlotLefts(previewOrder);
          const snapX = slotLefts[dragKey] - baseRects[dragKey].left;
          dragEl.removeAttribute('data-dragging');
          dragEl.setAttribute('data-snapping', 'true');
          dragEl.style.transform = `translate3d(${snapX.toFixed(1)}px, 0, 0)`;

          const finalOrder = [...previewOrder];
          for (const k of ALL_SLOTS) {
            if (!finalOrder.includes(k)) finalOrder.unshift(k);
          }

          snapTimerRef.current = setTimeout(() => {
            for (const k of visibleOrder) {
              const el = btnRefs.current[k];
              if (el) {
                el.removeAttribute('data-dodging');
                el.removeAttribute('data-snapping');
                el.style.transform = '';
              }
            }
            setOrder(finalOrder);
            saveSlotOrder(finalOrder);
          }, 300);
        };

        window.addEventListener('pointermove', onMove, true);
        window.addEventListener('pointerup', onUp, true);
        window.addEventListener('pointercancel', onUp, true);
      };

      const handlePillClick = (key, event) => {
        if (suppressClickRef.current) {
          suppressClickRef.current = false;
          event.stopPropagation();
          event.preventDefault();
          return;
        }
        if (popupGuard.activeClose) {
          event.stopPropagation();
          event.preventDefault();
          return;
        }
        setOpen(key);
      };

      return h('div', { className: 'sm-dock' },
        h('style', null, STYLES),
        h(LiveDataSink, { useProjection: props.useProjection, useChat: props.useChat }),
        visibleOrder.map((key) => {
          if (key === 'ctx') {
            return h(CtxPillButton, {
              key: 'ctx',
              ctxPct,
              coarseCells,
              hidden: open === 'ctx',
              btnRef: (el) => { btnRefs.current.ctx = el; },
              onPointerDown: (e) => startSlotDrag('ctx', e),
              onClick: (e) => handlePillClick('ctx', e),
            });
          }
          if (key === 'tokens') {
            return h(TokPillButton, {
              key: 'tokens',
              direction: tokDirection,
              idle: !streaming,
              num: activeTokParts.num,
              unit: activeTokParts.unit,
              hidden: open === 'tokens',
              btnRef: (el) => { btnRefs.current.tokens = el; },
              onPointerDown: (e) => startSlotDrag('tokens', e),
              onClick: (e) => handlePillClick('tokens', e),
            });
          }
          return h(MetricButton, {
            key,
            metric: key,
            label: t(key),
            hidden: open === key,
            btnRef: (el) => { btnRefs.current[key] = el; },
            onPointerDown: (e) => startSlotDrag(key, e),
            onClick: (e) => handlePillClick(key, e),
          });
        }),
        h(LowBadge, { t }),
        open === 'ctx' ? h(ContextCachePopup, {
          ctxPct,
          usedCtx,
          winCtx,
          hasCtx,
          breakdown,
          tConv,
          coarseCells,
          denseCells,
          getBtnEl: () => btnRefs.current.ctx,
          onClosed: () => setOpen(null),
        }) : null,
        open === 'tokens' ? h(TokenTrafficPopup, {
          direction: tokDirection,
          uploadTokens: liveUploadTokens,
          downloadTokens: liveDownloadTokens,
          sessionTotalTokens,
          latestCacheRead,
          cacheHit: cacheHitPct,
          recentSteps,
          streaming,
          t,
          tChat,
          getBtnEl: () => btnRefs.current.tokens,
          onClosed: () => setOpen(null),
        }) : null,
        open !== null && open !== 'ctx' && open !== 'tokens' ? h(Popup, {
          metric: open,
          connection: props.connection,
          t,
          getBtnEl,
          onClosed: () => setOpen(null),
        }) : null
      );
    }

    return {
      inject: ['slots', 'locale', 'connection'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'system-monitor: 词典');
        ctx.effect(() => {
          const saved = new Map();
          let patching = false;
          const patch = () => {
            if (patching) return;
            const chatLocales = ctx.locale.dicts?.get('chat');
            if (!chatLocales) return;
            let changed = false;
            for (const [loc, entries] of chatLocales.entries()) {
              if (entries && typeof entries['stats.cacheHit'] === 'string' && entries['stats.cacheHit'] !== '{percent}%') {
                if (!saved.has(loc)) saved.set(loc, entries['stats.cacheHit']);
                entries['stats.cacheHit'] = '{percent}%';
                changed = true;
              }
            }
            if (changed && typeof ctx.locale.publish === 'function') {
              patching = true;
              try {
                ctx.locale.publish(ctx.locale.getLocale().active, false);
              } finally {
                patching = false;
              }
            }
          };
          patch();
          const unsub = typeof ctx.locale.subscribe === 'function' ? ctx.locale.subscribe(patch) : () => {};
          return () => {
            unsub();
            const chatLocales = ctx.locale.dicts?.get('chat');
            if (!chatLocales) return;
            let restored = false;
            for (const [loc, orig] of saved.entries()) {
              const entries = chatLocales.get(loc);
              if (entries) {
                entries['stats.cacheHit'] = orig;
                restored = true;
              }
            }
            if (restored && typeof ctx.locale.publish === 'function') {
              ctx.locale.publish(ctx.locale.getLocale().active, false);
            }
          };
        }, 'system-monitor: 精简缓存命中文字');
        const t = ctx.locale.bind(NS);
        const tChat = ctx.locale.bind('chat');
        const tConv = ctx.locale.bind('conversation');
        ctx.slots.inject('conversation.composer.dock', function* () {
          yield ctx.slots.register({
            name: 'conversation.composer.dock',
            id: 'activity',
            priority: -1,
            order: 0,
          }, () => null);
          yield ctx.slots.register({
            name: 'conversation.composer.dock',
            id: 'usage',
            priority: -1,
            order: 1,
          }, () => null);
          yield ctx.slots.register({
            name: 'conversation.composer.dock',
            id: 'system-monitor',
            order: 10,
            locale: NS,
            inject: () => ({ connection: ctx.connection, t, tChat, tConv }),
          }, DockEntry);
        });
      },
    };
  },
});
