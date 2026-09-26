// sources.test.js - migrateInstances / generateInstanceName / getRefreshIntervalMin 测试
import { describe, it, expect } from "vitest";
import {
  migrateInstances,
  generateInstanceName,
  getRefreshIntervalMin,
  judgeLoginState,
  serializeCookieHeader,
  DEFAULT_REFRESH_INTERVAL_MIN,
} from "../src/shared/sources.js";

describe("migrateInstances", () => {
  it("把 manualCookie 迁移到 manualCurl", () => {
    const input = [{ id: "1", manualCookie: "curl abc", enabled: true }];
    const { instances, changed } = migrateInstances(input);
    expect(changed).toBe(true);
    expect(instances[0].manualCurl).toBe("curl abc");
    expect(instances[0].manualCookie).toBeUndefined();
  });

  it("manualCurl 已存在时不覆盖", () => {
    const input = [{ id: "1", manualCookie: "old", manualCurl: "new", enabled: true }];
    const { instances, changed } = migrateInstances(input);
    expect(changed).toBe(false);
    expect(instances[0].manualCurl).toBe("new");
    // 旧字段保留（不在迁移条件内不清除）
    expect(instances[0].manualCookie).toBe("old");
  });

  it("无旧字段时 changed=false", () => {
    const input = [{ id: "1", manualCurl: "x", enabled: true }];
    const { instances, changed } = migrateInstances(input);
    expect(changed).toBe(false);
  });

  it("不修改入参（返回新数组新对象）", () => {
    const input = [{ id: "1", manualCookie: "curl", enabled: true }];
    const { instances } = migrateInstances(input);
    expect(instances).not.toBe(input);
    expect(instances[0]).not.toBe(input[0]);
    expect(input[0].manualCookie).toBe("curl"); // 原对象不变
  });

  it("空输入返回空数组", () => {
    expect(migrateInstances(null)).toEqual({ instances: [], changed: false });
    expect(migrateInstances(undefined)).toEqual({ instances: [], changed: false });
    expect(migrateInstances([])).toEqual({ instances: [], changed: false });
  });

  it("混合数组只迁移需要迁移的", () => {
    const input = [
      { id: "1", manualCurl: "ok" },
      { id: "2", manualCookie: "migrate-me" },
      { id: "3" },
    ];
    const { instances, changed } = migrateInstances(input);
    expect(changed).toBe(true);
    expect(instances[0].manualCurl).toBe("ok");
    expect(instances[1].manualCurl).toBe("migrate-me");
    expect(instances[1].manualCookie).toBeUndefined();
    expect(instances[2].manualCurl).toBeUndefined();
  });
});

describe("getRefreshIntervalMin", () => {
  it("缺省字段返回默认 5 分钟", () => {
    expect(getRefreshIntervalMin({})).toBe(DEFAULT_REFRESH_INTERVAL_MIN);
    expect(getRefreshIntervalMin(null)).toBe(DEFAULT_REFRESH_INTERVAL_MIN);
  });

  it("非法值回退默认", () => {
    expect(getRefreshIntervalMin({ refreshIntervalMin: 0 })).toBe(DEFAULT_REFRESH_INTERVAL_MIN);
    expect(getRefreshIntervalMin({ refreshIntervalMin: -3 })).toBe(DEFAULT_REFRESH_INTERVAL_MIN);
    expect(getRefreshIntervalMin({ refreshIntervalMin: "abc" })).toBe(DEFAULT_REFRESH_INTERVAL_MIN);
  });

  it("合法数字（含数字字符串）透传", () => {
    expect(getRefreshIntervalMin({ refreshIntervalMin: 1 })).toBe(1);
    expect(getRefreshIntervalMin({ refreshIntervalMin: 30 })).toBe(30);
    expect(getRefreshIntervalMin({ refreshIntervalMin: "10" })).toBe(10);
  });
});

describe("generateInstanceName", () => {
  it("空列表返回该类型的模板名", () => {
    expect(generateInstanceName("minimax", [])).toBe("MiniMax Token Plan");
  });

  it("无同名时返回模板名", () => {
    const instances = [{ id: "1", name: "火山方舟 Agent Plan" }];
    expect(generateInstanceName("minimax", instances)).toBe("MiniMax Token Plan");
  });

  it("已有一个同名（模板名）时返回 #2", () => {
    const instances = [{ id: "1", name: "MiniMax Token Plan" }];
    expect(generateInstanceName("minimax", instances)).toBe("MiniMax Token Plan #2");
  });

  it("已有多个同名时递增编号", () => {
    const instances = [
      { id: "1", name: "MiniMax Token Plan" },
      { id: "2", name: "MiniMax Token Plan #2" },
      { id: "3", name: "MiniMax Token Plan #3" },
    ];
    expect(generateInstanceName("minimax", instances)).toBe("MiniMax Token Plan #4");
  });

  it("不同类型的同名实例不计入该类型的重复", () => {
    const instances = [
      { id: "1", name: "MiniMax Token Plan", type: "minimax" },
      { id: "2", name: "智谱 GLM 用量", type: "zhipu-glm" },
    ];
    // 生成 zhipu-glm：已有 1 个同名 -> #2
    expect(generateInstanceName("zhipu-glm", instances)).toBe("智谱 GLM 用量 #2");
    // 生成 minimax：已有 1 个同名 -> #2
    expect(generateInstanceName("minimax", instances)).toBe("MiniMax Token Plan #2");
  });

  it("excludeId 排除自身（类型变更重命名场景）", () => {
    // 当前实例已是 "MiniMax Token Plan"，重算时不应把自己算进重复
    const instances = [{ id: "me", name: "MiniMax Token Plan", type: "minimax" }];
    expect(generateInstanceName("minimax", instances, "me")).toBe("MiniMax Token Plan");
  });

  it("excludeId 时其它同名仍计数", () => {
    const instances = [
      { id: "me", name: "MiniMax Token Plan", type: "minimax" },
      { id: "other", name: "MiniMax Token Plan", type: "minimax" },
    ];
    expect(generateInstanceName("minimax", instances, "me")).toBe("MiniMax Token Plan #2");
  });

  it("未知类型回退到 coding plan", () => {
    expect(generateInstanceName("unknown-type", [])).toBe("coding plan");
  });

  it("null/undefined 安全处理", () => {
    expect(generateInstanceName("minimax", null)).toBe("MiniMax Token Plan");
    expect(generateInstanceName("minimax", undefined)).toBe("MiniMax Token Plan");
  });
});

describe("judgeLoginState - 登录态判定", () => {
  const keyTmpl = { loginCookieNames: ["bigmodel_token_production"] };

  it("关键 cookie 在场 → ok（matchedKey）", () => {
    const r = judgeLoginState(keyTmpl, ["csrfToken", "bigmodel_token_production", "__cf_bm"]);
    expect(r.state).toBe("ok");
    expect(r.matchedKey).toBe(true);
    expect(r.count).toBe(3);
  });

  it("只有杂 cookie（未登录）→ miss：不受杂 cookie 干扰", () => {
    // 复现火山/Cloudflare 场景：未登录也有 csrfToken/__spti 等杂 cookie
    const r = judgeLoginState(keyTmpl, ["csrfToken", "__spti", "monitor_session_id"]);
    expect(r.state).toBe("miss");
    expect(r.matchedKey).toBe(false);
  });

  it("无任何 cookie → miss", () => {
    const r = judgeLoginState(keyTmpl, []);
    expect(r.state).toBe("miss");
  });

  it("未定义 loginCookieNames 的源回退计数判定", () => {
    const tmpl = {};
    expect(judgeLoginState(tmpl, ["__cf_bm"]).state).toBe("ok");
    expect(judgeLoginState(tmpl, []).state).toBe("miss");
    expect(judgeLoginState(tmpl, ["a", "b"]).matchedKey).toBe(false);
  });

  it("多候选关键名（chatgpt 双前缀）任一命中即 ok", () => {
    const tmpl = { loginCookieNames: ["__Secure-next-auth.session-token", "next-auth.session-token"] };
    expect(judgeLoginState(tmpl, ["next-auth.session-token"]).state).toBe("ok");
    expect(judgeLoginState(tmpl, ["oai-did"]).state).toBe("miss");
  });

  it("cookieNames 缺省安全处理", () => {
    expect(judgeLoginState(keyTmpl).state).toBe("miss");
  });

  it("mimo：serviceToken 在场 → ok；仅有 userId 等杂 cookie → miss", () => {
    const tmpl = { loginCookieNames: ["api-platform_serviceToken"] };
    expect(judgeLoginState(tmpl, ["userId", "api-platform_serviceToken", "api-platform_ph"]).state).toBe("ok");
    expect(judgeLoginState(tmpl, ["userId", "api-platform_ph", "api-platform_slh"]).state).toBe("miss");
  });
});

describe("serializeCookieHeader - 本地模式 Cookie 头引号序列化", () => {
  it("纯数字 / hex / JWT 类值不加引号（与浏览器行为一致）", () => {
    const out = serializeCookieHeader([
      { name: "userId", value: "40534809" },
      { name: "csrfToken", value: "f40d3d6f0add28333f50954a1ffd6af8" },
      { name: "bigmodel_token_production", value: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc_-123" },
    ]);
    expect(out).toBe("userId=40534809; csrfToken=f40d3d6f0add28333f50954a1ffd6af8; bigmodel_token_production=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc_-123");
  });

  it("base64 值（含 +/= 等）补回双引号——mimo serviceToken 场景", () => {
    const out = serializeCookieHeader([
      { name: "api-platform_serviceToken", value: "0aGv1vYTmk+abc/XYZ=" },
      { name: "userId", value: "40534809" },
    ]);
    expect(out).toBe('api-platform_serviceToken="0aGv1vYTmk+abc/XYZ="; userId=40534809');
  });

  it("空列表与缺省安全处理", () => {
    expect(serializeCookieHeader([])).toBe("");
    expect(serializeCookieHeader(null)).toBe("");
    expect(serializeCookieHeader(undefined)).toBe("");
  });
});
