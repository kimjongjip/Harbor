import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import {
  classifyLink,
  normalizeMath,
  plainFilePattern,
  fileParentDirectory,
} from "../shared/links.js";

test("relative Korean paths and source line suffixes are clickable without changing directory roots", () => {
  for (const value of [
    "README.md:12",
    "docs/설명.md:12:3",
    "../docs/설명.md#L12",
    "./설명.md:12",
  ]) {
    const target = classifyLink(value);
    assert.equal(target.kind, "file");
    if (target.kind === "file") assert.equal(target.line, 12);
    assert.equal(
      [...value.matchAll(new RegExp(plainFilePattern))][0]?.[0],
      value,
    );
  }
  assert.equal(fileParentDirectory("/README.md"), "/");
  assert.equal(fileParentDirectory("C:\\README.md"), "C:\\");
  assert.equal(fileParentDirectory("C:/docs/README.md"), "C:/docs");
  assert.equal(
    fileParentDirectory("/home/user/docs/README.md"),
    "/home/user/docs",
  );
  assert.equal(classifyLink("javascript:12").kind, "blocked");
  assert.deepEqual(classifyLink("docs/hello%20world.md"), {
    kind: "file",
    path: "docs/hello world.md",
  });
});

test("resource links preserve Windows, Linux, relative paths and line references while rejecting executable URIs", () => {
  assert.deepEqual(classifyLink("https://example.com/chart.png?q=1"), {
    kind: "web",
    url: "https://example.com/chart.png?q=1",
    image: true,
  });
  assert.deepEqual(classifyLink("/home/user/chart.png"), {
    kind: "file",
    path: "/home/user/chart.png",
  });
  assert.deepEqual(classifyLink("src/App.tsx:42:7"), {
    kind: "file",
    path: "src/App.tsx",
    line: 42,
  });
  assert.deepEqual(classifyLink("C:/Users/user/plot.png#L8"), {
    kind: "file",
    path: "C:/Users/user/plot.png",
    line: 8,
  });
  assert.deepEqual(classifyLink("file:///C:/project/hello%20world.txt"), {
    kind: "file",
    path: "C:/project/hello world.txt",
  });
  for (const uri of [
    "javascript:alert(1)",
    "data:text/html,test",
    "javascript%3Aalert(1)",
    "command:delete",
    "//evil.example",
    "\n",
  ])
    assert.equal(classifyLink(uri).kind, "blocked");
});
test("math delimiters normalize without changing fenced or inline code", () => {
  const input =
    "inline \\(x^2\\), block \\[\\frac{1}{2}\\]. `$x$` and ```tex\n\\(unchanged\\)\n```";
  const result = normalizeMath(input);
  assert.match(result, /inline \$x\^2\$/);
  assert.ok(result.includes("$$\n\\frac{1}{2}\n$$"));
  assert.ok(result.includes("`$x$`"));
  assert.ok(result.includes("```tex\n\\(unchanged\\)\n```"));
});
