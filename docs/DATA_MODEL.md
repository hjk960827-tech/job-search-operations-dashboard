# Data Model

`jobs`는 회사·직무 기준의 대표 공고이며 `job_sources`는 플랫폼별 링크와 상태를
보관합니다. 플랫폼 링크를 하나로 덮어쓰지 않습니다.

대표 출처 선택 순서:

1. 표시 대상으로 설정되고 마감되지 않은 출처
2. 활성 기업 채용 페이지
3. `sources.yml`의 사용자 우선순위
4. 상태 확인 신뢰도
5. 최근 확인 시각
6. 플랫폼 키의 고정 정렬

`application_state`에는 관심 여부, 지원 상태와 메모만 저장합니다.
`jobs.deadline`은 대표 공고의 마감일이고 `job_sources.deadline`은 각 플랫폼 출처가
표시한 마감일입니다. 출처의 저장 상태가 `closed`이거나 출처 마감일이 지났을 때만 그
출처를 종료로 해석합니다. 저장된 출처가 모두 종료된 경우에만 대표 공고가 `closed`가
되며, 이후 어느 한 출처가 다시 `active`로 확인되면 대표 공고도 다시 열립니다.
마감 여부와 D-day는 `profile.yml`의 사용자 시간대 기준 날짜로 계산하며 잘못된 시간대는
Korea-first 기본값인 `Asia/Seoul`로 안전하게 대체합니다.
각 출처에는 허용된 접근 방식, 제한된 provenance, 최초·최근 확인 시각을 함께 보관하고
계정 상태·자격증명·회사 평점·회사 리뷰는 수집 계약에서 거부합니다.

대량 수집 결과는 운영 DB에 바로 쓰지 않습니다. `data/private/collection-runs/` 아래의
owner-only 실행 폴더에서 일관된 SQLite snapshot에 전체 batch를 먼저 적용하고
create/update/unchanged diff, 무결성, 외래키, 파일 체크섬을 검증합니다. publish 시에는
동일 DB instance·공고 revision·요청 체크섬을 다시 확인한 뒤 최대 1,000개 공고를 하나의
`BEGIN IMMEDIATE` 트랜잭션으로 적용합니다. staging 뒤 다른 writer가 공고를 바꾸면 기존
실행은 폐기하고 새 dry-run을 만들어야 합니다. 공고 반영과 publication journal은 같은
트랜잭션에 기록되며 JSON manifest 갱신 실패는 동일 체크섬 재시도로만 복구합니다.

`resume_profile`에는 직무·경력·학력 같은 사실 정보, 이력서 섹션 내용과 사용자가
공고별로 수정하도록 허용한 섹션 목록을 저장합니다. 등록 PDF·DOCX는 Git에서 제외된
`data/private/documents/`에 보관하고, DB의 `source_documents`에는 내부 경로·종류·크기·
SHA-256만 기록합니다. `profile_facts`, `evidence_items`, `resume_custom_sections`는 사용자가
승인한 문서 분석 결과를 분리해 저장합니다. `job_tailoring`은 공고별 중점 섹션과 실제
지원서 질문을 보관합니다.

`resume_assets`는 등록 문서를 `active`, `review_required`, `archived`로 관리합니다.
`resume_structured_items`는 경력·학력·기술·자격·프로젝트를 공통 필드와 날짜·주요 내용·
출처 참조로 보관합니다. 의미가 같은 구조화 항목은 정규화한 직무·제목·기관·역할·기간
조합으로 저장 전에 거부합니다. 호환 필드에 이미 있는 학력·자격이 구조화 항목으로도
등록되면 최종 문서에서는 구조화 항목을 사용해 같은 정보의 이중 출력을 막습니다.

홈 작업함의 workflow는 별도 테이블이나 중복 상태가 아닙니다. 공고 lifecycle,
`application_state.workflow_status`, 최신 `application_packages.state`, 기준 변경 여부를
순서대로 평가해 다음 단계와 허용 행동을 파생합니다. 공고 검토 전에는 작업본 생성 버튼을
노출하지 않고, 품질 보완 중에는 승인 버튼을 노출하지 않으며, 승인된 PDF만 수기 제출
준비로 이동할 수 있습니다. 작업함 deep link는 공고 ID와 현재 파생 단계를 사용하며 개인
파일 경로나 패키지 경로를 URL에 포함하지 않습니다.

현재 섹션 카탈로그는 `headline`, `summary`, `skills`, `experience_highlights`,
`achievement_evidence`, `representative_experience`, `direct_scope`,
`collaboration_scope`, `career_direction`의 9개입니다. 문서의 섹션이 이 카탈로그와
같은 의미면 기존 키로 정규화합니다. 매칭되지 않는 프로젝트·연구·논문·수상·교육·
봉사 등의 항목만 `custom:*` 키로 보존하며 `custom:summary`처럼 접두사만 바꾼 기본 키와
기본 항목 라벨을 재사용한 커스텀 키도 같은 의미의 중복으로 거부합니다. 이 검사는 DB를
수정하기 전에 끝납니다.
`document.example.yml`은 실제 동작하는 최소 작성 점수와 PDF 최대 페이지 수만 둡니다.

맞춤 문안의 편집 섹션은 다음 교집합으로 만듭니다.

1. 기본 이력서에 값이 있는 섹션
2. 공고 분석에서 중점 항목으로 지정한 섹션(없으면 1번 전체)
3. 사용자가 공고별 수정 가능하도록 허용한 섹션

직무 분야, 목표 직무, 경력 단계·연수, 학교·전공, 자격·인증과 확인된 근무 이력은
`protectedFacts`로 복제되며 맞춤 문안 수정 API가 값을 바꿀 수 없습니다. 그 밖의 승인
사실은 근거 라이브러리에 남지만 자동으로 보호 사실이 되지 않습니다. 지원서 질문은 공고 입력에
질문이 있을 때만 `application_question` 섹션으로 추가되고 이력서 PDF 본문에는
포함하지 않습니다. 이력서 Markdown·HTML·PDF에는 `resume` 섹션만 사용하고,
질문 답변은 같은 패키지 폴더의 `application-answers.md`에 별도로 저장합니다.
최종 문서의 `contacts`는 `profile.yml`에서 사용자가 개별 선택한 이메일·전화번호·주소만
포함합니다. 패키지 내용에는 선택 당시 snapshot이 들어가며 연락처 선택 또는 구조화 이력서가
바뀌면 기본 이력서 지문이 달라져 기존 패키지는 stale 처리됩니다. 패키지 API는 각 섹션의
`originalValue`와 현재 값을 비교한 diff와 통과·보완 품질 판정 사유를 함께 제공합니다.

승인 전 품질 검사는 점수와 별도의 차단조건을 먼저 적용합니다.

- 헤드라인을 제외한 이력서 본문 섹션이 최소 1개 있어야 합니다.
- 질문 답변만으로는 이력서 패키지를 승인할 수 없습니다.
- 텍스트 길이와 목록 개수·항목 길이의 섹션별 최소 기준을 충족해야 합니다.
- 보호 사실과 섹션 정의는 맞춤 수정 API로 바꿀 수 없습니다.

기존 공고를 다시 가져올 때 `tailoringFocus` 또는 `applicationQuestions`가 요청에서
생략되면 저장된 값을 유지합니다. 빈 배열을 명시한 경우에만 해당 설정을 비웁니다.
같은 규칙으로 선택 텍스트, `score`, `scoreBreakdown`은 생략 시 보존되고 명시적
`null`·빈 값이면 삭제됩니다. `score`는 호환 외부 단일 점수입니다. `scoreBreakdown`은
현재 평가 프로필 체크섬과 모든 활성 평가축의 점수·이유·근거 ID·부족 조건을 요구하고,
서버가 저장 가중치로 `total_score`를 계산합니다. 체크섬 또는 근거 ID가 오래되거나
알 수 없으면 전체 import를 거부합니다. 비어 있지 않은 `sources`는
`UNIQUE(job_id, platform, source_url)` 기준으로
병합하고 `null` 또는 빈 배열일 때만 모두 삭제합니다. 전체 요청은 검증 후 하나의
`BEGIN IMMEDIATE` 트랜잭션으로 적용됩니다. 공고·출처 상태는 `active`, `closed`,
`unknown`으로 정규화하며 URL 사용자명·비밀번호와 HTTP(S) 이외 URL을 거부합니다.

공고별 지원 문서 작업본은 다음 다섯 테이블로 분리합니다.

| 테이블 | 역할 |
|---|---|
| `job_tailoring` | 공고별 중점 이력서 섹션과 지원서 질문 |
| `application_packages` | 공고별 맞춤 문안, 품질 상태, 이력서와 별도 질문 답변 산출물 |
| `package_revisions` | 직접 수정 전후 체크섬·내용·파일 스냅샷 |
| `package_approvals` | 승인과 승인 무효화 이력 |
| `package_submissions` | 제출 준비 시 동결한 PDF 경로·체크섬·페이지 |

맞춤 문안은 `data/application-packages/<DB 인스턴스>/` 아래에만 생성됩니다.
수정은 화면이 읽은 체크섬과 DB의 현재 체크섬이 같을 때만 저장됩니다. 승인 뒤
수정하면 기존 PDF를 revision 폴더에 보관하고 승인을 무효화합니다. 제출 준비
시에는 현재 PDF를 별도 경로에 복사해 체크섬과 페이지 수를 동결합니다.

각 패키지는 생성 당시의 기본 이력서, 공고·질문, 품질 규칙 지문을 저장합니다.
현재 값이 달라지면 수정·승인·제출 준비를 차단하고 변경 사유를 표시합니다.
사용자가 `refreshConfirmed: true`로 확인한 경우에만 다음 버전을 만들며
`supersedes_package_id`로 이전 버전을 연결합니다. 과거 revision, 승인 PDF와 제출
동결본은 변경하지 않습니다.

승인 요청에는 화면이 본 `expectedChecksum`이 필수입니다. PDF는 저장된 HTML 파일을
신뢰하지 않고 요청 시 읽은 DB `content_json`으로 0600 임시 HTML을 다시 만든 뒤
렌더합니다. 렌더가 끝난 뒤 트랜잭션에서 상태·체크섬·지문·최신 버전을 다시 검사하고
조건부 갱신에 성공한 경우만 승인 이력을 기록합니다.

DB에는 `database_role`(`demo` 또는 `personal`)과 `schema_version=11`이 기록됩니다.
`schema_migrations`는 설치에 적용된 버전·이름·체크섬과 기존 스키마 버전에서 승계했는지
여부를 순서대로 보관합니다. 역할 불일치와 지원 버전보다 새로운 DB는 어떤 쓰기나
마이그레이션보다 먼저 차단합니다. 기존 DB를 업그레이드할 때는 원본 바이트 백업을 먼저
만들고, 모든 변경을 한 트랜잭션으로 적용하며 무결성·외래키·역할·버전을 다시 검사합니다.
검사나 마이그레이션이 실패하면 변경 전 파일로 복구합니다.

`system_revisions`는 공고 데이터와 지원 워크플로우 변경 번호를 분리해 관리합니다.
공고·출처·점수·맞춤 기준 변경은 `jobs`, 이력서·지원 상태·패키지·문서 변경은
`workflow` revision을 올립니다. 클라이언트는 이후 증분 동기화에서 두 범위를 독립적으로
판단할 수 있습니다.

`saved_filters`는 검색·트랙·플랫폼·지원 상태·공고 상태·마감·정렬·관심 여부만 JSON으로
저장합니다. 최대 30개이며 한 개만 시작 기본값이 될 수 있습니다. 목록 API는 이 조건을
전체 결과에 먼저 적용한 뒤 최대 100건을 반환하고, 목록에는 출처 URL·provenance·점수
breakdown·맞춤 문서 내용을 포함하지 않습니다. 전체 내용은 선택 공고 상세 API에서만
반환합니다. 목록·상세 ETag는 `system_revisions`와 요청 조건에 결합됩니다.

`agent_tasks`는 provider-neutral 로컬 companion 요청의 상태만 보관합니다. 공고 수집,
문서 분석, 공고별 문서 생성 작업은 `queued → running → succeeded|failed|cancelled`로
진행하며 요청/결과 본문은 Git 제외 owner-only JSON 파일에 저장합니다. 활성 요청은
kind와 입력 체크섬으로 중복을 차단하고, 실행 중인 문서 생성에는 전역 partial unique
index를 적용해 한 번에 하나만 처리합니다. lease와 heartbeat가 만료된 작업은 재시도
한도 안에서 queue로 돌아가며, 한도를 소진하면 실패로 남습니다.

`application_events`는 제출 뒤 서류 결과·면접·합격·불합격·철회를 append-only로
누적합니다. 같은 사건은 semantic checksum과 사용자 재시도용 event key로 중복을 막고,
DB trigger가 행 수정·삭제를 거부합니다. 결과 증빙은 종류·설명·선택적 SHA-256만
저장하고 외부 파일 경로나 메시지 원문을 저장하지 않습니다. 정정은 원본을 변경하는 대신
새 사건의 `correction_of_event_id`와 필수 정정 사유로 연결합니다.
`follow_ups`는 직접 지정한 예정일 또는 결과 사건 기준 D+0~365일을 보관하며
`pending`에서 `completed` 또는 `cancelled`로만 이동합니다. `local_notifications`는 결과와
후속조치마다 내부 공고 deep link를 한 건 생성하고 읽음 시각만 갱신합니다. 외부 메시지
전송과 Telegram·이메일·푸시 자격증명은 이 모델에 없습니다.

`jobs.reopened_at`과 `jobs.reopen_count`는 종료 공고가 다시 활성화된 이력을 보존합니다.
처음 본 공고와 재오픈 공고 표시는 이 필드와 최초 수집 시각에서 파생하며 별도의 지원
상태를 만들지 않습니다.

`privacy_deletion_events`는 보존 기간이 지난 비활성 등록 문서의 명시적 삭제 결과만
기록합니다. 활성 문서는 자동 삭제하지 않습니다. 파일은 먼저 owner-only 격리 폴더로
이동하고 DB 삭제가 실패하면 원래 위치로 복구합니다. DB 반영 뒤 파일 제거가 실패하면
격리 상태를 기록해 원문이 임의 위치로 되돌아가거나 조용히 유실된 것처럼 보이지 않게 합니다.

이전 개발 DB의 도달 불가 패키지 상태는 안전한 현재 상태로 정규화하고 DB trigger가
다시 생기는 것을 막습니다.
