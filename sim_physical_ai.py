"""
D-008 Physical AI PoC - HPC 블레이드 검사 (인지 -> 판단 -> 행동 -> 결과확인 -> 재계획)

  단순 Robot Automation이 아니라 Physical AI 핵심 루프가 '실제로 구현되어 있음'을 보이는 PoC.
  각 행동은 이전 perception / quality 결과에 의해 결정된다 (미리 정해진 키프레임 재생 아님).

  구현된 기술축
    Intelligence   작업지시 -> Task 생성, 실패 시 재계획
    Perception     세그멘테이션 기반 블레이드 검출 -> 위치.yaw 추정 (정답 좌표 미사용)
    Manipulation   추정 pose 기반 IK, 잔차 런타임 보정
    Mobility       occupancy grid + A* 경로계획, 장애물 회피 재계획
    Closed-loop    coverage 실측 -> PASS/FAIL -> 촬영 pose 재계산 -> 재촬영
    Orchestration  상태기계 + 실행 로그(화면 오버레이)

  상태 전이
    TASK_RECEIVED -> PERCEIVING -> PLANNING -> NAVIGATING -> POSITIONING
      -> CAPTURING -> QUALITY_CHECK -+-> [PASS]        VERIFIED -> NEXT_TARGET
                                     +-> [FAIL, n<2]   REPLANNING -> RECAPTURE
                                     +-> [FAIL, n>=2]  HUMAN_HANDOFF (HITL)

  실행:
    py -3.11 sim_physical_ai.py            # 3D 창 미리보기
    py -3.11 sim_physical_ai.py --render   # 렌더 -> frames/*.png
    py -3.11 make_mp4.py                   # -> sim.mp4
"""
import pybullet as p
import pybullet_data
import math, os, sys, time, zlib, struct, random

# ─────────────────────────────────────────────────────────────
# PNG 저장 (외부 라이브러리 없이)
# ─────────────────────────────────────────────────────────────
def _save_png(rgb, path):
    h, w, _ = rgb.shape
    raw = b"".join(b"\x00" + rgb[y].tobytes() for y in range(h))
    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 6))
           + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)

ARGS   = sys.argv[1:]
RENDER = "--render" in ARGS
HERE   = os.path.dirname(os.path.abspath(__file__))
# URDF.메시를 상대경로로 읽으므로 실행 위치를 스크립트 폴더로 고정한다.
#   (VS Code 처럼 워크스페이스 루트에서 실행하면 'Cannot load URDF file' 로 죽는다)
os.chdir(HERE)
BLADE_OBJ = os.path.join(HERE, "blade", "hpt_blade.obj").replace("\\", "/")

FPS  = 30
W, H = (1920, 1080) if RENDER else (1280, 720)   # 렌더는 1080p
random.seed(7)                                   # 재현 가능한 시연

p.connect(p.DIRECT if RENDER else p.GUI, options=f"--width={W} --height={H}")
p.configureDebugVisualizer(p.COV_ENABLE_SHADOWS, 1)
p.setAdditionalSearchPath(pybullet_data.getDataPath())

def box(pos, half, rgba, orn=None):
    v = p.createVisualShape(p.GEOM_BOX, halfExtents=half, rgbaColor=rgba)
    c = p.createCollisionShape(p.GEOM_BOX, halfExtents=half)
    return p.createMultiBody(0, c, v, basePosition=pos, baseOrientation=orn or [0,0,0,1])

def cyl(pos, r, h, rgba, orn=None):
    v = p.createVisualShape(p.GEOM_CYLINDER, radius=r, length=h, rgbaColor=rgba)
    c = p.createCollisionShape(p.GEOM_CYLINDER, radius=r, height=h)
    return p.createMultiBody(0, c, v, basePosition=pos, baseOrientation=orn or [0,0,0,1])

# ─────────────────────────────────────────────────────────────
# 씬
# ─────────────────────────────────────────────────────────────
plane = p.loadURDF("plane.urdf")
p.changeVisualShape(plane, -1, rgbaColor=[0.16, 0.18, 0.21, 1], textureUniqueId=-1)

N_BLADE     = 3          # 시연 3장: ①기본 ②작업자 우회 ③재촬영
PITCH       = 1.20
BLADE_Y     = 0.68
BLADE_SCALE = 0.0159
MESH_OFF_Y  = 0.133                              # 메시 원점 - 형상 중심 오프셋(실측). 자세와 함께 회전한다.
LAY = lambda yaw: p.getQuaternionFromEuler([math.pi/2, 0, yaw])

def nominal_x(i):  return (i - (N_BLADE - 1)/2) * PITCH

# [S1] 실제 배치에 무작위 오차 -> 사전 정의 좌표와 다르다
TRUE_POSE = []                                   # 정답(검증 전용, 로직에서 사용 금지)
BLADE_Z   = []                                   # 블레이드별 실제 높이(정답)
Z_STD     = 0.035                                # 로봇이 가정하는 표준 안착 높이
TRAY, BLADES = [], []
for i in range(N_BLADE):
    dx  = random.uniform(-0.05, 0.05)
    dy  = random.uniform(-0.04, 0.04)
    dyaw= random.uniform(-0.28, 0.28)            # +-16도
    # [S2] 3번 블레이드는 받침대 위에 올려져 있다 -> 카메라에 그만큼 가깝다.
    #      단안 인지는 깊이를 모르므로 표준 거리로 촬영 -> 화각을 벗어남 -> 재계획으로 고도 상승
    bz = 0.16 if i == 2 else Z_STD
    if i == 2:
        dyaw = 0.62                              # 약 36도
        dx  += 0.06
    bx, by = nominal_x(i) + dx, BLADE_Y + dy
    TRUE_POSE.append((bx, by, dyaw))
    BLADE_Z.append(bz)
    if bz > Z_STD:                               # 받침대(정비장 지그)
        TRAY.append(box([bx, by, (bz - 0.02)/2], [0.13, 0.09, (bz - 0.02)/2],
                        [0.22, 0.25, 0.30, 1], LAY(dyaw)))
    else:
        TRAY.append(box([bx, by, 0.008], [0.17, 0.11, 0.008], [0.24, 0.27, 0.33, 1], LAY(dyaw)))
    vis = p.createVisualShape(p.GEOM_MESH, fileName=BLADE_OBJ, meshScale=[BLADE_SCALE]*3,
                              rgbaColor=[0.62, 0.65, 0.70, 1], specularColor=[0.45,0.45,0.5])
    # 형상 중심이 (bx,by)에 오도록 메시 원점을 되민다 (오프셋도 yaw만큼 회전)
    obx = bx - MESH_OFF_Y*math.sin(dyaw)
    oby = by + MESH_OFF_Y*math.cos(dyaw)
    BLADES.append(p.createMultiBody(0, -1, vis,
                  basePosition=[obx, oby, bz], baseOrientation=LAY(dyaw)))

# ─────────────────────────────────────────────────────────────
# DIGITAL TWIN - 가상 검사 작업 셀 (실제 공정을 1:1 복제한 것이 아니라
#   HPC 블레이드 검사에 필요한 핵심 요소만 뽑아 추상화한 PoC 환경)
# ─────────────────────────────────────────────────────────────
CELL = {"id": "HPC-INS-01", "grid": 1.0, "engine": "CF34-10E", "stage": "HPC Stage 5"}
# 검사 대상 블레이드를 Digital Asset 으로 관리한다 (3D 오브젝트가 아니라 상태를 가진 자산)
#   asset_id 는 시뮬레이션 값이다. 실제 대한항공 자산번호가 아니다.
ASSETS = [{"asset_id": "HPC-S5-BLD-%03d" % (8 + i*13),
           "engine": CELL["engine"], "stage": CELL["stage"],
           "slot": "RACK-A / SLOT-%02d" % (i+1),
           "state": "WAITING"} for i in range(N_BLADE)]

COL_IDLE   = [0.62, 0.65, 0.70, 1]
COL_ACTIVE = [0.30, 0.82, 0.90, 1]
COL_FAIL   = [0.95, 0.62, 0.25, 1]
COL_DONE   = [0.36, 0.72, 0.52, 1]

# [S3] Moby 주행선 위 장애물 (사전 계획 경로를 막는다)
OBST_H  = 0.20                                   # 작업자 최대 반폭 (팔 끝까지 포함)
#  둘 다 블레이드 쪽에 세운다. +y 로 우회하면 Moby 가 블레이드 받침대를 파고들고(실측 84mm),
#  주행 중 뻗은 팔도 블레이드를 친다. 그래서 우회는 항상 -y 쪽으로만 나게 배치한다.
#  1번(기본) 과 2번(우회) 사이에만 세운다. 3번은 재촬영 장면에 집중시킨다.
OBST = [((TRUE_POSE[0][0]+TRUE_POSE[1][0])/2, 0.32)]

def build_worker(ox, oy):
    """정비장에 서 있는 작업자 — 기본 도형 조합.
       주의: 이건 '셀 지도에 등록된 작업자 위치'다. 로봇이 센서로 사람을 감지하는 것이 아니다."""
    VEST = [0.95, 0.72, 0.15, 1]        # 고시인성 안전조끼
    SKIN = [0.82, 0.66, 0.55, 1]
    DARK = [0.22, 0.25, 0.32, 1]
    parts = []
    for dx in (-0.055, 0.055):          # 다리
        parts.append(cyl([ox+dx, oy, 0.22], 0.052, 0.44, DARK))
    parts.append(cyl([ox, oy, 0.66], 0.125, 0.44, VEST))        # 몸통(조끼)
    for dx in (-0.155, 0.155):          # 팔
        parts.append(cyl([ox+dx, oy, 0.66], 0.038, 0.40, VEST))
    parts.append(cyl([ox, oy, 0.90], 0.062, 0.06, SKIN))        # 목
    parts.append(cyl([ox, oy, 0.985], 0.095, 0.13, SKIN))       # 머리
    parts.append(cyl([ox, oy, 1.06], 0.105, 0.05, [0.95,0.85,0.20,1]))  # 안전모
    return parts

OBST_ID = []
for _ox, _oy in OBST:
    OBST_ID += build_worker(_ox, _oy)

# ─────────────────────────────────────────────────────────────
# 가상 검사 작업 셀 (Workcell) — 공정의 핵심 요소만 추상화
#   바닥 구획 · 랙 · 표지 · 그리드. 벽.천장.배관은 만들지 않는다.
#   블레이드 위치는 건드리지 않는다 (A* 여유거리.IK 도달범위가 여기에 물려 있다).
# ─────────────────────────────────────────────────────────────
Z_INSPECT = [0.30, 0.40, 0.47, 1]      # 검사 영역 (푸른 계열)
Z_ROBOT   = [0.17, 0.19, 0.24, 1]      # 로봇 주행 레인 (어둡게 — 통로처럼)
Z_OPER    = [0.27, 0.36, 0.31, 1]      # 정비사 영역 (초록 계열)
Z_LINE    = [0.62, 0.68, 0.78, 1]      # 구획선
CELL_X    = (N_BLADE/2.0)*PITCH + 0.6  # 셀 반폭

def pad(cx, cy, hx, hy, rgba, z=0.002):
    return box([cx, cy, z], [hx, hy, 0.002], rgba)

WORKCELL = []
WORKCELL.append(pad(0,  0.78, CELL_X, 0.36, Z_INSPECT))          # 검사 영역
WORKCELL.append(pad(0,  0.00, CELL_X, 0.34, Z_ROBOT, 0.003))     # 로봇 주행 레인
WORKCELL.append(pad(0, -0.74, CELL_X, 0.30, Z_OPER))             # 정비사 영역
for _y in (0.36, -0.36):                                         # 레인 경계선
    WORKCELL.append(pad(0, _y, CELL_X, 0.010, Z_LINE, 0.004))
# 1m 그리드 — 셀을 디지털 좌표계로 추상화했다는 표시 (얇게)
_gx = 0.0
while _gx <= CELL_X:
    for _sx in ({_gx, -_gx}):
        WORKCELL.append(pad(_sx, 0.02, 0.004, 1.12, [0.40,0.45,0.53,1], 0.0015))
    _gx += CELL["grid"]
# 블레이드 랙 — 배경. 낮고 얇게 (시야를 가리지 않게)
RACK = []
for i in range(N_BLADE):
    rx = nominal_x(i)
    RACK.append(box([rx-0.24, 1.06, 0.07], [0.02, 0.10, 0.07], [0.34, 0.39, 0.46, 1]))  # 슬롯 칸막이
RACK.append(box([nominal_x(N_BLADE-1)+0.24, 1.06, 0.07], [0.02, 0.10, 0.07], [0.34,0.39,0.46,1]))
RACK.append(box([0, 1.06, 0.012], [CELL_X-0.35, 0.11, 0.012], [0.26, 0.30, 0.36, 1]))    # 랙 베이스
# 영역 표지 (작은 색 블록 — 글자는 오버레이가 담당)
SIGN = [box([-CELL_X+0.16,  0.78, 0.12], [0.02, 0.13, 0.12], [0.35, 0.72, 0.85, 1]),
        box([-CELL_X+0.16,  0.00, 0.12], [0.02, 0.13, 0.12], [0.88, 0.72, 0.35, 1]),
        box([-CELL_X+0.16, -0.74, 0.12], [0.02, 0.13, 0.12], [0.40, 0.80, 0.55, 1])]

# Moby + Indy7
MOBY_H = 0.28
def build_moby():
    b  = box([0, 0, MOBY_H/2], [0.26, 0.20, MOBY_H/2], [0.20, 0.22, 0.26, 1])
    t  = box([0, 0, MOBY_H + 0.012], [0.28, 0.22, 0.012], [0.30, 0.33, 0.38, 1])
    ws = [cyl([sx, sy, 0.07], 0.07, 0.05, [0.08,0.09,0.11,1],
              p.getQuaternionFromEuler([math.pi/2, 0, 0]))
          for sx in (-0.18, 0.18) for sy in (-0.21, 0.21)]
    return [b, t] + ws
MOBY_PARTS = build_moby()
MOBY_LOCAL = [p.getBasePositionAndOrientation(b)[0] for b in MOBY_PARTS]

robot = p.loadURDF("indy7.urdf", basePosition=[0, 0, MOBY_H + 0.024], useFixedBase=True)
EE  = 7
MOV = [j for j in range(p.getNumJoints(robot)) if p.getJointInfo(robot, j)[2] == p.JOINT_REVOLUTE]

cam_body  = box([0,0,-5], [0.035, 0.045, 0.028], [0.13, 0.15, 0.18, 1])
lens_body = cyl([0,0,-5], 0.018, 0.03, [0.08, 0.09, 0.11, 1])

# ─────────────────────────────────────────────────────────────
# PERCEPTION - 세그멘테이션으로 블레이드 검출 (정답 좌표 미사용)
# ─────────────────────────────────────────────────────────────
import numpy as np
PCAM_N, PCAM_FOV, PCAM_Z = 256, 50.0, 0.75

def _pca(xs, ys):
    """2x2 공분산 주축 (np.linalg.eigh 미사용 - 이 환경에서 크래시).
       반환: 중심, 장축각(deg), 장축/단축 비(길쭉할수록 각도 추정이 신뢰됨)"""
    n = len(xs)
    cx = sum(xs)/n; cy = sum(ys)/n
    sxx = syy = sxy = 0.0
    for x, y in zip(xs, ys):
        dx = x-cx; dy = y-cy
        sxx += dx*dx; syy += dy*dy; sxy += dx*dy
    sxx/=n; syy/=n; sxy/=n
    th = 0.5*math.atan2(2.0*sxy, sxx-syy)
    tr, d = (sxx+syy)/2.0, math.hypot((sxx-syy)/2.0, sxy)
    l1, l2 = tr+d, max(tr-d, 1e-9)
    return cx, cy, math.degrees(math.atan2(-math.sin(th), math.cos(th))), math.sqrt(l1/l2)

def perceive(idx, cam_xy):
    """상방 카메라 1장으로 블레이드 위치.yaw 추정. 실패 시 None."""
    ex, ey = cam_xy
    vm = p.computeViewMatrix([ex, ey, PCAM_Z], [ex, ey, 0.0], [0, 1, 0])
    pm = p.computeProjectionMatrixFOV(PCAM_FOV, 1.0, 0.05, 3.0)
    res = p.getCameraImage(PCAM_N, PCAM_N, vm, pm, renderer=p.ER_BULLET_HARDWARE_OPENGL)
    seg = np.reshape(np.array(res[4]), (PCAM_N, PCAM_N))
    mask = (seg == BLADES[idx])
    npx = int(mask.sum())
    if npx < 60:
        return None
    ys, xs = np.nonzero(mask)
    cx, cy, yaw, elong = _pca(xs.tolist(), ys.tolist())
    span = 2.0*(PCAM_Z - 0.035)*math.tan(math.radians(PCAM_FOV/2.0))
    wx = ex + (cx - PCAM_N/2.0)/PCAM_N*span
    wy = ey - (cy - PCAM_N/2.0)/PCAM_N*span
    yaw = (yaw - 90.0 + 90) % 180 - 90            # 메시 장축 보정
    # 검출 신뢰도 - 학습 모델이 아니라 마스크 통계에서 뽑은 휴리스틱.
    #   실루엣이 클수록 / 길쭉할수록(장축 방향이 뚜렷) / 프레임에 안 닿을수록 신뢰.
    edge = bool(xs.min() <= 1 or ys.min() <= 1 or
                xs.max() >= PCAM_N-2 or ys.max() >= PCAM_N-2)
    conf = (0.55 + 0.25*min(1.0, npx/2200.0)
                 + 0.20*min(1.0, (elong-1.0)/2.5)) * (0.70 if edge else 1.0)
    return {"x": wx, "y": wy, "yaw": yaw, "px": npx,
            "elong": elong, "conf": max(0.0, min(0.99, conf)), "clipped": edge}

# ─────────────────────────────────────────────────────────────
# MANIPULATION - 추정 pose 기반 IK (+ 잔차 런타임 보정)
# ─────────────────────────────────────────────────────────────
CAM_H = 0.50
DOWN  = p.getQuaternionFromEuler([0, math.pi/2, 0])
HOME  = [0, math.radians(-100), math.radians(115), 0, math.radians(-10), 0]
_LO=[-3.0]*len(MOV); _HI=[3.0]*len(MOV); _RNG=[6.0]*len(MOV)

def _axis_q(ax, ay, az, ang):
    """축-각 -> 쿼터니언 [x,y,z,w]"""
    n = math.sqrt(ax*ax + ay*ay + az*az) or 1.0
    sh = math.sin(ang/2.0)
    return [ax/n*sh, ay/n*sh, az/n*sh, math.cos(ang/2.0)]

def cam_orn(yaw_deg=0.0, tilt_deg=0.0, tilt_dir=(1.0, 0.0)):
    """촬영 카메라 자세.
       yaw_deg  : 인지한 블레이드 장축에 이미지 세로축을 맞춘다  (인지 -> 자세)
       tilt_deg : 부족했던 부위 쪽으로 광축을 기울인다          (품질 -> 자세)"""
    q = DOWN
    if abs(yaw_deg) > 1e-6:
        q = p.multiplyTransforms([0,0,0], _axis_q(0, 0, 1, math.radians(yaw_deg)),
                                 [0,0,0], q)[1]
    if abs(tilt_deg) > 1e-6:
        a = math.atan2(tilt_dir[1], tilt_dir[0])
        q = p.multiplyTransforms([0,0,0], _axis_q(math.sin(a), -math.cos(a), 0,
                                                  math.radians(tilt_deg)),
                                 [0,0,0], q)[1]
    return q

def ik_world(target, orn=None):
    for i, j in enumerate(MOV):
        p.resetJointState(robot, j, HOME[i])
    q = p.calculateInverseKinematics(robot, EE, target, orn if orn is not None else DOWN,
            lowerLimits=_LO, upperLimits=_HI, jointRanges=_RNG, restPoses=HOME,
            maxNumIterations=800, residualThreshold=1e-6)
    return list(q[:len(MOV)])

def plan_capture_pose(det, moby_x, height=CAM_H, offset=(0.0, 0.0),
                      tilt_deg=0.0, tilt_dir=(1.0, 0.0)):
    """인지된 블레이드 pose -> 촬영 목표 pose -> IK. 잔차를 측정해 목표를 되잡는다.
       위치는 det[x],det[y] 에서, 자세는 det[yaw] 에서 나온다 (고정 좌표 아님)."""
    # IK는 월드 좌표계로 푼다 -> 베이스를 촬영 위치에 먼저 세워야 한다
    p.resetBasePositionAndOrientation(robot, [moby_x, 0, MOBY_H + 0.024], [0, 0, 0, 1])
    orn = cam_orn(det.get("yaw", 0.0), tilt_deg, tilt_dir)
    tgt = [det["x"] + offset[0], det["y"] + offset[1], 0.03 + height]
    goal = list(tgt)
    q = ik_world(goal, orn)
    err = None
    for _ in range(6):
        for i, j in enumerate(MOV):
            p.resetJointState(robot, j, q[i])
        pos = p.getLinkState(robot, EE, computeForwardKinematics=True)[4]
        ex_ = pos[0] - tgt[0]
        ey_ = pos[1] - tgt[1]
        err = math.hypot(ex_, ey_)
        if err < 0.004:
            break
        goal[0] -= ex_; goal[1] -= ey_
        q = ik_world(goal, orn)
    return q, err

# 주행 자세 — 팔을 세워 접는다. 손끝은 베이스 근처로 오지만 팔꿈치는 옆으로 약 0.43 m 뻗는다.
#   (관절값으로 더 접으면 Moby 본체를 파고든다 - 실측 확인)
#   그래서 아래 CLR_Y 에 이 도달거리를 반영한다.
LIFT_POSE = ik_world([0.0, 0.20, 0.03 + CAM_H + 0.42])

# ─────────────────────────────────────────────────────────────
# CLOSED-LOOP - coverage 실측 (렌더 픽셀 기반, 수치를 지어내지 않음)
# ─────────────────────────────────────────────────────────────
QCAM_N   = 200
CAM_STANDOFF = 0.06                               # 플랜지 -> 렌즈 오프셋
QCAM_FOV  = 34.0                                  # 검사 촬영 화각
QCAM_WIDE = 100.0                                 # 전체 실루엣 확보용 광각(평가 전용)
COV_PASS = 0.90
REG_PASS = 0.88          # 부위별 기준. 전체 평균이 좋아도 특정 부위가 덜 찍히면 불합격.
                         # (팁 균열은 팁이 안 찍히면 못 본다 - 평균으로 덮으면 안 되는 값)

def evaluate_capture(idx, q, moby_x):
    """현재 팔 자세로 EE 카메라 촬영 -> 화각에 담긴 비율을 '부위별'로 실측.
       coverage = 화각 안에 들어온 실루엣 / 부품 전체 실루엣 (거리.배율 무관)"""
    # 카메라 몸체 더미가 EE 바로 앞(near plane 안쪽)에 있으면 자기 시야를 가린다 -> 잠시 치움
    for _b in (cam_body, lens_body):
        p.resetBasePositionAndOrientation(_b, [0, 0, -5], [0, 0, 0, 1])
    for i, j in enumerate(MOV):
        p.resetJointState(robot, j, q[i])
    p.resetBasePositionAndOrientation(robot, [moby_x, 0, MOBY_H + 0.024], [0,0,0,1])
    st = p.getLinkState(robot, EE, computeForwardKinematics=True)
    pos, orn = st[4], st[5]
    R = p.getMatrixFromQuaternion(orn)
    fwd = [R[0], R[3], R[6]]
    up  = [R[2], R[5], R[8]]                       # 이미지 세로축 (yaw 정렬 결과가 반영된다)
    # 카메라는 플랜지에서 앞으로 CAM_STANDOFF 만큼 나온 브래킷에 달려 있다.
    # (플랜지 원점에 두면 손목 링크가 시야를 가려 coverage가 자세마다 튄다)
    eye = [pos[i] + fwd[i]*CAM_STANDOFF for i in range(3)]
    tgt = [eye[i] + fwd[i]*0.6 for i in range(3)]
    vm = p.computeViewMatrix(eye, tgt, up)
    # 넓은 화각으로 한 장 찍어 '부품 전체'를 확보하고,
    # 그 안에서 실제 검사 화각(34도) 창에 들어온 픽셀만 세어 비율을 낸다.
    pm = p.computeProjectionMatrixFOV(QCAM_WIDE, 1.0, 0.02, 3.0)
    res = p.getCameraImage(QCAM_N, QCAM_N, vm, pm, renderer=p.ER_BULLET_HARDWARE_OPENGL)
    seg = np.reshape(np.array(res[4]), (QCAM_N, QCAM_N))
    m = (seg == BLADES[idx])
    total = int(m.sum())
    c = QCAM_N/2.0
    half = c * math.tan(math.radians(QCAM_FOV/2.0)) / math.tan(math.radians(QCAM_WIDE/2.0))
    if total < 40:
        return {"cov": 0.0, "bias": (0.0, 0.0), "regions": {}, "half": half,
                "seen": 0, "slack": {"xp":0.0,"xm":0.0,"yp":0.0,"ym":0.0}}
    ys, xs = np.nonzero(m)
    inside = (np.abs(xs - c) <= half) & (np.abs(ys - c) <= half)
    cov = float(inside.sum()) / float(total)

    # ── 부위 분할: 실루엣 주축 기준. 팁/루트는 '폭'으로 가른다(도브테일 쪽이 넓다).
    fx, fy = xs - xs.mean(), ys - ys.mean()
    sxx = float((fx*fx).mean()); syy = float((fy*fy).mean()); sxy = float((fx*fy).mean())
    th = 0.5*math.atan2(2.0*sxy, sxx - syy)
    ux, uy = math.cos(th), math.sin(th)            # 장축
    t = fx*ux + fy*uy                              # 장축 좌표
    sdist = np.abs(-fx*uy + fy*ux)                 # 중심선에서의 폭
    lo, hi = float(t.min()), float(t.max())
    endA = t <= lo + 0.25*(hi-lo)
    endB = t >= hi - 0.25*(hi-lo)
    wA = float(sdist[endA].mean()) if endA.any() else 0.0
    wB = float(sdist[endB].mean()) if endB.any() else 0.0
    tip_m, root_m = (endA, endB) if wA < wB else (endB, endA)   # 좁은 쪽 = 팁
    edge_m = sdist >= 0.62*float(sdist.max())                    # 외곽 엣지 띠

    regions = {}
    for name, msk in (("팁", tip_m), ("루트", root_m), ("외곽 엣지", edge_m)):
        n = int(msk.sum())
        if n < 10:
            continue
        r = float((inside & msk).sum()) / n
        # 그 부위 실루엣의 무게중심(화각창 기준 정규화) -> 어느 쪽으로 벗어났는지
        regions[name] = (r,
                         float((xs[msk].mean() - c)/half),
                         float((ys[msk].mean() - c)/half))
    dx = float((xs.mean() - c) / half)
    dy = float((ys.mean() - c) / half)
    # 화각창 각 변에 남은 여유(정규화). 음수면 이미 그 변으로 삐져나갔다.
    nx = (xs - c)/half; ny = (ys - c)/half
    slack = {"xp": 1.0-float(nx.max()), "xm": 1.0+float(nx.min()),
             "yp": 1.0-float(ny.max()), "ym": 1.0+float(ny.min())}
    return {"cov": cov, "bias": (max(-2.0, min(2.0, dx)), max(-2.0, min(2.0, dy))),
            "regions": regions, "half": half, "seen": int(inside.sum()), "slack": slack}

def diagnose(qr):
    """품질 결과 -> 실패 원인. 어느 부위가 왜 모자란지, 어느 쪽으로 벗어났는지."""
    regs = qr["regions"]
    if not regs:
        return {"reason": "부품 미검출", "region": None, "dir": (0.0, 0.0), "all_short": True}
    worst = min(regs, key=lambda k: regs[k][0])
    r, rx, ry = regs[worst]
    all_short = all(v[0] < REG_PASS for v in regs.values())
    # 그 부위 쪽으로 옮기려면 반대쪽에 그만큼 여유가 있어야 한다 -> 실측 슬랙으로 확인
    n = math.hypot(rx, ry) or 1.0
    ux, uy = rx/n, ry/n
    sl = qr.get("slack", {})
    room = min(sl.get("xm" if ux > 0 else "xp", 0.0) if abs(ux) > 0.2 else 9.9,
               sl.get("ym" if uy > 0 else "yp", 0.0) if abs(uy) > 0.2 else 9.9)
    short = max(0.0, REG_PASS - r)
    need  = 0.50*min(1.0, short/0.10)          # 필요한 이동량(정규화)
    tight = room < need*0.8                    # 옮길 자리가 없다
    if all_short:
        reason = "부품 전체가 화각보다 큼 (촬영 거리 부족)"
    elif tight:
        reason = "%s 부족 · 반대편 여유 %d%% 뿐 (옮길 공간 없음)" % (worst, int(max(0,room)*100))
    else:
        reason = "%s 영역만 부족 (%d%% < %d%%)" % (worst, int(r*100), int(REG_PASS*100))
    return {"reason": reason, "region": worst, "worst": r, "dir": (rx, ry),
            "all_short": all_short or tight, "tight": tight, "room": room}

def replan_pose(det, moby_x, qr, dg, cur):
    """실패 원인 -> 새 촬영 pose.  cur = 직전 촬영 자세 (h, off, tilt).
       직전 자세에서 '고쳐야 할 만큼만' 더한다 (매번 기본자세로 되돌리면 앞선 보정을 잃는다).
         - 전체가 화각 초과 : 촬영 거리를 띄운다
         - 특정 부위만 부족 : 그 부위 쪽으로 조금 옮기고 광축을 그쪽으로 기울인다
       시도 횟수가 아니라 '원인'이 값을 정한다."""
    h, off, tilt = cur["h"], list(cur["off"]), cur["tilt"]
    span = 2*h*math.tan(math.radians(QCAM_FOV/2))
    rx, ry = dg["dir"]
    n = math.hypot(rx, ry) or 1.0
    # 이미지 x -> 월드 +x, 이미지 y -> 월드 -y
    ux, uy = rx/n, -ry/n
    if dg["all_short"]:
        # 부족한 만큼 '한 번에' 띄운다. 조금씩 올리면 재촬영이 두 번 세 번 반복된다.
        #   촬영률이 많이 모자랄수록 더 크게 물러난다.
        short = max(0.0, COV_PASS - qr.get("cov", 0.0))  # 0.90 - 0.70 = 0.20
        h += 0.10 + short * 0.5                          # -> +0.20
        off[0] += qr["bias"][0]*span*0.15
        off[1] -= qr["bias"][1]*span*0.15
        tdir = (ux, uy)
    else:
        short = max(0.0, REG_PASS - dg.get("worst", 0.0))
        step  = span*0.25*min(1.0, short/0.10)           # 모자란 만큼만 이동
        off[0] += ux*step
        off[1] += uy*step
        tilt   = max(-20.0, min(20.0, tilt + 6.0 + 60.0*short))
        tdir = (ux, uy)
    q, err = plan_capture_pose(det, moby_x, height=h, offset=tuple(off),
                              tilt_deg=tilt, tilt_dir=tdir)
    return (q, err), {"h": h, "off": tuple(off), "tilt": tilt}

# ─────────────────────────────────────────────────────────────
# MOBILITY - occupancy grid + A* (장애물 회피 재계획)
# ─────────────────────────────────────────────────────────────
GRID_X = [round(-1.90 + 0.10*i, 2) for i in range(39)]      # -1.9 ~ 1.9
#  +y 상한 0.1 : 그 위로 가면 Moby 가 블레이드 받침대에 닿고 주행 자세의 팔이 블레이드를 친다
GRID_Y = [round(-0.50 + 0.10*i, 2) for i in range(7)]       # -0.5 ~ 0.1
# Moby 상판 반치수 + 장애물 반폭 + 여유 -> 실제 겹침 조건 (원 근사는 과소평가라 통과가 났었다)
#   x : Moby 발자국 기준 (주행 중 팔은 앞뒤로 0.19 m 만 나온다)
#   y : 주행 중 팔꿈치가 옆으로 0.43 m 뻗으므로 그것까지 반영해야 사람을 스치지 않는다
ARM_SIDE = 0.43
CLR_X = 0.28 + OBST_H + 0.04
CLR_Y = ARM_SIDE + OBST_H + 0.05

def occupied(x, y):
    for ox, oy in OBST:
        if abs(x-ox) < CLR_X and abs(y-oy) < CLR_Y:
            return True
    return False

# 빌드 시점 검사: 촬영 정지 위치가 장애물 여유구간에 물리면 Moby가 겹친 채 정차한다.
# (정적 바디끼리는 getContactPoints가 접촉을 만들지 않아 런타임 충돌검사로는 안 잡힌다)
for _i, (_bx, _by, _) in enumerate(TRUE_POSE):
    if occupied(_bx, 0.0):
        raise SystemExit("[scene] blade #%d 정지위치 x=%.2f 가 장애물 여유구간과 겹칩니다. "
                         "PITCH 또는 OBST 배치를 조정하세요." % (_i+1, _bx))

def astar(start, goal):
    """4-이웃 A* (격자). 경로 없으면 직선 반환."""
    import heapq
    def snap(pt):
        gx = min(GRID_X, key=lambda v: abs(v-pt[0]))
        gy = min(GRID_Y, key=lambda v: abs(v-pt[1]))
        return (gx, gy)
    s, g = snap(start), snap(goal)
    h = lambda a: abs(a[0]-g[0]) + abs(a[1]-g[1])
    openq = [(h(s), 0.0, s, None)]
    came, seen = {}, set()
    while openq:
        f, gc, cur, par = heapq.heappop(openq)
        if cur in seen: continue
        seen.add(cur); came[cur] = par
        if cur == g:
            path, n = [], cur
            while n: path.append(n); n = came[n]
            return list(reversed(path))
        for dx, dy in ((0.10,0), (-0.10,0), (0,0.10), (0,-0.10)):
            nx, ny = round(cur[0]+dx, 2), round(cur[1]+dy, 2)
            if nx not in GRID_X or ny not in GRID_Y: continue
            if occupied(nx, ny) or (nx, ny) in seen:  continue
            heapq.heappush(openq, (gc+0.10+h((nx,ny)), gc+0.10, (nx,ny), cur))
    return None                                             # 경로 없음 (직선으로 위장하지 않는다)

def simplify(path):
    """직선 구간 병합 -> waypoint 최소화"""
    if len(path) < 3: return path
    out = [path[0]]
    for i in range(1, len(path)-1):
        ax, ay = path[i][0]-path[i-1][0], path[i][1]-path[i-1][1]
        bx, by = path[i+1][0]-path[i][0], path[i+1][1]-path[i][1]
        if (ax, ay) != (bx, by):
            out.append(path[i])
    out.append(path[-1])
    return out

# ─────────────────────────────────────────────────────────────
# ORCHESTRATION - 상태기계 실행 (여기서 '결과'가 먼저 만들어진다)
# ─────────────────────────────────────────────────────────────
LOG = []            # (t_start, state, line1, line2)
TRACK = []          # 프레임별 (moby_x, q, colors, log_index)
MAX_RETRY = 2

# Physical AI 상태(문자열 하나) -> Digital Twin 3축 상태.
#   단일 진실원천 유지: FSM 이 바뀌면 여기서 파생될 뿐, 따로 하드코딩하지 않는다.
DT_MAP = {
 "TASK_RECEIVED":   ("IDLE",        None,                 "ASSIGNED"),
 "PERCEIVING":      ("SCANNING",    "TARGETED",           "ROBOT_EXECUTING"),
 "PLANNING":        ("PLANNING",    "TARGETED",           "ROBOT_EXECUTING"),
 "NAVIGATING":      ("MOVING",      "TARGETED",           "ROBOT_EXECUTING"),
 "REPLANNING(path)":("REPLANNING",  "TARGETED",           "ROBOT_EXECUTING"),
 "POSITIONING":     ("POSITIONING", "INSPECTING",         "ROBOT_EXECUTING"),
 "CAPTURING":       ("CAPTURING",   "INSPECTING",         "ROBOT_EXECUTING"),
 "QUALITY_CHECK":   ("CAPTURING",   "QUALITY_CHECK",      "QUALITY_CHECK"),
 "DECISION":        ("REPLANNING",  "RECAPTURE_REQUIRED", "QUALITY_CHECK"),
 "REPLANNING":      ("REPLANNING",  "RECAPTURE_REQUIRED", "RECAPTURE"),
 "RECAPTURE":       ("CAPTURING",   "INSPECTING",         "RECAPTURE"),
 "VERIFIED":        ("COMPLETE",    "VERIFIED",           "VERIFIED"),
 "HUMAN_HANDOFF":   ("IDLE",        "HANDOFF_REQUIRED",   "HUMAN_HANDOFF"),
 "NEXT_TARGET":     ("MOVING",      None,                 "ASSIGNED"),
 "TASK COMPLETE":   ("IDLE",        None,                 "COMPLETE"),
}
DT  = []            # LOG 와 같은 길이. 각 로그 시점의 Digital Twin 스냅샷
CUR = {"bi": None, "cov": None, "qres": None, "reason": None, "shots": 0,
       "plan": None, "act": None}

def log(t, state, l1, l2="", l3=""):
    LOG.append((t, state, l1, l2, l3))
    rs, bs, ins = DT_MAP.get(state, ("IDLE", None, "ASSIGNED"))
    bi = CUR["bi"]
    if bi is not None and bs:                 # 자산 상태를 실제로 갱신한다
        ASSETS[bi]["state"] = bs
    DT.append({"robot": rs, "blade": bs, "insp": ins, "bi": bi,
               "cov": CUR["cov"], "qres": CUR["qres"],
               "reason": CUR["reason"], "shots": CUR["shots"],
               "plan": CUR["plan"], "act": CUR["act"],
               "assets": [a["state"] for a in ASSETS]})

def lerp_q(a, b, r):
    r = r*r*(3-2*r)
    return [x + (y-x)*r for x, y in zip(a, b)]

def emit(dur, moby_xy, q, colors, li):
    """dur초 동안의 프레임을 트랙에 기록"""
    for _ in range(max(1, int(dur*FPS))):
        TRACK.append((moby_xy[0], moby_xy[1], list(q), list(colors), li))

def emit_move(dur, m0, m1, q0, q1, colors, li):
    """Moby (x,y) 와 관절을 동시에 보간 - A* 우회가 실제로 재생된다"""
    n = max(1, int(dur*FPS))
    for k in range(n):
        r = (k+1)/n
        e = r*r*(3-2*r)                                   # ease-in-out
        TRACK.append((m0[0] + (m1[0]-m0[0])*e,
                      m0[1] + (m1[1]-m0[1])*e,
                      lerp_q(q0, q1, r), list(colors), li))

def run_task():
    """Physical AI 루프 실행 - 각 행동은 직전 결과로 결정된다"""
    t = 0.0
    colors = [COL_IDLE[:] for _ in range(N_BLADE)]
    moby_x, moby_y = nominal_x(0) - 0.45, 0.0
    q_cur  = list(LIFT_POSE)

    log(t, "TASK_RECEIVED", "WO-2026-0805-01   HPC 블레이드 외관검사",
        "대상 %d장 · 촬영 합격 기준 %d%%" % (N_BLADE, int(COV_PASS*100)))
    emit(1.0, (moby_x, moby_y), q_cur, colors, len(LOG)-1); t += 1.0

    for i in range(N_BLADE):
        colors[i] = COL_ACTIVE[:]
        CUR.update(bi=i, cov=None, qres=None, reason=None, shots=0)

        # ---------- PERCEIVING : 대략 위치에서 상방 스캔 ----------
        approx = (nominal_x(i), BLADE_Y)
        det = perceive(i, approx)
        if det is None:
            log(t, "PERCEIVING", "블레이드 #%02d 미검출" % (i+1), "건너뛰고 다음 대상으로")
            emit(0.8, (moby_x, moby_y), q_cur, colors, len(LOG)-1); t += 0.8
            colors[i] = COL_IDLE[:]; continue
        tx, ty, tyaw = TRUE_POSE[i]                       # 검증 표기용(로직 미사용)
        perr = math.hypot(det["x"]-tx, det["y"]-ty)
        log(t, "PERCEIVING",
            "블레이드 #%02d 검출   신뢰도 %d%%" % (i+1, int(det["conf"]*100)),
            "사전 위치 x=%.2f y=%.2f 각도 %+.0f°  →  검출 x=%.2f y=%.2f 각도 %+.1f°" %
            (nominal_x(i), BLADE_Y, 0.0, det["x"], det["y"], det["yaw"]),
            "차이 %.0f mm / %+.1f°  → 촬영 자세를 이 값으로 다시 계산 (실측 오차 %.0f mm)" %
            (math.hypot(det["x"]-nominal_x(i), det["y"]-BLADE_Y)*1000,
             det["yaw"], perr*1000))
        emit(1.2, (moby_x, moby_y), q_cur, colors, len(LOG)-1); t += 1.2

        # ---------- PLANNING : 추정 pose로 촬영 목표 계산 ----------
        goal_mx = det["x"]
        q_shot, ikerr = plan_capture_pose(det, goal_mx)
        log(t, "PLANNING",
            "고정 좌표가 아니라 인지 결과로 촬영 자세를 계산",
            "목표 x=%.3f y=%.3f 높이 %.2f m · 카메라를 장축 %+.1f°에 정렬" %
            (det["x"], det["y"], CAM_H, det["yaw"]),
            "IK 잔차 %.0f mm" % ((ikerr or 0)*1000))
        emit(0.9, (moby_x, moby_y), q_cur, colors, len(LOG)-1); t += 0.9

        # ---------- NAVIGATING : A* 경로 (장애물이면 우회) ----------
        CUR["plan"] = [(moby_x, moby_y), (goal_mx, 0.0)]      # 장애물이 없다면 갔을 직선
        raw  = astar((moby_x, moby_y), (goal_mx, 0.0))
        path = simplify(raw) if raw else [(moby_x, moby_y), (goal_mx, 0.0)]
        detour = bool(raw) and any(abs(wy) > 1e-6 for _, wy in raw)
        CUR["act"] = list(path)                                # 실제로 주행한 경로
        blocked = any(occupied(px, 0.0) for px in
                      [moby_x + (goal_mx-moby_x)*k/10 for k in range(11)])
        if blocked and detour:
            log(t, "REPLANNING(path)", "주행선에 작업자 — A* 우회 경로 생성",
                "경유점: %s" % " → ".join("(%.1f,%.1f)" % w for w in path[:4]))
        else:
            log(t, "NAVIGATING", "경로 확보   경유점 %d개" % len(path),
                "Moby %.2f m → %.2f m" % (moby_x, goal_mx))
        li = len(LOG)-1
        # 출발 전에 팔을 먼저 접는다. 접으면서 동시에 달리면 접히는 중에 작업자를 스친다.
        if q_cur != LIFT_POSE:
            emit_move(0.5, (moby_x, moby_y), (moby_x, moby_y), q_cur, LIFT_POSE, colors, li)
            q_cur = list(LIFT_POSE); t += 0.5
        for wp in path[1:]:
            dur = max(0.25, math.hypot(wp[0]-moby_x, wp[1]-moby_y)/1.15)
            emit_move(dur, (moby_x, moby_y), (wp[0], wp[1]),
                      q_cur, LIFT_POSE, colors, li)
            moby_x, moby_y = wp[0], wp[1]; q_cur = list(LIFT_POSE); t += dur

        # ---------- POSITIONING ----------
        q_shot, ikerr = plan_capture_pose(det, moby_x)
        log(t, "POSITIONING", "Indy7 팔을 촬영 자세로 정렬",
            "IK 수렴 · 잔차 %.0f mm" % ((ikerr or 0)*1000))
        emit_move(0.9, (moby_x, moby_y), (moby_x, moby_y), q_cur, q_shot, colors, len(LOG)-1); t += 1.1
        q_cur = list(q_shot)

        # ---------- CAPTURE -> QUALITY -> (REPLAN -> RECAPTURE) 루프 ----------
        attempt, verified = 0, False
        cur_pose = {"h": CAM_H, "off": (0.0, 0.0), "tilt": 0.0}
        while attempt <= MAX_RETRY:
            log(t, "CAPTURING" if attempt == 0 else "RECAPTURE",
                "%d차 촬영   블레이드 #%02d" % (attempt+1, i+1), "")
            emit(1.1, (moby_x, moby_y), q_cur, colors, len(LOG)-1); t += 1.1

            qr = evaluate_capture(i, q_cur, moby_x)
            cov = qr["cov"]
            CUR.update(cov=cov, shots=attempt+1,
                       qres=("PASS" if cov >= COV_PASS and
                             all(v[0] >= REG_PASS for v in qr["regions"].values()) else "FAIL"))
            # 전체 촬영률과 부위별 기준을 모두 만족해야 합격
            ok = (cov >= COV_PASS and
                  all(v[0] >= REG_PASS for v in qr["regions"].values()))
            log(t, "QUALITY_CHECK",
                "화각 내 촬영률 %.0f%%   (기준 %d%%)" % (cov*100, int(COV_PASS*100)),
                "부위별(기준 %d%%)  " % int(REG_PASS*100) + " · ".join(
                    "%s %d%% %s" % (n, int(v[0]*100), "합격" if v[0] >= REG_PASS else "불합격")
                    for n, v in qr["regions"].items()),
                "판정: %s" % ("합격" if ok else "불합격"))
            emit(1.5 if not ok else 1.2, (moby_x, moby_y), q_cur, colors, len(LOG)-1); t += 1.5 if not ok else 1.2

            if ok:
                verified = True
                break
            attempt += 1
            if attempt > MAX_RETRY:
                break
            colors[i] = COL_FAIL[:]
            dg = diagnose(qr)
            CUR["reason"] = dg["reason"]
            log(t, "DECISION", "실패 원인: " + dg["reason"],
                "재촬영 필요 — 원인에 맞춰 촬영 자세를 바꾼다")
            emit(1.1, (moby_x, moby_y), q_cur, colors, len(LOG)-1); t += 1.1

            (q_new, ikerr2), cur_pose = replan_pose(det, moby_x, qr, dg, cur_pose)
            log(t, "REPLANNING",
                ("촬영 거리 확보 → 높이 %.2f m" % cur_pose["h"]) if dg["all_short"]
                else ("%s 쪽으로 카메라 이동 + 광축 %.0f° 기울임"
                      % (dg["region"], cur_pose["tilt"])),
                "누적 보정 (%+.0f, %+.0f) mm · 높이 %.2f m · tilt %.0f°"
                % (cur_pose["off"][0]*1000, cur_pose["off"][1]*1000,
                   cur_pose["h"], cur_pose["tilt"]))
            emit(1.3, (moby_x, moby_y), q_cur, colors, len(LOG)-1); t += 1.3
            emit_move(0.6, (moby_x, moby_y), (moby_x, moby_y), q_cur, q_new, colors, len(LOG)-1); t += 0.6
            q_cur = list(q_new)

        # ---------- VERIFIED / HUMAN_HANDOFF ----------
        CUR["reason"] = None if verified else CUR["reason"]
        if verified:
            colors[i] = COL_DONE[:]
            log(t, "VERIFIED", "블레이드 #%02d 검증 완료   촬영 %d회" % (i+1, attempt+1),
                "검사 증거 사진을 정비기록에 연결")
        else:
            colors[i] = COL_FAIL[:]
            log(t, "HUMAN_HANDOFF", "블레이드 #%02d 촬영 기준 미달" % (i+1),
                "정비사에게 인계 (HITL)")
        emit(1.2, (moby_x, moby_y), q_cur, colors, len(LOG)-1); t += 1.2

        # ---------- NEXT_TARGET ----------
        if i < N_BLADE-1:
            log(t, "NEXT_TARGET", "블레이드 #%02d → #%02d" % (i+1, i+2), "")
            emit_move(0.6, (moby_x, moby_y), (moby_x, moby_y), q_cur, LIFT_POSE, colors, len(LOG)-1); t += 0.6
            q_cur = list(LIFT_POSE)

    done = sum(1 for c in colors if c == COL_DONE)
    log(t, "TASK COMPLETE", "블레이드 %d/%d장 검증 완료" % (done, N_BLADE),
        "기록을 MRO 대시보드로 전송")
    emit(1.4, (moby_x, moby_y), q_cur, colors, len(LOG)-1)

print("  running Physical AI task loop ...")
run_task()
DUR = len(TRACK)/FPS
print("  task done - %d frames (%.1f s), %d log events" % (len(TRACK), DUR, len(LOG)))

# ─────────────────────────────────────────────────────────────
# 재생 (실행 결과를 그대로 렌더)
# ─────────────────────────────────────────────────────────────
def apply_frame(k):
    mx, my, q, colors, li = TRACK[min(k, len(TRACK)-1)]
    for b, loc in zip(MOBY_PARTS, MOBY_LOCAL):
        _, orn = p.getBasePositionAndOrientation(b)
        p.resetBasePositionAndOrientation(b, [loc[0]+mx, loc[1]+my, loc[2]], orn)
    p.resetBasePositionAndOrientation(robot, [mx, my, MOBY_H + 0.024], [0,0,0,1])
    for i, j in enumerate(MOV):
        p.resetJointState(robot, j, q[i])
    st = p.getLinkState(robot, EE, computeForwardKinematics=True)
    pos, orn = st[4], st[5]
    R = p.getMatrixFromQuaternion(orn); fwd = [R[0], R[3], R[6]]
    p.resetBasePositionAndOrientation(cam_body, [pos[i]+fwd[i]*0.030 for i in range(3)], orn)
    lo = p.multiplyTransforms([0,0,0], orn, [0,0,0], p.getQuaternionFromEuler([0, math.pi/2, 0]))[1]
    p.resetBasePositionAndOrientation(lens_body, [pos[i]+fwd[i]*0.072 for i in range(3)], lo)
    for i in range(N_BLADE):
        p.changeVisualShape(BLADES[i], -1, rgbaColor=colors[i])
    return li

SHOT_FRAMES = set()
for k, (_, _, _, _, li) in enumerate(TRACK):
    if LOG[li][1] in ("CAPTURING", "RECAPTURE"):
        SHOT_FRAMES.add(k)

_CAM_X = []                                   # Moby를 부드럽게 따라가는 카메라 (로봇을 크게 보이게)
for _t in TRACK:
    _CAM_X.append(_t[0] if not _CAM_X else _CAM_X[-1] + (_t[0]-_CAM_X[-1])*0.06)

def view_at(k):
    r = k/max(len(TRACK)-1, 1)
    yaw = math.radians(-63 + 6*r)
    pitch = math.radians(-34)
    dist = 2.8
    tgt = [_CAM_X[min(k, len(_CAM_X)-1)], BLADE_Y*0.62, 0.30]
    eye = [tgt[0]-dist*math.cos(pitch)*math.cos(yaw),
           tgt[1]-dist*math.cos(pitch)*math.sin(yaw),
           tgt[2]-dist*math.sin(pitch)]
    return p.computeViewMatrix(eye, tgt, [0,0,1])

PROJ = p.computeProjectionMatrixFOV(46, W/H, 0.05, 12.0)

# ─────────────────────────────────────────────────────────────
# 오버레이 (5x7 비트맵 폰트 - 외부 폰트 불필요)
# ─────────────────────────────────────────────────────────────
FONT = {
 'A':["01110","10001","10001","11111","10001","10001","10001"],
 'B':["11110","10001","11110","10001","10001","10001","11110"],
 'C':["01111","10000","10000","10000","10000","10000","01111"],
 'D':["11110","10001","10001","10001","10001","10001","11110"],
 'E':["11111","10000","11110","10000","10000","10000","11111"],
 'F':["11111","10000","11110","10000","10000","10000","10000"],
 'G':["01111","10000","10000","10111","10001","10001","01111"],
 'H':["10001","10001","11111","10001","10001","10001","10001"],
 'I':["11111","00100","00100","00100","00100","00100","11111"],
 'J':["00111","00010","00010","00010","00010","10010","01100"],
 'K':["10001","10010","11100","10100","10010","10001","10001"],
 'L':["10000","10000","10000","10000","10000","10000","11111"],
 'M':["10001","11011","10101","10101","10001","10001","10001"],
 'N':["10001","11001","10101","10011","10001","10001","10001"],
 'O':["01110","10001","10001","10001","10001","10001","01110"],
 'P':["11110","10001","10001","11110","10000","10000","10000"],
 'Q':["01110","10001","10001","10001","10101","10010","01101"],
 'R':["11110","10001","10001","11110","10100","10010","10001"],
 'S':["01111","10000","10000","01110","00001","00001","11110"],
 'T':["11111","00100","00100","00100","00100","00100","00100"],
 'U':["10001","10001","10001","10001","10001","10001","01110"],
 'V':["10001","10001","10001","10001","10001","01010","00100"],
 'W':["10001","10001","10001","10101","10101","11011","10001"],
 'X':["10001","10001","01010","00100","01010","10001","10001"],
 'Y':["10001","10001","01010","00100","00100","00100","00100"],
 'Z':["11111","00001","00010","00100","01000","10000","11111"],
 '0':["01110","10001","10011","10101","11001","10001","01110"],
 '1':["00100","01100","00100","00100","00100","00100","01110"],
 '2':["01110","10001","00001","00110","01000","10000","11111"],
 '3':["11110","00001","00001","01110","00001","00001","11110"],
 '4':["00010","00110","01010","10010","11111","00010","00010"],
 '5':["11111","10000","11110","00001","00001","10001","01110"],
 '6':["01110","10000","11110","10001","10001","10001","01110"],
 '7':["11111","00001","00010","00100","01000","01000","01000"],
 '8':["01110","10001","10001","01110","10001","10001","01110"],
 '9':["01110","10001","10001","01111","00001","00001","01110"],
 ' ':["00000"]*7, '.':["00000","00000","00000","00000","00000","01100","01100"],
 ',':["00000","00000","00000","00000","01100","01100","01000"],
 '-':["00000","00000","00000","11111","00000","00000","00000"],
 '+':["00000","00100","00100","11111","00100","00100","00000"],
 '=':["00000","00000","11111","00000","11111","00000","00000"],
 ':':["00000","01100","01100","00000","01100","01100","00000"],
 '%':["11001","11010","00010","00100","01000","01011","10011"],
 '/':["00001","00010","00010","00100","01000","01000","10000"],
 '(':["00010","00100","01000","01000","01000","00100","00010"],
 ')':["01000","00100","00010","00010","00010","00100","01000"],
 '#':["01010","01010","11111","01010","11111","01010","01010"],
 '>':["01000","00100","00010","00001","00010","00100","01000"],
 '_':["00000","00000","00000","00000","00000","00000","11111"],
}
def _bitmap_text(img, x, y, text, color, scale=2):
    """폰트를 못 찾을 때 쓰는 ASCII 대체 경로"""
    hgt, wid, _ = img.shape
    cx = x
    for ch in text.upper():
        g = FONT.get(ch)
        if g is None:
            cx += 6*scale; continue
        for ry, row in enumerate(g):
            for rx, bit in enumerate(row):
                if bit == '1':
                    x0, y0 = cx + rx*scale, y + ry*scale
                    if 0 <= x0 < wid-scale and 0 <= y0 < hgt-scale:
                        img[y0:y0+scale, x0:x0+scale] = color
        cx += (len(g[0]) + 1)*scale
    return cx

# 한글 렌더링 (Pillow + 맑은 고딕). 없으면 위 비트맵 폰트로 자동 대체.
try:
    from PIL import Image, ImageDraw, ImageFont
    _FONT_PATH = None
    for _f in ("C:/Windows/Fonts/malgun.ttf", "C:/Windows/Fonts/gulim.ttc"):
        if os.path.exists(_f):
            _FONT_PATH = _f; break
    _FONT_BOLD = ("C:/Windows/Fonts/malgunbd.ttf"
                  if os.path.exists("C:/Windows/Fonts/malgunbd.ttf") else _FONT_PATH)
    _fc = {}
    def _font(px, bold=False):
        k = (px, bold)
        if k not in _fc:
            _fc[k] = ImageFont.truetype(_FONT_BOLD if bold else _FONT_PATH, px)
        return _fc[k]
    HAS_TTF = _FONT_PATH is not None
except Exception:
    HAS_TTF = False

def text_w(text, px, bold=False):
    if not HAS_TTF:
        return len(text)*6*max(1, px//7)
    return int(_font(px, bold).getlength(text))

def draw_text(img, x, y, text, color, px=18, bold=False):
    """img(numpy RGB)에 텍스트를 그린다. px = 글자 높이(픽셀)."""
    if not HAS_TTF:
        return _bitmap_text(img, x, y, text, color, max(1, px//7))
    im = Image.fromarray(img)
    ImageDraw.Draw(im).text((x, y), text, font=_font(px, bold), fill=tuple(color))
    img[:, :, :] = np.asarray(im)
    return x + text_w(text, px, bold)

BSTATE_COL = {"WAITING":(150,160,175), "TARGETED":(120,190,255), "INSPECTING":(120,220,255),
              "QUALITY_CHECK":(230,235,245), "RECAPTURE_REQUIRED":(255,170,90),
              "VERIFIED":(120,240,170), "HANDOFF_REQUIRED":(255,130,120)}
RSTATE_COL = {"IDLE":(160,170,188), "SCANNING":(120,220,255), "PLANNING":(160,200,255),
              "MOVING":(150,220,180), "POSITIONING":(200,210,255), "CAPTURING":(255,235,140),
              "REPLANNING":(255,170,90), "COMPLETE":(120,240,170)}
STATE_COLOR = {
    "TASK_RECEIVED":(120,190,255), "PERCEIVING":(120,220,255), "PLANNING":(160,200,255),
    "NAVIGATING":(150,220,180), "REPLANNING(path)":(255,170,90), "POSITIONING":(200,210,255),
    "CAPTURING":(255,235,140), "RECAPTURE":(255,200,120), "QUALITY_CHECK":(255,255,255),
    "REPLANNING":(255,170,90), "VERIFIED":(120,240,170), "HUMAN_HANDOFF":(255,130,120),
    "DECISION":(255,120,110),
    "NEXT_TARGET":(180,190,205), "TASK COMPLETE":(120,240,170),
}
# 좌측 로그에 쓰는 상태 한글 표기
STATE_KO = {
    "TASK_RECEIVED":"작업지시 접수",   "PERCEIVING":"인지 · 블레이드 탐색",
    "PLANNING":"촬영 자세 계산",       "NAVIGATING":"이동",
    "REPLANNING(path)":"경로 재계획 · 장애물 회피",
    "POSITIONING":"팔 정렬",           "CAPTURING":"촬영",
    "RECAPTURE":"재촬영",              "QUALITY_CHECK":"촬영 품질 판정",
    "REPLANNING":"촬영 자세 재계획",   "VERIFIED":"검증 완료",
    "DECISION":"판단 · 실패 원인 분석",
    "HUMAN_HANDOFF":"정비사에게 인계", "NEXT_TARGET":"다음 대상으로",
    "TASK COMPLETE":"작업 완료",
}

# 상태별 중앙 배너 (제목, 설명, 색). 없는 상태는 배너를 띄우지 않는다.
BANNER = {
    "PERCEIVING":      ("① 본다",
                        "좌표를 미리 넣은 것이 아니라 카메라로 블레이드를 찾아낸다", (120,220,255)),
    "REPLANNING(path)":("주행선에 작업자 — 경로를 다시 짠다",
                        "정비사가 있는 자리를 피해 A*로 우회로를 찾는다 (위치는 셀 지도에 등록됨)", (255,170,90)),
    "QUALITY_CHECK":   ("③ 자기가 찍은 사진을 스스로 검사한다",
                        "부위별로 — 팁 · 루트 · 외곽 엣지가 각각 화각에 담겼는가", (255,255,255)),
    "DECISION":        ("④ 왜 실패했는지 판단한다",
                        "어느 부위가 모자란지가 다음 촬영 자세를 결정한다", (255,120,110)),
    "PLANNING":        ("② 인지 결과로 촬영 자세를 만든다",
                        "사전 좌표가 아니라 방금 검출한 위치·각도에서 IK를 푼다", (160,200,255)),
    "REPLANNING":      ("⑤ 실패 원인에 맞춰 새 촬영 자세를 계산",
                        "부족했던 부위 쪽으로 카메라를 옮기고 광축을 기울인다", (255,150,70)),
    "RECAPTURE":       ("재촬영",
                        "사람이 시킨 것이 아니라, 직전 촬영 결과를 보고 로봇이 결정한 2차 시도", (255,190,110)),
    "VERIFIED":        ("검증 완료",
                        "검사 증거 사진이 기준을 통과해 Work Card에 기록된다", (120,240,170)),
    "HUMAN_HANDOFF":   ("정비사에게 넘긴다",
                        "2회 재시도에도 기준 미달 — 로봇은 멈추고 사람을 부른다 (HITL)", (255,130,120)),
    "TASK COMPLETE":   ("작업 완료",
                        "최종 결함 판정은 정비사가 한다. 로봇은 촬영과 기록까지.", (120,240,170)),
}

def overlay(img, li):
    u = H/720.0                                   # 720p 기준 배율
    px = lambda v: int(v*u)
    pad = px(18)
    # 상단 배너
    img[0:px(58), :] = (img[0:px(58), :]*0.30).astype(img.dtype)
    draw_text(img, pad, px(6),  "Physical AI × Digital Twin · HPC 블레이드 검사 작업 셀",
              (235,240,250), px(19), bold=True)
    draw_text(img, pad, px(33), "인지 → 판단 → 행동 → 결과 확인 → 재계획   ·   CELL " + CELL["id"],
              (145,172,205), px(13))
    # 좌측 로그 (최근 4건) - 반투명 패널 위에
    y = px(72)
    start = max(0, li-3)
    img[px(66):px(66)+px(148), 0:px(430)] = (
        img[px(66):px(66)+px(148), 0:px(430)]*0.35).astype(img.dtype)
    for k in range(start, li+1):
        _, state, l1, l2, l3 = LOG[k]
        cur = (k == li)
        col = STATE_COLOR.get(state, (220,225,235))
        if not cur:
            col = tuple(int(c*0.5) for c in col)
        draw_text(img, pad, y, STATE_KO.get(state, state), col,
                  px(15) if cur else px(12), bold=cur)
        y += px(19) if cur else px(15)
        for ln, bright in ((l1, (222,228,240)), (l2, (182,193,212)), (l3, (182,193,212))):
            if ln and cur:
                draw_text(img, pad + px(10), y, ln[:52], bright, px(11))
                y += px(14)
        y += px(4)

    # ── 우측 Digital Twin 상태 패널 ──
    #    값은 전부 DT[li] (실행 중 쌓인 실제 상태). 연출용 텍스트를 따로 만들지 않는다.
    d = DT[li] if li < len(DT) else None
    if d:
        PW = px(268); x0 = img.shape[1] - PW
        py_ = px(66); ph = px(360)
        img[py_:py_+ph, x0:] = (img[py_:py_+ph, x0:]*0.30).astype(img.dtype)
        img[py_:py_+px(2), x0:] = (90, 150, 200)
        tx = x0 + px(14); y2 = py_ + px(9)
        draw_text(img, tx, y2, "DIGITAL TWIN", (150,190,235), px(12), bold=True); y2 += px(17)
        draw_text(img, tx, y2, "CELL  " + CELL["id"] + "   GRID 1.0 m", (120,140,165), px(11)); y2 += px(20)

        def row(lbl, val, col=(228,234,244), big=False):
            nonlocal y2
            draw_text(img, tx, y2, lbl, (118,136,160), px(10.5)); y2 += px(13)
            draw_text(img, tx, y2, val, col, px(14) if big else px(12.5), bold=big); y2 += px(18)

        bi = d["bi"]
        if bi is not None:
            a = ASSETS[bi]
            row("ASSET", a["asset_id"], (225,232,244), True)
            draw_text(img, tx, y2-px(4), a["engine"] + " · " + a["stage"], (140,158,182), px(11)); y2 += px(12)
            draw_text(img, tx, y2-px(2), a["slot"], (140,158,182), px(11)); y2 += px(18)
            bs = d["blade"] or "WAITING"
            row("ASSET STATE", "● " + bs, BSTATE_COL.get(bs, (200,210,225)), True)
        else:
            row("ASSET", "—")
        row("ROBOT", "MOBY-01 + Indy7")
        row("ROBOT STATE", "● " + d["robot"], RSTATE_COL.get(d["robot"], (200,210,225)), True)
        row("INSPECTION", d["insp"])
        if d["cov"] is not None:
            ok = (d["qres"] == "PASS")
            row("사진에 담김", "%d%%" % round(d["cov"]*100),
                (120,240,170) if ok else (255,150,120), True)
            if not ok and d["reason"]:
                draw_text(img, tx, y2-px(6), "⚠ " + d["reason"][:20], (255,170,120), px(10.5))
                y2 += px(12)
        # ── 미니맵: 계획 경로(점선) vs 실제 경로(실선) ──
        if d.get("act"):
            mw, mh = PW - px(28), px(54)
            mx0, my0 = tx, y2 + px(4)
            img[my0:my0+mh, mx0:mx0+mw] = (img[my0:my0+mh, mx0:mx0+mw]*0.45).astype(img.dtype)
            def m2p(wx, wy):
                return (int(mx0 + (wx + CELL_X)/(2*CELL_X)*mw),
                        int(my0 + mh/2 - wy/0.9*(mh/2 - 3)))
            for ox, oy in OBST:                      # 장애물
                ox_, oy_ = m2p(ox, oy)
                img[max(my0,oy_-2):oy_+3, max(mx0,ox_-2):ox_+3] = (210, 90, 70)
            def line(a_, b_, col, dash=0):
                (x1,y1),(x2,y2_) = m2p(*a_), m2p(*b_)
                n = max(abs(x2-x1), abs(y2_-y1), 1)
                for t_ in range(n+1):
                    if dash and (t_//dash) % 2: continue
                    xx = int(x1+(x2-x1)*t_/n); yy = int(y1+(y2_-y1)*t_/n)
                    if my0 <= yy < my0+mh and mx0 <= xx < mx0+mw:
                        img[yy:yy+2, xx:xx+2] = col
            pl = d.get("plan")
            if pl: line(pl[0], pl[1], (150, 165, 190), dash=3)     # 계획: 점선
            ac = d["act"]
            for i2 in range(len(ac)-1): line(ac[i2], ac[i2+1], (120, 220, 255))
            draw_text(img, mx0, my0+mh+px(2), "계획 ┄  실제 ━", (140,158,182), px(10))
            y2 = my0 + mh + px(16)

        # 자산 현황 한 줄 (전체 블레이드 상태)
        y2 += px(4)
        draw_text(img, tx, y2, "ASSETS", (118,136,160), px(10.5)); y2 += px(14)
        for k, a in enumerate(ASSETS):
            st = d["assets"][k]
            c = BSTATE_COL.get(st, (150,160,175))
            draw_text(img, tx + px(k*62), y2, "#%d" % (k+1), (150,162,180), px(10.5))
            draw_text(img, tx + px(k*62) + px(16), y2, "●", c, px(11))

    # 중앙 배너 - "지금 무슨 판단을 했는지"를 한 줄로.
    # 재검사 구간은 보는 사람이 가장 헷갈리는 지점이라 크게 띄운다.
    b = BANNER.get(LOG[li][1])
    if b:
        head, sub, col = b
        hp, sp = px(22), px(13)
        bh = px(70)
        y0 = img.shape[0] - bh
        img[y0:y0+bh, :] = (img[y0:y0+bh, :]*0.20).astype(img.dtype)
        img[y0:y0+px(3), :] = col
        cx = img.shape[1]//2
        draw_text(img, cx - text_w(head, hp, True)//2, y0 + px(13), head, col, hp, bold=True)
        draw_text(img, cx - text_w(sub, sp)//2,        y0 + px(44), sub, (215,222,235), sp)
    return img

# ─────────────────────────────────────────────────────────────
# 실행
# ─────────────────────────────────────────────────────────────
if not RENDER:
    p.resetDebugVisualizerCamera(4.0, -92, -24, [0, BLADE_Y*0.45, 0.28])
    print("\n  GUI preview - %.1f s loop (close window to exit)\n" % DUR)
    t0 = time.time()
    while p.isConnected():
        k = int(((time.time()-t0) % DUR) * FPS)
        li = apply_frame(k)          # 키네마틱 재생 - stepSimulation 금지(접촉력이 팔을 떨게 한다)
        time.sleep(1/FPS)
else:
    out = os.path.join(HERE, "frames")
    os.makedirs(out, exist_ok=True)
    for f in os.listdir(out):
        if f.endswith(".png"): os.remove(os.path.join(out, f))
    total = len(TRACK)
    print("  rendering %d frames (%dx%d)" % (total, W, H))
    for k in range(total):
        li = apply_frame(k)
        _, _, rgb, _, _ = p.getCameraImage(W, H, view_at(k), PROJ,
                                           renderer=p.ER_BULLET_HARDWARE_OPENGL,
                                           lightDirection=[-0.5, -0.8, 1.2])
        img = np.reshape(np.array(rgb, dtype=np.uint8), (H, W, 4))[:, :, :3].copy()
        if k in SHOT_FRAMES:
            img = np.clip(img.astype(np.int16)*1.18, 0, 255).astype(np.uint8)
        img = overlay(img, li)
        _save_png(img, os.path.join(out, "frame_%04d.png" % k))
        if k % 60 == 0: print("    %d/%d" % (k, total))
    print("\n  done -> %s\n  next:  py -3.11 make_mp4.py\n" % out)
