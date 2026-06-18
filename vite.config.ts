import { defineConfig } from "vite";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Vite is configured to play nicely with Tauri:
//  - Fixed port 1420 so the Rust side can reliably point its `devUrl` at it.
//  - `clearScreen: false` so Rust compiler errors are not wiped from the terminal.
//  - `envPrefix` lets `TAURI_ENV_*` vars through to the frontend if ever needed.
// See: https://tauri.app/start/frontend/vite/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // `@` points at the src directory (used by imports like "@/assets/...").
  resolve: {
    alias: { "@": resolve(import.meta.dirname, "src") },
  },
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_ENV_"],
  server: {
    port: 1420,
    strictPort: true,
    // Tauri expects a stable host; HMR over the same port keeps things simple.
    host: false,
    watch: {
      // Don't watch the Rust/Python source trees from the frontend dev server.
      ignored: ["**/src-tauri/**", "**/server/**"],
    },
  },
});
