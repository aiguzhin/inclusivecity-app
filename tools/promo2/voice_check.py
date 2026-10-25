import json, re, numpy as np, soundfile as sf, os, subprocess, itertools, scipy.signal as ss, sherpa_onnx
A='sherpa-onnx-nemo-ctc-giga-am-russian-2024-10-24'
asr=sherpa_onnx.OfflineRecognizer.from_nemo_ctc(model=f'{A}/model.int8.onnx',tokens=f'{A}/tokens.txt',num_threads=4)
M='vits-piper-ru_RU-dmitri-medium/ru_RU-dmitri-medium.onnx'
norm=lambda t: re.sub(r'[^а-яё ]','',t.lower().replace('ё','е').replace('-',' ').replace('ай сити','айсити').replace('ай-сити','айсити')).split()
def wer(r,h):
    r,h=norm(r),norm(h); d=np.arange(len(h)+1)
    for i,a in enumerate(r,1):
        p=d.copy(); d[0]=i
        for j,b in enumerate(h,1): d[j]=min(p[j]+1,d[j-1]+1,p[j-1]+(a!=b))
    return int(d[-1])
def synth(text,ls,ns,nw,out):
    subprocess.run(['python3','-m','piper','-m',M,'-f',out,'--length-scale',str(ls),'--noise-scale',str(ns),'--noise-w-scale',str(nw),'--sentence-silence','0.3'],input=text.encode(),check=True,capture_output=True)
    x,sr=sf.read(out,dtype='float32'); s=asr.create_stream(); s.accept_waveform(16000,ss.resample_poly(x,16000,sr).astype(np.float32)); asr.decode_stream(s); return s.result.text
ref=json.load(open('/tmp/claude-0/-home-claude/a900830a-0bd0-5237-86f5-87d456c9c6d4/scratchpad/vo/lines.json'))
V={ # варианты написания для трудных мест (ref — что должно прозвучать)
 'l1':['Лестница. Высокий бордюр. Гололёд.','Лестница. Высокий бордюр. Гололёд!','Лестница... Высокий бордюр... Гололёд.'],
 'l4':['Ай-Сити строит маршрут в обход: под коляску, трость, плохое зрение или детскую коляску.','Ай Сити строит маршрут в обход: под коляску, трость, плохое зрение или детскую коляску.'],
 'l5':['В гололёд обходит скользкие спуски.','Когда гололёд, обходит скользкие спуски.','В гололёд — обходит скользкие спуски.'],
 'l7':['Голосовой навигатор, автобусы, такси и кнопка помощи — в одном приложении.'],
 'l8':['Двадцать два города Казахстана. Бесплатно и без установки.','Двадцать два города Казахстана. Бесплатно. И без установки.'],
 'l9':['Ай-Сити. Город, в котором можно пройти везде.','Ай Сити. Город, в котором можно пройти везде.'],
}
os.makedirs('dm',exist_ok=True); best={}
for l in ref:
    texts=V.get(l['id'],[l['say']]); refT=l['say']
    cands=[]
    for ti,tx in enumerate(texts):
        for ls,ns,nw in [(1.08,0.5,0.6),(1.12,0.45,0.6),(1.0,0.6,0.8)]:
            out=f"dm/{l['id']}_{ti}_{ls}_{ns}.wav"; h=synth(tx,ls,ns,nw,out)
            e=wer(refT if 'Когда' not in tx else 'когда гололед обходит скользкие спуски',h); cands.append((e,-ls,out,tx,h))
    cands.sort(); best[l['id']]=cands[0]
    print(l['id'],'WER',cands[0][0],'|',cands[0][4],'|',cands[0][2])
json.dump({k:{'wav':v[2],'text':v[3],'heard':v[4],'err':v[0]} for k,v in best.items()},open('dm/best.json','w'),ensure_ascii=False,indent=1)
