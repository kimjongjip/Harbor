import test from "node:test";
import assert from "node:assert/strict";
import { MobileNetwork } from "./mobile-network";

const origin = "https://pc.fixture.ts.net",
  authority = "pc.fixture.ts.net:443";
function fixture() {
  let serve: any = {},
    state: any = {
      BackendState: "Running",
      Self: { DNSName: "pc.fixture.ts.net." },
    };
  const calls: string[][] = [];
  let failure: Error | undefined;
  let apply = true,
    output = "";
  const route = (publicAccess = false) => ({
    TCP: { "443": { HTTPS: true } },
    Web: {
      [authority]: { Handlers: { "/": { Proxy: "http://127.0.0.1:4318" } } },
    },
    AllowFunnel: { [authority]: publicAccess },
  });
  const network = new MobileNetwork(async (args) => {
    calls.push(args);
    if (args.join(" ") === "status --json") return JSON.stringify(state);
    if (args.join(" ") === "serve status --json") return JSON.stringify(serve);
    if (failure) throw failure;
    if (apply)
      serve = {
        ...serve,
        ...route(args[0] === "funnel"),
        TCP: { ...serve.TCP, "443": { HTTPS: true } },
      };
    return output;
  });
  return {
    network,
    calls,
    route,
    setServe: (v: any) => (serve = v),
    setState: (v: any) => (state = v),
    fail: (v: Error) => (failure = v),
    noApply: () => (apply = false),
    output: (v: string) => (output = v),
    getServe: () => serve,
  };
}
test("mobile network configures only the dedicated root and verifies actual mode", async () => {
  const f = fixture();
  f.setServe({ TCP: { "8443": { TCPForward: "127.0.0.1:9000" } } });
  const before = await f.network.status(4318);
  assert.deepEqual(before, {
    origin,
    connected: false,
    conflict: false,
    mode: undefined,
  });
  const result = await f.network.connect({
    origin,
    port: 4318,
    mode: "funnel",
  });
  assert.equal(result.mode, "funnel");
  assert.ok(result.connected);
  assert.deepEqual(
    f.calls.find((a) => a[0] === "funnel"),
    ["funnel", "--bg", "--yes", "--https=443", "http://127.0.0.1:4318"],
  );
  assert.deepEqual(f.getServe().TCP["8443"], { TCPForward: "127.0.0.1:9000" });
  await f.network.connect({ origin, port: 4318, mode: "funnel" });
  assert.equal(f.calls.filter((a) => a[0] === "funnel").length, 1);
  assert.equal(
    (await f.network.connect({ origin, port: 4318, mode: "private" })).mode,
    "private",
  );
  assert.ok(
    f.calls.some(
      (a) =>
        a.join(" ") === "serve --bg --yes --https=443 http://127.0.0.1:4318",
    ),
  );
  assert.ok(!f.calls.some((a) => a.includes("reset")));
});
test("mobile network refuses conflicting HTTPS routes, mismatched hosts and invalid input", async () => {
  for (const alter of [
    (v: any) => {
      v.Web[authority].Handlers["/"].Proxy = "http://127.0.0.1:4317";
    },
    (v: any) => {
      v.Web[authority].Handlers["/other"] = { Proxy: "http://127.0.0.1:7000" };
    },
    (v: any) => {
      v.Web["another.fixture.ts.net:443"] = { Handlers: {} };
    },
    (v: any) => {
      v.TCP["443"].TCPForward = "127.0.0.1:443";
    },
  ]) {
    const f = fixture(),
      config = f.route();
    alter(config);
    f.setServe(config);
    await assert.rejects(
      f.network.connect({ origin, port: 4318, mode: "funnel" }),
      /다른 서비스/,
    );
    assert.ok(f.calls.every((a) => a.includes("--json")));
  }
  const f = fixture();
  await assert.rejects(
    f.network.connect({
      origin: "https://other.fixture.ts.net",
      port: 4318,
      mode: "funnel",
    }),
    /주소/,
  );
  await assert.rejects(f.network.status(443), /포트/);
  await assert.rejects(
    f.network.connect({ origin, port: 4318, mode: "invalid" as any }),
    /방식/,
  );
  f.setState({ BackendState: "NeedsLogin" });
  await assert.rejects(f.network.status(4318), /로그인/);
  assert.ok(f.calls.every((a) => a.includes("--json")));
});
test("mobile network reports approval and incomplete configuration without claiming success", async () => {
  const f = fixture();
  f.fail(
    Object.assign(new Error("approval needed"), {
      approvalUrl: "https://login.tailscale.com/f/funnel?node=fixture",
    }),
  );
  const result = await f.network.connect({
    origin,
    port: 4318,
    mode: "funnel",
  });
  assert.equal(result.connected, false);
  assert.match(result.approvalUrl!, /^https:\/\/login.tailscale.com/);
  assert.equal(result.error, "approval needed");
  const g = fixture();
  g.noApply();
  await assert.rejects(
    g.network.connect({ origin, port: 4318, mode: "funnel" }),
    /확인하지 못했습니다/,
  );
  g.output("Enable at https://login.tailscale.com/f/funnel?node=fixture");
  const pending = await g.network.connect({
    origin,
    port: 4318,
    mode: "funnel",
  });
  assert.equal(pending.connected, false);
  assert.ok(pending.approvalUrl);
});
test("mobile network serializes changes", async () => {
  let release!: () => void;
  const network = new MobileNetwork(async () => {
    await new Promise<void>((r) => (release = r));
    throw new Error("fixture stopped");
  });
  const first = network.connect({ origin, port: 4318, mode: "funnel" });
  await assert.rejects(
    network.connect({ origin, port: 4318, mode: "private" }),
    /설정 중/,
  );
  release();
  await assert.rejects(first, /fixture stopped/);
});
