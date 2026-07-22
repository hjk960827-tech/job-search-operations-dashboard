# V2 Frontend Parity Matrix

Status values: `NOT_STARTED`, `IN_PROGRESS`, `PASS`. `PARTIAL`, `REVIEW`, `TODO`, and undocumented omissions are not valid completion states.

The table contains exactly 100 in-scope targets. `100 / 100 PASS` is required.

| ID | 개인용 화면·기능 | 개인용 위치 | 배포용 대체값 | 배포용 API | 구현 상태 | 테스트 | 합의 제외 | 비고 |
|---|---|---|---|---|---|---|---|---|
| P001 | 브랜드/앱 shell | header | FREE AGENT wordmark | static + bootstrap | PASS | parity-shell | 아니오 | 기본 `/` 경로의 FA 공개 브랜드 |
| P002 | 62px 상단 header | header | same geometry | static | PASS | parity-shell | 아니오 | desktop token |
| P003 | 구직공고 대시보드 최상위 메뉴 | header | jobs screen | bootstrap | PASS | parity-navigation | 아니오 | default |
| P004 | 이력서 관리 최상위 메뉴 | header | resume menu | bootstrap | PASS | parity-navigation | 아니오 | only second primary |
| P005 | 이력서 생성 dropdown | header | resume-create | resume/settings | PASS | parity-navigation | 아니오 | submenu |
| P006 | 이력서 수정 dropdown | header | resume-edit | resume/settings | PASS | parity-navigation | 아니오 | submenu |
| P007 | 이력서 리뷰 dropdown | header | resume-review | workflow/jobs | PASS | parity-navigation | 아니오 | submenu |
| P008 | 이력서 하위 탭 | resume screens | same 3 tabs | client state | PASS | parity-navigation | 아니오 | mobile reachable |
| P009 | 최신 확인 시각 | header | release revision time | bootstrap | PASS | parity-shell | 아니오 | no fake update claim |
| P010 | 알림 아이콘/badge | header | local inbox count | GET /api/inbox | PASS | parity-notifications | 아니오 | personal only |
| P011 | 알림 drawer 열기/닫기 | header | contextual drawer | GET /api/inbox | PASS | parity-notifications | 아니오 | not primary nav |
| P012 | 알림 유형 필터 | header drawer | generic types | GET /api/inbox | PASS | parity-notifications | 아니오 | client filter |
| P013 | 전체 알림 modal | overlay | full inbox | GET /api/inbox | PASS | parity-notifications | 아니오 | searchable |
| P014 | 모두 읽음 | notification surfaces | mark all | new release route | PASS | parity-notifications | 아니오 | backend required |
| P015 | 새로고침 | header | safe data refresh | bootstrap/jobs/workflow | PASS | parity-refresh | 아니오 | duplicate lock |
| P016 | 설정 진입 | header utility | settings modal/screen | GET/PATCH /api/settings | PASS | parity-settings | 아니오 | not primary nav |
| P017 | demo/onboarding 안내 | shell | compact environment notice | bootstrap | PASS | parity-modes | 아니오 | no layout takeover |
| P018 | onboarding-only replacement | all screens | setup before app | /api/onboarding* | PASS | parity-onboarding | 아니오 | existing flow preserved |
| P019 | post-setup default jobs | navigation | jobs | bootstrap | PASS | parity-navigation | 아니오 | no task-box default |
| P020 | two-primary-category invariant | header | jobs + resume only | static | PASS | parity-navigation | 아니오 | exact count 2 |
| P021 | 첫 목표 트랙 빠른 탭 | job toolbar | target track 1 | job facets/settings | PASS | parity-job-tabs | 아니오 | demo: 주 목표 직무 |
| P022 | 둘째 목표 트랙 빠른 탭 | job toolbar | target track 2 | job facets/settings | PASS | parity-job-tabs | 아니오 | demo: 보조 직무 |
| P023 | 추가 트랙 overflow/filter | job toolbar | configured extra tracks | job facets/settings | PASS | parity-job-tabs | 아니오 | no fixed occupations |
| P024 | 관심 공고 탭 | job toolbar | favorite | /api/jobs + state | PASS | parity-job-tabs | 아니오 | count |
| P025 | 지원 완료 탭 | job toolbar | applied | /api/jobs + state | PASS | parity-job-tabs | 아니오 | archive visibility |
| P026 | 제외 목록 탭 | job toolbar | skipped/rejected | /api/jobs + state | PASS | parity-job-tabs | 아니오 | lifecycle all |
| P027 | 공고 검색 | filters | generic search | GET /api/jobs | PASS | parity-filters | 아니오 | debounced |
| P028 | 트랙/직무 필터 | filters | dynamic tracks | GET /api/jobs | PASS | parity-filters | 아니오 | no marketing literals |
| P029 | 지역 필터 | filters | dynamic locations | GET /api/jobs | PASS | parity-filters | 아니오 | no Seoul catalog |
| P030 | 점수 필터 | filters | configured/external score | GET /api/jobs | PASS | parity-filters | 아니오 | unset supported |
| P031 | 지원 상태 필터 | filters | workflow status | GET /api/jobs | PASS | parity-filters | 아니오 | rejected trap handled |
| P032 | lifecycle 필터 | advanced filters | active/archive/all | GET /api/jobs | PASS | parity-filters | 아니오 | canonical |
| P033 | deadline 필터 | advanced filters | urgent/overdue/none | GET /api/jobs | PASS | parity-filters | 아니오 | Korea-first |
| P034 | platform 필터 | advanced filters | configured sources | GET /api/jobs | PASS | parity-filters | 아니오 | multisource |
| P035 | 조건/경력 필터 | advanced filters | experience/conditions | GET /api/jobs | PASS | parity-filters | 아니오 | generic |
| P036 | 필터 더보기 | filters | collapsible advanced | client state | PASS | parity-filters | 아니오 | same density |
| P037 | 필터 초기화 | filters | safe reset | GET /api/jobs | PASS | parity-filters | 아니오 | active default |
| P038 | 저장 필터 | filters | save/update/delete/default | /api/saved-filters* | PASS | parity-saved-filters | 아니오 | personal mode |
| P039 | 정렬 | list header | score/deadline/recent/company | GET /api/jobs | PASS | parity-sort | 아니오 | no Jobplanet sort |
| P040 | 목록 전용 보기 | filters | list only | client state | PASS | parity-filters | 아니오 | map control absent |
| P041 | 진행 상태 요약칩 | progress strip | workflow projection | GET /api/workflow | PASS | parity-progress | 아니오 | integrated task box |
| P042 | 진행칩 필터링 | progress strip | stage filter | jobs/workflow | PASS | parity-progress | 아니오 | deterministic |
| P043 | 결과 제목/개수 | list header | paged total | GET /api/jobs | PASS | parity-list | 아니오 | query aware |
| P044 | 고밀도 table/list shell | workspace | 12-slot-equivalent grid | GET /api/jobs | PASS | parity-list | 아니오 | generic columns |
| P045 | 점수 cell | list | score/source label | GET /api/jobs | PASS | parity-list | 아니오 | unconfigured state |
| P046 | 회사/logo cell | list | safe initial/icon | GET /api/jobs | PASS | parity-list | 아니오 | no personal asset |
| P047 | 포지션/역할 cell | list | title + condition meta | GET /api/jobs | PASS | parity-list | 아니오 | dense |
| P048 | 트랙 cell | list | user track | GET /api/jobs | PASS | parity-list | 아니오 | dynamic |
| P049 | 조건/경력 cell | list | generic condition summary | GET /api/jobs | PASS | parity-list | 아니오 | replaces company size |
| P050 | deadline cell | list | D-day/date | GET /api/jobs | PASS | parity-list | 아니오 | replaces rating width |
| P051 | 맞춤문서 상태 cell | list | package workflow | GET /api/jobs | PASS | parity-list | 아니오 | clickable |
| P052 | 우선순위 cell | list | workflow priority | GET /api/jobs | PASS | parity-list | 아니오 | generic |
| P053 | 리스크 cell | list | missing/fit warnings | GET /api/jobs | PASS | parity-list | 아니오 | evidence-based |
| P054 | 대표 플랫폼 cell | list | selected primary source | GET /api/jobs | PASS | parity-list | 아니오 | multisource |
| P055 | 상태 cell | list | lifecycle/workflow | GET /api/jobs | PASS | parity-list | 아니오 | separated |
| P056 | 행 관심 버튼 | list | favorite mutation | PATCH /api/jobs/:id/state | PASS | parity-job-state | 아니오 | no row selection conflict |
| P057 | 행 선택/상세 열기 | list | selected job | GET /api/jobs/:id | PASS | parity-detail | 아니오 | lazy detail |
| P058 | 첫 공고 자동 선택 | workspace | first visible result | GET /api/jobs/:id | PASS | parity-detail | 아니오 | desktop |
| P059 | 페이지 번호/이전/다음/마지막 | pagination | paged jobs | GET /api/jobs | PASS | parity-pagination | 아니오 | exact boundaries |
| P060 | 페이지당 20/50/100 | pagination | pageSize | GET /api/jobs | PASS | parity-pagination | 아니오 | persisted client state |
| P061 | 상세 회사/logo/title/status | detail | generic job identity | GET /api/jobs/:id | PASS | parity-detail | 아니오 | persistent panel |
| P062 | 상세 점수/rank/profile | detail | score breakdown/profile | GET /api/jobs/:id | PASS | parity-detail | 아니오 | stale-aware |
| P063 | 상세 주요 업무 | detail | summary/requirements | GET /api/jobs/:id | PASS | parity-detail | 아니오 | empty state |
| P064 | 상세 핵심 적합 포인트 | detail | score breakdown/evidence | GET /api/jobs/:id | PASS | parity-detail | 아니오 | no invented claims |
| P065 | 상세 주의 포인트 | detail | gaps/conditions | GET /api/jobs/:id | PASS | parity-detail | 아니오 | generic |
| P066 | 상세 메타데이터 | detail | deadline/location/experience | GET /api/jobs/:id | PASS | parity-detail | 아니오 | source aware |
| P067 | 상세 다중 출처 | detail | all sources + primary | GET /api/jobs/:id | PASS | parity-detail | 아니오 | links preserved |
| P068 | 맞춤문서 CTA | detail | package next action | GET/POST package | PASS | parity-package-entry | 아니오 | allowedActions |
| P069 | 공고 열기 | detail footer | primary source URL | GET /api/jobs/:id | PASS | parity-detail-actions | 아니오 | noreferrer |
| P070 | 상세 관심 | detail footer | favorite mutation | PATCH /api/jobs/:id/state | PASS | parity-job-state | 아니오 | allowed in personal |
| P071 | 상세 지원 완료 | detail footer | workflow applied | PATCH /api/jobs/:id/state | PASS | parity-job-state | 아니오 | package conflict gate |
| P072 | 상세 제외 | detail footer | workflow skipped | PATCH /api/jobs/:id/state | PASS | parity-job-state | 아니오 | reversible where valid |
| P073 | 이력서 생성 기본정보 | resume create | generic resume basics | PUT /api/resume | PASS | parity-resume-create | 아니오 | no occupation list |
| P074 | 경력 형태/단계/연수 | resume create | structured career state | PUT /api/resume | PASS | parity-resume-create | 아니오 | neutral |
| P075 | 스킬/자격/학력 | resume create | structured items | PUT /api/resume/structured | PASS | parity-resume-create | 아니오 | dynamic chips |
| P076 | 경력·프로젝트 추가/수정/정렬 | resume create | 역할·기간·고용형태·도구·연결자료 포함 structured items | PUT /api/resume/structured | PASS | parity-resume-create | 아니오 | full CRUD modal |
| P077 | 기준 이력서 문서 등록 | resume create | local source document | POST /api/settings/documents | PASS | parity-documents | 아니오 | PDF/DOCX |
| P078 | 포트폴리오 문서 등록 | resume create | optional source document | POST /api/settings/documents | PASS | parity-documents | 아니오 | PDF/DOCX |
| P079 | 문서 교체/열기/보관/삭제 | resume create/edit | safe open + archive + confirmed purge + upload | settings documents routes | PASS | parity-documents | 아니오 | private no-store response |
| P080 | 준비도 | resume create | 이력서 필수·포트폴리오 선택 | GET /api/bootstrap | PASS | parity-readiness | 아니오 | 포트폴리오 부재 단독 감점 없음 |
| P081 | 보강 질문/근거 | resume create | evidence items | resume/structured | PASS | parity-evidence | 아니오 | approved facts only |
| P082 | custom section | resume create | custom sections | PUT /api/resume | PASS | parity-resume-create | 아니오 | duplicate keys blocked |
| P083 | 이력서 수정 등록문서 목록 | resume edit | 이력서·사이트 문안·포트폴리오 3열 + 전체폭 적용 기준 | GET /api/settings | PASS | parity-resume-edit | 아니오 | generic |
| P084 | 이력서 수정 구조화 내용 | resume edit | editable resume/items | resume routes | PASS | parity-resume-edit | 아니오 | save/cancel |
| P085 | 이력서 수정 적용 기준 | resume edit | tracks/quality criteria | GET/PATCH /api/settings | PASS | parity-resume-edit | 아니오 | settings utility shared |
| P086 | 리뷰 단계 탭/개수 | resume review | 정확히 5단계 검토 필요·제출 준비·제출완료·지원 결과·보관함 | GET /api/workflow | PASS | parity-review | 아니오 | internal state projection |
| P087 | 리뷰 필터/후보 목록 | resume review | package/job filters | jobs/workflow | PASS | parity-review | 아니오 | responsive master-detail |
| P088 | 리뷰 상세/품질 근거 | resume review | public package/quality | GET /api/jobs/:id | PASS | parity-review | 아니오 | no private assumptions |
| P089 | 수정 전후 비교/modal | resume review | base vs package content | job/package routes | PASS | parity-review | 아니오 | sections dynamic |
| P090 | 맞춤문서 직접 수정 | resume review | package update | PUT /api/packages/:id | PASS | parity-package-edit | 아니오 | revision invalidates approval |
| P091 | 문안 승인/PDF 생성 상태 | resume review | approve package | POST /api/packages/:id/approve | PASS | parity-package-approve | 아니오 | checksum gate |
| P092 | 보완/보류/승인 취소 | resume review | review transitions | new release routes | PASS | parity-package-transitions | 아니오 | backend required |
| P093 | 수기 제출 준비/취소 | resume review | prepare/cancel | prepare + new cancel route | PASS | parity-submission | 아니오 | immutable gate |
| P094 | 제출 완료 기록/충돌 해결 | resume review | submitted + state reconcile | package/state routes | PASS | parity-submission | 아니오 | explicit confirmation |
| P095 | 지원 결과/교정/후속조치 | resume review | outcome ledger | outcomes/follow-ups routes | PASS | parity-outcomes | 아니오 | append-only |
| P096 | 결과 증빙 등록 | result modal | private evidence | new release route | PASS | parity-outcome-evidence | 아니오 | safe file rules |
| P097 | 문맥형 companion 요청 | jobs/resume/review | collect/analyze/generate | POST /api/companion/tasks | PASS | parity-companion | 아니오 | no primary nav |
| P098 | allowedActions/비활성 사유/중복 잠금 | all actions | server + client gates | /api/ui-contract + detail | PASS | parity-action-gates | 아니오 | no fake active control |
| P099 | desktop 1440×1000 parity | all screens | frozen geometry/tokens | runtime | PASS | parity-visual-desktop | 아니오 | console/overflow zero |
| P100 | mobile 390px parity | all screens | responsive structure | runtime | PASS | parity-visual-mobile | 아니오 | page overflow zero |

## Agreed exclusions

| ID | 제외 항목 | 이유 | 검증 |
|---|---|---|---|
| X001 | 지도 보기 버튼 | agreed release boundary | parity DOM에 없음 |
| X002 | 서울 지도와 지도 상태 | agreed release boundary | 코드/문구 없음 |
| X003 | Jobplanet 목록 열/정렬 | no supported official integration | 코드/문구 없음 |
| X004 | Jobplanet 상세/queue/enrichment | no supported official integration | route/control 없음 |
| X005 | 개인 A안 인하우스 명칭 | personal strategy | generic tracks |
| X006 | 개인 B안 대행사 명칭 | personal strategy | generic tracks |
| X007 | CRM/퍼포먼스/그로스/마케팅 기본값 | occupation-specific | config only |
| X008 | 개인 회사/이전회사/연봉/지역 | personal data/strategy | config only |
| X009 | 개인 이름/연락처 | personal data | repository scan zero |
| X010 | 개인 이력서/포트폴리오/지원자료 | private documents | repository scan zero |
| X011 | 개인 실제 공고/지원 이력 | private operations | synthetic demo only |
| X012 | API key/token/local AI credentials | secret | environment/agent session only |
| X013 | Telegram | agreed exclusion | code/config/docs absent |
| X014 | 자동지원 | explicit product boundary | capability unavailable |

## Accounting

- in-scope targets: **100**
- current PASS: **100**
- current NOT_STARTED: **0**
- exclusions: **14**
- completion: **100%**
