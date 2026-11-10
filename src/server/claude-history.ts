import * as fs from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import type { SFTPWrapper, Client } from 'ssh2';
import type { HostConfig } from '../shared/types.js';
import type { HistoryThread, HistoryPage, HistoryDetail, HistoryReadOptions } from '../shared/history.js';
import { passwordConnection } from './ssh-connect.js';
import { claudeHistoryFingerprint, decodeClaudePageCursor, encodeClaudePageCursor, readClaudeRecordsBackwards } from './claude-history-pages.js';
import { assembleClaudeHistory, belongsToClaudeSession, projectClaudeRecord, type ClaudeHistoryRecord } from './claude-history-items.js';
import { historyActivities } from './history-activity.js';
import { readSftpRange } from './sftp-range.js';
import { claudeUsageTail } from './terminal-usage.js';

const SAMPLE = 64 * 1024;
const validId = (id: string) => /^[a-zA-Z0-9_-]{1,150}$/.test(id);
const sessionKey = (hostId: string, id: string) => `${hostId}\0${id}`;
const call = <T>(fn: (cb: (e: Error | null | undefined, value: T) => void) => void) => new Promise<T>((resolve, reject) => fn((e, v) => e ? reject(e) : resolve(v)));
export interface ClaudeHistoryReader {
  root: string;
  join(...parts: string[]): string;
  entries(directory: string): Promise<{ name: string; directory: boolean; size: number; modified: number }[]>;
  stat?(file: string): Promise<{ directory: boolean; size: number; modified: number }>;
  read(file: string, start: number, length: number): Promise<string | Buffer>;
  close(): void;
}
async function connect(host: HostConfig, password?: string): Promise<ClaudeHistoryReader> {
  if (host.kind === 'local') return {
    root: path.join(process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude'), 'projects'),
    join: path.join,
    async entries(dir) { return Promise.all((await fs.readdir(dir, { withFileTypes: true })).map(async d => { const s = await fs.stat(path.join(dir, d.name)); return { name: d.name, directory: d.isDirectory(), size: s.size, modified: s.mtimeMs }; })); },
    async stat(file) { const s = await fs.stat(file); return { directory: !s.isFile(), size: s.size, modified: s.mtimeMs }; },
    async read(file, start, length) { const handle = await fs.open(file, 'r'); try { const b = Buffer.alloc(length); const { bytesRead } = await handle.read(b, 0, length, start); return b.subarray(0, bytesRead); } finally { await handle.close(); } },
    close() {},
  };
  const connection = await passwordConnection(host, password);
  try {
    const root = await remoteRoot(connection);
    const sftp = await call<SFTPWrapper>(cb => connection.sftp(cb));
    return {
      root: path.posix.join(root, 'projects'), join: path.posix.join,
      async entries(dir) { return (await call<any[]>(cb => sftp.readdir(dir, cb))).map(d => ({ name: d.filename, directory: d.attrs.isDirectory(), size: d.attrs.size, modified: d.attrs.mtime * 1000 })); },
      async stat(file) { const s = await call<import('ssh2').Stats>(cb => sftp.stat(file, cb)); return { directory: !s.isFile(), size: s.size, modified: s.mtime * 1000 }; },
      async read(file, start, length) { const h = await call<Buffer>(cb => sftp.open(file, 'r', cb)); try { return await readSftpRange((buffer, offset, size, position) => call<number>(cb => sftp.read(h, buffer, offset, size, position, (e, bytes) => cb(e, bytes))), start, length); } finally { await call<void>(cb => sftp.close(h, cb)); } },
      close() { connection.end(); },
    };
  } catch (e) { connection.end(); throw e; }
}
function remoteRoot(connection: Client): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { connection.end(); reject(new Error('Claude 설정 경로 조회 시간이 초과되었습니다.')); }, 10000);
    connection.exec('printf "\\nHARBOR_CLAUDE_ROOT=%s\\n" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"', (error, stream) => {
      if (error) { clearTimeout(timer); reject(error); return; }
      let output = '';
      stream.on('data', (b: Buffer) => { output += b.toString(); if (output.length > 16384) stream.close(); });
      stream.on('error', (e: Error) => { clearTimeout(timer); reject(e); });
      stream.on('close', () => { clearTimeout(timer); const root = output.match(/(?:^|\n)HARBOR_CLAUDE_ROOT=([^\r\n]+)/)?.[1]; root?.startsWith('/') ? resolve(root) : reject(new Error('Claude 설정 폴더의 절대경로를 확인할 수 없습니다.')); });
    });
  });
}
function records(text: string): any[] { return text.split('\n').flatMap(line => { try { const row = JSON.parse(line); return row && typeof row === 'object' && !Array.isArray(row) ? [row] : []; } catch { return []; } }); }
function messageText(row: any): string {
  const content = row.message?.content;
  return typeof content === 'string' ? content : Array.isArray(content) ? content.filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n') : '';
}
function ideUserInput(row: any): { requestId: string; text: string } | undefined {
  if (row.type !== 'user') return;
  const text = messageText(row).trim();
  const channel = text.match(/^<channel(?:\s[^>]*)?>([\s\S]*)<\/channel>$/);
  try {
    const value = JSON.parse(channel ? channel[1] : text);
    if (value?.userInput?.version === 1 && value?.sender?.kind === 'user' &&
      typeof value.userInput.requestId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value.userInput.requestId) &&
      typeof value.text === 'string' && value.text.trim() && value.text.length <= 16000)
      return { requestId: value.userInput.requestId, text: value.text };
  } catch { /* Ordinary transcript content is not a channel envelope. */ }
}
function titlePrompt(row: any): { text: string; command: boolean } {
  const text = (ideUserInput(row)?.text || messageText(row)).trim();
  if (row.isCompactSummary || /^<local-command-(?:caveat|stdout|stderr)>/.test(text)) return { text: '', command: false };
  const command = text.match(/<command-name>([\s\S]*?)<\/command-name>/)?.[1]?.trim();
  if (command) {
    const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim();
    return { text: [command, args].filter(Boolean).join(' '), command: true };
  }
  return { text, command: false };
}
export function parseClaudeHistory(hostId: string, id: string, text: string, modified: number, options: HistoryReadOptions = {}): HistoryDetail {
  const rows = records(text).filter(r => belongsToClaudeSession(r, id));
  const deduplicated = new Map<string, any>();
  let anonymous = 0;
  for (const row of rows) {
    const key = typeof row.uuid === 'string' ? row.uuid : `anonymous-${anonymous++}`;
    deduplicated.delete(key); deduplicated.set(key, row);
  }
  const visible = [...deduplicated.values()].filter(r => !r.isSidechain && (!r.isMeta || ideUserInput(r)) && ['user', 'assistant'].includes(r.type) && messageText(r));
  const metadata = (type: string, field: string) => {
    const value = rows.filter(r => !r.isSidechain && r.type === type && typeof r[field] === 'string').at(-1)?.[field];
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  };
  const prompts = visible.filter(r => r.type === 'user').map(titlePrompt);
  const preview = (prompts.find(p => p.text && !p.command)?.text || prompts.find(p => p.text)?.text || '').slice(0, 300);
  // Claude 2.1.258's resume picker prefers agent name, custom name, AI title, summary, then a prompt.
  const title = metadata('agent-name', 'agentName') || metadata('custom-title', 'customTitle') || metadata('ai-title', 'aiTitle') || metadata('summary', 'summary') || preview || 'Claude 대화';
  const projected = [...deduplicated.values()].flatMap((row, index) => {
    const record = projectClaudeRecord(row, typeof row.uuid === 'string' ? row.uuid : `${id}-${index}`, messageText(row), ideUserInput(row), !!options.includeActivity);
    return record ? [record] : [];
  });
  const { activityOmitted, ...messages } = assembleClaudeHistory(projected, !!options.includeActivity);
  return {
    thread: { id, hostId, provider: 'claude', title: title.slice(0, 180), cwd: rows.find(r => typeof r.cwd === 'string')?.cwd || '', preview, updatedAt: modified, source: 'claude', active: false },
    ...messages, nextCursor: null,
    ...(activityOmitted ? { notice: '개별 기록 하나의 작업 항목이 2,048개를 넘어 일부를 표시하지 않았습니다. 원본 기록은 유지됩니다.' } : {}),
  };
}
const titleFields = { 'agent-name': 'agentName', 'custom-title': 'customTitle', 'ai-title': 'aiTitle', summary: 'summary' } as const;
type Titles = Partial<Record<keyof typeof titleFields, string>>;
function titleValues(text: string, id: string): Titles {
  const titles: Titles = {};
  for (const row of records(text)) {
    if (!belongsToClaudeSession(row, id)) continue;
    const field = titleFields[row.type as keyof Titles];
    if (field && typeof row[field] === 'string') titles[row.type as keyof Titles] = row[field].replace(/\s+/g, ' ').trim().slice(0, 180);
  }
  return titles;
}
type Entry = { file: string; size: number; thread: HistoryThread; titles: Titles };
interface Lease { key: string; generation: number; reader: Promise<ClaudeHistoryReader>; busy: number; timer?: NodeJS.Timeout }
export class ClaudeHistory {
  private active = new Map<ClaudeHistoryReader, string>();
  private stopped = false;
  private generations = new Map<string, number>();
  private cache = new Map<string, { time: number; entries: Entry[] }>();
  // A running session is re-read every few seconds. Keep its file and the SSH
  // connection instead of rescanning every project or reconnecting each time.
  private sessions = new Map<string, Entry>();
  private usageFiles = new Map<string, string>();
  private leases = new Map<string, Lease>();
  constructor(private readonly create = connect, private readonly idleMs = 60_000) {}
  private release(hostId: string, lease: Lease) {
    if (this.leases.get(hostId) === lease) this.leases.delete(hostId);
    clearTimeout(lease.timer);
    void lease.reader.then(reader => { this.active.delete(reader); reader.close(); }).catch(() => {});
  }
  private async using<T>(host: HostConfig, password: string | undefined, fn: (reader: ClaudeHistoryReader) => Promise<T>): Promise<T> {
    if (this.stopped) throw new Error('Claude history connection is closed.');
    const generation = this.generations.get(host.id) || 0;
    if (host.kind !== 'ssh') {
      const r = await this.create(host, password);
      if (this.stopped || generation !== (this.generations.get(host.id) || 0)) { r.close(); throw new Error('Claude history connection is closed.'); }
      this.active.set(r, host.id);
      let timer: NodeJS.Timeout | undefined;
      try { return await Promise.race([fn(r), new Promise<never>((_, reject) => { timer = setTimeout(() => { r.close(); reject(new Error('Claude history lookup timed out.')); }, 60000); })]); }
      finally { clearTimeout(timer); this.active.delete(r); r.close(); }
    }
    const key = JSON.stringify([host.address, host.username, host.port, host.identityFile]);
    let lease = this.leases.get(host.id);
    if (lease && (lease.key !== key || lease.generation !== generation)) { this.release(host.id, lease); lease = undefined; }
    if (!lease) {
      const created: Lease = { key, generation, busy: 0, reader: this.create(host, password) };
      created.reader.then(reader => {
        if (this.leases.get(host.id) === created) this.active.set(reader, host.id);
        else reader.close();
      }, () => this.release(host.id, created));
      this.leases.set(host.id, lease = created);
    }
    const current = lease;
    clearTimeout(current.timer);
    current.busy++;
    let timer: NodeJS.Timeout | undefined;
    try {
      const r = await current.reader;
      if (this.stopped || generation !== (this.generations.get(host.id) || 0) || this.leases.get(host.id) !== current || !this.active.has(r))
        throw new Error('Claude history connection is closed.');
      return await Promise.race([fn(r), new Promise<never>((_, reject) => { timer = setTimeout(() => { this.release(host.id, current); reject(new Error('Claude history lookup timed out.')); }, 60000); })]);
    } catch (error) {
      // A failed read may leave the SSH channel unusable; never reuse it.
      this.release(host.id, current);
      throw error;
    } finally {
      clearTimeout(timer);
      current.busy--;
      if (!current.busy && this.leases.get(host.id) === current) {
        current.timer = setTimeout(() => this.release(host.id, current), this.idleMs);
        current.timer.unref?.();
      }
    }
  }
  private async locate(reader: ClaudeHistoryReader, hostId: string, id: string, fresh = false): Promise<Entry> {
    const key = sessionKey(hostId, id);
    const known = fresh ? undefined : this.sessions.get(key);
    if (known) return known;
    if (fresh) this.cache.delete(hostId);
    const entry = (await this.catalog(reader, hostId)).find(e => e.thread.id === id);
    if (!entry) throw new Error('Claude 대화 기록을 찾을 수 없습니다.');
    this.remember(key, entry);
    return entry;
  }
  private remember(key: string, entry: Entry) {
    this.sessions.delete(key);
    this.sessions.set(key, entry);
    if (this.sessions.size > 256) this.sessions.delete(this.sessions.keys().next().value!);
  }
  private async catalog(reader: ClaudeHistoryReader, hostId: string): Promise<Entry[]> {
    const cached = this.cache.get(hostId);
    if (cached && Date.now() - cached.time < 10000) return cached.entries;
    let dirs; try { dirs = await reader.entries(reader.root); } catch (e: any) { if (e.code === 'ENOENT' || e.code === 2) return []; throw e; }
    const result: Entry[] = [];
    if (dirs.filter(d => d.directory).length > 2000) throw new Error('Claude history exceeds the 2,000 project limit.');
    for (const dir of dirs.filter(d => d.directory)) {
      const base = reader.join(reader.root, dir.name);
      const files = await reader.entries(base);
      const visible = files.filter(f => !f.directory && f.name.endsWith('.jsonl') && validId(f.name.slice(0, -6)));
      if (result.length + visible.length > 5000) throw new Error('Claude history exceeds the 5,000 session limit.');
      for (let offset = 0; offset < visible.length; offset += 8) {
        const batch = await Promise.all(visible.slice(offset, offset + 8).map(async file => {
          if (!this.active.has(reader)) throw new Error('Claude history connection is closed.');
          const full = reader.join(base, file.name);
          const head = await reader.read(full, 0, Math.min(SAMPLE, file.size));
          if (records(head.toString()).some(r => r.isSidechain)) return null;
          const tail = file.size > SAMPLE ? await reader.read(full, Math.max(SAMPLE, file.size - SAMPLE), Math.min(SAMPLE, file.size - SAMPLE)) : '';
          const sample = head + '\n' + tail, id = file.name.slice(0, -6);
          return { file: full, size: file.size, thread: parseClaudeHistory(hostId, id, sample, file.modified).thread, titles: titleValues(sample, id) };
        }));
        for (const entry of batch) if (entry) result.push(entry);
      }
    }
    result.sort((a, b) => b.thread.updatedAt - a.thread.updatedAt || a.thread.id.localeCompare(b.thread.id));
    if (this.active.has(reader)) this.cache.set(hostId, { time: Date.now(), entries: result });
    return result;
  }
  async list(host: HostConfig, password?: string, options: { cursor?: string; search?: string; archived?: boolean; includeAutomation?: boolean } = {}): Promise<HistoryPage> {
    if (options.archived) throw new Error('Claude 대화 기록은 보관함을 지원하지 않습니다.');
    return this.using(host, password, async r => { const search = options.search?.toLocaleLowerCase(); const all = (await this.catalog(r, host.id)).filter(e => !search || [e.thread.title, e.thread.cwd, e.thread.preview].some(t => t.toLocaleLowerCase().includes(search))); const offset = this.offset(options.cursor); return { data: all.slice(offset, offset + 50).map(e => e.thread), nextCursor: offset + 50 < all.length ? String(offset + 50) : null }; });
  }
  private offset(cursor?: string) { if (cursor && !/^\d{1,8}$/.test(cursor)) throw new Error('잘못된 Claude 기록 페이지입니다.'); return Number(cursor || 0); }
  noteTranscript(hostId: string, id: string, file: string) {
    if (!validId(id) || !file || file.length > 4096 || /[\0\r\n]/.test(file)) return;
    const key = sessionKey(hostId, id);
    this.usageFiles.delete(key);
    this.usageFiles.set(key, file);
    if (this.usageFiles.size > 256) this.usageFiles.delete(this.usageFiles.keys().next().value!);
  }
  async usage(host: HostConfig, password: string | undefined, id: string, cwd?: string) {
    if (!validId(id)) throw new Error('Invalid Claude session');
    const key = sessionKey(host.id, id);
    const entry = this.sessions.get(key) || this.cache.get(host.id)?.entries.find(e => e.thread.id === id);
    const hint = this.usageFiles.get(key);
    // The first usage read must work without a history preview/catalog. Native
    // hook paths take precedence; older sessions can try their one known cwd.
    // Neither path performs an all-project scan on a status tick.
    if (!entry && !hint && !cwd) return null;
    return this.using(host, password, async r => {
      const normalize = (value: string) => {
        const normalized = r.join(value).replaceAll('\\', '/');
        return host.kind === 'local' && process.platform === 'win32' ? normalized.toLowerCase() : normalized;
      };
      const root = normalize(r.root).replace(/\/$/, '');
      const permitted = (file: string) => {
        const candidate = normalize(file);
        const filename = host.kind === 'local' && process.platform === 'win32' ? id.toLowerCase() : id;
        return candidate.startsWith(root + '/') && !candidate.split('/').includes('..') && candidate.endsWith('/' + filename + '.jsonl');
      };
      const project = cwd && cwd.length <= 4096 && !/[\0\r\n]/.test(cwd) ? cwd.replace(/[^a-zA-Z0-9]/g, '-') : undefined;
      const file = (hint && permitted(hint) ? hint : undefined) || entry?.file || (project ? r.join(r.root, project, `${id}.jsonl`) : undefined);
      if (!file || !permitted(file) || (!r.stat && !entry)) return null;
      let stat;
      try { stat = r.stat ? await r.stat(file) : { directory: false, size: entry!.size, modified: entry!.thread.updatedAt }; }
      catch (error: any) {
        if (error.code !== 'ENOENT' && error.code !== 2) throw error;
        this.usageFiles.delete(key);
        return null;
      }
      if (stat.directory || !Number.isSafeInteger(stat.size) || stat.size < 0) return null;
      this.noteTranscript(host.id, id, file);
      const start = Math.max(0, stat.size - 256 * 1024);
      const text = (await r.read(file, start, stat.size - start)).toString();
      return claudeUsageTail(id, start ? text.slice(text.indexOf('\n') + 1) : text, stat.modified);
    });
  }
  async read(host: HostConfig, password: string | undefined, id: string, cursor?: string, options: HistoryReadOptions = {}): Promise<HistoryDetail> {
    if (!validId(id)) throw new Error('잘못된 Claude 세션 ID입니다.');
    const page = decodeClaudePageCursor(cursor);
    return this.using(host, password, async r => {
      let entry = await this.locate(r, host.id, id);
      // The catalog may be cached, but an attached CLI appends to its transcript
      // continuously. Stat only this file so refresh sees new messages without
      // scanning every project again. Also honor truncation/replacement.
      const stat = async () => r.stat ? await r.stat(entry.file) : { directory: false, size: entry.size, modified: entry.thread.updatedAt };
      let current;
      try { current = await stat(); } catch (error: any) {
        // A remembered transcript can move or disappear; look it up once more.
        if (error?.code !== 'ENOENT' && error?.code !== 2) throw error;
        this.sessions.delete(sessionKey(host.id, id));
        entry = await this.locate(r, host.id, id, true);
        current = await stat();
      }
      if (current.directory || !Number.isSafeInteger(current.size) || current.size < 0) throw new Error('Claude 대화 기록 파일을 읽을 수 없습니다.');
      const alive = () => { if (!this.active.has(r)) throw new Error('Claude history connection is closed.'); };
      const read = async (start: number, length: number) => { alive(); const bytes = await r.read(entry.file, start, length); alive(); return bytes; };
      const snapshot = typeof page === 'number' ? { at: current.size, size: current.size, modified: current.modified, skip: false, remaining: page } : page;
      const changed = () => new Error('Claude 기록 파일이 변경됐습니다. 새로고침해 주세요.');
      if (current.size < snapshot.size || (current.size === snapshot.size && current.modified !== snapshot.modified)) throw changed();
      const fingerprint = await claudeHistoryFingerprint(read, snapshot.size, `${host.id}\0${id}\0${entry.file}`);
      if (typeof page !== 'number' && fingerprint !== page.fingerprint) throw changed();

      // The catalog stays cached, but titles/cwd may have changed in an active
      // transcript. Refresh just its bounded head/tail sample, never the file.
      let thread = entry.thread, titles = entry.titles;
      if (current.size !== entry.size || current.modified !== entry.thread.updatedAt) {
        const head = await read(0, Math.min(SAMPLE, current.size));
        const tail = current.size > SAMPLE ? await read(Math.max(SAMPLE, current.size - SAMPLE), Math.min(SAMPLE, current.size - SAMPLE)) : '';
        const sample = head + '\n' + tail;
        thread = parseClaudeHistory(host.id, id, sample, current.modified).thread;
        titles = titleValues(sample, id);
        this.remember(sessionKey(host.id, id), { file: entry.file, size: current.size, thread, titles });
      }
      const projected: ClaudeHistoryRecord[] = [], seen = new Set<string>(), latestTitles: Titles = {};
      let remaining = snapshot.remaining, fallbackCwd = '', visibleCount = 0, activityCount = 0;
      const scanned = await readClaudeRecordsBackwards(read, snapshot.at, snapshot.skip, alive, (line, start) => {
        let row: any; try { row = JSON.parse(line.toString('utf8')); } catch { return false; }
        if (!belongsToClaudeSession(row, id)) return false;
        if (!row.isSidechain) {
          const field = titleFields[row.type as keyof Titles];
          if (field && latestTitles[row.type as keyof Titles] === undefined && typeof row[field] === 'string') latestTitles[row.type as keyof Titles] = row[field].replace(/\s+/g, ' ').trim().slice(0, 180);
          if (typeof row.cwd === 'string') fallbackCwd = row.cwd;
        }
        if (typeof row.uuid === 'string') { if (seen.has(row.uuid)) return false; seen.add(row.uuid); }
        const input = ideUserInput(row);
        const record = projectClaudeRecord(row, typeof row.uuid === 'string' ? row.uuid : `${id}-byte-${start}`, messageText(row), input, !!options.includeActivity);
        if (!record) return false;
        const visible = record.items.some(item => item.kind === 'user' || item.kind === 'assistant');
        if (remaining > 0) { if (visible) remaining--; return false; }
        projected.push(record);
        if (visible) visibleCount++;
        activityCount += record.items.filter(item => item.kind !== 'user' && item.kind !== 'assistant').length;
        return visibleCount >= 50 || (options.includeActivity === true && activityCount >= 250);
      });
      const after = r.stat ? await r.stat(entry.file) : current;
      if (after.directory || after.size < snapshot.size || (after.size === snapshot.size && after.modified !== snapshot.modified) || await claudeHistoryFingerprint(read, snapshot.size, `${host.id}\0${id}\0${entry.file}`) !== fingerprint) throw changed();
      const combined = snapshot.at === snapshot.size ? { ...titles, ...latestTitles } : { ...latestTitles, ...titles };
      const { activityOmitted, ...messages } = assembleClaudeHistory(projected.reverse(), !!options.includeActivity);
      if (messages.timeline) {
        // The newest work (often a running turn) gets the preview budget first.
        messages.timeline = historyActivities.previewAll(host, 'claude', id, messages.timeline, item => item.kind !== 'user' && item.kind !== 'assistant');
      }
      const notice = [
        scanned.oversized ? '8 MB를 넘는 개별 기록 항목은 표시하지 않았습니다. 원본 파일은 유지되며 이전 대화를 계속 불러올 수 있습니다.' : '',
        activityOmitted ? '개별 기록 하나의 작업 항목이 2,048개를 넘어 일부를 표시하지 않았습니다. 원본 기록은 유지됩니다.' : '',
      ].filter(Boolean).join(' ');
      return {
        thread: { ...thread, updatedAt: current.modified, cwd: thread.cwd || fallbackCwd, title: Object.keys(titleFields).map(type => combined[type as keyof Titles]).find(Boolean) || thread.title },
        ...messages,
        nextCursor: scanned.at > 0 ? encodeClaudePageCursor({ at: scanned.at, size: snapshot.size, modified: snapshot.modified, fingerprint, skip: scanned.skip, remaining }) : null,
        ...(notice ? { notice } : {}),
      };
    });
  }
  async summary(host: HostConfig, password: string | undefined, id: string): Promise<HistoryThread> { if (!validId(id)) throw new Error('Invalid Claude session ID.'); return this.using(host, password, async r => { const entry = (await this.catalog(r, host.id)).find(e => e.thread.id === id); if (!entry) throw new Error('Claude 대화 기록을 찾을 수 없습니다.'); return entry.thread; }); }
  close(hostId: string) {
    this.generations.set(hostId, (this.generations.get(hostId) || 0) + 1);
    this.cache.delete(hostId);
    const lease = this.leases.get(hostId);
    if (lease) this.release(hostId, lease);
    for (const key of this.sessions.keys()) if (key.startsWith(sessionKey(hostId, ''))) this.sessions.delete(key);
    for (const key of this.usageFiles.keys()) if (key.startsWith(sessionKey(hostId, ''))) this.usageFiles.delete(key);
    for (const [reader, id] of this.active) if (id === hostId) { this.active.delete(reader); reader.close(); }
  }
  shutdown() { this.stopped = true; for (const [hostId, lease] of this.leases) this.release(hostId, lease); for (const reader of this.active.keys()) reader.close(); this.active.clear(); this.cache.clear(); this.sessions.clear(); this.usageFiles.clear(); }
}
