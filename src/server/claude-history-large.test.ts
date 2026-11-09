import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ClaudeHistory, type ClaudeHistoryReader } from './claude-history.js';
import { decodeClaudePageCursor } from './claude-history-pages.js';
import type { HostConfig } from '../shared/types.js';

const MiB = 1024 * 1024;
const remote = { id: 'large-history-fixture', kind: 'ssh' } as HostConfig;
const line = (row: object) => JSON.stringify(row) + '\n';
const message = (n: number, text = `Message ${n}`) => ({ type: n % 2 ? 'assistant' : 'user', message: { content: text }, cwd: '/fixture' });

function fixture(initial: Buffer, name = 'large') {
  let data = initial, modified = 1, closes = 0;
  const reads: { start: number; length: number }[] = [];
  const reader: ClaudeHistoryReader = {
    root: '/fixture/projects', join: path.posix.join,
    async entries(directory) {
      return directory === this.root ? [{ name: 'project', directory: true, size: 0, modified }]
        : [{ name: `${name}.jsonl`, directory: false, size: data.length, modified }];
    },
    async stat() { return { directory: false, size: data.length, modified }; },
    async read(_file, start, length) { reads.push({ start, length }); return data.subarray(start, start + length); },
    close() { closes++; },
  };
  const history = new ClaudeHistory(async (host, password) => {
    assert.equal(host, remote); assert.equal(password, 'synthetic-password'); return reader;
  });
  return {
    history, reader, reads, closes: () => closes,
    read: (cursor?: string) => history.read(remote, 'synthetic-password', name, cursor),
    replace(value: Buffer) { data = value; modified++; },
    append(value: string) { data = Buffer.concat([data, Buffer.from(value)]); modified++; },
  };
}

test('actual local file over 16 MiB pages the whole conversation with intact UTF-8 and stable anonymous ids', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harbor-claude-large-'));
  const old = process.env.CLAUDE_CONFIG_DIR;
  const history = new ClaudeHistory();
  try {
    process.env.CLAUDE_CONFIG_DIR = root;
    const directory = path.join(root, 'projects', 'fixture');
    await fs.mkdir(directory, { recursive: true });
    // Repeated multibyte characters necessarily cross 256 KiB range boundaries.
    const content = '한😀'.repeat(8000);
    const rows = Array.from({ length: 320 }, (_, i) => message(i, `${i}:${content}`));
    const data = Buffer.from(rows.map(line).join(''));
    assert.ok(data.length > 16 * MiB);
    const file = path.join(directory, 'large-local.jsonl');
    await fs.writeFile(file, data);
    const host = { id: 'local-large-fixture', kind: 'local' } as HostConfig;
    const first = await history.read(host, undefined, 'large-local');
    assert.equal(first.items.length, 50);
    assert.deepEqual(first.items.map(item => Number(item.text.split(':', 1)[0])), Array.from({ length: 50 }, (_, i) => i + 270));
    const expectedLatestId = first.items.at(-1)!.id;
    assert.match(expectedLatestId, /^large-local-byte-\d+$/);
    const all = [...first.items];
    let cursor = first.nextCursor, pages = 1;
    while (cursor) {
      const page = await history.read(host, undefined, 'large-local', cursor);
      all.unshift(...page.items); cursor = page.nextCursor;
      assert.ok(++pages < 10, 'pagination must terminate');
    }
    assert.deepEqual(all.map(item => Number(item.text.split(':', 1)[0])), rows.map((_, i) => i));
    assert.ok(all.every((item, i) => item.text === `${i}:${content}`), 'UTF-8 must be decoded after joining complete records');
    assert.equal(new Set(all.map(item => item.id)).size, rows.length);
    await fs.appendFile(file, line(message(320, 'New answer')));
    const refreshed = await history.read(host, undefined, 'large-local');
    assert.equal(refreshed.items.at(-2)!.id, expectedLatestId);
    assert.equal(refreshed.items.at(-1)!.text, 'New answer');
    assert.equal((await fs.stat(file)).size, data.length + Buffer.byteLength(line(message(320, 'New answer'))));
  } finally {
    history.shutdown();
    if (old === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = old;
    const resolved = path.resolve(root);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('harbor-claude-large-'));
    await fs.rm(resolved, { recursive: true, force: true });
  }
});

test('remote range reads stay bounded and byte pagination remains anchored while new messages are appended', async () => {
  const rows = Array.from({ length: 400 }, (_, i) => message(i, `${i}:${'x'.repeat(48 * 1024)}`));
  const data = Buffer.from(rows.map(line).join(''));
  const f = fixture(data);
  try {
    assert.ok(data.length > 16 * MiB);
    const first = await f.read();
    assert.equal(first.items.length, 50); assert.ok(first.nextCursor);
    assert.ok(f.reads.every(read => read.length <= 256 * 1024));
    assert.ok(f.reads.reduce((sum, read) => sum + read.length, 0) < 4 * MiB, 'first page must not read the whole transcript');
    const id = first.items.at(-1)!.id;
    f.append(line(message(400, 'Appended after first page')));
    const second = await f.read(first.nextCursor!);
    assert.deepEqual(second.items.map(item => Number(item.text.split(':', 1)[0])), Array.from({ length: 50 }, (_, i) => i + 300));
    assert.ok(!second.items.some(item => item.text.includes('Appended')));
    const refreshed = await f.read();
    assert.equal(refreshed.items.at(-2)!.id, id);
    assert.equal(refreshed.items.at(-1)!.text, 'Appended after first page');
    assert.ok(f.reads.every(read => read.length <= 256 * 1024));
  } finally { f.history.shutdown(); }
});

test('oversized individual records produce an explicit notice and a continuing cursor instead of fake EOF', async () => {
  const earlier = line(message(0, 'Earlier question'));
  const giant = line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x'.repeat(18 * MiB) }] } });
  const f = fixture(Buffer.from(earlier + giant + line(message(1, 'Latest answer'))));
  try {
    const first = await f.read();
    assert.deepEqual(first.items.map(item => item.text), ['Latest answer']);
    assert.match(first.notice || '', /8 MB/); assert.ok(first.nextCursor);
    const position = decodeClaudePageCursor(first.nextCursor!);
    assert.equal(typeof position, 'object');
    assert.equal(typeof position === 'object' && position.skip, true);
    assert.ok(f.reads.reduce((sum, read) => sum + read.length, 0) < 9 * MiB, 'huge records are not allocated/read in full');
    const second = await f.read(first.nextCursor!);
    assert.deepEqual(second.items, []); assert.ok(second.nextCursor); assert.ok(second.notice);
    const third = await f.read(second.nextCursor!);
    assert.deepEqual(third.items.map(item => item.text), ['Earlier question']);
    assert.equal(third.nextCursor, null); assert.ok(third.notice);
  } finally { f.history.shutdown(); }
});

test('tool-only spans are bounded empty pages with a usable next cursor', async () => {
  const tool = line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x'.repeat(200 * 1024) }] } });
  const f = fixture(Buffer.from(line(message(0, 'Visible before tools')) + tool.repeat(60)));
  try {
    const first = await f.read();
    assert.deepEqual(first.items, []); assert.ok(first.nextCursor); assert.equal(first.notice, undefined);
    assert.ok(f.reads.reduce((sum, read) => sum + read.length, 0) < 9 * MiB);
    const second = await f.read(first.nextCursor!);
    assert.deepEqual(second.items.map(item => item.text), ['Visible before tools']);
    assert.equal(second.nextCursor, null);
  } finally { f.history.shutdown(); }
});

test('old pages cannot change current titles and cursor replacement is rejected', async () => {
  const data = Buffer.from(line({ type: 'custom-title', customTitle: 'Old title' }) + Array.from({ length: 110 }, (_, i) => line(message(i))).join('') + line({ type: 'custom-title', customTitle: 'Current title' }));
  const f = fixture(data);
  try {
    const first = await f.read();
    const second = await f.read(first.nextCursor!);
    const third = await f.read(second.nextCursor!);
    assert.equal(first.thread.title, 'Current title'); assert.equal(third.thread.title, 'Current title');
    const legacy = await f.read('50');
    assert.deepEqual(legacy.items.map(item => item.id), second.items.map(item => item.id));
    const replacement = Buffer.from(data);
    replacement[0] = 32;
    f.replace(replacement);
    await assert.rejects(f.read(first.nextCursor!), /변경/);
  } finally { f.history.shutdown(); }
});

test('snapshot fingerprints reject replaced prefixes even when the replacement grew, and reject another transcript binding', async () => {
  const data = Buffer.from(Array.from({ length: 110 }, (_, i) => line(message(i))).join(''));
  const f = fixture(data), other = fixture(data, 'other');
  try {
    const first = await f.read();
    assert.ok(first.nextCursor);
    await assert.rejects(other.read(first.nextCursor!), /변경/);
    const replacement = Buffer.from(data);
    replacement[0] = 32;
    f.replace(Buffer.concat([replacement, Buffer.from(line(message(110)))]));
    await assert.rejects(f.read(first.nextCursor!), /변경/);
  } finally { f.history.shutdown(); other.history.shutdown(); }
});

test('records keep latest UUID contents and hide unrelated sessions, metadata, tool output, and incomplete trailing writes', async () => {
  const f = fixture(Buffer.from([
    { type: 'assistant', uuid: 'reply', message: { content: 'Earlier snapshot' } },
    { type: 'user', uuid: 'question', message: { content: 'Visible question' } },
    { type: 'assistant', uuid: 'reply', message: { content: [{ type: 'thinking', thinking: 'Hidden' }, { type: 'text', text: 'Complete answer' }] } },
    { type: 'user', isMeta: true, message: { content: 'Hidden metadata' } },
    { type: 'assistant', sessionId: 'another-session', message: { content: 'Hidden different session' } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'Hidden tool output' }] } },
  ].map(line).join('') + '{"type":"assistant","message":'));
  try {
    const page = await f.read();
    assert.deepEqual(page.items.map(item => item.text), ['Visible question', 'Complete answer']);
    f.append('{"content":"Completed trailing write"}}\n');
    const updated = await f.read();
    assert.deepEqual(updated.items.map(item => item.text), ['Visible question', 'Complete answer', 'Completed trailing write']);
  } finally { f.history.shutdown(); }
});

test('malformed cursors fail before opening a connection and cancellation interrupts a bounded range read', async () => {
  let connections = 0;
  const invalid = new ClaudeHistory(async () => { connections++; throw new Error('unexpected connection'); });
  for (const cursor of ['-1', 'NaN', 'claude-v1.e30', 'claude-v1.' + 'a'.repeat(513)]) {
    await assert.rejects(invalid.read(remote, undefined, 'large', cursor), /잘못된/);
  }
  assert.equal(connections, 0); invalid.shutdown();
  const f = fixture(Buffer.from(Array.from({ length: 100 }, (_, i) => line(message(i))).join('')));
  try {
    await f.history.list(remote, 'synthetic-password');
    const original = f.reader.read;
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    f.reader.read = async (...args) => { entered(); await new Promise<void>(resolve => { release = resolve; }); return original(...args); };
    const pending = f.read();
    await waiting;
    f.history.close(remote.id); release();
    await assert.rejects(pending, /closed/);
    assert.ok(f.closes() >= 2);
  } finally { f.history.shutdown(); }
});

test('activity pages remain bounded, preserve partial turns and never serialize large image/tool payloads', async () => {
  const rows = [
    { type: 'user', uuid: 'question', sessionId: 'large', message: { content: 'Inspect the build' } },
    ...Array.from({ length: 320 }, (_, i) => ({ type: 'assistant', uuid: `tool-${i}`, sessionId: 'large', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: `/fixture/${i}.ts`, ignoredImage: 'image-base64-that-is-not-text' } }], stop_reason: 'tool_use' } })),
    { type: 'user', uuid: 'tool-output', sessionId: 'large', message: { content: [{ type: 'tool_result', content: 'x'.repeat(2 * MiB) }] } },
    { type: 'assistant', uuid: 'final', sessionId: 'large', message: { content: 'Build inspected', stop_reason: 'end_turn' } },
  ];
  const f = fixture(Buffer.from(rows.map(line).join('')));
  try {
    const first = await f.history.read(remote, 'synthetic-password', 'large', undefined, { includeActivity: true });
    assert.ok(first.nextCursor);
    assert.deepEqual(first.items.map(item => item.id), ['final']);
    assert.equal(first.items[0].turnId, undefined, 'the absent user prompt must not be invented');
    assert.equal(first.items[0].turnStatus, 'completed');
    assert.ok(first.timeline!.filter(item => item.kind === 'tool').length <= 200);
    assert.ok(JSON.stringify(first).length < 100000);
    assert.ok(!JSON.stringify(first).includes('image-base64-that-is-not-text'));
    assert.ok(f.reads.every(read => read.length <= 256 * 1024));
    const older = await f.history.read(remote, 'synthetic-password', 'large', first.nextCursor!, { includeActivity: true });
    assert.equal(older.items[0].id, 'question');
    assert.ok(older.timeline!.every(item => item.turnId === 'claude-user:question'));
    assert.ok(older.timeline!.every(item => item.turnStatus === 'unknown'), 'a later-page completion must not be guessed');
    assert.equal(older.nextCursor, null);
    const allIds = [...older.timeline!, ...first.timeline!].map(item => item.id);
    assert.equal(new Set(allIds).size, allIds.length);
  } finally { f.history.shutdown(); }
});
