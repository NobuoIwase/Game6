// 実際のPCブラウザで確認用の視点を保存。俯瞰だけ霧を弱めて街区全体を読む。
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import fs from 'node:fs/promises';
import path from 'node:path';
const out=path.resolve(process.argv[2]||'artifacts/neighborhood/review');
await fs.mkdir(out,{recursive:true});
const server=await createServer({logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false,watch:{ignored:['**/*']}}});
await server.listen();
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',args:['--mute-audio']});
try {
  const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{let s=726146;Math.random=()=>((s=(Math.imul(s,1664525)+1013904223)>>>0)/4294967296);});
  await page.goto(server.resolvedUrls.local[0]);
  await page.selectOption('#quality','low');await page.click('#startBtn');
  await page.waitForFunction(()=>window.__game?.()&&document.querySelector('#loading')?.classList.contains('hidden'),null,{timeout:180000});
  const layout=await page.evaluate(()=>{
    const g=window.__game();g.engine.stopRenderLoop();g.paused=true;
    return {parcels:g.city.parcels,roads:g.city.roads.streets.map(s=>({id:s.id,from:s.from,to:s.to,length:s.length,width:s.width,sidewalk:s.sidewalk,kind:s.kind,samples:s.samples}))};
  });
  const views=[{name:'overview',pos:[210,420,240],target:[0,2,0],fog:.0004,maxZ:1400},
    {name:'park-route',pos:[-23,2.1,32],target:[-2,2,-10]},
    {name:'residential-slope',pos:[54,4.6,23],target:[80,6,58]}];
  for(const use of ['arcade','estate','house','company','apartment','parking']) {
    const p=layout.parcels.find(p=>use==='apartment'?p.assetId==='tokyo_small_apartment_001':p.use===use);if(!p)continue;
    const s=Math.sin(p.yaw),c=Math.cos(p.yaw),d=p.d/2+10;
    views.push({name:use,pos:[p.x+s*d+c*5,p.y+2.1,p.z+c*d-s*5],target:[p.x,p.y+4.2,p.z]});
    if(use==='apartment') {
      const e=p.d/2;
      views.push({name:'entrance-detail',pos:[p.x+s*(e+5)+c*3,p.y+1.65,p.z+c*(e+5)-s*3],target:[p.x+s*e,p.y+.25,p.z+c*e]});
    }
  }
  for(const view of views) {
    await page.evaluate(v=>{
      const g=window.__game(),V=g.player.position.constructor;
      g.scene.fogDensity=v.fog??.0034;g.camera.maxZ=v.maxZ??520;g.camera.position.set(...v.pos);g.camera.setTarget(new V(...v.target));
      g.assets.update(1,g.camera.position);for(let i=0;i<6;i++)g.scene.render();
    },view);
    await page.screenshot({path:path.join(out,view.name+'.png')});
  }
  await fs.writeFile(path.join(out,'layout.json'),JSON.stringify({...layout,views,errors},null,2));
  console.log(JSON.stringify({parcels:layout.parcels.length,byUse:layout.parcels.reduce((a,p)=>(a[p.use]=(a[p.use]||0)+1,a),{}),views:views.map(v=>v.name),errors},null,2));
} finally {await browser.close();await server.close();}
