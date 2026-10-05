/** Copy the decoded image, not its URL or the preview's scaled dimensions. */
export async function copyPreviewImage(image: HTMLImageElement): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined")
    throw new Error(
      "이 브라우저에서는 이미지 복사를 지원하지 않습니다. 다운로드를 사용해 주세요.",
    );
  if (!image.complete || !image.naturalWidth || !image.naturalHeight)
    throw new Error("이미지를 불러온 다음 다시 복사해 주세요.");
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context)
    throw new Error("이미지를 복사할 수 없습니다. 다시 시도해 주세요.");
  context.drawImage(image, 0, 0);
  // Start the clipboard operation inside the click/shortcut's user gesture.
  // PNG also makes JPEG/WebP previews usable by applications accepting images.
  const png = new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else
        reject(
          new Error("이미지를 변환할 수 없습니다. 다운로드를 사용해 주세요."),
        );
    }, "image/png");
  });
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
  } finally {
    canvas.width = canvas.height = 0;
  }
}
