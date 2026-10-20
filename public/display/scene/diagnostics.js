// 진단 영역: 입력·판정·시퀀스 상태를 사람이 읽을 수 있는 한국어로 보여 준다.

export const PHASE_LABELS = Object.freeze({
  'visible-idle': '보이는 대기',
  hiding: '숨는 중',
  'hidden-idle': '숨은 대기',
  revealing: '나오는 중',
});

const DECISION_LABELS = { unknown: '알 수 없음', near: '가까움', far: '멀어짐' };
const STATUS_LABELS = { ok: '정상 감지', 'no-target': '감지 없음', error: '입력 오류' };
const CLIP_LABELS = { hide: '숨기', reveal: '등장' };
const OUTCOME_LABELS = { finished: '완료', cancelled: '취소', error: '오류' };

const ROWS = [
  ['input', '입력 원본'],
  ['sample', '마지막 샘플'],
  ['age', '마지막 샘플 경과'],
  ['decision', '근접 판정'],
  ['candidate', '판정 후보'],
  ['phase', '현재 단계'],
  ['play', '재생 ID'],
  ['player', '재생기 상태'],
  ['error', '최근 오류'],
];

function formatSample(sample) {
  if (!sample) return '아직 없음';
  const label = STATUS_LABELS[sample.status];
  return sample.status === 'ok' ? `${label} · ${sample.distanceM.toFixed(1)} m` : label;
}

// 재생기의 실제 animation 상태. 애니메이션 진행(currentTime)과 실제 경과를 나란히 보여 준다.
function formatAnimation(info) {
  const time = info.currentTimeMs === null ? '-' : Math.round(info.currentTimeMs);
  return `#${info.playId} ${CLIP_LABELS[info.clip]} · ${info.playState}${info.pending ? ' (pending)' : ''}`
    + ` · 진행 ${time}/${info.durationMs} ms · 경과 ${Math.round(info.elapsedMs)} ms`;
}

function formatPlayer({ current, last }) {
  const parts = [];
  if (current) parts.push(`재생 중 ${formatAnimation(current)}`);
  if (last) parts.push(`마지막 ${OUTCOME_LABELS[last.outcome]} 시점 ${formatAnimation(last)}`);
  return parts.length ? parts.join(' / ') : '없음';
}

function formatErrors({ judge, seq, nowMs }) {
  const parts = [];
  if (seq.lastError) {
    const { reason, playId } = seq.lastError;
    const label = reason === 'timeout' ? '재생 시간 초과' : `재생 오류(${reason})`;
    parts.push(`${label} #${playId}`);
  }
  if (seq.retryAtMs !== null) {
    parts.push(`재시도까지 ${Math.max(0, (seq.retryAtMs - nowMs) / 1000).toFixed(1)} s`);
  }
  if (judge.lastRejection) parts.push(`샘플 거절(${judge.lastRejection.reason})`);
  return parts.length ? parts.join(' · ') : '없음';
}

export function createDiagnostics(listEl) {
  const cells = {};
  for (const [key, label] of ROWS) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.dataset.key = key;
    listEl.append(dt, dd);
    cells[key] = dd;
  }

  function render({ input, judge, seq, player, nowMs }) {
    cells.input.textContent = `${input.source} · ${input.sending ? '전송 중' : '전송 중단'} · 보낸 샘플 ${input.sentCount}`;
    cells.sample.textContent = formatSample(judge.lastSample);
    cells.age.textContent = judge.lastSampleAgeMs === null
      ? '-'
      : `${Math.round(judge.lastSampleAgeMs)} ms${judge.stale ? ' · 끊김(stale)' : ''}`;
    cells.decision.textContent = `${DECISION_LABELS[judge.decision]} (${judge.decision})`;
    cells.candidate.textContent = judge.candidate
      ? `${DECISION_LABELS[judge.candidate.zone]} ${Math.round(judge.candidate.heldMs)} / ${judge.candidate.requiredMs} ms`
      : '없음';
    cells.phase.textContent = `${PHASE_LABELS[seq.phase]} (${seq.phase})`;
    cells.play.textContent = seq.playId === null
      ? `진행 없음 · 마지막 #${seq.lastPlayId} · 무시한 늦은 알림 ${seq.ignoredCompletions}`
      : `#${seq.playId} ${CLIP_LABELS[seq.clip]} 재생 중 · 무시한 늦은 알림 ${seq.ignoredCompletions}`;
    cells.player.textContent = formatPlayer(player);
    cells.error.textContent = formatErrors({ judge, seq, nowMs });
  }

  return { render };
}
