# Job Search Operations Dashboard

> A local-first, Korea-first job search operations dashboard for multiple job
> families. It works as a companion to Codex or Claude and keeps personal data
> outside Git.

공고 출처 비교, 중복 정리, 관심·지원 상태, 이력서 작성 기준을 하나의 로컬
대시보드에서 관리하는 프로젝트입니다. 첫 실행은 실제 개인정보가 없는 합성
예시 데이터로 시작합니다.

## 핵심 원칙

- 개인 설정과 DB는 Git에 포함하지 않습니다.
- 목표 직무, 지역, 플랫폼과 점수 기준을 코드에 고정하지 않습니다.
- 동일 공고의 플랫폼별 링크를 모두 보존합니다.
- 활성 기업 채용 페이지를 우선하고 사용자 플랫폼 순위를 적용합니다.
- 이력서 문안은 사용자가 검토하며 자동 제출하지 않습니다.
- 공고별 맞춤 문안 수정은 이전 버전을 보관하고 동시 수정 충돌을 차단합니다.
- 승인 PDF는 임시 생성·페이지 검증 후 교체하고, 제출본은 별도 파일로 동결합니다.
- 초기 버전은 Telegram과 외부 파일 미리보기를 제공하지 않습니다.

## 빠른 시작

요구 환경은 Node.js 22.13 이상입니다.

```bash
npm install
npx playwright install chromium
npm run hooks:install
npm run db:init -- --demo
npm run dashboard
```

브라우저에서 `http://127.0.0.1:8766`을 엽니다.

개인 데이터로 전환하려면 다음 순서로 실행합니다.

```bash
npm run setup
APP_MODE=personal npm run db:init
APP_MODE=personal npm run dashboard
```

Codex 또는 Claude에는 다음과 같이 요청할 수 있습니다.

```text
START_HERE.md를 읽고 내 목표 직무와 희망 지역에 맞게 로컬 설정을 만들어줘.
실제 설정 파일과 DB는 Git에 추가하지 말아줘.
```

## 저장 경계

버전 관리 대상:

- 소스 코드, DB 스키마, `.example.yml`
- 합성 예시 JSON
- 문서, 테스트, 보안 검사

로컬 전용:

- `config/profile.yml`, `search.yml`, `sources.yml`, `resume.yml`
- `data/*.sqlite`
- 이력서, 포트폴리오, 지원 패키지, 원본 공고와 보고서
- `.env`, 로그와 보안 검사 결과

## 설정 파일

| 파일 | 역할 |
|---|---|
| `config/profile.yml` | 경력, 지역, 희망 조건 |
| `config/search.yml` | 목표 직무, 포함·제외 키워드, 사용자 트랙 |
| `config/sources.yml` | 플랫폼별 수집·표시·상태 확인·우선순위 |
| `config/resume.yml` | 이력서 섹션, 문체, 파일명과 품질 규칙 (`document.example.yml`에서 생성) |

설정이 완성되지 않으면 실제 공고 입력을 허용하지 않고 합성 예시 화면을 유지합니다.

## 맞춤 지원 문서 안전 흐름

공고 상세의 `맞춤 문안 시작`에서 공고별 초안을 만든 뒤 문안을 직접 수정합니다.
품질 기준을 통과해야 승인과 PDF 생성이 가능하고, 승인 후 다시 수정하면 기존
PDF와 승인은 자동으로 무효화됩니다. `제출본 동결`은 승인된 PDF를 별도 경로에
복사해 무결성을 고정할 뿐 외부 채용 플랫폼에 자동 제출하지 않습니다.

## 검증

```bash
npm run verify
```

이 명령은 기능 테스트, 개인정보·시크릿 검사, 포트·DB·자동실행 분리 검사를
실행합니다. 첫 GitHub push 전에는 별도의 pre-publish 스캐너도 통과해야 합니다.
`hooks:install`로 설치되는 pre-push 훅은 현재 커밋에 대한 명시적 사용자 승인
표식과 pre-publish 스캐너가 모두 없으면 push를 차단합니다.

## 계보와 라이선스

이 프로젝트는 MIT 라이선스인
[santifer/career-ops](https://github.com/santifer/career-ops)를 기반으로 합니다.
상세 기준 커밋과 파생 범위는 [NOTICE.md](NOTICE.md)에 기록했습니다.
