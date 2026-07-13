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
`resume_profile`에는 직무·경력·학력 같은 사실 정보, 이력서 섹션 내용과 사용자가
공고별로 수정하도록 허용한 섹션 목록을 저장합니다. 개인 PDF와 포트폴리오 파일은
DB와 저장소에 포함하지 않습니다. `job_tailoring`은 공고별 중점 섹션과 실제 지원서
질문을 보관합니다.

현재 섹션 카탈로그는 `headline`, `summary`, `skills`, `experience_highlights`,
`achievement_evidence`, `representative_experience`, `direct_scope`,
`collaboration_scope`, `career_direction`의 9개입니다. 첨부 이력서 파일에서 임의
필드를 추출하지 않으며 현재 카탈로그를 설정 파일로 바꾸지 않습니다.
`document.example.yml`은 실제 동작하는 최소 작성 점수와 PDF 최대 페이지 수만 둡니다.

맞춤 문안의 편집 섹션은 다음 교집합으로 만듭니다.

1. 기본 이력서에 값이 있는 섹션
2. 공고 분석에서 중점 항목으로 지정한 섹션(없으면 1번 전체)
3. 사용자가 공고별 수정 가능하도록 허용한 섹션

직무 분야, 목표 직무, 경력 구분·연수, 학교·전공, 자격·인증은 `protectedFacts`로
복제되며 맞춤 문안 수정 API가 값을 바꿀 수 없습니다. 지원서 질문은 공고 입력에
질문이 있을 때만 `application_question` 섹션으로 추가되고 이력서 PDF 본문에는
포함하지 않습니다. 이력서 Markdown·HTML·PDF에는 `resume` 섹션만 사용하고,
질문 답변은 같은 패키지 폴더의 `application-answers.md`에 별도로 저장합니다.

승인 전 품질 검사는 점수와 별도의 차단조건을 먼저 적용합니다.

- 헤드라인을 제외한 이력서 본문 섹션이 최소 1개 있어야 합니다.
- 질문 답변만으로는 이력서 패키지를 승인할 수 없습니다.
- 텍스트 길이와 목록 개수·항목 길이의 섹션별 최소 기준을 충족해야 합니다.
- 보호 사실과 섹션 정의는 맞춤 수정 API로 바꿀 수 없습니다.

기존 공고를 다시 가져올 때 `tailoringFocus` 또는 `applicationQuestions`가 요청에서
생략되면 저장된 값을 유지합니다. 빈 배열을 명시한 경우에만 해당 설정을 비웁니다.
같은 규칙으로 선택 텍스트와 `score`는 생략 시 보존되고 명시적 `null`·빈 값이면
삭제됩니다. 비어 있지 않은 `sources`는 `UNIQUE(job_id, platform, source_url)` 기준으로
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

DB에는 `database_role`(`demo` 또는 `personal`)과 `schema_version=2`가 기록됩니다.
역할 불일치는 어떤 마이그레이션보다 먼저 차단합니다. 이전 개발 DB의 도달 불가
패키지 상태는 안전한 현재 상태로 정규화하고 DB trigger가 다시 생기는 것을 막습니다.
