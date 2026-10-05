import {
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

function containedDirectory(root, directory) {
  if (typeof directory !== "string" || !directory || path.isAbsolute(directory))
    throw new Error("Invalid desktop release directory");
  const resolved = path.resolve(root, directory);
  const inside = (base, target) => {
    const relative = path.relative(base, target);
    return (
      relative &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  };
  if (
    !inside(root, resolved) ||
    (existsSync(resolved) &&
      !inside(realpathSync(root), realpathSync(resolved)))
  )
    throw new Error(
      "Desktop release directory must stay inside its release folder",
    );
  return resolved;
}

export function desktopExecutable({
  staged = false,
  root = process.cwd(),
} = {}) {
  const output = path.resolve(root, staged ? "release-next" : "release");
  let directory = `Harbor-win32-${process.arch}`;
  if (!staged) {
    try {
      directory = JSON.parse(
        readFileSync(path.join(output, "current.json"), "utf8"),
      ).directory;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return path.join(containedDirectory(output, directory), "Harbor.exe");
}

export function writeDesktopReleasePointer(output, directory, version) {
  output = path.resolve(output);
  if (
    !existsSync(path.join(containedDirectory(output, directory), "Harbor.exe"))
  )
    throw new Error("Cannot select an incomplete desktop release");
  const file = path.join(output, "current.json");
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ directory, version })}\n`);
  renameSync(temporary, file);
}
