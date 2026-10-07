import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ANNOTATION_COMMENT_LIMIT,
  ANNOTATION_DRAFT_TEXT_LIMIT,
  ANNOTATION_PROMPT_LIMIT,
  ANNOTATION_TEXT_LIMIT,
  annotationReference,
} from "../shared/annotations.js";
import {
  ANNOTATION_RECORD_LIMIT,
  TerminalAnnotations,
  annotationCaptureSchema,
} from "./terminal-annotations.js";

const input = (text = "Selected sentence\nSecond sentence") => ({
  text,
  source: {
    hostName: "Synthetic Server",
    title: "Synthetic answer",
    cwd: "/fixture/project",
  },
});
const ready = () => {
  const registry = new TerminalAnnotations();
  registry.markReady("terminal-a", "session-a");
  return registry;
};

test("annotations require native readiness; ordinary prompts add nothing", () => {
  const registry = new TerminalAnnotations();
  assert.equal(registry.isReady("terminal-a"), false);
  assert.throws(() => registry.capture("terminal-a", input()), /준비되지/);
  assert.throws(() => registry.validate("terminal-a", [1]), /준비되지/);
  assert.throws(
    () =>
      registry.resolve("terminal-a", "[#1 annotation] question", "session-a"),
    /준비되지/,
  );
  assert.equal(
    registry.resolve("terminal-a", "ordinary question", "session-a"),
    null,
  );
  registry.markReady("terminal-a", "session-a");
  assert.equal(registry.isReady("terminal-a"), true);
});

test("prepared captures bind immutably to the first deferred SessionStart", () => {
  const registry = new TerminalAnnotations();
  registry.prepare("terminal-a");
  assert.equal(registry.isReady("terminal-a"), true);
  const selected = input("Selected from resumed history before first prompt");
  const first = registry.capture("terminal-a", selected);
  selected.text = "changed later";
  const second = registry.capture(
    "terminal-a",
    input("Another pending selection"),
  );
  registry.attach("terminal-a", [
    { number: first.number, annotation: "Pending note before SessionStart" },
  ]);
  registry.validate("terminal-a", [first.number, second.number]);
  registry.markReady("terminal-a", "session-a");
  assert.equal(
    registry.resolve("terminal-a", first.reference, "session-a")!.annotations[0]
      .annotation,
    "Pending note before SessionStart",
  );
  assert.deepEqual(
    registry
      .resolve(
        "terminal-a",
        `${second.reference} ${first.reference}`,
        "session-a",
      )!
      .annotations.map((item) => item.text),
    [
      "Another pending selection",
      "Selected from resumed history before first prompt",
    ],
  );
  registry.markReady("terminal-a", "session-a");
  registry.prepare("terminal-a");
  assert.throws(
    () => registry.validate("terminal-a", [first.number]),
    /대화가 변경/,
  );
  registry.resolve("terminal-a", first.reference, "session-a");
  registry.validate("terminal-a", [first.number]);
});

test("authenticated first submit binds prepared refs when SessionStart is deferred or absent", () => {
  const registry = new TerminalAnnotations();
  registry.prepare("terminal-a");
  const initial = registry.capture("terminal-a", input("Before first submit"));
  assert.equal(
    registry.resolve("terminal-a", initial.reference, "session-first")!
      .annotations[0].text,
    "Before first submit",
  );
  registry.prepare("terminal-a");
  const pending = registry.capture(
    "terminal-a",
    input("After managed reconnect"),
  );
  registry.validate("terminal-a", [pending.number]);
  assert.throws(
    () => registry.validate("terminal-a", [initial.number]),
    /대화가 변경/,
  );
  assert.equal(
    registry.resolve("terminal-a", pending.reference, "session-next")!
      .annotations[0].text,
    "After managed reconnect",
  );
  assert.throws(
    () => registry.resolve("terminal-a", initial.reference, "session-next"),
    /대화가 변경/,
  );
  registry.prepare("terminal-a");
  const stillPending = registry.capture(
    "terminal-a",
    input("Another reconnect"),
  );
  assert.throws(() =>
    registry.resolve("terminal-a", stillPending.reference, ""),
  );
  registry.validate("terminal-a", [stillPending.number]);
  assert.equal(
    registry.resolve("terminal-a", stillPending.reference, "session-last")!
      .annotations[0].text,
    "Another reconnect",
  );
});

test("prepare and later SessionStart never rebind records from an assigned session", () => {
  const registry = new TerminalAnnotations();
  registry.prepare("terminal-a");
  const pending = registry.capture("terminal-a", input("Initial pending text"));
  registry.markReady("terminal-a", "session-first");
  const assigned = registry.capture("terminal-a", input("Assigned text"));
  registry.prepare("terminal-a");
  registry.markReady("terminal-a", "session-next");
  for (const reference of [pending, assigned]) {
    assert.throws(
      () => registry.validate("terminal-a", [reference.number]),
      /대화가 변경/,
    );
    assert.throws(
      () => registry.resolve("terminal-a", reference.reference, "session-next"),
      /대화가 변경/,
    );
  }
  const next = registry.capture("terminal-a", input("Next session text"));
  registry.validate("terminal-a", [next.number]);
  assert.equal(
    registry.resolve("terminal-a", next.reference, "session-next")!
      .annotations[0].text,
    "Next session text",
  );
  registry.revoke("terminal-a");
  registry.prepare("terminal-a");
  const newPending = registry.capture("terminal-a", input("Recreated pending"));
  assert.ok(newPending.number > next.number);
  registry.markReady("terminal-a", "session-last");
  assert.throws(
    () => registry.resolve("terminal-a", pending.reference, "session-last"),
    /찾을 수 없습니다/,
  );
  registry.validate("terminal-a", [newPending.number]);
});

test("captures are immutable; hidden context contains selected text, its note and minimal source", () => {
  const registry = ready();
  const original = input("  preserved whitespace\n한국어 and 😀\n");
  const captured = registry.capture("terminal-a", original);
  assert.deepEqual(captured, { number: 1, reference: "[#1 annotation]" });
  assert.equal(Object.isFrozen(captured), true);
  original.text = "changed after capture";
  original.source.hostName = "changed source";
  const context = registry.resolve(
    "terminal-a",
    captured.reference + " question",
    "session-a",
  );
  assert.deepEqual(context, {
    annotations: [
      {
        reference: captured.reference,
        text: "  preserved whitespace\n한국어 and 😀\n",
        annotation: "",
        source: {
          hostName: "Synthetic Server",
          title: "Synthetic answer",
          cwd: "/fixture/project",
        },
      },
    ],
  });
  assert.equal(Object.isFrozen(context), true);
  assert.equal(Object.isFrozen(context!.annotations[0].source), true);
  assert.throws(() => {
    (context!.annotations[0].source as { hostName: string }).hostName =
      "mutation";
  }, TypeError);
  assert.equal(JSON.stringify(context).includes("terminal-a"), false);
  assert.equal(JSON.stringify(context).includes("session-a"), false);
});

test("each marker carries its own note and preserves selection and source", () => {
  const registry = ready();
  const first = registry.capture(
    "terminal-a",
    input("First original selection"),
  );
  const second = registry.capture(
    "terminal-a",
    input("Second original selection"),
  );
  const notes = [
    {
      number: first.number,
      annotation: "왜 이렇게 설명했나요?\n한국어 note 😀",
    },
    {
      number: second.number,
      annotation: "이 예시는 두 번째 선택에 대한 설명입니다.",
    },
  ];
  registry.attach("terminal-a", notes);
  notes[0].annotation = "mutated after attaching";
  assert.deepEqual(
    registry.resolve(
      "terminal-a",
      `${second.reference} ${first.reference}`,
      "session-a",
    ),
    {
      annotations: [
        {
          reference: second.reference,
          text: "Second original selection",
          annotation: "이 예시는 두 번째 선택에 대한 설명입니다.",
          source: input().source,
        },
        {
          reference: first.reference,
          text: "First original selection",
          annotation: "왜 이렇게 설명했나요?\n한국어 note 😀",
          source: input().source,
        },
      ],
    },
  );
});

test("notes can change before submission and are sealed on first successful resolve", () => {
  const registry = ready();
  const first = registry.capture("terminal-a", input("Selected one"));
  const second = registry.capture("terminal-a", input("Selected two"));
  registry.attach("terminal-a", [
    { number: first.number, annotation: "Initial note" },
  ]);
  registry.attach("terminal-a", [
    { number: first.number, annotation: "Retry after paste failure" },
  ]);
  assert.throws(
    () =>
      registry.resolve(
        "terminal-a",
        `${first.reference} [#999 annotation]`,
        "session-a",
      ),
    /찾을 수 없습니다/,
  );
  registry.attach("terminal-a", [
    { number: first.number, annotation: "Final note" },
  ]);
  assert.equal(
    registry.resolve("terminal-a", first.reference, "session-a")!.annotations[0]
      .annotation,
    "Final note",
  );
  registry.attach("terminal-a", [
    { number: first.number, annotation: "Final note" },
  ]);
  assert.throws(
    () =>
      registry.attach("terminal-a", [
        { number: second.number, annotation: "Must not partially apply" },
        { number: first.number, annotation: "Changed after submission" },
      ]),
    /이미 전송/,
  );
  assert.equal(
    registry.resolve("terminal-a", second.reference, "session-a")!
      .annotations[0].annotation,
    "",
  );
  assert.equal(
    registry.resolve("terminal-a", first.reference, "session-a")!.annotations[0]
      .annotation,
    "Final note",
  );
});

test("note attachment validates terminal, native session and unique references atomically", () => {
  const registry = ready();
  registry.markReady("terminal-b", "session-b");
  const first = registry.capture("terminal-a", input("Original"));
  const foreign = registry.capture("terminal-b", input("Foreign"));
  registry.attach("terminal-a", [
    { number: first.number, annotation: "Original note" },
  ]);
  assert.throws(
    () =>
      registry.attach("terminal-a", [
        { number: first.number, annotation: "Must not overwrite" },
        { number: foreign.number, annotation: "Foreign note" },
      ]),
    /찾을 수 없습니다/,
  );
  assert.throws(
    () =>
      registry.attach("terminal-a", [
        { number: first.number, annotation: "Duplicated" },
        { number: first.number, annotation: "Duplicated again" },
      ]),
    /번호가 중복/,
  );
  assert.equal(
    registry.resolve("terminal-a", first.reference, "session-a")!.annotations[0]
      .annotation,
    "Original note",
  );
  registry.markReady("terminal-a", "session-new");
  assert.throws(
    () =>
      registry.attach("terminal-a", [
        { number: first.number, annotation: "Wrong session" },
      ]),
    /대화가 변경/,
  );
  registry.revoke("terminal-b");
  assert.throws(
    () =>
      registry.attach("terminal-b", [
        { number: foreign.number, annotation: "Revoked" },
      ]),
    /준비되지/,
  );
});

test("per-reference notes and combined selection plus note length are bounded without truncation", () => {
  const registry = ready();
  const refs = Array.from({ length: 4 }, () =>
    registry.capture(
      "terminal-a",
      input("x".repeat(ANNOTATION_TEXT_LIMIT - ANNOTATION_COMMENT_LIMIT)),
    ),
  );
  const full = refs.map((ref) => ({
    number: ref.number,
    annotation: "n".repeat(ANNOTATION_COMMENT_LIMIT),
  }));
  registry.attach("terminal-a", full);
  registry.validate(
    "terminal-a",
    refs.map((ref) => ref.number),
  );
  const extra = registry.capture("terminal-a", input("Extra selected text"));
  assert.throws(
    () =>
      registry.attach("terminal-a", [
        ...full,
        { number: extra.number, annotation: "n" },
      ]),
    /전체 인용/,
  );
  assert.throws(() =>
    registry.attach("terminal-a", [
      {
        number: extra.number,
        annotation: "n".repeat(ANNOTATION_COMMENT_LIMIT + 1),
      },
    ]),
  );
  assert.throws(
    () =>
      registry.validate("terminal-a", [
        ...refs.map((ref) => ref.number),
        extra.number,
      ]),
    /전체 인용/,
  );
  assert.throws(
    () =>
      registry.resolve(
        "terminal-a",
        [...refs, extra].map((ref) => ref.reference).join(" "),
        "session-a",
      ),
    /전체 인용/,
  );
  assert.equal(
    registry.resolve("terminal-a", extra.reference, "session-a")!.annotations[0]
      .annotation,
    "",
  );
  const resolved = registry.resolve(
    "terminal-a",
    refs.map((ref) => ref.reference).join(" "),
    "session-a",
  )!;
  assert.equal(
    resolved.annotations.reduce(
      (sum, item) => sum + item.text.length + item.annotation.length,
      0,
    ),
    ANNOTATION_DRAFT_TEXT_LIMIT,
  );
  assert.equal(
    resolved.annotations[0].annotation.length,
    ANNOTATION_COMMENT_LIMIT,
  );
});

test("global UTF-8 capacity includes attached notes and failed multi-note updates are atomic", () => {
  const registry = ready();
  const first = registry.capture("terminal-a", input("Small selection one"));
  const second = registry.capture("terminal-a", input("Small selection two"));
  registry.attach("terminal-a", [
    { number: first.number, annotation: "Existing note" },
  ]);
  const fill: number[] = [];
  for (;;) {
    try {
      fill.push(
        registry.capture(
          "terminal-a",
          input("한".repeat(ANNOTATION_TEXT_LIMIT)),
        ).number,
      );
    } catch (error) {
      assert.match((error as Error).message, /저장 공간이 가득/);
      break;
    }
  }
  // Bring the remaining space below two 8,000-character CJK notes. The capacity
  // uses encoded JSON bytes, so this exercises real UTF-8 and per-record overhead.
  for (;;) {
    try {
      fill.push(
        registry.capture("terminal-a", input("한".repeat(1000))).number,
      );
    } catch (error) {
      assert.match((error as Error).message, /저장 공간이 가득/);
      break;
    }
  }
  assert.throws(
    () =>
      registry.attach("terminal-a", [
        { number: first.number, annotation: "small change" },
        {
          number: second.number,
          annotation: "한".repeat(ANNOTATION_COMMENT_LIMIT),
        },
      ]),
    /저장 공간이 가득/,
  );
  assert.equal(
    registry.resolve("terminal-a", first.reference, "session-a")!.annotations[0]
      .annotation,
    "Existing note",
  );
  registry.remove("terminal-a", fill.slice(0, 2));
  registry.attach("terminal-a", [
    { number: first.number, annotation: "Existing note" },
    {
      number: second.number,
      annotation: "한".repeat(ANNOTATION_COMMENT_LIMIT),
    },
  ]);
  for (;;) {
    try {
      registry.capture("terminal-a", input("한".repeat(1000)));
    } catch (error) {
      assert.match((error as Error).message, /저장 공간이 가득/);
      break;
    }
  }
  assert.throws(
    () => registry.capture("terminal-a", input("한".repeat(6000))),
    /저장 공간이 가득/,
  );
  registry.attach("terminal-a", [
    { number: second.number, annotation: "Reduced note" },
  ]);
  registry.capture("terminal-a", input("한".repeat(6000)));
  assert.equal(
    registry.resolve("terminal-a", first.reference, "session-a")!.annotations[0]
      .annotation,
    "Existing note",
  );
  assert.equal(
    registry.resolve("terminal-a", second.reference, "session-a")!
      .annotations[0].annotation,
    "Reduced note",
  );
  registry.revoke("terminal-a");
  registry.markReady("terminal-b", "session-b");
  const next = registry.capture("terminal-b", input("New selection"));
  registry.attach("terminal-b", [
    { number: next.number, annotation: "한".repeat(ANNOTATION_COMMENT_LIMIT) },
  ]);
  assert.equal(
    registry.resolve("terminal-b", next.reference, "session-b")!.annotations[0]
      .annotation.length,
    ANNOTATION_COMMENT_LIMIT,
  );
});

test("terminal and session boundaries prevent foreign reference lookup", () => {
  const registry = ready();
  registry.markReady("terminal-b", "session-b");
  const a = registry.capture("terminal-a", input("only a"));
  const b = registry.capture("terminal-b", input("only b"));
  assert.ok(b.number > a.number);
  assert.throws(
    () => registry.resolve("terminal-b", a.reference, "session-b"),
    /찾을 수 없습니다/,
  );
  assert.throws(
    () => registry.validate("terminal-a", [b.number]),
    /찾을 수 없습니다/,
  );
  assert.throws(
    () => registry.resolve("terminal-a", a.reference, "session-b"),
    /현재 대화가 다릅니다/,
  );
  assert.deepEqual(
    registry
      .resolve("terminal-b", b.reference, "session-b")!
      .annotations.map((item) => item.text),
    ["only b"],
  );
});

test("only referenced records resolve; repeated markers are deduplicated in prompt order", () => {
  const registry = ready();
  const refs = ["unmentioned", "second", "third"].map((text) =>
    registry.capture("terminal-a", input(text)),
  );
  const context = registry.resolve(
    "terminal-a",
    `${refs[2].reference} ${refs[1].reference} ${refs[2].reference}`,
    "session-a",
  );
  assert.deepEqual(
    context!.annotations.map((item) => item.text),
    ["third", "second"],
  );
  assert.equal(JSON.stringify(context).includes("unmentioned"), false);
  assert.throws(
    () => registry.validate("terminal-a", [refs[0].number, refs[0].number]),
    /인용 번호가 중복/,
  );
});

test("session changes invalidate old refs while repeated readiness preserves current refs", () => {
  const registry = ready();
  const first = registry.capture("terminal-a", input());
  registry.markReady("terminal-a", "session-a");
  registry.validate("terminal-a", [first.number]);
  registry.markReady("terminal-a", "session-new");
  assert.throws(
    () => registry.validate("terminal-a", [first.number]),
    /대화가 변경/,
  );
  assert.throws(
    () => registry.resolve("terminal-a", first.reference, "session-new"),
    /대화가 변경/,
  );
  assert.throws(
    () => registry.resolve("terminal-a", first.reference, "session-a"),
    /현재 대화가 다릅니다/,
  );
  const next = registry.capture(
    "terminal-a",
    input("new session selected text"),
  );
  assert.ok(next.number > first.number);
  registry.validate("terminal-a", [next.number]);
});

test("revoke deletes readiness and data; terminal ID reuse never reuses old numbers", () => {
  const registry = ready();
  const first = registry.capture("terminal-a", input());
  registry.revoke("terminal-a");
  assert.equal(registry.isReady("terminal-a"), false);
  assert.throws(
    () => registry.resolve("terminal-a", first.reference, "session-a"),
    /준비되지/,
  );
  registry.markReady("terminal-a", "session-next");
  const next = registry.capture("terminal-a", input("new data"));
  assert.ok(next.number > first.number);
  assert.throws(
    () => registry.resolve("terminal-a", first.reference, "session-next"),
    /찾을 수 없습니다/,
  );
  registry.revoke("terminal-a");
  registry.revoke("terminal-a");
});

test("simultaneous window captures receive unique monotonically increasing numbers", async () => {
  const registry = ready();
  const refs = await Promise.all(
    Array.from({ length: 50 }, (_, index) =>
      Promise.resolve().then(() =>
        registry.capture("terminal-a", input(`selection ${index}`)),
      ),
    ),
  );
  assert.deepEqual(
    refs.map((ref) => ref.number),
    Array.from({ length: 50 }, (_, index) => index + 1),
  );
  for (let index = 0; index < refs.length; index++)
    assert.equal(
      registry.resolve("terminal-a", refs[index].reference, "session-a")!
        .annotations[0].text,
      `selection ${index}`,
    );
});

test("each selection and draft are bounded without truncating accepted data", () => {
  const registry = ready();
  assert.throws(() =>
    registry.capture(
      "terminal-a",
      input("x".repeat(ANNOTATION_TEXT_LIMIT + 1)),
    ),
  );
  assert.throws(() => registry.capture("terminal-a", input(" \n\t")));
  assert.equal(
    annotationCaptureSchema.safeParse({
      ...input(),
      before: "unselected neighbor",
    }).success,
    false,
  );
  const full = Array.from({ length: 4 }, () =>
    registry.capture("terminal-a", input("x".repeat(ANNOTATION_TEXT_LIMIT))),
  );
  assert.equal(full[0].number, 1, "failed captures do not allocate numbers");
  registry.validate(
    "terminal-a",
    full.map((ref) => ref.number),
  );
  const context = registry.resolve(
    "terminal-a",
    full.map((ref) => ref.reference).join(" "),
    "session-a",
  )!;
  assert.equal(
    context.annotations.reduce((total, item) => total + item.text.length, 0),
    ANNOTATION_DRAFT_TEXT_LIMIT,
  );
  const extra = registry.capture("terminal-a", input("y"));
  assert.throws(
    () =>
      registry.validate("terminal-a", [
        ...full.map((ref) => ref.number),
        extra.number,
      ]),
    /전체 인용/,
  );
  assert.throws(
    () =>
      registry.resolve(
        "terminal-a",
        [...full, extra].map((ref) => ref.reference).join(" "),
        "session-a",
      ),
    /전체 인용/,
  );
});

test("draft count, malformed numbers and oversized prompts fail explicitly", () => {
  const registry = ready();
  const refs = Array.from({ length: 9 }, (_, i) =>
    registry.capture("terminal-a", input(String(i))),
  );
  assert.throws(() =>
    registry.validate(
      "terminal-a",
      refs.map((ref) => ref.number),
    ),
  );
  assert.throws(
    () =>
      registry.resolve(
        "terminal-a",
        refs.map((ref) => ref.reference).join(" "),
        "session-a",
      ),
    /8개까지/,
  );
  for (const marker of [
    "[#0 annotation]",
    "[#01 annotation]",
    "[#9007199254740992 annotation]",
  ])
    assert.throws(
      () => registry.resolve("terminal-a", marker, "session-a"),
      /번호가 올바르지/,
    );
  assert.equal(
    registry.resolve(
      "terminal-a",
      "[#1 Annotation] [#1annotation]",
      "session-a",
    ),
    null,
  );
  assert.throws(
    () =>
      registry.resolve(
        "terminal-a",
        "x".repeat(ANNOTATION_PROMPT_LIMIT + 1),
        "session-a",
      ),
    /입력이 너무 깁니다/,
  );
  assert.throws(() => registry.validate("terminal-a", []));
});

test("global record capacity rejects new refs without silently replacing existing data", () => {
  const registry = ready();
  const refs = Array.from({ length: ANNOTATION_RECORD_LIMIT }, (_, i) =>
    registry.capture("terminal-a", input(`record ${i}`)),
  );
  assert.throws(
    () => registry.capture("terminal-a", input("overflow")),
    /저장 공간이 가득/,
  );
  assert.equal(
    registry.resolve("terminal-a", refs[0].reference, "session-a")!
      .annotations[0].text,
    "record 0",
  );
  registry.remove("terminal-a", [refs[0].number]);
  const next = registry.capture("terminal-a", input("after explicit removal"));
  assert.equal(next.number, ANNOTATION_RECORD_LIMIT + 1);
  assert.throws(
    () => registry.resolve("terminal-a", refs[0].reference, "session-a"),
    /찾을 수 없습니다/,
  );
  registry.revoke("terminal-a");
  registry.markReady("terminal-b", "session-b");
  assert.ok(registry.capture("terminal-b", input()).number > next.number);
});

test("global UTF-8 byte capacity rejects oversize storage and revoke frees capacity", () => {
  const registry = ready();
  const accepted: number[] = [];
  for (let i = 0; i < ANNOTATION_RECORD_LIMIT; i++) {
    try {
      accepted.push(
        registry.capture(
          "terminal-a",
          input("한".repeat(ANNOTATION_TEXT_LIMIT)),
        ).number,
      );
    } catch (error) {
      assert.match((error as Error).message, /저장 공간이 가득/);
      break;
    }
  }
  assert.ok(accepted.length > 10 && accepted.length < ANNOTATION_RECORD_LIMIT);
  assert.throws(
    () =>
      registry.capture("terminal-a", input("한".repeat(ANNOTATION_TEXT_LIMIT))),
    /저장 공간이 가득/,
  );
  const last = accepted.at(-1)!;
  assert.equal(
    registry.resolve("terminal-a", annotationReference(last), "session-a")!
      .annotations[0].text.length,
    ANNOTATION_TEXT_LIMIT,
  );
  registry.revoke("terminal-a");
  registry.markReady("terminal-b", "session-b");
  assert.ok(
    registry.capture("terminal-b", input("한".repeat(ANNOTATION_TEXT_LIMIT)))
      .number > last,
  );
});

test("source metadata and ready namespaces are bounded", () => {
  const registry = ready();
  assert.throws(() =>
    registry.capture("terminal-a", {
      text: "text",
      source: { hostName: "x".repeat(301), title: "title" },
    }),
  );
  assert.throws(() =>
    registry.capture("terminal-a", {
      text: "text",
      source: { hostName: "server", title: "title", cwd: "x".repeat(4097) },
    }),
  );
  assert.throws(() => registry.markReady("", "session"));
  assert.throws(() => registry.markReady("terminal", ""));
  for (let i = 1; i < ANNOTATION_RECORD_LIMIT; i++)
    registry.markReady(`terminal-${i}`, `session-${i}`);
  assert.throws(
    () => registry.markReady("overflow", "session"),
    /터미널이 너무 많습니다/,
  );
  registry.revoke("terminal-a");
  registry.markReady("overflow", "session");
});
