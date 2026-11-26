import { defineConfig, type Plugin } from "vite";
import { cp, mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";

// Keep CJK maps, standard fonts and image decoders local, including offline use.
export function pdfResources(): Plugin {
  let output: string;
  return {
    name: "harbor-pdf-resources",
    apply: "build",
    configResolved(config) {
      output = resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      const source = resolve("node_modules/pdfjs-dist");
      const { version } = JSON.parse(
        await readFile(resolve(source, "package.json"), "utf8"),
      );
      const target = resolve(output, "pdfjs", version);
      await mkdir(target, { recursive: true });
      for (const name of ["cmaps", "standard_fonts", "wasm", "iccs", "LICENSE"])
        await cp(resolve(source, name), resolve(target, name), {
          recursive: true,
        });
    },
  };
}

export default defineConfig({
  plugins: [react(), pdfResources()],
  build: {
    outDir: "dist/client",
    rollupOptions: {
      input: {
        main: "index.html",
        mobile: "mobile/index.html",
        desktop: "remote-desktop/index.html",
      },
    },
  },
});
