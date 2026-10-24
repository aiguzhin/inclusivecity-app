import numpy as np, sys
from scipy.signal import lfilter, butter, sosfilt
from scipy.io import wavfile

SR = 48000
BPM = 120
BEAT = 60 / BPM
DUR = 32.5
N = int(SR * DUR)
t_all = np.arange(N) / SR
rng = np.random.default_rng(7)

def midi(m): return 440 * 2 ** ((m - 69) / 12)
def env_adsr(n, a, d, s, r, sus_len):
    a, d, r = int(a*SR), int(d*SR), int(r*SR); sl = max(0, int(sus_len*SR) - a - d)
    e = np.concatenate([np.linspace(0, 1, max(a,1)), np.linspace(1, s, max(d,1)), np.full(sl, s), np.linspace(s, 0, max(r,1))])
    return e[:n] if len(e) >= n else np.pad(e, (0, n-len(e)))
def lp(x, fc, order=2):
    sos = butter(order, fc, 'low', fs=SR, output='sos'); return sosfilt(sos, x)
def hp(x, fc, order=2):
    sos = butter(order, fc, 'high', fs=SR, output='sos'); return sosfilt(sos, x)
def bp(x, lo, hi):
    sos = butter(2, [lo, hi], 'band', fs=SR, output='sos'); return sosfilt(sos, x)
def saw(f, n, ph=0.0):
    tt = np.arange(n) / SR
    return 2 * ((tt * f + ph) % 1) - 1
def add(buf, x, start):
    s = int(start * SR)
    if s >= len(buf): return
    e = min(len(buf), s + len(x)); buf[s:e] += x[:e-s]

# Аккорды по тактам (D, Bm, G, A), 16 тактов
prog = [[62,66,69],[59,62,66],[55,59,62],[57,61,64]]
bars = 17
pad = np.zeros(N); pluck = np.zeros(N); bass = np.zeros(N); drums = np.zeros(N); fx = np.zeros(N); kickenv = np.zeros(N)

for b in range(bars):
    t0 = b * 4 * BEAT
    if t0 >= DUR: break
    ch = prog[b % 4]
    final = b >= 14
    if final: ch = prog[0]
    # Пэд
    length = 4*BEAT if not final else (DUR - t0)
    n = int(length * SR)
    if b == 14: n = int((DUR - t0) * SR); length = DUR - t0
    if b >= 15: continue
    sig = np.zeros(n)
    for m in ch + [ch[0]-12, ch[1]+12]:
        f = midi(m)
        for dt in (-0.08, 0.0, 0.09):
            sig += saw(f * 2**(dt/12), n, ph=rng.random()) * 0.06
    sig = lp(sig, 1400 if b < 2 else 2600)
    sig *= env_adsr(n, 0.35 if b == 0 else 0.05, 0.4, 0.8, 0.6 if not final else 2.5, length - (0.6 if not final else 2.5))
    add(pad, sig, t0)
    # Арпеджио восьмыми
    if not final:
        pattern = [0, 1, 2, 1, 3, 2, 1, 2]
        notes = ch + [ch[0] + 12]
        for k in range(8):
            ts = t0 + k * BEAT / 2
            m = notes[pattern[k]] + 12
            nn = int(0.45 * SR); tt = np.arange(nn) / SR; f = midi(m)
            tone = (np.sin(2*np.pi*f*tt) + 0.35*np.sin(2*np.pi*2*f*tt) + 0.12*np.sin(2*np.pi*3*f*tt)) * np.exp(-tt * 9)
            tone[:96] *= np.linspace(0, 1, 96)
            add(pluck, tone * (0.16 if b >= 2 else 0.12), ts)
    # Бас и ударные с 3-го такта до 14-го
    if 2 <= b < 14:
        root = ch[0] - 24
        for k in range(8):
            ts = t0 + k * BEAT / 2
            nn = int(BEAT/2 * SR * 0.9); tt = np.arange(nn) / SR; f = midi(root + (12 if k % 2 else 0))
            x = np.tanh(2.2 * (np.sin(2*np.pi*f*tt) + 0.3*np.sin(2*np.pi*2*f*tt))) * np.exp(-tt*4)
            x[:120] *= np.linspace(0, 1, 120)
            add(bass, x * 0.20, ts)
        for k in range(4):
            ts = t0 + k * BEAT
            # бочка
            nn = int(0.42*SR); tt = np.arange(nn)/SR
            fsw = 45 + 110*np.exp(-tt*28); ph = 2*np.pi*np.cumsum(fsw)/SR
            kick = np.sin(ph) * np.exp(-tt*7.5); kick[:48] *= np.linspace(0,1,48)
            add(drums, kick * 0.85, ts)
            ke = np.exp(-np.arange(int(0.35*SR))/SR*9); add(kickenv, ke, ts)
            # хлопок на 2 и 4
            if k in (1, 3) and b >= 4:
                nn = int(0.22*SR); tt = np.arange(nn)/SR
                cl = bp(rng.standard_normal(nn), 900, 4200) * (np.exp(-tt*22) + 0.6*np.exp(-np.maximum(tt-0.012,0)*22)*(tt>0.012))
                add(drums, cl * 0.35, ts)
            # хэт на слабую долю
            nn = int(0.06*SR); tt = np.arange(nn)/SR
            hh = hp(rng.standard_normal(nn), 7500) * np.exp(-tt*70)
            add(drums, hh * 0.16, ts + BEAT/2)
            if b >= 8:
                add(drums, hh * 0.08, ts)

# Свист на склейках (под жёлтую шторку)
for c in (4, 8, 14, 18, 24):
    nn = int(0.6*SR); tt = np.arange(nn)/SR
    w = rng.standard_normal(nn)
    sweep = np.zeros(nn)
    for i, (lo, hi) in enumerate([(400, 1200), (900, 2600), (2000, 6000)]):
        seg = bp(w, lo, hi); win = np.exp(-((tt - (0.2 + i*0.1))/0.09)**2); sweep += seg*win
    add(fx, sweep * 0.22, c - 0.3)
# Подъём перед финалом и удар
nn = int(2.0*SR); tt = np.arange(nn)/SR
riser = hp(rng.standard_normal(nn), 1500) * (tt/2.0)**2.2 * 0.25
add(fx, riser, 26.0)
nn = int(2.8*SR); tt = np.arange(nn)/SR
boom = np.sin(2*np.pi*(38+40*np.exp(-tt*6))*tt) * np.exp(-tt*1.6) * 0.75
add(fx, boom, 28.0)
# Финальный аккорд — колокольчики
for i, m in enumerate([74, 78, 81, 86]):
    nn = int(3.6*SR); tt = np.arange(nn)/SR; f = midi(m)
    bell = (np.sin(2*np.pi*f*tt) + 0.25*np.sin(2*np.pi*2.76*f*tt)*np.exp(-tt*3)) * np.exp(-tt*1.3)
    add(fx, bell * 0.10, 28.05 + i*0.09)

# Сайдчейн пэда от бочки
duck = 1 - 0.55*np.clip(kickenv, 0, 1)
pad *= duck

# Реверберация (Шрёдер) для пэда и арпеджио
def reverb(x, mix=0.3):
    out = np.zeros_like(x)
    for d, g in ((1557, .80), (1617, .79), (1491, .81), (1422, .82)):
        d = int(d * SR / 44100); a = np.zeros(d+1); a[0] = 1; a[d] = -g
        out += lfilter([1], a, x)
    out /= 4
    for d, g in ((225, .7), (556, .7)):
        d = int(d * SR / 44100); b = np.zeros(d+1); b[0] = -g; b[d] = 1; a = np.zeros(d+1); a[0] = 1; a[d] = -g
        out = lfilter(b, a, out)
    return x + mix*lp(out, 6000)

music_c = bass + drums
L = reverb(pad*0.95 + pluck*1.05, 0.35) + music_c + fx
R = reverb(pad*1.0 + pluck*0.9, 0.38) + music_c + fx
# Небольшая ширина: задержка арпеджио в правом канале
dly = int(0.012*SR); R[dly:] += pluck[:-dly]*0.15

mix = np.stack([L, R], 1)
mix = hp(mix.T, 30).T
# Вход и выход
fi = np.clip(t_all/0.08, 0, 1); fo = np.clip((DUR - t_all)/1.2, 0, 1)
mix *= (fi*fo)[:, None]
# Мягкий лимитер
peak = np.max(np.abs(mix)); mix = mix / peak * 0.98
mix = np.tanh(mix * 1.6) / np.tanh(1.6) * 0.89
wavfile.write(sys.argv[1], SR, (mix * 32767).astype(np.int16))
print("ok", peak)
