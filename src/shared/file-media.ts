/** Formats rendered by the document/image viewer rather than the text editor. */
export function fileMediaKind(filename: string): "image" | "pdf" | undefined {
  if (/\.pdf$/i.test(filename)) return "pdf";
  if (/\.(?:png|jpe?g|gif|webp|bmp|avif|svg|ico)$/i.test(filename))
    return "image";
}
