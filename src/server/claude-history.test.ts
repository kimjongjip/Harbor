import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeHistory, parseClaudeHistory, type ClaudeHistoryReader } from './claude-history.js';
import type { HostConfig } from '../shared/types.js';
const host = { id: 'fixture', kind: 'local' } as HostConfig;
const jsonl = (rows: any[]) => rows.map(r => JSON.stringify(r)).join('\n');
test('Claude metadata and visible text exclude tools, meta, sidechain and thinking', () => {
  const detail = parseClaudeHistory('h', 'id', jsonl([
    { type: 'user', uuid: 'u', cwd: '/project', message: { content: [{ type: 'text', text: '질문' }, { type: 'image' }] } },
    { type: 'assistant', uuid: 'a', message: { content: [{ type: 'thinking', thinking: 'private' }, { type: 'tool_use', name: 'Bash' }, { type: 'text', text: '답변' }] } },
    { type: 'user', isMeta: true, message: { content: 'meta' } },
    { type: 'assistant', isSidechain: true, message: { content: 'subagent' } },
    { type: 'custom-title', customTitle: '제목' },
  ]) + '\n{"partial":', 42);
  assert.equal(detail.thread.title, '제목'); assert.equal(detail.thread.cwd, '/project');
  assert.deepEqual(detail.items.map(i => i.text), ['질문', '답변']); assert.equal(detail.items[0].imageCount, 1);
});
function fixture() {
  let closed = 0;
  const data: Record<string, string> = {};
  for (let i = 0; i < 55; i++) data[`/claude/projects/p/session-${i}.jsonl`] = jsonl(Array.from({ length: 61 }, (_, n) => ({ type: n % 2 ? 'assistant' : 'user', uuid: `${i}-${n}`, cwd: '/project', message: { content: `Question ${i} message ${n}` } })));
  data['/claude/projects/p/agent-hidden.jsonl'] = jsonl([{ type: 'user', isSidechain: true, message: { content: 'hidden' } }]);
  const reader: ClaudeHistoryReader = {
    root: '/claude/projects', join: (...parts) => parts.join('/'),
    async entries(dir) { if (dir === '/claude/projects') return [{ name: 'p', directory: true, size: 0, modified: 0 }]; return Object.entries(data).map(([name, text], i) => ({ name: name.split('/').at(-1)!, directory: false, size: Buffer.byteLength(text), modified: i })); },
    async read(file, start, length) { return Buffer.from(data[file]).subarray(start, start + length).toString(); },
    close() { closed++; },
  };
  return { history: new ClaudeHistory(async () => reader), closed: () => closed };
}
test('Claude lists across project and paginates/searches, excluding subagent sessions', async () => {
  const f = fixture(); const first = await f.history.list(host); assert.equal(first.data.length, 50); assert.equal(first.nextCursor, '50');
  const last = await f.history.list(host, undefined, { cursor: first.nextCursor! }); assert.equal(last.data.length, 5); assert.equal(last.nextCursor, null);
  const searched = await f.history.list(host, undefined, { search: 'Question 54' }); assert.equal(searched.data.length, 1); assert.equal(searched.data[0].id, 'session-54'); assert.equal(f.closed(), 3);
  await assert.rejects(f.history.list(host, undefined, { archived: true }), /보관함/);
});
test('Claude detail pages newest messages first as chronologically ordered batches and validates id', async () => {
  const f = fixture(); const first = await f.history.read(host, undefined, 'session-1'); assert.equal(first.items.length, 50); assert.equal(first.items[0].id, '1-11');
  const second = await f.history.read(host, undefined, 'session-1', first.nextCursor!); assert.equal(second.items.length, 11); assert.equal(second.nextCursor, null);
  await assert.rejects(f.history.read(host, undefined, '../secret'), /ID/);
  assert.equal((await f.history.summary(host, undefined, 'session-1')).cwd, '/project');
});

test('actual local reader honors CLAUDE_CONFIG_DIR in an isolated temporary folder', async () => {
  const fs = await import('node:fs/promises'); const os = await import('node:os'); const path = await import('node:path');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harbor-claude-history-')); const old = process.env.CLAUDE_CONFIG_DIR;
  try {
    process.env.CLAUDE_CONFIG_DIR = root; await fs.mkdir(path.join(root, 'projects', 'fixture'), { recursive: true });
    await fs.writeFile(path.join(root, 'projects', 'fixture', 'local-fixture.jsonl'), jsonl([{ type: 'user', cwd: '/fixture', message: { content: 'synthetic question' } }]));
    const history = new ClaudeHistory(); const page = await history.list(host); assert.equal(page.data.length, 1); assert.equal(page.data[0].provider, 'claude');
    assert.equal((await history.read(host, undefined, 'local-fixture')).items[0].text, 'synthetic question'); history.shutdown();
    await assert.rejects(history.list(host), /closed/);
  } finally {
    if (old === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = old;
    const resolved = path.resolve(root); assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)); assert.ok(path.basename(resolved).startsWith('harbor-claude-history-')); await fs.rm(resolved, { recursive: true, force: true });
  }
});

test('SSH reader contract receives host and password, and closes cancelled active connections', async () => {
  let closeCount = 0; let unblock!: () => void;
  const reader: ClaudeHistoryReader = { root: '/custom/projects', join: (...parts) => parts.join('/'), entries: async () => { await new Promise<void>(resolve => { unblock = resolve; }); return []; }, read: async () => '', close: () => { closeCount++; unblock?.(); } };
  const remote = { ...host, id: 'remote-fixture', kind: 'ssh' } as HostConfig;
  const history = new ClaudeHistory(async (h, password) => { assert.equal(h, remote); assert.equal(password, 'fixture-only'); return reader; });
  const pending = history.list(remote, 'fixture-only'); await new Promise(resolve => setImmediate(resolve)); history.close(remote.id); await pending;
  assert.ok(closeCount >= 1); history.shutdown(); await assert.rejects(history.list(remote), /closed/);
});

test('malformed primitive records and other session records are skipped; repeated message UUID uses latest snapshot', () => {
  const detail = parseClaudeHistory('h', 'id', jsonl([null, 3, 'text', [], { type: 'user', sessionId: 'other', message: { content: 'wrong session' } }, { type: 'assistant', uuid: 'a', sessionId: 'id', message: { content: 'partial' } }, { type: 'assistant', uuid: 'a', sessionId: 'id', message: { content: 'complete' } }]), 1);
  assert.deepEqual(detail.items.map(i => i.text), ['complete']);
});
