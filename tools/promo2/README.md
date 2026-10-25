# Рекламный ролик с озвучкой (icity-ad-voice.mp4)

1. Голос: Piper, модель `ru-irinia-medium` (github.com/rhasspy/piper, релиз v0.0.2). Текст — `lines.json` (`say` — как читать, `cap` — субтитр).
   `python3 -m piper -m ru-irinia-medium.onnx -f l1.wav --length-scale 1.05 --sentence-silence 0.25`
2. `python3 timeline.py` — склеивает фразы с паузами, пишет `voice_raw.wav` и `timeline.json` (время каждой фразы).
3. `python3 music2.py music2.wav timeline.json` — своя музыка (синтез), финальный аккорд ровно на последней фразе.
4. Сцена: в `scene.html` подставить `__TL__` (timeline.json) и `__CITIES__` (../promo/cities.json), положить в `public/_scene2.html`,
   кадры — `node f2.js 0 <папка> all` (16:9) и `node f2.js 1 <папка> all` (9:16).
5. Сведение ffmpeg: голос (компрессор, эквалайзер, −16 LUFS) + музыка −9 dB с приглушением под голос (sidechaincompress), итог −14 LUFS.
