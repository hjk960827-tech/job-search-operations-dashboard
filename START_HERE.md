# 시작하기

이 프로젝트는 사용자의 Codex 또는 Claude 세션이 로컬 설정을 만들고 유지하는
방식으로 사용합니다. 대시보드가 AI 토큰을 저장하거나 채용 사이트를 자동 수집하지는
않습니다.

## 에이전트에게 전달할 요청

```text
이 저장소의 CLAUDE.md와 config/*.example.yml을 읽어줘.
내 목표 직무, 경력 범위, 희망 지역, 근무 형태, 포함·제외 키워드와 사용할
채용 플랫폼을 질문해줘. 답변이 끝나면 config/profile.yml, search.yml,
sources.yml, resume.yml을 만들어줘. 실제 개인정보와 DB는 Git에 추가하지 말고,
지원서는 내 확인 없이 제출하지 마. 설정이 끝나면 선택한 플랫폼과 검색 조건을
준수해 찾은 공고를 아래 import API 계약으로만 로컬 대시보드에 넣어줘.
```

## 설정 완료 조건

- 네 설정 파일에 `setup_complete: true`가 있어야 합니다.
- `search.yml`에는 목표 직무가 하나 이상 있어야 합니다.
- `sources.yml`에서는 외부 수집 어댑터가 사용할 플랫폼만 `collect: true`로 둡니다.
  목록에 없는 플랫폼은 영문·숫자·`-`·`_` 키로 추가할 수 있습니다.
- 개인 DB는 반드시 이 저장소의 `data/` 아래에 생성합니다.
- 공고별 문서에는 설치당 하나의 활성 기본 이력서가 적용됩니다.

완료 후 실행:

```bash
APP_MODE=personal npm run db:init
APP_MODE=personal npm run dashboard
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

`score`는 외부에서 계산한 0~100 값만 받습니다. 현재 대시보드는 내장 직무 채점기나
자동 마감 확인기를 제공하지 않으므로, 외부 에이전트가 `search.yml`과
`sources.yml`의 조건을 지켜야 합니다.
