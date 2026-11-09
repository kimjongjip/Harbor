import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeHistory, parseClaudeHistory, type ClaudeHistoryReader } from './claude-history.js';
import type { HostConfig } from '../shared/types.js';
const host = { id: 'fixture', kind: 'local' } as HostConfig;
const jsonl = (rows: any[]) => rows.map(r => JSON.stringify(r)).join('\n');

test('saved conversation keeps earlier messages across compaction and resumed rendering', () => {
  const detail = parseClaudeHistory('fixture', 'native-session', jsonl([
    { type: 'user', uuid: 'old-user', message: { content: 'Earlier question' } },
    { type: 'assistant', uuid: 'old-answer', message: { content: 'Earlier answer' } },
    { type: 'system', subtype: 'compact_boundary' },
    { type: 'user', uuid: 'summary', isCompactSummary: true, message: { content: 'Continuation summary' } },
    { type: 'assistant', uuid: 'latest-answer', message: { content: 'Latest answer' } },
  ]), 42);
  assert.ok(detail.items.some(item => item.id === 'old-user' && item.text === 'Earlier question'));
  assert.ok(detail.items.some(item => item.id === 'old-answer' && item.text === 'Earlier answer'));
  assert.ok(detail.items.some(item => item.id === 'latest-answer' && item.text === 'Latest answer'));
});
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

test('IDE channel user prompts survive meta filtering without displaying their internal envelope', () => {
  const prompt = 'Question "quoted"\nC:\\fixture\\path';
  const envelope = { sender: { kind: 'user' }, userInput: { version: 1, requestId: 'fixture-request-1' }, text: prompt };
  const detail = parseClaudeHistory('fixture', 'native-session', jsonl([
    { type: 'user', uuid: 'channel-message', isMeta: true, message: { content: [{ type: 'text', text: `<channel source="harbor">${JSON.stringify(envelope)}</channel>` }] } },
    { type: 'user', uuid: 'peer-note', isMeta: true, message: { content: JSON.stringify({ sender: { kind: 'terminal' }, text: 'Peer note' }) } },
    { type: 'user', uuid: 'invalid-marker', isMeta: true, message: { content: JSON.stringify({ ...envelope, sender: { kind: 'terminal' } }) } },
    { type: 'assistant', uuid: 'normal-answer', message: { content: 'Normal answer' } },
  ]), 1);
  assert.deepEqual(detail.items.map(item => ({ id: item.id, text: item.text })), [
    { id: 'harbor-ide-user:fixture-request-1', text: prompt },
    { id: 'normal-answer', text: 'Normal answer' },
  ]);
  assert.equal(detail.thread.title, prompt);
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

test('live Claude detail reads appended and replaced JSONL without rescanning its cached catalog', async () => {
  let contents = Buffer.from(jsonl([{ type: 'user', uuid: 'u1', message: { content: 'Original question' } }]));
  let modified = 1, entries = 0, stats = 0;
  const reads: number[] = [];
  let statOverride: { directory: boolean; size: number; modified: number } | undefined;
  const reader: ClaudeHistoryReader = {
    root: '/claude/projects', join: (...parts) => parts.join('/'),
    async entries(directory) {
      entries++;
      return directory === this.root
        ? [{ name: 'project', directory: true, size: 0, modified: 0 }]
        : [{ name: 'live.jsonl', directory: false, size: contents.length, modified }];
    },
    async stat(file) {
      assert.equal(file, '/claude/projects/project/live.jsonl');
      stats++;
      return statOverride || { directory: false, size: contents.length, modified };
    },
    async read(_file, start, length) { reads.push(length); return contents.subarray(start, start + length).toString('utf8'); },
    close() {},
  };
  const history = new ClaudeHistory(async () => reader);
  try {
    await history.list(host);
    assert.equal(entries, 2);
    const originalSize = contents.length;
    contents = Buffer.concat([contents, Buffer.from('\n' + jsonl([{ type: 'assistant', uuid: 'a1', message: { content: 'New answer 한글' } }]))]);
    modified = 2;
    const appended = await history.read(host, undefined, 'live');
    assert.deepEqual(appended.items.map(item => item.text), ['Original question', 'New answer 한글']);
    assert.equal(appended.thread.updatedAt, 2);
    assert.ok(reads.some(length => length > originalSize));
    assert.ok(reads.includes(contents.length));

    contents = Buffer.from(jsonl([{ type: 'user', uuid: 'replacement', message: { content: 'Replaced' } }]));
    modified = 3;
    const replaced = await history.read(host, undefined, 'live');
    assert.deepEqual(replaced.items.map(item => item.text), ['Replaced']);
    assert.equal(replaced.thread.updatedAt, 3);
    assert.ok(reads.includes(contents.length));

    const pendingRecord = jsonl([{ type: 'assistant', uuid: 'next', message: { content: 'Completed after refresh' } }]);
    contents = Buffer.concat([contents, Buffer.from('\n' + pendingRecord.slice(0, -1))]);
    assert.deepEqual((await history.read(host, undefined, 'live')).items.map(item => item.text), ['Replaced']);
    contents = Buffer.concat([contents, Buffer.from(pendingRecord.slice(-1))]);
    assert.deepEqual((await history.read(host, undefined, 'live')).items.map(item => item.text), ['Replaced', 'Completed after refresh']);
    assert.equal(stats, 8);
    assert.equal(entries, 2, 'refresh must not enumerate all projects again');

    const readCount = reads.length;
    statOverride = { directory: true, size: 1, modified: 4 };
    await assert.rejects(history.read(host, undefined, 'live'), /파일을 읽을 수 없습니다/);
    statOverride = { directory: false, size: -1, modified: 4 };
    await assert.rejects(history.read(host, undefined, 'live'), /파일을 읽을 수 없습니다/);
    assert.equal(reads.length, readCount, 'invalid files must not be allocated/read');
    assert.equal(entries, 2);
  } finally { history.shutdown(); }
});

test('actual local reader honors CLAUDE_CONFIG_DIR in an isolated temporary folder', async () => {
  const fs = await import('node:fs/promises'); const os = await import('node:os'); const path = await import('node:path');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harbor-claude-history-')); const old = process.env.CLAUDE_CONFIG_DIR;
  try {
    process.env.CLAUDE_CONFIG_DIR = root; await fs.mkdir(path.join(root, 'projects', 'fixture'), { recursive: true });
    await fs.writeFile(path.join(root, 'projects', 'fixture', 'local-fixture.jsonl'), jsonl([{ type: 'user', cwd: '/fixture', message: { content: 'synthetic question' } }]));
    const history = new ClaudeHistory(); const page = await history.list(host); assert.equal(page.data.length, 1); assert.equal(page.data[0].provider, 'claude');
    assert.equal((await history.read(host, undefined, 'local-fixture')).items[0].text, 'synthetic question');
    await fs.appendFile(path.join(root, 'projects', 'fixture', 'local-fixture.jsonl'), '\n' + jsonl([{ type: 'assistant', message: { content: 'synthetic live answer' } }]));
    assert.deepEqual((await history.read(host, undefined, 'local-fixture')).items.map(item => item.text), ['synthetic question', 'synthetic live answer']);
    await fs.writeFile(path.join(root, 'projects', 'fixture', 'local-fixture.jsonl'), jsonl([{ type: 'user', message: { content: 'reset' } }]));
    assert.deepEqual((await history.read(host, undefined, 'local-fixture')).items.map(item => item.text), ['reset']);
    history.shutdown();
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

test('Claude resume titles prefer named sessions and AI titles before summaries and command wrappers', () => {
  const rows = [
    { type: 'user', sessionId: 'id', message: { content: '<command-name>/help</command-name><command-message>help</command-message><command-args></command-args>' } },
    { type: 'summary', sessionId: 'id', summary: 'Previous summary' },
    { type: 'ai-title', sessionId: 'id', aiTitle: '이전 자동 제목' },
    { type: 'ai-title', sessionId: 'id', aiTitle: '  서버 대화\n기록 수정  ' },
    { type: 'ai-title', sessionId: 'other', aiTitle: 'Wrong session title' },
    { type: 'custom-title', sessionId: 'id', isSidechain: true, customTitle: 'Wrong subagent title' },
  ];
  const parse = () => parseClaudeHistory('h', 'id', jsonl(rows), 1).thread;
  assert.equal(parse().title, '서버 대화 기록 수정');
  rows.push({ type: 'custom-title', sessionId: 'id', customTitle: '내가 정한 이름' } as any);
  assert.equal(parse().title, '내가 정한 이름');
  rows.push({ type: 'agent-name', sessionId: 'id', agentName: '리뷰 세션' } as any);
  assert.equal(parse().title, '리뷰 세션');
});

test('Claude fallback titles and previews skip local commands and preserve the original transcript', () => {
  const command = '<command-name>/resume</command-name><command-message>resume</command-message><command-args></command-args>';
  const rows = [
    { type: 'user', message: { content: '<local-command-caveat>Internal command note</local-command-caveat>' } },
    { type: 'user', message: { content: command } },
    { type: 'user', message: { content: '<local-command-stdout>Command output</local-command-stdout>' } },
    { type: 'user', isCompactSummary: true, message: { content: 'Compacted context' } },
    { type: 'user', message: { content: '컴파일 오류를 수정해줘' } },
  ];
  const detail = parseClaudeHistory('h', 'id', jsonl(rows), 1);
  assert.equal(detail.thread.title, '컴파일 오류를 수정해줘');
  assert.equal(detail.thread.preview, '컴파일 오류를 수정해줘');
  // The stored lines stay intact; display items name what the person did not type.
  assert.deepEqual(detail.items.map(item => ({ text: item.text, origin: item.origin, detail: item.detail })), [
    { text: '/resume', origin: 'command', detail: undefined },
    { text: 'Command output', origin: 'command-output', detail: undefined },
    { text: '이전 대화를 요약해 이어서 진행했습니다.', origin: 'system', detail: 'Compacted context' },
    { text: '컴파일 오류를 수정해줘', origin: undefined, detail: undefined },
  ]);
  assert.ok(jsonl(rows).includes(JSON.stringify(command).slice(1, -1)));
  assert.equal(parseClaudeHistory('h', 'id', jsonl([{ type: 'user', message: { content: '<command-name>/review</command-name><command-args>src/main.ts</command-args>' } }]), 1).thread.title, '/review src/main.ts');
});

test('catalog and detail retain the same AI-generated title from a long transcript tail', async () => {
  const rows = [
    { type: 'user', sessionId: 'id', cwd: '/project', message: { content: '<command-name>/help</command-name>' } },
    { type: 'assistant', sessionId: 'id', message: { content: 'filler'.repeat(24000) } },
    { type: 'user', sessionId: 'id', message: { content: '실제 작업 질문' } },
    { type: 'ai-title', sessionId: 'id', aiTitle: '긴 기록의 자동 제목' },
  ];
  const contents = Buffer.from(jsonl(rows));
  const reader: ClaudeHistoryReader = {
    root: '/claude/projects', join: (...parts) => parts.join('/'),
    async entries(dir) { return dir === this.root ? [{ name: 'project', directory: true, size: 0, modified: 1 }] : [{ name: 'id.jsonl', directory: false, size: contents.length, modified: 1 }]; },
    async read(_file, start, length) { return contents.subarray(start, start + length).toString(); },
    close() {},
  };
  const history = new ClaudeHistory(async () => reader);
  try {
    const listed = (await history.list(host)).data[0];
    assert.equal(listed.title, '긴 기록의 자동 제목');
    assert.equal(listed.preview, '실제 작업 질문');
    assert.equal((await history.read(host, undefined, 'id')).thread.title, listed.title);
    assert.equal((await history.list(host, undefined, { search: '자동 제목' })).data.length, 1);
  } finally { history.shutdown(); }
});

test('Claude timeline groups a native completed turn and keeps tools, image bytes and thinking out of Q/A', () => {
  const rows = [
    { type: 'user', uuid: 'q', sessionId: 'id', message: { content: [{ type: 'image', source: { data: 'private-image-bytes' } }] } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'q', message: { stop_reason: 'tool_use', content: [
      { type: 'thinking', thinking: 'private-thinking' },
      { type: 'text', text: 'Checking the files' },
      { type: 'tool_use', id: 't', name: 'Bash', input: { command: 'npm test', ignored: 'private-payload' } },
    ] } },
    { type: 'user', uuid: 'result', parentUuid: 'a1', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'Tests passed' }, { type: 'image', data: 'private-result-image' }] }] } },
    { type: 'assistant', uuid: 'a2', parentUuid: 'result', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Fixed the parser' }] } },
    { type: 'assistant', uuid: 'other', session_id: 'another-session', message: { stop_reason: 'end_turn', content: 'wrong session' } },
    { type: 'assistant', uuid: 'nested', parent_tool_use_id: 'nested-tool', message: { stop_reason: 'end_turn', content: 'nested answer' } },
  ];
  const normal = parseClaudeHistory('h', 'id', jsonl(rows), 1);
  assert.equal(normal.timeline, undefined);
  const detail = parseClaudeHistory('h', 'id', jsonl(rows), 1, { includeActivity: true });
  assert.deepEqual(detail.items.map(item => item.text), ['', 'Checking the files', 'Fixed the parser']);
  assert.equal(detail.items[0].imageCount, 1);
  assert.ok(detail.items.every(item => item.turnId === 'claude-user:q' && item.turnStatus === 'completed'));
  assert.deepEqual(detail.timeline!.map(item => item.kind), ['user', 'assistant', 'command', 'tool', 'assistant']);
  assert.equal(detail.items[1].phase, 'commentary');
  assert.equal(detail.items[2].phase, 'final_answer');
  assert.ok(!/private-|wrong session|nested answer/.test(JSON.stringify(detail)));
});

test('Claude null stop reasons, idle durations, interrupted and failed messages do not certify completion', () => {
  const detail = parseClaudeHistory('h', 'id', jsonl([
    { type: 'user', uuid: 'q', message: { content: 'First task' } },
    { type: 'assistant', uuid: 'a', message: { content: 'An answer-shaped block', stop_reason: null } },
    { type: 'system', subtype: 'turn_duration', durationMs: 1234 },
    { type: 'user', uuid: 'q2', message: { content: 'Second task' } },
    { type: 'assistant', uuid: 'b', aborted: true, message: { content: 'Partial', stop_reason: 'end_turn' } },
    { type: 'user', uuid: 'q3', message: { content: 'Third task' } },
    { type: 'assistant', uuid: 'c', isApiErrorMessage: true, message: { content: 'Error', stop_reason: 'end_turn' } },
  ]), 1, { includeActivity: true });
  assert.deepEqual(detail.items.filter(item => item.kind === 'assistant').map(item => item.turnStatus), ['unknown', 'interrupted', 'failed']);
  assert.ok(detail.items.every(item => item.phase !== 'final_answer'));
});

test('matching SDK end-turn results prove streamed final text but cannot complete another session', () => {
  const rows = [
    { type: 'user', uuid: 'q', message: { content: 'Task' } },
    { type: 'assistant', uuid: 'a', user_message_uuid: 'q', message: { content: 'Completed text', stop_reason: null } },
    { type: 'result', session_id: 'another', subtype: 'success', is_error: false, stop_reason: 'end_turn', user_message_uuid: 'q' },
  ];
  assert.equal(parseClaudeHistory('h', 'id', jsonl(rows), 1).items[1].turnStatus, 'unknown');
  rows.push({ type: 'result', session_id: 'id', subtype: 'success', is_error: false, stop_reason: 'end_turn', user_message_uuid: 'q' });
  const completed = parseClaudeHistory('h', 'id', jsonl(rows), 1);
  assert.equal(completed.items[1].turnStatus, 'completed');
  assert.equal(completed.items[1].phase, 'final_answer');
  rows.push({ type: 'assistant', uuid: 'continues', message: { content: 'More work', stop_reason: null } } as any);
  assert.ok(parseClaudeHistory('h', 'id', jsonl(rows), 1).items.every(item => item.turnStatus === 'unknown'));
});

test('Claude partial pages do not invent an earlier prompt or merge across a later real prompt', () => {
  const detail = parseClaudeHistory('h', 'id', jsonl([
    { type: 'assistant', uuid: 'prefix', message: { content: 'Earlier prompt is outside this page' } },
    { type: 'assistant', uuid: 'prefix-final', message: { content: 'Its answer', stop_reason: 'end_turn' } },
    { type: 'user', uuid: 'new', message: { content: 'New task' } },
    { type: 'assistant', uuid: 'new-answer', message: { content: 'Working', stop_reason: null } },
  ]), 1, { includeActivity: true });
  assert.equal(detail.items[0].turnId, undefined);
  assert.equal(detail.items[1].turnId, undefined);
  assert.equal(detail.items[0].turnStatus, 'unknown');
  assert.equal(detail.items[1].turnStatus, 'completed');
  assert.equal(detail.items[3].turnId, 'claude-user:new');
  assert.equal(detail.items[3].turnStatus, 'unknown');
});
