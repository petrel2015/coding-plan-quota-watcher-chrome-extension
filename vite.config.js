import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue2";
import { resolve } from "path";

// MV3 扩展打包配置
// - settings / dashboard：Vue 2 SFC，打包成页面入口 JS + CSS
// - background：第二轮单独构建成自包含 IIFE —— 无静态 import、无共享 chunk。
//   原因：Safari 不支持 manifest 的 background.type: "module"（safari-web-
//   extension-converter 会警告 type 键），按 classic 脚本加载含 import 的
//   worker 会直接语法报错；打成自包含脚本后，同一份产物在 Chrome（classic）
//   与 Safari 里都能加载，manifest 也无需再声明 type 字段。
//   两轮构建由 scripts/build-all.mjs 编排：先跑页面轮，再设
//   QW_BUILD_TARGET=background 跑 background 轮。
// 产物输出到 dist/，HTML 留根目录引用 dist/assets/*

const sharedResolve = {
  alias: {
    // 锁定 runtime-only 构建，杜绝运行时模板编译（MV3 禁 unsafe-eval）
    vue: "vue/dist/vue.runtime.esm.js",
  },
};

const sharedPlugins = [vue()];

const pagesConfig = {
  plugins: sharedPlugins,
  base: "./",
  resolve: sharedResolve,
  // vitest 配置
  test: {
    setupFiles: ["./test/setup.js"],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        settings: resolve(__dirname, "src/settings/main.js"),
        dashboard: resolve(__dirname, "src/dashboard/main.js"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "assets/chunks/[name]-[hash].js",
        // element-ui / vue 等第三方依赖固定进 theme 共享块：
        // 根目录 HTML 硬编码引用其抽离的 CSS（assets/theme.css），
        // 不固定块名会随 chunk 自动命名漂移（如引入 locale 后变成 en.css）
        manualChunks(id) {
          if (id.includes("node_modules")) return "theme";
          // 深色覆盖样式与 theme.js 是两页面共享的 UI 公共依赖，
          // 一并归入 theme 块，保证其 CSS 合并输出为单个 theme.css
          if (id.endsWith("shared/theme.js") || id.endsWith("element-overrides.css")) {
            return "theme";
          }
        },
        assetFileNames: (info) => {
          // Element-UI 字体分到 fonts 目录
          if (info.name && /\.(woff2?|ttf|eot)$/.test(info.name)) {
            return "assets/fonts/[name][extname]";
          }
          return "assets/[name][extname]";
        },
      },
    },
  },
};

// background：单文件自包含 IIFE（无静态 import，无共享 chunk）
const backgroundConfig = {
  plugins: sharedPlugins, // 保持与主配置一致的模块解析行为
  base: "./",
  resolve: sharedResolve,
  build: {
    outDir: "dist",
    emptyOutDir: false, // 页面构建已清空过 dist，这里只追加/覆盖 background.js
    rollupOptions: {
      input: {
        background: resolve(__dirname, "src/background/main.js"),
      },
      output: {
        format: "iife",
        entryFileNames: "[name].js",
        inlineDynamicImports: true,
      },
    },
  },
};

export default defineConfig(() => {
  const target = process.env.QW_BUILD_TARGET;
  if (target === "background") return backgroundConfig;
  return pagesConfig;
});
