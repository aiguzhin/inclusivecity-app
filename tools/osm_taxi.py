#!/usr/bin/env python3
"""
Службы такси каждого города ICity из OpenStreetMap (диспетчерские, стоянки с телефоном).
Запускается GitHub Actions (.github/workflows/taxi.yml). Пишет public/taxi-osm.json:
{"<город>": [[название, телефон, lat, lon], ...]} — карта показывает в такси только службы своего города.
"""
import json, os, re, sys, time, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAD_LAT, PAD_LON = 0.2, 0.35
APIS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter',
        'https://maps.mail.ru/osm/tools/overpass/api/interpreter']


def cities():
    src = open(os.path.join(ROOT, 'public', 'index.html'), encoding='utf-8').read()
    block = src[src.index('const CITIES = {'):]
    block = block[:block.index('\n};')]
    return {m.group(1): (float(m.group(2)), float(m.group(3)))
            for m in re.finditer(r'^\s*([a-z]+):\s*\{.*?c:\[([\d.]+),([\d.]+)\]', block, re.M)}


def overpass(q):
    for i in range(4):
        api = APIS[i % len(APIS)]
        try:
            req = urllib.request.Request(api, data=urllib.parse.urlencode({'data': q}).encode(),
                                         headers={'User-Agent': 'ICity/1.0 (inclusivecity.uk)'})
            return json.load(urllib.request.urlopen(req, timeout=200))
        except Exception as e:
            print('  retry', api, e, file=sys.stderr); time.sleep(15)
    sys.exit('Overpass не ответил')


def phone(t):
    for k in ('phone', 'contact:phone', 'contact:mobile', 'mobile'):
        if t.get(k):
            return re.split(r'[;,]', t[k])[0].strip()
    return ''


def main():
    cs = cities()
    # один запрос на все 22 города — Overpass не любит частые запросы подряд
    parts = []
    for la, lo in cs.values():
        bb = f'{la-PAD_LAT},{lo-PAD_LON},{la+PAD_LAT},{lo+PAD_LON}'
        parts.append(f'nwr["office"="taxi"]({bb});nwr["amenity"="taxi"]["phone"]({bb});'
                     f'nwr["name"~"такси|taxi",i]["phone"]({bb});nwr["name"~"такси|taxi",i]["contact:phone"]({bb});')
    q = '[out:json][timeout:180];(' + ''.join(parts) + ');out center tags;'
    els = overpass(q).get('elements', [])
    print('объектов:', len(els), file=sys.stderr)
    out = {k: [] for k in cs}; seen = {k: set() for k in cs}
    for e in els:
        t = e.get('tags', {}); ph = phone(t)
        name = t.get('name') or t.get('brand') or t.get('operator') or ''
        txt = (name + ' ' + t.get('office', '') + ' ' + t.get('amenity', '')).lower()
        if not ph or not name or ('такси' not in txt and 'taxi' not in txt):
            continue
        c = e.get('center') or e
        lat, lon = c.get('lat'), c.get('lon')
        if lat is None: continue
        key = min(cs, key=lambda k: (cs[k][0]-lat)**2 + ((cs[k][1]-lon)*0.65)**2)
        k2 = re.sub(r'\D', '', ph)[-10:]
        if k2 in seen[key]: continue
        seen[key].add(k2)
        out[key].append([name[:80], ph, round(lat, 5), round(lon, 5)])
    for k, v in out.items():
        print(f'{k}: {len(v)}', file=sys.stderr)
    with open(os.path.join(ROOT, 'public', 'taxi-osm.json'), 'w', encoding='utf-8') as f:
        json.dump({'source': 'OpenStreetMap contributors (ODbL)', 'fields': ['name', 'phone', 'lat', 'lon'], 'c': out},
                  f, ensure_ascii=False, separators=(',', ':'))


if __name__ == '__main__':
    main()
