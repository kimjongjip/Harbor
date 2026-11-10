# Harbor 개발·Git 게시·배포 절차

## 1.18.7 입력·완료 표시와 Mods 메뉴

`WorkGroup`은 펼쳤을 때 하단 접기 버튼을 제공하고 접힌 제목으로 스크롤·포커스를 돌린다. `TranscriptItems`는 동일한 항목 참조와 표시 속성을 비교해 레이아웃 변화만으로 목록을 다시 만들지 않는다. 기록 응답은 transition으로 적용하되 최신 기록 ref는 비동기 React commit과 별개로 유지한다. 실제 입력은 남은 기록 선택을 해제하여 멈춘 native projection을 재개하며 마우스 프로토콜 응답으로 선택을 해제하지 않는다.

완료 관찰은 Codex `Worked for`와 Claude `Cooked for … · done …` 같은 네이티브 완료 줄을 인식한다. 새 표시는 즉시·750ms·2초·5초의 제한된 기록 조회를 요청하며 실제 완료 판정은 저장 상태와 기존 화면 검증을 따른다. 작업 중 2초 조회는 마지막 저장 턴이 이미 완료되어도 계속한다. 원격 Claude 기록의 256KiB 읽기는 `readSftpRange`에서 최대 8개의 32KiB 요청으로 처리하고 짧은 패킷·EOF를 보존하며 오류 시에도 진행 중 요청이 끝난 뒤 handle을 닫는다.

Codex 배경 보완은 `cursorComposer`로 실제 커서·입력 모드·들여쓰기·하단 상태줄을 확인하여 wrap 플래그 없는 다중 행 입력도 지원한다. Claude dock의 연속 경계가 슬래시 메뉴에서 끝나면 원래 닫기 버튼·입력창·메뉴 행까지 확인한 뒤 그 위의 패널과 아래 선택 목록을 네이티브로 남긴다. DEC 2026 timeout으로 parsed 이벤트 없이 paint된 경우 `useClaudeModSurface`는 해당 대기 중 프레임만 다시 검사한다.

검증은 저장된 셀 배치·headless xterm·격리 Electron과 합성 HTTP/WebSocket으로 수행한다. 185개 작업의 위/아래 접기, 긴 기록의 선택 후 입력·IME, 커서로 배치한 프롬프트의 균일한 배경, 슬래시 메뉴의 dock 보존·복원과 sync timeout, 두 제공자의 완료·새 턴 조회를 포함한다. 합성 에코의 측정치를 실제 CLI·SSH 지연으로 보고하지 않는다. 실행 중 Harbor·백엔드·사용자 PTY는 종료하거나 재시작하지 않는다. 화면 패치와 다음 실행용 패키지를 따로 적용하며 원격 읽기 개선은 새 백엔드 실행부터 활성화된다.

## 1.18.6 공유 Codex 기록 표시 복구

공유 daemon으로 재개한 Codex는 터미널별 SessionStart 훅을 다시 보내지 않을 수 있다. 이때 agentKind는 Codex인데 agentSessionId·resumeThreadId가 모두 없어 TerminalConversation이 생성되지 않았다. `useTerminalHistorySession`은 이런 활성 화면에서만 원래 alternate buffer 하단의 모델·대화 제목·shortcuts와 bracketed paste 상태를 확인한다. 기존 인증 history API로 같은 호스트의 정확한 제목을 검색하고, 결과가 하나이며 추가 페이지가 없고 완료 답변의 충분히 긴 끝부분이 실제 본문에 있을 때만 reader의 ID를 복구한다.

복구 ID는 `TerminalConversation.historySessionId`에만 전달하며 TerminalInfo·입력·peer runtime을 수정하지 않는다. 원래 훅 ID가 있으면 우선한다. 제목이 잘리거나 중복되거나 답변을 확인할 수 없으면 원래 CLI를 유지한다. 제목 변경·탭 숨김·원문 보기·제공자 변경 시 이전 요청을 취소한다. 출력은 250ms 단위로 하단 6행만 확인하고 검색 재시도는 최소 30초 간격이다. 복구 후 같은 제목의 출력·입력은 추가 검색이나 React 상태 갱신을 만들지 않는다.

`terminal-history-session.test.ts`는 고유 제목·완료 답변 확인, 중복·다른 호스트/제공자·잘린 제목·초안·진행 중 답변·늦은 응답 거부를 검증한다. `terminal-history-session.browser.test.ts`는 격리 Electron의 실제 TerminalPane에서 ID 없는 공유 세션의 제목·표 조판, 입력 한 번 전달, 연결·크기·초안 보존, 반복 출력 중 검색·기록 재렌더 없음과 대화 전환 취소를 검증한다. 화면 파일 교체와 사용자의 새로고침으로 기존 공유 세션에도 적용할 수 있으며 앱·CLI 재시작은 필요 없다.

## 1.18.5 Mods 옆의 Claude 하단 안내

Mods dock가 열리면 `claudeModSurface`는 패널을 제외한 셀 범위에서 입력창 바로 위의 유휴 압축·업데이트 안내를 확인한다. 알려진 완전한 문구가 있는 하단 구간만 원래 xterm에 남긴다. 이 안내를 history reader에 넣으면 원래 오른쪽 정렬 공백과 문서 padding 때문에 마지막 단어가 다음 줄 왼쪽으로 밀렸다. 표시된 단어·ANSI 색·좌표를 변경하거나 PTY 크기·입력을 조작하지 않는다.

최대 12행의 하단 범위에서 안내 하나당 최대 6행을 읽어 CLI가 직접 배치한 줄바꿈도 지원한다. 일반 출력·인용문에서는 경계를 넓히지 않고, 안내가 사라지면 원래 reader 높이로 돌아간다. `terminal-mod-surface.test.ts`는 실제 253×44 셀 배치와 단독·여러 줄 안내·인용 오인 방지·소멸을, `terminal-conversation-mods.browser.test.ts`는 합성 화면의 원래 canvas 노출·중복 조판 없음·높이 복원과 Mods 클릭·입력·기록 렌더 보존을 검증한다.

## 1.18.4 다크 팔레트

`theme-palettes.ts`가 다섯 다크 테마의 UI 변수·xterm ANSI 색·Monaco 색을 공유한다. 기존 저장값 `dark`는 차콜로 유지하고 새 ID도 저장·별도 창 동기화에서 검증한다. `data-theme`는 선택값, `data-appearance`는 명암 구분이다. 라이트·페이퍼로 돌아갈 때 다크 팔레트의 인라인 변수를 제거한다. 테마 선택은 터미널이나 편집기 모델을 다시 만들지 않는다.

`TerminalPane`은 layout effect에서 xterm 팔레트를 적용하고 `TerminalNativeFlow`는 테마 변경 시에만 추가 capture를 예약한다. idle 상태에서도 이전 기본색으로 그린 행을 갱신하며 매 paint 구독·추가 키 입력·PTY 쓰기를 사용하지 않는다. `ide-terminal-switch.browser.test.ts`는 출력 없는 테마 전환의 실제 행 색·설정 저장·입력과 연결 보존을 확인한다. 별도 합성 앱에서 일곱 테마의 화면·편집 초안·Monaco 색·다시 열기와 좁은 화면을 검증한다.

## 1.18.3 중앙 PDF·이미지 탭

IDE의 열린 문서는 텍스트 모델과 미디어 문서를 구분한다. PDF·이미지에는 Monaco 모델을 만들지 않고 중앙 pane에 `IdeMediaPreview`를 표시한다. 저장·비교·코드 인용은 텍스트에만 적용하며 미디어 탭별·pane별 페이지와 배율을 보존한다. 외부 미리보기는 명시적인 도구 모음 동작으로 남긴다.

PDF.js는 문서를 열 때 지연 로드하고 별도 worker로 해석한다. 페이지 렌더링은 뷰어의 표시 영역을 따르며 탭을 떠날 때 로딩·worker를 정리한다. 폰트·CMap·WASM·ICC는 Vite의 `pdfResources`가 버전별 디렉터리에 포함한다. PDF 스크립팅 관리자는 사용하지 않고 기존 인증 PDF 경로·CSP·Electron `plugins:false`를 유지한다. `ide-media.browser.test.ts`에서 실제 이미지·PDF 중앙 표시, 새 창 없음, PDF 검색·페이지·배율, 탭 복원·분할·닫기와 미저장 초안을 검증한다. 새 PDF 리소스 폴더도 프런트엔드 반영 시 함께 복사해야 한다.

## 1.18.2 큰 PDF·이미지 미리보기

IDE는 정규 경로와 세션을 확인한 뒤 `fileMediaKind`로 PDF·이미지를 먼저 분류하여 텍스트 읽기·2MiB 검사·인코딩 변환을 건너뛴다. 클라이언트는 바이너리 안내와 구버전 서버의 큰 미디어 오류를 자동 미리보기로 연결하고 오류 띠를 남기지 않는다. 텍스트 편집과 기존 미저장 모델은 유지한다.

이미지는 64KiB 이하의 헤더로 MIME을 확인하고, 본문은 로컬/SFTP 스트림으로 보낸다. PDF·이미지의 인증 경로는 유지하며 `sendMediaFile`이 Content-Length, 단일 byte range, HEAD, 연결 취소를 처리한다. 응답의 no-transform은 압축으로 byte range가 달라지는 것을 막는다. SVG도 새 서버에서는 `<img>`로 직접 읽으며 HTML로 삽입하지 않는다. 기존 SVG 다운로드 호환 경로는 구버전 서버에만 사용한다. `file-media.test.ts`는 24MiB 파일·SSH 범위 읽기·취소를, `ide-media.browser.test.ts`는 별도 Electron에서 20MiB 초과 PNG/JPEG/SVG와 2MiB 초과 PDF의 실제 표시 및 미저장 초안 보존을 검증한다.

## 1.18.1 IDE 탐색기 너비

`ResizableSidebar`의 IDE 설정은 별도 `harbor.ideExplorerWidth`에 너비를 저장한다. 드래그는 탐색기의 CSS 변수만 변경하고 상위 IDE·터미널 상태를 갱신하지 않는다. 화면에 맞춘 일시적인 CSS 제한은 저장된 선호 너비를 덮어쓰지 않는다. 공통 경계 스타일은 컴포넌트에서 불러와 호스트·다른 PC 연결 모두에 적용한다. 기존 `ide-terminal-switch.browser.test.ts`에서 드래그·키보드·화면 축소와 복원·새 화면의 저장 너비·초기화 및 기존 터미널 DOM·입력·연결 보존을 함께 검증한다.

## 1.18.0 IDE 터미널 유지와 Mods 설치

PC IDE의 기존 세션은 같은 `TerminalWorkspace` DOM·xterm·WebSocket을 CSS grid로 오른쪽에 배치한다. `singleTerminalId`는 표시만 한 세션으로 제한하고 저장된 분할 tree는 유지한다. 새 AI 대화는 명시적 선택이며 숨길 때 작성 중 초안을 언마운트하지 않는다. `ide-terminal-switch.browser.test.ts`는 전체 앱에서 입력·DOM·연결·분할·새 대화 초안 보존과 불필요한 대화 생성 방지를 검증한다.

Mods는 고정된 공개 Agent Crew 카탈로그를 설치한다. HTTP에서 임의 명령·저장소 주소를 받지 않는다. 기존 CLI에 문자열을 보내지 않고 로컬 별도 프로세스 또는 전용 SSH exec 연결을 사용한다. 사용자 설정·로그인은 대상 서버의 Claude가 관리하며 다른 서버로 복사하지 않는다. 동일 호스트 설치 중복을 합치고 종료 코드 후 실제 설치·활성 목록을 다시 확인한다. 추가 marketplace 명령 승인은 자동 수락하지 않는다. `claude-mods.test.ts`와 위 전체 앱 테스트로 검증하며 실제 설치 시험은 별도 `CLAUDE_CONFIG_DIR`에서만 수행한다.

사용자 요청에 따라 업데이트는 검증·스테이징 검토·감사 후 main 게시까지 완료한다. 개인 수집 자동화·설정·보고서는 소스 저장소 밖에 유지한다. 실행 중 설치본의 화면 반영과 신규 패키지의 다음 실행 준비는 현재 앱·백엔드 종료 없이 진행하고 각각 구분해 보고한다.

## 세션과 독립적인 보고서 알림

`ReportNotificationsSync`는 로컬 호스트의 인증된 파일 미리보기 API로 `~/.harbor/reports/index.json`을 읽는다. 목록은 최근 200건 이하의 제목·요약·시각·고정 형식 ID만 포함하며 본문은 해당 ID의 JSON 파일을 선택할 때 읽는다. 원본 수집 작업이나 사용자 보고서는 제품 소스·패키지에 포함하지 않는다. 화면이 보일 때 60초 간격과 사용자의 새로고침으로 조회하고, 동일 목록은 상태를 다시 설정하지 않는다. 파일 없음·깨진 JSON·잘린 응답은 마지막 정상 목록을 지우지 않는다.

`report-notices` 스키마는 임의 경로·중복 ID를 거부한다. 보고서를 눌러도 세션 포커스나 입력 API를 호출하지 않으며 `Modal` 안의 Markdown으로 연다. 읽음 상태는 기기별 localStorage에 저장하고 같은 기기의 다른 창에 반영한다. `report-notifications.browser.test.ts`는 격리 Electron에서 새 보고서·본문·표·읽음 복원·불완전 목록·기존 터미널 알림을 검증한다. 실행 중 서버의 기존 파일 API를 사용하므로 프런트엔드 교체로 제공할 수 있으며 앱·백엔드 재시작은 필요 없다.

## 기본 대화 보기의 Claude Mods 보존

`useClaudeModSurface`는 완전한 Claude 입력창과 표준 Mods 경계가 확인되면 대화 표시층의 폭·높이를 본문 영역으로 제한한다. 오른쪽 dock, 좁은 창의 inline pane, AbovePrompt band와 입력창은 원래 xterm에 남으므로 Client 이미지·애니메이션·마우스 좌표를 다시 구현하지 않는다. `terminal-mod-surface`는 저장 기록과 네이티브 출력의 연결을 판정할 때 패널 텍스트를 제외한다. `TerminalNativeFlow`의 `end`·`panels`는 읽기용 투영만 제한하며 원본 버퍼·PTY 크기·입력은 변경하지 않는다. 여러 줄 입력에서도 패널을 유지하며, 패널을 닫거나 승인 화면으로 바뀌면 기존 대화 배치로 복귀한다.

화면 크기는 초기화·resize 때만 측정하고 패널 내용만 갱신될 때는 React의 배치 상태를 다시 설정하지 않는다. `terminal-conversation-mods.browser.test.ts`는 격리 Electron과 합성 기록으로 오른쪽/하단/입력창 위 패널, 클릭의 실제 터미널 셀 좌표, 입력 한 번 전달, 원문 전환, 승인 화면, 애니메이션 중 저장 답변 재렌더 0회를 확인한다. `terminal-mod-surface.test.ts`는 한글과 여러 줄 입력, 원본 버퍼 보존을 검증한다. 별도의 Claude Code 2.1.319에서도 72열·18행을 요청하는 합성 Pane을 열어 100/130/144/160/200열 화면의 실제 경계 인식을 확인했다(격리 설정, 가상 API, 모델 요청 0회). 기존 모바일 패널 숨김 정책은 유지한다. 실제 사용자 세션에 테스트 명령을 입력하거나 실행 중 앱을 재시작하지 않는다.

## 프롬프트 입력 지연 회귀 방지

`terminal-native-ime`는 대화 표시층(z-index 7) 뒤에 있던 xterm 조합 UI(z-index 5)를 조합 중에만 앞에 놓고 실제 투영 커서의 글자 위치에 맞춘다. 원래 textarea와 composition-view를 함께 이동하므로 OS 후보창 위치도 같은 위치를 따른다. 확정·취소·blur·화면 해제 시 원상 복구한다. 입력 데이터를 만들거나 가짜 에코를 추가하지 않는다. 위치 관찰은 조합 중에만 수행한다. `terminal-input-performance.browser.test.ts`는 Chromium IME 이벤트로 `ㅎ → 하 → 한`의 가림·위치·확정 전 미전송·한 번 확정·취소 후 영문 입력을 검증한다. 실제 Windows IME 후보창 자체의 외관은 이 자동 검증 범위에 포함하지 않는다.

추가 실측(Windows, Codex CLI 0.167.0): 기존 사용자의 터미널 대신 격리 CODEX_HOME·가상 모델 서버·합성 0/500턴 기록을 사용했다. Harbor 화면 없이 native PTY 입력→글자 출력은 약 32ms, 실제 TerminalPane/WebSocket/CLI를 연결한 숨김 Electron에서는 키→DOM 약 31ms(그중 마지막 출력→DOM 약 1ms)였다. 대화 길이에 따른 차이는 거의 없었다. 합성 WebSocket 에코의 약 2ms를 실제 CLI 전체 지연으로 보고하지 않는다. [Codex의 paste-burst 설정](https://learn.chatgpt.com/docs/config-file/config-reference)은 끄면 이 실험에서 약 15ms까지 줄지만, Windows 콘솔에서는 bracketed paste가 키 이벤트로 전달될 수 있어 여러 줄 붙여넣기 중 의도치 않은 전송을 확인했다. 따라서 이 설정을 기본값이나 사용자 설정에 적용하지 않았다. 남은 native CLI 지연과 한글 조합 UI의 가림은 별개의 문제다.

`desktop/input-scheduling.cjs`는 앱 초기화 전에 기존 `disable-features` 옵션을 보존하며 `DeferRendererTasksAfterInput`만 추가한다. Chromium의 이 스케줄러 정책은 입력 직후 일부 renderer task를 다음 프레임까지 최대 50ms 미룬다. [Chromium 구현](https://chromium.googlesource.com/chromium/src/+/29ff47d3f212fae17310a613844f36d214cd9400%5E%21/). 격리 Electron에서 키→xterm 입력은 즉시, 서버의 합성 에코도 즉시였지만 WebSocket 메시지 콜백이 약 50ms 늦었다. 동일한 화면에서 해당 기능만 비활성화하면 이 대기가 사라진다. 브라우저 전체 보안·샌드박스·GPU 옵션을 끄는 수정은 아니다. 실행 중인 앱에는 새로고침만으로 적용되지 않는다.

`TerminalNativeFlow`는 `.xterm-screen` 높이를 최초 한 번 읽고 이후 `ResizeObserver` 크기를 사용한다. 매 입력 후 동기 geometry 조회를 하지 않는다. 완료 답변은 text와 renderer가 같으면 재사용하고, 일반 원문은 절대 행 번호 기준 64행 묶음으로 비교하여 변경된 묶음만 React가 다시 처리한다. 모든 행의 DOM은 유지하여 연속 선택·복사·이전 기록 읽기를 보존한다. `NativeFlowFrame`은 실제 bracketed-paste 모드도 전달한다. `nativeChrome`은 긴 Codex 입력의 실제 커서·wrap을 따라가며, 수동 배치된 들여쓰기 행은 알려진 하단 상태줄까지 확인한다. 입력 모드·커서 근거가 없거나 승인 대기이면 원문 보존 경로를 유지한다.

`terminal-native-row.css`는 마지막 ANSI 배경색을 행 오른쪽 끝까지 확장한다. 한글·이모지가 xterm 셀 폭보다 좁은 글꼴로 표시되어도 줄마다 배경 끝이 달라지지 않는다. 배경용 생성 텍스트는 복사 문자열에 포함하지 않는다.

`terminal-input-performance.browser.test.ts`는 실제 TerminalPane·WebSocket·xterm 경로에서 합성 80턴/원문 5,000줄과 완료 답변·긴 한글 입력을 검사한다. 키를 한 번씩만 전달하고 저장 기록 및 완료 답변의 Markdown 재렌더가 0회인지 확인하며, 키→출력 도착→파싱→DOM 시간을 브라우저의 같은 시계로 기록한다. 숨긴 격리 Electron의 수치를 실제 SSH 왕복 시간이나 사용자의 전경 창 측정으로 설명하지 않는다. `terminal-native-flow.browser`는 geometry 재조회 없음·긴 원문 셀 재읽기 없음·선택 보존을, `terminal-native-row.browser`는 실제 터미널 폭에서 한글 배경 끝·복사·커서를 검사한다. 추가 회귀 검사는 native-chrome/transcript-boundary, conversation-pane/conversation, conversation-pagination, completion-refresh이다.

클라이언트와 desktop 시작 파일만 현재 설치에 반영할 경우 기존 index·시작 파일을 비공개 폴더에 백업하고 해시 자산을 추가한다. 실행 중 백엔드와 사용자 터미널은 유지한다. Ctrl+R은 화면·배경 수정을, 앱 완전 종료 후 재실행은 입력 후 task 지연 수정을 적용한다. 코드 수정·로컬 설치 반영·Git 게시·앱 재실행은 각각 구분해서 보고한다.

## 1.17.0 작업 중 표시와 CLI 작업 로그

Claude Code 2.1.3xx와 Codex 0.16x는 기본으로 대체 화면(전체 화면)을 쓰므로 xterm에는 화면 한 장만 남는다. 1.16.x는 이 화면을 저장 기록과 문자열로 맞춰 이어 붙였고, 표로 끝나는 답변이나 긴 작업에서 맞추기에 실패하면 화면 전체가 "칸"처럼 붙고 현재 턴 앞부분이 사라졌다. `terminal-native-chrome.ts`는 하단의 CLI 영역만 찾는다. Claude는 맨 아래 실선 묶음(입력창 위·아래 줄 또는 승인 상자 윗줄)과 바로 위 진행 표시·할 일 줄, Codex는 바닥 근처 `›` 입력줄과 상태줄이다. `liveTranscriptLayout`은 진행 중 턴을 포함한 모든 턴을 기록에서 그리고, 마지막 저장 텍스트(또는 현재 질문·직전 완료 답변) 이후의 화면 행과 하단 영역만 네이티브로 남긴다. 아무것도 맞지 않으면 최신 블록부터 보여준다. 하단 영역을 찾지 못하거나 프레임 없는(Codex형) 선택지가 승인 대기 중이면 기존 `transcriptBoundary`로 화면 전체를 유지한다. 실제 녹화 화면으로 만든 `terminal-native-chrome.test.ts`를 CLI 화면이 바뀔 때 갱신한다.

`TerminalNativeFlow`는 `{start, split}`을 받아 `[start, split)` 행을 실행 중 턴의 **작업 중** 묶음 안(`workTarget` portal)에, 나머지를 맨 아래에 그린다. 묶음을 접으면 두 부분이 함께 숨는다. 갱신은 키 입력 직후 250ms 동안 microtask로 즉시, 그 밖의 출력은 40ms 묶음으로 처리하며 RAF에 의존하지 않는다. 예약된 묶음을 새 출력으로 취소하면 갱신이 영구히 멈추므로 앞당기기만 한다. `nativeRow`는 셀 객체를 재사용하고 JSON 대신 문자열 키로 run을 합친다(모바일 공유). 대화 화면이 덮은 `TerminalRich`(`covered`)는 출력마다 재배치하지 않고 새 완료 답변의 높이 측정·`/rich/:id/layout` 응답만 유지한다. 예약 행의 완료 답변은 `renderNativeAnswer`가 Markdown으로 즉시 조판한다. 실행 중이고 화면에 `esc to interrupt`가 있거나 상태가 working/waiting이면 2초마다 기록을 다시 읽는다. 완료된 묶음은 펼칠 때만 내용을 렌더링한다.

`transcript-steps.ts`는 저장 순서를 바꾸지 않고 도구 호출과 결과를 `toolUseId`(구버전은 발생 순서)로 묶는다. `TranscriptWork.tsx`는 `Update(파일)`·`Bash(명령)` 머리줄과 한 줄 결과를 summary에 두고, 접힌 단계는 본문을 DOM에 남기지 않는다. 접힌 `<details>`의 숨은 내용은 스크롤 뒤 선택 문자열에 섞일 수 있었다. 서버의 `editResult`는 Claude `toolUseResult.structuredPatch`를 hunk 머리줄이 있는 unified diff(`format: "diff"`)로, 새 파일은 `format: "file"`로 보낸다. 레코드 하나에 도구 결과가 둘 이상이면 적용하지 않는다. 출력은 `AnsiText`가 SGR 색만 살린다. 터미널 작업 묶음 안의 단계는 펼친 상태로, 사이드바 기록 미리보기의 단계는 접힌 상태로 시작한다. 사용자가 직접 펼칠 때만 잘린 원문 첫 페이지를 자동으로 읽는다.

`shared/user-message-origin.ts`는 CLI가 user로 저장했지만 사람이 입력하지 않은 기록을 정확한 표식으로만 분류한다. Claude 2.1.295+의 `origin.kind`(human·voice-call 등은 입력, task-notification·channel·peer·plugin 등은 생성), `<command-name>`·`<local-command-stdout|stderr|caveat>`·`<bash-*>`·`<task-notification>`·`[Request interrupted…]`·`<channel>`·`<system-reminder>`, Harbor 자신의 Codex 동료 봉투가 대상이다. 서버는 `MessageItem.origin`과 표시용 텍스트를 보내고 저장 파일은 바꾸지 않는다. 클라이언트 `userMessageView`는 구버전 서버의 원문 태그에도 같은 분류를 적용한다. 터미널·모바일 대화·IDE 패널은 "나" 대신 명령·알림·메시지 라벨을 쓴다. 알림·채널은 새 턴을 열고 명령 출력·중단은 이전 기록에 붙는다.

`assembleClaudeHistory`는 직접 입력한 프롬프트가 부모 레코드의 턴을 물려받지 않게 한다. 실제 기록은 턴 사이 system 레코드 때문에 대개 끊겼지만, 프롬프트의 부모가 바로 이전 답변이면 모든 턴이 첫 턴으로 합쳐졌다. 작업 항목은 user/assistant 레코드에서만 만든다. Claude Code 2.1.319의 `api-request-blob`은 보낸 요청의 도구 결과 사본을 담는다. `HistoryActivities.previewAll`은 미리보기 용량을 최신 작업부터 배분하되 원문 캐시는 시간순으로 넣어 LRU가 최신 원문을 먼저 버리지 않게 한다.

`ClaudeHistory.read`는 세션 파일 위치를 최대 256개 기억하고 매번 stat으로 확인한다. 사라지면 한 번만 목록을 다시 만든다. 10초 캐시가 끝날 때마다 모든 세션 파일의 앞뒤를 다시 읽지 않는다. SSH 호스트의 읽기 연결은 60초 유휴까지 재사용한다. 실패·시간 초과·`close(hostId)`·설정 변경 시 폐기하고 진행 중 읽기는 `closed` 오류로 끝낸다. 로컬은 요청마다 열고 닫는다.

검증: `terminal-native-chrome`, `terminal-transcript-boundary`, `transcript-steps`, `user-message-origin`, `claude-history*`, `history*` 단위 테스트. 바뀐 구조를 반영한 브라우저 테스트는 `terminal-conversation`, `terminal-conversation-pane`, `terminal-completion-refresh`, `history-preview`이다. 실행 중 턴은 live 묶음, 완료 증명 후에만 done 묶음, 접힌 단계 DOM 없음, 키 입력 중 저장 기록 재렌더 없음, 입력 미전송을 확인한다. `mobile-settings.browser`의 일회용 연결 링크 대기 실패는 1.16.3 HEAD에서도 같아 이번 변경과 무관하다. 별도로 `.cache`의 격리 스크립트로 실제 Claude Code 2.1.319를 실행했다. 별도 `HARBOR_DATA_DIR`·포트·Electron 프로필·`CLAUDE_CONFIG_DIR`·`CODEX_HOME`을 쓰고, 루프백 모의 모델과 그 밖의 HTTP(S)는 닫힌 로컬 프록시 포트로 보냈다. 이 상태에서 합성 장기 대화 재개 → 입력 → 3단계 작업 → 완료를 오프스크린 Electron으로 측정·캡처했다. Harbor 터미널 안에서 실행하는 셸에는 실행 중 Harbor의 `HARBOR_DATA_DIR`·`HARBOR_PORT`·토큰이 상속되므로 격리 실행 전에 모두 제거한다. 실제 Codex를 격리 실행할 때 첫 화면의 Windows 샌드박스 설정 질문에 Enter를 보내면 안 된다. 격리 `CODEX_HOME`이어도 컴퓨터 전체의 CodexSandbox 계정 비밀번호와 방화벽 규칙을 다시 구성한다. `[windows] sandbox = "unelevated"`를 미리 넣거나 Esc로 닫는다. 작업 폴더는 Git 저장소 밖에 둔다.

## 1.16.3 Codex 표시 차이와 완료 조회

`terminal-transcript-boundary`는 저장된 Markdown의 원본과 링크 제목·목록 기호가 바뀐 비교용 텍스트를 함께 확인한다. 목록은 줄 시작의 문법만 정규화하고 본문 하이픈은 유지한다. 코드 안의 링크·목록·잘못된 문법은 임의로 제거하지 않으며, 저장된 원문을 수정하지 않는다. 비교 결과는 메시지 객체별로 캐시하고 기존 최소 일치 길이·완료 증명·반복 질문 보호를 유지한다. `»` 프롬프트도 같은 네이티브 질문으로 인식한다.

Codex `delivery: poll` 경로는 상태가 idle에 머무르거나 조판 블록 알림이 없을 수 있다. 새 네이티브 완료 출력은 기록 재조회 신호로만 사용한다. 자체 완료 증거로 취급하거나 작업/승인을 전송하지 않으며, 기본 폴링도 유지한다. 저장 완료가 출력보다 늦는 경우를 위해 200/1200/3000ms에만 재조회를 예약하며, 진행 중 요청은 기존 큐에서 합친다. 입력·커서·동일 완료 출력마다 조회가 반복되지 않도록 중복을 제거하고 세션 전환 때 초기화한다. 검증은 링크가 있는 최종 답변, 다른 프롬프트 문자, 완료 알림 없는 합성 Codex 화면, 추가 출력 없이 늦게 저장되는 완료 상태와 원래 입력 보존을 포함한다.

현재 Codex 입력줄이 배경을 전혀 보내지 않는 경우 `terminal-native-composer`가 표시용 배경을 보완한다. bracketed-paste 모드와 실제 커서가 있는 프롬프트 및 네이티브 줄바꿈으로 이어진 행만 대상이다. 명시적인 셀 배경이나 반전 색상이 있으면 적용하지 않는다. PTY·버퍼·복사 문자열은 변경하지 않고 테마 색상으로 행 배경만 표시한다.

## 1.16.2 입력 지연·원래 배경·완료 전환

`TerminalNativeFlow`는 `onWriteParsed` 직후 microtask로 화면을 갱신한다. 입력 에코에 고정 지연을 추가하거나 RAF에만 의존하지 않는다. DEC2026 동기 출력은 끝날 때까지 보류한다. `NativeFlowReader`는 공개 marker로 삭제·이동을 추적해 변경되지 않는 normal-buffer 스크롤백만 재사용하며, 현재 화면은 색상만 바뀌어도 다시 읽는다. 초기화·크기 변경·alternate buffer·테마 변경에서는 캐시를 무효화한다. `TerminalConversation`은 기록과 네이티브 경계가 바뀔 때만 저장된 대화를 갱신한다. 입력을 가짜로 에코하거나 PTY 크기·제어권을 바꾸는 최적화는 사용하지 않는다.

`NativeRow`의 배경 레이어는 원래 ANSI 셀 색을 끝 공백·빈 행까지 표시한다. CSS 생성 텍스트를 사용하여 복사 문자열에 패딩을 추가하지 않고, 배경은 행 폭 안에서 잘라 가로 스크롤·줄바꿈을 만들지 않는다. 커서 위치의 패딩도 실제 run의 색을 따른다.

최신 미완료·완료 불명 턴은 저장된 개별 도구 항목으로 바꾸지 않는다. `idle` 자체는 완료 증거가 아니며, 네이티브 완료와 동일 답변의 원문/예약 위치를 확인한 뒤 질문·작업 묶음·최종 답변을 함께 전환한다. Claude의 이미 교체된 예약은 원래 답변 텍스트로 복원해 미완료 내용을 부분 조판하지 않는다. 오래된 완료 정보 없는 기록은 `저장된 작업`으로 묶어 수동으로 읽으며 완료됐다고 표시하지 않는다.

회귀 검증: 실제 xterm/Electron에서 5,000줄 기록의 키 에코 지연·과거 셀 재읽기, 20회 입력 중 저장된 기록의 렌더 횟수, 색상만 변경·스크롤백 제거·전체 화면 전환, 회색 빈 입력 행·한글/이모지·복사, 원문→완료 일괄 전환, 기존 연속 선택·이전 페이지 읽기를 확인한다. SSH 왕복 시간과 클라이언트 표시 지연 측정은 구분한다.

## 1.16.1 통합 터미널과 작업 원문

1.16.0의 위쪽 기록 overlay와 아래쪽 입력 분할을 제거했다. `TerminalConversation`은 전체 영역의 단일 scroller이며 `TranscriptItems`의 저장된 항목 다음에 `TerminalNativeFlow`가 같은 xterm의 현재 출력·입력을 이어 표시한다. 별도 대화 헤더/모드 선택이나 중앙 최대 폭이 없다. 원문 버튼은 같은 CLI의 가공하지 않은 화면을 확인하는 fallback이다. 네이티브 프로세스·socket·PTY 크기·입력 경로를 변경하지 않는다.

`terminal-transcript-boundary.ts`는 현재 질문, 정확히 일치하는 조판 답변, 마지막 답변 원문을 이용해 겹치는 구간만 교체한다. `idle`이 명시된 경우에만 원래 입력칸으로 경계를 줄이며, 알 수 없는 상태/승인 대기에서는 원문을 임의로 없애지 않는다. 선택 또는 과거 읽기 중에는 기록·완료 접기·네이티브 경계를 함께 보존한다. 입력 또는 맨 아래로 이동하면 최신 출력에 합류한다. native DOM은 xterm 공개 buffer/cell API를 읽고 ANSI 색상·넓은 문자·원래 커서를 보존하며, 네이티브 입력은 기존 textarea와 제어권 검사에 맡긴다. 조판이나 읽기만으로 입력/resize를 보내지 않는다.

`TranscriptItems`는 명령·도구·코드 변경·에이전트 작업을 원래 순서의 개별 details로 표시한다. 과거 작업은 완료 증명이 없어도 수동 펼침을 제공한다. 전체 턴의 자동 접기는 기존 명시적 완료 증명을 유지한다. `history-items.ts`는 성공한 도구 결과와 에이전트 결과의 저장된 공개 텍스트를 보존한다. 접기와 더 읽기는 모델 호출이 아닌 DOM 표시와 파일/RPC 읽기이며 요약·토큰 압축을 수행하지 않는다.

`HistoryActivities`는 긴 공개 출력의 원문을 호스트 설정·공급자·native session·항목·원문 해시에 묶는다. 전체 캐시 64MiB/4,096개, TTL 15분이며 preview는 일부만 전송한다. `/api/hosts/:id/history/:threadId/activity/:ref`는 기존 인증을 유지하고 UTF-16 64K 단위로 원문을 반환한다. 만료/퇴거는 명시적 새로고침 오류이고 다른 서버/세션/공급자에서는 같은 ref를 읽지 못한다. 긴 도구를 잘라 없애지 않으며 기존 개별 JSONL 8MiB 및 비정상 단일 항목 2,048 activity 상한은 명시적 안내로 남긴다. 숨겨진 추론·이미지 바이트·알 수 없는 인수는 포함하지 않는다.

회귀 검증은 `terminal-native-flow*`, `terminal-transcript-boundary`, `terminal-conversation*`, `history-preview.browser`, `history-activity`, 기존 history/Claude/mobile/control 테스트를 사용한다. 실제 세션 입력/강제 재시작 없이 격리된 원본 버퍼, 합성 기록, HTTP 서버에서 검증한다.

## 1.16.0 세션 연속성과 대화 읽기

모바일 lease의 renew/release에는 획득한 token을 함께 보낸다. 모바일의 `fresh: true` claim만 새 세대를 만들며, 늦게 도착한 예전 release가 복귀 후 lease를 해제하지 못한다. 동일 대상으로 동시 claim은 합치고, 숨김·세션 변경 중 완료된 claim은 해당 token으로 반환한다. 기존 PC IDE/터미널의 claim 캐시 호환은 유지한다. Safari `pageshow.persisted` 및 온라인 복귀는 현재 snapshot을 받은 뒤 입력을 허용한다. 전송·첨부 완료는 원래 terminal/runtime/native binding과 초안을 확인하며 다른 세션 초안을 바꾸지 않는다. 전송 실패/불확실 입력을 재생하지 않는다.

`TerminalConversation`은 같은 CLI의 읽기 전용 기록을 하나의 DOM에 표시한다. 기본 자동 모드는 완료가 증명된 마지막 턴이고 실제 native 상태가 작업/승인 대기가 아닐 때만 표시한다. 같은 xterm과 PTY 입력을 유지하고 원문 표시를 선택할 수 있다. 네이티브 상태·rich 이벤트로 즉시 갱신하고 활성 화면에서만 30초 fallback을 사용한다. 읽기 전용 RPC idle lease는 60초이며 기존 close/shutdown 정리를 유지한다. 뷰 전환을 이유로 CLI를 재개하거나 writer lock을 건드리지 않는다.

기록 API의 `includeActivity=1`은 선택적인 작업 순서를 반환한다. 기존 `items`는 Q/A 계약을 유지한다. `turnStatus`와 `phase`는 Codex native turn 상태 또는 Claude의 명시적 end_turn/result로만 완료를 증명한다. Claude의 stop_reason=null이나 rich 답변 블록을 턴 완료로 추측하지 않는다. Claude native Stop의 `last_assistant_message`는 SHA-256만 AppState에 전달하고 현재 세션 마지막 답변의 정확한 UTF-8 해시와 일치할 때 보조 증거로 사용한다. 새 입력·도구·실패·세션 전환·continuation은 증거를 무효화하며 디스크에 지속하지 않는다. 클라이언트는 확인한 기존 메시지를 해당 세션 안에서만 기억하고 본문이 변경되면 재사용하지 않는다. 알 수 없는 페이지 접두부를 임의 턴에 합치지 않는다. 도구 기록은 개별 4k, 페이지 200개/96k 문자로 제한하고 이미지 바이트·내부 thinking을 보내지 않는다. 원문 파일은 수정하지 않는다.

`conversation-selection.ts`는 연속 문서 전체의 드래그·휠·경계 스크롤을 처리한다. `TerminalConversation`은 선택 중 최신 응답 갱신과 완료로 인한 접기를 미루되 이전 페이지는 앞에 붙여 읽을 수 있다. `conversation-selection-snapshot.ts`는 기존 DOM 노드를 보존하고 부분 턴 재결합으로 노드가 바뀔 때 메시지 ID·동일한 원문·문자 오프셋으로만 선택을 복원한다. 원문이 다르면 복원하지 않는다. 페이지 커서 반복을 차단하며 새 기록 대기열과 이전 페이지 병합을 분리한다. `richSelectedText`는 중간 질문/답변·작성자 표시를 포함하고 닫힌 작업 details 및 중복 조판 조각을 제외한다. native canvas와 DOM 사이를 좌표로 이어 붙이지 않는다. `TerminalTypeset`은 `onWriteParsed`도 구독하여 화면 이동 없이 조판 위치를 갱신한다.

HTTP 응답은 `serializeHistoryDetailForRead`가 Q/A를 `items`에 한 번만 담고 `activity`와 `${kind}:${id}` 순서의 `timelineIds`로 작업 순서를 전달한다. 내부 reader의 timeline 배열을 그대로 JSON 직렬화하면 큰 답변을 두 번 보내게 되므로 새 경로도 이 serializer를 사용한다. 클라이언트 `expandTimeline`은 compact 응답과 이전 full timeline 응답을 모두 읽는다.

회귀 테스트: `history-preview.browser.test.ts`, `history-turns.test.ts`, `conversation-turns.test.ts`, `conversation-selection.browser.test.ts`, `terminal-conversation.browser.test.ts`, `mobile-control.browser.test.ts`, `mobile.browser.test.ts`, `terminal-control.test.ts`, `history.test.ts`, `claude-history.test.ts`, `claude-history-large.test.ts`, `mobile-conversation.test.ts`. 합성 파일·자체 HTTP 서버·숨긴 Electron 프로필만 사용한다. 실제 PC/iPhone 야간 네트워크 지속 검증과 격리 테스트 통과를 구분해 보고한다. 백엔드와 모바일 클라이언트 변경은 함께 배포하고 실제 사용자 프로세스는 강제 종료하지 않는다.

## 현재 기준

- 저장소: https://github.com/kimjongjip/Harbor.git
- 배포 기준: main. 사용자의 `Update-Harbor.cmd`는 현재 체크아웃의 upstream을 `git pull --ff-only`로 받는다. 일반 사용자는 기본 main을 유지한다.
- 버전: package.json이 제품 버전이며 1.0.0부터 공개 버전을 관리한다. CHANGELOG에 변경 사항을 기록한다.
- Windows x64 소스 설치가 현재 배포 방식이다. 1.12.0부터 실행 중인 PC에 접속하는 개인용 모바일 PWA를 제공한다. 자동 설치형 EXE, 코드 서명, 자동 업데이트, 독립 서버 런타임은 아직 제공하지 않는다.
- 제품 이름 Harbor는 '항구'라는 뜻이다. 여러 서버·세션이 모이는 작업 공간이라는 설명을 사용한다. 최초 작명 당시의 결정 근거는 확인되지 않았다.

## 개발 환경과 수정

1.15.4의 `ClaudeHistory.read`는 전체 JSONL 크기를 이유로 거부하거나 전체 파일을 메모리에 읽지 않는다. `claude-history-pages.ts`가 256KiB 단위로 뒤에서 읽고, 페이지 탐색과 개별 항목 크기를 제한한다. 원본 바이트를 합친 뒤 UTF-8을 해석하며, 파일 경계의 fingerprint와 고정된 읽기 끝 위치를 포함한 커서로 추가 기록 중에도 이전 페이지를 읽는다. 변경된 파일은 재조회하도록 안내한다. 개별 항목이 8MiB를 넘으면 원본을 보존하고 `HistoryDetail.notice`를 터미널·모바일·IDE까지 전달한다. 이전 페이지의 중복 ID가 이미 읽은 최신 내용을 덮어쓰면 안 된다.

화면과 서버 버전이 다른 업데이트 중에는 구버전의 정확한 Claude 16MB 제한 오류만 호환 처리한다. 해당 대화의 자동 재요청과 오류 배너를 중단하고 읽은 내용을 보존하되 수동 재시도는 허용한다. 다른 인증·연결·파일 오류까지 숨기지 않는다. 화면 적용만으로 실행 중인 구버전 서버의 기록 읽기 제한이 제거됐다고 보고하지 않는다.

모바일의 로컬 Windows AI 제출은 `MobileGateway`에서 붙여넣기와 Enter를 하나의 요청 영수증으로 처리한다. 간격 중 중복 요청은 같은 완료 결과를 기다리고 다른 입력은 거절한다. Enter 직전에 runtime·native session·기기 등록·제어권을 다시 확인하며, 일부만 전송된 실패를 자동으로 재실행하지 않는다. 실행 중인 백엔드에 파일 교체만으로 적용되지 않으므로 설치본 갱신과 실제 재시작 상태를 구분해 보고한다.

1.15.3의 기기 전환 수정은 `TerminalPane`에서 제어 상태와 입력·크기 조정을 연결한다. 제어권 거절을 포함한 Harbor WebSocket 오류를 PTY 출력처럼 `term.write`하지 않는다. 기존 제어 API의 명시적 인계와 서버 검증을 유지하고 거절된 키는 재생하지 않는다. `terminal-handoff.browser.test.ts`는 실제 제어권 객체와 합성 WebSocket으로 휴대폰 소유·PC 인계·출력 보존을 검증한다.

Mods의 dock은 PTY 전체 폭과 다른 `viewport.columns`를 보낼 수 있다. `TerminalTypeset`은 현재 화면 높이에 맞고 PTY 폭 이하인 본문 폭도 예약 마커가 생기기 전에 측정해야 한다. 폭이 다르다는 이유로 측정을 건너뛰면 높이 응답을 받지 못한 Claude가 계속 원문으로 표시된다. `terminal-rich-mods.browser.test.ts`에서 패널 열기·닫기와 영역 보존을 확인한다. 조판 선택 스크롤은 `rich-selection-scroll.ts`가 같은 답변 DOM의 읽기 위치를 움직이며 PTY 입력을 만들지 않는다. `rich-selection-scroll.browser.test.ts`에서 마우스를 누른 채 휠·경계 이동·새 출력 중 선택 보존을 검증한다.

1.15.2의 모바일 Mods 숨김은 `mobile/claude-mod-panels.ts`와 `MobileTerminalRich`의 클라이언트 표시 단계에서만 수행한다. 실제 Claude Code 2.1.295의 격리된 dock/inline/AbovePrompt 화면에서 확인한 표준 패널 경계와 입력창을 함께 검증한다. 원본 xterm 버퍼·PTY 입력·resize·데스크톱 출력은 변경하지 않는다. 불완전한 프레임·승인 대기·알 수 없는 레이아웃은 원본을 유지하며, frozen 화면에는 원본과 잘라 표시할 행을 함께 보존한다. `mobile-mod-panels.test.ts`와 `mobile-mods.browser.test.ts`로 Unicode·패널 인식·원본 복귀·원본 버퍼 보존을 검증한다.

1.14.0의 PC IDE는 기존 Harbor 사이드바를 숨기고 탐색기·Monaco·오른쪽 AI 대화·접는 터미널 dock을 구성한다. TerminalWorkspace는 모드/패널 전환 중 재마운트하지 않는다. 모바일 entry는 그대로다. EditorFiles의 root는 실제 `~`이며 cwd는 문맥 메타데이터다. cd만으로 저장 바인딩을 깨지 않지만 host/runtime/native session 교체는 계속 검증한다. UTF-8/UTF-16 BOM과 명시적 CP949는 원래 바이트 형식을 유지하고 손실 인코딩은 거절한다. `iconv-lite`는 고정된 직접 의존성이다.

1.15.0부터 IDE AI는 `IdeChats`와 `/api/ide-chat`, paired desktop의 `/desktop-api/ide-chat`를 사용한다. 기존 PTY 기반 `IdeConversations`는 호환 테스트용 코드이며 production index에 마운트하지 않는다. Codex는 Hub app-server의 thread/start·resume·turn/start·approval, Claude는 고정된 `@anthropic-ai/claude-agent-sdk/core`와 설치된 CLI로 실행한다. SSH Claude는 PTY 없는 전용 exec 채널을 사용하며 로컬 환경변수/인증을 원격으로 복사하지 않는다. 서버의 기존 로그인·설정을 사용한다.

새 대화 생성은 첫 전송 때만 한다. 읽기 전후 및 실행 직전 기기 권한·runtime·네이티브 ID를 확인한다. 1.15.1부터 열린 CLI는 `IdeLiveChats`로 기록·상태를 연결하며 Hub/SDK로 다시 시작하지 않는다. 기존 프로세스에는 Codex FIFO 또는 실제 활성 Claude 채널로만 전송하고 PTY fallback을 제공하지 않는다. 같은 native ID의 두 번째 writer는 계속 금지한다. 기존 CLI 승인·중단은 해당 터미널에 남긴다.

관리형 메시지는 직렬화와 요청 ID 영수증으로 중복을 막으며 raw terminal 제어권과 분리한다. live 연결의 입력은 반대로 원래 터미널 제어권을 검증한다. 읽기·연결은 제어권을 가져오지 않으며 모바일 kind는 IDE API에 접근할 수 없다. 실행 승인은 Codex on-request와 Claude default를 유지한다. 기록 목록에는 appServer 생성 기록도 포함한다. Harbor 재시작 뒤에는 원래 네이티브 기록에서 재개한다. 메모리 초안과 실행 중 관리형 엔진을 독립 데몬으로 설명하지 않는다.

MarkdownReading은 .md 기본 읽기/원문/나란히 보기, 목차·확대·문서 기준 상대경로를 제공한다. Monaco 모델과 충돌 검사를 재사용하고 저장 전 내용도 미리 본다. 로컬 Markdown은 기존 안전한 이미지/링크 경로를 사용한다. paired desktop은 로컬 API 토큰에 의존하지 않는 RemoteMarkdown을 주입한다. 문서 본문의 HTML은 실행하지 않는다. 원격 이미지는 아직 설명으로만 표시한다.

추가 회귀 검사: `ide-chat*.test.ts`, `ide-chat.browser.test.ts`, `ide.browser.test.ts`, `remote-desktop.browser.test.ts`와 기존 editor/mobile/control 검사. SDK·SSH·AI는 합성 런타임을 기본으로 사용하며 실제 사용자 세션에 테스트 질문을 보내지 않는다. 프로토콜 초기화만 검증할 때도 모델 prompt를 보내지 않는다. Windows CLI는 npm cmd/ps1 셸 문자열 실행 대신 실제 executable/cli.js 경로를 찾는다. 파일 테스트의 `~`는 반드시 격리된 임시 홈에 매핑한다.

1.13.0은 PC IDE와 paired desktop을 추가한다. Vite 입력은 기존 main/mobile과 `remote-desktop/index.html`이며 gateway의 `/desktop/`에서 제공한다. Monaco는 IDE 클릭 시만 불러오고 모바일 entry에는 포함하지 않는다. `/desktop-api/editor`는 기기 kind=desktop 및 작업 폴더 범위·저장 버전·세션 바인딩을 검증한다. 서버 발급 invite에 기기 종류를 넣고 클라이언트가 모바일 권한을 PC로 올릴 수 없게 한다. 원격 세션 생성/종료·호스트 관리 API는 제공하지 않는다.

protocol 4는 기기별 state projection과 terminal control lease를 추가한다. 30초 소유권을 10초마다 갱신하고, native session/runtime 변경·기기 폐기 시 무효화한다. 소유권 비밀값은 state에 내보내지 않으며 input·resize·파일 저장·인용에서 확인한다. 구 모바일 호환 입력은 소유자 없을 때만 허용하며 PC raw 입력/저장은 lease가 필수다. 화면은 기존 snapshot+구독 세대+큐 순서로 복원한다. 아직 offset resume 또는 독립 데몬이 구현된 것으로 설명하지 않는다.

TailscaleSetup은 로컬 인증된 `/api/mobile/setup`에만 연결한다. install/login은 사용자 버튼에서만 시작하며 고정 실행 파일·인수만 허용한다. 테스트에는 fake executor를 쓰고 개발 검증 중 실제 설치·재로그인·Serve/Funnel 설정 변경을 하지 않는다. 새 사용자는 상단 연결 설정의 설치/로그인 단계로 준비한다.

변경 검증: `editor-files`, `terminal-control`, `tailscale-setup`, `mobile-gateway` 서버 테스트와 `ide`, `ide.browser`, `remote-rich.browser`, `remote-desktop.browser`, `tailscale-setup.browser`, `mobile.browser` 클라이언트 테스트를 실행한다. 브라우저 테스트는 격리된 숨김 Electron·가상 터미널·임시 프로젝트를 사용한다. 원격 PC 검증 전 최신 dist를 빌드하고 테스트 실행 중 dist를 덮어쓰지 않는다. 기존 preview/완료 알림 회귀 검사도 유지한다.

1.12.8의 모바일 protocol 3은 인증된 `GET /mobile-api/terminals/:id/preview`를 제공한다. runtime·terminal·native session을 읽기 전후 검증하고 기기 해제도 다시 확인한다. 기기당 1개·전체 2개의 동시 snapshot, 8초 응답 제한, 2백만 글자 제한이며 실제 읽기가 끝나기 전 동시성 슬롯을 반환하지 않는다. UI는 목록의 한 후보·터치/포커스 대상을 준비하고 새 대상이면 이전 fetch를 취소한다. 준비된 화면은 15초 후 폐기하고 화면 출력만 사용한다. 별도 읽기가 기존 WS 구독을 교체하지 않으며, 미리보기 응답이 늦어도 최신 snapshot을 덮지 않는다. 입력 허용은 항상 실시간 snapshot 완료 기준이다. `mobile-preloader.test.ts`, `mobile-preview.test.ts`, `mobile.browser.test.ts`에서 경합·취소·인증·읽기 전용 미리보기와 기존 전환/스크롤을 검증한다.

답변 완료 알림은 `MobileCompletions`가 Codex `turn/completed(status=completed)`와 Claude `Stop`을 받는다. 단순 working→idle 추정은 사용하지 않는다. Claude Stop은 600ms 동안 Harbor continuation/도구 재개·실패·현재 세션을 확인하고 보류된 알림을 취소한다. 완료 식별자를 제한된 메모리에서 중복 제거하고 Web Push의 tag도 동일 완료에 맞춘다. `MobileAccess`는 등록한 각 기기에만 일반 문구·세션 링크를 전송한다. GET push는 해당 기기의 등록·최근 전송 상태만 반환하며 만료 응답이 새 구독을 삭제하지 않게 endpoint를 재검증한다. 푸시 서비스 수락과 실제 iPhone 표시를 혼동하지 않는다. 알림 설정·테스트는 사용자 클릭에서 권한 요청을 시작한다. `mobile-completion`, `mobile-notifications`, `mobile-worker` 테스트와 모바일 브라우저 검증은 모의 푸시를 사용하며 실제 기기 검증을 대체하지 않는다.

1.12.4의 `/mobile-api/terminals/:id/conversation`은 `MobileConversations`에서 현재 terminal/host/provider/session 연결을 조회 전후 검증한다. 휴대폰이 임의 host·파일·제공자를 지정할 수 없으며 기존 읽기 전용 History/ClaudeHistory를 사용하고 CLI resume/write는 하지 않는다. 동시 동일 페이지 요청을 병합하고 전체 읽기 동시성을 제한한다. `MobileConversation`은 겹치는 페이지를 메시지 ID로 합치며 위쪽 스크롤로 이전 페이지를 불러오고 DOM 기준 위치를 보존한다. 사용자 텍스트는 일반 문자열로, AI 답변은 Markdown으로 표시한다. 구버전 404는 질문을 추정하지 않고 기존 답변과 업데이트 안내로 처리한다. `mobile-conversation.test.ts`(서버/클라이언트), `mobile.browser.test.ts`에서 세션 교체·인증·읽기 순서·중복·스크롤·구버전 호환성을 확인한다. 터미널의 조판 흐름은 휴대폰 폭으로 제한하고 끝의 빈 셀만 제거하며 이전 출력은 버튼 없이 펼친다.

모바일은 `MobileGateway`의 별도 루프백 listener와 `MobileAccess` 기기 등록으로 제공한다. 기존 `/api/bootstrap` 토큰을 모바일에 전달하지 않는다. 4318만 Tailscale Serve 또는 명시적으로 선택한 Funnel에 연결하며 모바일은 저장한 HTTPS Host/Origin, HttpOnly Secure 쿠키, 변경 요청 헤더로 인증한다. 일회용 링크는 10분·기기 쿠키는 90일, 저장소에는 토큰 해시만 기록한다. VAPID 개인키·기기 구독을 포함한 `mobile-access.json`은 기존 비공개 데이터 폴더에만 저장하고 Git/패키지에 포함하지 않는다. 손상된 설정은 모바일만 비활성화하고 PC 서버 시작은 유지한다.

1.12.6의 `mode=private|funnel`은 기존 설정에서 private로 이행한다. Funnel 헤더는 명시적 funnel 모드에서만 HTTP/WS에 허용하며 기존 인증을 생략하지 않는다. 같은 origin의 방식 변경은 기기 등록을 유지한다. 유효한 일회용 코드는 공개 망의 잘못된 시도로 전역 등록이 잠기는 것을 피하도록 별도 허용하며 재사용·만료는 계속 거부한다. `MobileNetwork`는 desktop 토큰으로 보호된 `/api/mobile/network`에서만 사용한다. 고정된 execFile 인자, 숨김 프로세스, 제한 시간으로 PC 노드 주소와 실제 프록시 상태를 확인한다. HTTPS 443 루트가 비어 있거나 같은 모바일 루트 하나만 가리킬 때만 serve/funnel을 전환한다. 다른 서비스·하위 경로·포워딩이 있으면 변경하지 않는다. 자동 실행·앱 시작 시 공개 설정 변경은 없고, 설정 저장과 CLI 변경은 직렬화한다. 다른 포트·전역 reset은 다루지 않는다. 최초 계정 허용은 공식 Tailscale 링크로 안내한다. 구버전 백엔드에는 mode/API를 보내지 않고 정상 재실행을 안내한다.

`mobile-network.test.ts`, `mobile-funnel.test.ts`, `mobile-settings.browser.test.ts`는 CLI 대역과 격리된 게이트웨이·브라우저만 사용한다. 실제 사용자 Tailscale 설정이나 사용자 터미널을 테스트로 변경하지 않는다. 설치본 갱신과 실행 중 백엔드 갱신은 구분하며 옛 백엔드에 먼저 Funnel을 활성화하지 않는다.

Vite는 `index.html`과 `mobile/index.html`을 함께 빌드한다. 모바일 server는 빌드된 `dist/client/mobile`, 해시 assets/fonts만 제공한다. 개발 중에도 `npm run build` 후 모바일 서버에서 최신 산출물을 확인한다. 1.12.7부터 Service Worker는 **공개 앱 셸 HTML·JS·CSS·정적 리소스만** 캐시하며 API·대화·터미널 데이터·토큰은 저장하지 않는다. `scripts/set-version.mjs`는 Worker 캐시 버전도 갱신한다. 설치 시 HTML과 참조 파일이 모두 준비된 뒤 활성화하며 네트워크 없이 재시작할 때 앱 셸을 표시한다. 모바일 입력은 runtime/terminal/native-session/request ID에 묶고 불명확한 입력을 자동 재생하지 않는다. 모바일 WebSocket은 구독만 허용하며 PTY 크기를 변경하지 않는다. 파일은 32MB·동시 2건, 개별 임시 이름으로 업로드한다.

1.12.7: `/assets`의 공개 파일만 Brotli/gzip 압축·immutable 캐시, `/fonts`는 하루 캐시한다. HTML·Worker·API는 HTTP no-store를 유지한다. 휴대폰은 OS 기본 글꼴을 사용한다. 모바일 WebSocket의 permessage-deflate는 no-context-takeover·동시 압축 2개·level 3으로 제한한다. `state.protocol=2`를 확인한 클라이언트만 열린 연결을 재사용하며 `subscriptionId`로 이전 구독의 지연 프레임을 제외한다. 서버는 새 구독으로 이전 대기 snapshot을 대체하고 완료·오류를 세대별로 확인한다. 최초 상태는 인증된 WebSocket에서 받아 별도 HTTP 요청을 줄인다. `MobileScreenCache`는 runtime/terminal/native session 키와 크기 제한을 갖는 메모리 전용 미리보기이며 입력 가능 여부는 항상 최신 snapshot으로 결정한다. 구버전 서버는 기존 새 연결 방식을 사용한다.

성능 회귀 검증: `mobile-performance.test.ts`(정적 압축·API 비저장·구독 전환), `mobile-screen-cache.test.ts`(메모리 한도·대화 분리), `mobile-worker.test.ts`(공개 셸만 오프라인), `mobile.browser.test.ts`(열린 연결 재사용·최신 응답 지연 중 미리보기와 입력 차단). 로컬 캐시 화면 표시 시간과 실제 인터넷 최초 접속 시간은 구분해서 보고한다.

1.12.3의 `MobileTerminalRich`는 xterm의 로컬 버퍼를 모바일 문서 흐름으로 표시한다. `terminal-flow.ts`는 `richFragments`로 검증한 예약을 답변 하나로 치환하고 나머지는 공개 cell API로 색·공백·한글을 유지한다. 인증된 `/mobile-api/terminals/:id/answers` 원문만 Markdown으로 렌더링한다. 답변은 자연스러운 전체 높이이며 이후 네이티브 상태·입력줄도 그 아래로 이동한다. 1.12.2의 고정 높이 overlay+overflow:hidden은 긴 답변을 잘랐으므로 재사용하지 않는다. 1.12.5부터 조판 없는 작업 화면도 이 흐름을 사용한다. PC 레이아웃 ACK·PTY resize·ANSI 수정은 하지 않는다. 원문 조회는 겹치지 않는 5초 간격·전환 취소·대화 ID 확인을 사용한다. 재연결 중 마지막 표시를 유지하고 replay 중간 상태를 읽기 화면에 반영하지 않는다. `mobile-flow.test.ts`는 한글·색·반전·예약 사이 출력 보존을, `mobile.browser.test.ts`는 PC 예약보다 긴 답변의 마지막 문장과 이후 네이티브 상태 위치·스크롤·재연결을 검증한다.

1.12.5: 모든 네이티브 행을 휴대폰 폭으로 줄바꿈하며 순수 가로선만 CSS 한 줄로 표시한다. `onWriteParsed` 기반 갱신을 묶고 DEC 2026 동기화 출력 중간 화면은 건너뛴다. 위쪽 휠·터치를 받으면 브라우저 스크롤 전에 따라가기를 해제하고 현재 버퍼를 읽기용으로 보존한다. 소스 xterm은 출력을 계속 받지만 CLI의 전체 화면 재그리기가 보존된 내용을 덮지 않는다. 최신 이동은 보존을 해제한다. DOM 전환 후 Chromium의 연속 휠 대상 유지 문제를 피하려고 세로 휠은 이 읽기 영역의 scrollBy로 처리하며 터치는 브라우저 관성 스크롤을 유지한다. 최상단의 `MobileConversation`은 같은 스크롤 영역에 저장된 질문·답변을 붙이고 삽입 높이만큼 위치를 보정한다. 현재 조판 답변과 원문이 일치하면 그 이전까지만 표시하고, 일치 기준이 없으면 저장 기록과 현재 터미널의 경계를 표시한다. 실제 과거 native 도구 로그를 저장 대화에서 추정하지 않는다. 회귀 테스트는 조판 없는 코드·긴 경로·구분선·연속 전체 화면 재그리기 중 실제 연속 휠·터치 이동·보존 내용·최신 복귀·기록 페이지 연결을 포함한다.

`npx.cmd tsx --test src/server/mobile-gateway.test.ts src/client/mobile.browser.test.ts`로 인증·해제·재접속·순서·중복 방지·질문·파일·모바일 화면을 검증한다. 브라우저 테스트는 먼저 `npm run build`하고 실행한다. 별도 데이터·루프백 프록시·Electron 프로필·합성 출력만 사용한다. 이 테스트가 실제 Tailscale 망이나 iOS Safari/푸시 검증을 대신하지 않는다. 사용자 확인 순서는 [모바일 사용 안내](mobile-guide.md), 후속 범위는 [개발 계획](mobile-and-orca-plan.md)을 따른다.

1.12.2의 `mobile/terminal-viewport.ts`는 단일 외부 scroller를 xterm의 로컬 버퍼 행과 픽셀 위치에 연결한다. xterm의 PC 행·열은 유지하고 가상 높이와 `scrollToLine`만 조정한다. 화면 아래 미사용 빈 행을 제외하며 최신 위치 따라가기/읽기 위치 보존을 구분한다. 재접속 복원 동안 스크롤 상태 변경을 막고 원래 위치를 복구한다. 터치·휠은 네이티브 브라우저 스크롤로 처리하고 CLI 키 입력이나 원격 resize를 만들지 않는다. `visualViewport`는 키보드 높이·offset에만 사용한다. 테스트에는 긴 버퍼의 최초 하단 위치·휠·새 출력·재접속·새로고침·세션별 초안·검색·모의 키보드 크기 변경을 포함한다. 모의 visualViewport 검증을 실제 iPhone 키보드 검증으로 보고하지 않는다.

1.10.8의 `BackendSupervisor`는 데스크톱이 직접 실행한 자식의 exit 이벤트를 확인했을 때만 재실행한다. HTTP 응답 지연을 이유로 살아 있는 백엔드를 죽이지 않으며, 처음부터 별도로 실행된 웹 백엔드는 소유하지 않는다. 2분 안에 1·2·5초 대기로 최대 세 번 시도하고 실패 시 사용자 **연결 복구**를 제공한다. 정상 종료·초기 실행·복구 중의 중복 exit와 늦게 도착한 이전 자식 이벤트를 구분한다. 앱 종료 중에는 새 프로세스를 만들지 않는다. 프런트엔드에는 제한된 상태 조회·알림·복구 IPC만 노출하며 기존 trustedWindow 검사를 유지한다.

`runtime-events.jsonl`은 30초마다 숫자 메모리 사용량을 기록하고 `uncaughtExceptionMonitor`로 예외 종류와 server.mjs/node 내 위치만 남긴다. 정상 종료 요청과 process exit도 구분한다. 예외를 소비하지 않고 Node의 기본 종료를 유지하며 Error 원문·환경 변수·argv는 직렬화하지 않는다. `desktop-events.jsonl`의 실제 exit code/signal과 합쳐 OS 종료·치명적 오류·정상 종료를 구분한다. 로그는 각각 256KB·128KB 수준으로 제한한다. 기존 1.10.5에서 확인된 프로세스 소멸의 최초 트리거까지 해결됐다고 주장하지 않는다.

`npx.cmd tsx --test src/server/backend-supervisor.test.ts src/server/runtime-diagnostics.test.ts src/server/backend-recovery.browser.test.ts`로 별도 Electron 프로필·합성 HTTP 백엔드의 종료·같은 창 유지·반복 재시도 제한·수동 복구·정상 종료 시 재생성 방지 및 오류 로그의 비밀값 제외를 검증한다. 기존 사용자 앱과 SSH 작업을 종료해 테스트하지 않는다.

처음에는 사용자 안내의 Setup을 사용하거나 Node.js 24가 있는 개발 환경에서 `npm ci`를 실행한다. Setup이 설치한 Node를 현재 PowerShell에서 쓰려면:

```powershell
$env:PATH = "$(Join-Path $PWD '.runtime\node-v24.15.0-win-x64');$env:PATH"
```

이후 `node`, `npm.cmd`를 사용할 수 있다. Node 버전·해시를 올릴 때는 Setup과 데스크톱 런처의 경로도 함께 변경하고 새 클론에서 검증한다.

1. `git status`와 `git fetch origin`으로 현재 변경 및 원격을 확인한다.
2. `git switch main`, `git pull --ff-only` 후 필요하면 작업 브랜치를 만든다. 기존 사용자 변경을 버리지 않는다.
3. 수정 후 작업 규모에 맞는 테스트와 빌드를 수행한다. 실제 사용자 SSH·대화 기록 대신 합성 fixture를 사용한다.

## 연구실 구현과 검증

1.7.4의 기존 Claude 수신은 채널 시작 옵션을 사후에 주입하거나 CLI를 재시작하지 않는다. 서명된 `SessionStart`를 받은 일반 Claude에 `PeerRuntime.delivery=hook`을 부여하고 나중의 ordinary MCP `poll` 등록이 이를 덮어쓰지 않도록 한다. 채널 `automatic`은 별도 경로이며 훅과 중복 전달하지 않는다. UI에는 `connection=boundary`로 표시하고 입력 대기 중 받은 과제 확인 요청을 기존 `terminalDraft`로 추가한다. 네이티브 ID·bracketed paste·연결·작업 상태 검증, 입력 보존·Enter 미전송·복사 대체를 유지한다.

`UserPromptSubmit`·`PostToolUse`는 `additionalContext`, `Stop`은 새 메시지가 있을 때만 `decision=block`과 reason을 반환한다. Stop의 idle 갱신 후 scheduler를 동기 tick하여 현재 턴 동안 보류한 배정을 같은 훅 응답에 담는다. 현재 터미널·대화·연구실·지시 revision·단계·미제출 배정을 검사하고 일시정지·완료·삭제·변경된 대화는 제외한다. 최대 4개·JSON 본문 32,000자, HTTP 응답 finish에서 offered를 기록하며 실제 MCP read만 consumed이다. 동시 훅은 응답 중인 ID를 예약하고 offered 메시지를 반복하지 않는다. 네이티브 Stop 계속 진행 제한을 바꾸거나 영구적인 빈 inbox polling을 만들지 않는다. PermissionRequest·StopFailure·Notification·SessionEnd에 작업을 주입하지 않는다. annotation 실패 시 다른 메시지도 전달하지 않는다. 기존 실행에 훅이 없다면 사후 연결을 주장하지 않는다.

격리한 로컬 signed HTTP/MCP 테스트로 대화 경계·채널 중복·준비 단계·계획·일시정지·stale revision·실제 읽기/답장·인용 실패를 검증한다. 네이티브 Claude의 별도 CLI home·임시 프로젝트·loopback 모의 Anthropic 서버에서도 채널 플래그 없이 동일 PID·native session의 Stop 계속 진행과 다음 사용자 입력 수신, 기존 맥락·입력 초안 보존을 확인한다. 모의 응답 검증은 실제 모델의 자율적인 판단 품질이나 실제 SSH 계정 검증과 구분한다.

1.6의 `ResearchParticipant.settings`는 해당 참여자의 **실행 시 지정값**이다. `ResearchAgentSettings`의 모델 ID와 effort를 `/research/prepare`의 `agentSettings`, `/research/:id/start`의 `partnerSettings`로 받는다. 기존 `lab.effort`는 구버전 데이터·요청의 기본값으로 남기며 신규 선택값은 참여자별로 저장한다. `research-settings.ts`가 모델 ID와 제공자별 effort를 검증하고 단일 옵션 배열을 생성한다. Windows와 관리형 SSH의 셸 실행 코드가 이를 안전하게 인용한다. `TerminalInfo.researchSettings`에도 실행 기록을 남겨 기존 대화를 선택할 때 표시한다. 이 값은 현재 모델을 실시간으로 추적하거나 CLI의 사용 가능 여부를 보장하지 않는다. 새 터미널은 per-launch flags로만 지정하며 전역 설정을 수정하지 않는다. `owned` 참여자 재개에 저장한 설정을 사용하고, 구버전은 `lab.effort`로 대체한다. 기존 대화 참여에는 새로운 지정값 요청을 거부하여 무시된 선택을 적용됐다고 표시하지 않는다. 독립 설정·저장 복구·잘못된 입력·기존 대화 유지와 실제 프로세스 argv 경계 검증을 유지한다. 모델 실행 테스트는 별도 허락 없이 고비용 실제 AI 호출로 확장하지 않는다. [OpenAI 설정 안내](https://learn.chatgpt.com/docs/developer-settings), [Claude 모델 설정](https://code.claude.com/docs/en/model-config).

서버 목록과 터미널 탭의 종료 버튼은 `App`의 같은 `CloseTerminalDialog`를 사용한다. 목록의 선택 버튼과 종료 버튼은 별도 요소이며 X 클릭으로 대상 터미널을 선택하지 않는다. 확인 후 기존 `/terminals/:id/close`로 프로세스를 종료하고 상태 갱신으로 분할을 합친다. 확인 창은 숨겨진 워크스페이스 바깥에 렌더링하여 서버 관리 화면에서도 목록 종료를 사용할 수 있다. UI 확인과 실제 로컬 셸 검증은 전용 포트·데이터를 사용한다.

1.5.1의 사용자 인증 API `DELETE /research/:id`, `DELETE /research`의 `{ids: string[]}`는 연구실 기록을 개별·일괄 삭제한다. 일괄 요청은 명시한 최대 100개 ID만 처리하고 이미 삭제된 ID의 재시도는 허용한다. 삭제 전에 모든 대상의 등록된 실행 작업을 검사하여 소유 터미널이 살아 있으면 전체 요청을 거부한다. 종료된 소유 터미널의 오래된 작업은 정리할 수 있다. 연구실 상태를 먼저 저장한 뒤 `research.labId` 또는 `labId`가 일치하는 받은함 메시지를 일괄 제거하여 변경 이벤트가 다음 배정을 만들지 못하게 한다. 연구실 저장 실패는 메모리 상태도 되돌린다. 받은함 저장 실패 후에는 같은 ID로 재시도하여 남은 메시지를 정리할 수 있다. 네이티브 CLI 기록·터미널·프로젝트·worktree·내보낸 문서는 삭제하지 않는다. 이미 전달된 native 알림이나 명령은 취소되지 않는다. UI 확인 창은 대상 ID를 고정하고 실행 중 등록 작업을 안내한다. 삭제·재시작 복구·동일 대화 재참여·관련 메시지 제거·자원 예약·일괄 실패 시 보존을 회귀 테스트로 유지한다.

1.5부터 기본 흐름은 `/research/prepare`로 참여자 한 명의 `status=preparing`, `phase=preparation` 연구실을 만든다. 목표·기준은 비어 있어도 되고 준비 단계에는 scheduler 배정이 없다. 주 대화는 새 CLI 또는 선택한 기존 CLI 그대로다. `harbor_lab_plan`은 실제 주 대화 ID에 인증된 AI만 제안할 수 있고 저장만 한다. 사용자 UI의 `/proposal`은 revision을 검사한다. `/plan-request`는 기존 FIFO·Claude 채널로 계획 정리 요청만 전달하며 `assignmentId=preparation:<labId>`를 정식 배정과 구분한다.

1.7.1의 `ResearchLabView.planRequest`는 현재 주 대화 ID에 맞는 마지막 preparation 메시지에서 queued·offered·consumed를 읽고 실제 agent 제안이 해당 요청 이후 저장돼야 saved로 표시한다. UI 상태만으로 읽기나 저장을 조작하지 않는다. API의 반복 요청은 미확인된 같은 메시지 ID를 반환한다. Claude working 상태에서는 `PeerDelivery.events`가 preparation 메시지를 Stop까지 보류하여 도구 응답 안의 텍스트로 섞이지 않게 한다.

manual 연결의 계획 버튼은 요청 저장 후 사용자 동작으로 `terminalDraft`의 해당 창·터미널 편집기를 호출한다. 편집기는 현재 native ID·agentConnected·WebSocket 및 화면 준비·bracketed paste·작업 상태를 검증하고 xterm.paste로 기존 입력 뒤에 붙인다. Enter·입력 삭제·강제 CLI 재시작은 하지 않는다. 종료된 뷰의 등록 해제는 새 뷰의 편집기를 지우지 않는다. 입력 실패 시 요청문 복사를 제공한다. 계획 작성·저장에는 CLI 연결·대화 조회를 요구하지 않지만 실제 start의 원래 native 대화 검증은 유지한다. 계획·완료 기준과 시작 대기 사유, API 오류는 고정 버튼 영역에 표시하고 실패 시 초안을 보존한다. 공통 Modal은 React portal로 body에 표시한다.

계획 UI 검증은 격리한 데이터·포트·합성 대화와 실제 xterm 입력 경로를 사용한다. manual 입력의 대화 대상·중복 방지·Enter 미전송, 새로고침 상태, 기록 실패와 재조회, 연결 없이 계획 저장, 저장·CLI 실행 실패와 재시도, 모달 위치를 검사한다. 실제 사용자 CLI에 테스트 입력을 보내거나 비용이 드는 새 모델 추론·SSH 실험을 실행하지 않는다.

`/research/:id/start`만 공동 작업을 시작한다. 원래 주 대화 ID·서버·작업 완료 상태·계획 revision을 확인하고 `History` 또는 `ClaudeHistory`에서 최신 사용자·AI 텍스트를 읽는다. `researchConversation`은 도구·notice·숨겨진 추론을 제외하고 32,000자로 제한하며 페이지 생략을 표시한다. 읽기 실패·빈 맥락은 자동 무시하지 않는다. 사용자가 `manualContext=true`를 명시하고 직접 배경을 입력한 경우만 대체한다. 전달하는 기록은 reference context이고 새 권한이 아니다. start에는 중복 시작 잠금을 적용하고 실패 시 이번 요청이 만든 터미널만 닫는다. 주 대화는 교체하지 않고 추가 참여자 하나만 만든다. 코드 신규 추가 참여자는 단일 worktree를 준비하고 주 대화는 사용자가 선택한 현재 폴더를 유지한다. UI에서 이를 표시하고 완료 결과에서 변경 위치를 구분한다.

저장 스키마는 구버전 연구실과 준비 중 한 명의 연구실을 함께 읽는다. 준비 상태는 재시작 후 그대로 복구하고 공동 작업 상태만 일시정지한다. 준비 중 재연결은 원래 대화 한 개를 검증하고 삭제는 연구실 연결만 제거하며 터미널·CLI 기록은 보존한다. 실제 대화 공유, 제안 권한, 오래된 revision, 명시적 시작, 원격 참여자 서버 경계, 재시작·단일 재연결을 회귀 테스트로 유지한다. UI 검증은 격리된 포트·데이터·합성 기록을 사용하고 실제 사용자 터미널·SSH에 입력하지 않는다.

`ResearchLabs`는 `.data/research.json`에 과제·배정 ID·참여자별 서버 ID·네이티브 대화 ID·보고서·실험 기록·중간 결과를 원자적으로 저장한다. `AppState.researchLabs`로 모든 창에 현재 상태를 전달한다. 생성·재연결은 로컬과 관리형 SSH를 지원한다. 신규 쌍은 선택한 서버에서 만들고 기존 세션은 서로 다른 서버도 연결한다. 서버 경로에 Windows `resolve`를 적용하지 않으며 산출물·Markdown 링크·재연결·자원 예약은 참여자의 서버 기준으로 처리한다.

원격 작업 폴더는 SFTP로 canonical 경로를 확인한 뒤 SSH exec로 준비한다. Python 스크립트와 입력은 base64로 인코딩해 줄바꿈·셸 인용 문제가 없도록 전달한다. 구버전의 신규 쌍은 두 개, 준비 대화 이후의 신규 추가 참여자는 하나의 worktree를 선택한 서버의 깨끗한 Git HEAD에서 만들며 부분 실패 시 남은 worktree를 강제 삭제하지 않는다. 새 연구 터미널은 관리형 연결·역방향 TCP forwarding을 요구한다. 셸은 홈에서 시작하고 전용 CLI만 할당 폴더와 세션별 effort로 실행한다. 내보낸 결과는 로컬 데이터 파일이므로 응답의 hostId도 로컬로 반환한다.

각 단계의 배정은 기존 Mailbox의 `purpose=research`와 labId·assignmentId·revision으로 전달한다. 분석 보고서는 양측 제출 전까지 상대에게 공개하지 않으며, 구체적 비동기 질문은 초기 분석에도 허용한다. 보고서의 `peerQuestions`(최대 4개)와 구버전 `userQuestion`은 일반 질문으로 자동 전달한다. 초기 보고서 질문은 양측 제출 뒤 전달하여 독립 초기 판단을 보존한다. 인증된 AI 보고에 기반한 `author=agent`, `purpose=question`, labId와 `questionSource={assignmentId,index,revision}`을 Mailbox에 저장한다. 이 outbox와 동일 질문으로 재시작·tick 중복을 피하고 미답변 질문 한도에서 나중에 재시도한다. Codex는 기존 네이티브 FIFO, Claude는 개발 채널을 사용한다. Claude의 다음 배정과 자동 질문은 네이티브 Stop 이후 전달한다. CLI 입력 타이핑, Enter 전송, 기존 사용자 대화 복제 경로를 만들지 않는다.

인증된 MCP `harbor_lab_context`, `harbor_lab_report`, `harbor_lab_work`, `harbor_lab_artifact`가 실제 보고를 받는다. 보고서의 모든 완료 기준을 검증하고 중복 제출은 같은 결과만 허용한다. ready=true와 추가 작업·질문·사용자 결정을 동시에 제출하면 수정 요청을 반환한다. context에 현재 지시 버전의 실제 peerQuestions·답변·전달 상태와 userAnswers를 공유한다. 양측 검토가 준비되면 한 명에게 종합, 상대에게 최종 검토를 배정한다. 상대의 승인·모든 기준 충족·미완료 작업 및 미답변 질문 없음·결과 문서가 모두 있어야 completed가 된다. 토론 횟수로 완료시키지 않는다. 정체·실제 사용자 결정·연결 종료는 중간 결과를 보존하는 확인 요청 또는 일시정지다.

`userDecision={kind,question,reason,peerMessageId}`만 사용자 확인 요청을 만든다. kind는 scope-change·missing-information·external-approval이며 초기 분석에는 허용하지 않는다. 해당 보고자의 현재 원래 대화가 같은 연구실·지시 버전에서 상대에게 보낸 질문과 인증된 agent 답장 연결을 실제 Mailbox에서 검증한 뒤 `pendingDecision`을 저장한다. 직접 MCP 질문에는 labRevision을 저장하며 시각만 같은 예전 질문을 현재 지시의 검토로 인정하지 않는다. 전달·읽기 알림, UI 작성 답장, 다른 과제·대화의 답장은 증거가 아니다. 분류의 의미는 모델 지시로 정하며 서버가 자연어 내용까지 판정하지는 않는다. 일반 질문을 userQuestion으로 제출해도 중단하지 않는다.

Codex 입력 봉투와 Windows Node·SSH Python Claude 채널 봉투에는 일반 질문의 labId·지시 버전과 replyToId를 함께 전달한다. 받은 AI가 현재 과제 문맥을 읽어 질문에 답하고, 답장을 또 질문으로 취급해 회신 반복을 만들지 않도록 안내한다. 양쪽 Claude adapter의 실제 프로세스는 합성 루프백 서버로 검증하며 실제 SSH 계정을 사용하지 않는다.

UI의 답변은 `/research/:id/control`의 `action=answer`, directive, decisionAssignmentId로 전달한다. 오래된 질문 ID를 거부하고 `decisionAnswer`와 공유 지시에 저장한 뒤 revision·기존 보고서를 보존하여 현재 체크포인트에서 이어간다. pendingDecision을 답변 없이 resume으로 넘길 수 없다. 방향 변경 `resume+directive`는 여전히 새 revision의 분석이며 답변과 구분한다. 구버전의 userQuestion 중단은 재시작 때 일시정지로 이관하고 자동 재개하지 않는다.

작업은 각 CLI의 네이티브 도구에서 실행한다. `harbor_lab_work`는 실행 기능이 아니라 AI 보고 기록과 공유 자원 예약이다. 코드 신규 추가 세션은 깨끗한 Git HEAD를 기준으로 별도 worktree를 만들고 주 대화는 사용자가 선택한 폴더를 유지한다. 구버전 신규 쌍은 기존의 두 worktree를 유지한다. 원래 프로젝트 병합은 연구실 완료 조건과 구분한다. `harbor_lab_artifact`는 실제 작업에 등록된 텍스트 파일만 참여자의 작업 폴더 경계·realpath·네이티브 대화 ID를 확인한 뒤 제한된 페이지와 SHA-256으로 읽는다. 실행 성공을 증명하는 도구로 설명하지 않는다.

해당 사용자가 시작한 활성 연구실의 데이터 도구·참여자 사이의 질문·답장만 PermissionRequest 훅의 과제 범위로 처리한다. 다른 MCP, 네이티브 명령·파일·보안 승인은 자동 승인하지 않는다. 새 연구 세션의 낮은 effort는 실행 옵션으로만 전달하며 기존 세션과 전역 설정을 변경하지 않는다. 앱 재시작은 자동 재개하지 않고 동일한 대화 ID 재연결 후 사용자가 계속한다.

Codex 0.162.0의 새 대화는 첫 turn 전까지 rollout이 없을 수 있다. `thread/resume`의 특정 no-rollout 거절에서만 `thread/loaded/list`로 같은 ID가 실제로 로드됐는지 확인하고 최초 요청을 FIFO에 넣는다. 다른 거절은 이 경로로 우회하지 않는다. 저장이 생기면 재구독하며 불명확한 enqueue 결과를 중복 전송하지 않는다.

기본 테스트는 `research-lab.test.ts`, `research-workspaces.test.ts`, `codex-peer-runtime.test.ts`와 기존 전체 테스트를 사용한다. 완료/반려, 긴 반복, 일시정지, stale 보고, 대화 변경, 자원 예약, 실제 산출물 경계, 재시작과 원래 Git 폴더 보존을 검증한다. 실제 CLI 검증은 사용자가 이번 작업에서 명시적으로 허용했으므로 별도 데이터 폴더·포트·임시 로컬 프로젝트에서 낮은 effort로만 실행했다. 기존 사용자 세션과 SSH 서버에는 테스트 입력을 보내지 않는다. 실험 기록·모델 응답·테스트 스크립트는 Git 제외 경로에 둔다. 이 컴퓨터의 Codex Windows 샌드박스 오류는 별도 제약으로 기록하며 설정 우회나 사용자 프로세스 종료로 해결하지 않는다.

SSH 기능 회귀 검증도 사용자 서버에 접속하지 않고 합성 SFTP·서버 메타데이터와 로컬 Bash의 가짜 CLI를 사용한다. `HARBOR_TEST_PYTHON`에 로컬 Python 실행 파일 경로를 지정하면 원격 준비 명령을 로컬 Bash에서 실제 실행해 독립 worktree와 dirty Git 거부를 검증한다. 테스트의 Windows Git 경로만 POSIX 형태로 변환한다. 이 검증을 실제 사용자 원격 연결 성공으로 보고하지 않는다.

## 장기 SSH 세션과 연결 진단

**1.9.0 변경:** 새 터미널은 `ephemeralRemote`로 직접 SSH를 사용하는 것이 기본이다. 새 터미널 창에서 SSH 서버를 고르면 `sshSessionMode`를 `direct`(기본) 또는 `tmux`로 선택할 수 있으며 `/terminals`가 enum으로 검증해 `Terminals.create`에 전달한다. 선택은 해당 생성에만 적용하고 다이얼로그를 다시 열거나 서버를 바꾸면 direct로 초기화한다. 로컬의 tmux 요청은 서버에서도 거부한다. 기록 재개·연구실은 기존대로 direct이며 tmux 요청은 새로운 선택 UI에서만 명시한다. 기존 `durable-terminals.json`의 복구·종료를 보존하고 실행 중 프로세스를 전환하지 않는다. durable 회귀 테스트도 tmux를 명시적으로 요청한다.

직접 SSH는 원격 `exit` 상태와 전송 오류를 분리한다. exit를 받지 않은 close/error는 성공 코드 0으로 만들지 않고 -1·종료 상태 미확인으로 표시한다. 채널 오류와 connection 오류·close는 idempotent하게 정리하고 X는 원격 상태 조회를 기다리지 않고 해당 직접 연결을 닫는다. 진단에는 허용된 `code`·`level`과 `source`만 기록하며 원문 메시지는 저장하지 않는다. `direct-ssh.test.ts`에서 실제 loopback SSH 전송, 일반 연결의 tmux 미사용, 정상 종료와 단절의 구분, 한 번의 종료 이벤트, 닫기, Harbor 훅 유지, forwarding 없는 연구 거부, 비밀값 미기록을 검사한다. 15초·3회 keepalive 설정은 기존대로 두며 PC 절전이나 과거 밤샘 끊김의 원인을 검증 없이 확정하지 않는다. 아래 tmux 설명은 기존 유지 세션의 호환 경로에 해당한다.

`terminals.ts`는 tmux를 명시한 새 SSH 터미널에서만 `tmux`·`bash`를 검사하고 `durable-ssh.ts`의 전용 tmux 소켓·세션으로 셸을 한 번 시작한다. 사용자의 기본 tmux 서버·설정을 바꾸지 않으며 상태 표시줄·tmux 접두키를 끄고 마우스 전달을 설정한다. 유지 기능은 기존 일반 SSH 프로세스를 옮기지 않는다. tmux·bash가 없거나 관리형 SSH 연결이 실패하면 생성 실패를 표시하며 일반 OpenSSH·비유지 셸로 조용히 대체하지 않는다. 사용자가 일반 SSH를 다시 선택할 수 있다. 원격 연구실의 관리형 SSH·TCP forwarding 조건은 그대로 유지한다.

`TerminalInfo.connectionState`는 connecting/connected/reconnecting/disconnected/exited를 구분한다. 전송 연결의 오류·close는 유지 세션의 exit로 바꾸지 않는다. 재연결은 1초부터 최대 30초 간격으로 기존 tmux 세션에만 attach하고 입력을 대기열에 저장하거나 자동 재전송하지 않는다. 원격 pane의 실제 종료 상태를 15초 간격으로 확인하여 exit code를 별도로 전달한다. 인증 실패·원격 세션 누락·서버 대상 변경은 자동 새 CLI 실행으로 우회하지 않는다. `POST /terminals/:id/reconnect`는 이번 연결의 비밀번호를 선택적으로 받으며 저장된 인증·SSH 키도 사용할 수 있다. 마지막으로 성공한 비밀번호는 해당 터미널 수명 동안만 메모리에 보관한다.

`new Terminals({directory:store.directory})`에 recovery의 현재 host 목록·자격 증명 조회를 연결하고, bridge 준비 후 `restore()`를 호출한다. `durable-terminals.json`은 터미널 정보, 대상 fingerprint, 전용 tmux 소켓·세션 ID와 고정 역방향 포트만 저장한다. 비밀번호·훅 토큰·Codex endpoint capability는 여기에 넣지 않는다. 삭제·변경된 서버 대상의 기록도 목록에서 사라지게 하지 않고 연결을 보류한다. 로컬·일반 SSH 세션은 앱 종료 후 복구 목록에 넣지 않는다.

Harbor MCP·훅의 역방향 포트는 재연결 때 처음 포트를 다시 바인딩한다. 같은 프로세스 환경의 URL을 바꿀 수 없으므로 포트 충돌·forwarding 거절에서 다른 포트로 조용히 바꾸지 않는다. bridge 토큰·훅 토큰과 Codex app-server endpoint는 원격의 사용자 전용 tmux 세션 환경에 보관한다. 초기 Bash 스크립트와 tmux 환경 설정은 인증된 SSH stdin으로 보내며, 토큰을 프로세스 argv에 넣지 않도록 mode 600 임시 설정 파일을 읽고 삭제한다. 재시작 시 같은 세션 환경에서 인증 정보를 읽어 `AgentBridge.restore()`로 기존 capability hash를 복구한다. 기존 토큰이 있으면 교체를 거부하며, `peer-runtime-restored`는 기존 Codex endpoint 또는 저장된 Claude 네이티브 연결 정보를 다시 등록한다. 전송 단절만으로 `bridge.revoke()`를 호출하지 않는다.

앱 shutdown은 유지 SSH에서 detach하고 기록을 남긴다. 터미널 X의 `close()`는 정확한 tmux 세션을 kill한 뒤 목록·capability·인용을 제거한다. 시작 중 X를 누르면 하나의 launch가 끝난 뒤 종료하여 늦게 생긴 작업이 숨지 않게 한다. 종료를 확인하지 못하면 오류와 목록을 보존한다. `close()`는 Promise이므로 API와 오류 정리 경로에서 await/catch해야 한다. 서버 재부팅·외부 kill 뒤 같은 PID 복구를 약속하지 않으며 다른 컴퓨터의 공통 세션 서비스도 제공하지 않는다. 연구실 스케줄러는 앱 재시작 후 기존처럼 일시정지하며, 살아 있는 참여자 프로세스 복구와 자동 과제 재개를 구분한다.

`TerminalAnnotations(directory)`의 `terminal-annotations.json`에는 인용 원문·주석·출처, 네이티브 대화 ID, submitted 상태와 전역 번호 상한을 별도로 보관한다. 진단 로그와 구분되는 개인 데이터이며 Git·배포물에서 제외한다. 종료된 터미널은 revoke/retain으로 정리하되 번호를 재사용하지 않는다. 잘못된 snapshot을 자동 초기화해 이전 `[#1 annotation]`을 새 선택문에 연결하지 않는다. `AgentBridge`에 이 저장소를 주입하고 터미널 restore 후 현재 ID만 retain한다. 복구한 AI의 연결 상태와 인용 준비를 원래 네이티브 ID에 다시 연결한다.

`terminal-disconnects.jsonl`은 최대 약 256KiB의 제한된 진단으로 시각, 터미널 ID, 오류 분류, 재시도 번호와 연결 상태만 저장한다. 원문 오류 메시지·명령·답변·주소·토큰은 넣지 않는다. Electron powerMonitor의 suspend/resume는 `Terminals.powerEvent()`로 전달하고 resume은 연결이 끊긴 유지 세션의 복구를 즉시 재시도한다. 진단이 없는 과거 Compiler 종료의 원인을 새 코드만으로 확정하지 않는다.

검증은 `durable-ssh.test.ts`, `terminal-annotations.test.ts`, 기존 shell/startup 테스트를 사용한다. 격리한 실제 루프백 ssh2 전송과 모의 tmux 명령 실행기로 같은 합성 프로세스 PID·네이티브 대화 ID·고정 포트·MCP/훅 인증의 전송 단절·백엔드 재시작 복구, 입력 중복 방지, 정상 exit, 포트 충돌, 세션 누락, 명시적 종료 실패, 전원 복귀, 원래 인용·주석·번호를 확인한다. 실제 `AgentBridge` HTTP 인증을 사용하고 잘못된 토큰·다른 대화의 인용을 거부한다. Git Bash에서는 비밀값이 tmux argv에 없고 임시 파일이 정리되는 것도 확인한다. **실제 Linux tmux·Compiler 서버에서의 장시간 실행 검증은 하지 않았다.** 사용자 서버·실행 중 세션·모델에 테스트 입력을 보내지 않으며 이 한계를 설치본 결과와 함께 보고한다.

1.9.0의 추가 검증에서는 개인 데이터·프로필·포트를 격리한 데스크톱과 두 SSH 서버의 별도 테스트 셸로 선택 UI → tmux 생성 → 앱 종료 → 동일 PID 복원 → X 종료를 확인했다. X 뒤 해당 tmux 서버와 pane 셸 프로세스가 없어지고 복구 목록도 제거되는지 검사했다. 일반 SSH 기본값, 서버 변경 시 초기화, 로컬 옵션 숨김, 잘못된 API 값 거부, 종료 취소도 확인한다. 실제 사용자 세션에는 입력하지 않으며 AI 모델 호출은 없다. 이 검증은 밤사이 연속 실행의 안정성을 보증하는 테스트가 아니다.

## 터미널 분할과 시작용 셸

1.9.1의 `CodexHistory`는 Codex·Claude 공통 `sshSessionMode` 선택을 제공한다. 버튼과 `application/x-harbor-history` 드래그 데이터, `harbor-history-drop` 이벤트에 모두 전달하며 `/history/:threadId/resume`이 enum을 검증한다. `HistoryResumer`는 host·provider·native thread ID로 이미 열린 터미널과 진행 중 생성 요청을 재사용한다. mode를 중복 방지 키에 넣지 않아 같은 대화의 두 writer를 만들지 않으며 열린 프로세스를 전환하지 않는다. 미지원 tmux는 실패를 표시하고 재시도 시 pending 항목을 해제한다. 연구실의 기본 연결은 계속 일반 SSH다. `history-resume.test.ts`에서 선택 전달, 원래 대화 ID·Claude 작업 폴더, 동시 요청·기존 연결 유지·실패 후 재시도를 검증한다.

`terminal-tree.ts`는 leaf(세션 ID)와 split(축·비율·두 하위 창)으로 배치를 저장한다. 중심 드롭은 교체·자리 교환, 가장자리 드롭은 해당 창 또는 전체 트리의 분할이다. 숨겨진 탭을 자동으로 빈 창에 채우지 않는다. 닫힌 창은 트리에서 제거하고 단일 가지를 합친다. `harbor.terminalTree`에 저장하며 예전 `harbor.terminalPanes`를 한 번 읽어 전환한다.

터미널 컴포넌트는 고정된 루트에 ID 키로 유지하고 위치만 변경한다. 분할·교환 때문에 xterm과 WebSocket을 다시 만들지 않는다. `TerminalSplitHandle`은 분할선 및 교차점의 여러 비율을 함께 갱신한다. 단위 테스트는 `terminal-tree.test.ts`; 격리된 브라우저 fixture에서 대화 기록 재개·드래그·3분할·부분 4분할·크기 조절·새로고침·닫기까지 확인한다.

자동 시작 셸만 `startupPlaceholder`를 표시한다. 첫 사용자 입력은 서버에서 표시를 제거한다. 보호된 `dismiss-startup` API는 미사용 셸만 닫으며 기존 셸·AI 연결·입력한 셸은 유지한다. 시작 요청보다 늦게 도착한 응답이 사용자 대화 선택을 덮어쓰지 않도록 선택 요청 세대와 최신 터미널 목록을 확인한다. `terminal-startup.test.ts`에서 삭제 경계를 검증한다.

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

## 네이티브 세션 간 질문·답장 구현

1.1.0의 메시지 경로는 터미널별 MCP 인증 → `PeerDelivery` → `Mailbox` → 수신 CLI → 인증된 `harbor_reply` → 송신 CLI다. UI 전송과 실제 AI 도구 전송의 작성자를 구분한다. 세션 이름이 모호하면 임의로 첫 세션을 선택하지 않는다. `harbor_ask`는 최대 50초 동안 실제 답장을 기다리고 대기 중이면 원래 요청 ID를 반환한다. `harbor_ask_result`는 해당 네이티브 대화가 보낸 질문만 조회한다. 서로 질문을 기다리는 경우 추가 대기를 피하고 ID를 반환한다.

`/bridge/peers`는 별도 루프백 bridge listener에만 등록하며 기존 터미널별 MCP bearer 인증과 외부 Origin 차단을 사용한다. `/runtime`은 네이티브 대화·상태·전달 능력을 등록한다. Codex app-server 포트와 capability token은 콜백에서만 사용하고 UI·지속 저장소·오류 메시지로 보내지 않는다. `/events`는 최대 25초 동안 대화 ID가 일치하는 미전달 메시지를 기다린다. `/ack`는 `offeredAt`만 기록하며 실제 모델 확인으로 표시하지 않는다. `consumedAt`은 수신자의 MCP 도구 확인에서만 기록한다. 동기 답변 도구가 기다리는 동안 해당 답장을 별도 네이티브 턴에도 전달하면 안 된다.

Codex의 관리형 셸 함수는 일반 대화·resume 실행에만 전용 app-server를 만들고 원래 TUI를 `--remote`로 연결한다. help/version/exec 등 명령은 일반 CLI 경로를 유지한다. `CodexPeerRuntime`은 해당 터미널의 로컬 루프백 또는 기존 SSH 연결의 `forwardOut`으로만 붙는다. CLI 0.160.1의 `thread/queue/add`와 고정 `clientUserMessageId`로 입력을 넣는다. 직접 PTY 입력·Enter·turn/steer로 사용자의 작성 내용을 제출하지 않는다. 네이티브 입력 항목이 시작된 뒤에만 전송 확인을 기록한다. 네이티브 주 대화만 관찰하고 부모가 있는 하위 에이전트·임시 제목 생성 대화는 제외한다. 상속된 하위 에이전트 훅이나 반복 MCP 연결이 주 대화의 인용·메시지 바인딩을 덮어쓰지 않도록 한다. 외부 controller는 실행 승인 요청에 응답하지 않으며 원래 TUI가 처리한다.

PowerShell의 큰 시작 스크립트는 환경 변수 여러 조각으로 나누고 짧은 loader에서 합친다. 모든 조각을 CLI 실행 전에 제거한다. app-server의 토큰 원문은 환경과 인증된 등록 요청에만 사용하고 명령행에는 해시만 넣는다. 원격 셸의 Python 표준 라이브러리 helper는 해당 실행의 backend와 TUI만 관리한다. 셸 시작 경로 `~`, 사용자 CLI 옵션·설정, 인용 훅과 실행 승인 규칙을 보존한다. 전용 프로세스가 종료되면 capability를 폐기하며, 연결 중 닫힌 터미널이나 이전 실행의 늦은 실패가 새 실행을 복구·변경하지 않도록 세대 번호를 검사한다.

Claude의 per-launch stdio MCP adapter는 Windows에서는 포함된 Node 실행 파일, 관리형 SSH에서는 `python3`를 사용한다. 일반 `claude`도 동일한 메시지 도구를 받는다. `--harbor-peers`를 명시한 대화에서만 개발 채널 플래그와 `claude/channel` capability를 추가한다. `--mcp-config`와 개발 채널 플래그는 가변 인수를 받으므로 고정 `--settings` 옵션을 그 뒤에 배치하여 사용자 프롬프트를 파일명으로 소비하지 않게 한다. 훅에서 전달한 SessionStart ID로만 바인딩하며 adapter의 capability 보고가 현재 working/waiting 상태를 idle로 덮어쓰거나 종료된 대화를 다시 살리지 않는다. 채널 stdout 기록만으로 Claude의 실제 채널 허용·모델 확인을 판단하지 않는다. UI는 이를 ‘채널 수신 요청’으로 표시한다.

WebSocket·네이티브 queue API와 Claude 개발 채널은 실험적 기능이다. Claude 계정·조직 정책이 채널을 막으면 Harbor가 허용 목록이나 승인 규칙을 우회하지 않는다. 일반 받은함 도구가 대체 경로다. [Codex app-server 공식 문서](https://learn.chatgpt.com/docs/app-server), [Claude 채널 공식 문서](https://code.claude.com/docs/en/channels-reference).

Claude SessionStart는 HTTP 훅을 지원하지 않으므로 해당 실행의 명령 훅에서 같은 hook capability로 POST한다. Windows는 encoded PowerShell, 원격은 Python 표준 라이브러리를 사용한다. UserPromptSubmit·Stop·승인 등 지원되는 이벤트는 HTTP 훅을 유지한다. 실제 Claude 2.1.258에서 명령 SessionStart → 기존 대화 → MCP 읽기·답장 경로를 확인했다. 훅 종류를 바꿀 때 합성 HTTP 이벤트만으로 검증을 끝내지 않는다. [Claude 훅 이벤트 공식 문서](https://code.claude.com/docs/en/hooks).

강제로 PTY를 종료해도 Windows의 KillOnJobClose job이 해당 실행의 app-server를 종료한다. Linux는 helper의 SIGHUP/SIGTERM 정리와 backend의 parent-death signal을 사용한다. 다른 원격 운영체제는 관리형 Codex 자동 수신 대신 받은함 방식을 사용한다. 실제 검증은 Windows 네이티브 CLI에서 수행했으며 SSH adapter의 준비와 실제 사용자 SSH 검증을 혼동하지 않는다. CLI가 실행한 도구 호출은 확인했지만, 모의 모델 검증이므로 실제 모델의 자연어 도구 선택 품질은 평가하지 않았다.

기본 회귀 검증은 `mailbox.test.ts`, `peer-delivery.test.ts`, `codex-peer-runtime.test.ts`, `claude-peer-channel.test.ts`, `claude-hooks.test.ts`, `terminal-shell.test.ts`, `peer-status.test.ts` 및 기존 인용 테스트다. 실제 CLI 검증은 격리한 CLI 홈·작업 폴더·합성 대화·루프백 모의 모델만 사용한다. 실제 SSH나 사용자 대화에 테스트 요청을 보내지 않는다. mock 모델이 생성한 도구 호출을 실제 CLI가 실행한 사실과, 실제 모델이 자연어 요청에서 자율적으로 도구를 선택한 사실을 구분해서 보고한다. CLI 자동 수신·문맥 유지·입력 보존·작업 중 대기·승인 소유권을 별도로 확인한다. Claude의 mock 자격 증명은 실제 계정의 채널 허용 여부를 검증하지 못한다.

## 파일 미리보기의 창 크기와 경로 해석

1.7.5의 `Modal`은 portal의 실제 `modal-backdrop`에 선택적인 `backdropClassName`·`backdropStyle`을 적용한다. `ResourcePreview`가 미리보기 전용 클래스와 CSS 크기 변수를 여기로 전달하며, React 부모의 DOM 상속에 의존하지 않는다. 독립 창은 100vw·100dvh와 flex로 채우고 본창 fallback만 저장된 미리보기 크기·크기 조절을 사용한다. 일반 입력 대화상자의 portal·초점·키보드 동작은 유지한다.

`Files.preview`는 정확한 요청 경로의 stat이 ENOENT·ENOTDIR·SFTP code 2일 때만 보정한다. 절대·홈 경로와 점 경로 요소는 보정하지 않는다. 현재 폴더부터 최대 16개 상위 디렉터리의 `.git` 디렉터리 또는 worktree 포인터 파일로 가장 가까운 저장소를 찾고 루트 기준 같은 파일을 확인한다. 루트가 없거나 해당 파일이 없다면 현재 폴더 basename과 요청의 첫 폴더가 같은 한 단계 중복만 확인한다. 저장소 경계는 넘지 않고 권한 오류는 그대로 전달한다. 현재 폴더의 실제 파일이 항상 우선하며 다운로드·업로드·일반 경로 해석에는 이 보정을 적용하지 않는다. 성공 응답의 `resolvedFrom`으로 UI 기준 폴더를 갱신하고 이후 문서 내 링크는 실제 `data.path`의 부모를 기준으로 연다.

검증은 합성 로컬 파일과 모의 SFTP로 현재 경로 우선·프로젝트 루트·worktree·중복 폴더·명시적 경로 보존·권한 오류를 확인한다. 격리된 데이터·포트·프로필의 Electron에서 실제 Ctrl+클릭, 독립 창의 전체 영역·창 크기 변경·내부 스크롤·Ctrl+휠·중첩 문서 링크, 본창 fallback의 크기 조절과 일반 입력 대화상자를 검증한다. 사용자 앱·터미널·SSH에는 테스트 입력을 보내지 않는다.

## 폴더 전체 업로드와 탐색기 오류

1.7.6의 `useFileDrop`은 drop 이벤트 안에서 네이티브 entry를 즉시 캡처하고 비동기로 하위 폴더를 읽는다. directory reader가 빈 배열을 반환할 때까지 모든 배치를 읽어 100개 이후 파일도 포함한다. `UploadSelection`은 원본 File과 상대경로, 빈 폴더 목록을 별도로 보관한다. 폴더 선택기의 `webkitRelativePath`도 같은 계획으로 변환한다. 드롭 당시 서버와 대상 폴더를 고정하며 화면 전환 중인 오래된 탐색 결과는 적용하지 않는다.

인증된 POST `/files/upload-plan`은 대상 경로·폴더 목록·파일별 상대경로와 크기를 검증한다. 파일/폴더 합계 10,000개·파일당 512MB·목록 JSON 1MB, 상대경로 4096자·128단계 이내다. 절대경로·점 경로·제어문자·중복·부모 누락을 거부하고 선택한 대상 폴더를 canonical 경로로 확인한다. 모든 최상위 이름의 충돌을 lstat으로 확인한 뒤 새 폴더만 부모부터 만든다. 기존 폴더와 병합하지 않으며 새 파일은 기존 upload의 wx 생성으로 보호한다. 로컬은 네이티브 경로, SSH는 POSIX/SFTP를 사용하고 셸 명령을 실행하지 않는다. 준비 단계 실패·클라이언트 중단은 이 요청이 만든 빈 폴더만 역순 rmdir으로 정리한다. 파일 전송이 시작된 뒤에는 완료한 파일·폴더를 보존한다.

탐색기와 넓은 파일 화면은 동일한 업로드 계획을 사용하고 파일별 진행·실패·취소를 표시한다. 업로드 오류가 폴더 재조회 성공 때문에 지워지지 않도록 하며, `SSH_AUTH_REQUIRED` 또는 실제 인증 실패에만 인증 버튼을 표시한다. 일반 권한·파일 충돌·잘못된 드롭·만료된 웹 토큰은 SSH 재인증으로 안내하지 않는다. 숨김 항목만 있는 디렉터리도 빈 화면 대신 숨김 파일 설정을 안내한다.

검증은 합성 entry의 다중 배치·빈 폴더·숨김 파일·파일 읽기 실패, 로컬 업로드의 실제 바이트·충돌 사전 확인·잘못된 경로·취소, 모의 SFTP의 POSIX 경로·새 폴더 정리를 포함한다. 별도의 데이터·프로필·포트에서 Electron 네이티브 폴더 드롭과 폴더 선택기로 실제 테스트 파일을 전송하고 두 탐색 화면의 오류·인증 표시를 확인한다. 실제 사용자 서버·터미널에는 테스트 파일을 올리지 않는다.

## AI 실행 승인 기본값

1.11.1의 `AutoApproval`은 위 서버 기본값과 별도의 세션별 실시간 응답기다. UI 인증 PATCH `/api/terminals/:id/auto-approval` 또는 새 터미널 생성의 `autoApprove`만 활성화한다. MCP 도구로 설정할 수 없다. 현재 터미널의 `agentSessionId`와 인증된 네이티브 PermissionRequest의 session_id를 모두 확인한 뒤 `Requests.acceptAutomatically`로 allow 응답을 기록한다. 기존 훅 응답 경로가 이 결정을 소비해 CLI에 반환한다. 키 입력, 화면 문자열 탐지, CLI 실행 옵션 변경은 하지 않는다. 일반 질문·계획 도구·다른 터미널·이전 대화 요청은 제외한다.

응답은 `answeredBy=automatic`으로 저장하며 `consumed`는 훅이 응답을 읽었다는 뜻이다. 자동 수락 수는 실행 성공 수가 아니다. 저장 실패에서는 허용하지 않고 자동화를 끈다. 정책은 메모리에만 유지하며 대화 교체·터미널 종료·백엔드 재시작 시 해제한다. UI 새로고침은 유지한다. 오래된 네이티브 승인창이나 로그인/신뢰 등 훅이 제공하지 않는 확인은 자동 응답할 수 없다. 훅 제한은 분당 600회로 MCP 호출/메시지 발송 제한과 분리해 정상 도구 승인 연속 처리로 메시지 quota를 소모하지 않는다.

`npx.cmd tsx --test src/server/auto-approval.test.ts src/server/requests.test.ts src/server/claude-hooks.test.ts src/server/codex-peer-runtime.test.ts src/client/terminal-auto-approval.browser.test.ts src/client/cli-approval.browser.test.ts`로 양쪽 CLI의 인증된 HTTP 훅에 allow가 실제 반환되는지, 대기 요청·35회 연속 요청·켜기/끄기·옆 세션·질문·실패·대화 전환·브라우저 조작을 검증한다. 실제 사용자 작업이나 계정 호출 대신 합성 네이티브 훅 이벤트를 사용한다.

1.11.0의 `HostConfig.cliApprovalMode`는 선택적 `native | full-access`이며 없으면 기존 CLI 설정을 유지한다. UI 인증이 필요한 PATCH `/api/hosts/:id/cli-approval`만 명시적으로 값을 저장한다. 이 경로는 연결 설정 변경과 분리해 열린 터미널을 닫거나 자격 증명을 지우지 않는다. 에이전트 MCP·메시지·연구실 보고서에 이 설정을 변경하거나 승인 요청에 대신 답하는 도구를 추가하지 않는다.

`Terminals.create`는 호스트 설정을 복사하고 `TerminalInfo.cliApprovalMode`에 실행 당시 값을 보존한다. Windows PowerShell 및 관리형 SSH Bash의 Codex 래퍼는 `-c approval_policy="never" -c sandbox_mode="danger-full-access"`를 CLI와 관리형 app-server 양쪽에 전달한다. Claude 래퍼는 `--permission-mode bypassPermissions`를 전달한다. 명시적인 사용자의 CLI 옵션은 뒤에 유지한다. 전역 CLI 파일 변경, 승인 화면 키 입력, 이미 열린 세션·tmux의 모드 변경은 수행하지 않는다. 자동 설정을 적용할 수 없는 대체 셸 경로는 오류를 표시한다. 터미널 배지는 시작 설정이며 런타임 권한 관측값으로 해석하지 않는다.

`npx.cmd tsx --test src/server/cli-approval.test.ts src/server/terminal-shell.test.ts src/server/terminal-shell-peer.test.ts src/server/claude-hooks.test.ts src/server/codex-peer-runtime.test.ts src/client/cli-approval.browser.test.ts`로 저장·복원, 연결 보존, Windows/SSH 실제 argv, 이어가기, UI 명시적 저장·취소·오류와 기존 네이티브 승인 경계를 확인한다. 실제 사용자 CLI·서버에서 자동 승인 실험을 하지 않고 합성 실행 파일·격리 브라우저를 사용한다.

## PDF 미리보기와 탐색기 드롭

1.10.7의 HTML은 `Files.preview`의 별도 종류로 구분하고 `HtmlPreview`가 인증된 POST `/files/html`로 문서 폴더에만 유효한 URL을 받는다. `/html-preview/:capability/...`는 앱 토큰을 노출하지 않는 읽기 전용 GET/HEAD 경로이며 1시간·최대 64개 연결로 제한한다. 1.10.9부터 파일 크기 제한과 전체 Buffer 수집을 제거하고 `Files.htmlResource`가 검증된 경로·크기·지연 생성 읽기 스트림을 반환한다. 연결 생성과 HEAD는 본문을 읽지 않으며 GET은 `pipeline`으로 64KB 단위 backpressure·취소를 처리한다. 단일 Range는 206/Content-Range, 잘못된 범위는 416으로 응답한다. 원문 보기는 Range와 클라이언트 읽기 상한을 함께 사용해 서버가 Range를 무시하더라도 512KB에서 중단한다. 이 경로만 opaque frame의 Origin:null과 모듈·fetch용 CORS를 허용하고 기존 API의 출처·토큰 검사는 유지한다. MIME 허용 목록과 realpath로 상위 폴더·숨김 경로·symlink 이탈을 막는다. iframe 및 HTTP CSP 모두 `sandbox allow-scripts`를 사용하며 `allow-same-origin`·폼·팝업·상위 창 이동은 허용하지 않는다. CSP의 로컬 리소스/연결 범위는 발급된 문서 폴더 URL에 한정하고 HTTPS CDN은 허용한다. [iframe sandbox](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe), [CSP sandbox](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/sandbox).

`npx.cmd tsx --test src/server/html-preview.test.ts src/server/files.test.ts src/server/links.test.ts src/client/html-preview.browser.test.ts`로 실제 Electron 팝업·CSS·이미지·ES 모듈·JSON·버튼·원문·새로고침, 부모 DOM/API 접근 차단과 모의 SFTP POSIX 경로를 검증한다. 브라우저 테스트는 자체 프로필·파일·서버만 사용하고 Windows DPI에 따른 CDP iframe 클릭 좌표 오차를 피하도록 테스트 실행에만 scale factor 1을 사용한다.

PDF는 `Files.preview`에서 텍스트로 읽지 않고 종류·절대경로를 반환한다. 독립 미리보기 창은 인증된 `/files/pdf` 스트림을 iframe으로 표시한다. 이 응답만 SAMEORIGIN framing을 허용하고, 데스크톱의 `preview=1` 창에서만 내장 PDF 플러그인과 같은 출처 frame을 허용한다. 다른 창의 보안 설정은 유지한다. 데스크톱 main 변경은 새로고침만으로 적용되지 않으며 앱을 다시 실행해야 한다.

`useFileDrop`이 트리·크게 보기의 외부 파일 드롭을 공통 처리한다. 폴더 행은 해당 폴더, 파일 행은 부모 폴더, 빈 영역은 현재 폴더를 대상으로 삼고 행에서 전파를 막아 중복 업로드를 방지한다. 트리의 닫힌 폴더는 700ms 머무르면 펼친다. 업로드 완료 시 대상 목록만 갱신하여 다른 트리의 펼친 상태를 유지한다. 내부 파일 드래그와 외부 업로드를 구분한다.

회귀 검증은 상대·절대 PDF 경로와 바이너리 보존, 인증 없는 PDF 요청 거부, 실제 내장 뷰어 표시, 하위 폴더·빈 영역의 정확한 드롭 경로와 중복 방지, hover 펼치기 및 업로드 후 트리 상태를 포함한다. 실제 데스크톱·빌드된 백엔드·클라이언트 컴포넌트를 격리한 데이터·포트로 검사한다. 로컬 검증을 실제 SSH 검증으로 보고하지 않는다.

## 검증과 민감정보 점검

Setup은 빌드 성공 후 `scripts/create-desktop-shortcut.ps1`로 Windows Desktop known folder에 Harbor.lnk를 저장한다. 바로가기는 숨긴 PowerShell에서 저장소의 `Start-Harbor-Desktop.ps1`을 실행하므로 업데이트 후 같은 경로를 사용한다. `-NoLaunch`에서도 바로가기는 만들며, 생성 실패는 경고로 처리한다. 검증 시 Setup/Update 또는 helper의 `-DesktopDirectory`를 격리된 폴더로 지정하고 실제 사용자 바로가기를 테스트용으로 교체하지 않는다. 공백·한글 설치 경로, 반복 생성, 실제 launcher 실행을 확인한다.

Claude 제목 우선순위는 공식 Claude 2.1.258 배포 파일의 resume picker에서 확인한 agentName → customTitle → aiTitle → summary → first prompt를 따른다. `ai-title` 레코드를 빠뜨리면 `<command-name>` 같은 초기 명령이 제목으로 노출된다. 제목과 목록의 짧은 미리보기만 정리하고 저장된 대화 원문은 수정하지 않는다. [공식 세션 문서](https://code.claude.com/docs/en/sessions)의 이름·생성 제목 설명도 참고한다.

```powershell
npm.cmd run build
node --import tsx --test --test-timeout=90000 --test-concurrency=1 src/server/*.test.ts src/client/*.test.ts
node scripts/verify-claude-api.mjs
git add <검토한 파일들>
npm.cmd run audit:publication
git diff --cached --stat
git diff --cached
```

감사 도구는 Git 인덱스의 파일만 검사한다. 민감한 줄을 로그나 대화에 그대로 출력하지 않는다. 새 문서·스크립트는 .gitignore와 scripts/audit-publication.mjs의 허용 목록을 함께 갱신한다. 데이터·로그·스크린샷·런타임·배포 바이너리를 `git add -f`로 포함하지 않는다. 테스트 계정·주소는 합성 예제로 쓴다.

설치/업데이트 스크립트를 바꾸면 별도의 깨끗한 클론에서 Setup -NoLaunch, 새 커밋으로 Update -NoLaunch, 사용자 데이터 보존, 수정된 소스 보호를 검증한다. 현재 쓰는 앱의 node_modules를 재설치하거나 사용자 세션을 종료하지 않는다.

## 완료 답변 조판과 글꼴 유지보수

1.8.1 회귀 방지: 모든 tmux 제어 대상은 `tmuxTarget()`의 `=세션명:` 형태를 사용한다. `=세션명`만 쓰면 실제 tmux의 창 대상 파서에서 `set-option`은 실패하고 `display-message`는 빈 필드를 성공 코드로 돌려줄 수 있다. 상태 응답은 pane_dead가 0·1인지 검사한다. 모의 SSH 실행기도 이 잘못된 대상 표기를 거부한다. 실제 tmux 검증 시에는 전용 무작위 소켓·합성 셸을 사용하고 기존 사용자 세션에는 입력하지 않는다.

Codex CLI 도움말이 `--no-daemon`을 제공하면 `resume`은 네이티브 공유 서버 선택을 유지한다. 이미 공유 서버가 보유한 대화를 별도 app-server에 강제로 재개하면 writer lock 충돌이 생긴다. 별도 서버를 쓰는 새 대화와 구분하고, 이 재개는 받은함 확인 방식으로 보고한다. 잠금 파일 삭제나 기존 소유 프로세스 종료로 우회하지 않는다.

`claude-rich-mod.ts`는 공식 `ui.render`·`turn.step` 모드를 생성한다. 관리형 PowerShell/Bash 래퍼가 해당 실행에만 `--plugin-dir`를 추가하며 CLI 인수·모델·effort·승인 정책을 보존한다. 완성된 `AssistantMessage`만 세션 훅 인증으로 `/bridge/rich`에 보낸다. 브리지는 현재 Claude 대화 ID를 검사한다. 실제 DOM의 행 배치 확인 뒤 native Box로 교체한다. `rows-v2`의 모든 행은 높이 1의 Box 안에 Text를 놓아 위치를 표시한다. Text에 허용되지 않는 height 속성을 직접 주지 않는다. 입력·도구 승인·스트림은 유지한다.

`RichTerminals`는 터미널·대화·답변·열 수와 원문을 개인 캐시에 보관한다. `TerminalTypeset`과 `richFragments`는 현재 xterm 화면에 실제 남아 있는 연속된 답변 행만 표시한다. 첫 행이 화면 밖이어도 행 번호로 해당 문서 부분을 찾으며 입력·요약 행까지 칠하지 않는다. 넓었던 과거 답변도 현재 너비 안에서 표시한다. 표시와 선택은 같은 Markdown·KaTeX DOM이고 PNG·SVG 복제와 투명 선택 레이어는 제거했다. 비동기 이미지·Mermaid를 기다린 뒤 최초 행을 확보하고, 이후 크기 변경은 내부 스크롤로 제공한다. 구버전 모드 요청은 원문으로 돌아가며 접힌 조판 카드로 호환한다. 파일 링크는 해당 블록의 서버·cwd를 사용한다. 회귀 테스트 `terminal-rich-layout.browser.test.ts`는 격리 Electron에서 긴 한국어 표의 행·후속 문장 경계, 첫 마커가 없는 긴 답변, 입력 보호, 원문·수식 선택, 요약 후 제거·크기 변경을 확인한다.

Codex `CodexPeerRuntime.onAnswer`는 검증된 주 대화의 `item/completed`·`agentMessage`만 받고 다른 스레드·추론·계획·중복 알림을 제외한다. 네이티브 출력 교체 훅을 검증하지 못했으므로 같은 터미널 안의 접을 수 있는 카드로 표시한다. 이를 Claude와 동일한 TUI 교체 지원이라고 설명하지 않는다. 새 추론·입력 전송·추가 대화 생성은 없다.

글꼴 원본·고정 커밋·해시·OFL 고지는 `public/fonts/README.md`에 있다. 정적 파일은 그대로 배포하고 출처·해시 테스트를 함께 갱신한다. 폰트 CDN에 의존하지 않는다. `Typography` 설정 변경은 기존 xterm 옵션과 fit만 갱신하며 PTY를 다시 만들지 않는다. 문서 Ctrl+휠 배율은 별도로 유지한다.

회귀 검증에는 네이티브 Claude 모드·실제 CLI 플러그인 검증, 정확한 PowerShell/Bash 인수 전달, 인증·세션 범위·레이아웃 실패·개인 캐시 복원, Codex 주 스레드 완료 이벤트를 포함한다. 네이티브 CLI 전체 경로는 격리한 HOME·프로필·포트와 로컬 모의 모델을 사용하며 실제 사용자·SSH 세션이나 유료 추론에 테스트를 보내지 않는다. 모의 UI 이벤트 성공만으로 실제 CLI 화면의 교체를 주장하지 말고 네이티브 버퍼·표시 위치·최종 화면을 확인한다.

## 터미널 스크롤과 현재 대화 원본

1.10.4: 전체 화면 CLI가 CUP와 EL로 행을 덮어쓰면 xterm에 이전 페이지의 `isWrapped`가 남을 수 있다. 이를 addon-serialize의 연속 문자열로 변환하면 화면 복원 중 행이 이동하고 조판 표식과 다른 글자가 섞인다. `terminal-screen-alternate.ts`는 alternate 화면의 현재 `baseY`부터 셀 좌표를 복원하고, 선택용 줄바꿈 메타데이터를 별도로 재현한다. 셀을 그리는 동안 자동 줄바꿈·삽입 모드를 끄고 마지막에 원래 모드·스크롤 영역·커서를 복원한다. 정상 셸의 scrollback은 기존 직렬화를 유지한다. 불완전한 넓은 글자나 빈 마지막 셀의 pending-wrap처럼 손실 없이 표현할 수 없는 상태는 원래 출력·크기 변경 기록을 반환한다.

이 오류는 표시 조각만 늘려서는 해결되지 않는다. 원격의 새 출력과 새로 구독한 snapshot을 구분해 검사한다. `terminal-screen.test.ts`는 이전 직렬화가 실패하는 동일한 합성 재그리기, 셀·색상·모드·후속 출력·셸 복귀와 편집 조합을 확인한다. `terminal-rich-layout.browser.test.ts`는 실제 서버 snapshot을 브라우저 복원 함수에 전달해 모든 행과 조판·입력 영역을 확인한다. 기존 세션에 테스트 입력을 보내지 않는다. 백엔드 변경은 정식 설치본을 갱신하고 다음 앱 시작에 적용하며, 프런트엔드 자산 교체나 Ctrl+R만으로 적용됐다고 보고하지 않는다.

1.8.4의 `checkDurableSession`은 tmux 3.2a의 `error connecting to … (No such file or directory)`와 이전 버전의 소켓 부재 문구를 `LC_ALL=C`로 판별한다. 관련 없는 ENOENT·권한·연결 거부는 `management`로 보존한다. Linux `/proc/net/unix`에 해당 전용 소켓이 남아 있으면 소켓 파일이 없어도 살아 있는 서버일 수 있으므로 부재로 판정하지 않는다. 원격 상태 확인의 성공 응답도 검증하며, 원래 세션을 새 CLI로 대체하지 않는다. 명시적 닫기는 실제 종료 또는 확인된 부재에서만 registry를 지우고 일시적 실패에서는 자동 재연결을 복구한다. 상태의 `connectionIssue`는 연결 성공 시 지우고 재연결 API의 오류 분류를 UI까지 전달한다. 비밀번호 창은 실제 인증 오류에만 사용한다.

회귀 검증은 실제 셸에서 tmux 진단 문자열·종료 코드 판별, 부재 세션의 닫기, 권한 오류 시 보존, 닫기 실패 뒤 같은 PID 재접속을 포함한다. 실제 원격 tmux 3.2a 검증에는 무작위 전용 소켓과 합성 셸만 사용한다. 소켓 unlink를 시험한다면 소유 UID·소켓 종류·전용 이름을 먼저 검사하고 해당 전용 서버만 복구·정리한다. 기존 사용자 소켓이나 프로세스에 신호를 보내거나 터미널 입력을 주입하지 않는다. 서버 가동 시간과 프로세스 부재는 현재 상태의 근거이며 과거 재부팅 원인을 확정하는 근거는 아니다.

1.8.3의 관리형 tmux는 생성 및 attach에서 세션별 `mouse on`을 적용한다. Claude fullscreen은 일반 터미널의 scrollback이 아닌 앱 내부에서 대화를 스크롤한다. `mouse off`와 대체 화면의 짧은 버퍼를 대화 삭제로 처리하거나 키 입력·모델 재실행으로 복구하지 않는다. 실제 사용자 세션을 조사할 때는 버퍼 행 수·마우스 모드·저장된 메시지 수 등 필요한 메타데이터만 읽고 본문·자격 증명을 출력하지 않는다.

`TerminalConversation`은 기존 인증된 `/hosts/:hostId/history/:nativeSessionId?provider=...` 읽기 API를 사용한다. 현재 터미널의 ID·서버·제공자·대화에 바인딩하고 컴포넌트 key와 AbortController로 이전 대화의 늦은 응답을 차단한다. 이전 페이지는 중복 ID를 합쳐 앞에 추가하고 읽던 스크롤 위치를 유지한다. 로딩·오류는 기존 기록과 입력을 지우지 않는다. 같은 터미널 mount에 portal로 표시하여 기존 로컬 복사·번호 인용 경로를 유지하고 입력창은 덮지 않는다. 새 CLI·추론·사용자 프롬프트를 만들지 않는다.

Claude의 요약된 대화를 다시 열면 네이티브 뷰가 요약 이전 기록을 제공하지 않을 수 있다. 저장된 JSONL의 이전 사용자·답변 레코드는 `ClaudeHistory`에서 계속 읽는다. 이 동작을 실제 삭제·scrollback 손실과 구분한다. 회귀 검증은 요약 경계 전후 원문, 페이지 순서·재시도·대화 전환 취소, native 입력 초안 보존과 실제 SSH·tmux의 휠 전달을 포함한다.

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

관리자 AI의 연구실 실행은 `research-manager.ts`의 별도 MCP 도구로 제공한다. `harbor_lab_hosts`, `harbor_lab_launch`, `harbor_lab_status`, `harbor_lab_control`은 인증된 터미널의 네이티브 host/provider/session으로 소유권을 판별한다. launch는 항상 새 Claude·Codex를 만들며 기존 대화 연결 기능과 구분한다. `requestId`와 입력 지문을 연구실에 저장하여 같은 요청의 병렬 호출·재시도·앱 재시작으로 중복 실행하지 않는다. 새 요청 ID는 새 작업이다. 두 설정의 사전 검증을 마친 뒤 작업 공간과 CLI를 만들고, 일부 생성 실패 시 생성한 터미널만 정리한다. 정리 실패는 터미널 ID와 함께 보고한다.

관리자는 참여자가 아니므로 참여자 전용 context/report 권한을 부여하지 않는다. 자신의 연구실만 조회·제어하고, 참여자는 하위 연구실을 재귀 생성할 수 없다. 종료는 scheduler 일시정지 후 소유한 동일 네이티브 대화의 터미널만 닫는다. 사용자 전용 pendingDecision을 관리자 directive로 지우거나 answer로 처리할 수 없다. 새 실행·종료 도구를 기존 데이터 교환용 자동 승인 allowlist에 추가하지 않는다. 종료는 미완료를 완료로 바꾸지 않으며 모델 보고와 실제 검증을 구분한다. `harbor_lab_status(waitMs)`는 최대 25초의 진행 조회이며 관리자 턴을 영구 실행하거나 자동 재개하지 않는다.

관리자 기능 검증은 `npx.cmd tsx --test src/server/research-manager.test.ts src/server/research-lab.test.ts src/server/research-settings.test.ts`로 수행한다. 합성 네이티브 연결과 실제 MCP HTTP, 연구 배정·최종 검토 경로를 사용하므로 유료 모델 호출이나 사용자 SSH 세션 접속이 없다. 도구 실행 경로 검증을 실제 모델의 지시 이행·연구 품질 검증으로 보고하지 않는다.

드래그·스크롤 회귀 검증은 Chromium이 설치된 개발 환경에서 `node scripts/verify-selection-scroll.mjs`로 실행한다(`npx playwright install chromium`으로 테스트 브라우저 준비). 일반 버퍼는 로컬 스크롤을, 전체 화면 CLI는 휠 입력에 응답해 실제 행을 다시 그리는 합성 제공자를 사용한다. **선택이 남아 있는지만 검사하면 스크롤 차단을 놓친다.** 실제 화면 위치 변경과 여러 페이지·역방향 이동 후 복사 문자열의 정확성, 경계 드래그, 지연된 응답·마우스 해제, 일반 휠 및 조판 선택을 함께 검사한다. `terminal-selection-pages.test.ts`는 고정 머리말·입력창 제외, 중복·누락 없는 행 연결, 한글·이모지·줄바꿈, 불명확한 화면의 연결 거부를 검사한다. 산출물은 `.cache/selection-scroll`에만 저장한다.

전체 화면 선택은 `terminal-app-selection.ts`에서 휠을 한 번씩 전달하고 실제 재그리기를 기다리며, `terminal-selection-pages.ts`가 겹치는 고유 행과 이미 관찰한 내용을 검증해 이어 붙인다. 네이티브 선택은 현재 보이는 부분의 강조이며 복사·인용은 별도로 유지한 전체 선택을 읽는다. 임의로 좌표만 복원하거나 저장 대화를 추정해 삽입하지 않는다. 버퍼 변경·크기 변경·새 입력·해제 시 상태를 정리하고 컴포넌트 종료 때 남은 휠·타이머를 취소한다.

실제 네이티브 회귀 검증은 Windows에서 `node scripts/verify-native-selection.mjs`로 실행한다. PATH의 `codex.exe`를 쓰거나 `HARBOR_NATIVE_CODEX`로 실행 파일을 지정한다. 별도 Codex 홈·Git 작업 폴더·합성 대화를 `.cache`에 만들고 로컬 더미 제공자로 재개하므로 실제 계정·대화·서버에 접근하거나 모델 답변을 생성하지 않는다. CLI의 최초 폴더 신뢰는 이 격리 폴더에서만 처리하고 샌드박스 설치 안내는 Esc로 닫는다. 다중 스크롤·역방향 이동 중 강조와 선택 원문의 누락·중복을 검사한다. 1.10.1의 단순 합성 화면은 통과해도 실제 CLI의 공백 재그리기에서 실패했으므로 두 검증을 함께 유지한다.

행 비교는 명시적인 끝 공백과 비어 있는 셀을 동일하게 취급하지만 원문 셀·선행 들여쓰기를 바꾸지 않는다. 빈 구분 행으로 영역을 확장할 때 반대쪽 화면과의 이동을 확인해 고정 입력창까지 포함하지 않는다. 휠 전송이 네이티브 강조를 지우므로 응답 전 현재 페이지를 다시 강조한다. 동기화된 재그리기(DEC 2026)는 종료 표식을 확인하며, xterm의 자체 화면 갱신 타임아웃 이후에도 최대 5초의 경계 유예를 둔다. 실제 선택문이 변경되거나 연결을 확인할 수 없는 페이지는 기존 원문 보존·안내 경로를 유지한다.

Claude의 `rows-v2` 표식은 답변 위치를 위한 내부 예약이다. `richFragments`는 같은 답변의 모든 연속 구간을 반환하며, 가장 긴 구간만 고르면 나머지 표식이 노출된다. 확인된 예약 행만 조판하고, 오른쪽에 일반 출력이 붙은 행은 그 출력 앞에서 폭을 자르며 중간 줄바꿈·상태·입력 행은 덮지 않는다. `TerminalTypeset`는 구간별 클립을 표시한다. 화면 밖 선택 DOM은 비활성 표시 대신 위치를 옮겨 유지하고, `richSelectedText`는 동일 답변 복제 DOM의 선택 끝점을 하나의 원문 범위로 대응시켜 중복 복사를 막는다. `terminal-rich-layout.browser.test.ts`는 실제 Electron/xterm에서 모든 표식 위치의 조판, 일반 출력 비침범, 구간 간 정·역방향 복사와 화면 밖 선택, 수식·표·글꼴 변경을 확인한다. 합성 재그리기는 reset도 write 큐에 넣어 앞서 대기 중인 화면과 순서가 뒤집히지 않게 한다.

클라이언트만 바뀐 긴급 수정은 실행 중 백엔드와의 호환성을 격리한 구버전 설치본에서 먼저 확인할 수 있다. 적용할 때 실제 실행 EXE 경로와 서버가 반환하는 index의 해시를 확인하고, 기존 index를 `.cache`에 백업한다. 새 해시 자산을 추가하되 기존 자산은 지우지 않고 index만 원자적으로 교체한다. 사용자가 Ctrl+R로 화면을 갱신하기 전에는 실행 중 화면이 바뀌지 않는다. 이 방식은 SSH·백엔드를 재시작하지 않으며 백엔드 버전 표시는 유지된다. 다음 앱 시작용 정식 설치본·바로가기도 별도로 갱신하고 화면 패치, 설치 버전, 실행 버전을 구분해 보고한다.

연구실의 기본 결정 정책은 AI 위임이다. 후보 목록은 고정 하드웨어·예산·보호 자원과 구분하며 후보 전환·확대·실험 선택·허용된 계획 수행에 일반 사용자 승인을 다시 요구하지 않는다. `ResearchLabs.delegateDecision`은 구체적인 고정 제약 변경 없는 `scope-change`를 지속 가능한 `researchDecision`과 동료 질문으로 바꾼다. 실제 고정 제약 변경은 `constraintChange.category`, 사용자 목표·완료 기준·지시·검토한 배경에 있는 제약의 원문, 변경 내용을 요구하며 기존의 실제 동료 답변 검증을 유지한다. 의미 해석은 모델의 판단이므로 이 검증을 완전한 자연어 제약 판별기로 설명하지 않는다.

연구실의 `harbor_request`는 `routeQuestion`으로 원래 네이티브 동료에게 전달한다. 사용자 `Requests` 레코드를 만들거나 가짜 사용자 답변을 반환하지 않는다. 답장은 기존 `PeerDelivery.result`로 조회하며 질문의 실제 작성자·대화 ID·지시 버전을 확인한다. 준비·연구실 밖 질문과 네이티브 승인 훅은 기존 경로다. 같은 검토의 반복은 새 근거·접근을 고르는 작업 배정으로 이어지며 기준 충족·실제 최종 검토 없이 완료 처리하지 않는다. 구버전의 일반 범위 변경 대기 기록은 재시작 후 일시정지로 복구하여 기존 대화와 보고서를 보존하고 연결·계속 진행으로 이어간다.

회귀 검증에는 후보 전환의 사용자 중단 방지, 방향 선택 질문의 실제 동료 전달·답장 조회·중복 방지, 고정 제약 변경과 외부 허가의 실제 사용자 대기, 과거 기록 복구, 반복 검토, 네이티브 승인 유지가 포함된다. 격리한 합성 두 제공자 대화·MCP·브라우저·설치본을 사용하고 실제 사용자 연구나 SSH 서버에 테스트 요청을 보내지 않는다. 도구 경로 검증과 실제 모델의 자율적인 연구 품질을 구분한다.

작업표시줄 고정은 버전별 release 폴더의 EXE를 직접 가리킬 수 있다. `create-desktop-shortcut.ps1`는 같은 설치의 `release/.../Harbor.exe` 대상만 최신 선택 실행기로 갱신한다. Windows shell-item 바로가기는 TargetPath가 비어 있을 수 있으므로 System.Link.TargetParsingPath도 확인한다. 다른 설치의 고정은 수정하지 않는다. 격리한 DesktopDirectory를 전달한 테스트는 PinnedDirectory도 명시해야 실제 작업표시줄을 건드리지 않는다. 새 창은 AppUserModelID와 relaunchCommand로 해당 설치의 고정 실행기를 제공한다.

실행기는 선택된 실제 resources/app/package.json 또는 소스 설치의 package.json과 서버 health 버전을 비교한다. `-CheckOnly`는 창을 띄우지 않고 진단 JSON을 출력한다. 데스크톱도 단일 인스턴스 잠금 전에 버전을 확인하여 새 EXE가 예전 프로세스로 조용히 흡수되지 않게 한다. 불일치에서 안내만 표시하고 기존 서버·터미널은 종료하지 않는다. 연구실 탭 누락 사례처럼 새 설치본과 실제 실행 버전이 다르면 앱 종료·재실행 여부와 작업표시줄 대상을 함께 확인한다.

`npm.cmd run build:desktop`은 release 아래에 전체 앱 폴더를 만든다. EXE 하나만 전달하지 않는다. 빌드 산출물은 Git 소스에 넣지 않고 필요하면 별도로 ZIP/Release 자산으로 제공한다. 사용자 데이터가 포함되지 않았는지 패키지 내용을 검사한다.

마지막 보고에는 버전, 원격 커밋 링크, 검증 결과, 사용자의 업데이트 명령을 남긴다. 소스 게시, 설치본 교체, 실행 프로세스 재시작 여부를 구분한다. 실행 중인 사용자 앱을 임의로 재시작하지 않는다.

화면 연결은 SSH 수명과 구분한다. `SocketWatchdog`는 open 12초·replay 30초·주기 응답 45초를 확인하며, 서버가 `connectionMonitoring`을 제공할 때만 주기 응답을 요구한다. 예전 서버의 정상 유휴 소켓을 강제로 재연결하지 않는다. 화면 재연결은 입력·SSH reconnect/close API를 호출하지 않고 새 WebSocket과 필요할 때 xterm 뷰만 만든다. 복원 쓰기는 취소 신호·시간 제한을 가지고 이전 연결의 대기 Promise를 해제한다. `useHarbor`의 bootstrap도 12초 제한과 세대 검사를 사용한다. 서버는 15초 heartbeat/pong을 확인하되 서버 이벤트 루프가 늦어진 직후에는 한 주기 여유를 둔다.

터미널 뷰는 `subscribe.state=false`로 자신이 사용하지 않는 전체 AppState 방송을 제외한다. 메인 구독은 종전처럼 전체 상태를 받고 같은 20ms 안의 갱신을 합친다. `view-connections.jsonl`은 허용한 reason/code/terminalId/시각만 기록하며 분당 건수와 파일 크기를 제한한다. 사용자 대화·주소·token·원래 예외 메시지를 추가하지 않는다. `npx.cmd tsx --test src/client/socket-watchdog.test.ts src/server/view-connections.test.ts`와 빌드 후 `node scripts/verify-view-recovery.mjs`로 검증한다. 후자는 독립 백엔드·Electron·ConPTY에서 최초 replay 누락과 close 이벤트 없는 연결 정지를 재현하며, 같은 프로세스 보존·키보드 미전송·상태 방송 제외·자동 복구를 확인한다. 기존 사용자 앱이나 SSH 서버를 테스트 대상으로 쓰지 않는다.

Codex의 네이티브 Mermaid 지원 범위와 Harbor 브라우저의 Mermaid 지원 범위는 다르다. 완료 답변 구독이 없는 기존 네이티브 세션에서도 지원 불가 안내가 보이면 `TerminalDiagramFallback`이 현재 host/session의 저장 기록을 읽는다. ANSI 출력에서 그림 소스를 복원하거나 예약 행·입력을 주입하지 않는다. 일반 화면에서 주기적으로 기록을 조회하지 않으며, 저장 지연은 최대 세 번 읽고 수동 재시도를 제공한다. 완결된 Mermaid fence가 있는 최종 assistant 메시지만 사용한다. 현재 대화가 바뀌면 컴포넌트 키로 상태를 분리하고 늦은 응답을 취소한다. `npx.cmd tsx --test src/client/terminal-diagrams.test.ts src/client/terminal-diagrams.browser.test.ts src/client/terminal-rich-layout.browser.test.ts`로 그림 조판·저장 지연·세션 전환·입력 비침범과 기존 Claude 조판을 함께 검증한다.
