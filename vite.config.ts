import { defineConfig } from "vite";

export default defineConfig({
  // 相対パスでビルドし、GitHub Pages 等どのサブパスに置いても動くようにする
  base: "./",
  optimizeDeps: {
    // Havok は wasm を別ファイルで読み込むため事前バンドル対象から外す
    exclude: ["@babylonjs/havok"],
  },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 8000,
  },
});
