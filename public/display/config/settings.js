// 1단계 프로토타입 설정 — 한 곳에 모은다.
// 모든 수치는 모의 입력 확인용 **임시값**이다. 실제 센서·현장 실측으로 정한 값이 아니다.
// 값을 바꾸면 docs/SYSTEM.md 8장 표도 함께 고친다.

export const SETTINGS = Object.freeze({
  proximity: Object.freeze({
    nearMaxM: 1.2, // 이 거리(m) 이하가 근거리 후보
    farMinM: 2.0, // 이 거리(m) 이상이 원거리 후보. 사이 구간은 이전 판정 유지
    nearHoldMs: 350, // 근거리 후보가 이만큼(ms) 이어져야 near
    farHoldMs: 600, // 원거리 후보가 이만큼(ms) 이어져야 far
    staleMs: 1200, // 마지막 정상 샘플 후 이만큼(ms) 새 샘플이 없으면 stale → unknown
    maxSampleGapMs: 300, // 후보 유지 중 샘플 간격이 이보다(ms) 벌어지면 유지 시간을 새로 센다
  }),
  sequence: Object.freeze({
    hideMs: 700, // 숨기 연출 길이(ms)
    revealMs: 900, // 등장 연출 길이(ms)
    playTimeoutMarginMs: 1000, // 연출 길이 + 이 여유(ms) 안에 완료가 없으면 재생 오류
    playbackRetryDelayMs: 3000, // 재생 오류 후 이만큼(ms) 안전 대기한 뒤 다시 판단
  }),
  mock: Object.freeze({
    source: 'mock',
    sampleIntervalMs: 100, // 모의 샘플 발행 간격(ms)
    initialDistanceM: 3.0, // 시작 거리(m). 원거리라 잠시 뒤 처음 등장한다
    nearPresetM: 0.8, // "가까이" 프리셋·N 키
    farPresetM: 3.0, // "멀리" 프리셋·F 키
    minDistanceM: 0,
    maxDistanceM: 5,
    stepM: 0.1,
  }),
  display: Object.freeze({
    tickMs: 100, // stale·재생 timeout 확인과 진단 갱신 간격(ms)
  }),
});
