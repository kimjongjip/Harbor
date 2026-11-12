import type { TerminalControlView } from "../shared/mobile";

export interface TerminalControlEvent {
  id: string;
  control: TerminalControlView | null;
}
const eventName = "harbor:terminal-control";

/** Apply ownership before the next resize/output packet reaches the parser. */
export function publishTerminalControl(value: TerminalControlEvent) {
  window.dispatchEvent(new CustomEvent(eventName, { detail: value }));
}

export function watchTerminalControl(
  id: string,
  changed: (control: TerminalControlView | null) => void,
) {
  const receive = (event: Event) => {
    const value = (event as CustomEvent<TerminalControlEvent>).detail;
    if (value.id === id) changed(value.control);
  };
  window.addEventListener(eventName, receive);
  return () => window.removeEventListener(eventName, receive);
}
