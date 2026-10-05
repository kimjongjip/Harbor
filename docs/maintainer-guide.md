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
