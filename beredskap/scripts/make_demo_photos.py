"""Draw the placeholder photos the demo seed attaches to deficiencies.

They are simple line drawings stamped DEMOBILD, so nobody mistakes them for
real photos of a real shelter. Run from the beredskap folder:

    python scripts/make_demo_photos.py
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent / "demo-photos"
W, H = 1200, 900
BG, FG, MUTED = (28, 31, 38), (226, 230, 236), (120, 126, 138)


def font(size):
    for name in ("arialbd.ttf", "arial.ttf", "DejaVuSans-Bold.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def base(title):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    for x in range(0, W, 60):  # faint grid, like a concrete wall
        d.line([(x, 0), (x, H)], fill=(34, 38, 46))
    for y in range(0, H, 60):
        d.line([(0, y), (W, y)], fill=(34, 38, 46))
    d.text((40, 30), title, font=font(40), fill=MUTED)
    return img, d


def stamp(img):
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    text = "DEMOBILD"
    f = font(150)
    w = d.textlength(text, font=f)
    d.text(((W - w) / 2, H / 2 - 90), text, font=f, fill=(255, 255, 255, 70))
    d.rectangle([20, H - 70, W - 20, H - 20], outline=(255, 255, 255, 120), width=3)
    d.text((40, H - 62), "Fiktiv bild för demonstration, inte ett riktigt skyddsrum", font=font(30), fill=(255, 255, 255, 200))
    return Image.alpha_composite(img.convert("RGBA"), layer).convert("RGB")


def door():
    img, d = base("Skyddsrumsdörr")
    d.rectangle([380, 140, 820, 800], outline=FG, width=10)
    d.rectangle([420, 180, 780, 760], outline=FG, width=4)
    for y in (260, 680):  # hinges, one rusty-looking
        d.rectangle([360, y, 400, y + 70], fill=FG)
    d.ellipse([350, 690, 410, 760], outline=(214, 120, 60), width=6)
    d.line([(700, 470), (760, 470)], fill=FG, width=12)  # bolt handle
    d.line([(560, 300), (640, 380)], fill=MUTED, width=4)
    return img


def ventilation():
    img, d = base("Ventilationsaggregat")
    d.rectangle([300, 260, 900, 640], outline=FG, width=10)
    d.ellipse([420, 330, 640, 550], outline=FG, width=8)
    for i in range(4):
        d.line([(530, 440), (530 + [90, 0, -90, 0][i], 440 + [0, 90, 0, -90][i])], fill=FG, width=6)
    d.rectangle([700, 330, 840, 560], outline=MUTED, width=6)  # empty filter slot
    d.line([(700, 330), (840, 560)], fill=(214, 120, 60), width=6)
    d.line([(840, 330), (700, 560)], fill=(214, 120, 60), width=6)
    return img


def drain():
    img, d = base("Golvbrunn")
    d.ellipse([400, 300, 800, 700], outline=FG, width=10)
    for x in range(460, 760, 40):
        d.line([(x, 360), (x, 640)], fill=FG, width=6)
    d.arc([380, 280, 820, 720], 200, 260, fill=(214, 120, 60), width=10)
    return img


def storage():
    img, d = base("Förråd i skyddsrummet")
    for i, (x, y, w, h) in enumerate([(200, 420, 260, 300), (480, 360, 220, 360), (720, 470, 300, 250), (330, 250, 200, 170)]):
        d.rectangle([x, y, x + w, y + h], outline=FG if i % 2 else MUTED, width=8)
        d.line([(x, y + h // 2), (x + w, y + h // 2)], fill=MUTED, width=3)
    d.rectangle([960, 200, 1040, 720], outline=(214, 120, 60), width=8)  # blocked exit
    return img


def sign():
    img, d = base("Skyddsrumsskylt")
    d.rectangle([420, 200, 780, 560], outline=FG, width=14)
    d.polygon([(600, 260), (730, 500), (470, 500)], outline=FG, width=14)
    d.line([(400, 620), (820, 160)], fill=(214, 120, 60), width=10)  # damaged
    return img


def main():
    OUT.mkdir(exist_ok=True)
    for name, draw in (("dorr", door), ("ventilation", ventilation), ("golvbrunn", drain), ("atkomst", storage), ("skylt", sign)):
        path = OUT / f"{name}.jpg"
        stamp(draw()).save(path, "JPEG", quality=72, optimize=True)
        print(path.name, path.stat().st_size, "bytes")


if __name__ == "__main__":
    main()
