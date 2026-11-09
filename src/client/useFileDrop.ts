import { useEffect, useRef, useState, type DragEvent } from "react";
import { readDroppedSelection, type UploadSelection } from "./upload-selection";

/** Explicit row targets avoid a drop bubbling into the explorer's root upload. */
export function useFileDrop({
  rootPath,
  scopeKey,
  busy,
  onFiles,
  onError,
}: {
  rootPath?: string;
  scopeKey?: string;
  busy: boolean;
  onFiles: (selection: UploadSelection, path: string) => void | Promise<void>;
  onError: (message: string) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const [targetPath, setTargetPath] = useState<string>();
  const [collecting, setCollecting] = useState(false);
  const reading = useRef(false);
  const generation = useRef(0);
  const hover = useRef<{
    path?: string;
    timer?: ReturnType<typeof setTimeout>;
  }>({});
  function cancelHover() {
    clearTimeout(hover.current.timer);
    hover.current = {};
  }
  function clear() {
    cancelHover();
    setDragging(false);
    setTargetPath(undefined);
  }
  useEffect(() => {
    generation.current++;
    setCollecting(false);
    clear();
    return () => {
      generation.current++;
      cancelHover();
    };
  }, [rootPath, scopeKey]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") clear();
    };
    window.addEventListener("dragend", clear);
    window.addEventListener("keydown", key);
    return () => {
      cancelHover();
      window.removeEventListener("dragend", clear);
      window.removeEventListener("keydown", key);
    };
  }, []);
  function over(
    event: DragEvent<HTMLElement>,
    path?: string,
    expand?: () => void,
  ) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect =
      !busy && !reading.current && path ? "copy" : "none";
    setDragging(true);
    setTargetPath(path);
    if (hover.current.path !== path) {
      cancelHover();
      hover.current.path = path;
      if (path && !busy && expand)
        hover.current.timer = setTimeout(expand, 700);
    }
  }
  function drop(event: DragEvent<HTMLElement>, path?: string) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.stopPropagation();
    clear();
    if (busy || reading.current || !path) return;
    const current = generation.current;
    reading.current = true;
    setCollecting(true);
    // Snapshot the native entries synchronously, before awaiting recursion.
    void readDroppedSelection(event.dataTransfer)
      .then(async (selection) => {
        if (generation.current === current) setCollecting(false);
        if (
          generation.current === current &&
          (selection.files.length || selection.directories.length)
        )
          await onFiles(selection, path);
      })
      .catch((error) => {
        if (generation.current === current) onError((error as Error).message);
      })
      .finally(() => {
        reading.current = false;
        if (generation.current === current) setCollecting(false);
      });
  }
  return {
    dragging,
    targetPath,
    collecting,
    containerProps: {
      onDragEnter: (event: DragEvent<HTMLElement>) => over(event, rootPath),
      onDragOver: (event: DragEvent<HTMLElement>) => over(event, rootPath),
      onDragLeave: (event: DragEvent<HTMLElement>) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget)
        )
          clear();
      },
      onDrop: (event: DragEvent<HTMLElement>) => drop(event, rootPath),
    },
    rowProps: (path: string, expand?: () => void) => ({
      onDragEnter: (event: DragEvent<HTMLElement>) => over(event, path, expand),
      onDragOver: (event: DragEvent<HTMLElement>) => over(event, path, expand),
      onDragLeave: (event: DragEvent<HTMLElement>) => {
        if (
          hover.current.path === path &&
          (!(event.relatedTarget instanceof Node) ||
            !event.currentTarget.contains(event.relatedTarget))
        )
          cancelHover();
      },
      onDrop: (event: DragEvent<HTMLElement>) => drop(event, path),
    }),
  };
}
