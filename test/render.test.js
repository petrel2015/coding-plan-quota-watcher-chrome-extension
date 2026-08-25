// render.test.js - normalizeData 各数据源归一化测试
import { describe, it, expect } from "vitest";
import { normalizeData, applyWindowCaps, computeForecast } from "../src/shared/render.js";

describe("normalizeData - volcengine-ark", () => {
  it("归一化 5h/周/月三个窗口", () => {
    const now = Math.floor(Date.now() / 1000);
    const data = {
      Result: {
        PlanType: "AgentPlan-Pro",
        AFPFiveHour: { Used: 100, Quota: 1000, ResetTime: now + 3600 },
        AFPWeekly: { Used: 3000, Quota: 10000, ResetTime: now + 86400 },
        AFPMonthly: { Used: 50000, Quota: 100000, ResetTime: 0 },
      },
    };
    const r = normalizeData("volcengine-ark", data);
    expect(r.planType).toBe("AgentPlan-Pro");
    expect(r.windows).toHaveLength(3);
    // 5h 窗口：100/1000 = 10%
    expect(r.windows[0].label).toBe("5小时窗口");
    expect(r.windows[0].usedPct).toBeCloseTo(10, 1);
    // 绝对量进结构（跨窗口有效上限的计算输入）
    expect(r.windows[0].used).toBe(100);
    expect(r.windows[0].quota).toBe(1000);
    expect(r.windows[0].remaining).toBe(900);
    // 月窗口 ResetTime=0 时推算为下月1日
    const now2 = new Date();
    const nextMonth = new Date(now2.getFullYear(), now2.getMonth() + 1, 1);
    expect(r.windows[2].resetMs).toBe(nextMonth.getTime());
  });

  it("处理秒级和毫秒级 ResetTime", () => {
    const sec = Math.floor(Date.now() / 1000) + 3600;
    const data1 = {
      Result: {
        AFPFiveHour: { Used: 50, Quota: 100, ResetTime: sec },
      },
    };
    const r1 = normalizeData("volcengine-ark", data1);
    expect(r1.windows[0].resetMs).toBe(sec * 1000);

    const ms = Date.now() + 3600000;
    const data2 = {
      Result: {
        AFPFiveHour: { Used: 50, Quota: 100, ResetTime: ms },
      },
    };
    const r2 = normalizeData("volcengine-ark", data2);
    expect(r2.windows[0].resetMs).toBe(ms);
  });

  it("无 Result 返回 null", () => {
    expect(normalizeData("volcengine-ark", {})).toBeNull();
    expect(normalizeData("volcengine-ark", { Result: null })).toBeNull();
  });
});

describe("normalizeData - minimax", () => {
  it("只取 general 模型，活跃窗口", () => {
    const data = {
      model_remains: [
        {
          model_name: "general",
          current_interval_status: 1, // 活跃
          current_interval_used_percent: "45.5",
          start_time: 1000,
          end_time: 1000 + 5 * 3600 * 1000,
          current_weekly_status: 3, // 不活跃
        },
      ],
    };
    const r = normalizeData("minimax", data);
    expect(r.windows).toHaveLength(1);
    expect(r.windows[0].label).toBe("5小时窗口");
    expect(r.windows[0].usedPct).toBeCloseTo(45.5, 1);
  });

  it("忽略非 general 模型", () => {
    const data = {
      model_remains: [
        { model_name: "abab", current_interval_status: 1, current_weekly_status: 3, current_interval_used_percent: "10" },
        { model_name: "general", current_interval_status: 1, current_weekly_status: 3, current_interval_used_percent: "20" },
      ],
    };
    const r = normalizeData("minimax", data);
    expect(r.windows).toHaveLength(1);
    expect(r.windows[0].usedPct).toBeCloseTo(20, 1);
  });

  it("无 model_remains 返回 null", () => {
    expect(normalizeData("minimax", {})).toBeNull();
  });
});

describe("normalizeData - chatgpt-codex", () => {
  it("归一化主窗口 + 次级窗口 + credits", () => {
    const resetAt = Math.floor(Date.now() / 1000) + 86400;
    const data = {
      rate_limit: {
        primary_window: { used_percent: 60, reset_at: resetAt, limit_window_seconds: 604800 },
        secondary_window: { used_percent: 30, reset_at: resetAt, limit_window_seconds: 86400 },
      },
      credits: { balance: "12.50" },
      rate_limit_reset_credits: { available_count: 2 },
    };
    const r = normalizeData("chatgpt-codex", data);
    expect(r.windows).toHaveLength(2);
    expect(r.windows[0].label).toBe("周窗口");
    expect(r.windows[0].usedPct).toBe(60);
    expect(r.extras).toContainEqual({ label: "Credits 余额", value: "$12.50" });
    expect(r.extras).toContainEqual({ label: "重置 Credits 次数", value: "2" });
  });

  it("无 rate_limit 返回 null", () => {
    expect(normalizeData("chatgpt-codex", { credits: {} })).toBeNull();
  });
});

describe("normalizeData - zhipu-glm", () => {
  it("unit=3,number=5 -> 5小时窗口；unit=6,number=1 -> 周窗口", () => {
    const nextReset = Date.now() + 3600000;
    const data = {
      data: {
        level: 3,
        limits: [
          { unit: 3, number: 5, currentValue: 200, usage: 1000, percentage: 20, nextResetTime: nextReset },
          { unit: 6, number: 1, currentValue: 5000, usage: 50000, percentage: 10, nextResetTime: nextReset },
        ],
      },
    };
    const r = normalizeData("zhipu-glm", data);
    expect(r.planType).toBe("Lv.3");
    expect(r.windows).toHaveLength(2);
    expect(r.windows[0].label).toBe("5小时窗口");
    expect(r.windows[0].usedPct).toBe(20);
    expect(r.windows[1].label).toBe("周窗口");
  });

  it("无 limits 返回 null", () => {
    expect(normalizeData("zhipu-glm", { data: {} })).toBeNull();
    expect(normalizeData("zhipu-glm", {})).toBeNull();
  });
});

describe("normalizeData - 未知类型", () => {
  it("返回 null", () => {
    expect(normalizeData("unknown", { foo: "bar" })).toBeNull();
  });
});

// 构造火山数据：5h/周/月三窗口，控制各窗口剩余量与重置时间
function volcData({ h5, week, month }) {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    Result: {
      PlanType: "AgentPlan-Pro",
      AFPFiveHour: { Used: h5.used, Quota: h5.quota, ResetTime: nowSec + h5.resetInSec },
      AFPWeekly: { Used: week.used, Quota: week.quota, ResetTime: nowSec + week.resetInSec },
      AFPMonthly: { Used: month.used, Quota: month.quota, ResetTime: nowSec + month.resetInSec },
    },
  };
}

describe("applyWindowCaps - 跨窗口幽灵上限", () => {
  it("周窗口剩余最小时，5h/月窗口被压到有效上限", () => {
    // 5h 剩 900，周剩 100（约束来源），月剩 80000
    const r = normalizeData("volcengine-ark", volcData({
      h5: { used: 100, quota: 1000, resetInSec: 4 * 3600 },
      week: { used: 9900, quota: 10000, resetInSec: 3 * 86400 },
      month: { used: 20000, quota: 100000, resetInSec: 10 * 86400 },
    }));
    const [w5, wk, wm] = r.windows;
    // 5h 窗口：有效上限 = (100 + 100) / 1000 = 20%
    expect(w5.capPct).toBeCloseTo(20, 5);
    expect(w5.bindingLabel).toBe("周窗口");
    expect(w5.bindingRemaining).toBe(100);
    expect(w5.capText).toContain("周窗口");
    // 周窗口自己是约束来源，无附加上限
    expect(wk.capPct).toBeUndefined();
    // 月窗口同样被周窗口压住：20000 + 100) / 100000 = 20.1%
    expect(wm.capPct).toBeCloseTo(20.1, 5);
    expect(wm.bindingLabel).toBe("周窗口");
  });

  it("各窗口剩余并列或自身最紧时无上限标记", () => {
    // 三窗口剩余都是 500
    const r = normalizeData("volcengine-ark", volcData({
      h5: { used: 500, quota: 1000, resetInSec: 4 * 3600 },
      week: { used: 500, quota: 1000, resetInSec: 3 * 86400 },
      month: { used: 500, quota: 1000, resetInSec: 10 * 86400 },
    }));
    for (const w of r.windows) {
      expect(w.capPct).toBeUndefined();
      expect(w.capText).toBeUndefined();
    }
  });

  it("只有百分比、无绝对量的窗口（MiniMax/Codex）不参与也不受约束", () => {
    const capped = applyWindowCaps([
      { label: "5小时窗口", usedPct: 30, quota: 1000, used: 300, resetMs: Date.now() + 3600e3 },
      { label: "5小时窗口B", usedPct: 80, resetMs: Date.now() + 3600e3 },
    ]);
    expect(capped[0].capPct).toBeUndefined();
    expect(capped[1].capPct).toBeUndefined();
  });
});

describe("computeForecast - 跨窗口约束下的预测", () => {
  // 5h 窗口：used 100/1000（10%），重置在 4h 后 → startMs ≈ 1h 前，速率 ≈ 10%/h
  function capped5h(weekRem, weekResetInSec) {
    const r = normalizeData("volcengine-ark", volcData({
      h5: { used: 100, quota: 1000, resetInSec: 4 * 3600 },
      week: { used: 10000 - weekRem, quota: 10000, resetInSec: weekResetInSec },
      month: { used: 20000, quota: 100000, resetInSec: 10 * 86400 },
    }));
    return r.windows[0];
  }

  it("有效上限先于本窗口重置到达 → fcCapHit", () => {
    // 周窗口剩 100 → 5h 有效上限 20%，按 10%/h 速率 1h 后撞墙（重置在 4h 后）
    const fc = computeForecast(capped5h(100, 3 * 86400));
    expect(fc.level).toBe("warn");
    expect(fc.text).toContain("撞上周窗口上限");
  });

  it("约束窗口在撞墙前先重置 → 约束失效，回落自身 100% 判断（fcOk）", () => {
    // 周窗口 30 分钟后重置，撞墙要 1h → 约束消失；自身 90% 需 9h > 4h 重置
    const fc = computeForecast(capped5h(100, 1800));
    expect(fc.level).toBe("ok");
    expect(fc.text).toBe("按当前速度可用到重置");
  });

  it("约束窗口已耗尽 → 已被限住（fcBlocked）", () => {
    const fc = computeForecast(capped5h(0, 3 * 86400));
    expect(fc.level).toBe("warn");
    expect(fc.text).toContain("已被周窗口额度限住");
  });

  it("撞墙时刻晚于本窗口重置 → 本周期内不受约束（fcOk）", () => {
    // 周窗口剩 850 → 有效上限 95%，需 8.5h 撞墙 > 本窗口 4h 重置
    const fc = computeForecast(capped5h(850, 3 * 86400));
    expect(fc.level).toBe("ok");
    expect(fc.text).toBe("按当前速度可用到重置");
  });
});
