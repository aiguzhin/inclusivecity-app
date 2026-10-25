import json, subprocess, numpy as np
from scipy.io import wavfile
L=json.load(open('lines.json'))
SR=22050
import sys
gap={'l2':.6,'l3':.55,'l4':.8,'l5':.65,'l6':.65,'l7':.7,'l8':.7,'l9':.9}
t=0.9; tl=[]; parts=[]
for l in L:
    sr,x=wavfile.read(l['id']+'.wav'); assert sr==SR
    x=x.astype(np.float32)/32768
    # обрезаем тишину в начале и конце
    nz=np.where(np.abs(x)>0.01)[0]; a=max(0,nz[0]-int(.03*SR)); b=min(len(x),nz[-1]+int(.08*SR)); x=x[a:b]
    t+=gap.get(l['id'],0)
    tl.append({'id':l['id'],'t0':round(t,3),'t1':round(t+len(x)/SR,3),'cap':l['cap'],'trim':round(a/SR,3)})
    parts.append((t,x)); t+=len(x)/SR
DUR=round(t+3.2,2)
voice=np.zeros(int(DUR*SR)+SR,np.float32)
for st,x in parts: i=int(st*SR); voice[i:i+len(x)]+=x
wavfile.write('voice_raw.wav',SR,(voice*32767).astype(np.int16))
json.dump({'dur':DUR,'lines':tl,'words':json.load(open('words.json'))},open('timeline.json','w'),ensure_ascii=False,indent=1)
print(DUR); [print(x['id'],x['t0'],x['t1'],'trim',x['trim']) for x in tl]
