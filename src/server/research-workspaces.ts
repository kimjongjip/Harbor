import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, stat } from "node:fs/promises";
import { isAbsolute, join, resolve, posix } from "node:path";
import { randomUUID } from "node:crypto";
import type { HostConfig } from "../shared/types.js";
import { shellQuote } from "./ssh.js";
const exec = promisify(execFile);

export async function researchDirectory(cwd: string): Promise<string> {
  if (!isAbsolute(cwd) || /[\x00-\x1f]/.test(cwd))
    throw new Error("연구할 로컬 폴더의 절대경로를 입력하세요.");
  const path = resolve(cwd);
  if (!(await stat(path)).isDirectory())
    throw new Error("연구할 폴더를 확인하세요.");
  return path;
}

/** Local-only setup. No network requests and no changes to the user's current worktree. */
export async function prepareResearchWorkspaces(
  directory: string,
  cwd: string,
  kind: "ideas" | "code" | "research",
  agents: Array<"claude" | "codex"> = ["claude", "codex"],
) {
  cwd = await researchDirectory(cwd);
  const root = join(directory, "research-workspaces", randomUUID());
  await mkdir(root, { recursive: true });
  const folders = agents.map((agent) => join(root, agent));
  if (kind !== "code") {
    await Promise.all(folders.map((path) => mkdir(path, { recursive: true })));
    return { folders };
  }
  const git = async (...args: string[]) =>
    (
      await exec("git", args, {
        cwd,
        windowsHide: true,
        timeout: 30000,
        maxBuffer: 1024 * 1024,
      })
    ).stdout.trim();
  let repository: string;
  try {
    repository = await git("rev-parse", "--show-toplevel");
  } catch {
    throw new Error(
      "코드 공동 수정은 Git 프로젝트 폴더에서 시작하세요. 각 AI의 별도 작업 폴더를 만듭니다.",
    );
  }
  if (await git("status", "--porcelain"))
    throw new Error(
      "현재 프로젝트에 저장되지 않은 Git 변경이 있습니다. 커밋한 뒤 새 연구 세션을 만들거나, 서로 다른 작업 폴더의 기존 세션을 선택하세요.",
    );
  const baseline = await git("rev-parse", "HEAD");
  const prefix = `harbor/research-${randomUUID().slice(0, 8)}`;
  const branches = agents.map((agent) => `${prefix}-${agent}`);
  // Keep successfully created worktrees on partial failure; never recursively delete project data.
  for (let i = 0; i < folders.length; i++)
    await git("worktree", "add", "-b", branches[i], folders[i], baseline);
  return { folders, workspace: { repository, baseline, branches } };
}

export interface RemoteResearchWorkspace {
  researchDirectory(host: HostConfig, cwd: string): Promise<string>;
  researchCommand(host: HostConfig, command: string): Promise<string>;
}

/** Commands run only on the selected SSH host, with no local interpretation of its paths. */
export async function prepareRemoteResearchWorkspaces(
  host: HostConfig,
  cwd: string,
  kind: "ideas" | "code" | "research",
  remote: RemoteResearchWorkspace,
  agents: Array<"claude" | "codex"> = ["claude", "codex"],
) {
  cwd = await remote.researchDirectory(host, cwd);
  const home = await remote.researchDirectory(host, "~");
  const runId = randomUUID();
  const root = posix.join(
    home,
    ".codex",
    "harbor",
    "research-workspaces",
    runId,
  );
  const folders = agents.map((agent) => posix.join(root, agent));
  const marker = `HARBOR_RESEARCH_${runId.replaceAll("-", "")}:`;
  const input = Buffer.from(
    JSON.stringify({
      cwd,
      kind,
      root,
      folders,
      agents,
      prefix: `harbor/research-${runId.slice(0, 8)}`,
      marker,
    }),
  ).toString("base64");
  const script = `import base64,json,os,subprocess,sys
x=json.loads(base64.b64decode(${JSON.stringify(input)}))
def git(*args):
    p=subprocess.run(['git',*args],cwd=x['cwd'],text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=25)
    if p.returncode: raise RuntimeError(p.stderr.strip() or 'Git command failed')
    return p.stdout.strip()
try:
    result={'folders':x['folders']}
    if x['kind']=='code':
        repository=git('rev-parse','--show-toplevel')
        if git('status','--porcelain'): raise RuntimeError('Uncommitted Git changes: commit the project first or use existing independent work folders.')
        baseline=git('rev-parse','HEAD')
        branches=[x['prefix']+'-'+agent for agent in x['agents']]
        os.makedirs(x['root'],mode=0o700,exist_ok=True)
        for branch,folder in zip(branches,x['folders']): git('worktree','add','-b',branch,folder,baseline)
        result['workspace']={'repository':repository,'baseline':baseline,'branches':branches}
    else:
        for folder in x['folders']: os.makedirs(folder,mode=0o700,exist_ok=True)
    print(x['marker']+json.dumps(result,ensure_ascii=True))
except Exception as error:
    print(str(error),file=sys.stderr)
    sys.exit(1)
`;
  const encodedScript = Buffer.from(script).toString("base64");
  const python = `python3 -c ${shellQuote(`import base64; exec(base64.b64decode(${JSON.stringify(encodedScript)}))`)}`;
  const command = `exec "\${SHELL:-/bin/sh}" -lc ${shellQuote(python)}`;
  const output = await remote.researchCommand(host, command);
  const line = output.split(/\r?\n/).find((s) => s.startsWith(marker));
  if (!line)
    throw new Error(
      "연구 서버의 작업 폴더 응답을 확인하지 못했습니다. python3와 Git 설치를 확인하세요.",
    );
  const result = JSON.parse(line.slice(marker.length));
  if (JSON.stringify(result.folders) !== JSON.stringify(folders))
    throw new Error("연구 서버의 작업 폴더 경로가 일치하지 않습니다.");
  if (
    kind === "code" &&
    (!result.workspace ||
      !posix.isAbsolute(result.workspace.repository) ||
      !/^[a-f0-9]{40,64}$/i.test(result.workspace.baseline) ||
      result.workspace.branches?.length !== agents.length)
  )
    throw new Error("연구 서버의 Git 기준 버전을 확인하지 못했습니다.");
  return result as {
    folders: string[];
    workspace?: { repository: string; baseline: string; branches: string[] };
  };
}
