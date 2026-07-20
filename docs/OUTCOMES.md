# Application outcomes and local follow-ups

지원 완료 뒤의 결과는 기존 제출본이나 과거 결과를 수정하지 않고
`application_events`에 계속 추가합니다. 지원 결과 원장은 다음 사건을 지원합니다.

- 서류 합격·불합격
- 면접 예정·완료
- 합격 또는 제안 수신·수락
- 최종 불합격
- 사용자 철회

같은 공고·종류·발생 시각·내용·증빙의 조합은 semantic checksum으로 한 번만
저장됩니다. `eventKey`를 재사용한 재시도도 동일 결과에만 연결할 수 있습니다.
DB trigger가 사건 행의 수정과 삭제를 거부하므로 새 결과는 항상 별도 행이 됩니다.

잘못 기록한 결과도 원본을 덮어쓰지 않습니다. 원본 사건을 지정하고 정정 사유를
필수로 입력하면 새 사건이 `correction_of_event_id`로 원본에 연결됩니다. 화면은 가장
최근의 유효 결과를 현재 결과로 보여주되 원본·정정 사유·증빙을 모두 보존합니다.

## 결과 증빙

증빙은 `none`, `manual_note`, `portal`, `email`, `document` 중 하나이며 설명과 선택적
SHA-256만 보관합니다. 파일 경로나 이메일 원문을 복사하지 않습니다. `document`는
SHA-256이 필수입니다. 실제 내용은 사용자의 로컬 원본에 남습니다.

## 후속조치와 D+ 일정

후속조치는 날짜를 직접 지정하거나 기존 결과 사건을 기준으로 D+0~365일을 설정합니다.
대기 상태에서는 완료 또는 취소로 한 번만 전환할 수 있고, 완료와 취소 기록은 지우지
않습니다. 같은 대기 후속조치는 중복 생성되지 않습니다.

모든 공고의 대기 후속조치는 홈 작업함에 예정일 순서로 모입니다. 사용자는 작업함에서
해당 공고의 결과·후속조치 영역으로 바로 이동할 수 있습니다.

## 신규·재오픈 공고

처음 수집된 공고는 `신규`, 과거 종료 상태였다가 다시 활성화된 공고는 `재오픈`으로
표시합니다. 재오픈 시각과 횟수를 별도로 보존하며 같은 활성 상태를 반복 수입해도 횟수를
다시 올리지 않습니다. 이 표시는 지원 결과 사건을 수정하지 않습니다.

## 로컬 알림함

결과와 후속조치를 추가하면 로컬 DB의 `local_notifications`에 한 건의 알림이 생깁니다.
deep link는 `#jobs?job=<id>&focus=outcomes` 형식만 서버에서 생성합니다. 알림은 대시보드
안에서 읽음 처리할 수 있으며 Telegram, 이메일, 푸시 또는 외부 메시지를 전송하지
않고 어떠한 외부 메시지 자격증명도 받지 않습니다.

주요 API:

- `GET|POST /api/jobs/:id/outcomes`
- `POST /api/jobs/:id/outcomes/:eventId/corrections`
- `POST /api/jobs/:id/follow-ups`
- `POST /api/follow-ups/:id/complete`
- `POST /api/follow-ups/:id/cancel`
- `GET /api/inbox`
- `POST /api/inbox/:id/read`
