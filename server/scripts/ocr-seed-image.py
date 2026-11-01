"""生成一张「作业纸」测试图，供识别页 OCR 播种用（A 任务配套）。

为什么要每次随机：后端按 (user_id, file_hash) 查重，同内容文件会命中历史条目，
造数据必须内容不同（MEMORY 铁律）。所以右下角带随机编号。

依赖：Pillow + Windows 自带字体（msyh.ttc）。与 server/scripts/ide-ocr-seed.mjs 配套，
由后者在缺图时自动调用：
    python scripts/ocr-seed-image.py ../.tmp
产物：<out>/ocr-seed.png 与 <out>/ocr-seed.b64（后者是 base64 文本，喂给模拟器文件系统）
"""
import base64
import random
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

out_dir = Path(sys.argv[1] if len(sys.argv) > 1 else "../.tmp").resolve()
out_dir.mkdir(parents=True, exist_ok=True)
rand = random.randint(1000, 9999)

img = Image.new("RGB", (640, 420), "white")
draw = ImageDraw.Draw(img)
font = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 26)
small = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 16)

lines = [
    "1. 计算 13 + 27 =        答：40",
    "2. 计算 8 x 7 =          答：56",
    "3. 计算 96 / 4 =         答：24",
    "4. 计算 45 - 18 =        答：27",
]
y = 40
for line in lines:
    draw.text((30, y), line, font=font, fill="black")
    y += 72
draw.text((30, 378), f"作业纸 编号 {rand}", font=small, fill="black")

png = out_dir / "ocr-seed.png"
img.save(png)
(out_dir / "ocr-seed.b64").write_text(base64.b64encode(png.read_bytes()).decode("ascii"), encoding="ascii")
print(f"png={png} bytes={png.stat().st_size} rand={rand}")
