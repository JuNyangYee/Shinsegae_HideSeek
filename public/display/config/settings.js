// 표시 페이지 설정 — 한 곳에 모은다. 값을 바꾸면 docs/SYSTEM.md 9장 표도 함께 고친다.
// 표기: 기획값 = v02 스토리보드·SEQUENCE_PLAN의 거리(0.6 / 1.2 m), 실측값 아님.
//       임시값 = 모의 입력 확인용으로 정한 값(노이즈 여유·유지 시간·timeout 등). 실제 센서·현장에서 다시 정한다.
//       ThrowSnow 운영값 = 참고 프로젝트 RENDER_STYLE.post.oilStroke(HEAD 1fa49de)와 같은 값.

// 실행 영상 클립 표(재생하는 것만). file = /media/seq/ 아래 파일(서버 allowlist server/media.js에 있어야 한다), durationMs = 원본 영상 길이(ms, 24fps).
// inSec·outSec = 재생 편집 구간(초, 원본 기준). 원본 파일은 그대로 두고 재생할 때 이 구간만 쓴다(null이면 처음 / 원본 끝).
//   임시 편집값(2026-10-21, 오케스트레이터가 원본 0.5초 간격 프레임과 경계 프레임 쌍을 보고 정함 — 자동 정지 검출 결과 아님).
//   사용자 지적(앞부분이 뚝 끊김, 처음 숨을 때 놀람이 없음)에 따라 **초반이 많이 겹칠 때만** 앞을 덜어낸다:
//   SC0A는 초기 짧은 자세 대기만(0.25초), SC0B는 동작이 커지기 전 대기만(0.5초) 덜고 말미 머리 자세 복귀(8.0초)까지 보존해
//   SC0C 0초로 잇는다. SC0C·SC2는 처음부터(0초) — SC0C 초반 손·머리 움직임, SC2 머리 들고 놀라는 예비 동작 보존.
//   SC1은 0~1.5초 놀이 기본 자세를 덜고 본격 눈치챔부터. 남는 손·머리의 미세한 차이는 naturalBlendMs로 섞는다.
// SC3_Hidden_Clue(너구리 빼꼼)는 사용자 요청(2026-10-21)으로 재생하지 않는다 — 원본 파일은 저장소·서버 allowlist에 미사용 자료로 남지만
// 이 표에 없으므로 불러오지도 재생하지도 않는다.
// 실제 재생 길이(timeout 계산) = outSec − inSec(core/sequence.js clipPlayMs). 완료는 실제 영상 시각이 outSec에 닿았을 때(또는 ended)만 판단한다.
// cues = 자세 연결 구간(초, 원본 기준, 양끝 포함) — 놀이·눈치챔 중 거리 판정으로 다른 클립(SC2 0초·SC1 1.5초·놀이 시작의 눈사람 쪽
//   기본 자세)이 필요할 때, **실제 영상 위치가 이 안에 있을 때만** 그 자리에서 잇는다(사용자 요청 2026-10-21 "고정시간으로 끊지 말고
//   적정 시간에 교체"). 임시 연출값: 오케스트레이터가 원본을 0.25초 간격·후보 양끝 0.125초로 네 캐릭터를 함께 눈으로 비교해 정함 —
//   완전히 같은 자세나 자동 인식이 아니다(SC0A 중간 구간은 여우 팔이 조금 높음). 도착 자세가 모두 같은 기본 놀이 계열이라 목적별 구분은
//   없다(필요하면 cue에 targets: ['duck'] 등을 줄 수 있다). 구간이 없으면 정상 out까지 재생한다 — SC0B는 중간 호환 자세가 없어
//   큰 동작 직후 요청이면 6.75초까지(최대 약 6초) 기다릴 수 있고, SC0C도 최대 약 5.6초. 거리 요청이 없으면 구간에서 자르지 않는다.
// SC1b_Glance(중간 거리 곁눈질)는 아직 영상이 없다(file null). 생기면 file·durationMs를 채우고 server/media.js allowlist에 추가한다.
// 정/역방향 짝(mirrorOf·frames·fps): SC4와 그 역순 파생 영상(SC4R, 사용자 요청 2026-10-21 — 복귀 도중 다시 다가오면 같은 자세에서 되돌아 숨기).
//   SC4R 프레임 j = SC4 원본 프레임 (frames − 1 − j). 둘 다 169프레임, 24fps, 마지막 프레임 PTS 7.0초(길이 7.041667초와 1프레임 차이).
//   SC4 재생 구간 0.50~6.00초(프레임 12~144)에 대응하는 SC4R 구간은 1.00~6.50초(프레임 24~156). SC4R의 끝(6.5초)이 모두 숨은 자세다.
//   짝 사이 전환은 지금 보이는 프레임의 대응 지점부터 시작한다(scene/seq-player.js mirrorStartSec). hiddenSec = 모두 숨은 자세의 시각
//   (짝 영상이 아직 화면에 나오기 전에 반전하면 보이는 것은 숨은 자세이므로 여기서 시작).
const cues = (...ranges) => Object.freeze(ranges.map(([fromSec, toSec]) => Object.freeze({ fromSec, toSec })));
const CLIPS = Object.freeze({
  SC0A_Pat: Object.freeze({
    file: 'SC0A_Pat.mp4', durationMs: 8042, inSec: 0.25, outSec: 7.25, title: '눈사람 다듬기',
    cues: cues([0.25, 0.375], [2.375, 2.625], [4.125, 4.25], [6.5, 7.25]), // 초반 기본 자세 · 손 내려놓는 박자 2회 · 말미 복귀
  }),
  SC0B_Roll: Object.freeze({
    file: 'SC0B_Roll.mp4', durationMs: 8042, inSec: 0.5, outSec: 8.0, title: '작은 눈덩이 굴리기',
    cues: cues([0.5, 0.75], [6.75, 8.0]), // 초반 기본 자세 · 굴리기를 마치고 몸·손·시선이 돌아온 뒤(2.5~5.5초 전면 자세는 제외)
  }),
  SC0C_Playful: Object.freeze({
    file: 'SC0C_Playful.mp4', durationMs: 8042, inSec: 0, outSec: 7.75, title: '눈 털며 장난치기',
    cues: cues([0, 0.5], [1.5, 1.875], [7.5, 7.75]), // 초기 동작 · 몸을 크게 돌리기 전 손을 둔 구간 · 말미 복귀
  }),
  SC1_Notice: Object.freeze({
    file: 'SC1_Notice.mp4', durationMs: 8042, inSec: 1.5, outSec: 6.75, title: '놀다가 눈치챔',
    cues: cues([1.5, 2.75], [6.25, 6.75]), // 고개를 크게 들어 관객 쪽을 보기 전 · 눈사람 쪽으로 돌아온 뒤
  }),
  SC1b_Glance: Object.freeze({ file: null, durationMs: 8000, inSec: null, outSec: null, title: '놀며 곁눈질(영상 없음)' }),
  SC2_Duck: Object.freeze({ file: 'SC2_Duck.mp4', durationMs: 4042, inSec: 0, outSec: 3.5, title: '놀라서 그 자리에서 숨기' }),
  SC4_Return_To_Play: Object.freeze({
    file: 'SC4_Return_To_Play.mp4', durationMs: 7042, inSec: 0.5, outSec: 6.0, mirrorOf: 'SC4R_Rehide', frames: 169, fps: 24, hiddenSec: 0.5, title: '나와서 놀이 재개',
  }),
  SC4R_Rehide: Object.freeze({
    file: 'SC4_Return_To_Play_Reverse.mp4', durationMs: 7042, inSec: 1.0, outSec: 6.5, mirrorOf: 'SC4_Return_To_Play', frames: 169, fps: 24, hiddenSec: 6.5,
    title: '복귀 역방향(다시 숨기)',
  }),
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
  // 실센서 입력 안정화(임시값, 2026-10-23): 판정 앞에서 단발 거리 튐·짧은 무감지(n=0)만 다룬다. 지속적인 잘못된 측정은 고치지 못한다.
  // 개발 패널에서 바꾸면 로컬 서버의 .local/ 파일에 저장되고 이 값보다 우선한다(config/input-settings.js).
  stabilize: Object.freeze({
    medianWindow: 3, // 최근 감지 거리 N개의 중앙값(1이면 끔). 창이 다 찰 때까지는 판정에 보내지 않는다
    absentGraceMs: 350, // 감지 중 n=0이 이 시간(ms) 안이면 직전 안정화 거리를 유지, 넘으면 감지 없음
  }),
  // 실센서 입력(ESP32 → 로컬 서버 → 같은 origin SSE). 서버가 시리얼을 읽는다(server/sensor/).
  sensor: Object.freeze({
    eventsUrl: '/api/sensor/events',
    apiBase: '/api/sensor/',
    source: 'mmwave',
  }),
  sequence: Object.freeze({
    clips: CLIPS,
    playCycle: PLAY_CYCLE, // 원거리·감지 없음: 기본 놀이 A → B → C 순환
    midIdleCycle: MID_IDLE_CYCLE, // 중간 거리에서 눈치챈 뒤 대기
    noticeClip: 'SC1_Notice',
    duckClip: 'SC2_Duck',
    returnClip: 'SC4_Return_To_Play',
    rehideClip: 'SC4R_Rehide', // 복귀 도중 near: 지금 자세에서 거꾸로 숨기(SC4 역방향 파생 영상)
    // 임시값: 다른 영상으로 넘어갈 때(클립 끝·자세 연결 구간) 이전 화면(멈춘 마지막 프레임)과 새 영상을 섞는 시간(ms, 유화 앞에서 섞음).
    // 새 영상은 섞는 동안에도 재생된다(정지 시간 추가 없음). 다른 자세를 감추려는 용도가 아니다.
    // 안전 정지(H)·H 이미지에서 시작·같은 영상 재시작·복귀 정/역 반전은 섞지 않는다.
    naturalBlendMs: 150,
    playTimeoutMarginMs: 4000, // 임시값: 편집 구간 길이 + 이 여유(불러오기·탐색 포함) 안에 완료가 없으면 재생 오류(timeout)
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
    // 모의 입력(개발용). 개발 패널에서 '모의 입력'을 고르거나 숫자 1/2/3을 누른 뒤에만 판정에 쓰인다(시작은 실센서).
    source: 'mock',
    sampleIntervalMs: 100, // 모의 샘플 발행 간격(ms)
    initialDistanceM: 1.6, // 시작 거리(m): 원거리
    nearPresetM: 0.4, // "가까이"·N·1 키
    midPresetM: 0.9, // "중간"·M·2 키
    farPresetM: 1.6, // "멀리"·F·3 키
    minDistanceM: 0,
    maxDistanceM: 3,
    stepM: 0.05,
  }),
  display: Object.freeze({
    tickMs: 100, // stale·재생 timeout 확인과 진단 갱신 간격(ms)
  }),
});
