// 개발 패널에서 바꾸는 설정의 기본값·검증(브라우저와 로컬 서버가 함께 쓰는 순수 모듈).
//   - 앱 판정 설정: 근접 판정 경계·유지 시간 + 실센서 입력 안정화. 서버가 .local/ 파일에 저장하고, 표시 페이지가 판정에 적용한다.
//   - 센서 자체 설정: 펌웨어의 고정 명령(cmd setRange / setThrFactor / setMicroMotion, mode 1)으로 보낼 희망값.
// 잘못된 값은 저장·적용하지 않는다(부분 적용 없음). 허용하지 않는 키가 있으면 거절한다.

import { SETTINGS } from './settings.js';

// 앱 판정 설정 항목: [키, 정수 여부, 최소, 최대, 한국어 이름]. staleMs·maxSampleGapMs는 패널에서 바꾸지 않는다.
const APP_FIELDS = Object.freeze([
  ['nearBelowM', false, 0.1, 5, '숨기 경계(near 미만)'],
  ['farAboveM', false, 0.2, 8, '원거리 경계(far 초과)'],
  ['retreatMarginM', false, 0, 1, '이탈 여유'],
  ['approachHoldMs', true, 0, 5000, '접근 유지 시간'],
  ['retreatHoldMs', true, 0, 5000, '후퇴 유지 시간'],
  ['medianWindow', true, 1, 5, '중앙값 창'],
  ['absentGraceMs', true, 0, 2000, '감지 누락 유예'],
]);
export const APP_SETTING_KEYS = Object.freeze(APP_FIELDS.map(([key]) => key));
export const MEDIAN_WINDOWS = Object.freeze([1, 3, 5]);

export function defaultAppSettings() {
  const p = SETTINGS.proximity;
  const s = SETTINGS.stabilize;
  return {
    nearBelowM: p.nearBelowM,
    farAboveM: p.farAboveM,
    retreatMarginM: p.retreatMarginM,
    approachHoldMs: p.approachHoldMs,
    retreatHoldMs: p.retreatHoldMs,
    medianWindow: s.medianWindow,
    absentGraceMs: s.absentGraceMs,
  };
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function unknownKeys(input, keys) {
  return Object.keys(input).filter((k) => !keys.includes(k));
}

// 앱 판정 설정 검증. 모든 키가 있어야 한다. → { ok: true, value } | { ok: false, errors: [한국어] }
export function validateAppSettings(input) {
  if (!isPlainObject(input)) return { ok: false, errors: ['설정 형식이 올바르지 않습니다.'] };
  const errors = [];
  const extra = unknownKeys(input, APP_SETTING_KEYS);
  if (extra.length) errors.push(`허용하지 않는 항목: ${extra.join(', ')}`);
  const value = {};
  for (const [key, integer, min, max, label] of APP_FIELDS) {
    const v = input[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      errors.push(`${label}: 숫자가 아닙니다.`);
      continue;
    }
    if (integer && !Number.isInteger(v)) {
      errors.push(`${label}: 정수여야 합니다.`);
      continue;
    }
    if (v < min || v > max) {
      errors.push(`${label}: ${min}~${max} 범위여야 합니다.`);
      continue;
    }
    value[key] = v;
  }
  if (errors.length === 0) {
    if (!MEDIAN_WINDOWS.includes(value.medianWindow)) errors.push(`중앙값 창: ${MEDIAN_WINDOWS.join('/')} 중 하나여야 합니다.`);
    if (!(value.nearBelowM + value.retreatMarginM < value.farAboveM)) {
      errors.push('숨기 경계 + 이탈 여유가 원거리 경계보다 작아야 합니다(near + margin < far).');
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

// 판정기(core/proximity.js) 설정 = 기본 proximity 설정 + 패널 값.
export function proximityConfigFrom(app) {
  return {
    ...SETTINGS.proximity,
    nearBelowM: app.nearBelowM,
    farAboveM: app.farAboveM,
    retreatMarginM: app.retreatMarginM,
    approachHoldMs: app.approachHoldMs,
    retreatHoldMs: app.retreatHoldMs,
  };
}

// ── 센서 자체 설정(희망값) ──
// SEN0610 감지 거리 0.3~12 m(기존 Python 툴과 같은 입력 범위 — 제조사 거리 측정 사양 1.2~12 m와 다름, 1.2 m 미만 정확도는 미확인),
// 감도 임계 1~99(작을수록 민감), 미세 움직임 켬/끔, 거리/속도 모드(mode 1)만 다시 지정할 수 있다.
export const SENSOR_RANGE_LIMITS_M = Object.freeze({ min: 0.3, max: 12 });
export const SENSOR_CONFIG_KEYS = Object.freeze(['rangeMinM', 'rangeMaxM', 'thrFactor', 'microMotion', 'distanceMode']);

// 0.1 m 단위인지(펌웨어 명령은 소수 1자리로 보낸다 — 반올림해서 다른 값을 보내지 않게 입력 단계에서 거절).
const isTenth = (v) => Math.abs(v * 10 - Math.round(v * 10)) < 1e-9;

export function validateSensorConfig(input) {
  if (!isPlainObject(input)) return { ok: false, errors: ['설정 형식이 올바르지 않습니다.'] };
  const errors = [];
  const extra = unknownKeys(input, SENSOR_CONFIG_KEYS);
  if (extra.length) errors.push(`허용하지 않는 항목: ${extra.join(', ')}`);
  const { min, max } = SENSOR_RANGE_LIMITS_M;
  for (const key of ['rangeMinM', 'rangeMaxM']) {
    const v = input[key];
    const label = key === 'rangeMinM' ? '감지 최소 거리' : '감지 최대 거리';
    if (typeof v !== 'number' || !Number.isFinite(v)) errors.push(`${label}: 숫자가 아닙니다.`);
    else if (v < min || v > max) errors.push(`${label}: ${min}~${max} m 범위여야 합니다.`);
    else if (!isTenth(v)) errors.push(`${label}: 0.1 m 단위여야 합니다.`);
  }
  if (errors.length === 0 && !(input.rangeMinM < input.rangeMaxM)) errors.push('감지 최소 거리는 최대 거리보다 작아야 합니다.');
  const thr = input.thrFactor;
  if (!Number.isInteger(thr) || thr < 1 || thr > 99) errors.push('감도 임계: 1~99 정수여야 합니다.');
  if (typeof input.microMotion !== 'boolean') errors.push('미세 움직임: 켬/끔 값이 아닙니다.');
  if (typeof input.distanceMode !== 'boolean') errors.push('거리 모드: 켬/끔 값이 아닙니다.');
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      rangeMinM: Math.round(input.rangeMinM * 10) / 10,
      rangeMaxM: Math.round(input.rangeMaxM * 10) / 10,
      thrFactor: thr,
      microMotion: input.microMotion,
      distanceMode: input.distanceMode,
    },
  };
}
