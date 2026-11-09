import test from "node:test";
import assert from "node:assert/strict";
import {
  mermaidFences,
  nativeDiagramUnsupported,
  savedDiagrams,
} from "./terminal-diagrams";

test("native warning survives terminal line wrapping and padding", () => {
  assert.equal(
    nativeDiagramUnsupported([
      "This Mermaid diagram uses features the terminal  ",
      "renderer doesn't support.",
    ]),
    true,
  );
  assert.equal(
    nativeDiagramUnsupported([
      "This Mermaid diagram uses features the term",
      "inal renderer doesn’t support.",
    ]),
    true,
  );
  assert.equal(nativeDiagramUnsupported(["Normal terminal output"]), false);
});

test("only complete Mermaid fences are extracted, excluding literal examples", () => {
  assert.deepEqual(
    mermaidFences(
      [
        "````text",
        "```mermaid",
        "not a diagram",
        "```",
        "````",
        "~~~Mermaid",
        "flowchart TB",
        "A --> B",
        "~~~",
        "````mermaid",
        "graph LR",
        "C --> D",
        "```",
        "````",
        "```mermaid",
        "unfinished",
      ].join("\n"),
    ),
    ["flowchart TB\nA --> B", "graph LR\nC --> D\n```"],
  );
});

test("only saved final assistant diagrams enter the fallback", () => {
  const text = "```mermaid\ngraph LR\nA --> B\n```";
  assert.deepEqual(
    savedDiagrams([
      { id: "u", kind: "user", text },
      { id: "c", kind: "assistant", phase: "commentary", text },
      { id: "p", kind: "assistant", status: "inProgress", text },
      {
        id: "final",
        kind: "assistant",
        phase: "final_answer",
        status: "completed",
        text,
      },
    ]),
    [{ id: "final:0", source: "graph LR\nA --> B" }],
  );
  assert.deepEqual(
    mermaidFences("```mermaid\n" + "x".repeat(50001) + "\n```"),
    [],
  );
});
