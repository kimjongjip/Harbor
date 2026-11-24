import { basename, join, resolve } from "node:path";
import {
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { HostConfig, WorkspaceUpdateOverview } from "../shared/types.js";
import type { RemoteWorkspaces } from "./remote-workspaces.js";

const lifetime = 24 * 60 * 60 * 1000;
const profileId = /^[a-f0-9]{64}$/;
const commitId = /^[a-f0-9]{40}$/;
interface Intent {
  version: string;
  until: number;
  profiles: string[];
  receipt?: string;
}
interface Receipt {
  sha: string;
  at: number;
  profiles?: string[];
}

// The desktop installer writes the pointer after the old process exits. Verify
// the running checkout and data directory before adopting a legacy handoff.
export function desktopUpdateReceipt(
  directory: string,
  version: string,
  installRoot?: string,
  activeRoot = process.cwd(),
): Receipt | undefined {
  if (!installRoot) return;
  try {
    const pointer = join(installRoot, ".runtime", "desktop-update.json");
    const selected = JSON.parse(readFileSync(pointer, "utf8"));
    const active = realpathSync(activeRoot);
    const sha = basename(active);
    if (
      !commitId.test(sha) ||
      selected.directory !== sha ||
      selected.version !== version ||
      realpathSync(resolve(selected.dataDirectory)) !==
        realpathSync(directory) ||
      realpathSync(join(installRoot, ".runtime", "updates", sha)) !== active
    )
      return;
    const receipt = JSON.parse(
      readFileSync(join(active, ".harbor-update.json"), "utf8"),
    );
    const at =
      selected.workspaceUpdate?.requestedAt ?? statSync(pointer).mtimeMs;
    if (
      receipt.sha !== sha ||
      receipt.version !== version ||
      !Number.isFinite(at) ||
      at > Date.now() ||
      at + lifetime <= Date.now()
    )
      return;
    if (selected.workspaceUpdate) {
      const profiles = selected.workspaceUpdate.profiles;
      if (
        Array.isArray(profiles) &&
        profiles.every((id) => typeof id === "string" && profileId.test(id))
      )
        return { sha, at, profiles };
      return;
    }
    // The old updater keeps this specific handoff until the new /api/health is
    // ready. Ordinary starts and a rollback to an earlier selection lack it.
    const runtime = join(installRoot, ".runtime");
    for (const file of readdirSync(runtime)) {
      if (!/^update-restart-[a-f0-9-]{36}\.json$/.test(file)) continue;
      try {
        const spec = JSON.parse(readFileSync(join(runtime, file), "utf8"));
        if (
          spec.sha === sha &&
          spec.version === version &&
          realpathSync(spec.dataDirectory) === realpathSync(directory) &&
          realpathSync(spec.installRoot) === realpathSync(installRoot)
        )
          return { sha, at };
      } catch {
        /* Another completed handoff may have just been removed. */
      }
    }
  } catch {
    /* A normal or previously rolled-back installation has no matching handoff. */
  }
}

type Workspaces = Pick<
  RemoteWorkspaces,
  | "version"
  | "enabled"
  | "profile"
  | "status"
  | "convergeForUpdate"
  | "synchronize"
>;

export class WorkspaceRollout {
  private readonly file: string;
  private intent?: Intent;
  private readonly running = new Set<string>();
  private readonly attemptAt = new Map<string, number>();
  constructor(
    private readonly directory: string,
    private readonly workers: Workspaces,
    private readonly hosts: () => HostConfig[],
    private readonly password: (id: string) => Promise<string | undefined>,
  ) {
    this.file = join(directory, "workspace-update-intent.json");
    try {
      const entry: Intent = JSON.parse(readFileSync(this.file, "utf8"));
      if (
        entry.version === workers.version &&
        Number.isFinite(entry.until) &&
        Array.isArray(entry.profiles) &&
        entry.profiles.every(
          (id) => typeof id === "string" && profileId.test(id),
        ) &&
        (!entry.receipt || commitId.test(entry.receipt))
      )
        this.intent = entry;
    } catch {
      /* No usable intent. Ordinary synchronization can still check and stage releases. */
    }
  }
  private enrolled() {
    return this.hosts().filter(
      (host) => host.kind === "ssh" && this.workers.enabled(host),
    );
  }
  private save(intent: Intent) {
    const temporary = this.file + "." + process.pid + ".tmp";
    writeFileSync(temporary, JSON.stringify(intent), { mode: 0o600 });
    renameSync(temporary, this.file);
    this.intent = intent;
  }
  adopt(receipt: ReturnType<typeof desktopUpdateReceipt>) {
    if (!receipt || this.intent?.receipt === receipt.sha) return;
    const enrolled = this.enrolled();
    // An old updater saved no list. A later change to the enrollment registry
    // invalidates that snapshot; those accounts need a fresh Update action.
    if (!receipt.profiles && enrolled.length) {
      try {
        if (
          statSync(join(this.directory, "server-workspaces.json")).mtimeMs >
          receipt.at
        )
          return;
      } catch {
        return;
      }
    }
    this.save({
      version: this.workers.version,
      until: receipt.at + lifetime,
      receipt: receipt.sha,
      profiles: enrolled
        .map((h) => this.workers.profile(h))
        .filter((id) => !receipt.profiles || receipt.profiles.includes(id)),
    });
  }
  start() {
    if (!this.workers.version)
      throw Error("PC의 서버 업데이트 파일을 확인하세요.");
    this.save({
      version: this.workers.version,
      until: Date.now() + lifetime,
      receipt: this.intent?.receipt,
      profiles: this.enrolled().map((h) => this.workers.profile(h)),
    });
    this.tick(true);
    return this.overview();
  }
  overview(): WorkspaceUpdateOverview {
    return {
      targetVersion: this.workers.version,
      ...(this.intent?.receipt && this.intent.until > Date.now()
        ? { handoff: this.intent.receipt }
        : {}),
      hosts: this.enrolled().map((h) => {
        const status = this.workers.status(h);
        return {
          id: h.id,
          name: h.name,
          ...status,
          ...(this.running.has(this.workers.profile(h)) &&
          status.phase === "current"
            ? { phase: "checking" as const }
            : {}),
        };
      }),
    };
  }
  tick(force = false) {
    const enrolled = this.enrolled();
    const intent = this.intent;
    const active =
      intent &&
      intent.until > Date.now() &&
      intent.version === this.workers.version;
    for (const host of enrolled) {
      const key = this.workers.profile(host);
      const password = () => this.password(host.id);
      if (!active || !intent.profiles.includes(key)) {
        if (!force) void this.workers.synchronize(host, password);
        continue;
      }
      if (this.running.has(key)) continue;
      const retry =
        this.workers.status(host).phase === "error" ? 300000 : 15000;
      if (!force && Date.now() - (this.attemptAt.get(key) || 0) < retry)
        continue;
      this.running.add(key);
      this.attemptAt.set(key, Date.now());
      void this.workers
        .convergeForUpdate(host, password)
        .then(() => {
          const current = this.intent;
          if (
            this.workers.status(host).phase === "current" &&
            current?.profiles.includes(key)
          ) {
            this.save({
              ...current,
              profiles: current.profiles.filter((id) => id !== key),
            });
            this.attemptAt.delete(key);
          }
        })
        .catch(() => {
          /* Keep failed or interrupted targets for the next check. */
        })
        .finally(() => this.running.delete(key));
    }
  }
  forget(host: HostConfig) {
    const key = this.workers.profile(host);
    const intent = this.intent;
    if (intent?.profiles.includes(key))
      this.save({
        ...intent,
        profiles: intent.profiles.filter((id) => id !== key),
      });
    this.attemptAt.delete(key);
  }
}
