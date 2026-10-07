import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    host: true,
    port: 5200,
    strictPort: true,
    proxy: {
      "/api": {
        target: process.env.AGENTFORGE_API_URL || "http://localhost:8000",
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
