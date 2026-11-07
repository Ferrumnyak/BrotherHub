import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// При `tauri android dev` телефон открывает интерфейс по сетевому адресу
// компьютера — его Tauri передаёт в TAURI_DEV_HOST.
const host = process.env.TAURI_DEV_HOST;

// Настройки под Tauri: фиксированный порт и не следить за Rust-кодом.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
