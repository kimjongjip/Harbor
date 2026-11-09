/** Compatibility with a running pre-pagination backend, not a general error filter. */
export function isLegacyClaudeHistoryLimit(value: unknown): boolean {
  const message = value instanceof Error ? value.message : value;
  return (
    typeof message === "string" &&
    /^이 Claude 기록은 16\s*MB를 초과합니다\. 터미널에서 이어서 확인하세요\.$/.test(
      message.trim(),
    )
  );
}
