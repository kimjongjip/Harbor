function backendVersionError(health, expectedVersion) {
  if (!health?.ok || health.name !== "codex-harbor") return null;
  if (health.version === expectedVersion) return null;
  const runningVersion =
    typeof health.version === "string" && /^\d+\.\d+\.\d+$/.test(health.version)
      ? health.version
      : "알 수 없음";
  return new Error(
    `실행 중인 Harbor는 ${runningVersion}, 설치된 버전은 ${expectedVersion}입니다.\n\n` +
      "작업을 저장한 뒤 기존 Harbor에서 Ctrl+Q로 완전히 종료하고 다시 실행하세요. " +
      "새로고침이나 일부 창만 닫는 것으로는 실행 버전이 바뀌지 않습니다. " +
      "실행 중인 터미널은 자동으로 종료하지 않았습니다.",
  );
}

module.exports = { backendVersionError };
