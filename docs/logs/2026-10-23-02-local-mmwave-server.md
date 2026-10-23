# 로컬 서버 실센서 직접 연결 — 2026-10-23

## 목표

- 사용자 요청: "해당 기능 분석해서, 로컬 서버로 따로 진행할 수 있게 연결해줘. 굳이 저 파이썬 안쓰도록. 웹 D 눌러서 나오는 패널에서 거리 등 조절할 수 있도록."
- 근거 분석: [2026-10-23-01 분석 로그](2026-10-23-01-mmwave-prototype-analysis.md). 참고 소스(읽기 전용): `D:/2026-09_ShinsegaeChristmas/007_Assets/Puuvila_mmwave`의 `src/main.cpp`, `tools/sensor_tool.py`, `platformio.ini`, `README.md`. 펌웨어·참고 프로젝트는 수정하지 않았다.
- 사용자 지시에 따라 재부팅할 수 없는 상황이므로 자동 재부팅·초기화·업로드 기능을 넣지 않았다. 구현 담당은 실제 포트를 열지 않았으며, 오케스트레이터의 후속 COM4 연결 확인은 아래 별도로 기록한다. 센서 명령은 전송하지 않았다.

## 변경

- **서버(`server/sensor/`, 새 파일):**
  - `protocol.js` — 줄 분할(512바이트 제한, 나뉜·붙은 조각), `presence`/`hb`/`boot`/`log`/`exist`/JSON 아님 구분과 숫자·범위 검증. `n=0` 거리는 버리고, `n>0`인데 거리 0 이하는 거절.
  - `serial-link.js` — 포트 목록(센서 보드 후보 VID 표시), 후보 1개일 때만 자동 선택, 목록 안 경로만 명시 연결, 해제(자동 재연결 취소), 3초 재연결, 연결 세대로 늦은 open·close·data 무시, 사용 중 안내(Python 툴 닫기), heartbeat와 거리 수신 시각 분리, 사용 가능 여부(연결·명령 처리 중 아님·speed 모드), 고정 명령 묶음 전송(줄마다 10초, 늦은 응답 무시, 시간 초과·새 연결 뒤 heartbeat 전 명령 금지).
  - `serial-backend.js` — `serialport` 13.0.0, 115200, `hupcl: false`, `rtscts: false`, `lock: true`. `server.js`만 불러온다.
  - `settings-store.js` — `.local/hideseek-settings.json`(앱 판정 설정·센서 희망값·최근 전송 기록), 임시 파일 → 이름 바꾸기, 저장 성공 때만 반영.
  - `api.js` — `/api/sensor/…` GET 상태·SSE, POST 포트 새로고침·연결·해제·앱 설정·센서 설정. loopback Host, 같은 origin, JSON, 4 KB, 허용 키. SSE 8개 제한·느린 수신자 끊기·지나간 프레임 재전송 없음.
- `server/app.js` — 넘겨받은 센서 API로 `/api/` 처리(없으면 기존과 같이 404). import만으로 장치를 열지 않음. `server/server.js` — 설정 불러오기, serialport backend(불러오기 실패 시 경고 후 실센서 없이 시작), 시작 후 자동 선택, 종료 때 SSE·타이머·포트 정리.
- **표시 페이지:**
  - `config/input-settings.js`(새) — 앱 판정 설정·센서 희망값 기본값·검증(서버 공용). `config/settings.js` — `stabilize`(중앙값 3, 무감지 유예 350 ms, 임시값)·`sensor`(SSE·API 주소) 추가.
  - `core/stabilizer.js`(새) — 짧은 중앙값·짧은 n=0 유예·프레임 공백·초기화. 프레임이 없으면 아무것도 내지 않는다.
  - `input/sensor-input.js`(새) — SSE 프레임 → 페이지 수신 시각 → 안정화 → 샘플. 오류·사용 불가·SSE 끊김은 오류 샘플, 형식 오류는 거절.
  - `input/sensor-panel.js`(새), `index.html`, `styles.css` — 입력 선택, 센서 연결·상태, 앱 판정 설정(적용·되돌리기·저장 위치), 센서 자체 설정(희망값·진행·최근 전송·실제 설정 알 수 없음). 판정 경계 안내 문구를 앱 판정 설정 영역으로 옮김. 관객 화면 변경 없음.
  - `main.js` — 판정 입력 선택(시작 실센서, 고른 입력만 판정에), 앱 판정 설정 적용 때·입력 전환 때 판정기·안정화 초기화, 진단 '판정 입력' 문구. `input/mock-controls.js` — 모의 조작·N/M/F는 모의 입력일 때만(실센서 중 N/M/F는 가로채지 않음), O·D는 항상. `core/proximity.js` — `rejectInput`(입력 어댑터 거절 알림, 기존 거절과 같은 처리)만 추가. `scene/diagnostics.js` — 입력 행 문구.
- `package.json`·`package-lock.json` — `serialport` 13.0.0 고정. `.gitignore` — `.local/`.
- 테스트 `test/sensor-local.test.js`(새, 최초 8개 + 검수 지적 회귀 2개).
- 문서: README(실행·Python 툴 닫기·실센서 연결·패널), PROJECT(현재 상태, 3.4절 새로 — 기존 3.4·3.5는 3.5·3.6, 단계 계획·결정 항목), SYSTEM(1~4장 구성, 9장 설정·패널·단축키, 10장 검증, 11장 새로).
- 시퀀스 규칙·자세 연결·역재생·영상·유화 값은 바꾸지 않았다.

## 결정과 이유

- **안정화를 브라우저에 둠:** 판정과 같은 페이지 시계(`performance.now()`)로 수신 시각을 재고, 판정의 stale·공백 규칙과 같은 시간축을 쓰기 위해서다. 서버는 프레임마다 사용 가능 여부를 붙여 보내기만 한다.
- **오류와 거절 구분:** 설정 중·연결 확정 전·존재 모드 프레임은 `error`(즉시 안전 정지). 숫자·범위가 틀린 단일 프레임은 거절(후보만 끊김) — 단발 형식 오류로 매번 H로 가지 않게 하고, 계속되면 기존 stale 규칙으로 unknown.
- **늦은 명령 응답:** 펌웨어는 설정 처리 직후 `cmd applied`를 쓰고 loop로 돌아와 heartbeat를 쓴다(소스 확인). 그래서 시간 초과·재연결 뒤에는 heartbeat를 받을 때까지 새 명령을 막아 늦은 응답이 새 명령을 끝내지 않게 했다.
- **센서 명령은 4줄 모두 보냄:** 실제 설정을 읽을 수 없어 "바뀐 항목만" 비교할 기준이 없다. 희망값 전체를 다시 지정한다(mode 1은 체크로 선택).
- **입력 전환·설정 적용 때 안전 정지에서 다시 판정:** 이전 거리·후보가 새 설정·입력에 섞이지 않게 하는 가장 단순한 방법. 개발 패널 조작이라 잠깐의 H 정지를 받아들였다(임시 선택).
- **SSE + JSON POST:** 추가 패키지(ws) 없이 같은 origin으로 충분하다.
- **가정:** 센서 희망값 기본 0.3~3.0 m·감도 10·미세 끔·mode 1(기존 툴 기록·기본값, readback 아님). 알려진 보드 칩 VID 3종. n>0 거리 0 이하 거절. 15 m 초과 거리 거절.

## 검수 및 검증

- 실행한 명령:
  - `npm install --save-exact serialport@13.0.0` — 22개 패키지 추가, 취약점 0. npm이 `@serialport/bindings-cpp`의 install script(node-gyp-build)를 실행하지 않았다는 allow-scripts 경고를 냈으나, `prebuilds/win32-x64/`의 미리 빌드된 바이너리로 `import('serialport')` 불러오기를 확인했다(포트는 열지 않음).
  - 설치된 `node_modules/@serialport/bindings-cpp/src/serialport_win.cpp`에서 hupcl → `DTR_CONTROL_ENABLE/DISABLE`, rtscts false → `RTS_CONTROL_DISABLE`, `dist/win32.js` 기본값 `hupcl: true`를 확인. `@serialport/stream` open 경로는 `set()`을 부르지 않는다.
  - `node --check`로 변경·추가 JS 문법 검사 — 통과.
  - `node --test test/sensor-local.test.js test/proximity.test.js test/server-media.test.js` — 19개 중 18 통과, 1 건너뜀(기존 심볼릭 링크 테스트, Windows EPERM), 실패 0.
  - `git diff --check` — 통과.
- 구현 담당은 전체 `npm test`(시퀀스·재생기 테스트는 이번 변경 영향 밖), 브라우저·실센서 확인(오케스트레이터 담당), 벤치마크를 실행하지 않았다. 브라우저 입력·패널·main 모듈의 단위 테스트는 추가하지 않았다. 오케스트레이터의 실제 확인 범위와 남은 미검증은 아래를 따른다.
- 간단 검수: `gpt-6.1-sol / xhigh / auto-review` 실제 설정으로 읽기 전용 1회. 필수 2건, 권장 없음. 두 수정과 회귀 검증은 아래 절에 기록했고, 오케스트레이터는 해당 분기·테스트의 수정 여부만 재확인했다. 일반·Astra 검수는 호출하지 않았다.

## 인계

- 브랜치 `task/local-mmwave-server`, worktree `C:/Users/User/.paseo/worktrees/0wbs9g4q/task-local-mmwave-server`, 기준 커밋 `bde38f880603224bfb83cc87a8016ba83e5d72dd`(master `ecd23fd` + 분석 로그).
- 이 기록 시점: 간단 검수·수정 완료, 오케스트레이터가 커밋·master 통합 준비 중. 아직 미병합·미push. 최종 통합 결과는 이 로그의 마지막 절로 보완한다.
- 다음 현장 단계: 실제 설치 위치에서 판정 경계·안정화 수치를 정한다. 센서 자체 설정 전송은 재부팅이 아니지만 센서 stop/start·saveConfig를 수행하므로 운영 시점을 정해 확인한다.
- 남은 이슈: 근거리(1.2 m 미만) 정확도·거리 튐 원인은 그대로(분석 로그). 센서 설정 readback 없음(펌웨어 변경 필요). 펌웨어 5초 무프레임 재탐색 빈틈. `package.json` description의 "1단계 모의 입력 프로토타입" 문구는 범위 밖이라 그대로 둠(제안: 정리).

## 간단 검수 후 수정

간단 검수(gpt-6.1-sol / xhigh / auto-review, 오케스트레이터 진행)의 필수 2건만 고쳤다. 구현 담당이 실제로 한 수정·검증만 적는다(실기기·브라우저 확인은 오케스트레이터 기록을 따른다).

1. **해석되지 않는 줄이 판정 후보를 끊지 않음:** `server/sensor/serial-link.js` `handleLine()`의 `case 'invalid'`(예: `dist:nan` → `bad-json`)가 수만 셌다. 유효하지 않은 presence와 같은 정책으로 프레임을 내보내게 했다 — 연결 확정 전은 `error`(not-connected), 설정 처리 중은 `error`(configuring), 그 밖은 `invalid`(사유 그대로) → 브라우저 `sensor-input`이 안정화를 비우고 `rejectInput`.
2. **늦은 포트 목록 조회가 연결 의도를 되살림:** 같은 파일에 연결 의도 토큰(`intentSeq`)을 두고 `connect()`·`autoSelect()`가 시작할 때 올리며, `disconnect()`·`shutdown()`도 올린다. 목록 조회를 기다린 뒤 토큰이 바뀌었으면 `connect()`는 `superseded`로 끝나고(열지 않음, want 그대로), `autoSelect()`는 아무것도 하지 않는다. 기존 handle 세대 보호·재연결 정책은 그대로.

- 회귀 테스트(`test/sensor-local.test.js`에 2개 추가): JSON 오류 줄 → `invalid`/`bad-json`, 설정 처리 중 → `error`/`configuring`; 연결 직후 해제·앞 연결의 늦은 조회·자동 선택 중 해제/종료가 포트를 열지 않음.
- 실행: `node --test test/sensor-local.test.js` — 10개 모두 통과. `node --check server/sensor/serial-link.js` 통과. `git diff --check` 통과.
- 실행하지 않음: 전체 테스트, 브라우저, 서버 실행, 실제 포트 열기, 센서 명령(요청 범위 밖). 수정 후 실기기 동작은 미검증.
- 문서: README 첫 단락과 PROJECT 6장 단계 3의 확인 상태를 오케스트레이터의 실기기 확인 사실(기본 COM4 수신·브라우저 연결)에 맞게 정정했다.
- 커밋 안 함, 미병합·미push.

## 오케스트레이터 확인

- 구현은 Claude Code `claude-opus-5-5 / high / auto`, 세션 `7ae880ec-697e-4f9e-b2e9-66097a993cb9`. 기존 runner의 임시 복사본에 사용자 지정 모델·effort·mode 인자만 추가했다(전역 스킬 수정·권한 우회 없음). init 이벤트의 모델/권한 모드와 CLI effort를 확인했다. 최초 실행 중 Bash 문자열 인용 오류 1건은 해당 명령만 실패했고 이후 정상 편집 및 문법 검사로 복구했다.
- 간단 검수 세션 `b6fff775-26a4-4c23-8f9e-89f99761e856`의 실제 `gpt-6.1-sol / xhigh / auto-review`를 확인했다. 검수자는 파일·프로세스 수정이나 실행 검증을 하지 않았다. 지적 2건은 같은 Claude 세션이 수정했고 root는 그 분기와 추가 회귀 테스트를 읽어 확인했다.
- **패널/모의 입력:** 별도 임시 포트 8092와 Paseo 내장 브라우저에서 D 표시 전환, 실센서 선택 중 N 키 미작동, 모의 입력의 N/F로 near→hidden 및 far→play 확인. 숨기 경계 0.6→0.7 저장 후 페이지 새로고침 유지, 잘못된 경계 2.0(원거리 1.2) 거절 및 적용값 유지, 이후 기본값 복원. 9:16 무대 옆 패널의 스크롤·숫자 입력·상태 표시를 화면으로 확인했고 콘솔 오류는 없었다. 유화는 확인 시점 12 그림/s로 표시됐다(장시간 성능 검증 아님).
- **실제 연결:** Python `sensor_tool.py` 프로세스가 COM4를 점유할 때 실제 Access denied 안내·3초 재시도·unknown/H를 확인했다. 해당 Python 프로세스의 경로/PID를 확인해 종료한 뒤 Node 서버가 COM4(CH343 1a86:55d3)를 자동으로 열었다. Python 파일·설정·펌웨어는 수정하지 않았다.
- **재부팅 관측:** 전환 전 기존 Python의 WebSocket으로 읽은 heartbeat 가동시간 5353초(15:05:09 KST) → Node 직접 수신 5393초로 이어졌고, Node의 boot 메시지 수는 0이었다. 이번 연결에서는 재부팅이 관측되지 않았다. 모든 드라이버·PC에서의 무재부팅 보장은 아니다.
- **실제 수신/판정:** 16.7초 동안 감지 프레임 167개(약 10 Hz), 당시 거리 약 0.7~0.8 m, 형식 오류 0. 원본 n=0와 안정화 거리 유지(유예) 표시도 관측했다. 패널의 앱 숨기 경계를 1.0 m로 바꿨을 때 실제 약 0.75 m 입력으로 near/hidden이 됐고, 기본 0.6/1.2 m로 복원한 뒤 mid·복귀를 확인했다. 사람이 실측 이동한 시험이 아니라 **수신 중인 실제 거리 + 앱 경계 변경** 확인이다. 튐 원인·정확도 해결을 뜻하지 않는다.
- **해제:** 패널 해제로 conn=idle, want=false, 재연결 예약 없음과 즉시 unknown/H를 확인하고 몇 초 뒤에도 해제 상태임을 확인했다. 임시 8092 서버는 포트를 해제한 후 종료했다.
- **미검증:** 센서 자체 설정 버튼의 실제 장치 명령 전송·응답 시간·적용값(가짜 backend 테스트만), USB 물리 분리/재삽입, 센서 측정 정확도·현장 동선·장시간 운전, 최종 수정 2건을 실제 고장 데이터/지연된 포트 목록으로 재현하는 시험. 재부팅·펌웨어 업로드·센서 설정 명령은 수행하지 않았다.
