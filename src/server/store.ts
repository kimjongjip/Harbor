import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { resolve, join } from "node:path";
import type {
  Activity,
  Discussion,
  HostConfig,
  SessionMeta,
  Transfer,
} from "../shared/types.js";

interface Data {
  version: 1;
  hosts: HostConfig[];
  sessions: SessionMeta[];
  activities: Activity[];
  transfers: Transfer[];
  discussions: Discussion[];
}
export class Store {
  readonly directory: string;
  readonly file: string;
  data: Data;
  constructor(directory = resolve(process.env.HARBOR_DATA_DIR || ".data")) {
    this.directory = directory;
    this.file = join(directory, "state.json");
    mkdirSync(directory, { recursive: true });
    try {
      this.data = JSON.parse(readFileSync(this.file, "utf8")) as Data;
      if (this.data.version !== 1 || !Array.isArray(this.data.hosts))
        throw new Error("Unsupported Harbor data format");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.data = {
        version: 1,
        hosts: [
          {
            id: "local",
            name: "이 컴퓨터",
            kind: "local",
            address: hostname(),
            username: "",
            port: 22,
            identityFile: "",
            codexPath: "codex",
            defaultCwd: process.env.HARBOR_DEFAULT_CWD || process.cwd(),
            mode: "auto",
            color: "#c5ed92",
            createdAt: Date.now(),
          },
        ],
        sessions: [],
        activities: [],
        transfers: [],
        discussions: [],
      };
    }
    for (const job of this.data.discussions) {
      if (job.status === "running") {
        job.status = "failed";
        job.error =
          "앱이 재시작되어 토론이 중단되었습니다. 진행한 내용은 보관됩니다.";
      }
    }
    this.save();
  }
  save() {
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(temp, this.file);
  }
  session(meta: SessionMeta) {
    const index = this.data.sessions.findIndex((s) => s.id === meta.id);
    if (index < 0) this.data.sessions.push(meta);
    else this.data.sessions[index] = meta;
    this.save();
  }
  activity(activity: Activity) {
    this.data.activities.unshift(activity);
    this.data.activities = this.data.activities.slice(0, 100);
    this.save();
  }
}
