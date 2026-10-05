import * as fs from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import type { SFTPWrapper, Client } from 'ssh2';
import type { HostConfig, MessageItem } from '../shared/types.js';
import type { HistoryThread, HistoryPage, HistoryDetail } from '../shared/history.js';
import { passwordConnection } from './ssh-connect.js';

const SAMPLE = 64 * 1024, MAX_DETAIL = 16 * 1024 * 1024;
const validId = (id: string) => /^[a-zA-Z0-9_-]{1,150}$/.test(id);
const call = <T>(fn: (cb: (e: Error | null | undefined, value: T) => void) => void) => new Promise<T>((resolve, reject) => fn((e, v) => e ? reject(e) : resolve(v)));
export interface ClaudeHistoryReader {
  root: string;
  join(...parts: string[]): string;
  entries(directory: string): Promise<{ name: string; directory: boolean; size: number; modified: number }[]>;
  read(file: string, start: number, length: number): Promise<string>;
  close(): void;
}
async function connect(host: HostConfig, password?: string): Promise<ClaudeHistoryReader> {
  if (host.kind === 'local') return {
    root: path.join(process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude'), 'projects'),
    join: path.join,
    async entries(dir) { return Promise.all((await fs.readdir(dir, { withFileTypes: true })).map(async d => { const s = await fs.stat(path.join(dir, d.name)); return { name: d.name, directory: d.isDirectory(), size: s.size, modified: s.mtimeMs }; })); },
    async read(file, start, length) { const handle = await fs.open(file, 'r'); try { const b = Buffer.alloc(length); const { bytesRead } = await handle.read(b, 0, length, start); return b.subarray(0, bytesRead).toString('utf8'); } finally { await handle.close(); } },
    close() {},
  };
  const connection = await passwordConnection(host, password);
  try {
    const root = await remoteRoot(connection);
    const sftp = await call<SFTPWrapper>(cb => connection.sftp(cb));
    return {
      root: path.posix.join(root, 'projects'), join: path.posix.join,
      async entries(dir) { return (await call<any[]>(cb => sftp.readdir(dir, cb))).map(d => ({ name: d.filename, directory: d.attrs.isDirectory(), size: d.attrs.size, modified: d.attrs.mtime * 1000 })); },
      async read(file, start, length) { const h = await call<Buffer>(cb => sftp.open(file, 'r', cb)); try { const b = Buffer.alloc(length); let count = 0; while (count < length) { const n = await call<number>(cb => sftp.read(h, b, count, Math.min(32768, length - count), start + count, (e, bytes) => cb(e, bytes))); if (!n) break; count += n; } return b.subarray(0, count).toString('utf8'); } finally { await call<void>(cb => sftp.close(h, cb)); } },
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
export function parseClaudeHistory(hostId: string, id: string, text: string, modified: number): HistoryDetail {
  const rows = records(text).filter(r => !r.sessionId || r.sessionId === id);
  const deduplicated = new Map<string, any>();
  let anonymous = 0;
  for (const row of rows) deduplicated.set(typeof row.uuid === 'string' ? row.uuid : `anonymous-${anonymous++}`, row);
  const visible = [...deduplicated.values()].filter(r => !r.isSidechain && !r.isMeta && ['user', 'assistant'].includes(r.type) && messageText(r));
  const first = visible.find(r => r.type === 'user');
  const custom = rows.filter(r => r.type === 'custom-title' && typeof r.customTitle === 'string').at(-1)?.customTitle;
  const summary = rows.filter(r => r.type === 'summary' && typeof r.summary === 'string').at(-1)?.summary;
  const preview = messageText(first || {}).slice(0, 300);
  return {
    thread: { id, hostId, provider: 'claude', title: (custom || summary || preview || 'Claude 대화').slice(0, 180), cwd: rows.find(r => typeof r.cwd === 'string')?.cwd || '', preview, updatedAt: modified, source: 'claude', active: false },
    items: visible.map((r, i) => ({ id: String(r.uuid || `${id}-${i}`), kind: r.type, text: messageText(r), imageCount: Array.isArray(r.message?.content) ? r.message.content.filter((p: any) => p?.type === 'image').length : 0 } as MessageItem)), nextCursor: null,
  };
}
type Entry = { file: string; size: number; thread: HistoryThread };
export class ClaudeHistory {
  private active = new Map<ClaudeHistoryReader, string>();
  private stopped = false;
  private generations = new Map<string, number>();
  private cache = new Map<string, { time: number; entries: Entry[] }>();
  constructor(private readonly create = connect) {}
  private async using<T>(host: HostConfig, password: string | undefined, fn: (reader: ClaudeHistoryReader) => Promise<T>): Promise<T> {
    if (this.stopped) throw new Error('Claude history connection is closed.');
    const generation = this.generations.get(host.id) || 0;
    const r = await this.create(host, password);
    if (this.stopped || generation !== (this.generations.get(host.id) || 0)) { r.close(); throw new Error('Claude history connection is closed.'); }
    this.active.set(r, host.id);
    let timer: NodeJS.Timeout | undefined;
    try { return await Promise.race([fn(r), new Promise<never>((_, reject) => { timer = setTimeout(() => { r.close(); reject(new Error('Claude history lookup timed out.')); }, 60000); })]); }
    finally { clearTimeout(timer); this.active.delete(r); r.close(); }
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
          if (records(head).some(r => r.isSidechain)) return null;
          const tail = file.size > SAMPLE ? await reader.read(full, Math.max(SAMPLE, file.size - SAMPLE), Math.min(SAMPLE, file.size - SAMPLE)) : '';
          return { file: full, size: file.size, thread: parseClaudeHistory(hostId, file.name.slice(0, -6), head + '\n' + tail, file.modified).thread };
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
  async read(host: HostConfig, password: string | undefined, id: string, cursor?: string): Promise<HistoryDetail> {
    if (!validId(id)) throw new Error('잘못된 Claude 세션 ID입니다.');
    return this.using(host, password, async r => { const entry = (await this.catalog(r, host.id)).find(e => e.thread.id === id); if (!entry) throw new Error('Claude 대화 기록을 찾을 수 없습니다.'); if (entry.size > MAX_DETAIL) throw new Error('이 Claude 기록은 16 MB를 초과합니다. 터미널에서 이어서 확인하세요.'); const detail = parseClaudeHistory(host.id, id, await r.read(entry.file, 0, entry.size), entry.thread.updatedAt); const offset = this.offset(cursor), end = Math.max(0, detail.items.length - offset), start = Math.max(0, end - 50); return { ...detail, items: detail.items.slice(start, end), nextCursor: start > 0 ? String(offset + 50) : null }; });
  }
  async summary(host: HostConfig, password: string | undefined, id: string): Promise<HistoryThread> { if (!validId(id)) throw new Error('Invalid Claude session ID.'); return this.using(host, password, async r => { const entry = (await this.catalog(r, host.id)).find(e => e.thread.id === id); if (!entry) throw new Error('Claude 대화 기록을 찾을 수 없습니다.'); return entry.thread; }); }
  close(hostId: string) {
    this.generations.set(hostId, (this.generations.get(hostId) || 0) + 1);
    this.cache.delete(hostId);
    for (const [reader, id] of this.active) if (id === hostId) { this.active.delete(reader); reader.close(); }
  }
  shutdown() { this.stopped = true; for (const reader of this.active.keys()) reader.close(); this.active.clear(); this.cache.clear(); }
}
