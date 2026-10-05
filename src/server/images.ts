export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 12 * 1024 * 1024;
export function validateImages(images: string[] = []): string[] {
  if (images.length > 4)
    throw new Error("한 번에 이미지를 최대 4개까지 첨부할 수 있습니다.");
  let total = 0;
  for (const image of images) {
    const match =
      /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(
        image,
      );
    if (!match)
      throw new Error("PNG, JPEG, WebP, GIF 이미지 파일만 첨부할 수 있습니다.");
    const bytes = Buffer.from(match[2], "base64");
    total += bytes.length;
    if (bytes.length > MAX_IMAGE_BYTES || total > MAX_TOTAL_IMAGE_BYTES)
      throw new Error("이미지는 개당 5MB, 합계 12MB까지 첨부할 수 있습니다.");
    const valid =
      match[1] === "png"
        ? bytes
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : match[1] === "jpeg"
          ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
          : match[1] === "gif"
            ? /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())
            : bytes.subarray(0, 4).toString() === "RIFF" &&
              bytes.subarray(8, 12).toString() === "WEBP";
    if (!valid) throw new Error("올바른 이미지 파일인지 확인해 주세요.");
  }
  return images;
}
