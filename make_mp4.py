"""
frames/*.png -> sim.mp4 인코딩
  (ffmpeg 별도 설치 불필요 - imageio-ffmpeg 내장 바이너리 사용)

  실행:  py -3.11 make_mp4.py
  결과:  sim.mp4  (데모 assets/sim.mp4 로 복사해 넣으면 연동 끝)
"""
import os, glob, subprocess, sys
import imageio_ffmpeg

HERE = os.path.dirname(os.path.abspath(__file__))
FRAMES = os.path.join(HERE, "frames")
OUT = os.path.join(HERE, "sim.mp4")
FPS = 30

pngs = sorted(glob.glob(os.path.join(FRAMES, "frame_*.png")))
if not pngs:
    print("frames/ 에 PNG가 없습니다. 먼저:  py -3.11 sim_blade.py --render")
    sys.exit(1)

ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
cmd = [ffmpeg, "-y",
       "-framerate", str(FPS),
       "-i", os.path.join(FRAMES, "frame_%04d.png"),
       "-c:v", "libx264",
       "-profile:v", "high",      # 화질 우선 (baseline 은 B프레임이 없어 같은 용량에서 흐리다)
       "-level", "4.1",
       "-preset", "slow",
       "-pix_fmt", "yuv420p",     # 브라우저 호환 필수
       "-crf", "18",              # 낮을수록 고화질 (23 -> 18)
       "-movflags", "+faststart", # 웹 스트리밍 시작 빠르게
       OUT]

print(f"  프레임 {len(pngs)}개 -> mp4 인코딩 중...")
r = subprocess.run(cmd, capture_output=True, text=True)
if r.returncode != 0:
    print("인코딩 실패:\n", r.stderr[-1500:])
    sys.exit(1)

mb = os.path.getsize(OUT) / 1024 / 1024
print(f"  완료: {OUT}")
print(f"  용량: {mb:.1f} MB  (권장 20MB 이하)")
print(f"  길이: {len(pngs)/FPS:.1f}초 @ {FPS}fps")
print()
print("  데모에 연동하려면 이 파일을 서비스 폴더로 복사:")
print(r'    copy sim.mp4 "C:\Users\User\Desktop\피지컬ai 자료\서비스\assets\sim.mp4"')
