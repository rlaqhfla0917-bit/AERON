"""로직만 실행해 로그를 파일로 남긴다 (렌더 없이)."""
import io, sys, os, traceback
os.chdir(os.path.dirname(os.path.abspath(__file__)))
LOG = "verify_result.txt"
open(LOG, "w").close()
def w(s):
    with open(LOG, "a", encoding="utf-8") as f: f.write(str(s) + "\n")

try:
    src = io.open("sim_physical_ai.py", encoding="utf-8").read()
    src = src.replace('p.connect(p.DIRECT if RENDER else p.GUI', 'p.connect(p.DIRECT')
    cut = src.index("# ─────────────────────────────────────────────────────────────\n# 재생")
    g = {"__name__": "__main__", "__file__": "sim_physical_ai.py"}
    exec(compile(src[:cut], "sim_logic", "exec"), g)
    LOGS = g["LOG"]; TRACK = g["TRACK"]; FPS = g["FPS"]
    w("frames=%d  duration=%.1fs  events=%d" % (len(TRACK), len(TRACK)/FPS, len(LOGS)))
    w("-"*72)
    for e in LOGS:
        t, st, l1, l2, l3 = e
        w("[%05.1fs] %-18s %s" % (t, st, l1))
        for x in (l2, l3):
            if x: w("%s%s" % (" "*28, x))
except Exception:
    w("ERROR:\n" + traceback.format_exc())
