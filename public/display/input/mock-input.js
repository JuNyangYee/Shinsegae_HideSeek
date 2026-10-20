// 모의 근접 입력 어댑터: 선택된 거리·상태를 일정 간격으로 공통 근접 샘플로 계속 내보낸다.
// 판정은 하지 않는다. "전송 중단"은 타이머를 멈춰 샘플이 실제로 끊기게 한다(stale 재현).

const MODES = new Set(['ok', 'no-target', 'error']);

export function createMockInput({
  source,
  sampleIntervalMs,
  initialDistanceM,
  minDistanceM,
  maxDistanceM,
  onSample,
  now = () => performance.now(),
}) {
  let distanceM = initialDistanceM;
  let mode = 'ok';
  let timer = null;
  let sentCount = 0;

  function emit() {
    const sample = { source, timestampMs: now(), status: mode };
    if (mode === 'ok') sample.distanceM = distanceM;
    sentCount += 1;
    onSample(sample);
  }

  function start() {
    if (timer !== null) return;
    timer = setInterval(emit, sampleIntervalMs);
    emit();
  }

  function stop() {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  }

  function setDistance(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return;
    distanceM = Math.min(maxDistanceM, Math.max(minDistanceM, n));
  }

  function setMode(next) {
    if (MODES.has(next)) mode = next;
  }

  // 정상 입력 재개: 정상 감지로 돌리고 전송을 다시 시작한다. 판정·연출은 정상 절차로 회복된다.
  function resumeNormal() {
    setMode('ok');
    start();
  }

  function getState() {
    return { source, distanceM, mode, sending: timer !== null, sentCount };
  }

  return { start, stop, setDistance, setMode, resumeNormal, getState };
}
