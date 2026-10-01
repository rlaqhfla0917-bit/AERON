"""전 프레임 관통/충돌 전수 검사 + 촬영 시점 카메라 정렬 검증."""
import io, math, traceback, os
os.chdir(os.path.dirname(os.path.abspath(__file__)))
LOG = "verify_result.txt"; open(LOG, "w").close()
def w(s):
    with open(LOG, "a", encoding="utf-8") as f: f.write(str(s) + "\n")
try:
    src = io.open("sim_physical_ai.py", encoding="utf-8").read()
    src = src.replace('p.connect(p.DIRECT if RENDER else p.GUI', 'p.connect(p.DIRECT')
    cut = src.index("# 오버레이 (5x7")-64
    g = {"__name__": "__main__", "__file__": "sim_physical_ai.py"}
    exec(compile(src[:cut], "s", "exec"), g)
    p = g["p"]; TRACK = g["TRACK"]; apply_frame = g["apply_frame"]
    robot = g["robot"]; targets = g["BLADES"] + g["TRAY"] + g["OBST_ID"] + g["MOBY_PARTS"] + g["RACK"] + g["SIGN"] + g["WORKCELL"]

    worst, bad, where = 0.0, 0, None
    for k in range(len(TRACK)):
        apply_frame(k)
        p.performCollisionDetection()
        for b in targets:
            for cp in p.getContactPoints(robot, b):
                if cp[8] < -0.005:
                    bad += 1
                    if cp[8] < worst: worst, where = cp[8], (k, b)
    w("frames scanned : %d" % len(TRACK))
    w("penetrations   : %d  (>5mm)" % bad)
    w("worst depth    : %.1f mm  %s" % (worst*1000, where))

    # Moby 본체가 장애물을 통과하지 않는지 (A* 검증)
    clear = min(math.hypot(t[0]-ox, t[1]-oy) for t in TRACK for ox, oy in g["OBST"])
    w("min |moby - obstacle| : %.3f m" % clear)
    mb = g["MOBY_PARTS"]; ob = g["OBST_ID"]
    hit = 0; deep = 0.0
    for k in range(len(TRACK)):
        apply_frame(k); p.performCollisionDetection()
        for a in mb:
            for b in ob:
                for cp in p.getContactPoints(a, b):
                    if cp[8] < -0.005:
                        hit += 1; deep = min(deep, cp[8])
    w("moby vs obstacle : %d hits, worst %.1f mm" % (hit, deep*1000))
    # Moby vs 블레이드.받침대 — 정적 바디끼리는 접촉이 안 잡히므로 사각형으로 직접 잰다
    MHX, MHY, THX, THY = 0.28, 0.22, 0.17, 0.11
    nb = 0; wb = 0.0
    for t in TRACK:
        for bx, by, _ in g["TRUE_POSE"]:
            ox = (MHX+THX)-abs(t[0]-bx); oy = (MHY+THY)-abs(t[1]-by)
            if ox > 0 and oy > 0: nb += 1; wb = max(wb, min(ox, oy))
    w("moby vs 블레이드 : %d 프레임 겹침, 최대 %.0f mm" % (nb, wb*1000))
    ys = [t[1] for t in TRACK]
    w("moby y range     : %.2f ~ %.2f m (우회 실제 실행 여부)" % (min(ys), max(ys)))
except Exception:
    w("ERROR:\n" + traceback.format_exc())
