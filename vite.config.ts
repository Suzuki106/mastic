import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * 前端只有 web/ 这一个项目,所以配置放在仓库根目录,
 * 用 root 指过去 —— 这样 `npm run build:web` 在根目录直接跑得通,
 * 不用 cd 来 cd 去。
 */
export default defineConfig({
  root: "web",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    // 开发时 `mastic ui` 照常在 7777 起 API,前端这边把 /api 转过去。
    // 这样一个终端跑 mastic ui,另一个跑 vite,改前端立即热更。
    proxy: { "/api": "http://127.0.0.1:7777" },
  },
});
