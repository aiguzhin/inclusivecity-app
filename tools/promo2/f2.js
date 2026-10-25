const {chromium}=require('playwright');
(async()=>{const [,,v,out,times]=process.argv;const W=v==='1'?1080:1920,H=v==='1'?1920:1080;
const b=await chromium.launch();const p=await b.newPage({viewport:{width:W,height:H}});
p.on('pageerror',e=>console.log('PAGEERR',e.message));
await p.goto('http://localhost:3000/_scene2.html?v='+v,{waitUntil:'networkidle'});await p.evaluate(()=>window.ready);
if(times==='all'){const fs=require('fs');fs.mkdirSync(out,{recursive:true});const dur=await p.evaluate(()=>TL.dur);const N=Math.round(dur*30);
 for(let i=0;i<N;i++){await p.evaluate(t=>render(t),i/30);await p.screenshot({path:out+'/'+String(i).padStart(5,'0')+'.jpg',type:'jpeg',quality:92});}}
else for(const t of times.split(',')){await p.evaluate(t=>render(+t),t);await p.screenshot({path:out+'_'+t+'.png'});}
await b.close();})();
