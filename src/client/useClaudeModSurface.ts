import { useLayoutEffect, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import {
  claudeModSurface,
  type ClaudeModSurface,
} from "./terminal-mod-surface";

interface Surface {
  native: ClaudeModSurface;
  width: number;
  height: number;
}

/** Geometry changes resize the reader overlay, never the CLI or its PTY. */
export function useClaudeModSurface(term: Terminal, enabled: boolean) {
  const [surface, setSurface] = useState<Surface>();
  useLayoutEffect(() => {
    if (!enabled) {
      setSurface(undefined);
      return;
    }
    const screen = term.element?.querySelector<HTMLElement>(".xterm-screen");
    const mount = term.element?.parentElement;
    if (!screen || !mount) return;
    let disposed = false,
      scheduled = false,
      pendingSync = false,
      previousKey = "";
    let geometry = { left: 0, top: 0, width: 0, height: 0 };
    const update = () => {
      scheduled = false;
      if (disposed) return;
      if (term.modes.synchronizedOutputMode) {
        pendingSync = true;
        return;
      }
      pendingSync = false;
      const native = claudeModSurface(term);
      const next =
        native && geometry.width && geometry.height
          ? {
              native,
              width: Math.max(
                0,
                geometry.left + (geometry.width * native.columns) / term.cols,
              ),
              height: Math.max(
                0,
                geometry.top +
                  (geometry.height * (native.end - native.baseY)) / term.rows,
              ),
            }
          : undefined;
      const key = JSON.stringify(next);
      if (key === previousKey) return;
      previousKey = key;
      setSurface(next);
    };
    const schedule = () => {
      if (disposed || scheduled) return;
      scheduled = true;
      queueMicrotask(update);
    };
    const measure = () => {
      const s = screen.getBoundingClientRect(),
        m = mount.getBoundingClientRect();
      geometry = {
        left: s.left - m.left,
        top: s.top - m.top,
        width: s.width,
        height: s.height,
      };
      schedule();
    };
    const observer = new ResizeObserver(measure);
    observer.observe(screen);
    observer.observe(mount);
    const parsed = term.onWriteParsed(schedule);
    // xterm's sync timeout can commit a frame without another parsed write.
    const rendered = term.onRender(() => {
      if (pendingSync && !term.modes.synchronizedOutputMode) schedule();
    });
    const resized = term.onResize(measure);
    measure();
    return () => {
      disposed = true;
      observer.disconnect();
      parsed.dispose();
      rendered.dispose();
      resized.dispose();
    };
  }, [term, enabled]);
  return enabled ? surface : undefined;
}
