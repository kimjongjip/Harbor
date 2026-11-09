export const UPLOAD_ENTRY_LIMIT = 10_000;
export const UPLOAD_FILE_LIMIT = 512 * 1024 * 1024;
export interface UploadManifest {
  directories: string[];
  files: { relativePath: string; size: number }[];
}
export interface UploadDestination {
  relativePath: string;
  directory: string;
  name: string;
}
export function uploadParts(value: string): string[] {
  const parts = value.split("/");
  if (
    !value ||
    value.length > 4096 ||
    parts.length > 128 ||
    parts.some(
      (p) =>
        !p ||
        p === "." ||
        p === ".." ||
        p.length > 255 ||
        /[\x00-\x1f\\]/.test(p),
    )
  )
    throw new Error("업로드할 폴더·파일의 상대경로를 확인하세요.");
  return parts;
}
export function validateUploadManifest(manifest: UploadManifest) {
  const count = manifest.files.length + manifest.directories.length;
  if (!count || count > UPLOAD_ENTRY_LIMIT)
    throw new Error(
      `폴더와 파일은 한 번에 ${UPLOAD_ENTRY_LIMIT.toLocaleString()}개까지 올릴 수 있습니다.`,
    );
  const dirs = new Set<string>(),
    names = new Set<string>();
  for (const directory of manifest.directories) {
    uploadParts(directory);
    if (names.has(directory))
      throw new Error("같은 업로드 경로가 중복되었습니다.");
    dirs.add(directory);
    names.add(directory);
  }
  for (const file of manifest.files) {
    uploadParts(file.relativePath);
    if (
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > UPLOAD_FILE_LIMIT
    )
      throw new Error("파일은 개당 512MB까지 업로드할 수 있습니다.");
    if (names.has(file.relativePath))
      throw new Error("같은 업로드 경로가 중복되었습니다.");
    names.add(file.relativePath);
  }
  for (const name of names) {
    const parent = name.slice(0, name.lastIndexOf("/"));
    if (name.includes("/") && !dirs.has(parent))
      throw new Error("업로드 목록에 상위 폴더가 없습니다.");
  }
  if (
    new TextEncoder().encode(JSON.stringify(manifest)).byteLength >
    1024 * 1024
  )
    throw new Error("업로드 목록이 너무 큽니다. 하위 폴더로 나눠 올려주세요.");
}
