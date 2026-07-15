# 시작하기

이 프로젝트는 로컬 온보딩 화면과 사용자의 기존 Codex 또는 Claude Code 세션을 함께
사용합니다. 대시보드가 AI 토큰을 저장하거나 채용 사이트를 자동 수집하지는 않습니다.

## 권장 시작 순서

```bash
npm install
npx playwright install chromium
npm run onboarding
```

브라우저에서 `http://127.0.0.1:8766`을 열고 저장 안내부터 최종 확인까지 진행합니다.
이력서는 PDF·DOCX 중 하나가 필수이고 포트폴리오는 선택입니다. HWP는 PDF로 변환합니다.
완료 직후 같은 화면이 개인 모드로 전환되며, 다음 실행부터 `npm run personal`을 사용합니다.

## 에이전트에게 전달할 요청

```text
이 저장소의 CLAUDE.md와 data/private/onboarding/agent-request.json을 읽어줘.
등록된 문서를 사실 근거만으로 분석하고 추측은 추가하지 마. 나이·생년월일은
추출하거나 평가에 사용하지 마. 경력·기술·성과 근거·원본 위치·신뢰도와 섹션
후보를 계약 형식으로 만들어 현재 로컬 /api/onboarding/analysis에 등록해줘.
지원서는 내 확인 없이 제출하지 말고 AI 토큰을 파일에 저장하지 마.
```

분석 결과가 들어오면 화면에서 각 항목을 `사용·수정·제외`한 뒤 목표 직무, 경력 단계,
조건, 검색어, 플랫폼, 이력서 수정 권한과 선택형 평가 기준을 확인합니다. 문서 분석 제안은
버튼을 눌러야 입력되며 사용자 확인 없이 직무·회사·지역·점수를 자동 적용하지 않습니다.

## 설정 완료 조건

- 네 설정 파일에 `setup_complete: true`가 있어야 합니다.
- `search.yml`에는 목표 직무가 하나 이상 있어야 합니다.
- `sources.yml`에서는 외부 수집 어댑터가 사용할 플랫폼만 `collect: true`로 둡니다.
  목록에 없는 플랫폼은 영문·숫자·`-`·`_` 키로 추가할 수 있습니다.
- 개인 DB는 반드시 이 저장소의 `data/` 아래에 생성합니다.
- 공고별 문서에는 설치당 하나의 활성 기본 이력서가 적용됩니다.

터미널 설정을 직접 관리하려는 고급 사용자는 다음 대체 경로를 쓸 수 있습니다.

```bash
npm run setup
APP_MODE=personal npm run db:init
npm run personal
```

Git 저장소에서는 `npm run verify`로 앱·격리·보안 검사를 모두 실행합니다. Git 정보가
없는 압축 해제본은 `npm run verify:app`으로 앱 기능과 로컬 격리를 확인할 수 있습니다.

## 최소 import 계약

개인 대시보드가 실행 중일 때 Codex·Claude 또는 동기화 스크립트는 다음 형태로
공고 한 건을 전달합니다.

```bash
curl -X POST http://127.0.0.1:8766/api/jobs \
  -H 'content-type: application/json' \
  -d '{
    "jobKey":"stable-provider-id",
    "companyName":"Example Company",
    "title":"Example Role",
    "track":"user-defined-track",
    "status":"active",
    "sources":[{"platform":"custom_portal","url":"https://example.invalid/jobs/1","status":"active"}]
  }'
```

- 필수값: `jobKey`, `companyName`, `title`
- 공고·출처 상태: `active`, `closed`, `unknown` (`open`, `expired` 등은 정규화)
- 같은 `jobKey` 재실행: 중복 생성 없이 갱신
- 생략한 선택값: 기존 값 보존
- `null`·빈 문자열·빈 배열: 해당 값 명시적 삭제
- 비어 있지 않은 `sources`: 기존 멀티소스 링크와 병합

`score`는 기존 외부 단일 점수 호환 필드입니다. 사용자별 세부 평가는 먼저
`GET /api/scoring-profile`에서 체크섬과 활성 평가축을 읽고, 각 축의 `score`, `reason`,
`evidenceRefs`, `gaps`를 담은 `scoreBreakdown`을 전달합니다. 서버가 총점을 계산합니다.
현재 대시보드는 내장 AI·직무 채점기·자동 마감 확인기를 제공하지 않으므로 외부
에이전트가 `search.yml`과 `sources.yml`의 조건을 지켜야 합니다.
