import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Настройки под Tauri: фиксированный порт и не следить за Rust-кодом.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
