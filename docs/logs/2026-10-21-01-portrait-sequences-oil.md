# 2026-10-21-01 세로 시퀀스 영상과 유화 필터

## 목표

사용자 요청(2026-10-21): ThrowSnow 최신 구조를 확인하고, 제공 영상(HideSeek_Seq_1021)과 Hide_Seek v02 자료·첨부 스토리보드 기준으로 숨바꼭질을 업데이트한다. 세로 9:16, 시퀀스 위에 ThrowSnow와 같은 유화 필터. 로컬 PC 하드웨어 체험 앱이며 배포·DB·WebSocket·실제 센서·새 영상 생성은 범위 밖.

## 경과

- 기준: `task/mock-proximity-flow` = `5a69779`(1단계, master 미병합)에서 `task/portrait-sequences-oil` 브랜치·worktree 시작(오케스트레이터 생성).
- 구현 담당: claude / `claude-opus-5-5`, high, auto. 하위 에이전트 없음. 서버·브라우저는 띄우지 않았다(오케스트레이터 담당).
- 읽은 자료(모두 읽기 전용, 수정 없음): 저장소 README·AGENTS·PROJECT·SYSTEM·최신 로그 / ThrowSnow HEAD `1fa49de283a46cd8ca73da5a7d50e6b77a32e842`의 `render/oil-stroke-fx.js`·`oil-strokes.js`·`post-fx.js`·`render-support.js`·`render-mode.js`·`frame-loop.js`, `scene/seq-scene.js`·`seq-media.js`, `core/seq-portrait.js`, `config/display-config.js`(oilStroke·SEQ.renderFps), `server/static.js`(vendor 방식) / Hide_Seek `LATEST.md` → v02 README·SESSION_HANDOFF·SEQUENCE_PLAN·CONTINUITY_GUIDE·manifest·REFERENCE_INDEX / 첨부 스토리보드 PNG.
- 영상 사실은 오케스트레이터 확인값을 그대로 썼다(전수 probe 다시 하지 않음): 7개 H.264 480×852 24fps 무음, SC0A/B/C·SC1 8.041667 s, SC2·SC3 4.041667 s, SC4 7.041667 s. 오케스트레이터가 SC0A·Notice·Duck·Return의 시작/중간/끝 프레임으로 P→P·P→H·H→P와 실제 가림을 확인했고, 원본이 합성 완료된 전체 화면 영상이므로 레이어 분해·크로마키 없이 한 영상 위에 후처리만 입히라고 전달했다.

## 변경

- 의존성: `three` **0.186.1 고정**(`npm install three@0.186.1 --save-exact`) — `package.json`·`package-lock.json`. 유일한 런타임 의존성.
- 서버
  - 추가 `server/app.js`: 요청 처리 분리(import 시 listen 없음). public/, `/vendor/three/three.module.js`·`three.core.js` 두 파일만, `/media/` 위임.
  - 추가 `server/media.js`: 고정 allowlist(영상 7 + `H_Hidden.png`), `SEQ_DIR`·`POSE_DIR` 환경 변수(기본은 이 PC 절대 경로), 디코딩 후 글자 그대로 일치, realpath로 폴더 바로 아래 일반 파일만, HEAD, 단일 bytes Range 206/416(여러 범위·If-Range는 무시하고 200).
  - 수정 `server/server.js`: 실행 진입점만(포트·오류 문구 유지, 미디어·three 폴더 경고, 시작 때 폴더 출력).
- 표시 페이지
  - `config/settings.js`: 3구간 기획값(0.6/1.2), 임시값(여유 0.05 m, 350/600 ms, stale·gap, timeout 여유 4000 ms, 재시도 3000 ms), 클립 표(실제 길이, SC1b `file: null`), 순환, 미디어 주소, 렌더(9:16, 12fps, ThrowSnow oilStroke 운영값, faceProtect 0), 모의 프리셋 0.4/0.9/1.6 m.
  - `core/proximity.js`: far/mid/near/unknown, 멀어질 때만 경계 여유, 방향별 유지 시간, `no-target` = far 구역 샘플, 기존 stale·역행·잘못된 시각·후보 단절 유지.
  - `core/sequence.js`: 6단계(safe/play/notice/duck/hidden/return), 즉시 끊기 규칙, 한 번짜리 전환 중 최신 판정 1개 보관, 눈치챔 기억, far/mid 순환 위치 분리, 재생 ID·timeout=오류·재시도, `setSuspended`·`retryNow`.
  - 추가 `scene/seq-player.js`: `<video>` 재생기(ended로만 완료, 토큰 가드, 늦은 시작 멈춤, 이전 프레임 유지 후 교체, 오류 요소 재생성, 자동 재생 막힘 표시, H 정지 이미지, dispose).
  - 추가 `scene/stage-renderer.js`: Three.js 9:16 무대, contain 배치, sRGB→선형 셰이더(seq-scene 방식), 경로 시험(post half→byte→direct), 유화 실패 시 원본 대체+오류, 그리기 불가 시 fatal·재시험, 12fps 박자, 텍스처 정리.
  - 추가 `render/oil-stroke-fx.js`·`render/oil-strokes.js`(ThrowSnow 그대로 + 출처 주석 4줄), `render/oil-post.js`(post-fx.js 유화 경로 축약 이식).
  - `main.js`·`index.html`·`styles.css`: 9:16 contain 무대(검정 여백), 운영 화면 패널 숨김(`?debug=1`·D), 패널은 옆 칸(좁으면 아래), 유화 체크·원본 비교, 무대 메시지(그리기 불가·자동 재생 막힘)와 유화 오류 띠, 탭 숨김·그리기 불가 일시 중지, import map.
  - `input/mock-controls.js`: M 키·중간 버튼, O 키, D = 패널 전환, 거리 프리셋은 정상 감지로 전송.
  - `scene/diagnostics.js`: 새 단계·재생기·그리기·유화·소스 상태·참고 행.
  - 삭제 `scene/dummy-player.js`(CSS 더미 재생기).
- 테스트: `test/proximity.test.js`·`test/sequence.test.js` 새 규칙으로 다시 씀, 추가 `test/server-media.test.js`(Range·HEAD·404 경로·심볼릭 링크·allowlist 일치).
- 문서: README(npm ci/start, 영상 경로, 단축키), PROJECT(v02 스토리·2단계 범위·SC1b 누락·Notice 실제 길이·친구 이름 대응 출처·미정 표), SYSTEM(전면 갱신). AGENTS는 바꿀 근거가 없어 유지. 과거 로그는 고치지 않았다.

## 결정과 이유 (임시 선택 — 사용자 확정 아님)

- 거리 경계: 0.6·1.2 m는 mid에 포함(스토리보드 "0.6m 안"·"1.2m 밖" 표현을 엄격한 부등호로 읽음). 노이즈 여유는 **멀어질 때만** 붙여 다가갈 때 반응 거리를 기획값 그대로 둔다.
- 유지 시간: 1단계의 350/600 ms를 방향별(다가감 350 / 멀어짐·회복 600)로 옮겼다.
- 감지 없음 = far(기본 놀이): v02 "입력 없음 = 기본 놀이"를 따라 1단계 임시 정책(이전 판정 유지)을 대체. error·stale은 unknown으로 분리 유지.
- 안전 화면 = H 정지 이미지: 시작·unknown·재생 오류·탭 숨김·그리기 불가. H에서 SC3(숨음)·SC4(복귀)가 바로 이어지므로 연결이 자연스럽다. 그래서 시작은 near면 숨은 루프, mid·far면 복귀부터.
- far → mid 때 놀이 루프를 바로 끊고 눈치챔(`interruptPlayForNotice`): 8초 루프 끝까지 기다리면 눈치챔이 무의미해진다. 끊는 순간 동작이 튈 수 있어 설정으로 둠.
- 복귀 후 mid는 눈치챔 없이 중간 대기: "눈치챔 기억"을 duck·hidden·return·notice 시작 때 켜고 far에서만 끈다.
- 중간 대기 = SC0 순환(SC1b 없음). far용·mid용 순환 위치를 따로 기억해 SC1b가 생기면 설정만으로 바뀐다.
- 영상은 Blob 전체 받기(ThrowSnow 방식) 대신 서버 Range로 직접 연다(요청 4번).
- 렌더러 경로·박자·색 공간은 ThrowSnow seq-scene·frame-loop 규칙을 따르되 단일 전체 화면 영상용으로 새로 썼다(render-support·render-mode·frame-loop 파일은 이식하지 않음).
- 유화 실패는 원본 대체 + 화면 띠 + 콘솔 오류. 원본 경로가 있으면 O로 유화를 다시 시험한다(깜빡임 방지). 사용할 그리기 경로가 전혀 없으면 공통 복구 상태에서 1초마다 자동 재시험한다(아래 검수 수정 반영).
- 자동 재생 막힘: 재생 오류로 안전 정지 + 무대 안내, 클릭·키 입력 때 `retryNow`.

## 검수 및 검증

- `npm test` **1회** 실행: 16개 중 15개 통과, 0개 실패, 1개 건너뜀 — 심볼릭 링크 시나리오는 Windows에서 링크 생성 권한이 없어(EPERM) 건너뜀(**미검증**). 실패가 없어 다시 돌리지 않았다.
- 바뀐 브라우저·서버 모듈 전부 `node --check`로 문법만 확인.
- 이식 파일: 오케스트레이터가 `oil-stroke-fx.js`·`oil-strokes.js`의 원본 대비 차이가 출처 주석 4줄뿐임을 확인(오케스트레이터 전달).
- `git diff --check` 1회(추적 파일) + 새 파일은 index를 건드리지 않게 `git diff --no-index --check`: 경고 없음. 텍스트 파일 CRLF 없음.
- 미검증 구분(최종 상태는 아래 "현재 확인 상태" 절): 구현 직후에는 브라우저·HTTP를 구현 담당이 확인하지 않았다(오케스트레이터 담당).

## 오케스트레이터 Chrome 첫 smoke 후 수정

오케스트레이터가 실제 Chrome에서 확인한 결과(구현 담당은 브라우저·서버를 띄우지 않음): 실제 세로 영상 표시, 유화 `post:half` 적용·칠함 확인 정상, SC0A/B/C 순환, mid → SC1_Notice, near → SC3 반복, 콘솔 오류 0, 눈에 보이는 필터 확인. 오케스트레이터 HTTP smoke는 루트 서버(PID 43456, 포트 14562)에서 오케스트레이터가 진행.

- 수정 1 — 유화 처리 크기: 실제 CSS 크기(734×1304@1.5)로 `post.setSize`해 내부가 1080×1918로 계산되던 것을, 고정 9:16(`render.aspect`) 기준으로 바꿔 **정확히 1080×1920**으로 둔다(`scene/stage-renderer.js`, 생성 때 한 번, resize에서는 캔버스만 바꿈). 화면 출력 크기는 실제 CSS를 그대로 쓴다. SYSTEM 7.2절 갱신.
- 수정 2 — 진단 문구: `noticed`를 '눈치챔 완료'로 보여 Notice 재생 중에도 완료로 오인될 수 있어 '관객 인지'로 바꿨다. SYSTEM 9장에 뜻을 적었다.
- 관측 — 그리기 1 그림/s(마지막 그림 약 8 ms), 영상 시간·`ended`는 정상(자동화 Chrome, 오케스트레이터 관측). 박자 코드(`due`)를 다시 읽었으나 ThrowSnow `createRenderCadence`와 같은 규칙이며 **명확한 결함을 찾지 못했다. 원인 미확정**, 박자 코드는 고치지 않았다. 설정은 12 그림/s이고 이 환경 실측은 1 그림/s다. 마지막 그림 시간은 CPU 제출 시간이라 GPU 비용은 포함하지 않는다.
  - 원인 구분용 진단만 추가: '그리기' 행에 설정 그림/s와 화면 갱신(requestAnimationFrame) 횟수/s. rAF/s도 약 1이면 브라우저가 화면 갱신 자체를 줄인 것(창 가림·자동화 환경 제한·GPU 지연 가능성), rAF/s가 높은데 그림/s만 1이면 박자·그리기 쪽을 의심한다.
- 검증: 바뀐 `scene/stage-renderer.js`·`scene/diagnostics.js`는 `node --check`로 문법만 확인. 코어·서버는 바뀌지 않아 `npm test`는 다시 돌리지 않았다. `git diff --check` 1회 재실행. 브라우저 재확인은 오케스트레이터가 한다(미확인).

## 오케스트레이터 루트 실행 확인 (오케스트레이터 결과)

구현 담당은 서버·브라우저를 띄우지 않았다. 아래는 오케스트레이터가 루트 서버(PID 43456, 포트 14562)로 확인해 전달한 결과다.

- HTTP 10항목 통과: `/display/` 200, 영상 HEAD 200·본문 0, `Range: bytes=0-15` 206·본문 16·총 1997176, 범위 초과 416, 미디어 폴더 목록·없는 SC1b·인코딩 상위 경로·docs·allowlist 밖 vendor 404, three 모듈 HEAD 200.
- Chrome: 실제 유화 `post:half` 출력·칠함 확인 정상, SC0A/B/C 순환, mid 진입 SC1_Notice, near 숨기 후 SC3 반복, far 복귀 SC4 완료 후 놀이, stale → unknown 안전 H·정상 재개, 유화 끄기(direct)와 다시 켜기, 정상 no-target → far → SC4 복귀 완료 → 놀이, 입력 error 즉시 safe. 콘솔 경고·오류 0.
- 첫 두 수정(1080×1920 고정, '관객 인지') 후 새로고침: 내부 정확히 1080×1920, '관객 인지' 표시 확인. 540×960 뷰포트에서 무대 540×960, 운영 화면 패널 숨김·원본 비율 유지 시각 확인 후 뷰포트 복원. 스크린샷 `Temp/hideseek-portrait-20261021/portrait-oil-preview.jpg`(저장소 밖).
- 그리기 1 그림/s일 때 화면 갱신(rAF)도 1/s, 직접(원본) 경로에서도 1/s. 브라우저가 주는 화면 갱신 호출 자체가 낮은 관측이다. **원인은 확정하지 않았고 설치 PC에서 12 그림/s를 보장한다는 뜻도 아니다.** 박자 코드는 고치지 않았다.

## 간단 검수와 수정

- 검수: codex / `gpt-6.1-sol`, xhigh, auto-review(읽기 전용) — Paseo 작업 ID `f560e676-cc22-4f2b-a490-7dfc9d699ab5`. 필수 2, 권장 1(채택). 검수자는 파일을 수정하지 않았다(오케스트레이터 전달 기준).
- 필수 1 — 안전 정지 이미지 실패·로딩 중 이전 영상 프레임이 남음(`seq-player.js` 이미지 실패를 콘솔만 기록, `stage-renderer.js`가 준비 안 된 이미지로는 교체하지 않음):
  - 렌더러: 표시 요청이 H 이미지인데 준비 전·실패면 이전 프레임을 유지하지 않고 **검정 가림 화면**(`shown.kind = 'cover'`)으로 바꾼다. 준비되면 이미지로 교체. 영상 사이 전환은 기존대로 이전 프레임 유지.
  - 재생기: 안전 이미지 실패 시 3000 ms마다 새 `<img>`로 다시 불러온다. 시도마다 세대 번호로 늦은 load·error를 무시, 실패한 이전 `<img>`는 src를 떼 텍스처가 정리되게 했다. 안전 정지 중이면 새 이미지를 표시 요소로 바꾼다. `stillStatus` 추가.
  - 조립·진단: 안전 정지 중 이미지 실패면 무대 가운데에 "안전 정지 화면(H 이미지)을 불러오지 못했습니다. 다시 시도하는 중입니다"(tick마다 갱신). 진단 '화면 표시'에 '가림 화면', 소스 행에 H 시도 횟수.
- 필수 2 — 원본 경로가 없을 때 유화 실패가 `oilFault`만 남기고 경로 null로 계속 머묾, 재시험이 `fault`일 때만 돌고 `oilFault`를 고려하지 않은 성공 판정으로 풀릴 수 있음:
  - `choosePath()`(복구 상태와 무관한 선택)와 `enterFaultIfNoPath()`를 두고, 경로 시험·유화 실패·칠함 확인 실패·직접 그리기 예외 뒤 **고를 경로가 없으면 공통 복구 상태**(`fault`)로 들어간다. 직접 그리기 예외는 직접 경로를 사용 불가로 표시(후처리가 되면 그쪽으로).
  - 복구(`tryRecover`, 1000 ms마다): 다시 시험해 **실제로 고를 경로가 생겼을 때만** 해제. 원본 경로가 있으면 유화 실패는 유지(원본 대체·경고 정책 그대로, 유화 재시도는 O). 원본 경로가 없고 후처리 시험만 통과하면 유화 실패를 지우고 후처리로 다시 시도(칠함 확인은 그 뒤 결과로 판단).
- 권장 1(채택, 문서 교정) — README의 슬라이더·프리셋 구분: 프리셋 버튼·N/M/F는 정상 감지로 돌리고, 슬라이더는 거리 값만 바꾸며 감지 없음·입력 오류 상태를 유지한다. 코드 동작은 바꾸지 않았다. SYSTEM 9장도 같은 문구로.
- 문서: SYSTEM 7.1·7.4절(안전 이미지 재시도, 공통 복구 상태, 안전 정지 화면 미준비), 9장(단축키 구분).
- 검증(작게): 바뀐 `scene/stage-renderer.js`·`scene/seq-player.js`·`scene/diagnostics.js`·`main.js`는 `node --check` 문법 확인. 렌더러 경로 분기는 정적으로 따라가 확인했다(원본 가능+유화 실패 → 원본·경고 / 원본 불가+유화 실패 → 복구 상태·1초 재시험 / 직접 예외+후처리 가능 → 후처리 / 실제 경로가 생길 때만 해제). DOM·GPU 가짜 테스트는 만들지 않았다. 코어·서버는 바뀌지 않아 `npm test`는 다시 돌리지 않았다. `git diff --check` 1회 재실행. **H 없는 `POSE_DIR`로 가림·재시도 실제 확인은 오케스트레이터 예정(미확인).**

## 현재 확인 상태

- 검수 수정 후 오케스트레이터 확인: 정상 서버 새로고침 후 SC4 완료 → SC0A 재생, 유화 `post:half`·내부 1080×1920·H ready, 콘솔 경고·오류 없음.
- H 누락 재현: 별도 임시 서버(PID 46960, 포트 6766)의 `POSE_DIR`만 저장소 밖 빈 임시 폴더로 설정. SC0 영상 재생 중 입력 오류 → unknown으로 바꾸자 이전 캐릭터 영상 대신 검정 가림 화면·H 실패 안내가 표시되고 재시도 횟수가 증가했다. 원본 H 파일을 **임시 폴더에만** 복사한 뒤 새로고침·조작 없이 `H ready(시도 11)`·H 정지 이미지로 복구하고 안내가 사라짐을 화면에서 확인했다. 원본 파일은 수정하지 않았다.
- 렌더러 공통 복구 수정은 경로 선택·예외·칠함 실패·재시험 분기를 코드로 재확인했다. GPU 오류를 강제로 만드는 실행 검증은 하지 않았다.
- 확인됨: 단위 테스트 15개 통과(1개 Windows 심볼릭 링크 권한으로 건너뜀), HTTP 10항목, Chrome 주요 흐름·유화 출력·레이아웃, 수정 후 정상 재생과 H 누락 가림·자동 복구. 변경 없는 코어·서버 테스트는 반복하지 않았다.
- 미확인: GPU 오류 후 공통 복구 상태의 실제 동작, 심볼릭 링크 차단, 낮은 그림/s의 원인과 설치 PC 성능, 탭 복귀·자동 재생 막힘 실제 경로, 장시간 동작.
- 범위 밖 미검증: 실제 센서, 현장 수치.
- 정리: 오케스트레이터가 만든 검증용 탭 2개와 서버(PID 43456·46960)를 종료했다. 다른 서버·사용자 탭은 건드리지 않았다. 임시 뷰포트 설정은 복원했다.

## 인계

- 브랜치: `task/portrait-sequences-oil`, 기준 커밋 `5a69779`(`task/mock-proximity-flow`, master 미병합)
- worktree: `C:/Users/User/.paseo/worktrees/0wbs9g4q/task-portrait-sequences-oil`
- 상태: 간단 검수 완료·지적 3건 반영(필수 2, 권장 1), 오케스트레이터의 제한된 수정 확인 완료. 이 로그를 포함한 로컬 커밋이 최종 변경 단위이며 해시는 해당 브랜치의 `git log -1 --format=%h`로 확인한다. master 미병합, push 없음.
- 남은 이슈: SC1b_Glance 영상 없음(대체 중), 즉시 끊기 순간의 동작 튐(실영상 검토 필요), 실측 임계값, 설치 PC 필터 성능, PROJECT 7장 미정 항목.
- 다음 단계: 사용자 요청 시 master 통합·push. 이어서 실제 센서 모델·통신 방식 확정과 설치 PC의 표시 성능 확인, SC1b 영상 확보 후 연결.
