import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import path from "node:path";

const require = createRequire(import.meta.url);
const {
  configureInputScheduling,
} = require("../../desktop/input-scheduling.cjs");

function commandLine(initial: Record<string, string> = {}) {
  const switches = new Map(Object.entries(initial));
  const writes: [string, string][] = [];
  return {
    switches,
    writes,
    getSwitchValue: (name: string) => switches.get(name) || "",
    appendSwitch: (name: string, value: string) => {
      writes.push([name, value]);
      switches.set(name, value);
    },
  };
}

test("terminal input scheduling preserves other feature switches and is idempotent", () => {
  for (const existing of ["", "ExistingFeature,AnotherFeature:param/value"]) {
    const switches = commandLine({
      "disable-features": existing,
      "enable-features": "EnabledFeature",
      "unrelated-switch": "unchanged",
    });
    configureInputScheduling(switches);
    configureInputScheduling(switches);
    assert.deepEqual(switches.writes, [
      [
        "disable-features",
        `${existing ? existing + "," : ""}DeferRendererTasksAfterInput`,
      ],
    ]);
    assert.equal(switches.getSwitchValue("enable-features"), "EnabledFeature");
    assert.equal(switches.getSwitchValue("unrelated-switch"), "unchanged");
  }
  for (const existing of [
    "OtherFeature, DeferRendererTasksAfterInput ",
    "DeferRendererTasksAfterInput,OtherFeature,DeferRendererTasksAfterInput",
    "DeferRendererTasksAfterInput<ExistingTrial,OtherFeature",
  ]) {
    const switches = commandLine({ "disable-features": existing });
    configureInputScheduling(switches);
    assert.deepEqual(switches.writes, []);
    assert.equal(switches.getSwitchValue("disable-features"), existing);
  }
});

test("desktop entry configures terminal scheduling before Electron readiness or windows", async () => {
  const source = await readFile(
    new URL("../../desktop/main.cjs", import.meta.url),
    "utf8",
  );
  const switches = commandLine({ "disable-features": "PreservedFeature" });
  const reachedReady = new Error("fixture reached readiness boundary");
  let readyCalls = 0;
  const app = {
    commandLine: switches,
    setName() {},
    setAppUserModelId() {},
    setPath() {},
    getAppPath: () => "/synthetic-harbor",
    getPath: () => "/synthetic-profile",
    isPackaged: false,
    on() {},
    whenReady() {
      readyCalls++;
      assert.equal(
        switches.getSwitchValue("disable-features"),
        "PreservedFeature,DeferRendererTasksAfterInput",
      );
      assert.equal(switches.writes.length, 1);
      throw reachedReady;
    },
  };
  assert.throws(
    () =>
      runInNewContext(source, {
        require(name: string) {
          if (name === "electron")
            return {
              app,
              BrowserWindow: class {
                constructor() {
                  assert.fail("window created before startup configuration");
                }
              },
            };
          if (name === "./input-scheduling.cjs")
            return { configureInputScheduling };
          if (name === "./backend-supervisor.cjs")
            return { BackendSupervisor: class {} };
          if (name === "./backend-version.cjs") return {};
          if (name === "node:fs")
            return {
              readFileSync: () => '{"name":"codex-harbor","version":"fixture"}',
            };
          if (name === "node:path") return path;
          if (name === "node:crypto" || name === "node:child_process")
            return {};
          throw new Error(`Unexpected startup import: ${name}`);
        },
        process: {
          platform: "win32",
          env: {},
          execPath: "/synthetic-harbor/Harbor.exe",
        },
      }),
    (error) => error === reachedReady,
  );
  assert.equal(
    readyCalls,
    1,
    "the actual entry reaches readiness after configuration",
  );
});
