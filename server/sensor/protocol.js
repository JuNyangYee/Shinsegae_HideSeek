// ESP32 펌웨어(Puuvila_mmwave src/main.cpp) → PC USB 시리얼 115200 JSON 줄 해석. 장치·타이머 없는 순수 모듈.
//
// 보드 → PC 줄(펌웨어 소스 기준):
//   {"type":"presence","n":1,"dist":1.23,"speed":-0.40,"energy":120,"ts":12345}  센서 프레임마다(약 10 Hz). n=0이면 대상 없음(dist는 의미 없음)
//   {"type":"hb","up":123,"frames":4567,"baud":9600,"mode":"speed","age":93,"ts":...}  1 Hz. age = 보드 기준 마지막 센서 프레임 경과(ms)
//   {"type":"boot",...} {"type":"log","msg":"..."} {"type":"exist","exist":1}(존재 모드) {"type":"raw",...}
// ts·age·up은 보드(MCU) 시각이다. 표시에만 쓰고 수신 시각·페이지 시각과 섞지 않는다.

export const MAX_LINE_BYTES = 512; // 펌웨어 줄은 150바이트 안팎. 이보다 긴 줄(개행 없는 쓰레기 스트림)은 버린다

// 바이트 조각 → 줄. 줄이 나뉘어 오거나 여러 줄이 한 조각에 붙어 와도 된다. 긴 줄은 개행까지 통째로 버리고 onDrop을 부른다.
export function createLineSplitter({ maxLineBytes = MAX_LINE_BYTES, onLine, onDrop = () => {} }) {
  let parts = [];
  let size = 0;
  let discarding = false;

  function emit(buf) {
    const text = buf.toString('utf8').replace(/[\r\0]/g, '').trim();
    if (text) onLine(text);
  }

  function push(chunk) {
    let start = 0;
    for (;;) {
      const i = chunk.indexOf(0x0a, start);
      if (i < 0) break;
      const piece = chunk.subarray(start, i);
      if (discarding || size + piece.length > maxLineBytes) onDrop('too-long');
      else emit(parts.length ? Buffer.concat([...parts, piece]) : piece);
      parts = [];
      size = 0;
      discarding = false;
      start = i + 1;
    }
    if (start >= chunk.length || discarding) return;
    const rest = chunk.subarray(start);
    if (size + rest.length > maxLineBytes) {
      discarding = true;
      parts = [];
      size = 0;
      return;
    }
    parts.push(Buffer.from(rest)); // 복사: 원본 버퍼 재사용에 대비
    size += rest.length;
  }

  function reset() {
    parts = [];
    size = 0;
    discarding = false;
  }

  return { push, reset };
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonNegInt = (v) => Number.isInteger(v) && v >= 0;

export const PRESENCE_LIMITS = Object.freeze({
  maxTargets: 16,
  maxDistanceM: 15, // SEN0610 최대 12 m + 여유. 이보다 크면 형식 오류로 본다
  maxSpeedMps: 30,
});

// presence 줄 검증. n>0이면 0보다 큰 거리가 있어야 한다(거리 0 감지는 근거리로 쓰지 않고 형식 오류로 거절 — 가정).
function parsePresence(d) {
  const bad = (reason) => ({ type: 'presence', valid: false, reason });
  if (!isNonNegInt(d.n) || d.n > PRESENCE_LIMITS.maxTargets) return bad('bad-n');
  if (!Number.isFinite(d.dist) || !Number.isFinite(d.speed) || !Number.isFinite(d.energy)) return bad('bad-number');
  if (!isNonNegInt(d.ts)) return bad('bad-ts');
  if (d.energy < 0) return bad('bad-energy');
  if (Math.abs(d.speed) > PRESENCE_LIMITS.maxSpeedMps) return bad('speed-out-of-range');
  if (d.n > 0) {
    if (d.dist <= 0) return bad('zero-distance');
    if (d.dist > PRESENCE_LIMITS.maxDistanceM) return bad('distance-out-of-range');
  }
  return {
    type: 'presence',
    valid: true,
    n: d.n,
    distM: d.n > 0 ? d.dist : null, // n=0의 dist(보통 0)는 버린다
    speedMps: d.speed,
    energy: d.energy,
    mcuTs: d.ts,
  };
}

function parseHb(d) {
  if (!isNonNegInt(d.up) || !isNonNegInt(d.frames) || !isNonNegInt(d.ts) || typeof d.mode !== 'string') {
    return { type: 'hb', valid: false, reason: 'bad-hb' };
  }
  return {
    type: 'hb',
    valid: true,
    upSec: d.up,
    frames: d.frames,
    baud: isNonNegInt(d.baud) ? d.baud : null,
    mode: d.mode.slice(0, 16),
    frameAgeMs: isNonNegInt(d.age) ? d.age : null,
    mcuTs: d.ts,
  };
}

// 한 줄 → 구분된 메시지. JSON이 아닌 줄(예: 보드 재시작 때 ROM 출력)은 type 'text'.
export function parseDeviceLine(text) {
  if (!text.startsWith('{')) return { type: 'text', text: text.slice(0, 160) };
  let d;
  try {
    d = JSON.parse(text);
  } catch {
    return { type: 'invalid', reason: 'bad-json' };
  }
  if (!isObj(d) || typeof d.type !== 'string') return { type: 'invalid', reason: 'no-type' };
  switch (d.type) {
    case 'presence':
      return parsePresence(d);
    case 'hb':
      return parseHb(d);
    case 'boot':
      return { type: 'boot', fw: typeof d.fw === 'string' ? d.fw.slice(0, 32) : null };
    case 'log':
      return { type: 'log', msg: typeof d.msg === 'string' ? d.msg.slice(0, 200) : '', mode: typeof d.mode === 'string' ? d.mode : null };
    case 'exist':
      return { type: 'exist' };
    case 'raw':
      return { type: 'raw' };
    default:
      return { type: 'other', name: d.type.slice(0, 32) };
  }
}
