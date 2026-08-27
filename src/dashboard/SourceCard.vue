<template>
  <div class="source-card" :class="{ 'card-loading': loading }">
    <!-- header：名称 + planType 徽章 + 刷新控件 -->
    <div class="source-header">
      <div class="source-title">
        <span class="source-name">{{ inst.name }}</span>
        <span v-if="normalized && normalized.planType" class="plan-type">{{ normalized.planType }}</span>
      </div>
      <div class="card-controls">
        <span v-if="data && data._fetchedAt" class="card-refreshed-at">{{ refreshedText }}</span>
        <span v-if="!loading && !timedOut && nextRefreshText" class="card-next-refresh">{{ nextRefreshText }}</span>
        <el-button
          size="mini"
          class="card-refresh-btn"
          :disabled="loading"
          @click="$emit('refresh-one', inst.id)"
        >{{ loading ? t('card.refreshing') : t('card.refresh') }}</el-button>
      </div>
    </div>

    <!-- 刷新状态提示：超时失败 / 可点击重试 -->
    <div v-if="timedOut" class="retry-block retry-error">
      <span class="retry-msg">{{ t('card.timeout') }}</span>
      <a href="javascript:;" class="retry-link" @click="$emit('retry', inst.id)">{{ t('card.retry') }}</a>
    </div>
    <div v-else-if="loading && retryable" class="retry-block">
      <span class="retry-msg">{{ t('card.slow') }}</span>
      <a href="javascript:;" class="retry-link" @click="$emit('retry', inst.id)">{{ t('card.retry') }}</a>
    </div>

    <!-- 正文 -->
    <template v-if="!data">
      <div class="error-msg">{{ t('card.noData') }}</div>
    </template>
    <template v-else-if="data._lastError">
      <div class="diag-block diag-warn">
        <div class="diag-title">{{ t('card.showLast') }} · {{ diag && diag.title }}</div>
        <div v-if="diag && diag.detail" class="diag-detail">{{ diag.detail }}</div>
        <div v-if="diag && diag.advice" class="diag-advice">{{ diag.advice }}</div>
      </div>
      <!-- 上次数据仍有效则显示窗口；无效（如缓存的坏 body）时诊断块已说明
           失败原因，不再追加「格式解析异常」块，避免同一错误重复展示 -->
      <div v-if="normalized" class="card-body">
        <WindowList :windows="normalized.windows" :now="now" />
      </div>
    </template>
    <template v-else-if="data._error && !data._hasValidData">
      <div class="diag-block diag-error">
        <div class="diag-title">{{ (diag && diag.title) || t('card.fetchFailed') }}</div>
        <div v-if="diag && diag.detail" class="diag-detail">{{ diag.detail }}</div>
        <div v-if="diag && diag.advice" class="diag-advice">{{ diag.advice }}</div>
      </div>
    </template>
    <template v-else>
      <div v-if="normalized" class="card-body">
        <WindowList :windows="normalized.windows" :now="now" />
        <div v-for="(ex, i) in normalizedExtras" :key="'ex' + i" class="window-detail">{{ ex.label }}: {{ ex.value }}</div>
      </div>
      <div v-else class="diag-block diag-error">
        <div class="diag-title">{{ t('card.formatError') }}</div>
        <div class="diag-detail">{{ t('card.formatErrorDetail') }}</div>
        <div class="diag-advice">{{ t('card.formatErrorAdvice', { url: formatUrl }) }}</div>
      </div>
    </template>

    <!-- 更新时间 -->
    <div v-if="data && data._fetchedAt" class="fetched-at">{{ t('card.updated', { time: refreshedText }) }}</div>
  </div>
</template>

<script>
import WindowList from "./WindowList.vue";
import { normalizeData } from "../shared/render.js";
import { formatRelativeTime } from "../shared/format.js";
import { diagnoseError } from "../shared/diagnose.js";
import { getRefreshIntervalMin, SOURCE_TEMPLATES } from "../shared/sources.js";
import { t } from "../shared/i18n.js";

export default {
  name: "SourceCard",
  components: { WindowList },
  props: {
    inst: { type: Object, required: true },
    data: { type: Object, default: null },
    loading: { type: Boolean, default: false },
    retryable: { type: Boolean, default: false }, // 转圈≥5s，显示「点击重试」链接
    timedOut: { type: Boolean, default: false }, // 转圈≥30s，判定超时失败
    autoRefreshOff: { type: Boolean, default: false }, // 登录终态失效等不自动刷新的卡，不显示下次刷新倒计时
    now: { type: Number, default: () => Date.now() }, // 用于倒计时刷新
  },
  computed: {
    normalized() {
      if (!this.data || (this.data._error && !this.data._hasValidData)) return null;
      try {
        return normalizeData(this.inst.type, this.data);
      } catch (e) {
        return null;
      }
    },
    // 给"格式解析异常"诊断块用：从 SOURCE_TEMPLATES 拿平台主页 / 套餐页 URL，
    // 让用户知道去哪里确认账户/套餐状态
    formatUrl() {
      const tmpl = SOURCE_TEMPLATES[this.inst.type];
      return (tmpl && (tmpl.curlHintUrl || tmpl.loginUrl)) || "";
    },
    // 失败诊断：优先用 background 写入的 _diag；老缓存没有时现场归类
    diag() {
      if (!this.data) return null;
      const hasError = this.data._error || this.data._lastError;
      if (!hasError) return null;
      if (this.data._diag) return this.data._diag;
      return diagnoseError(hasError, {
        type: this.inst.type,
        authMode: this.inst.authMode,
      });
    },
    normalizedExtras() {
      if (!this.normalized || !this.normalized.extras) return [];
      return this.normalized.extras.filter((ex) => ex.value != null);
    },
    refreshedText() {
      if (!this.data || !this.data._fetchedAt) return "";
      // 传入响应式 now，让「刚刚/X 分钟前」随每秒 tick 重算（否则 computed 缓存不更新）
      return formatRelativeTime(this.data._fetchedAt, this.now);
    },
    // 下次自动刷新时刻 = 上次刷新尝试 + 该卡刷新间隔（与 App 的到点定时器、
    // 后台到期检查同一公式）。依赖 now，倒计时每秒重算
    nextRefreshAt() {
      if (!this.data) return 0;
      const last = this.data._attemptedAt || this.data._fetchedAt;
      return last ? last + getRefreshIntervalMin(this.inst) * 60000 : 0;
    },
    nextRefreshText() {
      if (!this.nextRefreshAt || this.autoRefreshOff) return "";
      const ms = this.nextRefreshAt - this.now;
      if (ms <= 0) return t("card.nextRefreshSoon");
      const totalSec = Math.ceil(ms / 1000);
      const m = Math.floor(totalSec / 60);
      const s = totalSec % 60;
      const dur = m > 0 ? t("format.ms", { m, s }) : t("format.s", { s });
      return t("card.nextRefresh", { time: dur });
    },
  },
  methods: {
    t,
  },
};
</script>

<style scoped>
.source-card {
  background: var(--color-card);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-card);
  padding: 18px;
  box-shadow: var(--shadow-card);
  transition: box-shadow 0.15s, border-color 0.15s;
  position: relative;
}
/* 刷新状态提示条（5s 可重试 / 30s 超时失败） */
.retry-block {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  border-radius: var(--radius-btn);
  padding: 6px 10px;
  margin-bottom: 10px;
}
.retry-msg {
  color: var(--color-text-secondary);
}
.retry-link {
  color: var(--color-accent);
  cursor: pointer;
  text-decoration: none;
  font-weight: 500;
  flex-shrink: 0;
}
.retry-link:hover {
  text-decoration: underline;
  color: var(--color-accent-hover);
}
.retry-error {
  background: var(--color-danger-bg);
  border: 1px solid var(--color-danger-border);
}
.retry-error .retry-msg {
  color: var(--color-danger);
}
.source-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 14px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--color-border);
}
.source-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.source-name {
  font-weight: 600;
  font-size: 14px;
  letter-spacing: -0.01em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.plan-type {
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--color-text-secondary);
  background: var(--color-bg-subtle);
  border: 1px solid var(--color-border);
  padding: 1px 7px;
  border-radius: var(--radius-pill);
  flex-shrink: 0;
  text-transform: uppercase;
}
.card-controls {
  display: flex;
  align-items: center;
  gap: 8px;
}
.card-refreshed-at {
  font-size: 11px;
  color: var(--color-text-tertiary);
  font-variant-numeric: tabular-nums;
  min-width: 48px;
  text-align: right;
}
/* 距下次刷新倒计时：tabular-nums 防止秒数跳动时数字抖动 */
.card-next-refresh {
  font-size: 11px;
  color: var(--color-text-faint);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.card-body {
  /* 占位 */
}
/* extras 行（credits 等）沿用窗口明细的排版 */
.window-detail {
  font-size: 11px;
  color: var(--color-text-faint);
  font-variant-numeric: tabular-nums;
  margin-bottom: 4px;
}
.fetched-at {
  margin-top: 10px;
  font-size: 11px;
  color: var(--color-text-mute);
  text-align: right;
}
.error-msg {
  color: var(--color-danger);
  font-size: 12px;
  margin-bottom: 6px;
  word-break: break-all;
}
.fetch-warn {
  font-size: 11.5px;
  color: var(--color-warn);
  background: var(--color-warn-bg);
  border: 1px solid var(--color-warn-border);
  border-left-width: 2px;
  border-radius: var(--radius-btn);
  padding: 5px 9px;
  margin-bottom: 10px;
}
/* 诊断块：失败时的「类别 + 详情 + 建议」三行结构 */
.diag-block {
  border-radius: var(--radius-btn);
  padding: 7px 10px;
  margin-bottom: 10px;
  border-left-width: 3px;
  border-left-style: solid;
}
.diag-warn {
  background: var(--color-warn-bg);
  border-color: var(--color-warn);
}
.diag-error {
  background: var(--color-danger-bg);
  border-color: var(--color-danger);
}
.diag-title {
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 3px;
}
.diag-warn .diag-title { color: var(--color-warn); }
.diag-error .diag-title { color: var(--color-danger); }
.diag-detail {
  font-size: 11.5px;
  color: var(--color-text-secondary);
  word-break: break-all;
  margin-bottom: 2px;
}
.diag-advice {
  font-size: 11.5px;
  color: var(--color-text-tertiary);
  line-height: 1.45;
}
</style>
