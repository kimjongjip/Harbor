import { chromium } from "playwright";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const svg = readFileSync("public/harbor.svg", "utf8");
  const images = [];
  for (const size of [16, 32, 48, 256]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}svg{width:100vw;height:100vh;display:block}</style>${svg}`,
    );
    images.push({
      size,
      data: await page.screenshot({ omitBackground: true }),
    });
  }
  mkdirSync("desktop", { recursive: true });
  writeFileSync("desktop/icon.png", images.at(-1).data);
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, i) => {
    const pos = 6 + i * 16;
    header[pos] = header[pos + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, pos + 4);
    header.writeUInt16LE(32, pos + 6);
    header.writeUInt32LE(data.length, pos + 8);
    header.writeUInt32LE(offset, pos + 12);
    offset += data.length;
  });
  writeFileSync(
    "desktop/icon.ico",
    Buffer.concat([header, ...images.map((i) => i.data)]),
  );
} finally {
  await browser.close();
}
