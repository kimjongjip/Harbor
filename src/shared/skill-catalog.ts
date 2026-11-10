/** Korean discovery notes, not a translation or modification of upstream instructions. */
export const SKILL_SOURCE = {
  repository: "anthropics/skills",
  commit: "2c5958ecac7cee2b583967a2c4981d0f4a75c579",
  checkedAt: "2026-11-11",
  url: "https://github.com/anthropics/skills",
} as const;
export type SkillProvider = "claude" | "codex";
export interface CatalogSkill {
  id: string;
  title: string;
  category: "문서·데이터" | "디자인" | "개발" | "업무·학습";
  description: string;
  example: string;
  requirements?: string;
  caveat?: string;
}
export const SKILL_CATALOG: CatalogSkill[] = [
  {
    id: "pdf",
    title: "PDF 작업",
    category: "문서·데이터",
    description:
      "PDF의 글·표 추출, 합치기, 양식 작성, OCR과 새 문서 만들기를 돕습니다.",
    example: "이 PDF에서 표를 추출하고 핵심 내용을 한국어로 정리해줘.",
    requirements:
      "작업에 따라 Python 라이브러리, Poppler, Tesseract 등이 필요합니다.",
  },
  {
    id: "docx",
    title: "워드 문서",
    category: "문서·데이터",
    description: "Word 문서를 만들고 수정하며, 서식·목차·변경 추적을 다룹니다.",
    example: "회의 메모를 목차와 표가 있는 Word 보고서로 만들어줘.",
    requirements:
      "작업에 따라 Node.js/docx, Python, Pandoc, LibreOffice가 필요합니다.",
  },
  {
    id: "pptx",
    title: "프레젠테이션",
    category: "문서·데이터",
    description:
      "PowerPoint 슬라이드를 만들거나 기존 발표 자료와 템플릿을 편집합니다.",
    example: "이 기획안을 8장짜리 PowerPoint 발표 자료로 만들어줘.",
    requirements:
      "작업에 따라 Node.js/PptxGenJS, Python, LibreOffice가 필요합니다.",
  },
  {
    id: "xlsx",
    title: "엑셀·표 데이터",
    category: "문서·데이터",
    description: "스프레드시트의 수식·서식·데이터 정리와 파일 변환을 돕습니다.",
    example: "이 CSV를 정리하고 합계 수식이 있는 엑셀 파일로 만들어줘.",
    requirements:
      "Python의 openpyxl·pandas 등과, 수식 재계산 시 LibreOffice가 필요할 수 있습니다.",
  },
  {
    id: "doc-coauthoring",
    title: "문서 함께 쓰기",
    category: "문서·데이터",
    description:
      "제안서·기술 명세·의사결정 문서를 맥락 수집부터 독자 검토까지 함께 작성합니다.",
    example: "이 기능의 기술 제안서를 질문부터 해가며 함께 작성해줘.",
  },
  {
    id: "frontend-design",
    title: "웹 화면 디자인",
    category: "디자인",
    description:
      "제품에 맞는 색·글꼴·배치로 개성 있는 웹 UI를 설계하고 구현합니다.",
    example: "이 프로젝트의 대시보드를 차분하고 읽기 쉽게 디자인해줘.",
  },
  {
    id: "canvas-design",
    title: "포스터·정적 이미지",
    category: "디자인",
    description:
      "시각적 콘셉트를 정하고 PNG·PDF 포스터나 정적인 디자인을 만듭니다.",
    example: "행사 안내 포스터를 PNG와 PDF로 만들어줘.",
    requirements:
      "이미지·PDF 제작 환경이 필요합니다. 글꼴 리소스를 함께 설치합니다.",
  },
  {
    id: "algorithmic-art",
    title: "코드로 그리는 아트",
    category: "디자인",
    description:
      "p5.js와 난수·입자·흐름을 사용해 조절 가능한 생성형 아트를 만듭니다.",
    example: "색과 입자 수를 조절할 수 있는 물결 애니메이션을 만들어줘.",
    requirements: "브라우저에서 p5.js를 실행할 환경이 필요합니다.",
  },
  {
    id: "theme-factory",
    title: "색·글꼴 테마",
    category: "디자인",
    description:
      "문서·발표·웹 결과물에 준비된 10가지 테마나 새로운 테마를 적용합니다.",
    example: "이 보고서에 어울리는 색과 글꼴 테마를 골라 적용해줘.",
  },
  {
    id: "brand-guidelines",
    title: "Anthropic 브랜드 스타일",
    category: "디자인",
    description:
      "Anthropic의 브랜드 색상과 타이포그래피를 결과물에 적용합니다.",
    example: "이 안내 자료에 Anthropic 브랜드 스타일을 적용해줘.",
    caveat: "일반 브랜드 생성기가 아니라 Anthropic 브랜드 전용 지침입니다.",
  },
  {
    id: "slack-gif-creator",
    title: "Slack용 GIF",
    category: "디자인",
    description:
      "Slack에 맞는 크기와 용량의 애니메이션 GIF를 만들고 확인합니다.",
    example: "Slack 이모지로 쓸 수 있는 손 흔드는 GIF를 만들어줘.",
    requirements: "Python 이미지 처리 라이브러리가 필요합니다.",
  },
  {
    id: "webapp-testing",
    title: "웹앱 브라우저 테스트",
    category: "개발",
    description:
      "Playwright로 웹 기능을 확인하고 화면 캡처·콘솔 로그를 수집합니다.",
    example: "로컬 웹앱의 로그인 폼 동작을 브라우저로 테스트해줘.",
    requirements: "Python Playwright와 해당 브라우저가 필요합니다.",
  },
  {
    id: "mcp-builder",
    title: "MCP 서버 만들기",
    category: "개발",
    description:
      "외부 API를 AI 도구로 연결하는 Python·TypeScript MCP 서버를 설계합니다.",
    example: "이 서비스 API를 연결하는 MCP 서버를 만들어줘.",
    requirements:
      "Python 또는 Node.js와 연결할 서비스의 자격 증명이 필요할 수 있습니다.",
  },
  {
    id: "skill-creator",
    title: "스킬 만들기·개선",
    category: "개발",
    description: "새 SKILL.md를 작성하고 예시 작업으로 동작을 평가·개선합니다.",
    example: "우리 팀 코드 리뷰 규칙을 재사용할 수 있는 스킬로 만들어줘.",
    caveat:
      "문서 작성은 양쪽에서 활용할 수 있지만, 자동 평가 스크립트 일부는 Claude CLI를 호출합니다.",
  },
  {
    id: "claude-api",
    title: "Claude API 개발",
    category: "개발",
    description:
      "Anthropic SDK·Claude API를 이용한 스트리밍·도구·에이전트 개발 지침입니다.",
    example: "Anthropic SDK로 스트리밍 채팅 예제를 만들어줘.",
    caveat:
      "Codex에서도 Claude API 개발에 참고할 수 있습니다. OpenAI API 지침은 아니며 실제 호출에는 별도 인증이 필요합니다.",
  },
  {
    id: "web-artifacts-builder",
    title: "복합 웹 아티팩트",
    category: "개발",
    description:
      "React·Tailwind·shadcn/ui로 여러 요소를 갖춘 HTML 결과물을 만듭니다.",
    example: "필터와 차트가 있는 대시보드를 하나의 HTML 결과물로 만들어줘.",
    requirements: "Node.js와 Bash 실행 환경이 필요합니다.",
    caveat:
      "Claude.ai 아티팩트용 지침입니다. Codex에서는 파일 생성 부분을 활용하며 Claude.ai 표시 기능은 제공되지 않습니다.",
  },
  {
    id: "internal-comms",
    title: "사내 소통 문서",
    category: "업무·학습",
    description:
      "진행 상황, 경영진 보고, 사내 뉴스, FAQ와 장애 보고 문서를 작성합니다.",
    example: "이번 주 진행 상황과 문제를 팀 공유용 보고서로 정리해줘.",
  },
  {
    id: "academy-guide",
    title: "Claude 학습 길잡이",
    category: "업무·학습",
    description:
      "Claude 사용법을 배울 때 알맞은 Claude Academy 강좌와 학습 자료를 찾습니다.",
    example: "팀에서 Claude를 처음 도입할 때 볼 학습 자료를 추천해줘.",
    caveat:
      "Claude 제품 학습에 초점이 맞춰져 있습니다. Codex 자체 사용법 안내는 아닙니다.",
  },
  {
    id: "discernment-nudge",
    title: "답변을 검토하는 질문",
    category: "업무·학습",
    description:
      "중요한 조언이나 초안 뒤에 사실·가정·빠진 맥락을 확인하는 질문을 더합니다.",
    example: "이 사업 계획을 검토하고 내가 확인해야 할 가정을 질문해줘.",
    caveat:
      "다양한 답변에 검토 질문을 덧붙이는 스킬입니다. 이런 응답 방식을 원할 때 설치하세요.",
  },
];
export type SkillInstallState =
  "available" | "installed" | "existing" | "unavailable";
export interface SkillLibraryStatus {
  roots: Record<SkillProvider, string>;
  skills: Record<string, Record<SkillProvider, SkillInstallState>>;
  errors?: Partial<Record<SkillProvider, string>>;
}
export interface SkillInstallResult {
  id: string;
  provider: SkillProvider;
  state: "installed" | "existing" | "error";
  message?: string;
}
export const skillInvocation = (skill: CatalogSkill, provider: SkillProvider) =>
  `${provider === "claude" ? "/" : "$"}${skill.id} ${skill.example}`;
