import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { chromium } from "playwright";
import assert from "node:assert/strict";
const folder = resolve(".cache/selection-scroll");
mkdirSync(folder, { recursive: true });
await build({
  stdin: {
    contents: `import {Terminal} from '@xterm/xterm'; import {installTerminalSelection} from './src/client/terminalSelection.ts';
import React from 'react'; import {createRoot} from 'react-dom/client'; import {TerminalRich} from './src/client/TerminalTypeset.tsx';
const richRoot=createRoot(document.getElementById('react')); window.renderRich=block=>richRoot.render(React.createElement(TerminalRich,{term,info:{id:'fixture',hostId:'fixture',title:'Synthetic terminal',cwd:'/fixture',exited:false,agentSessionId:'native-fixture'},blocks:[block]}));
const term=new Terminal({cols:80,rows:20,scrollback:500,fontSize:16,allowProposedApi:true});term.open(document.getElementById('mount'));window.notices=[];window.selectionController=installTerminalSelection(document.getElementById('mount'),term,()=>true,{onNotice:message=>notices.push(message)});window.selected=()=>selectionController.getSelection()??term.getSelection();window.term=term;window.inputs=[];term.onData(s=>inputs.push(s));window.write=s=>new Promise(r=>term.write(s,r));`,
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" },
  outfile: join(folder, "fixture.js"),
});
writeFileSync(
  join(folder, "index.html"),
  `<link rel="stylesheet" href="../../node_modules/@xterm/xterm/css/xterm.css"><link rel="stylesheet" href="fixture.css"><style>body{margin:20px} #mount{width:850px;height:420px}</style><div id="mount" class="terminal-mount"></div><div id="react"></div><script src="fixture.js"></script>`,
);
// A real Chromium renderer, with no backend, SSH connection or AI process.
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1000, height: 650 } });
try {
  await page.goto(
    "file:///" + join(folder, "index.html").replaceAll("\\", "/"),
  );
  await page.waitForFunction(() => window.term?.element);
  await page.evaluate(async () => {
    await write(
      Array.from(
        { length: 100 },
        (_, i) =>
          "ROW " +
          String(i).padStart(3, "0") +
          " long selectable sentence with Korean 한글 and words",
      ).join("\r\n"),
    );
    await write("\x1b[?1003h\x1b[?1006h");
    term.scrollToLine(40);
  });
  await page.waitForTimeout(150);
  const box = await page.locator(".xterm-screen").boundingBox();
  const cellH = box.height / 20,
    cellW = box.width / 80;
  await page.mouse.move(box.x + cellW * 4, box.y + cellH * 15.5);
  await page.mouse.down();
  await page.mouse.move(box.x + cellW * 30, box.y + cellH * 9.5, { steps: 10 });
  const before = await page.evaluate(() => ({
    selection: term.getSelection(),
    y: term.buffer.active.viewportY,
    inputs: inputs.length,
  }));
  await page.mouse.wheel(0, -180);
  await page.waitForTimeout(200);
  await page.mouse.move(box.x + cellW * 31, box.y + cellH * 9.5, { steps: 2 });
  const during = await page.evaluate(() => ({
    selection: term.getSelection(),
    y: term.buffer.active.viewportY,
    inputs: inputs.length,
  }));
  await page.mouse.up();
  console.log(
    JSON.stringify({
      before: {
        length: before.selection.length,
        y: before.y,
        inputs: before.inputs,
      },
      during: {
        length: during.selection.length,
        y: during.y,
        inputs: during.inputs,
      },
    }),
  );
  if (process.env.BASELINE === "1") process.exitCode = 0;
  else {
    assert.ok(before.selection.length > 0);
    assert.ok(during.selection.endsWith(before.selection.slice(-30)));
    assert.ok(during.selection.length > before.selection.length);
    assert.ok(during.y < before.y);
    assert.equal(during.inputs, before.inputs);
    const selected = await page.evaluate(() => term.getSelection());
    await page.mouse.wheel(0, -80);
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => term.getSelection()), selected);
    await page.evaluate(async () => {
      term.reset();
      window.nativePosition = 60;
      window.nativeDelay = 250;
      window.nativeSplit = false;
      window.nativeRow = (i) =>
        "ROW " + String(i).padStart(3, "0") + " native answer 한글 text";
      window.nativeDraw = () =>
        write(
          "\x1b[H" +
            [
              "FIXED HEADER",
              ...Array.from({ length: 17 }, (_, i) =>
                nativeRow(nativePosition + i),
              ),
              "FIXED STATUS",
              "FIXED PROMPT",
            ]
              .map((t) => "\x1b[2K" + t)
              .join("\r\n"),
        );
      await write("\x1b[?1049h\x1b[?1003h\x1b[?1006h");
      await nativeDraw();
      inputs.length = 0;
      window.nativeProvider = term.onData((data) => {
        const direction = data.includes("[<64;")
          ? -1
          : data.includes("[<65;")
            ? 1
            : 0;
        if (!direction) return;
        setTimeout(() => {
          nativePosition = Math.max(
            0,
            Math.min(120, nativePosition + 3 * direction),
          );
          if (nativeSplit) {
            void write("\x1b[?2026h\x1b[2J");
            setTimeout(async () => {
              await nativeDraw();
              await write("\x1b[?2026l");
            }, 1400);
          } else void nativeDraw();
        }, nativeDelay);
      });
    });
    const expected = (first, last) =>
      Array.from(
        { length: last - first },
        (_, i) =>
          "ROW " +
          String(first + i).padStart(3, "0") +
          " native answer 한글 text",
      ).join("\n") + "\n";
    const text = () => page.evaluate(() => selected().replaceAll("\r\n", "\n"));
    await page.mouse.move(box.x + 1, box.y + cellH * 14.5);
    await page.mouse.down();
    await page.mouse.move(box.x + 1, box.y + cellH * 6.5, { steps: 10 });
    assert.equal(await text(), expected(65, 73));
    for (const top of [57, 54]) {
      await page.mouse.wheel(0, -120);
      await page.waitForTimeout(35);
      assert.ok(
        await page.evaluate(() => term.hasSelection()),
        "native mouse input must not erase the highlight while waiting for a remote redraw",
      );
      await page.waitForFunction((top) => nativePosition === top, top);
      await page.waitForTimeout(100);
      assert.equal(await text(), expected(top + 5, 73));
    }
    await page.mouse.wheel(0, 120);
    await page.waitForFunction(() => nativePosition === 57);
    await page.waitForTimeout(100);
    assert.equal(await text(), expected(62, 73));
    await page.mouse.up();
    const released = await text();
    await page.mouse.wheel(0, -120);
    await page.waitForFunction(() => nativePosition === 54);
    await page.waitForTimeout(100);
    assert.equal(await text(), released);
    // A remote redraw can arrive after mouseup. Its requested final endpoint
    // must still be applied, without waiting for another mouse movement.
    await page.keyboard.press("Escape");
    await page.evaluate(() => {
      nativeDelay = 250;
    });
    await page.mouse.move(box.x + 1, box.y + cellH * 14.5);
    await page.mouse.down();
    await page.mouse.move(box.x + 1, box.y + cellH * 6.5, { steps: 10 });
    await page.mouse.wheel(0, -120);
    await page.mouse.up();
    await page.waitForFunction(() => nativePosition === 51);
    await page.waitForTimeout(100);
    assert.equal(await text(), expected(56, 67));
    await page.evaluate(() => {
      nativeDelay = 15;
    });
    // A synchronized redraw split by SSH can outlast the normal response timer.
    await page.keyboard.press("Escape");
    await page.mouse.move(box.x + 1, box.y + cellH * 14.5);
    await page.mouse.down();
    await page.mouse.move(box.x + 1, box.y + cellH * 6.5, { steps: 10 });
    await page.evaluate(() => {
      nativeSplit = true;
    });
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(1300);
    assert.equal(await page.evaluate(() => notices.length), 0);
    await page.waitForFunction(
      () =>
        !term.modes.synchronizedOutputMode &&
        term.buffer.active
          .getLine(1)
          ?.translateToString(true)
          .includes(nativeRow(48)),
    );
    await page.waitForTimeout(150);
    assert.equal(await text(), expected(53, 64));
    assert.ok(await page.evaluate(() => term.hasSelection()));
    await page.mouse.up();
    await page.evaluate(() => {
      nativeSplit = false;
    });
    // This must scroll without a wheel too: hold the pointer beyond the top edge.
    await page.keyboard.press("Escape");
    await page.mouse.move(box.x + 1, box.y + cellH * 14.5);
    await page.mouse.down();
    await page.mouse.move(box.x + 1, box.y - 3, { steps: 10 });
    await page.waitForFunction(() => nativePosition < 48);
    await page.mouse.up();
    await page.waitForTimeout(100);
    assert.ok((await text()).split("\n").length > 14);
    assert.equal(await page.evaluate(() => notices.length), 0);
    await page.keyboard.press("Escape");
    assert.equal(await text(), "");
    const position = await page.evaluate(() => nativePosition);
    await page.mouse.move(box.x + 100, box.y + 100);
    await page.mouse.wheel(0, -120);
    await page.waitForFunction((p) => nativePosition < p, position);
    await page.evaluate(() => nativeProvider.dispose());
    await page.evaluate(async () => {
      term.reset();
      const id = "abcdef0123456789abcd";
      await write(
        [
          ...Array.from({ length: 50 }, (_, i) => "BEFORE " + i),
          ...Array.from({ length: 14 }, (_, i) => "~HBR:" + id + ":" + i + "~"),
          ...Array.from({ length: 50 }, (_, i) => "AFTER " + i),
        ].join("\r\n"),
      );
      term.scrollToLine(47);
      renderRich({
        id,
        requestId: "fixture",
        sessionId: "native-fixture",
        text: "First selected paragraph with Korean 한글.\n\nSecond selected paragraph with words.\n\nThird selected paragraph.\n\nFinal selected paragraph.",
        columns: 80,
        viewportRows: 20,
        rows: 14,
        renderer: "rows-v2",
        state: "ready",
        createdAt: 0,
        marker: "fixture",
      });
    });
    await page
      .locator('[data-terminal-rich="true"] .markdown p')
      .first()
      .waitFor();
    const first = await page
        .locator(".terminal-rich-content p")
        .first()
        .boundingBox(),
      second = await page
        .locator(".terminal-rich-content p")
        .nth(1)
        .boundingBox();
    await page.mouse.move(first.x + 8, first.y + 12);
    await page.mouse.down();
    await page.mouse.move(second.x + 150, second.y + 12, { steps: 8 });
    await page.waitForTimeout(80);
    const richBefore = await page.evaluate(() => getSelection().toString());
    assert.ok(richBefore.length > 20);
    await page.mouse.wheel(0, 750);
    await page.waitForTimeout(120);
    await page.mouse.up();
    const retained = await page.evaluate(() => ({
      text: getSelection().toString(),
      connected: getSelection().anchorNode?.isConnected,
      y: term.buffer.active.viewportY,
    }));
    assert.ok(retained.connected);
    assert.equal(retained.text, richBefore);
    assert.ok(retained.y > 61);
    await page.screenshot({ path: join(folder, "selection.png") });
    console.log(
      JSON.stringify({
        passed: true,
        dragScrollExtendsSelection: true,
        completedSelectionStable: true,
        fullscreenScrollDuringDrag: true,
        fullscreenSelectionExactAcrossPages: true,
        edgeDragAutoscroll: true,
        nativeWheelUnchangedWhenNotSelecting: true,
        richSelectionSurvivesOffscreen: true,
        modelCalls: 0,
      }),
    );
  }
} finally {
  await browser.close();
}
