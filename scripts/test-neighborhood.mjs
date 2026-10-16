// 実ブラウザで地形・Havok・OBB・迂回移動・同時入力・戦闘・倒壊を確認する。
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const pilot=process.argv.includes('--pilot');
const out=path.resolve(process.env.NEIGHBORHOOD_TEST_OUT||'artifacts/neighborhood/'+(pilot?'pilot-tests':'tests'));
await fs.mkdir(out,{recursive:true});
const server=await createServer({logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false,watch:{ignored:['**/*']}}});
await server.listen();
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',args:['--mute-audio']});
const errors=[];
try {
  const results=[];
  for(let run=0;run<2;run++) {
    console.log('run',run+1,'loading');
    const page=await browser.newPage({viewport:{width:1280,height:720}});
    page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(()=>{let s=726146;Math.random=()=>((s=(Math.imul(s,1664525)+1013904223)>>>0)/4294967296);});
    await page.goto(server.resolvedUrls.local[0]+(pilot?'?district=pilot':''));
    await page.selectOption('#quality','low');await page.click('#startBtn');
    await page.waitForFunction(()=>window.__game?.()&&document.querySelector('#loading')?.classList.contains('hidden'),null,{timeout:180000});
    console.log('run',run+1,'checks');
    const report=await page.evaluate(async run=>{
      const g=window.__game(),V=g.player.position.constructor,city=g.city,roads=city.roads,pe=g.scene.getPhysicsEngine();
      g.engine.stopRenderLoop();g.paused=true;g.bot=null;g.onEnd=undefined;
      let seed=8001;Math.random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
      const failures=[],checks=[];
      const check=(name,ok,detail)=>{checks.push({name,ok,detail});if(!ok)failures.push(name);};
      const direct=roads.route('westGate','eastGate'),detour=roads.route('westGate','eastGate',['shopping-west','shopping-east']);
      check('100m-main-and-real-detour',direct?.length>99&&direct.length<115&&detour?.length>direct.length+30,{direct,detour});
      let count=0,maxHeightError=0,maxPhysicsError=0,maxSlope=0,blocked=0;const blockedPoints=[];
      for(const street of roads.streets) {
        for(let i=1;i<street.samples.length;i++) {const a=street.samples[i-1],b=street.samples[i];maxSlope=Math.max(maxSlope,Math.abs(b.y-a.y)/Math.hypot(b.x-a.x,b.z-a.z));}
        for(let i=1;i<street.samples.length-1;i+=8) {
          const s=street.samples[i],h=city.heightAt(s.x,s.z),ray=city.raycast(new V(s.x,h+1,s.z),new V(0,-1,0),3);
          const physics=pe.raycast(new V(s.x,h+1,s.z),new V(s.x,h-2,s.z));
          count++;maxHeightError=Math.max(maxHeightError,ray?Math.abs(ray.point.y-h):999);
          maxPhysicsError=Math.max(maxPhysicsError,physics.hasHit?Math.abs(physics.hitPointWorld.y-h):999);
          if(!city.isOpen(s.x,s.z,.55)){blocked++;blockedPoints.push({street:street.id,x:s.x,z:s.z});}
        }
      }
      check('surface-ray-height-agreement',maxHeightError<.002,{count,maxHeightError});
      check('havok-uses-rendered-ground',maxPhysicsError<.035,{maxPhysicsError});
      check('continuous-walkable-road-centers',blocked===0&&maxSlope<.13,{blocked,maxSlope,blockedPoints});
      const b=city.buildings.find(b=>b.asset&&b.boxes.length===1&&b.boxes[0].oriented.hw>3.5&&b.boxes[0].oriented.hd>3.5&&Math.abs(Math.sin(b.boxes[0].oriented.yaw*2))>.65);
      if(b) {
        const o=b.boxes[0].oriented,c=Math.cos(o.yaw),s=Math.sin(o.yaw),y=b.baseY+b.height*.6;
        const origin=new V(o.x+s*(o.hd+2),y,o.z+c*(o.hd+2)),dir=new V(-s,0,-c);
        const hit=city.raycast(origin,dir,4),physical=pe.raycast(origin,origin.add(dir.scale(4)));
        check('arbitrary-yaw-wall-ray',hit?.building===b&&Math.abs(hit.dist-2)<.005,{yaw:o.yaw,dist:hit?.dist});
        check('arbitrary-yaw-havok',physical.hasHit&&V.Distance(hit.point,physical.hitPointWorld)<.035,{distance:physical.hasHit?V.Distance(hit.point,physical.hitPointWorld):null});
        let emptyCorner=false;
        for(let ix=1;ix<10&&!emptyCorner;ix++)for(let iz=1;iz<10&&!emptyCorner;iz++) {
          const box=b.boxes[0],x=box.minX+(box.maxX-box.minX)*ix/10,z=box.minZ+(box.maxZ-box.minZ)*iz/10;
          const lx=(x-o.x)*c-(z-o.z)*s,lz=(x-o.x)*s+(z-o.z)*c;
          if(Math.abs(lx)<o.hw+.6&&Math.abs(lz)<o.hd+.6)continue;
          const pos=new V(x,y,z),before=pos.clone();city.collideCircle(pos,.4,1.8);
          if(V.Distance(pos,before)<.001&&city.heightAt(x,z,y)<y-.5)emptyCorner=true;
        }
        check('aabb-corner-does-not-block',emptyCorner);
      } else check('has-rotated-building',false);
      // 移動試験中だけ敵とミッションの進行を停止。プレイヤーの通常更新・物理は通す。
      for(const e of g.enemies.list)e.root.setEnabled(false);
      g.enemies.list=[];g.mission.update=()=>{};g.timers=[];g.time=0;g.player.armor=g.player.maxArmor=6000;
      const input=g.opts.input,dt=1/60;
      const reset=(x,z)=>{g.player.position.set(x,city.heightAt(x,z),z);g.player.velH.setAll(0);g.player.velY=0;g.player.state='normal';g.player.grounded=true;input.reset();g.camRecoil=0;g.camPitch=0;};
      const step=(frame={})=>{input.update();Object.assign(input,{moveX:0,moveY:0,fire:false,zoom:false,dash:false,lookDX:0,lookDY:0},frame);g.update(dt);pe._step(dt);input.endFrame();};
      const follow=(route,from='westGate')=>{
        reset(roads.nodes[from][0],roads.nodes[from][2]);
        let current=from,steps=0,maxGap=0,maxVerticalStep=0,reached=true;
        for(const id of route.streets) {
          const street=roads.streets.find(s=>s.id===id),forward=street.from===current;
          const points=forward?street.samples:[...street.samples].reverse();current=forward?street.to:street.from;
          const targets=points.filter((_,i)=>i%3===0||i===points.length-1);
          for(const target of targets) {
            let guard=0;
            while(Math.hypot(target.x-g.player.position.x,target.z-g.player.position.z)>.45&&guard++<150) {
              const oldY=g.player.position.y;
              g.camYaw=Math.atan2(target.x-g.player.position.x,target.z-g.player.position.z);step({moveY:1});steps++;
              maxVerticalStep=Math.max(maxVerticalStep,Math.abs(g.player.position.y-oldY));
              maxGap=Math.max(maxGap,Math.abs(g.player.position.y-city.heightAt(g.player.position.x,g.player.position.z,g.player.position.y)));
            }
            if(guard>=150){reached=false;break;}
          }
          if(!reached)break;
        }
        return {reached,steps,seconds:steps*dt,maxGap,maxVerticalStep,end:g.player.position.asArray()};
      };
      const walks={direct:follow(direct),detour:follow(detour)};
      check('walk-main-route',walks.direct.reached&&walks.direct.maxGap<.35,walks.direct);
      check('walk-park-detour',walks.detour.reached&&walks.detour.maxGap<.35,walks.detour);
      const streetWalks=roads.streets.map(s=>({street:s.id,...follow({streets:[s.id]},s.from)}));
      check('every-road-and-alley-is-traversable',streetWalks.every(w=>w.reached&&w.maxVerticalStep<.45),streetWalks);
      const communityWalks=[];
      for(const space of city.communitySpaces??[])for(const [index,path] of space.paths.entries()) {
        reset(path[0][0],path[0][2]);let reached=true,maxStep=0,steps=0;
        for(let j=1;j<path.length;j++) {
          const a=path[j-1],b=path[j],count=Math.ceil(Math.hypot(b[0]-a[0],b[2]-a[2])/2);
          for(let k=1;k<=count;k++) {
            const x=a[0]+(b[0]-a[0])*k/count,z=a[2]+(b[2]-a[2])*k/count;let guard=0;
            while(Math.hypot(x-g.player.position.x,z-g.player.position.z)>.3&&guard++<160) {
              const old=g.player.position.y;g.camYaw=Math.atan2(x-g.player.position.x,z-g.player.position.z);step({moveY:.8});steps++;
              maxStep=Math.max(maxStep,Math.abs(g.player.position.y-old));
            }
            if(guard>=160){reached=false;break;}
          }
          if(!reached)break;
        }
        communityWalks.push({space:space.id,index,reached,maxStep,steps});
      }
      const spaces=city.communitySpaces??[];
      check('community-spaces-connect-and-can-be-walked',communityWalks.every(w=>w.reached&&w.maxStep<.45)&&spaces.every(s=>s.paths.length===2&&Math.hypot(s.paths[0].at(-1)[0]-s.paths[1].at(-1)[0],s.paths[0].at(-1)[2]-s.paths[1].at(-1)[2])>12)&&(roads.streets.length===8||spaces.length===4),communityWalks);
      const entrances=[];
      for(const p of city.parcels.filter((p,i)=>i%13===0||p.use==='parking')) {
        const road=roads.streets.find(r=>r.id===p.streetId),s=roads.at(road,p.along),c=Math.cos(p.yaw),sn=Math.sin(p.yaw);
        const ex=p.refined?0:-1.35;
        const target={x:p.x+ex*c+(p.d/2-.8)*sn,z:p.z-ex*sn+(p.d/2-.8)*c};
        reset(s.x+ex*c,s.z-ex*sn);let guard=0,maxStep=0;
        while(Math.hypot(target.x-g.player.position.x,target.z-g.player.position.z)>.2&&guard++<240) {
          const old=g.player.position.y;g.camYaw=Math.atan2(target.x-g.player.position.x,target.z-g.player.position.z);step({moveY:.7});
          maxStep=Math.max(maxStep,Math.abs(g.player.position.y-old));
        }
        entrances.push({parcel:p.id,use:p.use,reached:guard<240,maxStep});
      }
      check('curb-cuts-and-parking-entrances',entrances.every(e=>e.reached&&e.maxStep<.45),entrances);
      // 車輪位置の3本の断面を5cm間隔で計測。プレイヤーの60cm段差許容では判定しない。
      const vehicleEntrances=[];
      for(const p of city.parcels.filter(p=>p.refined&&p.hasParking)) {
        const road=roads.streets.find(s=>s.id===p.streetId),c=Math.cos(p.yaw),sn=Math.sin(p.yaw);
        let maxStep=0,maxPhysicsError=0;
        for(const lx of [-1,0,1]) {
          const s=roads.at(road,p.along+lx*p.side),r=road.width/2;
          const a={x:s.x+s.dz*p.side*r,z:s.z-s.dx*p.side*r},b={x:p.x+lx*c+p.d/2*sn,z:p.z-lx*sn+p.d/2*c};
          const length=Math.hypot(b.x-a.x,b.z-a.z),steps=Math.ceil((length+.3)/.05);
          let previous=null;
          for(let i=0;i<=steps;i++) {
            const t=(-.15+(length+.3)*i/steps)/length,x=a.x+(b.x-a.x)*t,z=a.z+(b.z-a.z)*t,h=city.terrain.heightAt(x,z);
            if(previous!==null)maxStep=Math.max(maxStep,Math.abs(h-previous));previous=h;
            const physics=pe.raycast(new V(x,h+.06,z),new V(x,h-.12,z));
            maxPhysicsError=Math.max(maxPhysicsError,physics.hasHit?Math.abs(physics.hitPointWorld.y-h):999);
          }
        }
        vehicleEntrances.push({parcel:p.id,width:p.entryWidth,maxStep,maxPhysicsError});
      }
      check('vehicle-wheel-tracks-have-no-curb-lip',vehicleEntrances.every(e=>e.width>=3.4&&e.maxStep<.015&&e.maxPhysicsError<.02)&&(roads.streets.length===8||vehicleEntrances.length>0),vehicleEntrances);
      const apt=city.buildings.find(b=>b.asset?.id==='tokyo_small_apartment_001');
      if(apt) {
        const a=apt.asset,c=Math.cos(a.yaw),s=Math.sin(a.yaw),world=(x,z)=>({x:a.x+x*c+z*s,z:a.z-x*s+z*c});
        const start=world(6.75,1.8);reset(start.x,start.z);
        let reached=true;
        for(const [x,z] of [[6.75,-4.55],[5.55,-4.55],[5.55,.75],[0,.75]]) {
          const target=world(x,z);let guard=0;
          while(Math.hypot(target.x-g.player.position.x,target.z-g.player.position.z)>.16&&guard++<400) {
            g.camYaw=Math.atan2(target.x-g.player.position.x,target.z-g.player.position.z);step({moveY:.5});
          }
          if(guard>=400){reached=false;break;}
        }
        check('apartment-exterior-stair-and-corridor',reached&&Math.abs(g.player.position.y-a.y-3.1)<.03,{reached,expected:a.y+3.1,actual:g.player.position.y,position:g.player.position.asArray()});
      }
      // 各フレームで移動2軸＋射撃＋照準＋ズーム、ジャンプ・回避・切替・装填を重ねる固定トレース。
      reset(-29,-17);g.time=0;seed=9017;g.camYaw=Math.PI/2;
      const trace=[];
      for(let frame=0;frame<420;frame++) {
        const edges={45:'jump',160:'roll',245:'switch',300:'reload',360:'switch'};
        if(edges[frame])input.press(edges[frame]);
        step({moveX:frame<100?.6:frame<240?-.35:0,moveY:frame<340?.8:0,fire:frame<145||frame>365,zoom:frame>70&&frame<130,dash:frame>170&&frame<240,lookDX:frame<145?.0012:0,lookDY:frame<60?.0002:0});
        if(frame%30===0)trace.push({frame,pos:g.player.position.asArray().map(x=>+x.toFixed(5)),state:g.player.state,weapon:g.player.current,ammo:g.player.weapons.map(w=>w.ammo),grounded:g.player.grounded});
      }
      check('simultaneous-inputs-finite',trace.every(t=>t.pos.every(Number.isFinite)),{frames:420,trace});
      check('firing-path-used',g.player.weapons[0].ammo<150,{ammo:g.player.weapons.map(w=>w.ammo)});
      // 坂で落としたアイテムの接地。
      const ip=roads.at(roads.streets.find(s=>s.id==='shopping-east'),35);
      reset(-52,-18);g.pickups.drop(new V(ip.x,ip.y+4,ip.z));
      for(let i=0;i<360;i++)step();
      const item=g.pickups.items.at(-1),itemGap=item?Math.abs(item.pos.y-city.heightAt(item.pos.x,item.pos.z,item.pos.y)-.5):999;
      check('pickup-rests-on-slope',itemGap<.02,{itemGap});
      // 坂でラグドール化し、Havokで落下した後に同じ地面へ復帰。
      reset(ip.x,ip.z);g.player.knockImmune=0;g.player.knockdown(new V(0,0,0),1);
      for(let i=0;i<300;i++)step();
      const recoveryGap=Math.abs(g.player.position.y-city.heightAt(g.player.position.x,g.player.position.z,g.player.position.y));
      check('ragdoll-recovers-on-slope',g.player.state==='normal'&&recoveryGap<.05,{state:g.player.state,recoveryGap});
      reset(-52,-18);g.enemies.spawnGroup({type:'ant',count:2,at:[ip.x,ip.z],spread:.5},1);
      let enemyGap=0;
      for(let i=0;i<180;i++) {
        step();
        for(const e of g.enemies.list)if(!e.airborne&&e.climbing===0)enemyGap=Math.max(enemyGap,Math.abs(e.position.y-city.heightAt(e.position.x,e.position.z,e.position.y)));
      }
      const falling=g.enemies.list[0];falling.position.set(ip.x,ip.y+6,ip.z);falling.vel.setAll(0);falling.airborne=true;
      for(let i=0;i<240&&falling.airborne;i++)step();
      check('enemies-and-airborne-landing-use-slope',enemyGap<.035&&!falling.airborne,{enemyGap,landed:!falling.airborne});
      for(const e of g.enemies.list)e.root.setEnabled(false);g.enemies.list=[];
      // 実際の武器の命中・敵死亡・アイテム経路を確認。
      reset(-45,-17);g.player.current=0;g.player.weapons[0].ammo=150;g.player.weapons[0].reloading=false;g.player.switchT=0;
      g.enemies.spawnGroup({type:'ant',count:1,at:[-28,-17],spread:0},1);
      const killsBefore=g.enemies.killed;
      for(let i=0;i<600&&g.enemies.aliveCount;i++) {
        const enemy=g.enemies.list.find(e=>e.alive),target=enemy.center(),delta=target.subtract(g.player.chest);
        g.camYaw=Math.atan2(delta.x,delta.z);g.camPitch=-Math.atan2(delta.y,Math.hypot(delta.x,delta.z));g.camRecoil=0;step({fire:true});
      }
      check('weapon-kills-enemy',g.enemies.killed>killsBefore,{kills:g.enemies.killed-killsBefore,remaining:g.enemies.aliveCount,ammo:g.player.weapon.ammo});
      const target=city.buildings.filter(b=>b.asset).sort((a,b)=>b.baseY-a.baseY)[0];
      const oldBase=target.baseY;g.explode({pos:new V(target.cx,oldBase+2,target.cz),radius:5,damage:1000000,buildingDamage:1000000,knockback:0,source:'enemy'});
      for(let i=0;i<240;i++)step();
      const wreck=g.assets.placements.find(p=>p.wrecked&&p.def.id===target.asset.id);
      check('collapse-removes-body',target.state==='gone'&&target.body===null,{state:target.state});
      check('wreck-keeps-site-height',!!wreck&&Math.abs(wreck.root.position.y-target.asset.y)<.001,{expected:target.asset.y,actual:wreck?.root.position.y});
      g.camera.position.set(target.cx+24,oldBase+14,target.cz+25);g.camera.setTarget(new V(target.cx,oldBase+3,target.cz));g.assets.update(1,g.camera.position);g.scene.render();
      return {run,checks,failures,trace,walks,parcels:city.parcels.length,roadCount:roads.streets.length,buildings:city.buildings.length};
    },run);
    results.push(report);await page.screenshot({path:path.join(out,`collapse-${run+1}.png`)});
    await fs.writeFile(path.join(out,`run-${run+1}.json`),JSON.stringify(report,null,2));
    await page.close();console.log('run',run+1,report.failures.length?'FAIL '+report.failures.join(', '):'PASS');
  }
  const deterministic=JSON.stringify(results[0].trace)===JSON.stringify(results[1].trace);
  const report={pilot,seed:726146,dt:1/60,browser:browser.version(),deterministic,errors,results};
  await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({deterministic,errors,failures:results.map(r=>r.failures)},null,2));
  assert.equal(errors.length,0);assert(deterministic,'fixed input replay differs');assert(results.every(r=>r.failures.length===0),'neighborhood checks failed');
} finally {await browser.close();await server.close();}
