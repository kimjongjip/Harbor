import type { CatalogSkill } from "./skill-catalog";
export const COMMUNITY_SKILLS: CatalogSkill[] = [
  {
    id: "literature-review",
    title: "체계적 문헌 조사",
    category: "연구",
    description:
      "주제별 선행연구를 찾고 검색 범위·선정 기준·근거의 한계를 기록하며 종합합니다.",
    example: "이 연구 주제의 선행연구를 비교하고 빠진 근거를 정리해줘.",
    requirements:
      "Python·requests와 검색망이 필요합니다. PDF 내보내기는 Pandoc·XeLaTeX, 선택적 도식은 OpenRouter 키가 필요합니다.",
    source: "scientific",
  },
  {
    id: "scientific-critical-thinking",
    title: "주장·근거 비판적 검토",
    category: "연구",
    description:
      "논문의 주장, 실험 설계, 교란 변수와 통계 해석이 근거에 맞는지 검토합니다.",
    example: "이 논문의 주장과 실험 결과가 실제로 연결되는지 검토해줘.",
    requirements:
      "핵심 검토는 추가 프로그램 없이 사용할 수 있습니다. 선택적 그림 생성은 별도 스킬·API가 필요합니다.",
    source: "scientific",
  },
  {
    id: "scientific-brainstorming",
    title: "연구 방향 브레인스토밍",
    category: "연구",
    description:
      "가정·반론·평가 기준을 드러내며 연구 후보를 만들고 비교합니다.",
    example:
      "현재 실험 결과를 바탕으로 검증할 가치가 있는 연구 방향을 비교해줘.",
    requirements: "선택적 로컬 도구는 Python 3.11+가 필요합니다.",
    source: "scientific",
  },
  {
    id: "hypothesis-generation",
    title: "가설·반증 실험 설계",
    category: "연구",
    description:
      "관측 결과를 검증 가능한 가설, 경쟁 설명과 구별 가능한 예측으로 바꿉니다.",
    example: "이 현상을 설명할 가설과 각 가설을 구별할 최소 실험을 설계해줘.",
    requirements: "선택적 로컬 도구는 Python 3.11+이며 API 키 없이 실행합니다.",
    source: "scientific",
  },
  {
    id: "peer-review",
    title: "논문 리뷰·수정 대응",
    category: "연구",
    description:
      "주장과 증거, 방법·재현성·통계를 점검하고 구체적인 리뷰 초안을 작성합니다.",
    example: "이 원고의 핵심 약점과 보완 실험을 리뷰 형식으로 정리해줘.",
    requirements: "선택적 검사 도구는 Python 3.11+가 필요합니다.",
    source: "scientific",
  },
  {
    id: "scientific-writing",
    title: "과학 논문 작성·검토",
    category: "연구",
    description:
      "출처를 추적하며 논문의 구조, 결과 설명, 인용과 제출 전 일관성을 검토합니다.",
    example:
      "내 실험 기록으로 논문의 결과 부분을 작성하고 근거가 빠진 문장을 표시해줘.",
    requirements:
      "핵심 지침은 공통 형식이며 선택적 로컬 검사는 Python 3.11+가 필요합니다.",
    source: "scientific",
  },
  {
    id: "citation-management",
    title: "논문 인용·BibTeX 관리",
    category: "연구",
    description:
      "논문 메타데이터와 DOI를 확인하고 인용 오류를 점검하며 BibTeX를 만듭니다.",
    example: "이 참고문헌의 제목·저자·DOI를 검증하고 BibTeX로 정리해줘.",
    requirements:
      "Python·requests와 서지 API 접근이 필요합니다. Google Scholar 검색은 scholarly를 추가로 사용합니다.",
    source: "scientific",
  },
  {
    id: "statistical-analysis",
    title: "실험 결과 통계 분석",
    category: "연구",
    description:
      "검정 선택, 가정 확인, 효과 크기와 불확실성, 연구 결과 보고를 돕습니다.",
    example:
      "이 반복 실험을 비교하고 적절한 검정·효과 크기·신뢰구간을 보고해줘.",
    requirements: "Python 3.12+와 원본에 안내된 통계 라이브러리가 필요합니다.",
    source: "scientific",
  },
  {
    id: "statistical-power",
    title: "표본 수·검정력 계획",
    category: "연구",
    description:
      "필요한 반복 수, 최소 검출 효과와 검정력을 가정별로 계산합니다.",
    example:
      "이 성능 차이를 검증하려면 몇 번 반복해야 하는지 민감도 분석을 해줘.",
    requirements: "Python 3.12+, statsmodels·SciPy·NumPy 등이 필요합니다.",
    source: "scientific",
  },
  {
    id: "experimental-design",
    title: "실험·대조군 설계",
    category: "연구",
    description:
      "데이터 수집 전에 대조군·무작위화·블록·반복·요인 설계를 정리합니다.",
    example:
      "성능 비교 실험에서 혼입 요인과 반복 순서를 통제하는 설계를 만들어줘.",
    requirements: "Python 3.12+, NumPy·pandas·pydoe가 필요할 수 있습니다.",
    source: "scientific",
  },
  {
    id: "scientific-visualization",
    title: "논문용 그림·오차 표시",
    category: "연구",
    description:
      "다중 패널, 불확실성, 색상 접근성과 제출용 출력 규격을 점검합니다.",
    example:
      "실험 결과를 오차 막대가 있는 논문용 그림으로 만들고 원본 데이터와 연결해줘.",
    requirements:
      "Python·Matplotlib 등이 필요합니다. Plotly 정적 출력은 Chrome/Chromium이 필요할 수 있습니다.",
    source: "scientific",
  },
  {
    id: "matplotlib",
    title: "정밀한 연구 그래프",
    category: "연구",
    description:
      "Matplotlib으로 그래프의 세부 요소와 PNG·PDF·SVG 출력을 제어합니다.",
    example: "이 CSV로 읽기 쉬운 비교 그래프를 그리고 PDF와 SVG로 저장해줘.",
    requirements: "Python 3.11+, Matplotlib·NumPy·SciPy 등이 필요합니다.",
    source: "scientific",
  },
  {
    id: "exploratory-data-analysis",
    title: "연구 데이터 탐색",
    category: "연구",
    description:
      "지원 형식의 데이터를 살펴보고 결측값·누출·이상치와 분석 가정을 점검합니다.",
    example:
      "이 실험 데이터의 결측값과 이상치, 분석 전에 확인할 문제를 찾아줘.",
    requirements:
      "Python 3.11+이며 HDF5·이미지 등 형식별 추가 라이브러리가 필요할 수 있습니다.",
    source: "scientific",
  },
  {
    id: "research-lookup",
    title: "최신 연구 근거 수집",
    category: "연구",
    description:
      "질문에 맞는 최신 학술 근거·경쟁 결과·출처를 수집하는 절차와 도구입니다.",
    example:
      "이 연구 질문에 대한 최신 논문과 상반된 결과를 출처와 함께 모아줘.",
    requirements:
      "Python·parallel-web-tools 및 Parallel 로그인/API가 필요합니다. 선택적 Perplexity는 OpenRouter 키가 필요합니다.",
    source: "scientific",
  },
  {
    id: "ml-paper-writing",
    folder: "20-ml-paper-writing/ml-paper-writing",
    title: "ML·AI 학회 논문 작성",
    category: "AI·시스템 연구",
    description:
      "연구 저장소에서 논증 구조·인용·LaTeX 원고와 제출 점검표를 만듭니다.",
    example:
      "이 연구 결과를 ML 학회 논문 구조로 정리하고 주장별 근거를 검토해줘.",
    requirements:
      "인용 조회용 Python 패키지와 PDF 빌드용 LaTeX가 필요할 수 있습니다.",
    source: "orchestra",
  },
  {
    id: "systems-paper-writing",
    folder: "20-ml-paper-writing/systems-paper-writing",
    title: "시스템 학회 논문 작성",
    category: "AI·시스템 연구",
    description:
      "OSDI·SOSP·ASPLOS·NSDI 등 시스템 논문의 문단 구조와 평가 설계를 안내합니다.",
    example: "이 가속기 연구를 ASPLOS 논문의 문제·설계·평가 구조로 검토해줘.",
    requirements:
      "LaTeX 빌드 환경은 별도입니다. 원본의 마감일·제출 규칙은 최신 학회 공고로 다시 확인하세요.",
    source: "orchestra",
  },
  {
    id: "academic-plotting",
    folder: "20-ml-paper-writing/academic-plotting",
    title: "ML 논문 도표·구조도",
    category: "AI·시스템 연구",
    description: "실험 데이터 그래프와 모델·시스템 구조도를 만드는 지침입니다.",
    example: "이 추론 파이프라인의 구조도와 성능 비교 그래프를 만들어줘.",
    requirements:
      "데이터 그래프는 Matplotlib·Seaborn, AI 구조도 생성은 Gemini API 키가 필요합니다.",
    source: "orchestra",
  },
  {
    id: "brainstorming-research-ideas",
    folder: "21-research-ideation/brainstorming-research-ideas",
    title: "CS·AI 연구 문제 찾기",
    category: "AI·시스템 연구",
    description:
      "구조화된 질문으로 새로운 문제, 연구 공백과 기여 후보를 탐색합니다.",
    example:
      "이 분야에서 기존 결과를 넘어서 검증할 수 있는 연구 문제를 찾아줘.",
    source: "orchestra",
  },
  {
    id: "creative-thinking-for-research",
    folder: "21-research-ideation/creative-thinking-for-research",
    title: "연구 아이디어 재구성",
    category: "AI·시스템 연구",
    description:
      "유추·제약 변경·문제 재정의로 CS·AI 연구 방향을 새롭게 검토합니다.",
    example:
      "이 연구의 가정을 바꿔 볼 수 있는 관점과 검증 가능한 아이디어를 제시해줘.",
    source: "orchestra",
  },
  {
    id: "speculative-decoding",
    folder: "19-emerging-techniques/speculative-decoding",
    title: "추측 디코딩 연구",
    category: "AI·시스템 연구",
    description:
      "draft 모델, Medusa, lookahead 등 추측 디코딩의 설계와 평가를 다룹니다.",
    example: "이 추측 디코딩 구현의 지연시간 병목과 비교 실험을 설계해줘.",
    requirements:
      "PyTorch·Transformers와 실험에 맞는 GPU가 필요합니다. 속도 향상 수치는 직접 측정해야 합니다.",
    source: "orchestra",
  },
  {
    id: "optimizing-attention-flash",
    folder: "10-optimization/flash-attention",
    title: "Attention 메모리·속도 최적화",
    category: "AI·시스템 연구",
    description:
      "PyTorch SDPA·Flash Attention을 이용한 attention 병목 분석과 구현을 돕습니다.",
    example:
      "이 attention 코드의 메모리 사용과 실행시간을 측정하고 최적화 후보를 비교해줘.",
    requirements: "PyTorch·flash-attn과 지원 GPU/CUDA 환경이 필요합니다.",
    source: "orchestra",
  },
  {
    id: "awq-quantization",
    folder: "10-optimization/awq",
    title: "AWQ 모델 양자화",
    category: "AI·시스템 연구",
    description:
      "제한된 GPU 메모리에서 AWQ 양자화의 적용과 품질·속도 평가를 안내합니다.",
    example:
      "이 모델의 AWQ 적용 가능성과 양자화 전후 품질 비교 실험을 설계해줘.",
    requirements:
      "PyTorch·AutoAWQ·Transformers와 호환 GPU가 필요합니다. 패키지 호환성을 확인해야 합니다.",
    source: "orchestra",
  },
  {
    id: "evaluating-llms-harness",
    folder: "11-evaluation/lm-evaluation-harness",
    title: "LLM 벤치마크 평가",
    category: "AI·시스템 연구",
    description:
      "LM Evaluation Harness로 평가 설정·모델 비교·재현 가능한 결과 수집을 돕습니다.",
    example: "이 모델들을 같은 데이터·설정으로 평가하고 재현 정보를 기록해줘.",
    requirements:
      "lm-eval·모델 실행 환경이 필요합니다. 코드 실행형 벤치마크는 격리된 환경에서 다룹니다.",
    source: "orchestra",
  },
  {
    id: "serving-llms-vllm",
    folder: "12-inference-serving/vllm",
    title: "vLLM 추론·서빙 실험",
    category: "AI·시스템 연구",
    description:
      "배칭·PagedAttention·병렬화와 추론 처리량·지연시간 평가를 안내합니다.",
    example: "이 vLLM 서빙의 배치 조건별 처리량과 지연시간을 비교해줘.",
    requirements: "vLLM·PyTorch 및 모델과 호환되는 GPU 환경이 필요합니다.",
    source: "orchestra",
  },
  {
    id: "long-context",
    folder: "19-emerging-techniques/long-context",
    title: "장문 컨텍스트 연구",
    category: "AI·시스템 연구",
    description:
      "RoPE·YaRN·ALiBi 등 위치 인코딩과 컨텍스트 확장 방식을 다룹니다.",
    example: "이 모델의 장문 컨텍스트 확장 방법과 길이별 품질 평가를 비교해줘.",
    requirements:
      "PyTorch·Transformers 등과 충분한 모델 실행 자원이 필요합니다.",
    source: "orchestra",
  },
  {
    id: "knowledge-distillation",
    folder: "19-emerging-techniques/knowledge-distillation",
    title: "지식 증류 실험",
    category: "AI·시스템 연구",
    description:
      "교사·학생 모델의 로짓, 온도, 손실 함수와 압축 평가 절차를 다룹니다.",
    example:
      "교사 모델을 작은 학생 모델로 증류하는 실험 계획과 비교 기준을 만들어줘.",
    requirements: "PyTorch·Transformers·datasets와 학습 자원이 필요합니다.",
    source: "orchestra",
  },
  {
    id: "systematic-debugging",
    title: "근거 중심 디버깅",
    category: "개발",
    description:
      "재현·원인 추적·가설 검증을 거쳐 버그와 성능 문제를 수정하는 절차입니다.",
    example: "이 오류의 재현 조건과 근본 원인을 먼저 찾아줘.",
    source: "superpowers",
    caveat:
      "다른 Superpowers 스킬을 참조하는 부분은 해당 스킬을 함께 설치하거나 현재 도구에 맞춰 적용해야 합니다.",
  },
  {
    id: "verification-before-completion",
    title: "완료 전 검증",
    category: "개발",
    description:
      "완료를 보고하기 전에 관련 검증을 실행하고 실제 결과를 확인하도록 돕습니다.",
    example: "이 변경이 완료됐는지 필요한 검증 결과와 함께 확인해줘.",
    source: "superpowers",
  },
  {
    id: "test-driven-development",
    title: "테스트 중심 개발",
    category: "개발",
    description:
      "실패하는 테스트부터 시작해 구현과 리팩터링을 진행하는 개발 절차입니다.",
    example: "이 기능을 실패하는 테스트부터 작성하며 구현해줘.",
    source: "superpowers",
  },
  {
    id: "rigs",
    title: "OpenRig 팀 연결",
    category: "개발",
    description:
      "Claude·Codex 팀을 구성하는 OpenRig의 설치·연결·운영 안내 스킬입니다.",
    example:
      "OpenRig가 필요한지 확인하고 이 서버에서 팀을 구성하는 절차를 설명해줘.",
    source: "openrig",
    requirements:
      "OpenRig 실행에는 macOS/Linux, Node.js 22/24, tmux와 각 CLI 로그인이 필요합니다.",
    caveat:
      "여기서는 안내 스킬만 설치합니다. OpenRig 설치·실행은 별도이며 사용자 설정·훅·tmux를 변경하고 새 에이전트를 실행할 수 있습니다. 현재 Harbor 세션을 자동 연결하지 않습니다.",
  },
  {
    id: "graft",
    title: "Graft · Trail-code 연결",
    category: "개발",
    description:
      "코드 구조와 팀의 학습 내용을 연결하는 Graft는 현재 Trail-code로 이름이 바뀌었습니다.",
    example:
      "이 프로젝트에 Trail-code를 적용하면 어떤 파일과 훅이 바뀌는지 먼저 확인해줘.",
    source: "graft",
    kind: "guide",
    requirements:
      "독립 CLI 도구입니다. Node.js와 네이티브 모듈 빌드 환경이 필요할 수 있습니다.",
    caveat:
      "최신 저장소의 SKILL.md는 테스트용 fixture이므로 설치 대상에 넣지 않았습니다. 공식 CLI가 프로젝트에 맞는 연결을 생성합니다. 초기화가 설정·훅·프로젝트 파일을 바꾸므로 공식 안내를 확인하세요.",
    guideCommands: ["npm install -g @trailhq/trail-code", "trail init"],
  },
];
