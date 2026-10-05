import { WebLinksAddon } from "@xterm/addon-web-links";
import type { Terminal, ILink } from "@xterm/xterm";
import { classifyLink, plainFilePattern } from "../shared/links";

export function installTerminalLinks(
  term: Terminal,
  open: (href: string) => void,
  hover: (text: string) => void,
) {
  const activate = (event: MouseEvent, href: string) => {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      if (classifyLink(href).kind !== "blocked") open(href);
    }
  };
  const show = (_event: MouseEvent, href: string) =>
    hover(`Ctrl+클릭으로 열기 · ${href}`);
  const leave = () => hover("");
  const web = new WebLinksAddon(activate, { hover: show, leave });
  term.loadAddon(web);
  term.options.linkHandler = {
    activate,
    hover: show,
    leave,
    allowNonHttpProtocols: true,
  };
  const provider = term.registerLinkProvider({
    provideLinks(y, callback) {
      const buffer = term.buffer.active;
      const line = buffer.getLine(y - 1);
      if (!line) {
        callback(undefined);
        return;
      }
      // Map UTF-16 offsets to terminal cells so Korean and wide characters do not shift clickable paths.
      const positions: { x: number; y: number }[] = [];
      let text = "";
      let start = y - 1,
        end = y - 1;
      while (start > 0 && y - start < 50 && buffer.getLine(start)?.isWrapped)
        start--;
      while (
        end + 1 < buffer.length &&
        end - start < 50 &&
        buffer.getLine(end + 1)?.isWrapped
      )
        end++;
      for (let row = start; row <= end; row++) {
        const content = buffer.getLine(row)!;
        for (let col = 0; col < term.cols; col++) {
          const cell = content.getCell(col);
          if (!cell || cell.getWidth() === 0) continue;
          const chars = cell.getChars() || " ";
          for (let n = 0; n < chars.length; n++)
            positions.push({ x: col + 1, y: row + 1 });
          text += chars;
        }
      }
      const links: ILink[] = [];
      const regex = new RegExp(plainFilePattern.source, plainFilePattern.flags);
      for (const match of text.matchAll(regex)) {
        const before = text.slice(Math.max(0, match.index! - 8), match.index);
        if (/https?:\/?\/?$/i.test(before)) continue;
        const value = match[0].replace(/[),;\]}]+$/, "");
        const target = classifyLink(value);
        if (target.kind !== "file") continue;
        const first = positions[match.index!],
          last = positions[match.index! + value.length - 1];
        if (!first || !last || y < first.y || y > last.y) continue;
        links.push({
          range: { start: first, end: last },
          text: value,
          activate,
          hover: show,
          leave,
        });
      }
      callback(links);
    },
  });
  return () => {
    provider.dispose();
    web.dispose();
  };
}
