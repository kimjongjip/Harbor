import test from "node:test";
import assert from "node:assert/strict";
import {
  readDroppedSelection,
  selectionFromFiles,
  uploadManifest,
} from "./upload-selection.js";
import {
  validateUploadManifest,
  UPLOAD_FILE_LIMIT,
} from "../shared/upload-tree.js";
import { needsFileAuthentication } from "./file-errors.js";

const fileEntry = (name: string, text = "fixture") => ({
  name,
  isFile: true,
  isDirectory: false,
  file: (done: Function) => done(new File([text], name)),
});
const folderEntry = (name: string, batches: any[][]) => ({
  name,
  isFile: false,
  isDirectory: true,
  createReader: () => {
    let i = 0;
    return { readEntries: (done: Function) => done(batches[i++] || []) };
  },
});
function transfer(entries: any[]) {
  return {
    files: [],
    items: entries.map((entry) => ({
      kind: "file",
      webkitGetAsEntry: () => entry,
      getAsFile: () => null,
    })),
  } as unknown as DataTransfer;
}

test("folder drops preserve nested paths, hidden files, empty folders and all native reader batches", async () => {
  const entries = Array.from({ length: 101 }, (_, i) =>
    fileEntry(`file-${i}.txt`),
  );
  const root = folderEntry("dataset", [
    entries.slice(0, 100),
    [
      entries[100],
      folderEntry("empty", []),
      folderEntry("nested", [[fileEntry(".config")]]),
    ],
  ]);
  const result = await readDroppedSelection(
    transfer([root, fileEntry("loose.txt")]),
  );
  assert.equal(result.files.length, 103);
  assert.ok(
    result.files.some((f) => f.relativePath === "dataset/file-100.txt"),
  );
  assert.ok(
    result.files.some((f) => f.relativePath === "dataset/nested/.config"),
  );
  assert.deepEqual(result.directories, [
    "dataset",
    "dataset/empty",
    "dataset/nested",
  ]);
  assert.equal(
    result.files.find((f) => f.relativePath === "loose.txt")?.file.name,
    "loose.txt",
  );
  assert.equal(await result.files[0].file.text(), "fixture");
});
test("drop entries are captured before the native transfer store is protected", async () => {
  let read: Function;
  const file = fileEntry("source.txt");
  file.file = (done) => {
    read = done;
  };
  const data = transfer([file]);
  const pending = readDroppedSelection(data);
  Object.defineProperty(data, "items", { value: [] });
  read!(new File(["original bytes"], "source.txt"));
  assert.equal(await (await pending).files[0].file.text(), "original bytes");
});
test("folder picker paths preserve their root and directories, while ordinary files remain flat", () => {
  const file = new File(["text"], "note.md");
  Object.defineProperty(file, "webkitRelativePath", {
    value: "project/docs/note.md",
  });
  const result = selectionFromFiles([file]);
  assert.deepEqual(result.directories, ["project", "project/docs"]);
  assert.equal(result.files[0].relativePath, "project/docs/note.md");
  assert.deepEqual(
    selectionFromFiles([new File(["x"], "plain.txt")]).directories,
    [],
  );
});
test("malformed paths, duplicate destinations, missing parents and oversized files fail before uploads", async () => {
  for (const name of [
    "../escape",
    "/absolute",
    "folder/../escape",
    "folder\\escape",
    "folder//file",
  ])
    assert.throws(() =>
      validateUploadManifest({
        directories: [],
        files: [{ relativePath: name, size: 1 }],
      }),
    );
  assert.throws(() =>
    validateUploadManifest({
      directories: ["same"],
      files: [{ relativePath: "same", size: 0 }],
    }),
  );
  assert.throws(() =>
    validateUploadManifest({
      directories: [],
      files: [{ relativePath: "parent/file", size: 0 }],
    }),
  );
  assert.throws(
    () =>
      validateUploadManifest({
        directories: ["folder"],
        files: [{ relativePath: "folder/huge", size: UPLOAD_FILE_LIMIT + 1 }],
      }),
    /512MB/,
  );
  assert.throws(
    () =>
      validateUploadManifest({
        directories: [],
        files: Array.from({ length: 6000 }, (_, i) => ({
          relativePath: `${"가".repeat(80)}${i}.txt`,
          size: 1,
        })),
      }),
    /목록이 너무 큽니다/,
  );
  await assert.rejects(
    readDroppedSelection(transfer([folderEntry("invalid/../root", [])])),
  );
  const bad = {
    ...fileEntry("broken"),
    file: (_: Function, fail: Function) =>
      fail(new Error("Local file unavailable")),
  };
  await assert.rejects(
    readDroppedSelection(transfer([bad])),
    /Local file unavailable/,
  );
});
test("only actual SSH authentication failures request authentication", () => {
  for (const message of [
    "폴더는 압축한 뒤 올려주세요.",
    "Permission denied",
    "EACCES",
    "No such file",
    "업로드 목록이 잘못되었습니다.",
    "화면을 새로고침하세요.",
    "Connection timed out",
  ])
    assert.equal(needsFileAuthentication(new Error(message)), false);
  assert.equal(needsFileAuthentication({ code: "SSH_AUTH_REQUIRED" }), true);
  assert.equal(
    needsFileAuthentication(
      new Error("All configured authentication methods failed"),
    ),
    true,
  );
  assert.equal(
    needsFileAuthentication(new Error("SFTP 인증에 사용할 SSH 키가 없습니다.")),
    true,
  );
  assert.deepEqual(
    uploadManifest(selectionFromFiles([new File(["x"], "file")])),
    { directories: [], files: [{ relativePath: "file", size: 1 }] },
  );
});
