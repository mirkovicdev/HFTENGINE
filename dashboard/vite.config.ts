import { defineConfig } from "vite";

export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: 5180,
    strictPort: true,
  },
  build: {
    target: "es2022",
    assetsInlineLimit: 0,
  },
});
