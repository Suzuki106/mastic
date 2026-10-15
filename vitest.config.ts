import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * 前端测试单独一个跑法。
 *
 * 后端那套用 `node --test` 直接跑 .ts(靠 Node 擦除类型),这条链子不能沾
 * 任何构建工具 —— 那是 README 里写明的性质。前端要 JSX,只能交给 vitest。
 *
 * environment 用 node 而不是 jsdom:这里测的是"渲染出什么",用
 * react-dom/server 就够了,不必为了断言几段 HTML 去装一整个浏览器环境。
 */
export default defineConfig({
  plugins: [react()],
  test: {
    include: ["web/src/**/*.test.{ts,tsx}"],
    environment: "node",
  },
});
