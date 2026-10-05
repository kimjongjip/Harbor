import { Globe2, GripVertical, HardDrive, Plus } from "lucide-react";
import type { HostView } from "../shared/types";
import { useHostReorderDrag, type MoveHost } from "./server-order";
import "./server-order.css";

export default function ServerTreeHost({
  host,
  selected,
  opening,
  onSelect,
  onConnect,
  onMove,
  onMoveBy,
}: {
  host: HostView;
  selected: boolean;
  opening: boolean;
  onSelect: () => void;
  onConnect: () => void;
  onMove: MoveHost;
  onMoveBy: (id: string, direction: -1 | 1) => void;
}) {
  const drag = useHostReorderDrag(onMove);
  return (
    <div
      className={`harbor-host-row host-reorder-row ${selected ? "selected" : ""} ${drag.draggingId === host.id ? "is-dragging" : ""}`}
      data-host-id={host.id}
      data-drop-position={drag.dropPosition(host.id)}
      {...drag.dragProps(host.id)}
    >
      <button onClick={onSelect} onDoubleClick={onConnect}>
        {host.kind === "local" ? <HardDrive size={16} /> : <Globe2 size={16} />}
        <span>{host.name}</span>
        {host.terminalConnected && <i className="harbor-online" />}
      </button>
      <button
        className="host-reorder-grip"
        draggable
        aria-label={`${host.name} 순서 이동`}
        title="드래그로 순서 이동 · Alt+↑/↓"
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.altKey && ["ArrowUp", "ArrowDown"].includes(event.key)) {
            event.preventDefault();
            event.stopPropagation();
            onMoveBy(host.id, event.key === "ArrowUp" ? -1 : 1);
          }
        }}
      >
        <GripVertical size={14} />
      </button>
      <button
        aria-label={`${host.name} 연결`}
        title="새 터미널 연결"
        onClick={onConnect}
        disabled={opening}
      >
        <Plus size={14} />
      </button>
    </div>
  );
}
