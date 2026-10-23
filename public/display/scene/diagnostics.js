// 진단 영역: 입력·판정·시퀀스·재생기·렌더러 상태를 사람이 읽을 수 있는 한국어로 보여 준다(개발 패널 안).

export const PHASE_LABELS = Object.freeze({
  safe: '안전 정지(H)',
  play: '놀이',
  notice: '눈치챔',
  duck: '숨기',
  hidden: '숨음',
  return: '놀이로 복귀',
  rehide: '다시 숨기(복귀 역방향)',
});

const DECISION_LABELS = { unknown: '알 수 없음', far: '원거리', mid: '중간', near: '근거리' };
const STATUS_LABELS = { ok: '정상 감지', 'no-target': '감지 없음', error: '입력 오류' };
const OUTCOME_LABELS = { finished: '완료', cancelled: '취소', replaced: '교체', error: '오류' };
const SWITCH_LABELS = { cue: '연결 구간에서 이음', natural: '구간 없이 정상 완료에서 이음', cancelled: '판정 되돌아와 취소', safe: '안전 정지로 취소' };
const TARGET_LABELS = { duck: '숨기', notice: '눈치챔', play: '놀이' };
const cueText = (via) => `${via.clip} ${via.atSec.toFixed(3)} s(구간 ${sec(via.fromSec)}~${sec(via.toSec)})`;
const sec = (v) => (v === null || v === undefined ? '-' : v.toFixed(2));
const STAGE_LABELS = { pending: '대기', loading: '불러오는 중', seeking: '처음으로 탐색', starting: '재생 시작 중', playing: '재생 중' };

const ROWS = [
  ['input', '판정 입력'],
  ['sample', '마지막 샘플'],
  ['age', '마지막 샘플 경과'],
  ['decision', '근접 판정'],
  ['candidate', '판정 후보'],
  ['phase', '현재 단계'],
  ['play', '재생 ID'],
  ['player', '재생기'],
  ['shown', '화면 표시'],
  ['transition', '최근 전환'],
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
      + ` · 편집 ${sec(current.inSec)}~${current.outSec === null ? '끝' : sec(current.outSec)} s`
      + (current.cueTarget
        ? ` · 연결 대기(${TARGET_LABELS[current.cueTarget] ?? current.cueTarget}) 가능 구간 ${current.cues.map((c) => `${sec(c.fromSec)}~${sec(c.toSec)}`).join(', ') || '없음(정상 완료까지)'} s`
        : '')
      + ` · readyState ${current.readyState ?? '-'}${current.paused ? ' · 멈춤' : ''} · 경과 ${Math.round(current.elapsedMs)} ms`);
  }
  if (last) parts.push(`마지막 #${last.playId} ${last.clip} ${OUTCOME_LABELS[last.outcome]}${last.reason ? `(${last.reason})` : ''}`);
  return parts.length ? parts.join(' / ') : '없음';
}

function formatSources(player) {
  return Object.entries(player.sources)
    .map(([clip, s]) => `${clip.split('_')[0]} ${s.error ? `오류(${s.error})` : s.readyState === null ? '-' : `r${s.readyState}`}${s.rewinds ? `·되감기${s.rewinds}` : ''}`)
    .concat(`H ${player.still}`)
    .join(' · ');
}

// 최근 전환 지연(ms): 이전 클립 끝 → 재생 요청 → 준비 → 재생 시작(표시 교체) → 첫 영상 프레임 → 교체 후 첫 그림.
// 각 단계는 재생 요청 기준 경과(+ms). 첫 그림은 렌더러의 마지막 교체가 이 재생일 때만 보인다.
function formatTransition(player, r) {
  const list = player.transitions ?? [];
  if (list.length === 0) return '없음';
  const t = list[list.length - 1];
  const rel = (v) => (v === null ? '-' : `+${Math.round(v - t.requestMs)}`);
  const swap = r?.swap;
  const drawnMs = swap && swap.kind === 'video' && swap.clip === t.clip && swap.atMs >= t.requestMs ? swap.drawnMs : null;
  const origin = t.prevEndedMs ?? t.requestMs;
  const parts = [
    `#${t.playId} ${t.fromClip ?? '-'} → ${t.clip}${t.via ? ` · 연결 ${cueText(t.via)}` : ''}`
      + ` · 섞기 ${t.blended ? `${t.blendMs} ms` : '없음'}${t.endedBy ? ` · 끝남(${t.endedBy})` : ''}`
      + (t.mirror ? ` · 정/역 반전 시작 ${t.mirror}` : ''),
    `끝→첫 그림 ${drawnMs === null ? '-' : Math.round(drawnMs - origin)} ms${t.prevEndedMs === null ? '(요청 기준)' : ''}`,
    `끝→요청 ${t.prevEndedMs === null ? '-' : Math.round(t.requestMs - t.prevEndedMs)}`,
    `준비 ${rel(t.readyMs)}${t.seeked ? '(탐색)' : ''}${t.waitedRewind ? '(되감기 대기)' : ''}`,
    `재생 시작 ${rel(t.playingMs)}`,
    `첫 영상 프레임 ${rel(t.firstFrameMs)}${t.firstFrameMediaSec === null ? '' : `(${t.firstFrameMediaSec.toFixed(3)} s)`}`,
    `첫 그림 ${rel(drawnMs)}`,
  ];
  // 최근 전환들의 끝(없으면 요청) → 재생 시작 지연
  const recent = list
    .map((x) => (x.playingMs === null ? '-' : Math.round(x.playingMs - (x.prevEndedMs ?? x.requestMs))))
    .join(', ');
  return `${parts.join(' · ')} ms / 최근 끝→재생 시작: ${recent} ms`;
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
    cells.input.textContent = input.text; // 고른 판정 입력(실센서 / 모의)과 수신 요약 — main.js가 만든다
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
    if (seq.phase === 'hidden' && seq.playId === null) flags.push('숨은 대기(자동 재생 없음 · 멀어지면 복귀)');
    if (seq.pending) {
      flags.push(`연결 대기 → ${TARGET_LABELS[seq.pending.target] ?? seq.pending.target} · ${((nowMs - seq.pending.sinceMs) / 1000).toFixed(1)} s째(판정 ${DECISION_LABELS[seq.decision]})`);
    } else if (seq.lastSwitch) {
      const s = seq.lastSwitch;
      flags.push(`마지막 연결: ${SWITCH_LABELS[s.outcome] ?? s.outcome}${s.via ? ` ${cueText(s.via)}` : ''}`);
    }
    cells.phase.textContent = `${PHASE_LABELS[seq.phase]} (${seq.phase})${flags.length ? ` · ${flags.join(' · ')}` : ''}`;
    cells.play.textContent = seq.playId === null
      ? `진행 없음 · 마지막 #${seq.lastPlayId} · 무시한 늦은 알림 ${seq.ignoredCompletions}`
      : `#${seq.playId} ${seq.clip} · 무시한 늦은 알림 ${seq.ignoredCompletions}`;
    if (seq.ignoredCues) cells.play.textContent += ` · 받지 않은 연결 알림 ${seq.ignoredCues}`;
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
    cells.transition.textContent = formatTransition(player, r);
    cells.sources.textContent = formatSources(player);
    cells.error.textContent = formatErrors({ judge, seq, render: r, nowMs });
  }

  return { render };
}
