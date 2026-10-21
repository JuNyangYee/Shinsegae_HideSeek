# 2026-10-21-04 시퀀스 전환 매끄럽게

## 목표

사용자 요청(2026-10-21): "시퀀스들이 거리에 따라 뚝뚝 끊기게 재생되는데 최소화, 시퀀스 끝나고 바뀐다든지. 다 숨은 뒤 너구리가 나왔다 들어갔다 하는 것은 랜덤하게 가끔 한번씩만. IDLE 연결부분 약1초 멈췄다가 시작하는 느낌 자연스럽게."

1. 정상 거리 변화는 진행 중 클립을 끝까지 재생한 뒤 최신 판정 하나만 반영한다(안전 정지 사유는 기존대로 즉시).
2. SC3_Hidden_Clue 무한 반복을 없애고 숨은 대기 → 랜덤 8~16초 뒤 1회 → 새 랜덤 대기로 바꾼다.
3. IDLE(SC0A/B/C) 연결의 약 1초 멈춤을 줄인다 — 재생 준비·표시 첫 그림 경로의 불필요한 대기를 줄이고, 실제 브라우저에서 확인할 수 있게 전환 지연을 계측한다.

## 경과

- 브랜치 `task/smooth-sequence-transitions`, 기준 master `d545900`, worktree `C:/Users/User/.paseo/worktrees/0wbs9g4q/task-smooth-sequence-transitions`(오케스트레이터 생성).
- 구현 담당: claude / `claude-opus-5-5`, high, auto. 하위 에이전트 없음. 서버·브라우저는 띄우지 않았다(오케스트레이터 담당). 커밋·병합·push는 오케스트레이터가 한다(구현 담당은 변경만 남김).
- 오케스트레이터 전달(작업 중):
  - 원본 IDLE 3개 ffmpeg `freezedetect`(n=0.001, d=0.25): SC0A 6.958~7.25 s(0.292 s), SC0B 7.292~7.542 s(0.25 s) 저변화 구간만, SC0C 없음. **원본에 약 1초 정지가 있다는 근거는 얻지 못함**(휴리스틱, 연출상 쉬는 동작까지 배제한 것은 아님). → 원본 트림·배속 없이 재생 준비·첫 그림 경로를 우선.
  - master `d545900` Chrome baseline: SC0B 재생 정상, 이전 SC0A 완료 정상, 그림/s 1·rAF/s 1, 마지막 그림 CPU 8.4 ms, 콘솔 경고·오류 0. 표시 교체가 다음 rAF까지 기다리는 구조라 이 환경에서 최대 약 1초 추가 지연이 가능 → 표시 변경 직후 첫 그림 경로와 계측 우선, 주기 전체를 `setInterval`로 바꾸거나 필터 값을 낮추는 확대 작업 금지.
  - SC3 4.04 s를 0.5초 간격 8프레임으로 확인: 너구리(후트)가 오른쪽 우체통 옆에서 한 번 고개를 내밀었다가 끝에 다시 숨는다 → 클립 편집 없이 "1회 → 랜덤 대기 → 1회" 정책으로 충분. 컨택트 시트는 저장소 밖 `C:/Users/User/AppData/Local/Temp/hideseek-smooth-20261021/hidden-clue-contact.jpg`.
  - 진행 중 diff 지적: 명시 탐색 경로가 `waitUntil(video, ['seeked'], () => false)`로 남아 영원히 끝나지 않음, rVFC 계측의 늦은 콜백 가드 확인 → 아래 변경에 반영.

## 원인 분석(코드 경로 기준, 실제 브라우저 미확정)

IDLE 전환 경로: 이전 클립 `ended` → 코어 `playbackFinished` → 재생기 `play`(동기, 지연 거의 없음) → `run`:
1. 준비 대기 후, **두 번째 순환부터는 다음 영상이 지난 회차 끝(ended)에 멈춰 있어 0초 탐색(`seeked`)을 기다렸다.** 탐색 시간은 측정된 적 없다.
2. `play()` 약속이 끝나야 `display`를 새 영상으로 바꾼다(그동안 이전 클립 끝 프레임 유지 — 의도된 동작).
3. **렌더러는 다음 rAF에서야 `display`를 읽어 교체·그림.** 관측 환경(rAF 약 1/s)에서는 이 단계만으로 최대 약 1초가 더해질 수 있다(오케스트레이터 지적과 같음).

1·3은 불필요한 대기라 줄였다. 2는 이전 프레임 유지 정책이라 유지했다. 브라우저의 유휴 영상 플레이어 정지(오래 멈춘 영상의 디코더 해제 후 재개 지연) 같은 브라우저 내부 원인 가능성은 코드로 확인할 수 없어 계측으로 확인하도록 했다(미확정). GPU·원본 탓으로 단정하지 않는다.

## 변경

- `core/sequence.js`
  - 정상 판정 변화로 진행 중 클립을 끊지 않는다(`shouldInterrupt` 제거). 판정은 마지막 하나만 저장, 클립이 끝나면 최신 판정으로 다음을 고른다. 빠르게 near → far로 돌아오면 지나간 near는 실행하지 않는다(큐 없음).
  - unknown·재생 오류·timeout·일시 중지는 기존대로 즉시 `safe`. 재생 ID·늦은 알림 무시·timeout 보호 유지.
  - 숨은 대기: H로 끝나는 단계(`safe`·`duck`·`hidden`)에서 near면 클립 없이 `hidden`에 들어가고 `clueAtMs`를 한 번 추첨(`hiddenClueDelayMs`). 시각이 되면 SC3 1회, 끝나면 near일 때 새로 추첨. 대기 중 mid·far면 바로 `return`. 안전 정지는 예약 취소. 시작 near·unknown 회복 near·일시 중지 해제 near도 숨은 대기부터.
  - `createSequenceDirector(cfg, { random })`로 추첨 함수 주입(기본 `Math.random`). `snapshot().clueAtMs` 추가.
- `config/settings.js`: `interruptPlayForNotice` 삭제, `hiddenClueDelayMs: { minMs: 8000, maxMs: 16000 }`(임시값) 추가.
- `scene/seq-player.js`
  - `waitFor` → `waitUntil(video, events, check)`: 이벤트마다 조건을 다시 확인. 준비 대기는 `readyState ≥ 2 && !seeking`을 `loadeddata`·`seeked`·`canplay`로 확인(미리 되감기 중인 영상이 재생 차례가 되면 그 탐색을 기다림 — `loadeddata`는 한 번만 오므로 이것만 기다리면 멈춤). 명시 탐색은 `currentTime = 0` 뒤 `!seeking`을 `seeked`로 확인.
  - `rewindIdle()`: 표시 교체 직후·안전 정지 직후, 지금 쓰지 않는 영상을 미리 0초로 되감는다. 표시 중·현재 재생·렌더러가 아직 그리는 요소(`isShown`)·불러오는 중·탐색 중·오류 요소는 제외. 숨은 대기의 끝 프레임은 표시 중이라 건드리지 않는다.
  - `onDisplayChange` 알림(`setDisplay`), `isShown` 옵션, 테스트용 `createVideoElement`·`createImage` 주입.
  - 전환 계측: 최근 6개 재생의 `prevEndedMs`·`requestMs`·`readyMs`·`playingMs`·`firstFrameMs`(`requestVideoFrameCallback`, 현재 토큰일 때 한 번만)·되감기 대기/탐색 여부. 소스별 `rewinds` 횟수.
- `scene/stage-renderer.js`: `refresh()` — 표시 변경 알림 때 rAF를 기다리지 않고 바로 교체·한 장 그림(복구 상태면 무시, 박자 격자는 그 그림부터). 그리기 본문을 `draw()`로 분리(동작 같음). `shownElement` getter, 마지막 교체 `swap { clip, kind, atMs, drawnMs }`를 `stats()`에. rAF 주기·필터 값은 그대로.
- `main.js`: 재생기에 `onDisplayChange: () => stageRenderer?.refresh()`, `isShown` 연결. `stageRenderer` 선언을 재생기 생성 앞으로 옮김(TDZ 방지).
- `scene/diagnostics.js`: '현재 단계'에 숨은 대기 단서까지 남은 시간, 새 행 '최근 전환'(끝 → 첫 그림, 끝 → 요청, 요청 기준 준비·재생 시작·첫 영상 프레임·첫 그림 ms, 최근 6개 끝 → 재생 시작 ms), 소스별 되감기 횟수. 개발 패널에만 보인다(운영 화면 표시 추가 없음).
- 테스트: `test/sequence.test.js` 새 정책으로 다시 씀(8개), 추가 `test/seq-player.test.js`(가짜 media 4개).
- 문서: README(임시값·연출 규칙·테스트 설명), PROJECT(2장 표·사용자 요청 2건, 3.3 임시 선택, 7장 미정 표), SYSTEM(3장 테스트, 6장 숨은 대기·판정 변화 규칙·폐지 규칙, 7.1 준비·되감기·계측, 7.2 즉시 그림, 9장 설정·진단, 10장 테스트). 과거 로그·AGENTS는 고치지 않았다.
- 에셋·유화 값·박자 설정·서버 변경 없음.

## 결정과 이유

- 숨은 대기 화면은 직전 `duck`·SC3 영상의 **마지막 프레임 유지**(새 지시 없음). H 이미지로 바꾸면 해상도·배치(941×1672 vs 480×852)가 달라 튈 수 있고, 같은 프레임 유지가 가장 단순하다. 안전 정지에서 시작한 경우는 이미 H 이미지다. — 임시 선택
- 표시 중인 같은 영상을 다시 재생할 때(숨은 대기 뒤 SC3 반복, 취소 뒤 같은 클립)는 재생 시작 때 탐색한다. 2버퍼를 만들지 않으려는 선택이며, 이때 탐색이 끝나며 첫 프레임이 먼저 보일 수 있다(SC3은 H→H). — 임시 선택
- 반응 지연: 진행 중 클립을 끝까지 재생하므로 놀이·눈치챔 중 near가 와도 최대 약 8초 뒤에 숨는다. 사용자 요청("시퀀스 끝나고 바뀐다든지")에 따른 것이며, 허용 여부는 PROJECT 7장 미정 표에 남겼다.
- 원본 영상 트림·배속·긴 크로스페이드·유화 값 변경은 하지 않았다(근거 없음, 지시).

## 검수 및 검증

- `node --test test/sequence.test.js test/seq-player.test.js`(명시 탐색 수정 후 실행, 코어 주석 한 줄 정리 뒤 한 번 더): **12개 통과, 0 실패.**
  - 코어: 완료 후 최신 판정(눈치챔·숨기·복귀), 빠른 near → far 무시, 숨은 대기·랜덤 1회·재추첨·tick 재추첨 없음·대기 중 mid 즉시 복귀, SC3 중 mid는 끝난 뒤 복귀, unknown 즉시·늦은 완료 무시·회복 near 숨은 대기·대기 중 unknown 예약 취소, timeout·재시도, 일시 중지·해제·예약 취소.
  - 재생기(가짜 media): 표시 교체 뒤에만 이전 영상 되감기, 되감기 중 재생 차례면 탐색 대기·재탐색 없음, 렌더러가 아직 그리는 요소 보호, 되감기 대기 중 취소 뒤 늦은 `seeked`에 시작·표시·알림 없음, 취소 뒤 같은 클립 재생 시 명시 탐색 완료 후 시작(수정 전 코드에서는 영원히 시작하지 않는 경로).
- `node --check`: `main.js`, `scene/stage-renderer.js`, `scene/diagnostics.js`, `scene/seq-player.js`, `core/sequence.js`, `config/settings.js` 통과.
- `git diff --check` 통과(아래 인계 시점).
- 구현 담당은 `npm ci`·서버·브라우저를 실행하지 않았다. 오케스트레이터가 아래 실제 브라우저 확인을 위해 이 worktree에서 `npm ci`를 실행했다.
- 하지 않음: 전체 `npm test`(근접 판정·미디어 서버는 바뀌지 않음), 장시간 벤치마크, GPU 가짜 환경 테스트, 실제 센서·설치 현장 확인.
- 간단 검수: 오케스트레이터 진행, 필수 없음·권장 1건(아래 "간단 검수 후 수정").

## 간단 검수 후 수정

- 권장 1 — `enterHiddenWait()`가 `noticed`를 켜지 않아, 최초 near·unknown 회복 near로 숨은 대기에 바로 들어가면 진단 '관객 인지'가 SYSTEM 6장 설명(숨은 상태는 관객을 이미 안 상태)과 달랐다. `core/sequence.js` `enterHiddenWait()`에서 `noticed = true`로 맞췄다(near에서만 들어오므로 클립을 시작하는 단계와 같은 규칙). 전환 동작은 바뀌지 않는다.
- 테스트 보강: `test/sequence.test.js`의 시작 near 시나리오에 숨은 대기 진입 시 `noticed === true` 확인 1개 추가.
- 검증: `node --test test/sequence.test.js` 1회 — 8개 통과, 0 실패. `git diff --check` 통과. 전체 테스트·브라우저·서버 실행 없음, 미커밋.

## 오케스트레이터 브라우저 확인

- Chrome, 모의 입력, 유화 켬, 실제 저장소 에셋. 임시 로컬 서버 `127.0.0.1:3793`에서 확인했다. 서버 시작 직후의 의존성 경고는 이 worktree의 `npm ci` 전 기록이며, 설치 후 실제 페이지와 유화 표시가 정상 동작했다.
- IDLE A → B → C → A와 재사용된 B까지 진행했다. 관측한 연속 전환의 끝 → 재생 시작은 0~1 ms, 새 영상의 첫 그리기 완료는 8~10 ms였다. 되감기 횟수도 늘고, 재사용 IDLE에 추가 탐색 대기는 없었다.
- 위 수치는 앱의 재생/그리기 호출 계측이다. **실제 모니터에 표시된 시각을 측정한 값은 아니다.** 이 브라우저에서는 기존과 같이 rAF·지속 그리기가 약 1/s였다. 첫 영상 프레임 콜백은 발생했지만 약 61~1007 ms 뒤에 관측됐다. 따라서 전환 코드의 추가 대기를 줄인 것은 확인했으나, 설치 화면에서 체감하는 약 1초 정지가 모두 해소됐다고 단정하지 않는다. 낮은 rAF 원인은 미확정이다.
- SC0B 재생 약 2.7초에 근거리 입력을 넣었고, 다음 상태에서 SC0B의 결과가 `완료`인 채 SC2로 전환됨을 확인했다(취소 없음). SC3 중 원거리 입력 후에도 복귀를 거쳐 놀이 순환으로 돌아왔다.
- SC2 끝 → SC3 요청의 숨은 대기는 8.027초, 다음 두 대기는 9.229초·8.149초였다. SC3 1회 완료 뒤에는 진행 클립 없이 마지막 SC3 화면을 유지하며 새 대기 시간을 표시했다. 같은 SC3 재생 때 탐색은 3~4 ms였으며 멈춰 있지 않았다. 같은 텍스처를 쓰는 SC3 반복의 첫 그리기 계측은 `-`로 남는다(표시 교체 계측의 한계).
- 콘솔 경고·오류 0, 진단 최근 오류 없음. 실제 화면의 장기 부드러움·유휴 디코더 복구·설치 PC 성능·실제 센서는 미검증이다.
- 간단 검수 실제 설정: `gpt-6.1-sol / xhigh / auto-review`, 기준 `d545900` 대비 최종 diff, 읽기 전용 1회. 필수 없음, 권장 1건은 위대로 수정했고 오케스트레이터가 해당 코드와 assertion만 다시 확인했다. 추가 일반/Astra 검수는 하지 않았다.
- 구현 실제 설정: `claude-opus-5-5 / high / auto`, Claude 세션 `350c7c6a-5da0-40b4-b85f-73396463d7d4`.
- 화면 기록은 저장소 밖 `C:/Users/User/AppData/Local/Temp/hideseek-smooth-20261021/transition-diagnostics.png`에 보관한다.
- 최종 수정 후 페이지를 다시 불러오고 운영 화면 `final-preview.png`를 같은 임시 폴더에 저장했다. 오케스트레이터가 띄운 baseline 서버(PID 58560, 3727)와 수정본 서버(PID 62596, 3793), 확인 탭을 모두 종료했다. 사용자 서버는 건드리지 않았다.

## 인계

- 브랜치 `task/smooth-sequence-transitions`, 기준 master `d545900`, worktree `C:/Users/User/.paseo/worktrees/0wbs9g4q/task-smooth-sequence-transitions`.
- 상태: 구현·간단 검수·필요 수정·브라우저 확인 완료. 구현 커밋 `4d454bc`를 master에 fast-forward 병합하고 origin/master에 push 완료.
- 남은 이슈: rAF가 낮은 원인 미확정, 설치 화면의 체감과 반응 지연 허용 여부·숨은 단서 간격 미정(PROJECT 7장), `AGENTS.md` 에셋 규칙 갱신 미반영(이전 로그의 기지 제약, 이번 범위 밖).
- 다음 단계: 설치 화면에서 연결 체감과 최대 약 8초의 거리 반응 지연을 확인하고 필요할 때 해당 항목만 조정한다.

## 통합 기록

- 구현 커밋: `4d454bc` (`fix: 시퀀스 경계 전환과 IDLE 연결 개선`). 작업 worktree에서 새 테스트·로그를 포함한 staged diff check 통과 후 커밋했다.
- 통합 checkout: `D:/2026-09_ShinsegaeChristmas/006_Works/001_HideSeek`, 실제 브랜치 `master`, 병합 전 clean 확인. fetch 후 origin/master와 차이 0/0을 확인했다.
- `git merge --ff-only task/smooth-sequence-transitions` 성공: `d545900` → `4d454bc`. `git push origin master` 성공, master와 origin/master 일치·clean 확인.
- 이 통합 기록은 별도 문서 커밋으로 남긴다. 기존 브랜치·worktree는 보존했다.
