import { useEffect, useRef, useState, type DragEvent } from "react";

/** Explicit row targets avoid a drop bubbling into the explorer's root upload. */
export function useFileDrop({
  rootPath,
  busy,
  onFiles,
  onError,
}: {
  rootPath?: string;
  busy: boolean;
  onFiles: (files: File[], path: string) => void;
  onError: (message: string) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const [targetPath, setTargetPath] = useState<string>();
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
    clear();
    return cancelHover;
  }, [rootPath]);
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
    event.dataTransfer.dropEffect = !busy && path ? "copy" : "none";
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
    if (busy || !path) return;
    if (
      [...event.dataTransfer.items].some(
        (item) => item.webkitGetAsEntry?.()?.isDirectory,
      )
    ) {
      onError("폴더는 압축한 뒤 올려주세요.");
      return;
    }
    const files = [...event.dataTransfer.files];
    if (files.length) onFiles(files, path);
  }
  return {
    dragging,
    targetPath,
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
