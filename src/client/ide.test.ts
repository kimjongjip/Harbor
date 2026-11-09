import test from "node:test";
import assert from "node:assert/strict";
import { createIdeApi, IdeApiError, type IdeFile } from "./ide/types";
import { documentKey, dirtyFile, savedFile, selectionText } from "./ide/state";
import {
  quoteIdeSelection,
  registerIdeAnnotation,
} from "./ide/annotationBridge";

const file: IdeFile = {
  terminalId: "one",
  hostId: "server-a",
  root: "/project",
  path: "/project/code.ts",
  content: "base",
  version: "v1",
  binding: "bound-to-one",
};
test("editor identity distinguishes servers while save acknowledgement retains later drafts", () => {
  assert.notEqual(
    documentKey(file),
    documentKey({ ...file, hostId: "server-b" }),
  );
  const acknowledged = savedFile(file, {
    ...file,
    content: "sent snapshot",
    version: "v2",
  });
  assert.equal(dirtyFile(acknowledged, "typed during save"), true);
  assert.throws(
    () => savedFile(file, { ...file, terminalId: "other" }),
    /원래 파일/,
  );
});
test("injected editor API preserves conflict contents and binding without desktop credentials", async () => {
  let received: RequestInit | undefined;
  const client = createIdeApi(async (path, init) => {
    assert.equal(path, "/desktop-api/editor/one/file");
    received = init;
    return new Response(
      JSON.stringify({
        error: "changed",
        code: "EDITOR_CONFLICT",
        current: { ...file, content: "new server", version: "v2" },
      }),
      { status: 409 },
    );
  }, "/desktop-api/editor");
  await assert.rejects(
    client.save(file, "my draft"),
    (error: unknown) =>
      error instanceof IdeApiError && error.current?.content === "new server",
  );
  assert.deepEqual(JSON.parse(received!.body as string), {
    path: file.path,
    content: "my draft",
    expectedVersion: "v1",
    binding: file.binding,
  });
  assert.equal(new Headers(received?.headers).has("X-Harbor-Token"), false);
});
test("editor API carries explicit encoding and preserves non-text recovery details", async () => {
  const details = {
    terminalId: file.terminalId,
    hostId: file.hostId,
    root: file.root,
    path: file.path,
    size: 24,
    preview: "download",
    encodings: ["cp949"],
  };
  const reads: string[] = [];
  let saved: any;
  const client = createIdeApi(async (path, init) => {
    reads.push(path);
    if (init.method === "PUT") {
      saved = JSON.parse(init.body as string);
      return new Response(
        JSON.stringify({ ...file, encoding: "cp949", bom: false }),
      );
    }
    return new Response(
      JSON.stringify({
        error: "choose encoding",
        code: "EDITOR_ENCODING_REQUIRED",
        details,
      }),
      { status: 415 },
    );
  });
  await assert.rejects(
    client.read(file.terminalId, file.path, "cp949"),
    (error: unknown) => {
      assert.ok(error instanceof IdeApiError);
      assert.deepEqual(error.details, details);
      return true;
    },
  );
  assert.equal(
    new URL(reads[0], "http://fixture.invalid").searchParams.get("encoding"),
    "cp949",
  );
  await client.save({ ...file, encoding: "cp949", bom: false }, "수정");
  assert.equal(saved.encoding, "cp949");
  assert.equal(saved.content, "수정");
});
test("IDE references preserve selected file/range and only reach their own mounted terminal", async () => {
  const selection = {
    terminalId: "one",
    hostId: file.hostId,
    path: file.path,
    root: file.root,
    text: "const n = 7;",
    startLine: 3,
    endLine: 3,
    startColumn: 1,
    endColumn: 13,
    unsaved: true,
  };
  const captured: string[] = [];
  const release = registerIdeAnnotation("one", async (value) => {
    captured.push(selectionText(value));
  });
  await quoteIdeSelection(selection);
  assert.match(
    captured[0],
    /code\.ts\n범위: 3:1–3:13 \(아직 저장하지 않은 편집 내용\)/,
  );
  await assert.rejects(
    quoteIdeSelection({ ...selection, terminalId: "two" }),
    /해당 터미널/,
  );
  release();
  await assert.rejects(quoteIdeSelection(selection), /해당 터미널/);
  assert.throws(
    () => selectionText({ ...selection, text: "a".repeat(16000) }),
    /16,000/,
  );
});
