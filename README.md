# Job Search Operations Dashboard

> A local-first, Korea-first job search operations dashboard for multiple job
> families. It works as a companion to Codex or Claude and keeps personal data
> outside Git.

공고 출처 비교, 중복 정리, 관심·지원 상태, 이력서 작성 기준을 하나의 로컬
대시보드에서 관리하는 프로젝트입니다. 첫 실행은 실제 개인정보가 없는 합성
예시 데이터로 시작합니다. 현재 버전은 `0.3.1`입니다.

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://github.com/codespaces/new?hide_repo_select=true&ref=main&repo=1298501275&skip_quickstart=true)

위 버튼을 사용하면 로컬 설치 없이 GitHub의 개인 임시 환경에서 실제 대시보드를 열 수 있습니다. 처음에는 11단계 초기 설정 화면이 열리며, 자세한 사용법과 개인정보 주의사항은 [Codespaces 체험 가이드](docs/CODESPACES.md)를 확인하세요.

## 핵심 원칙

- 개인 설정과 DB는 Git에 포함하지 않습니다.
- 등록한 PDF·DOCX와 분석 결과는 `data/private/`의 소유자 전용 영역에 저장합니다.
- 목표 직무, 지역, 플랫폼 우선순위와 경고 기준을 로컬 설정으로 분리합니다.
- 동일 공고의 플랫폼별 링크를 모두 보존합니다.
- 활성 기업 채용 페이지를 우선하고 사용자 플랫폼 순위를 적용합니다.
- 이력서 문안은 사용자가 검토하며 자동 제출하지 않습니다.
- 맞춤 이력서 항목은 `등록 이력서 항목 ∩ 공고 중점 항목 ∩ 사용자 수정 허용 항목`으로 정합니다.
- 학력·경력 구분·자격 정보는 맞춤 편집에서 잠그고, 공고에 없는 지원서 질문은 임의로 만들지 않습니다.
- 지원서 질문 답변은 `application-answers.md`로 분리하며 이력서 Markdown·HTML·PDF에 섞지 않습니다.
- 지원서 질문만 있거나 항목별 최소 작성 기준을 충족하지 못하면 승인 단계로 이동하지 않습니다.
- 공고별 맞춤 문안 수정은 이전 버전을 보관하고 동시 수정 충돌을 차단합니다.
- 승인 PDF는 임시 생성·페이지 검증 후 교체하고, 제출본은 별도 파일로 동결합니다.
- 초기 버전은 Telegram과 외부 파일 미리보기를 제공하지 않습니다.
- 데모는 합성 설정·데이터만 사용하는 읽기 전용 화면입니다.
- 대시보드가 AI 토큰을 저장하거나 내장 AI를 호출하지 않습니다.
- DB 스키마 변경 전 로컬 백업을 만들고, 실패하면 변경 전 파일로 복구합니다.
- 등록 문서는 보존 기간만으로 자동 삭제하지 않으며 비활성 문서에 대한 명시적 삭제 명령만 제공합니다.
- 잡플래닛 평점·리뷰 수집·분석 기능은 제공하지 않습니다.

## 빠른 시작

요구 환경은 Node.js 22.13 이상입니다.

```bash
npm install
npx playwright install chromium
npm run db:init -- --demo
npm run dashboard
```

브라우저에서 `http://127.0.0.1:8766`을 엽니다.

개인 데이터로 전환하려면 다음 순서로 실행합니다.

```bash
npm run onboarding
```

같은 주소에서 11단계 설정을 완료하면 개인 모드로 즉시 전환됩니다. 이후에는
`npm run personal`로 실행합니다. 이력서는 필수, 포트폴리오는 선택이며 PDF·DOCX를
지원합니다. HWP는 PDF로 변환한 뒤 등록합니다. 터미널 설정을 선호하는 고급 사용자는
기존 `npm run setup` 경로를 계속 사용할 수 있습니다.

Codex 또는 Claude에는 다음과 같이 요청할 수 있습니다.

```text
START_HERE.md와 data/private/onboarding/agent-request.json을 읽고 등록 문서를
사실 근거만으로 분석해줘. 나이·생년월일은 추출하지 말고, 구조화 결과를
로컬 /api/onboarding/analysis에 등록해줘.
```

## 저장 경계

버전 관리 대상:

- 소스 코드, DB 스키마, `.example.yml`
- 합성 예시 JSON
- 문서, 테스트, 보안 검사

로컬 전용:

- `config/profile.yml`, `search.yml`, `sources.yml`, `resume.yml`
- `data/*.sqlite`
- `data/private/`의 이력서·포트폴리오·분석 결과
- 지원 패키지, 원본 공고와 보고서
- `.env`, 로그와 보안 검사 결과

## 로컬 데이터 점검·백업·복원

설치 상태와 DB 역할·무결성·스키마 이력을 먼저 확인합니다.

```bash
npm run doctor -- --mode=personal
npm run db:inspect -- --mode=personal
```

기존 DB가 구버전이면 대시보드가 DB를 열기 전에 owner-only 백업을 만들고, 명시된
마이그레이션을 한 트랜잭션으로 적용합니다. 각 버전의 이름과 체크섬도 현재 릴리스의
manifest와 비교하며, 실패하면 변경 전 DB 바이트와 파일 시간을 복구합니다. 백업과
내보내기는 `data/` 아래의 Git 제외 영역에만 생성됩니다.

```bash
npm run db:backup -- --mode=personal --reason=before-local-change
npm run db:export -- --mode=personal
```

JSON 내보내기에는 모든 개인 데이터가 포함될 수 있으므로 저장소에 추가하거나 공유하면
안 됩니다. 복원은 대시보드를 종료한 상태에서 먼저 dry-run 검증을 실행하고, 정확한 확인
문구를 함께 준 경우에만 실제 DB를 교체합니다. 실제 복원 직전에도 현재 DB의 안전 백업을
추가로 만듭니다.

```bash
npm run db:restore -- --mode=personal --backup=<backup-file>
npm run db:restore -- --mode=personal --backup=<backup-file> --write --confirm=RESTORE_LOCAL_DATABASE
```

비활성으로 표시된 등록 문서 중 보존 기간이 지난 항목은 기본적으로 목록만 확인합니다.
활성 문서는 대상이 아니며, 실제 삭제에는 별도 쓰기 플래그와 확인 문구가 모두 필요합니다.

```bash
npm run privacy:prune -- --older-than-days=180
npm run privacy:prune -- --older-than-days=180 --write --confirm=DELETE_EXPIRED_PRIVATE_DOCUMENTS
```

전체 안전 동작과 복구 범위는 [데이터 안전 가이드](docs/DATA_SAFETY.md)에 정리되어 있습니다.

## 설정 파일

| 파일 | 역할 |
|---|---|
| `config/profile.yml` | 경력, 지역, 희망 조건 |
| `config/search.yml` | 목표 직무, 포함·제외 키워드, 사용자 트랙, 선택형 평가축·가중치 |
| `config/sources.yml` | 외부 수집 어댑터가 지킬 플랫폼별 수집·상태 확인 계약과 대시보드 표시·우선순위 |
| `config/resume.yml` | 사용자 선택형 문서 품질 기준·가중치, 최소 점수와 PDF 최대 페이지 수 (`document.example.yml`에서 생성) |

`APP_MODE=personal`은 네 설정 파일이 모두 유효하지 않으면 DB 경로를 계산하거나
열기 전에 종료합니다. 데모 실행은 로컬 개인 설정이 있더라도 항상 `.example.yml`만
읽습니다. `sources.yml`에는 예시 목록 외의 플랫폼도 안전한 영문 키로 추가할 수 있습니다.

## 공고 가져오기와 점수 범위

이 저장소 자체는 채용 사이트를 크롤링하거나 자동 로그인하지 않습니다. Codex,
Claude 또는 별도 동기화 어댑터가 `search.yml`과 `sources.yml`을 읽고 공고를 찾은 뒤
로컬 import API를 호출하는 구조입니다. 예:

`sources.yml`에 잡플래닛을 공고 링크 출처로 등록할 수는 있지만, 잡플래닛의 회사 평점이나
사용자 리뷰를 가져오거나 요약하지 않습니다. 공식 API가 없는 데이터의 우회 수집 기능도
제공하지 않습니다.

```bash
curl -X POST http://127.0.0.1:8766/api/jobs \
  -H 'content-type: application/json' \
  -d '{
    "jobKey":"provider-stable-id",
    "companyName":"Example Company",
    "title":"Example Role",
    "status":"active",
    "sources":[{"platform":"direct","url":"https://example.invalid/jobs/role","status":"active"}]
  }'
```

같은 `jobKey` 재수입은 선택 필드를 생략하면 기존 값을 보존합니다. `null`, 빈 문자열,
빈 배열은 문서화된 필드를 명시적으로 비우며, 비어 있지 않은 `sources`는 기존 출처와
병합합니다. 모든 입력은 쓰기 전에 검증되고 한 트랜잭션으로 반영됩니다.

기존 공고 적합도 `score`는 외부 채점기가 전달한 0~100 숫자로 호환 유지되며 화면에서
`외부 단일 점수`로 구분합니다. 온보딩에서 평가축을 직접 활성화하고 가중치 합계를
100으로 정하면 `GET /api/scoring-profile`이 프로필 체크섬을 제공합니다. Codex·Claude는
각 축의 점수·이유·근거 ID·부족 조건과 체크섬을 `scoreBreakdown`으로 전달할 수 있고,
서버가 저장된 가중치로 총점을 계산합니다. 체크섬이 오래됐거나 근거 ID가 존재하지
않으면 저장하지 않습니다. 평가축을 선택하지 않으면 점수를 자동 계산하지 않고
`평가 기준 설정 필요`를 표시합니다.

## Codex·Claude 로컬 Companion

`에이전트 작업` 화면은 공고 수집, 등록 문서 분석, 공고별 문서 생성 요청을 로컬 queue에
추가합니다. 대시보드는 AI 계정·토큰을 받거나 모델을 직접 호출하지 않습니다. 사용자가
이미 로그인한 Codex 또는 Claude 세션이 같은 provider-neutral JSON 계약을 처리합니다.

```bash
npm run companion -- list
npm run companion -- claim --worker=local-agent
```

claim 결과의 상대 `requestPath`를 읽고 결과를 해당 task 폴더의
`candidate-result.json`에 저장한 뒤, claim 때 받은 요청 체크섬으로 완료합니다.

```bash
npm run companion -- complete --task=<task-id> --worker=local-agent --request-checksum=<sha256>
```

동일한 활성 요청은 하나로 합쳐지고, 문서 생성은 동시에 하나만 실행됩니다. 실행 작업은
lease·heartbeat를 사용하며 실패·재시도·취소·stale 복구 상태가 화면에 표시됩니다.
생성 결과는 현재 요청 체크섬과 승인된 사실·근거·이력서 항목 참조를 통과해야 저장됩니다.
결과를 기본 이력서나 지원 문서에 자동 적용하거나 자동 승인하지는 않습니다. 자세한 파일·
API 계약은 [로컬 Companion 가이드](docs/COMPANION.md)를 참고하세요.

## 공고 수집 결과의 안전한 반영

대시보드는 채용 플랫폼에 로그인하거나 내장 크롤러를 실행하지 않습니다. 공식 API·공개
페이지·사용자 제공 사실을 읽은 provider-neutral 어댑터 결과만 받으며, `sources.yml`에서
`collect: true`로 허용한 플랫폼만 staging할 수 있습니다. `POST /api/jobs/batch` 또는
`npm run collection`은 먼저 별도 SQLite snapshot에서 전체 batch·마감일·출처·무결성을
검증하고 create/update/unchanged 차이를 보여줍니다. 사용자가 체크섬과 run ID를 확인해
publish한 경우에만 운영 DB에 한 트랜잭션으로 반영합니다. DB 반영과 publication journal은
같은 트랜잭션에 기록됩니다. 이후 로컬 manifest 파일 갱신이 실패해도 재수입하지 않고
동일한 run ID와 체크섬으로 안전하게 파일 상태만 복구할 수 있습니다.

공고와 각 출처는 별도 마감일을 가질 수 있습니다. 화면은 D-day 필터·마감 임박 정렬을
제공하고 모든 출처가 마감된 경우에만 대표 공고를 종료합니다. 자세한 계약은
[공고 수집 가이드](docs/COLLECTION.md)를 참고하세요.

## 공고별 지원 문서 안전 흐름

개인 모드의 첫 화면은 `홈·작업함`입니다. 별도의 워크플로우 상태를 저장하지 않고
`application_state`와 최신 `application_packages`에서 현재 단계와 다음 행동을 계산합니다.
공고 검토 → 작업본 생성 → 문안·품질 보완 → 승인·PDF 생성 → 수기 제출 준비 → 제출 완료
순서로 진행하며, 보완 필요·승인 대기·제출 준비 작업함에서 해당 공고로 바로 이동할 수
있습니다. 제외·종료 상태를 선택하면 활성 공고 필터 때문에 결과가 사라지지 않도록 화면이
자동으로 전체 공고 범위로 전환됩니다.

공고 상세의 `공고별 작업본 만들기`에서 기본 이력서 내용을 불러온 뒤 직접 수정합니다.
이 기능은 새 경력이나 문장을 AI로 자동 작성하거나 직무 적합성을 판정하지 않습니다.
헤드라인·요약·기술·경험·성과 근거처럼 기본 이력서에 실제로 입력된 항목 중에서
공고 import 시 중점 항목으로 지정되고 사용자가 수정 가능하도록 선택한 항목만 편집 화면에 나타납니다.
공고가 별도 자기소개 질문을 제공한 경우에만 그 질문이 추가됩니다.
질문 답변은 이력서와 별도 파일로 저장되며 이력서 본문 품질을 대신할 수 없습니다.
품질 기준을 통과해야 승인과 PDF 생성이 가능하고, 승인 후 다시 수정하면 기존
PDF와 승인은 자동으로 무효화됩니다. `수기 제출 준비`는 승인된 PDF를 별도 경로에
복사해 무결성을 고정하고 직접 지원할 준비를 할 뿐 외부 채용 플랫폼에 자동 제출하지 않습니다.

기본 이력서 화면의 기존 항목, 커스텀 섹션, 구조화 경력·학력·기술·자격·프로젝트는
한 번의 DB 트랜잭션으로 함께 저장됩니다. 일부 항목 저장이 실패하면 나머지도 적용하지
않아 서로 다른 시점의 이력서 내용이 섞이지 않습니다.

기본 이력서·공고/질문·문서 기준이 바뀌면 기존 패키지를 조용히 덮어쓰지 않습니다.
화면에 변경 사유를 표시하고 사용자가 확인한 경우에만 v2 이상의 새 버전을 만듭니다.
과거 승인본과 제출 동결본은 그대로 보존됩니다.

## 제출 이후 결과와 로컬 알림

제출 뒤 서류 결과·면접·합격·불합격·철회는 기존 제출본을 바꾸지 않는 append-only
사건으로 누적됩니다. 결과를 기준으로 D+ 후속조치를 만들거나 날짜를 직접 지정하고,
대시보드 안에서 완료·취소할 수 있습니다. 결과와 후속조치 알림은 내부 deep link와
읽음 상태만 로컬 DB에 저장하며 외부 메시지를 전송하지 않습니다. 자세한 규칙은
[지원 결과·로컬 알림 가이드](docs/OUTCOMES.md)를 참고하세요.

## 대량 공고 목록과 캐시

브라우저는 공고를 최대 100건씩 페이지로 받고, 선택한 공고만 상세 출처와 지원 문서를
추가로 불러옵니다. jobs/workflow revision이 같으면 ETag 캐시를 사용하고, mutation은
전체 목록이 아니라 변경된 공고 한 행만 반환합니다. 사용자는 현재 필터를 개인 DB에
저장할 수 있습니다. 제한 병렬 공고 읽기는 run별 owner-only 산출물을 만든 뒤 모든
worker 결과가 일치해야만 기존 staging 단계로 넘길 수 있습니다. 자세한 내용은
[성능·결정론적 읽기 가이드](docs/PERFORMANCE.md)를 참고하세요.

## 현재 문서 기능의 경계

대시보드 자체가 첨부 이력서를 AI로 해석하지는 않습니다. 사용자의 기존 Codex·Claude
Code 세션이 로컬 요청 계약에 따라 문서를 분석하고, 사용자가 승인한 내용만 반영합니다.
기존 9개 직무 중립 항목(헤드라인, 요약, 역량, 경력 하이라이트, 성과 근거, 대표 경험,
직접 담당, 협업 범위, 일하는 방식)은 호환 기본값으로 유지합니다. 의미가 같은 첨부 문서
항목은 이 9개에 매핑하고 프로젝트·연구·논문·수상처럼 겹치지 않는 항목만 커스텀
섹션으로 보존합니다. 설치당 활성 기본 이력서는 1개입니다. 등록 문서는 사용·검토 필요·
보관 상태로 관리하고, 경력·학력·기술·자격·프로젝트는 직무 중립 구조화 항목으로 추가할 수
있습니다. 이 항목은 사용자가 입력한 값만 최종 Markdown·HTML·PDF에 반영됩니다.

`profile.yml`의 이메일·전화번호·주소는 각각 값과 `pdf_fields` 선택이 모두 있을 때만
최종 문서에 표시됩니다. 값은 로컬 Git 제외 설정에만 두며 데모·예시에는 실제 연락처가
없습니다. 사용자는 제출 전 내용·연락처·레이아웃을 확인해야 합니다. PDF 산출물은 내부 안전 파일명을 사용하며
사용자 파일명 규칙은 제공하지 않습니다. 외부 HTML 입력은 후속 확장 범위입니다.

## 검증

```bash
npm run verify
```

이 명령은 기능·브라우저·PDF 테스트, 개인정보·시크릿 검사, 포트·DB·자동실행 분리 검사를
실행합니다. 새 GitHub push 전에는 별도의 pre-publish 스캐너도 통과해야 합니다.
Git 메타데이터가 없는 압축 해제본에서 앱 기능만 확인할 때는 `npm run verify:app`을
사용합니다. `npm run verify`의 보안 검사는 Git이 관리하는 실제 배포 후보 목록을 요구합니다.
저장소를 직접 배포·유지보수하는 관리자는 `gitleaks`와 별도 pre-publish 스캐너를
준비한 뒤에만 `npm run hooks:install`로 pre-push 훅을 설치합니다. 일반 사용자는 앱을
실행하기 위해 이 훅을 설치할 필요가 없습니다. 관리용 훅은 승인된 커밋·remote URL·
remote ref가 실제 push 대상과 정확히 일치하고 작업트리가 깨끗하며 pre-publish 검사까지
통과해야만 push를 허용합니다. 원격 이력을 교체하는 force/non-fast-forward push는 별도
절차 없이 허용하지 않습니다. 검사 `PASS` 자체는 업로드 승인이 아닙니다.

## 계보와 라이선스

이 프로젝트는 MIT 라이선스인
[santifer/career-ops](https://github.com/santifer/career-ops)를 기반으로 합니다.
상세 기준 커밋과 파생 범위는 [NOTICE.md](NOTICE.md)에 기록했습니다.
