import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version || '')) throw new Error('Usage: node scripts/set-version.mjs X.Y.Z');
const root = path.resolve(import.meta.dirname, '..');
const read = file => readFileSync(path.join(root, file), 'utf8');
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
pkg.version = version;
lock.version = version;
lock.packages[''].version = version;
const replacements = [
  ['src/server/index.ts', /name: "codex-harbor", version: "\d+\.\d+\.\d+"/, `name: "codex-harbor", version: "${version}"`],
  ['desktop/preload.cjs', /version: "\d+\.\d+\.\d+"/, `version: "${version}"`],
].map(([file, pattern, replacement]) => {
  const source = read(file);
  if (!pattern.test(source)) throw new Error(`Version marker missing in ${file}`);
  return [file, source.replace(pattern, replacement)];
});
for (const [file, content] of [['package.json', JSON.stringify(pkg, null, 2)+'\n'], ['package-lock.json', JSON.stringify(lock, null, 2)+'\n'], ...replacements]) writeFileSync(path.join(root, file), content);
console.log(`Harbor version set to ${version}. Update CHANGELOG.md before publishing.`);
