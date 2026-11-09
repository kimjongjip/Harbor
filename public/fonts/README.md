# Bundled Harbor fonts

These unmodified upstream font files ship inside Harbor. No font CDN, system installation, account or network request is needed at runtime. CSS uses app-specific family aliases without modifying font metadata. Upstream license texts and copyright notices accompany the files.

## D2Coding 1.4.0, standard build

- Author: NAVER Corporation. License: SIL Open Font License 1.1; reserved names D2Coding and D2Coding-Bold. See [OFL.txt](d2coding/OFL.txt) and [AUTHORS.txt](d2coding/AUTHORS.txt).
- Official project: <https://github.com/naver/d2-coding-font> and <https://naver.github.io/d2-coding-font/>.
- Immutable source: tag `VER1.4.0`, commit `b0dc372e28d7abdba7f3cba854855ceffbd490a8`.
- [D2Coding-Regular.ttf](https://github.com/naver/d2-coding-font/blob/b0dc372e28d7abdba7f3cba854855ceffbd490a8/fonts/ttf/D2Coding-Regular.ttf), SHA-256 `d5f2b6bf5b1826cfbf3734c70582f0cd42ea2e1d6c2636ae681b612bc9c5682f`.
- [D2Coding-Bold.ttf](https://github.com/naver/d2-coding-font/blob/b0dc372e28d7abdba7f3cba854855ceffbd490a8/fonts/ttf/D2Coding-Bold.ttf), SHA-256 `14a0cfa4d96fbd976bc4b1a6ef81e51df353a1689d5273ebcd908c857a4f2752`.

The regular and bold standard builds avoid programming ligature substitutions in the terminal grid. Their Latin monospaced advances and Hangul double-width advances are tested.

## Pretendard 1.3.9, Korean variable webfont

- Author: Kil Hyung-jin and the upstream contributors. License: SIL Open Font License 1.1. See [LICENSE](pretendard/LICENSE), including upstream copyright notices.
- Official project: <https://github.com/orioncactus/pretendard>.
- Immutable source: tag `v1.3.9`, commit `5c41199ea0024a9e0b2cb31735265056e5472d76`.
- [PretendardVariable.woff2](https://github.com/orioncactus/pretendard/blob/5c41199ea0024a9e0b2cb31735265056e5472d76/packages/pretendard/dist/web/variable/woff2/PretendardVariable.woff2), SHA-256 `9599f12fd42fc0bce1cd50b47a0c022e108d7aa64dd0d1bb0ed44f3282d900b4`.

This is the full Korean variable webfont (weights 100–900), not a CDN subset requiring additional network downloads. KaTeX retains its own bundled math fonts for mathematical glyphs and layout.
