import sys
S=sys.argv[1]
s=open(S+'/video/scene.html').read().replace('__CITIES__',open(S+'/cities.json').read())
ff=''
for fam,key,ws in [('Unbounded','unbounded',[500,700]),('Golos Text','golos-text',[400,500,600,700])]:
  for w in ws:
    for sub,rng in [('cyrillic','U+0301,U+0400-045F,U+0490-04FF,U+2116'),('latin','U+0000-00FF,U+20B8,U+2013-2014,U+2018-201E,U+2026')]:
      ff+="@font-face{font-family:'%s';font-weight:%d;src:url(/_fonts/%s-%s-%d-normal.woff2) format('woff2');unicode-range:%s}\n"%(fam,w,key,sub,w,rng)
s=s.replace('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Unbounded:wght@500;700&family=Golos+Text:wght@400;500;600;700&display=swap">','<style>'+ff+'</style>')
s=s.replace("window.ready=document.fonts.ready","window.ready=Promise.all(['500 20px Unbounded','700 20px Unbounded','400 20px \"Golos Text\"','500 20px \"Golos Text\"','600 20px \"Golos Text\"','700 20px \"Golos Text\"'].map(f=>document.fonts.load(f,'АаЯя Ққ Әә'))).then(()=>document.fonts.ready)")
open('/home/claude/inclusivecity-app/public/_scene.html','w').write(s)
