/** File permissions, validation and collisions are not SSH authentication failures. */
export function needsFileAuthentication(error: unknown) {
  const value = error as { code?: string; message?: string };
  return (
    value?.code === "SSH_AUTH_REQUIRED" ||
    /All configured authentication methods failed|SFTP 인증에 사용할 SSH 키가 없습니다|SSH 인증에 실패|Authentication failed/i.test(
      value?.message || "",
    )
  );
}
