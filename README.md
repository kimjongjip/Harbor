# Harbor 1.2

- [사용자 설치·업데이트 안내](docs/user-guide.md)
- [개발자 Git 게시·배포 절차](docs/maintainer-guide.md)
- [변경 이력](CHANGELOG.md)
- [에이전트 작업 시작 안내](AGENTS.md)

Windows에서 로컬·SSH 터미널과 Codex·Claude Code 세션을 관리하는 데스크톱 앱입니다. 터미널에서 평소처럼 CLI를 실행하며, 별도의 AI 채팅 화면으로 전환하지 않습니다.

## Windows 빠른 시작

Windows 10/11 **x64**, Windows PowerShell 5.1, 인터넷 연결, Git이 필요합니다. Git이 없으면 저장소의 **Code → Download ZIP**으로 내려받아 압축을 풀어도 됩니다.

```powershell
git clone https://github.com/kimjongjip/Harbor.git
cd Harbor
.\Setup-Harbor.cmd
```

설치 스크립트가 공식 Node.js 배포처에서 Node.js 24.15.0을 내려받아 고정된 SHA-256을 확인하고, `npm ci`로 Electron과 잠긴 버전의 의존성을 설치한 뒤 빌드·실행합니다. 관리자 권한이나 시스템 PATH 변경 없이 프로젝트의 `.runtime`과 `node_modules`에 저장합니다. 첫 실행에는 다운로드와 빌드 시간이 필요합니다.

이후 실행:

```powershell
.\Start-Harbor.cmd
```

설치·빌드만 하고 창을 열지 않으려면 `.\Setup-Harbor.cmd -NoLaunch`를 사용합니다. Node.js·Electron·Harbor 라이브러리는 자동 준비하지만 **Codex·Claude Code와 SSH 서버는 자동 설치하거나 로그인하지 않습니다.** 작업할 컴퓨터/서버에서 원하는 CLI를 설치하고 본인 계정으로 로그인하세요.

## 업데이트

작업을 저장하고 Harbor를 완전히 종료한 다음:

```powershell
.\Update-Harbor.cmd
```

처음 한 번만 클론하면 됩니다. 업데이트 스크립트는 `git pull --ff-only` → 의존성 설치 → 빌드 → 실행을 수행합니다. 직접 수정한 소스나 이 폴더에서 실행 중인 앱이 있으면 중단하며 강제 덮어쓰기·세션 종료를 하지 않습니다. 빌드가 실패하면 오류를 해결한 뒤 `Setup-Harbor.cmd`를 다시 실행하세요. ZIP 다운로드본은 Git 업데이트를 지원하지 않으므로 새 ZIP을 별도 폴더에 받아야 합니다.

소스 실행의 로컬 설정은 `.data`에 보관되며 설치·업데이트 스크립트가 삭제하지 않습니다. 새 사용자에게는 자신의 로컬 컴퓨터만 등록되며 SSH 서버를 직접 추가합니다. 다른 사람이 사용하던 `.data`나 전체 작업 폴더를 복사하지 마세요.

## 주요 기능

- 로컬 및 저장된 SSH 서버 터미널, 탭, 분할 배치와 크기 조절, 별도 창.
- 기본 시작 화면은 터미널. 새로고침 후 선택한 터미널을 복원하며, 세션이 없으면 홈 폴더에서 로컬 셸을 엽니다.
- Codex와 Claude 대화 기록을 별도 영역에서 검색·미리보기·이어가기. 기록을 터미널 칸으로 드래그해 배치.
- 파일 탐색, 다운로드·업로드, 하위 폴더에 파일 드롭, 터미널로 파일 드롭·이미지 붙여넣기.
- 파일 링크를 독립 창으로 열기. Markdown 표·수식·Mermaid, CSV 표, 이미지·PDF 미리보기.
- 터미널 선택문 복사·인용. 선택한 상태의 Ctrl+C는 복사, 선택하지 않은 상태는 실행 중단.
- Claude 작업 상태·알림·실행 승인 받은함. 일반 질문은 원래 터미널에서 답변.
- Codex·Claude 사이의 세션 이름 기반 질문·답장. 왼쪽 받은함에서 대기·CLI 알림 전달·AI 확인·답장을 구분.

Claude 상태 연동은 Windows PowerShell과 관리형 SSH Bash에서 지원합니다. 전역 설정을 수정하지 않고 해당 실행에만 hooks와 세션 전용 MCP 연결을 추가합니다. 관리 정책이 hooks를 제한하거나 일반 SSH 대체 연결을 사용하면 CLI 자체의 승인·상태 표시를 사용하세요. Claude 첨부는 업로드한 파일 경로 입력 방식이며 자동 Enter를 보내지 않습니다.

## 세션끼리 질문하기

터미널의 이름 변경 버튼으로 `구현`, `리뷰`처럼 구별되는 이름을 정하고, CLI에서 “리뷰 세션에 왜 이렇게 구현했는지 물어보고 답을 반영해줘”라고 요청합니다. 모델이 Harbor 도구를 호출하면 요청이 실제로 기록되고, 상대의 원래 대화에서 보낸 답장이 돌아옵니다. 도구 호출 없이 모델이 말로만 요청했다고 하는 것은 전달 기록으로 처리하지 않습니다.

Codex CLI 0.160.1 이상에서는 해당 터미널용 app-server에 네이티브 TUI와 Harbor가 함께 연결됩니다. 요청은 네이티브 대기열에 들어가며 작성 중인 입력을 전송하거나 수정하지 않습니다. 이 WebSocket·대기열 연결은 실험적 CLI 기능입니다. 지원하지 않는 버전이나 연결 실패에서는 받은함 방식으로 표시하며, 상대에게 “받은 메시지 확인해줘”라고 요청합니다. 관리형 SSH에서 자동 연결을 사용하려면 원격의 `python3`와 SSH TCP forwarding이 필요합니다.

Claude는 일반 `claude` 실행으로 질문·답장 도구를 사용할 수 있습니다. 대기 중인 Claude에 자동 알림도 보내려면 Harbor 터미널에서 `claude --harbor-peers`로 실행합니다. 이 옵션은 해당 실행에만 Claude 개발 채널을 요청하며, Claude 자체의 채널 승인·계정·조직 정책을 따릅니다. 왼쪽의 **채널 수신 요청**은 활성화가 보장됐다는 뜻이 아닙니다. 지원하지 않으면 받은함을 직접 확인합니다. [Codex app-server](https://learn.chatgpt.com/docs/app-server), [Claude 채널](https://code.claude.com/docs/en/channels-reference).

## 데이터와 연결

Harbor 백엔드는 기본적으로 이 PC의 `127.0.0.1:4317`에서 실행됩니다. 인터넷 공개 서버나 여러 사용자가 함께 접속하는 서비스로 배포하도록 설계된 버전은 아닙니다. SSH 서버에는 사용자가 등록한 인증으로 연결합니다. Codex·Claude에 보내는 내용과 인증은 각 CLI 설정을 따릅니다.

사용자 서버 정보·암호화된 저장 자격 증명·로컬 작업 데이터는 Git에 포함하지 않습니다. 대화 기록은 해당 컴퓨터/서버의 CLI 저장소에서 읽습니다. 로그·스크린샷·내보낸 파일에는 개인 정보가 포함될 수 있으므로 이슈에 첨부하기 전에 확인하세요.

마지막 데스크톱 창을 닫으면 앱이 시작한 백엔드와 터미널도 종료됩니다. 새로고침은 실행 중인 터미널을 유지합니다. 다른 PC·휴대폰에서 같은 실행 세션에 접속하는 기능은 아직 제공하지 않습니다.

## 개발 및 패키징

이미 Node.js 24와 npm이 있다면 다음 명령도 사용할 수 있습니다.

```powershell
npm ci
npm run build
npm run desktop
```

```powershell
npm test
npm run audit:publication
npm run build:desktop
```

`build:desktop`은 Windows에서 Electron·별도 Node.js 런타임을 포함한 `release/Harbor-win32-x64` 폴더를 만듭니다. **Harbor.exe 하나가 아니라 해당 폴더 전체**를 ZIP으로 전달해야 합니다. 현재 자동 설치형 EXE·코드 서명·자동 업데이트는 제공하지 않습니다.

`.gitignore`는 공개할 파일을 명시적으로 허용합니다. `.data`, `.cache`, `.runtime`, `artifacts`, `dist`, `release`, 로컬 개발용 검증 스크립트는 제외합니다. 새 루트 파일·스크립트를 추가할 때 공개 대상인지 검토하고 허용 목록을 갱신하세요. 비밀값을 `git add -f`로 추가하지 마세요.
