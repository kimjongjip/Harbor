# Harbor 개발·Git 게시·배포 절차

## 현재 기준

- 저장소: https://github.com/kimjongjip/Harbor.git
- 배포 기준: main. 사용자의 `Update-Harbor.cmd`는 현재 체크아웃의 upstream을 `git pull --ff-only`로 받는다. 일반 사용자는 기본 main을 유지한다.
- 버전: package.json이 제품 버전이며 1.0.0부터 공개 버전을 관리한다. CHANGELOG에 변경 사항을 기록한다.
- Windows x64 소스 설치가 현재 배포 방식이다. 자동 설치형 EXE, 코드 서명, 자동 업데이트, 모바일 공유 세션은 아직 제공하지 않는다.
- 제품 이름 Harbor는 '항구'라는 뜻이다. 여러 서버·세션이 모이는 작업 공간이라는 설명을 사용한다. 최초 작명 당시의 결정 근거는 확인되지 않았다.

## 개발 환경과 수정

처음에는 사용자 안내의 Setup을 사용하거나 Node.js 24가 있는 개발 환경에서 `npm ci`를 실행한다. Setup이 설치한 Node를 현재 PowerShell에서 쓰려면:

```powershell
$env:PATH = "$(Join-Path $PWD '.runtime\node-v24.15.0-win-x64');$env:PATH"
```

이후 `node`, `npm.cmd`를 사용할 수 있다. Node 버전·해시를 올릴 때는 Setup과 데스크톱 런처의 경로도 함께 변경하고 새 클론에서 검증한다.

1. `git status`와 `git fetch origin`으로 현재 변경 및 원격을 확인한다.
2. `git switch main`, `git pull --ff-only` 후 필요하면 작업 브랜치를 만든다. 기존 사용자 변경을 버리지 않는다.
3. 수정 후 작업 규모에 맞는 테스트와 빌드를 수행한다. 실제 사용자 SSH·대화 기록 대신 합성 fixture를 사용한다.

## 버전 올리기

버그 수정은 1.0.1, 기능 추가는 1.1.0, 큰 비호환 변경은 2.0.0처럼 관리한다.

```powershell
node scripts/set-version.mjs 1.0.1
```

이 명령은 package.json, package-lock.json의 제품 버전, 서버 health 응답, 데스크톱 preload 버전을 함께 갱신한다. CHANGELOG.md는 변경 내용을 직접 작성한다. 의존성의 같은 숫자까지 치환하면 안 된다. 패키징은 package.json 버전을 사용한다.

## CLI 번호 인용 구현과 검증

1.0.5부터 선택문은 `TerminalAnnotations`의 메모리 저장소에 보관한다. 1.0.6부터는 각 참조의 사용자 질문·코멘트도 같은 번호 안에 연결한다. 브라우저가 서버에 선택문을 등록하고 `/annotations/attach`로 각 번호의 `annotation`을 연결한 뒤 번호만 CLI에 붙여 넣는다. `buildAnnotationPrompt`에 본문·코멘트·출처·추가 안내문을 다시 넣으면 안 된다. 사용자가 CLI에서 따로 작성한 일반 질문은 CLI 입력 자체로 유지한다.

Codex의 세션 전용 `SessionStart`·`UserPromptSubmit` 훅은 해당 터미널의 환경 변수 인증으로 `/bridge/annotation`을 호출한다. 제출한 번호에 연결된 `reference`·`text`·`annotation`·`source` JSON을 `additionalContext`에 반환한다. `text`는 인용 원문이고 `annotation`은 사용자가 그 부분에 작성한 질문·코멘트다. 여러 번호의 코멘트를 하나로 합치거나 입력칸으로 풀어 넣지 않는다. CLI 입력 내용은 바꾸지 않는다. Codex 0.160.0은 이를 별도 developer 문맥으로 보관하며 성공한 문맥 전용 훅의 본문은 TUI에 표시하지 않는다. 긴 시스템 지시를 만들지 않고 인용 데이터를 직렬화한다. Claude는 기존 HTTP 훅의 같은 이벤트 경로를 사용한다. 다른 세션으로 보내는 메시지 기능과는 별개다.

`annotationHookTrustConfig`는 Harbor가 제공한 두 인용 훅의 정확한 정의만 지문으로 신뢰한다. 현재 실행의 CLI 설정에만 전달하며 사용자 설정 파일을 쓰거나 전체 훅 신뢰를 우회하지 않는다. 다른 훅의 상태와 실행 승인 규칙은 유지한다. 지문은 0.160.0 공식 소스의 정규 JSON·SHA256 형식을 따른다. 훅 명령이나 옵션을 바꿀 때 설정 생성과 지문 생성이 일치하는지 네이티브 `hooks/list` 결과와 비교해야 한다. Codex의 SessionStart는 첫 제출까지 지연되므로 MCP 연결 시 임시 참조를 준비하고 실제 훅의 세션 ID로 한 번만 연결한다.

번호는 프로세스 전체에서 재사용하지 않는다. 원래 터미널·네이티브 대화 경계를 검증하고 선택문은 불변으로 보관한다. 코멘트 연결은 전체 참조를 검증한 뒤 원자적으로 처리하고, 제출 후에는 코멘트도 변경하지 않는다. 취소한 미전송 참조는 제거하고 이미 입력한 번호는 제출할 때 사용할 수 있도록 유지한다. 저장 한도 초과나 연결 실패에서 각 참조의 코멘트를 보존한다. 원문이나 코멘트를 CLI에 풀어 넣는 대체 경로는 만들지 않는다.

VS Code 확장의 실제 내부 동작과 동일하다고 설명하지 않는다. 공식 배포 VSIX `openai.chatgpt` 26.51002.51308(win32-x64 prerelease, 2026-10-06 업데이트)의 webview 정적 코드를 직접 확인했다. 응답 인용은 `Response annotations` 구역에서 `text`·`annotation`·`source` JSON과 447자/64단어의 안내로 직렬화된다. 선택문·선택적 코멘트를 구성하고, 원본 메시지를 찾을 수 있으면 source에 messageId와 선택 시작·종료 오프셋도 보관한다. Harbor의 이전 안내문과 같지 않으며, 현재 Harbor는 CLI 훅에서 `reference`·`text`·`annotation`·`source`를 전달하는 자체 구현이다. Harbor의 터미널 선택은 원본 메시지 ID와 오프셋까지 추적하지 않으며 입력칸의 번호도 네이티브 IDE 첨부 요소가 아니다. 확장 패키지에서 정확한 `[#N annotation]` 표시 문자열까지 확인한 것은 아니다. 확장을 설치하거나 사용자 설정·대화를 읽지 않고 배포 ZIP의 정적 JS만 선별 확인했다. 확인한 번들 SHA256은 `fc1d63f87039bcd92ce8184878fe4f93917a604b64191ecc21475974c16b40ac`이다. [공식 IDE 문서](https://learn.chatgpt.com/docs/codex/ide), [공식 확장 배포](https://marketplace.visualstudio.com/items?itemName=openai.chatgpt).

관련 단위 테스트는 `terminalAnnotation.test.ts`, `terminal-annotations.test.ts`, `annotation-hook.test.ts`를 사용한다. 로컬 검증용 `scripts/verify-native-annotation.mjs`와 `scripts/verify-terminal-annotation.mjs`는 Git 제외 파일이다. 네이티브 검증은 격리한 CODEX_HOME과 작업 폴더, 합성 PTY, 루프백 모의 Responses 서버만 사용한다. 실제 API·사용자 대화·실제 SSH에서 검증하지 않는다. 설치본의 서버 파일을 교체해도 실행 중 서버와 Codex 프로세스는 이전 훅을 사용한다. 재시작 전 적용 완료로 보고하지 않는다.

## 검증과 민감정보 점검

```powershell
npm.cmd run build
node --import tsx --test --test-timeout=25000 --test-concurrency=1 src/server/*.test.ts src/client/*.test.ts
node scripts/verify-claude-api.mjs
git add <검토한 파일들>
npm.cmd run audit:publication
git diff --cached --stat
git diff --cached
```

감사 도구는 Git 인덱스의 파일만 검사한다. 민감한 줄을 로그나 대화에 그대로 출력하지 않는다. 새 문서·스크립트는 .gitignore와 scripts/audit-publication.mjs의 허용 목록을 함께 갱신한다. 데이터·로그·스크린샷·런타임·배포 바이너리를 `git add -f`로 포함하지 않는다. 테스트 계정·주소는 합성 예제로 쓴다.

설치/업데이트 스크립트를 바꾸면 별도의 깨끗한 클론에서 Setup -NoLaunch, 새 커밋으로 Update -NoLaunch, 사용자 데이터 보존, 수정된 소스 보호를 검증한다. 현재 쓰는 앱의 node_modules를 재설치하거나 사용자 세션을 종료하지 않는다.

## GitHub에 게시

Git for Windows의 GitHub 인증이 설정된 환경:

```powershell
git commit -m "Describe the user-visible change"
git push origin main
```

작업 브랜치를 사용했다면 검토·병합 후 main에 반영한다. 사용자 업데이트는 main에 올라온 내용만 받는다. push 실패를 성공으로 기록하지 않는다. 인증이 필요하면 Git Credential Manager의 브라우저 로그인을 사용하고 토큰·비밀번호를 파일이나 명령에 넣지 않는다.

선택적으로 버전 기준점을 태그로 남길 수 있다:

```powershell
git tag -a v1.0.1 -m "Harbor 1.0.1"
git push origin v1.0.1
```

태그나 GitHub Release 작성은 main 게시와 별도다. 실제로 게시하지 않았다면 생성했다고 보고하지 않는다. 태그만 올려서는 사용자 코드가 업데이트되지 않는다.

## 에이전트가 GitHub 연결 도구로 게시할 때

이 환경에서는 일반 git push 인증이 없지만 연결된 GitHub 앱의 쓰기 권한으로 최초 게시했다. 도구 이름·사용 가능 여부는 세션마다 다시 확인한다.

1. 대상 저장소와 원격 main SHA, 쓰기 권한을 확인한다. 이전 세션의 SHA를 재사용하지 않는다.
2. 로컬 변경을 커밋하고 감사를 통과한 파일만 `git show HEAD:<path>`로 읽는다.
3. 기존 원격 tree를 기반으로 변경 파일의 blob/tree를 만든다. 바이너리나 Unicode 변환이 우려되는 파일은 base64 blob으로 전송한다.
4. 생성한 tree SHA를 `git rev-parse 'HEAD^{tree}'`와 비교한다. 다르면 파일별 SHA를 비교해 수정하고 같아지기 전에는 main을 이동하지 않는다.
5. 현재 원격 main을 부모로 커밋을 만든 뒤 ref를 **force 없이** 갱신한다. 경쟁 변경으로 실패하면 새 main을 받아 통합·재검증한다.
6. `git fetch origin` 후 `git diff --exit-code HEAD origin/main`으로 내용이 일치하는지 확인한다.
7. API 커밋은 로컬 커밋과 SHA가 달라질 수 있다. 작업 트리가 깨끗하고 내용이 정확히 동일한 경우에만 로컬 기존 HEAD를 백업 브랜치로 남기고 `git reset --soft origin/main`으로 이력을 맞춘다. 사용자 변경이 있으면 자동 정리하지 않는다. upstream은 origin/main으로 설정한다.

기존 공개 저장소에 초기 README를 다시 만들거나 전체 tree를 무심코 교체하지 않는다. 파일 삭제는 의도적으로 검토한 경우에만 한다. 외부 게시 권한은 해당 사용자 작업 지시 범위를 따른다.

## 실행 파일 배포와 완료 보고

`npm.cmd run build:desktop`은 release 아래에 전체 앱 폴더를 만든다. EXE 하나만 전달하지 않는다. 빌드 산출물은 Git 소스에 넣지 않고 필요하면 별도로 ZIP/Release 자산으로 제공한다. 사용자 데이터가 포함되지 않았는지 패키지 내용을 검사한다.

마지막 보고에는 버전, 원격 커밋 링크, 검증 결과, 사용자의 업데이트 명령을 남긴다. 소스 게시, 설치본 교체, 실행 프로세스 재시작 여부를 구분한다. 실행 중인 사용자 앱을 임의로 재시작하지 않는다.
