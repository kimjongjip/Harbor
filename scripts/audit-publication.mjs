import { execFileSync } from 'node:child_process';

// Inspect exactly what would be committed, not private files in the workspace.
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
if (!files.length) throw new Error('Stage the intended files before running the publication audit.');
const roots = new Set(['.gitignore', '.gitattributes', 'README.md', 'AGENTS.md', 'CHANGELOG.md', 'docs/user-guide.md', 'docs/maintainer-guide.md', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'index.html', 'Setup-Harbor.cmd', 'Setup-Harbor.ps1', 'Update-Harbor.cmd', 'Update-Harbor.ps1', 'Start-Harbor.cmd', 'Start-Harbor-Desktop.ps1']);
const scripts = new Set(['package-desktop.mjs', 'desktop-release.mjs', 'make-desktop-icons.mjs', 'harbor-image.py', 'audit-publication.mjs', 'set-version.mjs', 'verify-claude-api.mjs', 'verify-installed-replay.mjs']);
const findings = [];
for (const file of files) {
  const allowed = roots.has(file) || /^(src|desktop|public)\//.test(file) || (file.startsWith('scripts/') && scripts.has(file.slice(8)));
  if (!allowed || /(?:^|\/)(?:\.data|\.cache|\.runtime|artifacts|release|node_modules)(?:\/|$)/.test(file) || /\.(?:pem|key|jsonl|sqlite|db|log)$/i.test(file)) findings.push({file, reason:'File outside public source manifest'});
  const buffer = execFileSync('git', ['show', `:${file}`], { maxBuffer: 10 * 1024 * 1024 });
  if (/\.(png|ico)$/.test(file)) continue;
  const lines = buffer.toString('utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    const rules = [
      ['Private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
      ['Access token', /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{30,})/],
      ['Credentials in URL', /https?:\/\/[^\s/:]+:[^\s/@]+@/],
      ['Personal Windows directory', /[A-Z]:[\\/]Users[\\/](?!user(?:[\\/]|\b)|test(?:[\\/]|\b)|fixture(?:[\\/]|\b)|Public(?:[\\/]|\b)|Default(?:[\\/]|\b))[A-Za-z0-9_.-]+/i],
    ];
    for (const [reason, pattern] of rules) if (pattern.test(line)) findings.push({file, line:index+1, reason});
    for (const ip of line.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) || []) {
      if (!/^(?:127\.|192\.168\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.|0\.0\.0\.0$|255\.)/.test(ip)) findings.push({file, line:index+1, reason:'Non-example IP address'});
    }
  });
}
if (findings.length) {
  console.error(JSON.stringify({ passed:false, findings }, null, 2));
  process.exitCode = 1;
} else console.log(JSON.stringify({passed:true, stagedFiles:files.length, note:'Source manifest and high-confidence secret patterns checked; manual review is still required.'}, null, 2));
