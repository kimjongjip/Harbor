import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HostConfig } from "../shared/types.js";
import type {
  TerminalWork,
  TerminalWorkSnapshot,
} from "../shared/host-insights.js";
import type { Files } from "./files.js";
import { shellQuote } from "./ssh.js";
const exec = promisify(execFile);

// Only executable/script/log basenames leave the host; command arguments may contain secrets.
export function taskName(command: string, executable = "process"): string {
  const files =
    command.match(
      /(?:[a-zA-Z0-9_./\\:-]+\.(?:py|sh|ps1|js|mjs|log|out|yaml|yml|json))(?=\s|["']|$)/g,
    ) || [];
  const base = (s: string) => s.split(/[\\/]/).pop()!.slice(0, 100);
  return [base(executable), ...files.slice(0, 3).map(base)]
    .filter((v, i, all) => all.indexOf(v) === i)
    .join(" · ");
}
export function workKind(
  task: string,
  gpu?: number,
): TerminalWork["kind"] | null {
  if (gpu !== undefined) return "gpu";
  if (/monitor|watch|tail|nvidia-smi|tensorboard/i.test(task)) return "monitor";
  if (/simulat|ramulator|gem5|gpgpu|accel.?sim|verilator|vvp/i.test(task))
    return "simulator";
  if (/python|\.py\b|\.sh\b|\.ps1\b|train|benchmark|torch|jupyter/i.test(task))
    return "background";
  return null;
}
const linuxProbe = `import os,json,hashlib,subprocess,re
scope=SCOPE
gpu={}
try:
 out=subprocess.run(['nvidia-smi','--query-compute-apps=pid,used_gpu_memory','--format=csv,noheader,nounits'],capture_output=True,text=True,timeout=3).stdout
 for line in out.splitlines():
  p,m=[x.strip() for x in line.split(',')[:2]]
  if p.isdigit() and m.isdigit(): gpu[int(p)]=gpu.get(int(p),0)+int(m)
except Exception: pass
jobs=[]
for p in [x for x in os.listdir('/proc') if x.isdigit()][:16384]:
 try:
  root='/proc/'+p
  if os.stat(root).st_uid!=os.getuid(): continue
  with open(root+'/environ','rb') as f: env=f.read(131072).split(b'\\0')
  token=next((x.split(b'=',1)[1] for x in env if x.startswith(b'HARBOR_SESSION_TOKEN=')),None)
  if not token or hashlib.sha256(token).hexdigest()!=scope: continue
  with open(root+'/cmdline','rb') as f: args=f.read(8192).decode('utf-8','replace').split('\\0')
  with open(root+'/stat') as f: fields=f.read().rsplit(')',1)[1].split()
  if fields[0]=='Z': continue
  exe=os.path.basename(args[0])
  names=[os.path.basename(x)[:100] for x in args[1:] if re.fullmatch(r'[a-zA-Z0-9_./:-]+\\.(py|sh|ps1|js|mjs|log|out|yaml|yml|json)',x)]
  if exe in ('watch','timeout'): names=[x for x in args[1:] if x in ('nvidia-smi','tail','top','htop')]+names
  job={'pid':int(p),'id':p+':'+fields[19],'task':' · '.join([exe]+names[:3])}
  if int(p) in gpu: job['memoryMiB']=gpu[int(p)]
  jobs.append(job)
 except (OSError,ValueError,IndexError): pass
print(json.dumps(jobs[:256]))`;

export class TerminalWorkMonitor {
  private cache = new Map<string, TerminalWorkSnapshot>();
  private pending = new Map<string, Promise<TerminalWorkSnapshot>>();
  constructor(private files: Files) {}
  read(
    host: HostConfig,
    terminalId: string,
    scope?: string,
    pid?: number,
  ): Promise<TerminalWorkSnapshot> {
    const key = JSON.stringify([host, terminalId, scope, pid]);
    const previous = this.cache.get(key);
    if (previous && Date.now() - previous.updatedAt < 10000)
      return Promise.resolve(previous);
    const pending = this.pending.get(key);
    if (pending) return pending;
    const promise = this.probe(host, scope, pid)
      .then((rows) => {
        const jobs: TerminalWork[] = rows
          .flatMap((row) => {
            const kind = workKind(row.task, row.memoryMiB);
            return kind ? [{ ...row, kind, state: "running" as const }] : [];
          })
          .slice(0, 32);
        for (const old of previous?.jobs || [])
          if (
            old.state === "running" &&
            !jobs.some((j) => j.id === old.id) &&
            jobs.length < 40
          )
            jobs.push({ ...old, state: "ended" });
        return { jobs, updatedAt: Date.now() };
      })
      .catch(() => ({
        jobs: previous?.jobs || [],
        updatedAt: Date.now(),
        error:
          "작업 정보를 읽지 못했습니다. 서버 연결·프로세스 조회 권한을 확인해주세요.",
      }))
      .then((result) => {
        this.cache.set(key, result);
        if (this.cache.size > 64)
          this.cache.delete(this.cache.keys().next().value!);
        return result;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }
  private async probe(
    host: HostConfig,
    scope?: string,
    pid?: number,
  ): Promise<Omit<TerminalWork, "kind" | "state">[]> {
    if (host.kind === "ssh") {
      if (!scope || !/^[a-f0-9]{64}$/.test(scope)) throw new Error("No scope");
      return JSON.parse(
        await this.files.researchCommand(
          host,
          `python3 -c ${shellQuote(`exec(${JSON.stringify(linuxProbe.replace("SCOPE", JSON.stringify(scope)))})`)}`,
        ),
      );
    }
    if (process.platform !== "win32" || !Number.isSafeInteger(pid) || !pid)
      throw new Error("No process scope");
    const script = `$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$all=@(Get-CimInstance Win32_Process);$ids=[Collections.Generic.HashSet[int]]::new();[void]$ids.Add(${pid});do{$added=$false;foreach($p in $all){if($ids.Contains([int]$p.ParentProcessId) -and $ids.Add([int]$p.ProcessId)){$added=$true}}}while($added);@($all|Where-Object{$_.ProcessId -ne ${pid} -and $ids.Contains([int]$_.ProcessId)}|Select-Object ProcessId,Name,CommandLine,CreationDate)|ConvertTo-Json -Compress`;
    const result = await exec(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { windowsHide: true, timeout: 8000, maxBuffer: 1024 * 1024 },
    );
    const raw = JSON.parse(result.stdout || "[]");
    const rows = Array.isArray(raw) ? raw : [raw];
    const memory = new Map<number, number>();
    try {
      const gpu = await exec(
        "nvidia-smi",
        [
          "--query-compute-apps=pid,used_gpu_memory",
          "--format=csv,noheader,nounits",
        ],
        { windowsHide: true, timeout: 3000, maxBuffer: 65536 },
      );
      for (const line of gpu.stdout.split(/\r?\n/)) {
        const [p, m] = line.split(",").map(Number);
        if (p > 0 && Number.isFinite(m))
          memory.set(p, (memory.get(p) || 0) + m);
      }
    } catch {
      /* No NVIDIA device is a normal CPU-only host. */
    }
    return rows.slice(0, 256).map((row) => ({
      id: `${row.ProcessId}:${row.CreationDate}`,
      pid: row.ProcessId,
      task: taskName(row.CommandLine || "", row.Name),
      ...(memory.has(row.ProcessId)
        ? { memoryMiB: memory.get(row.ProcessId) }
        : {}),
    }));
  }
}
