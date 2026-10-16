import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    outDir: "dist",
    target: ["es2021", "chrome105", "safari15"],
    minify: !process.env.TAURI_DEBUG,
    sourcemap: !!process.env.TAURI_DEBUG,
    // pet.html: the Tiny King's own window (meme mode).
    rollupOptions: { input: ["index.html", "pet.html"] },
  },
});
