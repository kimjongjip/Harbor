import { api, ApiError } from "./api";
import { uploadManifest, type UploadSelection } from "./upload-selection";
import {
  validateUploadManifest,
  type UploadDestination,
} from "../shared/upload-tree";

export async function prepareUploadSelection(
  hostId: string,
  path: string,
  selection: UploadSelection,
  signal?: AbortSignal,
) {
  const manifest = uploadManifest(selection);
  validateUploadManifest(manifest);
  if (!manifest.directories.length)
    return {
      path,
      directoryCount: 0,
      files: selection.files.map((item) => ({
        relativePath: item.relativePath,
        directory: path,
        name: item.file.name,
      })),
    };
  try {
    return await api<{
      path: string;
      directoryCount: number;
      files: UploadDestination[];
    }>(
      `/hosts/${hostId}/files/upload-plan`,
      { path, ...manifest },
      "POST",
      signal,
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 404)
      throw new Error(
        "실행 중인 Harbor 서버가 폴더 업로드를 지원하지 않습니다. 업데이트 후 Harbor를 다시 실행해 주세요.",
      );
    throw error;
  }
}
