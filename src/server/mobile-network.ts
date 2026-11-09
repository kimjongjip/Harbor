import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { mobileOrigin } from "./mobile-access.js";
import type { MobileNetworkStatus } from "../shared/mobile.js";

type Mode = "private" | "funnel";
type Run = (args: string[]) => Promise<string>;
const approvalLink = (output: string) =>
  output.match(/https:\/\/login\.tailscale\.com\/f\/[A-Za-z0-9/?=&_-]+/)?.[0];
const nativeRun: Run = (args) =>
  new Promise((resolve, reject) => {
    const executable =
      process.platform === "win32"
        ? join(
            process.env.ProgramFiles || "C:\\Program Files",
            "Tailscale",
            "tailscale.exe",
          )
        : "tailscale";
    if (process.platform === "win32" && !existsSync(executable)) {
      reject(new Error("PC에 Tailscale을 설치하고 로그인하세요."));
      return;
    }
    execFile(
      executable,
      args,
      {
        windowsHide: true,
        timeout: 20000,
        maxBuffer: 2 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout);
          return;
        }
        // Only expose the official approval link, never a raw status/config dump.
        const approval = approvalLink(stdout + "\n" + stderr);
        reject(
          Object.assign(
            new Error(
              approval
                ? "Tailscale에서 공개 연결을 허용한 뒤 연결 설정을 다시 눌러주세요."
                : "Tailscale 연결 설정에 실패했습니다. PC의 로그인 상태를 확인하거나 아래 PowerShell 명령을 실행하세요.",
            ),
            { approvalUrl: approval },
          ),
        );
      },
    );
  });

/** Read/modify only this node's dedicated HTTPS root pointing at Harbor Mobile. */
export class MobileNetwork {
  private changing = false;
  constructor(private run: Run = nativeRun) {}
  async status(port: number): Promise<MobileNetworkStatus> {
    if (!Number.isInteger(port) || port < 1024 || port > 65535)
      throw new Error("모바일 포트를 확인하세요.");
    const state = JSON.parse(await this.run(["status", "--json"]));
    if (state.BackendState !== "Running" || !state.Self?.DNSName)
      throw new Error("PC Tailscale에 로그인하고 연결을 켜세요.");
    const origin = mobileOrigin(
      `https://${String(state.Self.DNSName).replace(/\.$/, "")}`,
    );
    const config = JSON.parse(await this.run(["serve", "status", "--json"]));
    const authority = `${new URL(origin).host}:443`;
    const routes = config.Web?.[authority]?.Handlers || {};
    const keys = Object.keys(routes);
    const matching =
      keys.length === 1 &&
      keys[0] === "/" &&
      Object.keys(routes["/"] || {}).length === 1 &&
      routes["/"]?.Proxy === `http://127.0.0.1:${port}`;
    const has443 =
      !!config.TCP?.["443"] ||
      Object.keys(config.Web || {}).some((key) => key.endsWith(":443"));
    const otherHost = Object.keys(config.Web || {}).some(
      (key) => key.endsWith(":443") && key !== authority,
    );
    const listener = config.TCP?.["443"] || {};
    const connected =
      matching &&
      listener.HTTPS === true &&
      Object.keys(listener).length === 1 &&
      !otherHost;
    return {
      origin,
      connected,
      conflict: has443 && !connected,
      mode: connected
        ? config.AllowFunnel?.[authority] === true
          ? "funnel"
          : "private"
        : undefined,
    };
  }
  async connect(config: {
    origin: string;
    port: number;
    mode: Mode;
  }): Promise<MobileNetworkStatus> {
    if (config.mode !== "private" && config.mode !== "funnel")
      throw new Error("연결 방식을 확인하세요.");
    if (this.changing)
      throw new Error("연결 설정 중입니다. 잠시 기다려주세요.");
    this.changing = true;
    try {
      const status = await this.status(config.port);
      if (status.origin !== config.origin)
        throw new Error(
          "현재 PC의 Tailscale 주소와 저장한 주소가 다릅니다. PC 주소 확인을 눌러주세요.",
        );
      if (status.conflict)
        throw new Error(
          "HTTPS 443에 다른 서비스나 경로가 설정돼 있어 변경하지 않았습니다. Tailscale 설정을 먼저 확인하세요.",
        );
      if (status.connected && status.mode === config.mode) return status;
      let output = "";
      try {
        output = await this.run([
          config.mode === "funnel" ? "funnel" : "serve",
          "--bg",
          "--yes",
          "--https=443",
          `http://127.0.0.1:${config.port}`,
        ]);
      } catch (error) {
        const failure = error as Error & { approvalUrl?: string };
        return {
          ...status,
          connected: false,
          error: failure.message,
          approvalUrl: failure.approvalUrl,
        };
      }
      const result = await this.status(config.port);
      if (!result.connected || result.mode !== config.mode) {
        const approvalUrl = approvalLink(output);
        if (approvalUrl)
          return {
            ...result,
            connected: false,
            approvalUrl,
            error:
              "Tailscale에서 연결을 허용한 뒤 연결 설정을 다시 눌러주세요.",
          };
        throw new Error(
          "접속 설정을 확인하지 못했습니다. PC 주소 확인을 다시 눌러주세요.",
        );
      }
      return result;
    } finally {
      this.changing = false;
    }
  }
}
