# 2026-10-20-02 모의 근접 입력과 숨바꼭질 흐름

## 목표

모의 거리 입력 → 근접 판정 → 숨기·등장 시퀀스 → 임시 웹 화면을 연결한다(1단계). 실제 센서와 최종 영상은 이후 단계다.

## 경과

- 사용자 요청에 따라 초기 문서 커밋 `9deab80`을 `master`에 fast-forward 병합하고 `origin/master`에 push했다. 통합 worktree가 깨끗한 상태임을 확인했다. 이전 로그(`2026-10-20-01`)의 미병합·push 없음은 당시 상태이며, 이 기록으로 후속 완료를 남긴다.
- 기준 `refs/heads/master` (`9deab80`)에서 `task/mock-proximity-flow` 브랜치와 별도 worktree를 만들었다.
- Opus 5.5 / high / auto 구현 세션을 시작했으나 세션 사용량 한도에 걸렸다(앱 코드 변경 없음). 사용자가 2026-10-20 17:10(한국 시간) 한도 초기화 후 같은 모델로 계속하도록 선택했고, Paseo 재개 예약 `ca002b7f`(17:11, 1회)를 등록했다. 재개 지시서: `C:/Users/User/AppData/Local/Temp/hideseek-bootstrap-20261020/resume-after-limit.md`.
- 재개 후 구현 담당(claude / `claude-opus-5-5`, high, auto)이 요청서 `mock-flow-request.md`에 따라 구현했다. 하위 에이전트·검수자는 띄우지 않았다.

## 변경

- 추가 `package.json`(외부 의존성 0, `npm start` / `npm test`, Node ≥ 24), `package-lock.json`(`npm install --package-lock-only`로 생성, 패키지 설치 없음).
- 추가 `server/server.js`: 내장 `http` 정적 서버. `127.0.0.1`, 기본 포트 8091(`PORT`, `0` 허용), `public/`만 제공, GET/HEAD, `/` → `/display/`, 숨김·상위 경로 차단, MIME·404, 잘못된 PORT·사용 중 포트 오류 문구 후 종료 코드 1.
- 추가 `public/display/`:
  - `config/settings.js` — 임시 수치 한 곳(SYSTEM 8장 표와 같음).
  - `core/proximity.js` — 샘플 검증, 히스테리시스·연속 유지, 신호 공백·역행 처리, `no-target`/`error`/stale.
  - `core/sequence.js` — 4상태, 최신 판정 1개, 재생 ID, timeout=오류, `unknown`·재생 오류 시 숨은 상태 안전 대기, 재생 오류 후 재시도.
  - `input/mock-input.js`(샘플 연속 발행, 전송 중단은 실제로 끊김), `input/mock-controls.js`(슬라이더·프리셋·상태 버튼·N/F/D 키 → 어댑터).
  - `scene/dummy-player.js`(Web Animations API 재생, play/cancel·finished/error 계약), `scene/diagnostics.js`(진단 표).
  - `index.html`, `styles.css`, `main.js` — 눈 언덕·나무·덤불 무대와 CSS 더미 캐릭터, 조작부·진단, 조립.
- 추가 `test/proximity.test.js`(5개), `test/sequence.test.js`(6개, 검수 후 1개 추가해 7개).
- 수정 `README.md`(실행·조작법), `docs/PROJECT.md`(3.2절 1단계 범위·임시 선택, 단계 계획·미정 표 보완, 3.x 절 번호 한 칸씩 이동), `docs/SYSTEM.md`(구현/미구현 구분해 전체 갱신, 실제 폴더·샘플·판정·전환·오류 복구·설정값·실행법).
- `AGENTS.md`는 고칠 근거가 없어 수정하지 않았다.

## 결정과 이유 (모두 임시 선택, 사용자 확정 아님)

- 시작은 `hidden-idle` + `unknown`, 처음 `far` 안정 후 등장 — `unknown`을 `far`로 오인한 자동 등장을 막는다. 모의 기본 거리 3 m라 첫 화면은 약 0.6초 뒤 드러난다.
- `no-target`은 이전 안정 판정 유지, 후보만 끊음 — 센서 규격 확인 전 "멀어짐"으로 단정하지 않는다. 설정 항목은 아직 만들지 않았다.
- `error`·stale·재생 오류의 안전 대기 화면은 숨은 상태 — 초기 초안의 "마지막 정지 화면 / 숨은 상태" 미정을 이번에는 숨김으로 골랐다. 연출 없이 바로 숨긴다.
- 후보 유지 중 샘플 간격 한도 `maxSampleGapMs`(300 ms)를 추가 — 요청서 예시에 없던 값이다. 드문 샘플 두 개로 유지 시간이 채워지는 것을 막으려고 넣었다.
- 재생 오류 복구는 고정 대기(`playbackRetryDelayMs` 3초) 후 최신 판정 재평가 — 같은 `far`가 이어져도 영구히 막히지 않게 하되, 즉시 반복 재시도는 피한다.
- timeout 판정은 시퀀스 코어가 `nowMs`로 한다(타이머 길이로 성공 처리하지 않음). 기한을 넘긴 완료도 timeout으로 본다.
- 단축키는 `event.code` 기준 — 한글 입력 상태에서 `event.key`가 자모로 바뀌는 문제를 피한다.
- 진단·모의 조작부는 개발 화면이라 기본으로 보인다. 운영 화면에서 숨기는 것은 제안으로 남겼다.

## 검수 및 검증

- `npm test` 실행: 첫 실행은 `node --test test/`가 디렉터리를 모듈로 해석해 실패 → 스크립트를 `node --test`(기본 탐색)로 고침. 두 번째 실행에서 근접 판정 stale 시나리오가 실패 — `tick`이 `unknown` 전환 전 판정 값을 돌려주던 실제 결함을 고침. 세 번째 실행 11개 모두 통과.
- 브라우저 전용 모듈과 서버는 `node --check`로 문법만 확인했다.
- `git diff --check` 1회: 추적 파일은 그대로, 새 파일은 index를 건드리지 않게 `git diff --no-index --check`로 포함. 경고 없음. CRLF 없음.
- 설정 파일 값과 SYSTEM 8장 표·README 수치를 대조했다.
- **미검증(구현 직후 기준, 아래 절에서 갱신):** 서버 실행·HTTP 응답(오케스트레이터 smoke 예정), 브라우저 화면·애니메이션·레이아웃·반응형·단축키 실제 동작, 백그라운드 탭 복귀 동작, 실제 센서·현장 수치, 장시간 동작. 모든 동작 확인은 모의 입력·단위 테스트 기준이다.
- 간단 검수: 아래 "간단 검수와 수정" 절. 일반·Astra 검수는 요청하지 않아 실행하지 않았다.

## 오케스트레이터 실행 확인 후 수정

오케스트레이터가 `PORT=0`(자동 4262)로 띄운 로컬 서버에서 확인한 결과를 받아 반영했다. 구현 담당은 서버를 띄우거나 브라우저를 직접 확인하지 않았다.

- 오케스트레이터 HTTP smoke(오케스트레이터 실행 결과): `/` 302, `/display/` 200, `/display/main.js` 200, `/docs/PROJECT.md` 404, 인코딩된 상위 경로 404, `HEAD /display/` 200 빈 본문.
- 수정 1 — 확실한 표시 버그: 조작부 `refresh()`가 `mock.start()` 전에만 불려, 첫 화면이 "정상 감지 · 전송 중단"·`전송 중단` 버튼 눌림으로 보였다(실제로는 전송 중). `main.js`에서 `mock.start()` 뒤 `controls.refresh()`를 한 번 더 부르게 고쳤다.
- 조사 — 브라우저 재생 timeout: Chrome(자동화 환경)에서 첫 등장·숨기가 자주 timeout(`#1`, `#2`… 재시도)으로 끝나고, 가끔은 정상 완료됐다(`#12` 등장 완료 후 `#13` 숨기가 약 1.7초 뒤 timeout). `visibilityState`는 `visible`, 콘솔 경고·오류 0개, 판정·샘플 갱신은 정상(오케스트레이터 확인).
  - 소스 점검: 재생 취소 경로는 시퀀스 코어의 `cancel` 지시와 새 `play` 시작뿐이고, `duration`·`finished` 연결도 문제를 찾지 못했다. **원인은 확인되지 않았다.** 자동화 환경이 애니메이션 프레임을 제한하는지도 확인되지 않았다. timeout을 성공으로 바꾸지 않았다.
  - 최소 진단 추가: 재생기 `snapshot(nowMs)`과 진단 영역 "재생기 상태" 행. 진행 중 재생과 마지막으로 끝난 재생(완료·취소·오류 시점)의 `playState`·`pending`·`currentTime`(진행 ms/클립 길이)·실제 경과 ms를 보인다. timeout으로 취소될 때 `currentTime`이 실제 경과보다 크게 뒤처져 있으면 애니메이션 시계가 진행되지 않은 것이고, 클립 길이에 닿았는데 완료되지 않았다면 `finished` 처리 쪽을 의심할 수 있다.
- 검증: 바뀐 브라우저 모듈(`main.js`, `scene/dummy-player.js`, `scene/diagnostics.js`)은 `node --check`로 문법만 확인했다. 코어 모듈은 바뀌지 않아 `npm test`는 다시 돌리지 않았다. `git diff --check`(새 파일 포함) 1회 재실행.
- 이 시점의 상태(과거 기록): HTTP smoke 통과, 브라우저에서 숨기·등장 완료와 위 수정·진단의 동작은 확인 전이었다. 이후 결과는 다음 절.

## 오케스트레이터 Chrome 재확인 (수정 1·진단 추가 후 새로고침)

오케스트레이터가 실제 Chrome에서 확인한 결과다. 구현 담당은 브라우저·서버를 실행하지 않았다.

- 첫 화면 조작부 "정상 감지 · 전송 중", `전송 중단` 버튼 `aria-pressed=false` — 수정 1 확인.
- 첫 등장 `#1`: finished, 진행 900/900 ms, 실제 경과 917 ms → `visible-idle`, 오류 없음.
- 가까이 `#2`: 숨기 finished 700/700 ms, 실제 717 ms → `near`/`hidden-idle`, 오류 없음.
- 멀리 `#3`: 등장 finished 900/900 ms, 실제 932 ms → `far`/`visible-idle`, 오류 없음.
- 전송 중단: 보낸 샘플 347에서 멈춤, 경과 1487 ms에서 stale → `unknown`/`hidden-idle`.
- 정상 입력 재개 `#4`: 등장 finished 900/900 ms, 실제 1411 ms → `visible-idle`, 오류 없음.
- 콘솔 경고·오류 0개.
- 판단: 이 시나리오에서는 정상 완료를 확인했다. **최초 관측된 간헐 timeout의 원인은 여전히 확인되지 않았다.** 해결됐다고 보지 않으며 위 초기 관측은 그대로 둔다.

## 간단 검수와 수정

- 검수: codex / `gpt-6.1-sol`, xhigh, auto-review — Paseo 작업 ID `2f5496aa-968d-460b-82e4-8ad3b4a77aa7`. 지적 2건(필수 1, 권장 1). 검수자는 파일을 수정하지 않았다(오케스트레이터 전달 기준).
- 필수 1 — `core/sequence.js`의 `setDecision`이 새 판정을 저장하기 전에 재시도 대기 만료(`expire`)를 처리해, 재시도 시각을 막 넘긴 호출에서 들어온 새 판정 대신 이전 판정으로 전환을 시작할 수 있었다(예: `far` 재생 오류 100 ms → 재시도 3100 ms → `setDecision('near', 3101)`이 등장부터 시작). → 판정을 먼저 저장한 뒤 `expire`를 부르도록 순서를 바꿨다. `unknown` 즉시 안전 대기, timeout, 늦은 완료 무시는 그대로다. 회귀 시나리오 1개를 `test/sequence.test.js`에 추가했다.
- 권장 1(채택) — `index.html`의 고정 "1.2 / 2.0 m" 안내 → `main.js`가 `SETTINGS.proximity`의 `nearMaxM`·`farMinM`으로 안내 문구를 만든다.
- 검증: 구현 담당이 `npm test` 1회 실행해 12개 모두 통과. `main.js`는 `node --check`로 문법 확인. `git diff --check`(새 파일 포함) 1회. 오케스트레이터가 지적된 두 수정 지점과 회귀 테스트를 읽어 확인했다. 별도 모델 재검수나 전체 검증 반복은 하지 않았다.
- 최종 수정 후 오케스트레이터가 Chrome을 새로고침해 설정 안내(1.2 / 2.0 m), 정상 전송 표시, 최초 등장 #1 완료(`finished` 900/900 ms, 실제 경과 1615 ms), `visible-idle`, 최근 오류 없음과 콘솔 경고·오류 0개를 확인했다. 전체 조작 시나리오는 앞선 확인으로 갈음했다.

## 현재 확인 상태

- 확인됨: 순수 코어 단위 테스트 12개(모의 시각 기준), 오케스트레이터 HTTP smoke, 오케스트레이터 Chrome에서 모의 입력 기본 흐름(등장·숨기·재등장·전송 중단 stale·정상 재개) 정상 완료.
- 미확인: 최초 간헐 재생 timeout의 원인, 반응형 배치 전반, 백그라운드 탭 복귀, 장시간 동작.
- 범위 밖 미검증: 실제 센서, 현장 수치·설치 환경, 최종 영상·아트.

## 인계

- 브랜치: `task/mock-proximity-flow`, 기준 커밋: `9deab80` (`master`·`origin/master`와 같음)
- worktree: `C:/Users/User/.paseo/worktrees/0wbs9g4q/task-mock-proximity-flow`, workspace: `wks_112c33a5fa320bef`
- 구현 Paseo 작업 ID: `ab29e9af-c1ef-4511-8c8d-2b1ae1b6a285`, 요청서: `C:/Users/User/AppData/Local/Temp/hideseek-bootstrap-20261020/mock-flow-request.md`
- 상태: 간단 검수 완료·지적 2건 반영·오케스트레이터 확인 완료. 최종 변경과 이 로그를 함께 로컬 커밋으로 남긴다(해시는 이 파일을 추가한 커밋 참조). **이번 1단계는 master 미병합·push 없음.** 최초 간헐 재생 timeout 원인 미확인.
- 정리: 오케스트레이터가 띄운 테스트 서버(PID 62216)의 명령을 확인하고 종료했으며 작업용 Chrome 탭도 닫았다. 실행하려면 이 worktree에서 `npm start`를 사용한다.
- 남은 이슈: PROJECT 7장의 미정 항목(센서 모델·인터페이스, 실측 임계값, 시작 상태·안전 대기 화면 확정, 등장 캐릭터, 소스 형식, 에셋 정책 등).
- 다음 단계: 시퀀스 소스가 제공되면 2단계(영상 소스 연결)를 진행한다. 간헐 timeout이 다시 보이면 "재생기 상태" 진단의 취소 시점 값으로 원인을 좁힌다.
