#!/usr/bin/env python3
"""
Контакты заведений (телефон, сайт, Instagram) для 22 городов ICity из открытых данных Overture Maps
(слой places, лицензия CDLA-Permissive-2.0 — можно бесплатно, нужна подпись источника).

Запускается GitHub Actions (.github/workflows/places.yml) раз в месяц или вручную:
  pip install duckdb==1.1.3 && python tools/overture_places.py
Пишет public/places/<город>.json — сайт подставляет оттуда номер, если в OpenStreetMap его нет.
"""
import json, os, re, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'public', 'places')
BUCKET = 's3://overturemaps-us-west-2/release/'
PAD_LAT, PAD_LON = 0.2, 0.35          # чуть шире, чем область города на карте (0.13 × 0.24)


def cities():
    src = open(os.path.join(ROOT, 'public', 'index.html'), encoding='utf-8').read()
    block = src[src.index('const CITIES = {'):]
    block = block[:block.index('\n};')]
    out = {}
    for m in re.finditer(r'^\s*([a-z]+):\s*\{.*?c:\[([\d.]+),([\d.]+)\]', block, re.M):
        out[m.group(1)] = (float(m.group(2)), float(m.group(3)))
    if len(out) < 20:
        sys.exit(f'нашли только {len(out)} городов в index.html')
    return out


def latest_release():
    if os.environ.get('OVERTURE_RELEASE'):
        return os.environ['OVERTURE_RELEASE']
    ls = subprocess.run(['aws', 's3', 'ls', '--no-sign-request', BUCKET], capture_output=True, text=True, check=True).stdout
    rel = sorted(re.findall(r'PRE (\d{4}-\d{2}-\d{2}[\w.-]*)/', ls))
    if not rel:
        sys.exit('не удалось получить список релизов Overture')
    return rel[-1]


def main():
    import duckdb
    cs = cities()
    rel = latest_release()
    src = os.environ.get('OVERTURE_SRC') or f'{BUCKET}{rel}/theme=places/type=place/*'
    lat0 = min(c[0] for c in cs.values()) - PAD_LAT; lat1 = max(c[0] for c in cs.values()) + PAD_LAT
    lon0 = min(c[1] for c in cs.values()) - PAD_LON; lon1 = max(c[1] for c in cs.values()) + PAD_LON
    con = duckdb.connect()
    if src.startswith('s3://'):
        con.execute("INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2';")
    print('Overture', rel, src, file=sys.stderr)
    rows = con.execute(f"""
      SELECT names.primary AS name, (bbox.ymin+bbox.ymax)/2 AS lat, (bbox.xmin+bbox.xmax)/2 AS lon,
             phones, websites, socials, categories.primary AS cat, confidence
      FROM read_parquet('{src}', hive_partitioning=1)
      WHERE bbox.xmin BETWEEN {lon0} AND {lon1} AND bbox.ymin BETWEEN {lat0} AND {lat1}
        AND names.primary IS NOT NULL AND confidence >= 0.4
        AND (len(phones) > 0 OR len(websites) > 0 OR len(socials) > 0)
    """).fetchall()
    print('строк в рамке Казахстана:', len(rows), file=sys.stderr)
    os.makedirs(OUT, exist_ok=True)
    total = 0
    for key, (clat, clon) in cs.items():
        items = []
        for name, lat, lon, phones, webs, socials, cat, conf in rows:
            if abs(lat - clat) > PAD_LAT or abs(lon - clon) > PAD_LON:
                continue
            ig = next((s for s in (socials or []) if 'instagram.com' in (s or '')), '')
            items.append([name[:120], round(lat, 6), round(lon, 6), (phones or [''])[0] or '',
                          (webs or [''])[0] or '', ig, cat or ''])
        items.sort(key=lambda r: (r[1], r[2]))
        with open(os.path.join(OUT, key + '.json'), 'w', encoding='utf-8') as f:
            json.dump({'release': rel, 'source': 'Overture Maps Foundation (CDLA-Permissive-2.0)',
                       'fields': ['name', 'lat', 'lon', 'phone', 'website', 'instagram', 'category'], 'p': items},
                      f, ensure_ascii=False, separators=(',', ':'))
        total += len(items)
        print(f'{key}: {len(items)}', file=sys.stderr)
    print('всего мест с контактами:', total, file=sys.stderr)


if __name__ == '__main__':
    main()
