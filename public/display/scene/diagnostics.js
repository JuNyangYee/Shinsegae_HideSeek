// 진단 영역: 입력·판정·시퀀스·재생기·렌더러 상태를 사람이 읽을 수 있는 한국어로 보여 준다(개발 패널 안).

export const PHASE_LABELS = Object.freeze({
  safe: '안전 정지(H)',
  play: '놀이',
  notice: '눈치챔',
  duck: '숨기',
  hidden: '숨음',
  return: '놀이로 복귀',
});

const DECISION_LABELS = { unknown: '알 수 없음', far: '원거리', mid: '중간', near: '근거리' };
const STATUS_LABELS = { ok: '정상 감지', 'no-target': '감지 없음', error: '입력 오류' };
const OUTCOME_LABELS = { finished: '완료', cancelled: '취소', replaced: '교체', error: '오류' };
const STAGE_LABELS = { pending: '대기', loading: '불러오는 중', seeking: '처음으로 탐색', starting: '재생 시작 중', playing: '재생 중' };

const ROWS = [
  ['input', '입력 원본'],
  ['sample', '마지막 샘플'],
  ['age', '마지막 샘플 경과'],
  ['decision', '근접 판정'],
  ['candidate', '판정 후보'],
  ['phase', '현재 단계'],
  ['play', '재생 ID'],
  ['player', '재생기'],
  ['shown', '화면 표시'],
  ['render', '그리기'],
  ['filter', '유화 필터'],
  ['sources', '영상 소스'],
  ['note', '참고'],
  ['error', '최근 오류'],
];

function formatSample(sample) {
  if (!sample) return '아직 없음';
  const label = STATUS_LABELS[sample.status];
  return sample.status === 'ok' ? `${label} · ${sample.distanceM.toFixed(2)} m` : label;
}

function formatPlayer({ current, last }) {
  const parts = [];
  if (current) {
    const t = current.currentTimeSec === null ? '-' : current.currentTimeSec.toFixed(2);
    const d = current.durationSec === null ? '-' : current.durationSec.toFixed(2);
    parts.push(`#${current.playId} ${current.clip} · ${STAGE_LABELS[current.stage] ?? current.stage} · ${t}/${d} s`
      + ` · readyState ${current.readyState ?? '-'}${current.paused ? ' · 멈춤' : ''} · 경과 ${Math.round(current.elapsedMs)} ms`);
  }
  if (last) parts.push(`마지막 #${last.playId} ${last.clip} ${OUTCOME_LABELS[last.outcome]}${last.reason ? `(${last.reason})` : ''}`);
  return parts.length ? parts.join(' / ') : '없음';
}

function formatSources(player) {
  return Object.entries(player.sources)
    .map(([clip, s]) => `${clip.split('_')[0]} ${s.error ? `오류(${s.error})` : s.readyState === null ? '-' : `r${s.readyState}`}`)
    .concat(`H ${player.still}`)
    .join(' · ');
}

function formatErrors({ judge, seq, render, nowMs }) {
  const parts = [];
  if (render?.fatal) parts.push(`그리기 불가: ${render.fatal}`);
  if (render?.oilError) parts.push(`유화 오류(원본 표시): ${render.oilError}`);
  if (seq.lastError) {
    const { reason, playId, clip } = seq.lastError;
    const label = reason === 'timeout' ? '재생 시간 초과' : `재생 오류(${reason})`;
    parts.push(`${label} #${playId} ${clip}`);
  }
  if (seq.retryAtMs !== null) parts.push(`재시도까지 ${Math.max(0, (seq.retryAtMs - nowMs) / 1000).toFixed(1)} s`);
  if (judge.lastRejection) parts.push(`샘플 거절(${judge.lastRejection.reason})`);
  return parts.length ? parts.join(' · ') : '없음';
}

export function createDiagnostics(listEl, { note = '' } = {}) {
  const cells = {};
  for (const [key, label] of ROWS) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.dataset.key = key;
    listEl.append(dt, dd);
    cells[key] = dd;
  }
  cells.note.textContent = note;

  function render({ input, judge, seq, player, render: r, suspendedBy, nowMs }) {
    cells.input.textContent = `${input.source} · ${input.sending ? '전송 중' : '전송 중단'} · 보낸 샘플 ${input.sentCount}`;
    cells.sample.textContent = formatSample(judge.lastSample);
    cells.age.textContent = judge.lastSampleAgeMs === null
      ? '-'
      : `${Math.round(judge.lastSampleAgeMs)} ms${judge.stale ? ' · 끊김(stale)' : ''}`;
    cells.decision.textContent = `${DECISION_LABELS[judge.decision]} (${judge.decision})`;
    cells.candidate.textContent = judge.candidate
      ? `${DECISION_LABELS[judge.candidate.zone]} ${Math.round(judge.candidate.heldMs)} / ${judge.candidate.requiredMs} ms`
      : '없음';
    const flags = [];
    if (seq.noticed) flags.push('관객 인지');
    if (seq.suspended) flags.push(`일시 중지(${suspendedBy.join(', ') || '-'})`);
    cells.phase.textContent = `${PHASE_LABELS[seq.phase]} (${seq.phase})${flags.length ? ` · ${flags.join(' · ')}` : ''}`;
    cells.play.textContent = seq.playId === null
      ? `진행 없음 · 마지막 #${seq.lastPlayId} · 무시한 늦은 알림 ${seq.ignoredCompletions}`
      : `#${seq.playId} ${seq.clip} · 무시한 늦은 알림 ${seq.ignoredCompletions}`;
    cells.player.textContent = `${formatPlayer(player)}${player.blocked ? ' · 자동 재생 막힘' : ''}`;
    if (r) {
      const shownLabels = { image: 'H 정지 이미지', cover: '가림 화면(H 이미지 준비 안 됨)' };
      cells.shown.textContent = r.shown.kind === null ? '아직 없음' : shownLabels[r.shown.kind] ?? `영상 ${r.shown.clip}`;
      const vp = r.viewport;
      cells.render.textContent = `${r.path === 'post' ? `유화(${r.postType})` : r.path === 'direct' ? '원본(직접)' : '불가'}`
        + ` · ${r.drawRate} 그림/s(설정 ${r.renderFps}) · 화면 갱신 ${r.frameRate}/s · 마지막 ${r.lastDrawMs === null ? '-' : r.lastDrawMs.toFixed(1)} ms`
        + ` · 캔버스 ${vp.width}×${vp.height}@${vp.pixelRatio} · 시험 ${r.probe}`;
      const internal = r.internal;
      const health = r.health;
      cells.filter.textContent = `${r.wantOil ? '켬' : '끔'}${r.oilActive ? ' · 적용 중' : ''}`
        + (internal ? ` · 내부 ${internal.width}×${internal.height} · 획 ${internal.strokes}` : '')
        + (health ? ` · 칠함 확인 ${health.supported ? (health.ok ? '정상' : `실패(${health.detail})`) : '지원 안 함'}(${health.checked})` : '');
    } else {
      cells.shown.textContent = '-';
      cells.render.textContent = '렌더러 없음';
      cells.filter.textContent = '-';
    }
    cells.sources.textContent = formatSources(player);
    cells.error.textContent = formatErrors({ judge, seq, render: r, nowMs });
  }

  return { render };
}
