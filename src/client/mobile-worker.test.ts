import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
test("mobile worker serves public shell offline and never intercepts private API or writes", async () => {
  const callbacks = new Map<string, (event: any) => void>(),
    stores = new Map<string, Map<string, Response>>();
  const base = "https://fixture.example.ts.net";
  const path = (v: string | Request) =>
    new URL(typeof v === "string" ? v : v.url, base).pathname;
  let offline = false,
    networkRequests = 0;
  const caches = {
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
    open: async (name: string) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name)!;
      return {
        match: async (key: string) => store.get(path(key))?.clone(),
        put: async (key: string, value: Response) => {
          store.set(path(key), value.clone());
        },
      };
    },
  };
  const fetch = async (value: string | Request) => {
    networkRequests++;
    if (offline) throw new Error("offline");
    return new Response(
      path(value) === "/mobile/"
        ? '<title>Harbor Mobile</title><script src="/assets/app-123.js"></script><link href="/assets/app-123.css">'
        : "public application code",
    );
  };
  const self = {
    location: { origin: base },
    addEventListener: (name: string, fn: (event: any) => void) =>
      callbacks.set(name, fn),
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };
  runInNewContext(await readFile("public/mobile/sw.js", "utf8"), {
    self,
    caches,
    fetch,
    URL,
  });
  const runLifecycle = async (type: string) => {
    let promise: Promise<void> | undefined;
    callbacks.get(type)!({ waitUntil: (p: Promise<void>) => (promise = p) });
    await promise;
  };
  await runLifecycle("install");
  await runLifecycle("activate");
  const request = async (
    pathname: string,
    method = "GET",
    mode = "navigate",
    origin = base,
  ) => {
    let response: Promise<Response> | undefined;
    callbacks.get("fetch")!({
      request: { url: origin + pathname, method, mode },
      respondWith: (p: Promise<Response>) => (response = p),
    });
    return response;
  };
  offline = true;
  const before = networkRequests;
  assert.match(
    await (await request("/mobile/?terminal=fixture"))!.text(),
    /Harbor Mobile/,
  );
  assert.equal(
    await (await request("/assets/app-123.js", "GET", "cors"))!.text(),
    "public application code",
  );
  for (const route of [
    "/mobile-api/state",
    "/mobile-api/terminals/fixture/answers",
    "/api/bootstrap",
    "/mobile/sw.js",
  ])
    assert.equal(await request(route), undefined);
  assert.equal(await request("/assets/app-123.js", "POST", "cors"), undefined);
  assert.equal(
    await request("/assets/app-123.js", "GET", "cors", "https://evil.example"),
    undefined,
  );
  assert.equal(networkRequests, before);
  assert.deepEqual([...stores.values()][0].size, 3);
});
test("mobile push displays a deduplicating tag and opens the notified session", async () => {
  const callbacks = new Map<string, (event: any) => void>(),
    shown: any[] = [],
    opened: string[] = [],
    posted: any[] = [];
  const origin = "https://fixture.example.ts.net";
  let client = false,
    focused = false;
  const self = {
    location: { origin },
    addEventListener: (name: string, fn: (event: any) => void) =>
      callbacks.set(name, fn),
    registration: {
      showNotification: async (title: string, options: any) =>
        shown.push({ title, options }),
    },
    clients: {
      matchAll: async () =>
        client
          ? [
              {
                url: origin + "/mobile/",
                postMessage: (v: any) => posted.push(v),
                focus: async () => {
                  focused = true;
                },
              },
            ]
          : [],
      openWindow: async (url: string) => opened.push(url),
    },
  };
  runInNewContext(await readFile("public/mobile/sw.js", "utf8"), { self, URL });
  async function run(type: string, event: any) {
    let task: Promise<any> | undefined;
    callbacks.get(type)!({
      ...event,
      waitUntil: (p: Promise<any>) => (task = p),
    });
    await task;
  }
  await run("push", {
    data: {
      json: () => ({
        title: "Harbor",
        body: "generic",
        url: "/mobile/?terminal=fixture",
        tag: "harbor-turn",
      }),
    },
  });
  assert.equal(shown[0].options.tag, "harbor-turn");
  const event = {
    notification: { close: () => {}, data: shown[0].options.data },
  };
  await run("notificationclick", event);
  assert.equal(opened[0], origin + "/mobile/?terminal=fixture");
  client = true;
  await run("notificationclick", event);
  assert.equal(posted[0].type, "harbor-open");
  assert.equal(posted[0].url, opened[0]);
  assert.ok(focused);
  await run("push", {
    data: { json: () => ({ url: "https://evil.example" }) },
  });
  assert.equal(shown[1].options.data.url, "/mobile/");
});
