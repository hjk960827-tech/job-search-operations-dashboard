# Listing, cache, and deterministic reads

## 가벼운 목록과 상세

브라우저는 시작할 때 `/api/bootstrap`으로 설정·이력서·알림 메타데이터를 받고,
`GET /api/jobs?page=1&pageSize=30`에서 한 페이지의 공고 요약만 가져옵니다. 목록 요약에는
출처 URL, provenance, 점수 breakdown, 맞춤 문서 내용이 없습니다. 사용자가 공고를
선택한 경우에만 `GET /api/jobs/:id`로 전체 출처와 지원 문서를 가져옵니다.

페이지 크기는 최대 100건입니다. 검색·직무 트랙·플랫폼·지원 상태·공고 상태·마감·관심
여부·정렬을 서버가 페이지 계산 전에 적용합니다. API는 전체 건수와 페이지 수, 전체
track/platform facet을 함께 반환합니다.

목록·상세·workflow 응답의 ETag는 DB instance 내부 `jobs`와 `workflow` revision에
결합됩니다. 같은 URL과 revision으로 다시 요청하면 `304 Not Modified`를 반환합니다.
공고별 mutation은 전체 목록 대신 해당 공고의 요약 행·상세·새 revision만 반환합니다.
여러 공고를 바꾸는 batch publish나 이력서 기준 변경은 invalidation scope만 반환합니다.

## 저장 필터

개인 모드 사용자는 최대 30개의 범용 필터를 개인 SQLite DB에 저장할 수 있습니다.
한 필터만 시작 기본값으로 지정할 수 있고 이름은 대소문자와 호환형 문자를 정규화해
중복을 막습니다. 실제 직무·지역·회사 기본값은 예시에 넣지 않습니다. demo 모드는
저장 필터 mutation을 허용하지 않습니다.

## 제한 병렬 읽기

`runLimitedJobReads()`는 provider-neutral read task를 동시에 1~4개만 실행합니다. 각
worker 결과는 Git 제외 owner-only `data/private/read-runs/<run-id>/`에 별도 파일로
저장됩니다. reducer는 task key와 job key를 고정 정렬하고 동일 job key의 완전히 같은
결과만 합칩니다. 서로 다른 사실은 실패로 처리합니다.

모든 worker와 reducer가 성공한 run에만 `combined.json`이 생깁니다. worker 하나가
실패하면 failed manifest만 남고 combined artifact나 DB write는 만들지 않습니다.
성공 결과도 DB에 자동 publish하지 않으며 기존 collection dry-run·staging·명시적
publish 절차를 별도로 거쳐 single writer 원칙을 유지합니다.

회사 로고와 지도는 자동 원격 로딩, 위치 추론 또는 고정 지역 중심 UI로 제공하지
않습니다. 후속 검토 시에도 사용자가 명시적으로 켠 로컬 설정과 개인정보 영향을 먼저
검토해야 합니다.
