import { shellQuote } from "./ssh.js";

/** Runs in the remote account. Never enables linger or changes system services. */
export const workspaceEnvironment = `set -e
umask 077
root="$HOME/.local/share/harbor-workspace"
export PATH="$HOME/.local/bin:$HOME/.agy/bin:$PATH"
`;

export const workspaceNodeVersion="24.22.3";
// https://nodejs.org/dist/v24.22.3/SHASUMS256.txt
const workspaceNodeSetup = `
node_ready() {
  command -v npm >/dev/null && node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=12)?0:1)' >/dev/null 2>&1
}
if ! node_ready; then
  for dir in "$HOME"/.nvm/versions/node/*/bin "$HOME"/.local/share/fnm/node-versions/*/installation/bin "$HOME"/.volta/tools/image/node/*/bin "$root"/runtime/node-v${workspaceNodeVersion}-linux-*/bin; do
    if [ -x "$dir/node" ] && [ -x "$dir/npm" ] && (export PATH="$dir:$PATH"; node_ready); then export PATH="$dir:$PATH"; break; fi
  done
fi
if ! node_ready; then
  case "$(uname -m)" in
    x86_64) arch=x64; expected=4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb;;
    aarch64|arm64) arch=arm64; expected=6e51a2ada00f0011cc266f65d98922b403d7ad88f809ca2aa615a5fe1ce6e86c;;
    *) echo '이 서버 아키텍처에는 Node.js 22.12 이상과 npm을 준비하세요.' >&2; exit 1;;
  esac
  name="node-v${workspaceNodeVersion}-linux-$arch"
  mkdir -p "$root/runtime"
  runtimeStage=$(mktemp -d "$root/runtime/.install-XXXXXXXX")
  (trap 'rm -rf -- "$runtimeStage"' EXIT
    curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location --retry 2 --max-time 180 \
      "https://nodejs.org/dist/v${workspaceNodeVersion}/$name.tar.xz" -o "$runtimeStage/node.tar.xz"
    printf '%s  %s\\n' "$expected" "$runtimeStage/node.tar.xz" | sha256sum -c - >/dev/null
    tar -xJf "$runtimeStage/node.tar.xz" -C "$runtimeStage"
    test ! -e "$root/runtime/$name"
    mv "$runtimeStage/$name" "$root/runtime/$name"
  )
  export PATH="$root/runtime/$name/bin:$PATH"
  node_ready || { echo 'Harbor 전용 Node 런타임을 실행할 수 없습니다.' >&2; exit 1; }
fi
`;

export const workspaceCheck =
  workspaceEnvironment +
  `
test "$(uname -s)" = Linux || { echo '서버 세션 유지는 Linux를 지원합니다.' >&2; exit 1; }
command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null || { echo '사용자 systemd 서비스가 필요합니다.' >&2; exit 1; }
test "$(loginctl show-user "$(id -un)" --property=Linger --value)" = yes || { echo '로그아웃 후 유지하려면 서버에서 loginctl enable-linger 또는 관리자 설정이 필요합니다.' >&2; exit 1; }
for bin in tar sha256sum flock; do command -v "$bin" >/dev/null || { echo "$bin 설치가 필요합니다." >&2; exit 1; }; done
`;

// Never interpolate a caller-supplied path into an installation script.
export function workspaceInstall(digest: string, version: string) {
  if (!/^[a-f0-9]{64}$/.test(digest) || !/^\d+\.\d+\.\d+$/.test(version))
    throw Error("Invalid workspace release");
  return (
    workspaceCheck +
    `
mkdir -p "$root/releases" "$root/data" "$HOME/.config/systemd/user"
root=$(cd -P "$root" && pwd)
chmod 700 "$root"
exec 9>"$root/install.lock"
flock -w 120 9 || { echo '다른 설치가 진행 중입니다.' >&2; exit 1; }
${workspaceNodeSetup}
unit="$HOME/.config/systemd/user/harbor-workspace.service"
if [ -e "$unit" ] && ! grep -Fxq '# Harbor managed workspace' "$unit"; then
  echo '기존 harbor-workspace.service 설정이 있습니다.' >&2; exit 1
fi
stage=$(mktemp -d "$root/releases/.install-XXXXXXXX")
trap 'rm -f "$stage/archive.tgz"; if [ -d "$stage" ]; then rm -rf "$stage"; fi' EXIT
cat > "$stage/archive.tgz"
echo '${digest}  '"$stage/archive.tgz" | sha256sum -c - >/dev/null
release="$root/releases/${version}-${digest.slice(0, 16)}"
if [ ! -d "$release" ]; then
  tar -xzf "$stage/archive.tgz" -C "$stage"
  rm "$stage/archive.tgz"
  cp "$stage/dist/worker-manifest/"{package.json,package-lock.json} "$stage/"
  nodeDir=$(dirname "$(command -v node)")
  nodeRoot=$(cd "$nodeDir/.." && pwd)
  if [ -f "$nodeRoot/include/node/node.h" ];then export npm_config_nodedir="$nodeRoot"; fi
  for name in node npm codex claude agy; do
    exe=$(type -P "$name" || true)
    case "$exe" in /*) dirname "$exe";; esac
  done | awk '!seen[$0]++' > "$stage/host-path"
  (cd "$stage" && npm ci --omit=dev --no-audit --no-fund >&2) || {
    code=$?
    echo '서버 npm 설치 실패: npm 레지스트리 접속과 node-pty 빌드용 Python, make, C++ 컴파일러, Node 헤더를 확인하세요.' >&2
    exit "$code"
  }
  echo '${digest}' > "$stage/.harbor-release"
  mv "$stage" "$release"
fi
if [ ! -f "$root/data/workspace.key" ]; then
  node -e 'require("fs").writeFileSync(process.argv[1],require("crypto").randomBytes(32).toString("hex"),{flag:"wx",mode:0o600})' "$root/data/workspace.key"
fi
old=$(readlink -f "$root/current" || true)
if [ -n "$old" ] && [ "$old" != "$release" ] && [ -f "$old/.harbor-release" ]; then
  ln -s "$old" "$root/previous.$$"
  mv -Tf "$root/previous.$$" "$root/previous"
fi
ln -s "$release" "$root/current.$$"
mv -Tf "$root/current.$$" "$root/current"
cat > "$root/start.tmp" <<'START'
#!/bin/bash
set -e
umask 077
export PATH="$HOME/.local/bin:$HOME/.agy/bin:$PATH"
root="$HOME/.local/share/harbor-workspace"
export HARBOR_DATA_DIR="$root/data" HARBOR_DEFAULT_CWD="$HOME"
export HARBOR_WORKSPACE_SOCKET="$XDG_RUNTIME_DIR/harbor-workspace/http.sock"
export HARBOR_WORKSPACE_RELEASE_LINK="$root/current"
cd -P "$root/current"
if [ -f host-path ];then
  paths=$(paste -sd: host-path)
  export PATH="$paths:$PATH"
fi
exec node dist/server.mjs
START
chmod 700 "$root/start.tmp"
mv -f "$root/start.tmp" "$root/start"
cat > "$unit.tmp" <<'UNIT'
# Harbor managed workspace
[Unit]
Description=Harbor workspace
[Service]
Type=simple
RuntimeDirectory=harbor-workspace
RuntimeDirectoryMode=0700
UMask=0077
ExecStart=/bin/bash -lc 'exec "$HOME/.local/share/harbor-workspace/start"'
Restart=on-failure
RestartSec=3
[Install]
WantedBy=default.target
UNIT
mv -f "$unit.tmp" "$unit"
systemctl --user daemon-reload
systemctl --user enable --now harbor-workspace.service >&2
for i in {1..45}; do
  if [ -S "$XDG_RUNTIME_DIR/harbor-workspace/http.sock" ] && systemctl --user is-active --quiet harbor-workspace.service; then
    pid=$(systemctl --user show -p MainPID --value harbor-workspace.service)
    running=$(readlink -f "/proc/$pid/cwd" || true)
    previous=$(readlink -f "$root/previous" || true)
    if [ -n "$running" ]; then
      for d in "$root"/releases/*; do
        [ -d "$d" ] && [ ! -L "$d" ] && [ -f "$d/.harbor-release" ] || continue
        [ "$d" = "$running" ] || [ "$d" = "$release" ] || [ "$d" = "$previous" ] || rm -rf -- "$d"
      done
    fi
    exit 0
  fi
  sleep 1
done
echo '서버 실행 실패. journalctl --user -u harbor-workspace.service 로 확인하세요.' >&2
exit 1
`
  );
}

export const workspaceProbe =
  workspaceEnvironment +
  `
if systemctl --user is-active --quiet harbor-workspace.service && test -S "$XDG_RUNTIME_DIR/harbor-workspace/http.sock"; then
  printf '%s\\n' "$XDG_RUNTIME_DIR/harbor-workspace/http.sock"
  cat "$root/data/workspace.key"
  printf '\\n'
  date +%s
  pid=$(systemctl --user show -p MainPID --value harbor-workspace.service)
  if [ "$(readlink -f "/proc/$pid/cwd")" != "$(readlink -f "$root/current")" ]; then printf 'pending\\n'; else printf 'active\\n'; fi
else
  echo '먼저 이 서버에서 세션 유지를 설정하세요.' >&2; exit 1
fi
`;

// Protect protocol stdout from a login profile's banners.
export function workspaceShell(script: string) {
  const encoded = Buffer.from(script).toString("base64");
  const command = `exec /bin/bash -c "$(printf %s ${encoded} | base64 -d)" >&3 3>&-`;
  return `exec 3>&1; exec /bin/bash -lc ${shellQuote(command)} >/dev/null`;
}
