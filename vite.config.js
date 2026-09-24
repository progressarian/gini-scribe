import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
const API_TARGET = process.env.VITE_DEV_API_URL || "http://localhost:3001";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: parseInt(process.env.PORT) || 3000,
    allowedHosts: "all",
    proxy: {
      "/api": {
        target: API_TARGET,
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: "0.0.0.0",
    port: parseInt(process.env.PORT) || 3000,
    allowedHosts: "all",
    proxy: {
      "/api": {
        target: API_TARGET,
        changeOrigin: true,
      },
    },
  },
});
