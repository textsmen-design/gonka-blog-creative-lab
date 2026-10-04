#!/usr/bin/env python3
"""Генерация public/scene/day.jpg и night.jpg из design-references (воспроизводимо).
Запуск из корня проекта: python3 tools/scene/build-night.py
Исходники не изменяются. Ночное окно берётся из референса desktop-day-night (нижняя полоса),
переключатель и стрелка из него убираются клонированием соседнего неба."""
import numpy as np, random, math, os
from PIL import Image, ImageDraw, ImageFilter

DAY_SRC = 'design-references/desktop-window-reference.png'
DN_SRC = 'design-references/desktop-day-night.png.png'
OUT = 'public/scene/'

day = Image.open(DAY_SRC).convert('RGB')

# --- фото Белграда (srbia.png в корне проекта) вставляется в правую фотографию на столе, в перспективе ---
BEL_SRC = 'srbia.png'
PHOTO_QUAD = [(1063, 675), (1279, 706), (1242, 806), (1003, 763)]      # внутренняя картинка фото: TL, TR, BR, BL (px сцены 1672×940)

def _persp_coeffs(dst, src):
    A, B = [], []
    for (x, y), (u, v) in zip(dst, src):
        A.append([x, y, 1, 0, 0, 0, -x * u, -y * u]); B.append(u)
        A.append([0, 0, 0, x, y, 1, -x * v, -y * v]); B.append(v)
    return np.linalg.solve(np.array(A, np.float64), np.array(B, np.float64))

def composite_photo(base):
    if not os.path.exists(BEL_SRC):
        return base
    src = Image.open(BEL_SRC).convert('RGB')
    w, h = src.size
    src = src.crop((0, 0, int(h * 1.5), h))                             # 3:2: монумент Победник, храм Св. Саввы, река
    xs = [p[0] for p in PHOTO_QUAD]; ys = [p[1] for p in PHOTO_QUAD]
    x0, y0, x1, y1 = min(xs) - 4, min(ys) - 4, max(xs) + 4, max(ys) + 4
    quad = [(x - x0, y - y0) for x, y in PHOTO_QUAD]
    src = src.resize((620, 413), Image.LANCZOS)                      # предварительное сжатие против муара (было ×6 за один шаг)
    sw, sh = src.size
    coeffs = _persp_coeffs(quad, [(0, 0), (sw, 0), (sw, sh), (0, sh)])
    region = src.transform((x1 - x0, y1 - y0), Image.PERSPECTIVE, tuple(coeffs), Image.BICUBIC)
    # «печатный» вид: чуть мягче контраст и насыщенность, тёплый свет окна, зерно
    arr = np.array(region).astype(np.float32)
    lum = arr.mean(axis=2, keepdims=True)
    arr = lum + (arr - lum) * 0.92
    arr = (arr - 128) * 0.94 + 128
    arr = 255.0 * (np.clip(arr, 0, 255) / 255.0) ** 0.88             # чуть светлее: снимок закатный, на столе при свете окна
    arr *= np.array([1.04, 1.0, 0.93], np.float32)
    gx = np.linspace(0.92, 1.06, arr.shape[1], dtype=np.float32)[None, :, None]   # свет слева→справа
    arr *= gx
    arr += np.random.default_rng(5).normal(0, 1.1, arr.shape[:2] + (1,))
    region = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
    mask = Image.new('L', region.size, 0)
    ImageDraw.Draw(mask).polygon(quad, fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(0.9))
    base = base.copy()
    box = (x0, y0, x1, y1)
    base.paste(Image.composite(region, base.crop(box), mask), box)
    return base

day = composite_photo(day)
W, H = day.size                      # 1672x940
dn = Image.open(DN_SRC).convert('RGB')

# --- 1. ночное окно из нижней полосы (y>=470), окно x 415..1475, y 0..262 ---
strip = dn.crop((0, 470, 1672, 941))
win = strip.crop((415, 0, 1475, 262)).copy()          # 1060x262
wx = np.array(win).astype(np.float32)
# убрать переключатель (x 295..545, y 0..52 в координатах окна) и стрелку (x 380..465, y 54..82)
def clone(arr, dst, src, feather=10):
    """Закрашивает прямоугольник dst небом: средний цвет строк из чистой полосы src (x0,x1) + шум и звёзды."""
    x0, y0, x1, y1 = dst; sx0, sx1 = src
    h, w = y1 - y0, x1 - x0
    rows = arr[y0:y1, sx0:sx1, :].mean(axis=1)            # h x 3
    rng = np.random.default_rng(3)
    patch = np.repeat(rows[:, None, :], w, axis=1) + rng.normal(0, 1.6, (h, w, 1))
    for _ in range(max(2, w * h // 900)):
        sy, sx = rng.integers(0, h), rng.integers(0, w)
        patch[sy, sx, :] = rng.integers(130, 235)
    m = np.ones((h, w), np.float32)
    for i in range(feather):
        a = (i + 1) / (feather + 1)
        if y0 > 0: m[i, :] = np.minimum(m[i, :], a)
        m[h - 1 - i, :] = np.minimum(m[h - 1 - i, :], a)
        m[:, i] = np.minimum(m[:, i], a); m[:, w - 1 - i] = np.minimum(m[:, w - 1 - i], a)
    arr[y0:y1, x0:x1, :] = arr[y0:y1, x0:x1, :] * (1 - m[..., None]) + patch * m[..., None]
clone(wx, (280, 0, 560, 62), (110, 280))
clone(wx, (370, 50, 480, 92), (110, 280))
win = Image.fromarray(np.clip(wx, 0, 255).astype(np.uint8))
# нижние строки окна (подоконник) заменяем растяжкой тёмных крыш — иначе под наклонным подоконником справа остаётся пустота
body = win.crop((0, 0, 1060, 250))
ext = win.crop((0, 232, 1060, 250)).resize((1060, 90), Image.BILINEAR).filter(ImageFilter.GaussianBlur(6))
ea = np.array(ext).astype(np.float32) * np.linspace(1.0, 0.12, 90)[:, None, None]   # уходит в тёмный склон
ext = Image.fromarray(ea.astype(np.uint8))
win2 = Image.new('RGB', (1060, 250 + 90)); win2.paste(body, (0, 0)); win2.paste(ext, (0, 250))
win = win2

# --- 2. полное небо окна: градиент + звёзды, внизу — ландшафт из референса ---
WW, WH = 1053, 640                                     # область окна в дневном кадре: x 425.., y 0..640
sky = np.zeros((WH, WW, 3), np.float32)
top_row = np.array(win)[2:10, :, :].mean(axis=(0, 1))   # цвет верха ночного фрагмента
for y in range(WH):
    t = y / WH
    top = np.array([6, 9, 30], np.float32); bot = top_row
    sky[y, :, :] = top * (1 - min(1, t * 1.6)) + bot * min(1, t * 1.6)
sky_img = Image.fromarray(sky.astype(np.uint8))
random.seed(7)
d = ImageDraw.Draw(sky_img)
for _ in range(260):
    x = random.randint(0, WW - 1); y = random.randint(0, 300)
    b = random.randint(120, 255); r = random.choice([0, 0, 0, 1])
    d.ellipse((x - r, y - r, x + r, y + r), fill=(b, b, min(255, b + 15)))
sky_img = sky_img.filter(ImageFilter.GaussianBlur(0.4))
bottom_y = 658                                         # низ ландшафта (по линии подоконника, середина)
crop_top = bottom_y - win.height
alpha = Image.new('L', win.size, 255)
ad = ImageDraw.Draw(alpha)
for i in range(56):                                    # плавный верх, чтобы стыка с небом не было
    ad.line([(0, i), (win.width, i)], fill=int(255 * i / 56))
sky_img.paste(win.resize((WW, win.height)), (0, crop_top), alpha.resize((WW, win.height)))
night_window = sky_img                                  # WWxWH

# --- 3. маска окна в дневном кадре ---
mask = Image.new('L', (W, H), 0)
md = ImageDraw.Draw(mask)
poly = [(427, 0), (1478, 0), (1478, 536), (1460, 527), (1387, 527), (1353, 537),
        (1353, 600), (1100, 580), (700, 536), (427, 482)]
md.polygon(poly, fill=255)
# листва (зелёные/жёлто-зелёные пиксели) остаётся из дневного кадра
a = np.array(day).astype(np.float32)
mx = a.max(axis=2); mn = a.min(axis=2); dlt = mx - mn + 1e-6
sat = dlt / (mx + 1e-6); val = mx / 255.0
rr, gg, bb = a[..., 0], a[..., 1], a[..., 2]
hue = np.where(mx == rr, ((gg - bb) / dlt) % 6, np.where(mx == gg, (bb - rr) / dlt + 2, (rr - gg) / dlt + 4)) * 60.0
# листва: жёлто-зелёные тона; светлое небо/облака (высокая яркость, оттенок < 62°) не считаем
foliage = ((hue >= 44) & (hue <= 150) & (sat > 0.45) & ((val < 0.62) | (hue > 62))).astype(np.float32)
fol = Image.fromarray((foliage * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.GaussianBlur(1.2))
zone = Image.new('L', (W, H), 0)
zd = ImageDraw.Draw(zone)
zd.rectangle((0, 150, 540, 560), fill=255)       # плющ слева
zd.rectangle((1200, 0, 1500, 270), fill=255)     # лоза справа сверху
zd.rectangle((1370, 0, 1500, 600), fill=255)     # растение справа
fol = Image.fromarray((np.array(fol).astype(np.float32) * (np.array(zone) / 255)).astype(np.uint8))
m = np.array(mask.filter(ImageFilter.GaussianBlur(1.0))).astype(np.float32) / 255
m = m * (1 - np.array(fol).astype(np.float32) / 255)

# --- 4. ночная градация стола и рамы ---
night = a.copy()
lum = (night * np.array([0.3, 0.59, 0.11])).sum(axis=2, keepdims=True)
night = lum + (night - lum) * 0.62                      # лёгкая десатурация
night = night * np.array([0.40, 0.45, 0.62])            # холодная приглушённая гамма
# тёплое пятно лампы (лампа на (225,345)), плюс мягкий отсвет на столе
yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
def glow(cx, cy, rx, ry, col, k):
    d2 = ((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2
    return (np.exp(-d2 * 1.6)[..., None]) * np.array(col, np.float32) * k
night += glow(225, 350, 330, 300, (255, 170, 80), 0.55)
night += glow(300, 640, 520, 260, (255, 150, 70), 0.28)
night += glow(225, 345, 70, 60, (255, 225, 160), 0.8)
night = np.clip(night, 0, 255)
# ночное окно в маске
nw = np.zeros_like(a)
nw[0:WH, 427:427 + WW - 2, :] = np.array(night_window)[:, 2:, :]
# лёгкая синева листвы в окне, чтобы не выбивалась
out = night * (1 - m[..., None]) + nw * m[..., None]
Image.fromarray(np.clip(out, 0, 255).astype(np.uint8)).save(OUT + 'night.jpg', quality=90, optimize=True)
day.save(OUT + 'day.jpg', quality=90, optimize=True)
mask.save('/dev/null', format='PNG') if False else None
print('ok', day.size)
