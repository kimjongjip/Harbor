import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const parent = path.join(root, '.cache/claude-api');
await mkdir(parent, { recursive: true });
const fixture = await mkdtemp(path.join(parent, 'run-'));
const id = '33333333-3333-4333-8333-333333333333';
await mkdir(path.join(fixture, 'claude/projects/project'), { recursive: true });
await writeFile(path.join(fixture, `claude/projects/project/${id}.jsonl`), [
  { type: 'user', uuid: 'one', sessionId: id, cwd: fixture, message: { content: 'Synthetic Claude question' } },
  { type: 'assistant', uuid: 'two', sessionId: id, cwd: fixture, message: { content: [{ type: 'text', text: 'Synthetic Claude answer' }] } },
].map(r => JSON.stringify(r)).join('\n'));
const socket = createServer();
await new Promise(r => socket.listen(0, '127.0.0.1', r));
const port = socket.address().port;
await new Promise(r => socket.close(r));
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [path.join(root, 'dist/server.mjs')], {
  cwd: root, windowsHide: true, stdio: 'ignore',
  env: { ...process.env, NODE_ENV: 'production', HARBOR_PORT: String(port), HARBOR_DATA_DIR: path.join(fixture, 'state'), CLAUDE_CONFIG_DIR: path.join(fixture, 'claude'), CODEX_HOME: path.join(fixture, 'codex') },
});
const exited = once(child, 'exit');
try {
  let boot;
  for (let n = 0; n < 100; n++) {
    assert.equal(child.exitCode, null);
    try { boot = await (await fetch(`${base}/api/bootstrap`, { signal: AbortSignal.timeout(500) })).json(); break; }
    catch { await new Promise(r => setTimeout(r, 100)); }
  }
  assert.ok(boot);
  assert.equal(boot.capabilities.claudeIntegration, true);
  const get = async route => {
    const r = await fetch(base + route, { headers: { 'X-Harbor-Token': boot.token }, signal: AbortSignal.timeout(5000) });
    assert.equal(r.status, 200);
    return r.json();
  };
  const list = await get('/api/hosts/local/history?provider=claude');
  assert.equal(list.data.length, 1);
  assert.equal(list.data[0].provider, 'claude');
  assert.equal(list.data[0].id, id);
  const detail = await get(`/api/hosts/local/history/${id}?provider=claude`);
  assert.equal(detail.items.length, 2);
  assert.equal(detail.items[1].text, 'Synthetic Claude answer');
  const missing = await get('/api/hosts/local/history?provider=claude&search=nonmatching');
  assert.equal(missing.data.length, 0);
  assert.equal((await get('/api/bootstrap')).state.terminals.length, 0);
  const result = { passed: true, bundledBackend: true, providerRouting: true, listDetailSearch: true, syntheticOnly: true, userTerminalsTouched: false };
  await mkdir(path.join(root, 'artifacts'), { recursive: true });
  await writeFile(path.join(root, 'artifacts/claude-api-verification.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  child.kill();
  await exited;
  assert.ok(path.resolve(fixture).startsWith(parent + path.sep));
  await rm(fixture, { recursive: true, force: true });
}
