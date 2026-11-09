import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const TAILSCALE_DOWNLOAD_URL = "https://tailscale.com/download/windows";
export type TailscaleSetupAction = "install" | "login";
export interface TailscaleSetupJob {
  id: string;
  action: TailscaleSetupAction;
  status: "running" | "waiting" | "succeeded" | "failed";
  message: string;
  startedAt: number;
  updatedAt: number;
  authUrl?: string;
}
export interface TailscaleSetupStatus {
  supported: boolean;
  installed: boolean;
  canInstall: boolean;
  loggedIn: boolean;
  connected: boolean;
  state:
    | "not-installed"
    | "needs-login"
    | "stopped"
    | "starting"
    | "running"
    | "needs-approval"
    | "unavailable";
  origin?: string;
  authUrl?: string;
  version?: string;
  message: string;
  downloadUrl: string;
  job?: TailscaleSetupJob;
}

export interface SetupCommandOptions {
  timeoutMs: number;
  signal: AbortSignal;
  onOutput?: (chunk: string) => void;
}
export type SetupExecutor = (
  executable: string,
  args: readonly string[],
  options: SetupCommandOptions,
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

/** All executable paths and arguments are selected by this module, never an HTTP body. */
const execute: SetupExecutor = (executable, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      signal: options.signal,
    });
    let stdout = "",
      stderr = "",
      size = 0,
      timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);
    timer.unref();
    const collect = (target: "stdout" | "stderr", chunk: Buffer) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        timedOut = true;
        child.kill();
        return;
      }
      const value = chunk.toString("utf8");
      if (target === "stdout") stdout += value;
      else stderr += value;
      options.onOutput?.(value);
    };
    child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error("SETUP_COMMAND_TIMEOUT"));
      else resolve({ code, stdout, stderr });
    });
  });

interface SetupOptions {
  platform?: NodeJS.Platform;
  exists?: (filename: string) => boolean;
  execute?: SetupExecutor;
  tailscalePath?: string;
  wingetPath?: string;
  now?: () => number;
}

/** Only Tailscale-issued HTTPS authentication URLs may reach the browser. */
export function tailscaleAuthUrl(input: unknown): string | undefined {
  if (typeof input !== "string" || input.length > 2048) return;
  try {
    const url = new URL(input);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "login.tailscale.com" ||
      url.port ||
      url.username ||
      url.password ||
      url.hash
    )
      return;
    if (
      !/^\/a\/[A-Za-z0-9_-]+$/.test(url.pathname) &&
      url.pathname !== "/admin/machines"
    )
      return;
    return url.href;
  } catch {
    return;
  }
}

function findAuthUrl(output: string) {
  for (const match of output.matchAll(/https:\/\/[^\s<>"']+(?=[\s<>"'])/g)) {
    const url = tailscaleAuthUrl(match[0]);
    if (url) return url;
  }
}

/** Local-PC onboarding only. Mount mutation methods behind the desktop owner's auth. */
export class TailscaleSetup {
  private readonly platform: NodeJS.Platform;
  private readonly exists: (filename: string) => boolean;
  private readonly run: SetupExecutor;
  private readonly now: () => number;
  private readonly tailscalePath: string;
  private readonly wingetPath: string;
  private current?: TailscaleSetupJob;
  private controller?: AbortController;
  private reading?: Promise<Omit<TailscaleSetupStatus, "job">>;
  private cached?: { time: number; status: Omit<TailscaleSetupStatus, "job"> };
  private closed = false;

  constructor(options: SetupOptions = {}) {
    this.platform = options.platform || process.platform;
    this.exists = options.exists || existsSync;
    this.run = options.execute || execute;
    this.now = options.now || Date.now;
    this.tailscalePath =
      options.tailscalePath ||
      path.join(
        process.env.ProgramFiles || "C:\\Program Files",
        "Tailscale",
        "tailscale.exe",
      );
    this.wingetPath =
      options.wingetPath ||
      path.join(
        process.env.LOCALAPPDATA || path.join(homedir(), "AppData", "Local"),
        "Microsoft",
        "WindowsApps",
        "winget.exe",
      );
  }

  getJob() {
    return this.current ? { ...this.current } : undefined;
  }

  private update(job: TailscaleSetupJob, values: Partial<TailscaleSetupJob>) {
    if (this.current !== job || this.closed) return;
    if (job.status === "succeeded" || job.status === "failed") return;
    Object.assign(job, values, { updatedAt: this.now() });
    if (values.status === "succeeded" || values.status === "failed")
      delete job.authUrl;
  }

  private async probe(): Promise<Omit<TailscaleSetupStatus, "job">> {
    const supported = this.platform === "win32";
    const installed = supported && this.exists(this.tailscalePath);
    const base = {
      supported,
      installed,
      canInstall: supported && this.exists(this.wingetPath),
      loggedIn: false,
      connected: false,
      downloadUrl: TAILSCALE_DOWNLOAD_URL,
    };
    if (!installed)
      return {
        ...base,
        state: "not-installed",
        message: supported
          ? "이 PC에 Tailscale을 설치하세요."
          : "이 환경에서는 Tailscale 공식 설치 안내를 이용하세요.",
      };
    const controller = new AbortController();
    try {
      const result = await this.run(
        this.tailscalePath,
        ["status", "--json", "--peers=false"],
        { timeoutMs: 8000, signal: controller.signal },
      );
      if (result.code !== 0) throw new Error("STATUS_FAILED");
      const value = JSON.parse(result.stdout);
      const backend = value?.BackendState;
      const state: TailscaleSetupStatus["state"] =
        backend === "Running"
          ? "running"
          : backend === "Stopped"
            ? "stopped"
            : backend === "NeedsLogin"
              ? "needs-login"
              : backend === "NeedsMachineAuth"
                ? "needs-approval"
                : backend === "Starting"
                  ? "starting"
                  : "unavailable";
      const loggedIn = [
        "running",
        "stopped",
        "starting",
        "needs-approval",
      ].includes(state);
      const dns =
        typeof value.Self?.DNSName === "string"
          ? value.Self.DNSName.replace(/\.$/, "")
          : "";
      const origin =
        /^[a-z\d](?:[a-z\d-]*[a-z\d])?\.[a-z\d](?:[a-z\d-]*[a-z\d])?\.ts\.net$/i.test(
          dns,
        )
          ? `https://${dns.toLowerCase()}`
          : undefined;
      const authUrl =
        state === "needs-login"
          ? tailscaleAuthUrl(value.AuthURL)
          : state === "needs-approval"
            ? "https://login.tailscale.com/admin/machines"
            : undefined;
      const messages = {
        running: "Tailscale에 연결되어 있습니다.",
        stopped: "로그인되어 있습니다. 연결을 켜면 기존 계정을 사용합니다.",
        "needs-login": "Tailscale에 로그인하세요.",
        "needs-approval":
          "Tailscale 관리자 화면에서 이 PC의 기기 승인이 필요합니다.",
        starting: "Tailscale이 연결 중입니다.",
        unavailable:
          "Tailscale 서비스를 확인하지 못했습니다. PC의 Tailscale 앱을 확인하세요.",
        "not-installed": "이 PC에 Tailscale을 설치하세요.",
      };
      return {
        ...base,
        state,
        loggedIn,
        connected: state === "running",
        origin,
        authUrl,
        version:
          typeof value.Version === "string" &&
          /^[\w.+-]{1,80}$/.test(value.Version)
            ? value.Version
            : undefined,
        message: messages[state],
      };
    } catch {
      return {
        ...base,
        state: "unavailable",
        message:
          "Tailscale 서비스를 확인하지 못했습니다. PC의 Tailscale 앱을 확인하세요.",
      };
    }
  }

  private async readStatus(force = false) {
    if (!force && this.cached && this.now() - this.cached.time < 1000)
      return this.cached.status;
    if (this.reading) {
      if (!force) return this.reading;
      await this.reading;
    }
    const pending = this.probe();
    this.reading = pending;
    try {
      const status = await pending;
      this.cached = { time: this.now(), status };
      return status;
    } finally {
      if (this.reading === pending) this.reading = undefined;
    }
  }

  async status(): Promise<TailscaleSetupStatus> {
    const status = await this.readStatus();
    const job = this.current;
    if (
      job?.action === "login" &&
      ["running", "waiting"].includes(job.status)
    ) {
      if (status.connected) {
        this.update(job, {
          status: "succeeded",
          message: "기존 Tailscale 계정으로 연결되었습니다.",
        });
        this.controller?.abort();
      } else if (status.authUrl)
        this.update(job, {
          status: "waiting",
          authUrl: status.authUrl,
          message: status.message,
        });
    }
    return { ...status, job: this.getJob() };
  }

  /** Called only after an explicit Install or Login click; status() never mutates Tailscale. */
  start(action: TailscaleSetupAction): TailscaleSetupJob {
    if (action !== "install" && action !== "login")
      throw new Error("설치 또는 로그인 작업을 선택하세요.");
    if (this.closed) throw new Error("Tailscale 설정 서비스가 종료되었습니다.");
    if (this.current && ["running", "waiting"].includes(this.current.status))
      return { ...this.current };
    const job: TailscaleSetupJob = {
      id: randomUUID(),
      action,
      status: "running",
      message:
        action === "install"
          ? "Tailscale 설치 상태를 확인하고 있습니다."
          : "Tailscale 로그인 상태를 확인하고 있습니다.",
      startedAt: this.now(),
      updatedAt: this.now(),
    };
    this.current = job;
    const controller = new AbortController();
    this.controller = controller;
    void this.perform(job, controller)
      .catch(() => {
        this.update(job, {
          status: "failed",
          message:
            action === "install"
              ? "설치를 완료하지 못했습니다. 설치 화면을 확인하거나 공식 다운로드를 이용하세요."
              : "로그인을 완료하지 못했습니다. Tailscale 앱의 로그인 상태를 확인하고 다시 시도하세요.",
        });
      })
      .finally(() => {
        if (this.controller === controller) this.controller = undefined;
        this.cached = undefined;
      });
    return { ...job };
  }

  private async perform(job: TailscaleSetupJob, controller: AbortController) {
    const state = await this.readStatus(true);
    if (this.closed || controller.signal.aborted) return;
    if (job.action === "install") {
      if (state.installed) {
        this.update(job, {
          status: "succeeded",
          message: "이미 Tailscale이 설치되어 있습니다.",
        });
        return;
      }
      if (!state.canInstall) {
        this.update(job, {
          status: "failed",
          message:
            "이 PC에서는 자동 설치를 사용할 수 없습니다. 공식 다운로드에서 설치하세요.",
        });
        return;
      }
      this.update(job, {
        message:
          "Tailscale 공식 설치 프로그램을 여는 중입니다. Windows 설치 화면에서 진행하세요.",
      });
      const result = await this.run(
        this.wingetPath,
        [
          "install",
          "--id",
          "Tailscale.Tailscale",
          "--exact",
          "--source",
          "winget",
          "--interactive",
          // No invisible CLI prompt on a fresh PC; the installer UI stays visible.
          "--accept-source-agreements",
          "--accept-package-agreements",
          "--disable-interactivity",
        ],
        { timeoutMs: 15 * 60 * 1000, signal: controller.signal },
      );
      const installed = this.exists(this.tailscalePath);
      if (!installed || (result.code !== 0 && result.code !== 3010))
        throw new Error("INSTALL_FAILED");
      this.update(job, {
        status: "succeeded",
        message: "Tailscale을 설치했습니다. 다음으로 로그인하세요.",
      });
      return;
    }
    if (!state.installed) {
      this.update(job, {
        status: "failed",
        message: "먼저 이 PC에 Tailscale을 설치하세요.",
      });
      return;
    }
    if (state.connected) {
      this.update(job, {
        status: "succeeded",
        message:
          "이미 연결되어 있습니다. 기존 로그인과 네트워크 설정을 유지합니다.",
      });
      return;
    }
    if (state.state === "unavailable") throw new Error("SERVICE_UNAVAILABLE");
    if (state.authUrl)
      this.update(job, {
        status: "waiting",
        authUrl: state.authUrl,
        message: state.message,
      });
    let output = "";
    // `login` always starts reauthentication. Bare `up` preserves current preferences/account.
    // https://github.com/tailscale/tailscale/blob/main/cmd/tailscale/cli/up.go
    const result = await this.run(this.tailscalePath, ["up"], {
      timeoutMs: 5 * 60 * 1000,
      signal: controller.signal,
      onOutput: (chunk) => {
        output = (output + chunk).slice(-8192);
        const authUrl = findAuthUrl(output);
        if (authUrl)
          this.update(job, {
            status: "waiting",
            authUrl,
            message: "브라우저에서 Tailscale 로그인을 완료하세요.",
          });
      },
    });
    if (this.closed || controller.signal.aborted) return;
    const latest = await this.readStatus(true);
    if (latest.connected) {
      this.update(job, {
        status: "succeeded",
        message: "Tailscale에 연결되었습니다.",
      });
      return;
    }
    if (latest.state === "needs-approval") {
      // Keep the approval URL available, but finish this command so retry is possible.
      this.update(job, { status: "failed", message: latest.message });
      return;
    }
    if (result.code !== 0) throw new Error("LOGIN_FAILED");
    throw new Error("LOGIN_NOT_CONNECTED");
  }

  close() {
    this.closed = true;
    // Cancel only CLI helpers owned here; never stop tailscaled or an existing connection.
    this.controller?.abort();
    this.controller = undefined;
    if (this.current && ["running", "waiting"].includes(this.current.status)) {
      this.current.status = "failed";
      this.current.message =
        "Harbor 설정 작업이 종료되었습니다. Tailscale 연결은 유지됩니다.";
      delete this.current.authUrl;
    }
  }
}
