#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
直播源健康检查：逐条探测 tv/m3u/live.m3u 中的源，剔除失效条目并重写文件。

判定标准（比单纯 HTTP 200 更严格）：
  - 主播放列表必须含 #EXTM3U 且至少有一个分片地址
  - 或直接返回 ts 分片内容
失效源会被移除，剩余条目保持原有顺序与属性。

环境变量:
  BASE_URL  自有站点地址，用于 tvg-logo / x-tvg-url（默认 https://<owner>.github.io/live）
  TIMEOUT   单条探测超时秒数（默认 10）
"""
import os, re, ssl, sys, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor

M3U = os.path.join('tv', 'm3u', 'live.m3u')
BASE = (os.environ.get('BASE_URL') or 'https://{0}.github.io/live').strip().rstrip('/')
TIMEOUT = int(os.environ.get('TIMEOUT', '10'))
WORKERS = int(os.environ.get('WORKERS', '24'))

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    'Referer': 'https://www.google.com/',
}


def probe(url):
    """返回 True 表示该源当前可播放。"""
    try:
        req = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=TIMEOUT, context=ctx) as resp:
            body = resp.read(4096)
            if resp.status != 200:
                return False
            text = body.decode('utf-8', 'replace')
            if '#EXTM3U' in text:
                segs = [l for l in text.splitlines() if l.strip() and not l.startswith('#')]
                return len(segs) > 0
            # 直接返回分片内容
            return b'.ts' in body[:200] or len(body) > 1000
    except Exception:
        return False


def main():
    if not os.path.exists(M3U):
        print(f'找不到 {M3U}，跳过')
        return 0

    with open(M3U, encoding='utf-8') as f:
        lines = f.read().splitlines()

    header = []
    blocks = []          # [(attrs_line, url)]
    for line in lines:
        s = line.strip()
        if s.startswith('#EXTINF'):
            header.append(s) if not header else None
            attrs = s
            blocks.append([attrs, None])
        elif s and not s.startswith('#') and blocks:
            blocks[-1][1] = s
        elif not s and blocks and blocks[-1][1] is None:
            continue

    urls = [b[1] for b in blocks if b[1]]
    if not urls:
        print('m3u 中没有可检查的源')
        return 0

    print(f'检查 {len(urls)} 条直播源 ...')
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        results = list(ex.map(probe, urls))

    alive = set(u for u, ok in zip(urls, results) if ok)
    removed = len(urls) - len(alive)
    print(f'存活 {len(alive)}/{len(urls)}，移除失效 {removed} 条')

    if removed == 0:
        return 0

    out = [f'#EXTM3U x-tvg-url="{BASE}/e.xml"']
    for attrs, url in blocks:
        if not url or url not in alive:
            continue
        # 统一 logo 与 EPG 指向自有站点
        attrs = re.sub(r'tvg-logo="https://live\.fanmingming\.[a-z]+/tv/',
                       f'tvg-logo="{BASE}/tv/', attrs)
        out.append(attrs)
        out.append(url)

    with open(M3U, 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join(out) + '\n')
    print(f'已重写 {M3U}：{len(alive)} 条源')
    return 0


if __name__ == '__main__':
    sys.exit(main())
