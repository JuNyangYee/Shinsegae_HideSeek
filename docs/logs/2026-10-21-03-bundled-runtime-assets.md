# 2026-10-21-03 실행 에셋 저장소 포함

## 목표

사용자 요청("ThrowSnow처럼 영상 에셋들 다 master로 두자. 경로 변경될 수 있으니까")에 따라 실행용 영상·정지 이미지를 저장소에 포함하고, 서버 기본 미디어 경로를 프로젝트 상대 기준으로 바꾼다.

## 변경

- 에셋 복사(원본 그대로, 변환·이동·삭제 없음) 8개, 합계 13,113,741바이트:
  - `public/display/assets/seq/`: `SC0A_Pat`·`SC0B_Roll`·`SC0C_Playful`·`SC1_Notice`·`SC2_Duck`·`SC3_Hidden_Clue`·`SC4_Return_To_Play` `.mp4` 7개(10,634,627바이트). 출처 `D:/2026-09_ShinsegaeChristmas/007_Assets/HideSeek_Seq_1021/`.
  - `public/display/assets/pose/H_Hidden.png` 1개(2,479,114바이트). 출처 `D:/2026-09_ShinsegaeChristmas/007_Assets/Hide_Seek/HideSeek_Snowman_Play_v02/01_Masters/`.
  - 쓰지 않는 포즈·가이드·작업 원본·IP PDF는 복사하지 않았다.
- `server/media.js`: `DEFAULT_MEDIA_DIRS`를 `import.meta.url` 기준 `public/display/assets/seq/`·`pose/`로 변경. `SEQ_DIR`·`POSE_DIR` 덮어쓰기 의미(빈 값은 기본, 상대 경로는 실행 cwd 기준)와 `/media/...` 주소, allowlist, HEAD·Range 처리는 그대로. `server/app.js`·`server/server.js`는 주석만 고쳤다.
- `.gitattributes`: `*.mp4 binary`, `*.png binary` 추가. LFS·ignore 변경 없음.
- `test/server-media.test.js`: 테스트 2개 추가 — 기본 경로가 다른 cwd에서도 저장소 에셋 폴더이고 환경 변수 덮어쓰기(절대·상대·빈 값)가 유지되는지, 환경 변수 없이 만든 기본 핸들러가 다른 cwd에서 8개 모두 HEAD 200(크기 일치)과 영상 Range 206(원본 첫 16바이트 일치)을 주는지.
- 문서: README 영상·이미지 경로 절, SYSTEM 1·3·8·10장, PROJECT 3.3절 표현과 7장의 "최종 에셋의 저장소 관리 정책(미정)" 행 삭제. 출처 절대 경로는 출처로만 남겼다.
- 영상 순서·판정·유화·UI 코드는 바꾸지 않았다.

## 결정과 이유

- **확정(사용자 결정):** 실행 에셋은 `public/display/assets/`에 원본 사본으로 추적한다. 프로젝트·원본 폴더 경로가 바뀌어도 실행되게 하려는 목적이다. ThrowSnow와 같이 일반 Git 바이너리로 커밋하고 LFS는 쓰지 않는다.
- 에셋이 `public/` 아래에 있어 기존 정적 제공으로 `/display/assets/...` 직접 주소도 열린다(ThrowSnow와 같은 범위, Range 없음, `.mp4`는 `application/octet-stream`). 표시 페이지는 `/media/...`만 쓰므로 서버를 개편하지 않고 SYSTEM 8장에 노출 범위를 적었다.
- `AGENTS.md`의 에셋 규칙(원본 영상 복사 금지) 갱신은 이번 작업에서 **하지 못했다**. 구현 담당의 수정 시도를 자동 승인 검토가 "Instruction Poisoning" 사유로 거부했다. 우회하지 않고 파일을 유지했으며 사용자에게 이 제한을 보고했다. 이번 실행 에셋 포함은 최신 사용자 명시 지시이며 README·SYSTEM에 확정 결정으로 기록했다.

## 검수 및 검증

- 복사 파일 8개 SHA256 원본 일치: 8/8 일치.
- `node --test test/server-media.test.js`: 6개 중 5 통과, 1 skip(기존 심볼릭 링크 테스트 — 이 PC에서 링크 생성 `EPERM`). 테스트 서버는 임시 포트로 띄우고 테스트 안에서 닫는다.
- `git diff --check` 및 새 파일 포함 확인.
- 하지 않음: 전체 `npm test`, 브라우저 확인, 상주 서버 실행, 벤치마크(화면·유화 코드 변경 없음).
- 같은 사용자 흐름의 메인 checkout(`D:/2026-09_ShinsegaeChristmas/006_Works/001_HideSeek`) `node_modules` 누락 경고: 오케스트레이터가 `npm ci`를 완료하고 three 0.186.1 두 모듈(`three.module.js`, `three.core.js`) 존재와 git clean을 확인했다. 당시 8091 서버가 꺼져 있어 live HTTP 확인은 하지 못했고, 이 작업의 테스트 임시 서버(기본 핸들러 HEAD·Range)로 대신 확인했다.
- 간단 검수: codex / `gpt-6.1-sol`, xhigh, auto-review 실제 설정 확인. 기준 `9a5bd0c` 대비 읽기 전용 1회, 필수·권장 지적 없음. 검수자는 파일 수정·테스트·서버·브라우저 실행을 하지 않았다. `AGENTS.md` 미갱신은 기지 제약으로 처리했다.
- 구현: claude / `claude-opus-5-5`, high, auto 실제 설정 확인. Paseo 에이전트 `2b8a56f6-2deb-4fd8-adae-bfdf53524525`, Claude 세션 `820b0d2f-028b-43b4-bedc-bd1a96f1434a`. 구현 worktree에서 `claude --resume 820b0d2f-028b-43b4-bedc-bd1a96f1434a`로 다시 열 수 있다.

## 인계

- 브랜치 `task/bundled-runtime-assets`, 기준 master `9a5bd0c`, worktree `C:/Users/User/.paseo/worktrees/0wbs9g4q/task-bundled-runtime-assets`.
- 검수 완료. 기능 커밋 `892a323`을 오케스트레이터가 master에 fast-forward 병합·push했다(아래 통합 결과).
- 남은 이슈: `AGENTS.md` 에셋 규칙 갱신 미반영(위 결정 절). 원본이 바뀌면 수동으로 다시 복사해 커밋해야 한다.
- 다음 단계: 메인 프로젝트에서 `npm start`로 실행. 원본 교체 시 저장소 사본을 함께 갱신한다.

## 통합 결과

- 메인 checkout의 실제 브랜치 master와 clean 상태를 확인하고 origin을 fetch했다. 원격 master가 작업 브랜치의 조상임을 확인했다.
- 기능 커밋 `892a323`: `git merge --ff-only task/bundled-runtime-assets` 성공(`9a5bd0c` → `892a323`), `git push origin master` 성공. 사용자 변경과 다른 worktree는 보존했다.
- 메인 checkout에서 임시 포트의 기본 핸들러를 열어 three 모듈 2개·SC0A 영상·H 정지 이미지 HEAD 200을 확인하고 서버를 닫았다. 미디어 기본 경로가 메인 프로젝트 내부 `public/display/assets/seq/`·`pose/`임을 확인했다. 앞서 처리한 메인 checkout의 `npm ci`와 에셋 통합을 함께 확인한 것이다.
- 이 통합 결과는 별도 문서 커밋으로 남긴다. 상주 서버는 띄워 두지 않았다.
