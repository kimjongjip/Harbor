import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist/client",
    rollupOptions: {
      input: { main: "index.html", mobile: "mobile/index.html", desktop: "remote-desktop/index.html" },
    },
  },
});
