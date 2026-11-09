import {
  UPLOAD_ENTRY_LIMIT,
  uploadParts,
  validateUploadManifest,
  type UploadManifest,
} from "../shared/upload-tree";
export interface UploadSelection {
  files: { file: File; relativePath: string }[];
  directories: string[];
}
export function uploadManifest(selection: UploadSelection): UploadManifest {
  return {
    directories: selection.directories,
    files: selection.files.map(({ file, relativePath }) => ({
      relativePath,
      size: file.size,
    })),
  };
}
export function selectionFromFiles(files: Iterable<File>): UploadSelection {
  const directories = new Set<string>();
  const items = [...files].map((file) => {
    const relativePath = file.webkitRelativePath || file.name;
    const parts = uploadParts(relativePath);
    for (let i = 1; i < parts.length; i++)
      directories.add(parts.slice(0, i).join("/"));
    return { file, relativePath };
  });
  const result = { files: items, directories: [...directories] };
  if (items.length) validateUploadManifest(uploadManifest(result));
  return result;
}

/** Capture entries during drop; DataTransfer becomes protected after that event. */
export function readDroppedSelection(
  transfer: DataTransfer,
): Promise<UploadSelection> {
  const files = [...transfer.files];
  const entries = [...transfer.items]
    .filter((item) => item.kind === "file")
    .map((item) => ({
      entry: item.webkitGetAsEntry?.(),
      file: item.getAsFile(),
    }));
  if (!entries.length) return Promise.resolve(selectionFromFiles(files));
  return (async () => {
    const result: UploadSelection = { files: [], directories: [] };
    const visit = async (entry: FileSystemEntry, parent = "") => {
      const relativePath = parent ? `${parent}/${entry.name}` : entry.name;
      uploadParts(relativePath);
      if (result.files.length + result.directories.length >= UPLOAD_ENTRY_LIMIT)
        throw new Error("폴더와 파일은 한 번에 10,000개까지 올릴 수 있습니다.");
      if (entry.isFile) {
        const file = await new Promise<File>((resolve, reject) =>
          (entry as FileSystemFileEntry).file(resolve, reject),
        );
        result.files.push({ file, relativePath });
      } else if (entry.isDirectory) {
        result.directories.push(relativePath);
        const reader = (entry as FileSystemDirectoryEntry).createReader();
        // Chromium returns directory entries in batches, often 100 at a time.
        for (;;) {
          const batch = await new Promise<FileSystemEntry[]>(
            (resolve, reject) => reader.readEntries(resolve, reject),
          );
          if (!batch.length) break;
          for (const child of batch) await visit(child, relativePath);
        }
      } else throw new Error("일반 폴더와 파일만 업로드할 수 있습니다.");
    };
    for (const item of entries) {
      if (item.entry) await visit(item.entry);
      else if (item.file)
        result.files.push({ file: item.file, relativePath: item.file.name });
      else
        throw new Error("드래그한 파일을 읽지 못했습니다. 다시 선택해 주세요.");
    }
    validateUploadManifest(uploadManifest(result));
    return result;
  })();
}
