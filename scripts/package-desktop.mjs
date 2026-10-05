import { packager } from "@electron/packager";
import { cp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { writeDesktopReleasePointer } from "./desktop-release.mjs";
const require = createRequire(import.meta.url);
const root = process.cwd();
if (process.platform !== "win32")
  throw new Error(
    "This packaging script currently targets Windows on Windows.",
  );
const stage = path.resolve(root, ".cache", "desktop-package");
const staged = process.argv.includes("--staged");
const output = path.resolve(root, staged ? "release-next" : "release");
const outputRelative = path.relative(root, output);
if (
  !outputRelative ||
  outputRelative.startsWith("..") ||
  path.isAbsolute(outputRelative)
)
  throw new Error("Unsafe output path");
const relative = path.relative(root, stage);
if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
  throw new Error("Unsafe staging path");
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
if (!existsSync(path.join(root, "desktop/icon.ico")))
  await import("./make-desktop-icons.mjs");
for (const name of [
  "package.json",
  "package-lock.json",
  "dist",
  "desktop",
  "README.md",
])
  await cp(path.join(root, name), path.join(stage, name), { recursive: true });
await new Promise((resolve, reject) => {
  const install = spawn(
    "npm.cmd ci --omit=dev --ignore-scripts --no-audit --no-fund",
    { cwd: stage, shell: true, windowsHide: true, stdio: "inherit" },
  );
  install.once("error", reject);
  install.once("exit", (code) =>
    code === 0
      ? resolve()
      : reject(new Error(`Packaging dependencies failed: ${code}`)),
  );
});
await mkdir(path.join(stage, "runtime"), { recursive: true });
await cp(process.execPath, path.join(stage, "runtime/node.exe"));
const license = await fetch(
  `https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`,
);
if (!license.ok)
  throw new Error("Could not include the bundled Node.js license.");
await writeFile(
  path.join(stage, "runtime/LICENSE.node.txt"),
  await license.text(),
);
await mkdir(path.join(stage, "scripts"), { recursive: true });
await cp(
  path.join(root, "scripts/harbor-image.py"),
  path.join(stage, "scripts/harbor-image.py"),
);
const packageJson = JSON.parse(
  await readFile(path.join(stage, "package.json"), "utf8"),
);
packageJson.scripts = {};
delete packageJson.devDependencies;
await writeFile(
  path.join(stage, "package.json"),
  JSON.stringify(packageJson, null, 2),
);
const paths = await packager({
  dir: stage,
  name: "Harbor",
  executableName: "Harbor",
  platform: "win32",
  arch: process.arch,
  electronVersion: require("electron/package.json").version,
  out: output,
  overwrite: true,
  asar: false,
  prune: false,
  icon: path.join(root, "desktop/icon.ico"),
  appVersion: packageJson.version,
  win32metadata: {
    CompanyName: "Harbor",
    FileDescription: "Harbor — SSH and Codex workspace",
    ProductName: "Harbor",
  },
});
if (!staged)
  writeDesktopReleasePointer(
    output,
    path.relative(output, paths[0]),
    packageJson.version,
  );
console.log(`Desktop ready: ${path.join(paths[0], "Harbor.exe")}`);
