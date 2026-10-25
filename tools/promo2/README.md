# Рекламный ролик с озвучкой (icity-ad-voice.mp4)

Голос — **Дмитрий** (Piper `ru_RU-dmitri-medium`, датасет NabuCasa, лицензия **CC0** — можно в рекламе).
Голос Руслана не используем: его датасет CC BY-NC-SA (только некоммерческое).
Модель: github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-ru_RU-dmitri-medium.tar.bz2 (внутри .onnx и .onnx.json для `python3 -m piper`).

1. Фразы — `lines.json` (`say` — как читать, `cap` — субтитр). Темп `--length-scale` 1.2–1.28, `--noise-scale` 0.35–0.5.
2. Проверка произношения — `voice_check.py`: каждую фразу распознаёт GigaAM (sherpa-onnx, asr-models/sherpa-onnx-nemo-ctc-giga-am-russian-2024-10-24,
   лицензия NC — только для проверки, в ролик не идёт) и выбирает вариант без ошибок — и до, и после обработки звука.
   Трудные места: «гололёд» в начале фразы Дмитрий глотает — читаем «Лестница, высокий бордюр, гололёд».
3. Время слов — `words.json` (метки распознавания); сцена берёт из них моменты появления надписей (`K` в `scene.html`).
4. `python3 timeline.py` → `voice_raw.wav`, `timeline.json`; музыка `python3 music2.py music.wav timeline.json` (своя, синтез).
5. Кадры: `scene.html` с подставленными `__TL__` и `__CITIES__` → `public/_scene2.html`, `node f2.js 0|1 <папка> all`.
6. Сведение: голос highpass 70, +1.5 dB 120 Гц, +1.5 dB 3 кГц, компрессор 2:1, −16 LUFS; музыка −12 dB с вырезом 1.8 и 5 кГц и
   приглушением под голос (sidechaincompress); итог −14 LUFS, пик −1 dB. Эхо и деэссер не ставить: портят «т/с» (проверено распознаванием).
