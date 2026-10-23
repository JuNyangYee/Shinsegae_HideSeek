// 개발 패널 설정 저장: 프로젝트 .local/hideseek-settings.json(gitignore, public/ 밖). 새로고침·서버 재시작 뒤에도 유지된다.
//   - app: 앱 판정 설정(근접 경계·유지 시간·안정화). 저장에 성공해야 적용된다.
//   - sensorDesired: 센서 자체 설정 희망값(이 서버가 기억하는 값 — 센서에서 읽은 값이 아니다).
//   - sensorLastSent: 최근 명령 전송 기록(보드 처리 응답 여부 — 센서 실제 적용 확인이 아니다).
// 경로는 이 파일(import.meta.url) 기준이라 실행 cwd와 무관하다. 쓰기는 임시 파일 → 이름 바꾸기로 하고, 한 번에 하나씩 한다.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultAppSettings, validateAppSettings, validateSensorConfig } from '../../public/display/config/input-settings.js';

export const DEFAULT_SETTINGS_FILE = path.join(fileURLToPath(new URL('../../.local/', import.meta.url)), 'hideseek-settings.json');

// 센서 희망값 기본(가정): 기존 Python 툴 저장 기록(감지 0.3~3.0 m, mode 1 — 센서 readback 아님)과 툴 기본 감도 10, 미세 움직임 끔.
export function defaultSensorDesired() {
  return { rangeMinM: 0.3, rangeMaxM: 3.0, thrFactor: 10, microMotion: false, distanceMode: true };
}

export function createSettingsStore({ file = DEFAULT_SETTINGS_FILE } = {}) {
  let app = defaultAppSettings();
  let appSource = 'default';
  let sensorDesired = defaultSensorDesired();
  let sensorLastSent = null;
  let loadError = null;
  let writeChain = Promise.resolve();

  async function load() {
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') loadError = `설정 파일을 읽지 못했습니다(기본값 사용): ${err.message}`;
      return;
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      loadError = '설정 파일 형식이 올바르지 않습니다(기본값 사용, 다음 저장 때 덮어씀).';
      return;
    }
    const problems = [];
    if (data?.app !== undefined) {
      const checked = validateAppSettings(data.app);
      if (checked.ok) {
        app = checked.value;
        appSource = 'file';
      } else problems.push(`앱 판정 설정(${checked.errors.join(' ')})`);
    }
    if (data?.sensorDesired !== undefined) {
      const checked = validateSensorConfig(data.sensorDesired);
      if (checked.ok) sensorDesired = checked.value;
      else problems.push('센서 희망값');
    }
    if (data?.sensorLastSent && typeof data.sensorLastSent === 'object') sensorLastSent = data.sensorLastSent;
    if (problems.length) loadError = `저장된 값 중 잘못된 항목은 기본값을 씁니다: ${problems.join(', ')}`;
  }

  // 지금 메모리 값에 patch를 더한 내용을 쓴다. 성공해야 메모리에 반영한다(실패를 성공처럼 보이지 않게).
  function persist(patch) {
    const run = async () => {
      const next = { version: 1, app, sensorDesired, sensorLastSent, ...patch, savedAt: new Date().toISOString() };
      const tmp = `${file}.${process.pid}.tmp`;
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
      await rename(tmp, file);
      return next;
    };
    const result = writeChain.then(run, run);
    writeChain = result.catch(() => {});
    return result;
  }

  async function saveApp(input) {
    const checked = validateAppSettings(input);
    if (!checked.ok) return { ok: false, code: 'invalid', errors: checked.errors };
    try {
      await persist({ app: checked.value });
    } catch (err) {
      return { ok: false, code: 'save-failed', errors: [`저장하지 못해 적용하지 않았습니다: ${err.message}`] };
    }
    app = checked.value;
    appSource = 'file';
    loadError = null;
    return { ok: true, value: app };
  }

  async function saveSensorDesired(value) {
    try {
      await persist({ sensorDesired: value });
    } catch (err) {
      return { ok: false, code: 'save-failed', errors: [`희망값을 저장하지 못해 보내지 않았습니다: ${err.message}`] };
    }
    sensorDesired = value;
    return { ok: true };
  }

  // 명령 결과 기록. 실패하면 오류 문구만 돌려준다(명령 결과 자체는 연결 상태에 남는다).
  async function recordSensorSend(record) {
    try {
      await persist({ sensorLastSent: record });
      sensorLastSent = record;
      return null;
    } catch (err) {
      sensorLastSent = record;
      return `전송 기록을 파일에 저장하지 못했습니다: ${err.message}`;
    }
  }

  function snapshot() {
    return { app, appSource, sensorDesired, sensorLastSent, file, loadError };
  }

  return { load, saveApp, saveSensorDesired, recordSensorSend, snapshot };
}
