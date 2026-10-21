// 표시 페이지 설정 — 한 곳에 모은다. 값을 바꾸면 docs/SYSTEM.md 9장 표도 함께 고친다.
// 표기: 기획값 = v02 스토리보드·SEQUENCE_PLAN의 거리(0.6 / 1.2 m), 실측값 아님.
//       임시값 = 모의 입력 확인용으로 정한 값(노이즈 여유·유지 시간·timeout 등). 실제 센서·현장에서 다시 정한다.
//       ThrowSnow 운영값 = 참고 프로젝트 RENDER_STYLE.post.oilStroke(HEAD 1fa49de)와 같은 값.

// 영상 클립 표. file = /media/seq/ 아래 파일(서버 allowlist server/media.js와 같아야 한다), durationMs = 실제 영상 길이(ms, 24fps).
// durationMs는 **재생 timeout 계산에만** 쓴다(완료는 실제 ended 이벤트로만 판단).
// SC1b_Glance(중간 거리 곁눈질)는 아직 영상이 없다(file null). 생기면 file·durationMs를 채우고 server/media.js allowlist에 추가한다.
const CLIPS = Object.freeze({
  SC0A_Pat: Object.freeze({ file: 'SC0A_Pat.mp4', durationMs: 8042, title: '눈사람 다듬기' }),
  SC0B_Roll: Object.freeze({ file: 'SC0B_Roll.mp4', durationMs: 8042, title: '작은 눈덩이 굴리기' }),
  SC0C_Playful: Object.freeze({ file: 'SC0C_Playful.mp4', durationMs: 8042, title: '눈 털며 장난치기' }),
  SC1_Notice: Object.freeze({ file: 'SC1_Notice.mp4', durationMs: 8042, title: '놀다가 눈치챔' }),
  SC1b_Glance: Object.freeze({ file: null, durationMs: 8000, title: '놀며 곁눈질(영상 없음)' }),
  SC2_Duck: Object.freeze({ file: 'SC2_Duck.mp4', durationMs: 4042, title: '그 자리에서 숨기' }),
  SC3_Hidden_Clue: Object.freeze({ file: 'SC3_Hidden_Clue.mp4', durationMs: 4042, title: '숨은 채 작은 단서' }),
  SC4_Return_To_Play: Object.freeze({ file: 'SC4_Return_To_Play.mp4', durationMs: 7042, title: '나와서 놀이 재개' }),
});

const PLAY_CYCLE = Object.freeze(['SC0A_Pat', 'SC0B_Roll', 'SC0C_Playful']);
// 중간 거리 대기: SC1b가 있으면 그것을 반복, 없으면 기본 놀이 순환으로 대체한다(현재 대체 중).
const MID_IDLE_CYCLE = CLIPS.SC1b_Glance.file === null ? PLAY_CYCLE : Object.freeze(['SC1b_Glance']);

export const SETTINGS = Object.freeze({
  proximity: Object.freeze({
    // 구역(기획값): 거리 < nearBelowM → near, nearBelowM ≤ 거리 ≤ farAboveM → mid, 거리 > farAboveM → far.
    nearBelowM: 0.6,
    farAboveM: 1.2,
    // 노이즈 여유(임시값): 가까운 쪽 구역에서 **멀어질 때만** 경계를 이만큼(m) 더 넘어야 한다(다가갈 때는 기획값 그대로).
    retreatMarginM: 0.05,
    approachHoldMs: 350, // 임시값: 더 가까운 구역 후보가 이만큼(ms) 이어져야 판정이 바뀐다
    retreatHoldMs: 600, // 임시값: 더 먼 구역 후보(감지 없음 포함)·unknown에서 회복할 때 유지 시간
    staleMs: 1200, // 임시값: 마지막 정상 샘플 후 이만큼(ms) 새 샘플이 없으면 stale → unknown
    maxSampleGapMs: 300, // 임시값: 후보 유지 중 샘플 간격이 이보다(ms) 벌어지면 유지 시간을 새로 센다
  }),
  sequence: Object.freeze({
    clips: CLIPS,
    playCycle: PLAY_CYCLE, // 원거리·감지 없음: 기본 놀이 A → B → C 순환
    midIdleCycle: MID_IDLE_CYCLE, // 중간 거리에서 눈치챈 뒤 대기
    noticeClip: 'SC1_Notice',
    duckClip: 'SC2_Duck',
    hiddenClip: 'SC3_Hidden_Clue',
    returnClip: 'SC4_Return_To_Play',
    // 임시값: 숨은 대기 중 SC3(숨은 단서)를 1회 재생하기까지의 랜덤 대기(ms). 숨은 대기에 들어갈 때마다 이 범위에서 한 번 추첨한다.
    hiddenClueDelayMs: Object.freeze({ minMs: 8000, maxMs: 16000 }),
    playTimeoutMarginMs: 4000, // 임시값: 클립 길이 + 이 여유(불러오기·탐색 포함) 안에 ended가 없으면 재생 오류(timeout)
    playbackRetryDelayMs: 3000, // 임시값: 재생 오류 후 이만큼(ms) 안전 정지한 뒤 다시 판단
  }),
  media: Object.freeze({
    seqBase: '/media/seq/',
    safeStillUrl: '/media/pose/H_Hidden.png', // 안전 정지(H, 모두 숨음) — unknown·오류·시작
  }),
  render: Object.freeze({
    // 무대(9:16). 내부 처리 크기: 짧은 변 oilStroke.referenceShortSide(1080) → 1080 × 1920.
    aspect: Object.freeze({ width: 9, height: 16 }),
    renderFps: 12, // ThrowSnow SEQ.renderFps(사용자 결정 2026-10-20): 그리기(필터) 박자. 영상 자체는 24fps 1배속으로 재생한다
    maxPixelRatio: 2,
    oilEnabled: true, // 처음 유화 필터 켬(O 키로 끄고 켬)
    compareSplit: 0.5, // 원본 비교를 켜면 화면 왼쪽 이 비율을 필터 없는 원본으로
    // ThrowSnow RENDER_STYLE.post.oilStroke 운영값(HEAD 1fa49de). faceProtect만 영상 기준 0(ThrowSnow 영상 레이어 SEQ.faceProtect false와 같음).
    oilStroke: Object.freeze({
      strength: 0.2,
      size: 0.9,
      boil: 0.05,
      grade: 1,
      split: 0,
      q: 0.5,
      referenceShortSide: 1080,
      flowSigma: 2.5,
      layers: Object.freeze([
        Object.freeze({ widthPx: 36, spacingPx: 15, lengthPx: 84, lod: 3.8, detailMin: 0 }),
        Object.freeze({ widthPx: 18, spacingPx: 8, lengthPx: 44, lod: 2.6, detailMin: 0.02 }),
        Object.freeze({ widthPx: 8, spacingPx: 4, lengthPx: 20, lod: 1.4, detailMin: 0.06 }),
      ]),
      refine: Object.freeze({ enabled: true, widthPx: 3.5, spacingPx: 3, lengthPx: 10, lod: 0.6, errorThreshold: 0.22 }),
      faceProtect: 0,
    }),
    recoverRetryMs: 1000, // 실행 중 그리기 실패 후 다시 시험하는 간격(ms)
  }),
  mock: Object.freeze({
    source: 'mock',
    sampleIntervalMs: 100, // 모의 샘플 발행 간격(ms)
    initialDistanceM: 1.6, // 시작 거리(m): 원거리
    nearPresetM: 0.4, // "가까이"·N 키
    midPresetM: 0.9, // "중간"·M 키
    farPresetM: 1.6, // "멀리"·F 키
    minDistanceM: 0,
    maxDistanceM: 3,
    stepM: 0.05,
  }),
  display: Object.freeze({
    tickMs: 100, // stale·재생 timeout 확인과 진단 갱신 간격(ms)
  }),
});
