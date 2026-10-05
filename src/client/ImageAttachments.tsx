import { ImagePlus, X } from "lucide-react";
export interface AttachedImage {
  id: string;
  name: string;
  url: string;
  size: number;
}
export async function readImages(
  files: File[],
  existing: AttachedImage[],
): Promise<AttachedImage[]> {
  const accepted = files.filter((f) =>
    ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(f.type),
  );
  if (accepted.length !== files.length)
    throw new Error(
      "PNG, JPEG, WebP, GIF 이미지를 첨부해 주세요. 일반 파일은 파일 탐색에서 서버에 올릴 수 있어요.",
    );
  if (existing.length + accepted.length > 4)
    throw new Error("이미지는 한 번에 4개까지 첨부할 수 있습니다.");
  if (
    accepted.some((f) => f.size > 5 * 1024 * 1024) ||
    [...existing, ...accepted].reduce((sum, f) => sum + f.size, 0) >
      12 * 1024 * 1024
  )
    throw new Error("이미지는 개당 5MB, 합계 12MB까지 첨부할 수 있습니다.");
  return Promise.all(
    accepted.map(
      (file) =>
        new Promise<AttachedImage>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () =>
            resolve({
              id: crypto.randomUUID(),
              name: file.name || "붙여넣은 캡처.png",
              url: reader.result as string,
              size: file.size,
            });
          reader.onerror = () =>
            reject(new Error("이미지를 읽을 수 없습니다."));
          reader.readAsDataURL(file);
        }),
    ),
  );
}
export function ImageAttachments({
  images,
  disabled,
  onRemove,
}: {
  images: AttachedImage[];
  disabled: boolean;
  onRemove: (id: string) => void;
}) {
  return (
    <div className="image-attachments">
      {images.map((image) => (
        <div className="image-attachment" key={image.id}>
          <img src={image.url} alt={`첨부: ${image.name}`} />
          <span title={image.name}>{image.name}</span>
          <button
            type="button"
            disabled={disabled}
            aria-label={`첨부 삭제: ${image.name}`}
            title="첨부 삭제"
            onClick={() => onRemove(image.id)}
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
