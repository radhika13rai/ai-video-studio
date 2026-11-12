import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the Worker runs on :8787 (wrangler dev) and Vite proxies /api to it.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": { target: "http://127.0.0.1:8787", changeOrigin: true } },
  },
});
