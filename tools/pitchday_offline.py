# Собирает public/media/icity-pitchday-offline.html — презентация одним файлом, работает без интернета
import base64, re, os
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src=open(os.path.join(ROOT,'public/pitchday.html'),encoding='utf-8').read()
def data(path, mime):
    with open(os.path.join(ROOT,'public',path.lstrip('/')),'rb') as f: return f'data:{mime};base64,'+base64.b64encode(f.read()).decode()
src=re.sub(r'url\((/fonts/[^)]+\.woff2)\)', lambda m: 'url('+data(m.group(1),'font/woff2')+')', src)
src=src.replace('src="/icons/soft-192.png"','src="'+data('/icons/soft-192.png','image/png')+'"')
src=src.replace('href="/icons/soft.svg"','href="'+data('/icons/soft.svg','image/svg+xml')+'"')
os.makedirs(os.path.join(ROOT,'public/media'),exist_ok=True)
open(os.path.join(ROOT,'public/media/icity-pitchday-offline.html'),'w',encoding='utf-8').write(src)
print('ok', len(src)//1024, 'KB')
