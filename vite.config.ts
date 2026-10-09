import { defineConfig } from "vite";

// Tauri 期望的固定开发端口与构建产物路径
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // 不监听 Rust 源码目录
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    target: "es2021",
    outDir: "dist",
    rollupOptions: {
      output: {
        manualChunks(id) {
          const path = id.replaceAll('\\', '/');
          if (path.includes('/node_modules/@xterm/addon-image/')) return 'terminal-images';
          if (path.includes('/node_modules/zmodem.js/')) return 'zmodem';
          if (path.includes('/node_modules/@xterm/') && !path.includes('/addon-webgl/')) return 'terminal-core';
        },
      },
    },
  },
});
