"""把 258MB 的卡图缩成网页尺寸（192px webp），打包用。
用法：python tools/shrink-assets.py <源 assets> <目标 assets>
单张约 120KB → 8~15KB，缩完整个 assets 大约 20~30MB。
"""
import io
import json
import os
import shutil
import sys
from concurrent.futures import ThreadPoolExecutor

from PIL import Image

SRC = sys.argv[1] if len(sys.argv) > 1 else r'D:\tts-server\sts2-ui\assets'
DST = sys.argv[2] if len(sys.argv) > 2 else r'D:\tts-server\sts2-ui\assets_web'
MAX_W = 192
QUALITY = 72

stats = {'done': 0, 'skip': 0, 'fail': 0, 'src_bytes': 0, 'dst_bytes': 0}


IMAGE_EXT = ('.webp', '.png', '.jpg', '.jpeg', '.gif', '.bmp')


def convert(rel):
    src = os.path.join(SRC, rel)
    dst = os.path.join(DST, rel)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    try:
        if not rel.lower().endswith(IMAGE_EXT) or os.path.getsize(src) < 60 * 1024:
            shutil.copy2(src, dst)
            stats['skip'] += 1
            stats['src_bytes'] += os.path.getsize(src)
            stats['dst_bytes'] += os.path.getsize(dst)
            return
        with Image.open(src) as im:
            im = im.convert('RGBA') if im.mode in ('RGBA', 'LA', 'P') else im.convert('RGB')
            w, h = im.size
            if w > MAX_W:
                im = im.resize((MAX_W, max(1, round(h * MAX_W / w))), Image.LANCZOS)
            im.save(dst, 'WEBP', quality=QUALITY, method=4)
        stats['done'] += 1
        stats['src_bytes'] += os.path.getsize(src)
        stats['dst_bytes'] += os.path.getsize(dst)
    except Exception as e:  # noqa: BLE001
        stats['fail'] += 1
        print('失败', rel, e)


def main():
    if os.path.isdir(DST):
        shutil.rmtree(DST)
    os.makedirs(DST, exist_ok=True)

    # 卡片走缩图；relics / ui / 各种 json 原样复制
    jobs = []
    for sub in ('cards',):
        base = os.path.join(SRC, sub)
        for name in os.listdir(base):
            jobs.append(os.path.join(sub, name))
    for sub in ('relics', 'ui'):
        base = os.path.join(SRC, sub)
        if not os.path.isdir(base):
            continue
        for root, _dirs, files in os.walk(base):
            for n in files:
                jobs.append(os.path.relpath(os.path.join(root, n), SRC))
    for name in os.listdir(SRC):
        p = os.path.join(SRC, name)
        if os.path.isfile(p):
            jobs.append(name)

    with ThreadPoolExecutor(max_workers=12) as ex:
        list(ex.map(convert, jobs))

    print(json.dumps({
        '文件数': len(jobs),
        **stats,
        '源': round(stats['src_bytes'] / 1024 / 1024, 1),
        '目标': round(stats['dst_bytes'] / 1024 / 1024, 1),
        '压缩比': round(stats['src_bytes'] / max(1, stats['dst_bytes']), 1),
    }, ensure_ascii=False))


if __name__ == '__main__':
    main()
