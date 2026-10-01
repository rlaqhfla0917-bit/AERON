"""렌더가 중간에 죽었을 때 남은 프레임만 이어서 렌더한다.
   frames/ 를 지우지 않는다. 이미 있는 번호는 건너뛴다.
   실행:  py -3.11 _resume_render.py
"""
import io, os, sys, glob
import numpy as np

os.chdir(os.path.dirname(os.path.abspath(__file__)))
src = io.open("sim_physical_ai.py", encoding="utf-8").read()
# 렌더 모드로 강제(해상도 1920x1080) + 창 없이
src = src.replace('RENDER = "--render" in ARGS', 'RENDER = True')
src = src.replace('p.connect(p.DIRECT if RENDER else p.GUI', 'p.connect(p.DIRECT')
cut = src.index("# 실행\n# ") - 64          # 실행 블록 직전까지만 (자체 렌더 루프 제외)
g = {"__name__": "__main__", "__file__": os.path.abspath("sim_physical_ai.py")}
exec(compile(src[:cut], "sim", "exec"), g)

p = g["p"]; TRACK = g["TRACK"]; W, H = g["W"], g["H"]
out = os.path.join(os.getcwd(), "frames")
have = {int(os.path.basename(f)[6:10]) for f in glob.glob(os.path.join(out, "frame_*.png"))}
todo = [k for k in range(len(TRACK)) if k not in have]
print("  전체 %d · 기존 %d · 남은 %d 프레임" % (len(TRACK), len(have), len(todo)))
if not todo:
    print("  이미 모두 렌더됨"); sys.exit(0)

for n, k in enumerate(todo, 1):
    li = g["apply_frame"](k)
    _, _, rgb, _, _ = p.getCameraImage(W, H, g["view_at"](k), g["PROJ"],
                                       renderer=p.ER_BULLET_HARDWARE_OPENGL,
                                       lightDirection=[-0.5, -0.8, 1.2])
    img = np.reshape(np.array(rgb, dtype=np.uint8), (H, W, 4))[:, :, :3].copy()
    if k in g["SHOT_FRAMES"]:
        img = np.clip(img.astype(np.int16) * 1.18, 0, 255).astype(np.uint8)
    img = g["overlay"](img, li)
    g["_save_png"](img, os.path.join(out, "frame_%04d.png" % k))
    if n % 20 == 0 or n == len(todo):
        print("    %d/%d" % (n, len(todo)), flush=True)
print("  이어서 렌더 완료 -> %s" % out)
