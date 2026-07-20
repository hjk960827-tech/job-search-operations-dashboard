# Provider-neutral Local Companion

로컬 companion은 Codex나 Claude 계정을 대시보드에 연결하는 로그인 기능이 아닙니다.
대시보드는 AI 키, 계정 식별자, 쿠키와 세션을 요청하거나 저장하지 않습니다. 사용자가
이미 인증한 로컬 에이전트가 Git 제외 JSON 파일을 읽고 결과를 돌려주는 공통 계약입니다.

## 작업 종류

| kind | 입력 | 결과 |
|---|---|---|
| `collect_jobs` | 목표 직무·검색어·트랙·지역·고용형태·근무방식·경력범위·급여·회사/산업/업무 선호와 수집 허용 플랫폼 | 공개 공고 사실과 HTTP(S) 출처 |
| `analyze_documents` | 활성 등록 문서의 상대경로·SHA-256 | 문서 위치 근거가 있는 사실·근거·섹션 후보 |
| `generate_package` | 공고와 승인된 사실·근거·이력서 섹션 | 승인된 참조를 명시한 공고별 섹션 후보 |

생성 결과는 자동으로 이력서나 지원 패키지를 변경하지 않습니다. 서버는 알려지지 않은
사실·근거 ID와 이력서 섹션 키를 거부하지만 문장의 의미가 근거와 일치하는지는 사용자가
최종 확인해야 합니다. 승인·PDF·수기 제출 단계는 기존 대시보드 gate를 그대로 거칩니다.

## 파일 계약

각 task는 `data/private/companion/tasks/<random-id>/` 아래에 저장됩니다. 폴더 권한은
`0700`, JSON 권한은 `0600`입니다.

- `request.json`: task ID, kind, 입력 snapshot, 결과 계약, 요청 SHA-256
- `candidate-result.json`: 에이전트가 작성하는 로컬 결과 후보
- `result.json`: 서버 검증을 통과한 결과, 요청/결과 SHA-256

DB에는 상대경로만 기록하고 API 응답에도 절대경로를 내보내지 않습니다. 요청 파일이
수정되었거나 오래된 요청 체크섬으로 결과를 제출하면 완료를 거부합니다.

## 에이전트 실행 순서

```bash
npm run companion -- claim --worker=local-agent
```

출력된 `requestPath`를 읽고 계약에 맞는 결과를 같은 task 폴더의
`candidate-result.json`에 작성합니다. 특정 개인 task ID, dispatcher 또는 provider 이름을
코드에 고정하지 않습니다.

긴 작업은 API `POST /api/companion/tasks/:id/heartbeat` 또는 CLI heartbeat 명령으로
lease를 연장합니다.

```bash
npm run companion -- heartbeat --task=<task-id> --worker=local-agent
npm run companion -- complete --task=<task-id> --worker=local-agent --request-checksum=<sha256>
```

실패를 기록한 뒤 사용자가 화면이나 CLI에서 다시 시도할 수 있습니다.

```bash
npm run companion -- fail --task=<task-id> --worker=local-agent --code=local_failure --message="Local processing failed"
npm run companion -- retry --task=<task-id>
npm run companion -- cancel --task=<task-id>
```

## Queue 안전 규칙

- 같은 kind와 같은 입력 체크섬의 `queued`·`running` 요청은 하나로 합칩니다.
- `generate_package`는 DB partial unique index와 claim 트랜잭션으로 동시에 하나만 실행합니다.
- claim은 worker ID, lease 만료와 heartbeat 시각을 저장합니다. worker ID는 로컬 실행 이름일
  뿐 계정 정보가 아닙니다.
- lease가 만료되면 재시도 한도 전에는 queue로 복구하고, 한도에 도달하면 실패로 남깁니다.
- 취소된 작업은 이후 결과 완료를 거부합니다.
- 실패·취소·재시도는 이전 요청 파일을 덮어쓰지 않습니다.
- 공고 결과는 공개 HTTP(S) 출처만 허용하고 URL 사용자정보 및 토큰·키·서명처럼
  자격증명으로 보이는 query/fragment parameter를 거부합니다.
- 문서 분석 결과는 등록 문서 ID와 원본 위치를 요구하고 나이·생년월일을 거부합니다.
- 문서 생성 결과는 요청에 포함된 승인 사실·근거·섹션 참조만 허용합니다. 숫자는 문자열
  일부가 아니라 쉼표·퍼센트 표기를 정규화한 정확한 값이 승인 근거에 있을 때만 허용합니다.

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/companion/tasks` | 상태 목록과 stale 복구 |
| `POST` | `/api/companion/tasks` | 중복 차단형 작업 생성 |
| `POST` | `/api/companion/tasks/claim` | 다음 작업 lease 획득 |
| `POST` | `/api/companion/tasks/:id/heartbeat` | 실행 lease 연장 |
| `POST` | `/api/companion/tasks/:id/complete` | 요청·결과 검증 후 완료 |
| `POST` | `/api/companion/tasks/:id/fail` | 실패 기록 |
| `POST` | `/api/companion/tasks/:id/retry` | 실패 작업 재대기 |
| `POST` | `/api/companion/tasks/:id/cancel` | 대기·실행 작업 취소 |

모든 변경 API는 personal mode와 loopback host/origin, JSON content type 보호를 그대로
적용합니다. 외부 메시지 전송이나 SaaS 계정 연결은 이 계약의 범위가 아닙니다.
