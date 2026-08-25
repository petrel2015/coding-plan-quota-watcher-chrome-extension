<template>
  <div>
    <div v-for="(win, i) in windows" :key="i" class="window">
      <div class="window-header">
        <span class="window-label">{{ win.label }}</span>
        <span class="window-used">{{ (win.usedPct || 0).toFixed(1) }}%</span>
      </div>
      <div class="progress-bar" :title="win.capText || ''">
        <div class="progress-fill" :class="barClass(win.usedPct)" :style="{ width: Math.min(win.usedPct || 0, 100) + '%' }"></div>
        <!-- 幽灵上限：[capPct, 100%] 为被其他窗口锁死的“虚血量” -->
        <div
          v-if="hasCap(win)"
          class="cap-ghost"
          :style="{ left: Math.min(win.capPct, 100) + '%' }"
        ></div>
      </div>
      <div v-if="win.detail" class="window-detail">{{ win.detail }}</div>
      <div v-if="win.capText" class="window-capnote">{{ win.capText }}</div>
      <div v-if="forecast(win)" class="window-forecast" :class="'forecast-' + forecast(win).level">
        {{ forecast(win).text }}
      </div>
      <div class="window-footer">
        <span class="reset-time" :class="{ 'reset-done': isReset(win) }">{{ resetText(win) }}</span>
      </div>
    </div>
  </div>
</template>

<script>
// 窗口列表：一张卡片的全部额度窗口（进度条 + 明细 + 预测 + 重置倒计时）。
// 从 SourceCard 抽出，正常态与「刷新失败展示上次数据」态共用同一份渲染；
// 含跨窗口幽灵上限（capPct/capText，见 shared/render.js applyWindowCaps）。
import { computeForecast } from "../shared/render.js";
import { formatCountdown } from "../shared/format.js";
import { t } from "../shared/i18n.js";

export default {
  name: "WindowList",
  props: {
    windows: { type: Array, default: () => [] },
    now: { type: Number, default: () => Date.now() }, // 用于倒计时刷新
  },
  methods: {
    t,
    barClass(pct) {
      pct = pct || 0;
      if (pct >= 90) return "bar-danger";
      if (pct >= 70) return "bar-warn";
      return "bar-ok";
    },
    hasCap(win) {
      return win.capPct != null && win.capPct < 100;
    },
    forecast(win) {
      return computeForecast(win);
    },
    isReset(win) {
      return win.resetMs - this.now <= 0;
    },
    resetText(win) {
      if (!win.resetMs) return "\u00a0";
      const resetInMs = win.resetMs - this.now;
      if (resetInMs <= 0) return t("card.reset");
      return t("card.countdown", { time: formatCountdown(resetInMs) });
    },
  },
};
</script>

<style scoped>
.window {
  margin-bottom: 14px;
}
.window:last-child {
  margin-bottom: 0;
}
.window-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 6px;
}
.window-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--color-text-secondary);
}
.window-used {
  font-size: 13px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.01em;
}
.progress-bar {
  position: relative;
  height: 6px;
  background: var(--progress-track);
  border-radius: var(--radius-pill);
  overflow: hidden;
  margin-bottom: 6px;
}
.progress-fill {
  height: 100%;
  border-radius: var(--radius-pill);
}
.bar-ok { background: var(--color-ok); }
.bar-warn { background: var(--color-warn); }
.bar-danger { background: var(--color-danger); }
.cap-ghost {
  position: absolute;
  top: 0;
  bottom: 0;
  right: 0;
  background: repeating-linear-gradient(135deg, var(--cap-hatch) 0 2px, transparent 2px 5px);
  border-left: 2px dashed var(--cap-line);
  border-radius: 0 var(--radius-pill) var(--radius-pill) 0;
}
.window-detail {
  font-size: 11px;
  color: var(--color-text-faint);
  font-variant-numeric: tabular-nums;
  margin-bottom: 4px;
}
.window-capnote {
  font-size: 11px;
  color: var(--color-warn);
  font-variant-numeric: tabular-nums;
  margin-bottom: 4px;
}
.window-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 11.5px;
  color: var(--color-text-tertiary);
}
.reset-time {
  font-variant-numeric: tabular-nums;
}
.reset-done {
  color: var(--color-ok);
}
.window-forecast {
  font-size: 11px;
  margin-bottom: 5px;
  padding: 4px 8px 4px 10px;
  border-radius: var(--radius-btn);
  font-variant-numeric: tabular-nums;
  border: 1px solid;
  border-left-width: 2px;
}
.forecast-ok {
  color: var(--color-ok);
  background: var(--color-ok-bg);
  border-color: var(--color-ok-border);
}
.forecast-warn {
  color: var(--color-danger);
  background: var(--color-danger-bg);
  border-color: var(--color-danger-border);
}
</style>
