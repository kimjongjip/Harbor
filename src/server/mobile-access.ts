import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import webpush from "web-push";

const subscription = z.object({
  endpoint: z
    .string()
    .url()
    .max(2048)
    .refine((value) => {
      const u = new URL(value);
      return (
        u.protocol === "https:" &&
        !u.username &&
        !u.password &&
        !u.port &&
        (u.hostname === "web.push.apple.com" ||
          u.hostname.endsWith(".push.apple.com") ||
          u.hostname === "fcm.googleapis.com" ||
          u.hostname === "updates.push.services.mozilla.com")
      );
    }, "지원되는 Apple·Google·Mozilla 푸시 주소가 아닙니다."),
  keys: z.object({
    p256dh: z.string().regex(/^[A-Za-z0-9_-]{87}={0,1}$/),
    auth: z.string().regex(/^[A-Za-z0-9_-]{22}={0,2}$/),
  }),
});
const configSchema = z.object({
  mode: z.enum(["private", "funnel"]).default("private"),
  enabled: z.boolean(),
  origin: z.string(),
  port: z.number().int().min(1024).max(65535),
  devices: z
    .array(
      z.object({
        id: z.string().uuid(),
        name: z.string().max(80),
        kind: z.enum(["mobile", "desktop"]).default("mobile"),
        hash: z.string(),
        createdAt: z.number(),
        expiresAt: z.number(),
        push: subscription.optional(),
        pushDelivery: z
          .object({
            state: z.enum(["sent", "failed", "expired"]),
            at: z.number(),
          })
          .optional(),
      }),
    )
    .max(10),
  vapid: z.object({ publicKey: z.string(), privateKey: z.string() }).optional(),
});
type Config = z.infer<typeof configSchema>;
export type MobileDevice = Config["devices"][number];
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
export function mobileOrigin(value: string) {
  const u = new URL(value);
  if (
    u.origin !== value ||
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.port ||
    !u.hostname.endsWith(".ts.net")
  )
    throw new Error(
      "Tailscale의 HTTPS 주소만 입력하세요. 예: https://my-pc.example.ts.net (경로 없이)",
    );
  return u.origin;
}
export class MobileAccess {
  private file: string;
  config: Config;
  private invite?: {
    hash: string;
    expiresAt: number;
    kind: "mobile" | "desktop";
  };
  private failures: number[] = [];
  loadError = "";
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true });
    this.file = join(directory, "mobile-access.json");
    this.config = {
      enabled: false,
      origin: "",
      port: 4318,
      devices: [],
      mode: "private",
    };
    try {
      if (existsSync(this.file))
        this.config = configSchema.parse(
          JSON.parse(readFileSync(this.file, "utf8")),
        );
      if (this.config.origin) mobileOrigin(this.config.origin);
      if (this.config.enabled && !this.config.origin)
        throw new Error("Missing mobile origin");
    } catch {
      this.config = {
        enabled: false,
        origin: "",
        port: 4318,
        devices: [],
        mode: "private",
      };
      this.loadError =
        "모바일 설정을 읽지 못해 접속을 껐습니다. 주소를 다시 저장하고 기기를 등록하세요.";
    }
  }
  private commit(next: Config) {
    const temporary = this.file + ".tmp";
    writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
    renameSync(temporary, this.file);
    this.config = next;
    this.loadError = "";
  }
  configure(
    enabled: boolean,
    origin: string,
    port: number,
    mode = this.config.mode,
  ) {
    const next = configSchema.parse({
      ...this.config,
      enabled,
      origin: !enabled && !origin ? "" : mobileOrigin(origin),
      port,
      mode,
    });
    if (next.origin !== this.config.origin) next.devices = [];
    this.commit(next);
    this.invite = undefined;
  }
  view() {
    return {
      enabled: this.config.enabled,
      origin: this.config.origin,
      port: this.config.port,
      mode: this.config.mode,
      devices: this.config.devices
        .filter((d) => d.expiresAt > Date.now())
        .map(({ id, name, kind, createdAt, expiresAt, push }) => ({
          id,
          name,
          kind,
          createdAt,
          expiresAt,
          notifications: !!push,
        })),
    };
  }
  pairing(kind: "mobile" | "desktop" = "mobile") {
    if (!this.config.enabled) throw new Error("먼저 모바일 연결을 켜세요.");
    const code = randomBytes(24).toString("base64url");
    const expiresAt = Date.now() + 10 * 60_000;
    this.invite = { hash: digest(code), expiresAt, kind };
    return {
      url: `${this.config.origin}/${kind}/#pair=${code}`,
      expiresAt,
      kind,
    };
  }
  pair(code: string, name: string) {
    this.failures = this.failures.filter((t) => Date.now() - t < 60_000);
    if (
      !this.config.enabled ||
      !this.invite ||
      this.invite.expiresAt < Date.now() ||
      digest(code) !== this.invite.hash
    ) {
      if (this.failures.length >= 10)
        throw new Error("연결 시도가 많습니다. 1분 뒤 다시 시도하세요.");
      this.failures.push(Date.now());
      throw new Error(
        "연결 링크가 만료되었거나 잘못되었습니다. PC에서 새 링크를 만드세요.",
      );
    }
    const devices = this.config.devices.filter((d) => d.expiresAt > Date.now());
    if (devices.length >= 10)
      throw new Error("등록된 기기 중 사용하지 않는 기기를 해제하세요.");
    const token = randomBytes(32).toString("base64url");
    const device = {
      id: randomUUID(),
      name: z.string().trim().min(1).max(80).parse(name),
      kind: this.invite.kind,
      hash: digest(token),
      createdAt: Date.now(),
      expiresAt: Date.now() + 90 * 86400000,
    };
    this.commit({ ...this.config, devices: [...devices, device] });
    this.invite = undefined;
    return { token, device };
  }
  authenticate(cookie?: string) {
    if (!this.config.enabled) return undefined;
    const token = cookie
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith("harbor_mobile="))
      ?.slice(14);
    if (!token || token.length > 100) return undefined;
    return this.config.devices.find(
      (d) => d.hash === digest(token) && d.expiresAt > Date.now(),
    );
  }
  revoke(id: string) {
    this.commit({
      ...this.config,
      devices: this.config.devices.filter((d) => d.id !== id),
    });
  }
  publicKey() {
    if (!this.config.vapid)
      this.commit({ ...this.config, vapid: webpush.generateVAPIDKeys() });
    return this.config.vapid!.publicKey;
  }
  setPush(id: string, input: unknown) {
    const push = input === null ? undefined : subscription.parse(input);
    this.commit({
      ...this.config,
      devices: this.config.devices.map((d) =>
        d.id === id ? { ...d, push, pushDelivery: undefined } : d,
      ),
    });
  }
  pushView(id: string) {
    const device = this.config.devices.find((d) => d.id === id);
    return {
      publicKey: this.publicKey(),
      enabled: !!device?.push,
      delivery: device?.pushDelivery,
    };
  }
  async notify(
    title: string,
    body: string,
    terminalId?: string,
    only?: string,
    eventId?: string,
  ) {
    if (!this.config.enabled || !this.config.vapid)
      return { sent: 0, failed: 0 };
    let sent = 0,
      failed = 0;
    await Promise.all(
      this.config.devices
        .filter(
          (d) => d.push && d.expiresAt > Date.now() && (!only || d.id === only),
        )
        .map(async (d) => {
          try {
            await webpush.sendNotification(
              d.push!,
              JSON.stringify({
                title,
                body,
                ...(eventId
                  ? { tag: `harbor-${digest(eventId).slice(0, 32)}` }
                  : {}),
                url: terminalId
                  ? `/mobile/?terminal=${encodeURIComponent(terminalId)}`
                  : "/mobile/",
              }),
              {
                vapidDetails: {
                  subject: this.config.origin,
                  ...this.config.vapid!,
                },
                TTL: 3600,
                urgency: "high",
                timeout: 8000,
              },
            );
            sent++;
            this.recordPush(d.id, d.push!.endpoint, "sent");
          } catch (e) {
            failed++;
            if (
              [404, 410].includes(
                (e as { statusCode?: number }).statusCode || 0,
              )
            ) {
              try {
                this.recordPush(d.id, d.push!.endpoint, "expired");
              } catch {}
            } else this.recordPush(d.id, d.push!.endpoint, "failed");
          }
        }),
    );
    return { sent, failed };
  }
  private recordPush(
    id: string,
    endpoint: string,
    state: "sent" | "failed" | "expired",
  ) {
    // A late result must not resurrect a revoked device or remove a new subscription.
    if (
      !this.config.devices.some(
        (d) => d.id === id && d.push?.endpoint === endpoint,
      )
    )
      return;
    try {
      this.commit({
        ...this.config,
        devices: this.config.devices.map((d) =>
          d.id === id && d.push?.endpoint === endpoint
            ? {
                ...d,
                ...(state === "expired" ? { push: undefined } : {}),
                pushDelivery: { state, at: Date.now() },
              }
            : d,
        ),
      });
    } catch {
      /* Notification delivery must not interrupt the terminal. */
    }
  }
}
