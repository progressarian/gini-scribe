import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Backend port to proxy `/api` to. Useful when the bundle was built
// without VITE_API_URL or when the user copies a curl from DevTools that
// captured the dev-server origin (`localhost:3000`) instead of the API.
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
