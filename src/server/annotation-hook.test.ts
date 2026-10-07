import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentBridge } from "./agent-bridge.js";
import { Mailbox } from "./mailbox.js";
import {
  annotationHookConfig,
  powershellAnnotationHook,
} from "./annotation-hook.js";
import type { TerminalInfo } from "../shared/types.js";

test(
  "native annotation hook binds hidden selected text to the original terminal and session",
  { skip: process.platform !== "win32" },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "harbor-annotation-hook-"));
    const terminals = ["origin", "other"].map(
      (id) =>
        ({
          id,
          hostId: "fixture-host",
          title: id,
          cwd: "/synthetic",
          agentKind: "codex",
        }) as TerminalInfo,
    );
    const mailbox = new Mailbox(directory, {
      terminal: (id) => terminals.find((item) => item.id === id),
      host: () => ({ id: "fixture-host", name: "Fixture" }),
    });
    const bridge = new AgentBridge(mailbox, {
      terminals: () => terminals,
      host: () => ({ id: "fixture-host", name: "Fixture" }),
    });
    const app = express();
    let posts = 0;
    app.use((req, _res, next) => {
      posts++;
      next();
    });
    app.all("/bridge/annotation", bridge.annotationHandle);
    const server = createServer(app).listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => {
      server.closeAllConnections();
      server.close();
      rmSync(directory, { recursive: true, force: true });
    });
    const url = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/bridge/permission`;
    const origin = bridge.issue("origin"),
      other = bridge.issue("other");
    const run = (event: object, hookToken = origin.hookToken) =>
      new Promise<Record<string, any>>((resolve, reject) => {
        const child = spawn(
          "powershell.exe",
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(powershellAnnotationHook, "utf16le").toString("base64"),
          ],
          {
            windowsHide: true,
            env: {
              ...process.env,
              HARBOR_HOOK_URL: url,
              HARBOR_HOOK_TOKEN: hookToken,
            },
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        let stdout = "",
          stderr = "";
        child.stdout.on("data", (value) => (stdout += value));
        child.stderr.on("data", (value) => (stderr += value));
        child.on("error", reject);
        child.on("close", (code) => {
          try {
            assert.equal(code, 0);
            assert.equal(stderr, "");
            assert.equal(stdout.includes(hookToken), false);
            resolve(JSON.parse(stdout));
          } catch (error) {
            reject(error);
          }
        });
        child.stdin.end(JSON.stringify(event));
      });
    const session = {
      hook_event_name: "SessionStart",
      session_id: "fixture-thread",
    };
    assert.deepEqual(await run(session), {});
    assert.ok(bridge.annotations.isReady("origin"));
    const selectedText = "선택한 정확한 글\nonly selected text";
    const reference = bridge.annotations.capture("origin", {
      text: selectedText,
      source: { hostName: "Fixture", title: "Review", cwd: "/synthetic" },
    });
    const annotation = "이 부분에서 무엇을 뜻하는지 설명해주세요.";
    bridge.annotations.attach("origin", [
      { number: reference.number, annotation },
    ]);
    const prompt = reference.reference;
    const submitted = {
      hook_event_name: "UserPromptSubmit",
      session_id: "fixture-thread",
      prompt,
      transcript_path: "/must-not-be-read/transcript.jsonl",
    };
    const resolved = await run(submitted);
    assert.equal(resolved.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.deepEqual(
      JSON.parse(resolved.hookSpecificOutput.additionalContext),
      {
        annotations: [
          {
            reference: reference.reference,
            text: selectedText,
            annotation,
            source: { hostName: "Fixture", title: "Review", cwd: "/synthetic" },
          },
        ],
      },
    );
    assert.equal(submitted.prompt, prompt);
    const before = posts;
    assert.deepEqual(
      await run({ ...submitted, prompt: "ordinary prompt" }),
      {},
    );
    assert.equal(
      posts,
      before,
      "ordinary prompts must not require a bridge request",
    );
    await run(session, other.hookToken);
    assert.equal((await run(submitted, other.hookToken)).decision, "block");
    assert.equal(
      (await run(submitted, "invalid-scoped-token")).decision,
      "block",
    );
    await run({ ...session, session_id: "new-thread" });
    assert.equal(
      (await run({ ...submitted, session_id: "new-thread" })).decision,
      "block",
    );
    bridge.revoke("origin");
    assert.equal((await run(submitted)).decision, "block");
    for (const platform of ["windows", "posix"] as const)
      for (const event of ["SessionStart", "UserPromptSubmit"] as const) {
        const config = annotationHookConfig(platform, event);
        assert.ok(config.startsWith(`hooks.${event}=`));
        assert.equal(config.includes(origin.hookToken), false);
        assert.equal(config.includes(url), false);
        assert.equal(config.includes("bypass-hook-trust"), false);
      }
  },
);
