import type { Terminal } from "@xterm/headless";

const closeLink = "\x1b]8;;\x1b\\";

export function explicitUnderline(cell: any): number {
  return cell.hasExtendedAttrs() && (cell.extended._ext & 469762048)
    ? 1 : cell.fg & 268435456;
}

export function terminalLinkedChars(terminal: Terminal, cell: any): string {
  const chars = cell.getChars();
  const id = cell.hasExtendedAttrs() ? cell.extended.urlId : 0;
  const link = (terminal as any)._core._oscLinkService.getLinkData(id);
  if (!chars || !link || /[\x00-\x1f\x7f-\x9f]/.test(link.uri + (link.id ?? ""))) return chars;
  return `\x1b]8;id=${link.id ?? `harbor-replay-${id}`};${link.uri}\x1b\\${chars}${closeLink}`;
}

/** Compatibility adapter for pinned xterm 6 / serialize 0.14, which omits OSC 8.
 * Only serializer-owned reusable cells are decorated; live buffer cells and
 * the shared cell prototype are never changed. Empty/wide placeholder cells
 * retain their original meaning to the serializer's wrap/erase logic.
 */
export function serializeTerminalLinks(terminal: Terminal, serialize: () => string): string {
  const core = (terminal as any)._core;
  const openLink = (id: number): string => {
    const link = core._oscLinkService.getLinkData(id);
    if (!link) return "";
    // These values came through the OSC parser; reject control characters
    // defensively before interpolating them into a new control sequence.
    if (/[\x00-\x1f\x7f-\x9f]/.test(link.uri + (link.id ?? ""))) return "";
    return `\x1b]8;${`id=${link.id ?? `harbor-replay-${id}`}`};${link.uri}\x1b\\`;
  };
  const restore: (() => void)[] = [];
  try {
    for (const buffer of [terminal.buffer.normal, terminal.buffer.alternate]) {
      const original = buffer.getNullCell;
      const descriptor = Object.getOwnPropertyDescriptor(buffer, "getNullCell");
      Object.defineProperty(buffer, "getNullCell", {
        configurable: true,
        value() {
          const cell = original.call(buffer);
          // xterm reports OSC8's implicit dashed underline as an SGR
          // underline. OSC8 itself restores it; emitting SGR 4 here can leak
          // underline into subsequent unlinked text (addon default detection).
          cell.isUnderline = function () {
            return explicitUnderline(this);
          };
          const getChars = cell.getChars;
          cell.getChars = function () {
            const chars = getChars.call(this);
            if (!chars || !this.getWidth()) return chars;
            const opening = openLink((this as any).hasExtendedAttrs() ? (this as any).extended.urlId : 0);
            return opening ? opening + chars + closeLink : chars;
          };
          return cell;
        },
      });
      restore.push(() => {
        if (descriptor) Object.defineProperty(buffer, "getNullCell", descriptor);
        else delete (buffer as any).getNullCell;
      });
    }
    return serialize();
  } finally {
    for (const undo of restore.reverse()) undo();
  }
}

/** Keep a link that was still open at the snapshot boundary open for output. */
export function terminalLinkSuffix(terminal: Terminal): string {
  const core = (terminal as any)._core;
  const id = core._inputHandler._curAttrData.extended.urlId;
  const link = core._oscLinkService.getLinkData(id);
  if (!link || /[\x00-\x1f\x7f-\x9f]/.test(link.uri + (link.id ?? ""))) return closeLink;
  return `\x1b]8;${`id=${link.id ?? `harbor-replay-${id}`}`};${link.uri}\x1b\\`;
}


