<template>
  <div>
    <!-- topbar -->
    <div class="topbar">
      <div class="topbar-title">
        <h1>{{ t('dashboard.title') }}</h1>
        <span v-if="version" class="topbar-version">v{{ version }}</span>
      </div>
      <div class="topbar-right">
        <el-button @click="goSettings">{{ t('dashboard.settings') }}</el-button>
        <el-button type="primary" :loading="refreshingAll" @click="refreshAll(false)">{{ t('dashboard.refreshAll') }}</el-button>
        <el-button @click="toggleLocale">{{ nextLangLabel }}</el-button>
      </div>
    </div>

    <div class="sources-grid" :style="{ gridTemplateColumns: 'repeat(' + displayCols + ', 1fr)' }">
      <SourceCard
        v-for="inst in enabledInstances"
        :key="inst.id"
        :inst="inst"
        :data="dataMap[inst.id]"
        :loading="refreshingIds.has(inst.id)"
        :retryable="retryableIds.has(inst.id)"
        :timed-out="timedOutIds.has(inst.id)"
        :auto-refresh-off="isTerminalAuthError(inst)"
        :now="now"
        @refresh-one="refreshOne"
        @retry="retry"
      />
      <div v-if="enabledInstances.length === 0" class="empty">
        {{ t('dashboard.empty') }}
      </div>
    </div>
  </div>
</template>

<script>
import SourceCard from "./SourceCard.vue";
import { migrateInstances, getRefreshIntervalMin } from "../shared/sources.js";
import { applyTheme, setThemeAttr } from "../shared/theme.js";
import { diagnoseError, isTerminalAuthDiag } from "../shared/diagnose.js";
import { t, getLocale } from "../shared/i18n.js";

// 手动刷新时每张卡的最小转圈时间，避免太快闪一下看不到（自动刷新不受影响）
const MIN_LOADING_MS = 500;
// 转圈超过该时长（5s）后，卡片显示「点击重试」链接（仍在转圈，可提前触发重试）
const RETRY_SHOW_MS = 5000;
// 转圈超过该时长（60s）判定超时失败：停止转圈并提示失败。须大于单卡最坏
// 合法耗时——多请求数据源每段请求各受 20s/10s 超时保护，chatgpt-codex
// 三段（token + usage + forecast）最长 50s，全部成功也可能超过 30s
const LOADING_FALLBACK_TIMEOUT_MS = 60000;

// 发送刷新消息：MV3 下 SW 冷启动竞态 / SW 中途被杀会断开消息通道
// （"Receiving end does not exist" / "message port closed"），此时刷新
// 并未发生。等 1s 让 SW 完成启动后重试一次
async function sendRefreshMessage(msg) {
  try {
    return await chrome.runtime.sendMessage(msg);
  } catch (e) {
    console.error("[QuotaWatcher] sendMessage failed, retrying once:", e);
    await new Promise((r) => setTimeout(r, 1000));
    return chrome.runtime.sendMessage(msg);
  }
}

export default {
  name: "DashboardApp",
  components: { SourceCard },
  data() {
    return {
      // 当前扩展版本（topbar 徽章展示；非扩展环境取不到则为空、不显示）
      version: (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getManifest)
        ? chrome.runtime.getManifest().version
        : "",
      instances: [],
      dataMap: {}, // { [instanceId]: data }
      displayCols: 2,
      refreshingIds: new Set(), // 正在刷新的实例 id（注意：Set 需重新赋值触发响应式）
      refreshStartTimes: {}, // { [instanceId]: startTimeMs }，用于 500ms 最小展示
      retryableIds: new Set(), // 转圈≥5s 的实例 id：显示「点击重试」链接
      timedOutIds: new Set(), // 转圈≥30s 判定超时的实例 id：停止转圈并提示失败
      now: Date.now(),
    };
  },
  // 定时器句柄是内部簿记，模板不依赖，不进 data()（免走响应式）。
  // 且不能以 _ / $ 开头放 data()：Vue 2 不代理这类属性，this._xxx
  // 永远是 undefined —— markRefreshing 曾因此抛错，首卡进了 loading
  // 却没设上兜底定时器，永久转圈、全部刷新按钮永久不可点。
  created() {
    this.tickTimer = null;
    this.retryTimers = {}; // { [instanceId]: timer }，5s 显示重试链接
    this.fallbackTimers = {}; // { [instanceId]: timer }，30s 超时失败
    this.autoTimers = {}; // { [instanceId]: timer }，每卡片到点自动刷新
  },
  computed: {
    enabledInstances() {
      return this.instances.filter((i) => i.enabled);
    },
    // 「全部刷新」按钮 loading：有任何卡在转就 loading
    refreshingAll() {
      return this.refreshingIds.size > 0;
    },
    // 右上角快捷切换按钮显示「目标语言」：中文界面显示 EN，英文界面显示 中文
    nextLangLabel() {
      return getLocale() === "zh" ? "EN" : "中文";
    },
  },
  async mounted() {
    document.title = t("doc.dashboardTitle");
    document.documentElement.lang = getLocale();
    // 查询一次后台状态打到页面 console：SW 版本 / 存活时长 / 是否有刷新轮
    // 卡死（refreshing 长时间 true），排查「转圈到超时」时直接可看
    chrome.runtime.sendMessage({ action: "diag" })
      .then((d) => console.log("[QuotaWatcher] background diag:", d))
      .catch((e) => console.error("[QuotaWatcher] background diag failed:", e));
    await applyTheme();
    await this.loadAll();
    // 监听 storage 变化
    chrome.storage.onChanged.addListener(this.onStorageChanged);
    // 每秒刷新相对时间与「距下次刷新」倒计时（now 变化触发卡片重算，一直动）
    this.tickTimer = setInterval(() => {
      this.now = Date.now();
    }, 1000);
    // 按各卡片自己的刷新间隔排定到点自动刷新（默认 5 分钟）
    this.scheduleAutoRefresh();
    // 进入 dashboard：数据过期（任一启用卡片缺数据或距上次尝试超过其间隔）才自动刷新，
    // 从 settings 改完配置回来若数据仍新鲜则直接展示缓存，不闪进度条。
    // 自动刷新跳过已知登录失效的卡片，避免无意义的进度条闪烁
    if (this.isDataStale()) this.refreshAll(true);
  },
  beforeDestroy() {
    chrome.storage.onChanged.removeListener(this.onStorageChanged);
    if (this.tickTimer) clearInterval(this.tickTimer);
    for (const map of [this.retryTimers, this.fallbackTimers, this.autoTimers]) {
      for (const id of Object.keys(map)) clearTimeout(map[id]);
    }
  },
  methods: {
    t,
    async loadAll() {
      const { instances: raw, displayCols, theme } = await chrome.storage.local.get([
        "instances",
        "displayCols",
        "theme",
      ]);
      let instances = raw || [];
      if (raw) {
        const { instances: migrated, changed } = migrateInstances(raw);
        if (changed) {
          instances = migrated;
          await chrome.storage.local.set({ instances });
        }
      }
      this.instances = instances;
      this.displayCols = displayCols || 2;
      // 一次性拉取所有 data_* 缓存
      const dataKeys = this.enabledInstances.map((i) => `data_${i.id}`);
      const dataResult = await chrome.storage.local.get(dataKeys);
      const dataMap = {};
      for (const inst of this.enabledInstances) {
        dataMap[inst.id] = dataResult[`data_${inst.id}`];
      }
      this.dataMap = dataMap;
    },
    onStorageChanged(changes, area) {
      if (area !== "local") return;
      let needReloadInstances = false;
      let needReloadCols = false;
      let needReloadTheme = false;
      const dataUpdates = {};
      for (const key of Object.keys(changes)) {
        if (key === "instances") {
          needReloadInstances = true;
        } else if (key === "displayCols") {
          needReloadCols = true;
        } else if (key === "theme") {
          needReloadTheme = true;
        } else if (key === "locale") {
          // 语言绑在启动链路上（Element UI 文案 / doc lang），变更后整页重载
          location.reload();
          return;
        } else if (key.startsWith("data_")) {
          const id = key.slice(5);
          dataUpdates[id] = changes[key].newValue;
        }
      }
      if (needReloadInstances || needReloadCols) {
        this.loadAll().then(() => this.scheduleAutoRefresh());
      }
      if (needReloadTheme) {
        applyTheme();
      }
      if (Object.keys(dataUpdates).length > 0) {
        const newDataMap = { ...this.dataMap };
        for (const [id, val] of Object.entries(dataUpdates)) {
          newDataMap[id] = val;
          // 该实例后台已写入新数据 → 标记完成（逐卡停转圈）
          this.markDone(id);
        }
        this.dataMap = newDataMap;
        // 新数据落库（_attemptedAt 推进）→ 按新基准重排各卡到点刷新
        this.scheduleAutoRefresh();
      }
    },
    // 标记某实例开始刷新（记录开始时间，用于 500ms 最小展示）
    markRefreshing(id) {
      const newSet = new Set(this.refreshingIds);
      newSet.add(id);
      this.refreshingIds = newSet;
      this.refreshStartTimes = { ...this.refreshStartTimes, [id]: Date.now() };
      // 清掉上一次的定时器与超时/重试标记，重新计时
      this.clearCardTimers(id);
      const rt = new Set(this.retryableIds);
      rt.delete(id);
      this.retryableIds = rt;
      const to = new Set(this.timedOutIds);
      to.delete(id);
      this.timedOutIds = to;
      // 5s 后显示「点击重试」链接
      this.retryTimers[id] = setTimeout(() => this.markRetryable(id), RETRY_SHOW_MS);
      // 30s 判定超时失败（background 卡死/无响应时兜底，防止永久卡住）
      this.fallbackTimers[id] = setTimeout(() => this.markTimedOut(id), LOADING_FALLBACK_TIMEOUT_MS);
    },
    clearCardTimers(id) {
      if (this.retryTimers[id]) { clearTimeout(this.retryTimers[id]); delete this.retryTimers[id]; }
      if (this.fallbackTimers[id]) { clearTimeout(this.fallbackTimers[id]); delete this.fallbackTimers[id]; }
    },
    // 转圈≥5s：让该卡显示可点击的重试链接（仍保持转圈）
    markRetryable(id) {
      if (!this.refreshingIds.has(id)) return;
      const newSet = new Set(this.retryableIds);
      newSet.add(id);
      this.retryableIds = newSet;
    },
    // 转圈≥30s：停止转圈并标记为超时失败
    markTimedOut(id) {
      this.clearCardTimers(id);
      const rs = new Set(this.refreshingIds);
      rs.delete(id);
      this.refreshingIds = rs;
      const ts = { ...this.refreshStartTimes };
      delete ts[id];
      this.refreshStartTimes = ts;
      const rt = new Set(this.retryableIds);
      rt.delete(id);
      this.retryableIds = rt;
      const to = new Set(this.timedOutIds);
      to.add(id);
      this.timedOutIds = to;
    },
    // 标记某实例完成：清 loading，但保证手动刷新至少展示 500ms
    markDone(id) {
      this.clearCardTimers(id);
      const rt = new Set(this.retryableIds);
      rt.delete(id);
      this.retryableIds = rt;
      const to = new Set(this.timedOutIds);
      to.delete(id);
      this.timedOutIds = to;
      if (!this.refreshingIds.has(id)) return;
      const start = this.refreshStartTimes[id];
      const elapsed = start ? Date.now() - start : MIN_LOADING_MS;
      const clear = () => {
        const newSet = new Set(this.refreshingIds);
        newSet.delete(id);
        this.refreshingIds = newSet;
        const ts = { ...this.refreshStartTimes };
        delete ts[id];
        this.refreshStartTimes = ts;
      };
      if (elapsed >= MIN_LOADING_MS) {
        clear();
      } else {
        // 不足 500ms：补足后再清（setTimeout 期间仍显示转圈）
        setTimeout(clear, MIN_LOADING_MS - elapsed);
      }
    },
    // 数据是否过期：任一启用卡片缺数据，或距上次刷新尝试超过其刷新间隔即视为过期。
    // 后台同批刷新时 stamp 同步推进；新添加的卡片 stamp=0 会触发补刷
    isDataStale() {
      const now = Date.now();
      return this.enabledInstances.some((inst) => {
        const data = this.dataMap[inst.id];
        const last = (data && (data._attemptedAt || data._fetchedAt)) || 0;
        return now - last >= getRefreshIntervalMin(inst) * 60000;
      });
    },
    // 该实例最近一次失败是否为「需要用户重新登录/补齐凭证」的终态错误：
    // 这类错误重试不会自愈，自动刷新时不应再触发转圈（避免无意义的进度条闪烁）
    isTerminalAuthError(inst) {
      const data = this.dataMap[inst.id];
      if (!data) return false;
      const err = data._error || data._lastError;
      if (!err) return false;
      const diag = data._diag || diagnoseError(err, { type: inst.type, authMode: inst.authMode });
      return isTerminalAuthDiag(diag);
    },
    // 按各卡片刷新间隔排定「到点自动刷新」：下次刷新 = 上次尝试（_attemptedAt，
    // 老缓存回退 _fetchedAt）+ 间隔，与卡片上显示的倒计时、后台到期检查同公式。
    // 页面打开时由此精确到秒触发；页面关闭后由后台 alarm（1 分钟粒度）兜底
    scheduleAutoRefresh() {
      for (const id of Object.keys(this.autoTimers)) {
        clearTimeout(this.autoTimers[id]);
        delete this.autoTimers[id];
      }
      const now = Date.now();
      for (const inst of this.enabledInstances) {
        const data = this.dataMap[inst.id];
        const last = data && (data._attemptedAt || data._fetchedAt);
        // 无数据/登录终态失效的卡不排（前者由 isDataStale 补刷，后者不闪转圈）
        if (!last || this.isTerminalAuthError(inst)) continue;
        const delay = last + getRefreshIntervalMin(inst) * 60000 - now;
        this.autoTimers[inst.id] = setTimeout(
          () => this.autoRefreshOne(inst.id),
          Math.max(delay, 0),
        );
      }
    },
    // 到点自动刷新单卡；已在转圈（手动/全部刷新）则跳过，等数据落库后重排
    async autoRefreshOne(id) {
      delete this.autoTimers[id];
      if (this.refreshingIds.has(id)) return;
      const inst = this.enabledInstances.find((i) => i.id === id);
      if (!inst || this.isTerminalAuthError(inst)) return;
      await this.refreshOne(id);
    },
    async refreshAll(skipTerminal = false) {
      // 防重入：已有任何卡在转时不重复触发
      if (this.refreshingIds.size > 0) return;
      // 自动刷新（打开 dashboard）时跳过已知登录失效的卡片：静态展示错误即可，
      // 避免每次打开都闪进度条；手动「全部刷新」传 false，全部照常刷新。
      let targets = this.enabledInstances;
      if (skipTerminal) {
        targets = targets.filter((inst) => !this.isTerminalAuthError(inst));
      }
      // 所有 enabled 卡片各自进入独立 loading（蒙层）；逐张完成时由
      // onStorageChanged → markDone 逐张停。sendMessage settle 后（成功 =
      // 后台整轮已写库；重试后仍失败 = 刷新不会再来）统一停一次，
      // 避免个别 onChanged 未触达或通道断开时卡片空转到兜底超时
      for (const inst of targets) {
        this.markRefreshing(inst.id);
      }
      try {
        await sendRefreshMessage({ action: "refresh" });
      } catch (e) {
        console.error("[QuotaWatcher] refreshAll failed:", e);
      }
      for (const inst of targets) this.markDone(inst.id);
    },
    async refreshOne(instanceId) {
      if (this.refreshingIds.has(instanceId)) return;
      this.markRefreshing(instanceId);
      try {
        // resolve 即后台 refreshOne 完成并写库（成功或失败都会写 data_*），
        // reject（重试后仍失败）说明刷新不会发生：两者都立即停转圈
        await sendRefreshMessage({ action: "refreshOne", instanceId });
      } catch (e) {
        console.error("[QuotaWatcher] refreshOne failed:", e);
      }
      this.markDone(instanceId);
    },
    // 转圈≥5s 时点击「重试」：即使还在转圈也强制重新触发刷新，并重置计时
    async retry(instanceId) {
      this.markRefreshing(instanceId);
      try {
        await sendRefreshMessage({ action: "refreshOne", instanceId });
      } catch (e) {
        console.error("[QuotaWatcher] retry failed:", e);
      }
      this.markDone(instanceId);
    },
    goSettings() {
      window.location.href = "settings.html";
    },
    // 右上角中/英快捷切换：写入显式语言（覆盖「跟随浏览器」），重载生效
    async toggleLocale() {
      await chrome.storage.local.set({ locale: getLocale() === "zh" ? "en" : "zh" });
      location.reload();
    },
  },
};
</script>

<style scoped>
.topbar {
  position: sticky;
  top: 0;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14px 28px;
  background: var(--color-card);
  border-bottom: 1px solid var(--color-border);
  z-index: 10;
}
.topbar h1 {
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.topbar-right {
  display: flex;
  align-items: center;
  gap: 8px;
}
.sources-grid {
  display: grid;
  gap: 16px;
  padding: 24px 28px 40px;
}
.empty {
  text-align: center;
  color: var(--color-text-tertiary);
  padding: 40px 0;
  font-size: 14px;
  grid-column: 1 / -1;
}
</style>
