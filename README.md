# Physical AI PoC — HPC 블레이드 검사 로봇 시뮬레이션

KT AIVLE School 빅프로젝트 / 수도권 01반 01조
항공정비 Physical AI 도입 오케스트레이션 — 로봇 시뮬레이션 파트

동봉 영상: `demo_video.mp4` (1920×1080, 36.8초)

---

## ⚠ 실행 전 반드시 확인

**폴더 경로에 한글이 들어가면 안 됩니다.**

PyBullet이 한글 경로의 3D 모델 파일(`.obj`, `.stl`)을 읽지 못합니다.
오류 메시지 없이 조용히 실패하기 때문에 — 로봇은 움직이는데 블레이드만
보이지 않고, 검출이 전부 실패합니다.

```
C:\Users\...\제출자료\robot_sim_source\   ← 안 됨
C:\robot_sim_source\                      ← 이렇게
```

---

## 실행 방법

**환경**: Python 3.11 (3.14는 pybullet 휠 없음)

```bash
pip install pybullet numpy pillow imageio-ffmpeg
```

| 목적 | 명령 |
|---|---|
| 3D 창으로 미리보기 | `py -3.11 sim_physical_ai.py` |
| 프레임 렌더 (frames/*.png) | `py -3.11 sim_physical_ai.py --render` |
| mp4 인코딩 | `py -3.11 make_mp4.py` |
| 렌더가 중간에 끊겼을 때 이어서 | `py -3.11 resume_render.py` |
| 충돌·관통 전수 검증 | `py -3.11 verify_simulation.py` |
| 실행 로그(상태 전이) 출력 | `py -3.11 print_execution_log.py` |

전체 렌더는 1080p 기준 약 20분 걸립니다.
VS Code에서 실행할 경우 `.vscode/launch.json`이 포함되어 있습니다
(인터프리터를 Python 3.11로 지정해야 합니다).

---

## 이 시뮬레이션이 보이려는 것

미리 짜둔 애니메이션 재생이 **아닙니다.** 각 동작은 직전 단계의
인지·품질 판정 결과로 결정됩니다.

```
TASK_RECEIVED → PERCEIVING → PLANNING → NAVIGATING → POSITIONING
  → CAPTURING → QUALITY_CHECK ─┬─ PASS ────────→ VERIFIED → NEXT_TARGET
                               ├─ FAIL (n<2) ──→ REPLANNING → RECAPTURE
                               └─ FAIL (n≥2) ──→ HUMAN_HANDOFF (HITL)
```

| 기술축 | 구현 내용 |
|---|---|
| Perception | 세그멘테이션 마스크 기반 블레이드 검출 → 위치·yaw 추정 (**정답 좌표 미사용**) |
| Manipulation | 추정 pose 기반 IK, 잔차 런타임 보정 |
| Mobility | occupancy grid + A\* 경로계획, 작업자 회피 재계획 |
| Closed-loop | 촬영 커버리지 실측 → PASS/FAIL → 촬영 pose 재계산 → 재촬영 |
| Orchestration | 상태기계 + 실행 로그 화면 오버레이 |

**영상 구성 (블레이드 3장)**

1. 기본 검사 — 인지 → 이동 → 촬영 → 합격
2. 작업자 우회 — 경로상 작업자 감지 → A\* 재계획 → 우회 후 촬영
3. 재촬영 — 커버리지 미달 판정 → 촬영 자세 재계산 → 재촬영 → 합격

> 커버리지는 픽셀 수가 아니라 **화각 안에 들어온 블레이드 실루엣 비율**로
> 정의했습니다. 픽셀 수로 재면 잘라 찍을수록 점수가 올라가는 문제가 있습니다.

---

## 검증 결과

`verify_simulation.py` 전 프레임 전수 검사 결과 (`verify_result.txt`):

```
frames scanned : 1036
penetrations   : 0  (>5mm)
moby vs obstacle : 0 hits
moby vs 블레이드 : 0 프레임 겹침
moby y range   : -0.40 ~ 0.00 m   (우회가 실제로 실행됨)
```

정적 바디(mass 0)끼리는 PyBullet이 접촉점을 만들지 않기 때문에,
Moby–블레이드 받침대 겹침은 접촉 판정이 아니라 사각형 기하로 직접 측정합니다.

---

## 파일 구성

```
sim_physical_ai.py       메인 시뮬레이션 (인지·계획·조작·품질판정·재계획)
make_mp4.py              frames/*.png → mp4 인코딩
resume_render.py         중단된 렌더 이어서 실행
verify_simulation.py     충돌·관통 전수 검증
print_execution_log.py   상태 전이 로그 출력
indy7.urdf               협동로봇 모델 (뉴로메카 Indy7)
meshes/indy7/            URDF가 참조하는 STL 14개
blade/hpt_blade.obj      HPC 블레이드 3D 모델
demo_video.mp4           렌더 결과 영상
```

> 코드를 다시 렌더하면 길이가 34.5초로 나옵니다.
> 동봉 영상(36.8초)과의 차이는 자막 표시 시간 조정분이며, 동작 내용은 같습니다.

---

## 설계 원칙

- 최종 결함 판정은 **정비사**가 수행합니다. 로봇은 촬영과 품질 확인까지만 합니다.
- 2회 재촬영에도 커버리지가 미달이면 `HUMAN_HANDOFF` — 사람에게 넘깁니다.
- 작업자 위치는 셀 지도에 등록된 정보이며, 로봇이 센서로 감지한 것이 아닙니다.
