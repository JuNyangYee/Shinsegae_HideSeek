# Shinsegae_HideSeek

mmWave 센서로 관객이 가까워지면 캐릭터들이 숨고, 멀어지면 다시 놀이로 돌아오는 숨바꼭질 체험(로컬 PC 하드웨어 체험 앱, 시퀀스 영상 기반 연출)입니다.

현재(2026-10-21)는 **세로 9:16 실제 시퀀스 영상 + 유화 후처리 + 모의 근접 입력** 단계입니다. 제공된 7개 영상(HideSeek_Seq_1021)을 근접 판정에 따라 재생하고, 그 위에 ThrowSnow와 같은 유화 필터를 입힙니다. **실제 센서 연동은 아직 없습니다**(개발 패널의 모의 입력으로 확인).

## 실행

- 필요: Node.js 24 이상, WebGL2를 쓸 수 있는 브라우저(Chrome 권장).

```sh
npm ci           # three 0.186.1 설치(유일한 런타임 의존성)
npm start        # http://127.0.0.1:8091/display/ (루트 / 는 이 주소로 이동)
npm test         # 근접 판정·시퀀스 상태·외부 미디어 서버 테스트(node:test)
```

- 포트 변경: `PORT=8092 npm start` (PowerShell: `$env:PORT=8092; npm start`). `PORT=0`이면 빈 포트를 자동으로 고르고 실제 주소를 출력합니다.
- 서버는 `127.0.0.1`에서만 열리며 `public/`, three 고정 파일 2개, 아래 미디어 allowlist만 제공합니다.

## 영상·이미지 경로

원본은 저장소에 복사하지 않고 서버가 외부 폴더에서 고정 목록만 `/media/...` 주소로 제공합니다.

| 환경 변수 | 기본 경로(이 PC) | 쓰는 파일 |
|---|---|---|
| `SEQ_DIR` | `D:/2026-09_ShinsegaeChristmas/007_Assets/HideSeek_Seq_1021` | `SC0A_Pat`·`SC0B_Roll`·`SC0C_Playful`·`SC1_Notice`·`SC2_Duck`·`SC3_Hidden_Clue`·`SC4_Return_To_Play` `.mp4` |
| `POSE_DIR` | `D:/2026-09_ShinsegaeChristmas/007_Assets/Hide_Seek/HideSeek_Snowman_Play_v02/01_Masters` | `H_Hidden.png`(안전 정지 화면) |

다른 PC에서는 `SEQ_DIR=... POSE_DIR=... npm start`로 바꿉니다. 폴더가 없으면 시작 때 경고를 출력하고 해당 주소는 404입니다.

## 화면과 조작

운영 화면은 9:16 무대만 보입니다(창 비율이 달라도 늘리지 않고 맞춤, 남는 곳은 검정). 개발 패널은 기본으로 숨어 있고, `D` 키나 주소 `?debug=1`로 엽니다. 패널은 무대 옆 칸에 열려 무대를 덮지 않습니다.

| 조작 | 동작 |
|---|---|
| `가까이`/`중간`/`멀리` 버튼, `N`/`M`/`F` 키(0.4 m / 0.9 m / 1.6 m) | 거리를 바꾸고 입력 상태를 정상 감지로 돌림 |
| 거리 슬라이더 | 거리 값만 바꿈(감지 없음·입력 오류 상태는 그대로 — 그동안 거리는 전송되지 않음) |
| `감지 없음` | 대상이 없는 정상 샘플 → 원거리와 같이 기본 놀이 |
| `입력 오류` / `전송 중단` | 오류 샘플 / 샘플 끊김(1.2초 뒤 stale) → 안전 정지(H 화면) |
| `정상 입력 재개` | 정상 감지로 돌리고 전송 재개 |
| `O` 키, 패널 `유화 필터` | 유화 후처리 켬·끔(실패 후 다시 켜면 새로 시험) |
| 패널 `원본 비교` | 화면 왼쪽 절반을 필터 없는 원본으로 |
| `D` 키 | 개발 패널 표시 전환 |

거리 구간은 기획값(근거리 0.6 m 안, 중간 0.6~1.2 m, 원거리 1.2 m 밖)이고, 노이즈 여유·유지 시간·timeout은 **임시값**입니다. 모두 `public/display/config/settings.js` 한 곳에 있습니다.

## 문서

| 문서 | 내용 |
|---|---|
| [AGENTS.md](AGENTS.md) | AI 에이전트 작업 지침(역할, 검수, 검증, Git·worktree, 로그) |
| [docs/PROJECT.md](docs/PROJECT.md) | 목표, 체험 흐름(v02 스토리), 범위, 캐릭터·IP 참고, 단계 계획, 결정 필요 항목 |
| [docs/SYSTEM.md](docs/SYSTEM.md) | 기술 명세(구조, 3구간 판정, 상태·경계·오류, 외부 에셋, 유화 필터 출처·설정) |
| [docs/references/](docs/references/) | 사용자 제공 캐릭터 참고 이미지(실행 에셋 아님) |
| [docs/logs/](docs/logs/) | 작업 로그와 인계 |
