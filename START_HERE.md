# 시작하기

이 프로젝트는 사용자의 Codex 또는 Claude 세션이 로컬 설정을 만들고 유지하는
방식으로 사용합니다.

## 에이전트에게 전달할 요청

```text
이 저장소의 CLAUDE.md와 config/*.example.yml을 읽어줘.
내 목표 직무, 경력 범위, 희망 지역, 근무 형태, 포함·제외 키워드와 사용할
채용 플랫폼을 질문해줘. 답변이 끝나면 config/profile.yml, search.yml,
sources.yml, resume.yml을 만들어줘. 실제 개인정보와 DB는 Git에 추가하지 말고,
지원서는 내 확인 없이 제출하지 마.
```

## 설정 완료 조건

- 네 설정 파일에 `setup_complete: true`가 있어야 합니다.
- `search.yml`에는 목표 직무가 하나 이상 있어야 합니다.
- `sources.yml`에서는 사용할 플랫폼만 `collect: true`로 둡니다.
- 개인 DB는 반드시 이 저장소의 `data/` 아래에 생성합니다.

완료 후 실행:

```bash
APP_MODE=personal npm run db:init
APP_MODE=personal npm run dashboard
```
