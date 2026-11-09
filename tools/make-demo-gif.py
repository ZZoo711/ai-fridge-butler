#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把真实 Chrome 截图合成 30 秒循环演示 GIF + GitHub 社交预览图。

用法：python make-demo-gif.py --shots=<截图目录> --out=<输出目录>
依赖：Pillow（pip install Pillow）
所有画面均来自产品真实渲染，未修改任何产品代码。
"""
import argparse
import os
from PIL import Image, ImageDraw, ImageFont

P = argparse.ArgumentParser()
P.add_argument('--shots', default=os.path.join(os.path.dirname(__file__), '..', '.check-output', 'screens'))
P.add_argument('--out', default=os.path.join(os.path.dirname(__file__), '..', 'docs'))
a = P.parse_args()
SHOTS, OUT = os.path.abspath(a.shots), os.path.abspath(a.out)
os.makedirs(OUT, exist_ok=True)

W = 320
CAP_H = 74
FONT_BD = 'C:/Windows/Fonts/msyhbd.ttc'
FONT_RG = 'C:/Windows/Fonts/msyh.ttc'
GREEN = (19, 92, 58)
DARK = (20, 39, 31)
LIGHT = (238, 248, 241)


def font(path, size):
    return ImageFont.truetype(path, size, index=0)


def fit_text(draw, text, fnt, max_w, min_size=11, path=FONT_RG):
    """超宽时自动缩字号，保证单行放得下。"""
    size = fnt.size
    while size > min_size:
        f = font(path, size)
        if draw.textbbox((0, 0), text, font=f)[2] <= max_w:
            return f
        size -= 1
    return font(path, min_size)


def caption(img, title, sub):
    """给画面加统一字幕条。"""
    canvas = Image.new('RGB', (W, img.height + CAP_H), DARK)
    canvas.paste(img, (0, 0))
    d = ImageDraw.Draw(canvas)
    y0 = img.height
    d.rectangle((0, y0, W, y0 + CAP_H), fill=DARK)
    d.rectangle((0, y0, 4, y0 + CAP_H), fill=(46, 190, 110))
    f1 = fit_text(d, title, font(FONT_BD, 19), W - 28, min_size=14, path=FONT_BD)
    d.text((14, y0 + 9), title, font=f1, fill=(240, 255, 245))
    f2 = fit_text(d, sub, font(FONT_RG, 13), W - 28)
    d.text((14, y0 + 42), sub, font=f2, fill=(168, 200, 180))
    return canvas


def scene(filename, title, sub):
    im = Image.open(os.path.join(SHOTS, filename)).convert('RGB')
    h = round(im.height * W / im.width)
    im = im.resize((W, h), Image.Resampling.LANCZOS)
    return caption(im, title, sub)


SCENES = [
    ('01-home.png', '先看什么快坏了', '18 样食材、10 样临期，首页直接排出优先级'),
    ('02-fridge.png', '录食材和保质期', '按批次管理，做饭自动扣最早到期的一批'),
    ('03-plan.png', '不做菜谱搜索，做临期倒计时', '按临期 / 库存 / 忌口 / 口味 / 历史评分排序 30 道菜'),
    ('10-recipe-modal.png', '推荐理由全部摊开给你看', '点开做法，一键「我做了这道菜」自动扣库存'),
    ('04-week.png', '一周菜单，自动出采购清单', '临期锚定，7 天不重样'),
    ('05-leftover.png', '剩菜单独成盒，不重复扣库存', '改造方案排序 + 凑一锅，熟食 2 天护栏'),
    ('08-stats.png', '少扔了多少，自己看得到', '下厨次数 / 临期救回 / 估算节省金额自动累计'),
    ('11-m4-card.png', '把「怎么证伪自己」也写进代码', '20 人 × 14 天打卡 · CSV 导出 · 自动 GO/NO-GO'),
    ('09-settings.png', '零后端 · 零账号 · 零构建', '数据只在浏览器 localStorage，可导出 JSON 备份'),
]

frames, durations = [], []
last_still = None
H = None
for i, (fn, title, sub) in enumerate(SCENES):
    cur = scene(fn, title, sub)
    H = cur.height
    # 画面交叉淡入，字幕硬切（避免文字重影）
    if last_still is not None:
        for alpha in (0.34, 0.68):
            blended = Image.blend(last_still.crop((0, 0, W, H - CAP_H)),
                                  cur.crop((0, 0, W, H - CAP_H)), alpha)
            f = Image.new('RGB', (W, H), DARK)
            f.paste(blended, (0, 0))
            f.paste(cur.crop((0, H - CAP_H, W, H)), (0, H - CAP_H))
            frames.append(f)
            durations.append(150)
    frames.append(cur)
    durations.append(2700)
    last_still = cur

# 结尾品牌卡
outro = Image.new('RGB', (W, H - CAP_H))
d = ImageDraw.Draw(outro)
for y in range(outro.height):
    k = y / outro.height
    d.line((0, y, W, y), fill=(int(16 + 12 * k), int(78 + 28 * k), int(52 + 18 * k)))
d.rounded_rectangle((24, 118, W - 24, 300), radius=18, fill=(255, 255, 255))
d.text((48, 146), '鲜知', font=font(FONT_BD, 40), fill=GREEN)
d.text((48, 200), '冰箱大脑', font=font(FONT_BD, 32), fill=DARK)
d.text((48, 252), 'v1.6.2 · MIT 开源', font=font(FONT_RG, 14), fill=(90, 115, 100))
d.text((34, 342), '双击 index.html 就能跑', font=font(FONT_BD, 19), fill=(235, 255, 242))
d.text((34, 378), '断网可用 · 不上传任何数据', font=font(FONT_RG, 14), fill=(175, 220, 190))
d.text((34, 440), 'github.com', font=font(FONT_RG, 13), fill=(150, 205, 172))
d.text((34, 462), 'ZZoo711/ai-fridge-butler', font=font(FONT_BD, 13), fill=(235, 255, 242))
d.text((34, 530), 'M4 真实验证尚未执行', font=font(FONT_RG, 13), fill=(205, 230, 212))
d.text((34, 552), 'README 如实标注，没有结论', font=font(FONT_RG, 13), fill=(205, 230, 212))
outro_full = caption(outro, '先算临期，再决定今晚吃什么', '纯前端 PWA · 代码与验证工具链全部开源')
for alpha in (0.34, 0.68):
    blended = Image.blend(last_still.crop((0, 0, W, H - CAP_H)), outro, alpha)
    f = Image.new('RGB', (W, H), DARK)
    f.paste(blended, (0, 0))
    f.paste(outro_full.crop((0, H - CAP_H, W, H)), (0, H - CAP_H))
    frames.append(f)
    durations.append(150)
frames.append(outro_full)
durations.append(3600)

gif = os.path.join(OUT, 'demo-30s.gif')
# 交给 Pillow 逐帧自适应调色板，避免全局调色板把品牌深绿量化成偏蓝色
frames[0].save(gif, save_all=True, append_images=frames[1:], duration=durations,
               loop=0, optimize=True, disposal=2)
print('GIF:', gif)
print('frames=%d  duration=%.1fs  size=%.2f MB' %
      (len(frames), sum(durations) / 1000, os.path.getsize(gif) / 1024 / 1024))

# GitHub 社交预览图 1200×630
soc = Image.new('RGB', (1200, 630))
d = ImageDraw.Draw(soc)
for y in range(630):
    k = y / 630
    d.line((0, y, 1200, y), fill=(int(14 + 10 * k), int(70 + 24 * k), int(45 + 14 * k)))
d.rounded_rectangle((64, 86, 640, 544), radius=26, fill=(255, 255, 255))
d.text((110, 130), '鲜知 · 冰箱大脑', font=font(FONT_BD, 54), fill=GREEN)
d.text((110, 218), '先算哪样快坏了，', font=font(FONT_BD, 40), fill=DARK)
d.text((110, 274), '再决定今晚吃什么。', font=font(FONT_BD, 40), fill=DARK)
for i, t in enumerate(['零后端 · 零账号 · 零构建', '双击 index.html 就能跑，断网可用',
                       '内置 20 人 × 14 天验证工具链']):
    d.ellipse((112, 362 + i * 46, 122, 372 + i * 46), fill=(46, 190, 110))
    d.text((138, 352 + i * 46), t, font=font(FONT_RG, 21), fill=(70, 100, 82))
d.text((110, 500), 'github.com/ZZoo711/ai-fridge-butler', font=font(FONT_BD, 18), fill=(120, 155, 132))
phone = Image.open(os.path.join(SHOTS, '01-home.png')).convert('RGB')
pw = 224
phone = phone.resize((pw, round(phone.height * pw / phone.width)), Image.Resampling.LANCZOS)
soc.paste(phone, (860, 48))
d = ImageDraw.Draw(soc)
d.rounded_rectangle((860, 48, 860 + pw, 48 + phone.height), radius=16, outline=(255, 255, 255), width=3)
sp = os.path.join(OUT, 'social-preview.png')
soc.save(sp, optimize=True)
print('SOCIAL:', sp, '%.0f KB' % (os.path.getsize(sp) / 1024))
