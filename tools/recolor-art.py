# recolor-art.py <in.png> <out.png> <target hue deg> [sat x] [val x]   (needs numpy and ImageMagick)
# Shift only the green pixels of a piece of art to a new hue: chrome, white, sky
# and bubbles keep theirs. Sunset: 30 1.05 1.06. Midnight: 215 0.95 1.08.
import subprocess, sys, numpy as np
src, dst, target = sys.argv[1], sys.argv[2], float(sys.argv[3])
sat_k = float(sys.argv[4]) if len(sys.argv) > 4 else 1.0
val_k = float(sys.argv[5]) if len(sys.argv) > 5 else 1.0
w, h = map(int, subprocess.check_output(['identify', '-format', '%w %h', src]).split())
px = np.frombuffer(subprocess.check_output(['convert', src, '-depth', '8', 'rgba:-']), np.uint8).reshape(h, w, 4).astype(np.float32) / 255
rgb, a = px[..., :3], px[..., 3:]
mx, mn = rgb.max(-1), rgb.min(-1); d = mx - mn
r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
hue = np.zeros_like(mx); nz = d > 1e-6
hue = np.where(nz & (mx == r), ((g - b) / np.where(nz, d, 1)) % 6, hue)
hue = np.where(nz & (mx == g), (b - r) / np.where(nz, d, 1) + 2, hue)
hue = np.where(nz & (mx == b), (r - g) / np.where(nz, d, 1) + 4, hue)
hue = hue * 60
sat = np.where(mx > 0, d / np.where(mx > 0, mx, 1), 0); val = mx
def ramp(x, a0, a1): return np.clip((x - a0) / (a1 - a0), 0, 1)
green = ramp(hue, 48, 62) * (1 - ramp(hue, 160, 175)) * ramp(sat, 0.10, 0.25)
sel = (green > 0.5) & (a[..., 0] > 0.5)
centre = float(np.median(hue[sel])) if sel.any() else 85.0
nh = (hue + (target - centre)) % 360
ns = np.clip(sat * sat_k, 0, 1); nv = np.clip(val * val_k, 0, 1)
c = nv * ns; hp = nh / 60; x = c * (1 - np.abs(hp % 2 - 1)); m = nv - c
z = np.zeros_like(c); i = np.floor(hp).astype(int) % 6
out = np.stack([np.choose(i, [c, x, z, z, x, c]), np.choose(i, [x, c, c, x, z, z]), np.choose(i, [z, z, x, c, c, x])], -1) + m[..., None]
mix = rgb * (1 - green[..., None]) + out * green[..., None]
res = (np.concatenate([mix, a], -1) * 255 + 0.5).clip(0, 255).astype(np.uint8)
subprocess.run(['convert', '-size', f'{w}x{h}', '-depth', '8', 'rgba:-', dst], input=res.tobytes(), check=True)
print(f'{dst}: green centre {centre:.0f}° → {target:.0f}°, {sel.mean()*100:.0f}% of pixels')
