// 两轮构建编排：① 页面轮（settings/dashboard，含 theme chunk）
//               ② background 轮（自包含 IIFE，见 vite.config.js 顶部注释）
// 用法：npm run build（等价于原来的 vite build）
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const viteBin = resolve(
  root,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "vite.cmd" : "vite",
);

function sh(cmd, extraEnv = {}) {
  execSync(cmd, {
    stdio: "inherit",
    cwd: root,
    env: { ...process.env, ...extraEnv },
  });
}

// --only=pages / --only=background：只跑单轮（调试用）
const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const only = onlyArg && onlyArg.split("=")[1];

if (only !== "background") sh(`"${viteBin}" build`);
if (only !== "pages") sh(`"${viteBin}" build`, { QW_BUILD_TARGET: "background" });
console.log("\n✓ dist/ 构建完成（settings/dashboard + 自包含 background.js）");
