import { BUILDING_PALETTES, type RoadPoint } from "../data/neighborhood";
import type { AssetDef } from "./AssetLibrary";
import { RoadNetwork, parcelCorners, parcelLocal, parcelWorld, parcelsOverlap, type Parcel, type RoadSample, type Street } from "./RoadNetwork";
import { Terrain, type SurfaceKind } from "./Terrain";
import type { CommunitySpace } from "./CommunitySpaces";

const hash=(s:string)=>{let n=2166136261;for(const c of s)n=Math.imul(n^c.charCodeAt(0),16777619);return n>>>0;};
export const inCentralPark=(x:number,z:number)=>((x+12)/34)**2+((z-23)/26)**2<1;
export function makeParcels(network:RoadNetwork,defs:AssetDef[],pilot:boolean,mode="full"):Parcel[] {
  const parcels:Parcel[]=[],catalog=new Map(defs.map(d=>[d.id,d]));
  const ordered=[...network.streets].sort((a,b)=>Number(["garden-slope","west-shopping"].includes(b.id))-Number(["garden-slope","west-shopping"].includes(a.id)));
  for(const street of ordered) {
    if(street.kind==="park")continue;
    const refined=mode==="full"||mode==="sample"&&["garden-slope","west-shopping"].includes(street.id);
    for(const side of [-1,1]) {
      let along=refined?8:11+hash(street.id+side)%7,order=0;
      while(along<street.length-10) {
        const key=street.id+":"+side+":"+order++,n=hash(key),s=network.at(street,along);
        let use:Parcel["use"]=street.kind==="main" ? (["company","shop","apartment","arcade"] as const)[n%4] : "house";
        if(refined&&street.kind==="main")use=(["shop","shop","house","shop","company","apartment","shop","arcade"] as const)[n%8];
        if(s.z>90&&s.x>25)use="estate";
        else if(street.kind!=="main"&&n%7===0)use="apartment";
        if(use==="arcade"&&parcels.some(p=>p.use==="arcade"))use="shop";
        if(!pilot&&n%31===0&&parcels.filter(p=>p.use==="parking").length<4)use="parking";
        const pool=BUILDING_PALETTES[use==="arcade"||use==="parking"?"house":use];
        let id=use==="arcade"&&catalog.has("tokyo_arcade_001")?"tokyo_arcade_001":use==="arcade"?"building_023":pool[n%pool.length];
        if(use==="parking")id="parking-lot";
        if(use==="apartment"&&catalog.has("tokyo_small_apartment_001")&&n%3!==0)id="tokyo_small_apartment_001";
        const def=catalog.get(id),box=def?.states.normal;
        const bw=box?box.max[0]-box.min[0]:8,bd=box?box.max[2]-box.min[2]:9;
        const hasParking=use==="parking"||use==="house"&&n%3===0;
        const front=refined?(hasParking?5:use==="shop"?1.2:use==="house"?1.7:2.6):5;
        const back=refined?(use==="house"?2.8:use==="estate"?4:1.6):2;
        const w=use==="parking"?12:bw+(refined?(use==="shop"?.7:1.3):(use==="shop"?2:3.5)),d=use==="parking"?14:bd+front+back;
        // 前後の空地に用途を持たせ、建物を店先または玄関前まで寄せる。
        const setback=refined?(hasParking?1.5:.45):.8,bodyZ=refined?(back-front)/2:-1.5;
        const centerAlong=refined?along+w/2:along,q=network.at(street,centerAlong);
        const nx=q.dz*side,nz=-q.dx*side,off=street.width/2+street.sidewalk+d/2+setback;
        const entryWidth=refined?(use==="parking"?5.4:hasParking?3.5:use==="shop"||use==="arcade"?Math.min(w-.6,6):2.2):5.4;
        const p:Parcel={id:key,x:q.x+nx*off,z:q.z+nz*off,y:q.y+.14,yaw:Math.atan2(-nx,-nz),w,d,assetId:id,use,streetId:street.id,along:centerAlong,side,refined,front,back,bodyZ,setback,entryWidth,hasParking};
        const corners=parcelCorners(p);
        const allowed=corners.every(c=>Math.abs(c[0])<(pilot?83:194)&&Math.abs(c[2])<(pilot?83:194)&&!inCentralPark(c[0],c[2])&&!inCentralPark(p.x,p.z));
        // 道路の全サンプルを敷地座標で照合。四隅だけでは敷地中央を横切る路地を見落とす。
        const clearRoads=network.streets.every(road=>road.samples.every(q=>{
          if(Math.abs(q.x-p.x)>w+d+12||Math.abs(q.z-p.z)>w+d+12)return true;
          const local=parcelLocal(p,q.x,q.z),dx=Math.max(0,Math.abs(local.x)-w/2),dz=Math.max(0,Math.abs(local.z)-d/2);
          return Math.hypot(dx,dz)>road.width/2+road.sidewalk+.15;
        }));
        if(allowed&&clearRoads&&!parcels.some(q=>parcelsOverlap(p,q,refined?.25:1.6))) {
          parcels.push(p);along+=refined?w+.25:w+3+(n%5);
        } else along+=refined?1.5:5.5;
      }
    }
  }
  return parcels;
}

export function makeTerrain(network:RoadNetwork,parcels:Parcel[],spaces:CommunitySpace[]=[]) {
  const terrain=new Terrain(network,parcels);terrain.generateGround();
  const point=(s:RoadSample,offset:number,lift:number):RoadPoint=>[s.x+s.dz*offset,s.y+lift,s.z-s.dx*offset];
  const strip=(a:RoadSample,b:RoadSample,lo:number,hi:number,lift:number,kind:SurfaceKind)=>terrain.quad(point(a,lo,lift),point(b,lo,lift),point(b,hi,lift),point(a,hi,lift),kind);
  const inJunction=(s:RoadSample,street:Street,offset=0)=>{
    const p=point(s,offset,0),n=network.nearest(p[0],p[2],street.id);
    return !!n&&n.distance<n.street.width/2+.8;
  };
  for(const street of network.streets) {
    const r=street.width/2;
    const sites=parcels.filter(p=>p.streetId===street.id);
    // 切下げと縁石は同じ分割点を使い、開口に半端な縁石を残さない。
    const breaks=[...street.samples.map(s=>s.distance),...sites.filter(p=>p.refined).flatMap(p=>[p.along-p.entryWidth/2,p.along+p.entryWidth/2])];
    const samples=[...new Set(breaks.filter(d=>d>=0&&d<=street.length).map(d=>+d.toFixed(6)))].sort((a,b)=>a-b).map(d=>network.at(street,d));
    for(let i=1;i<samples.length;i++) {
      const a=samples[i-1],b=samples[i],mid=network.at(street,(a.distance+b.distance)/2);
      strip(a,b,-r,r,.025,street.kind==="park"?"path":"road");
      if(street.kind==="park")continue;
      for(const side of [-1,1]) {
        if(inJunction(mid,street,side*(r+.3)))continue;
        const entrance=sites.find(p=>p.side===side&&Math.abs(p.along-mid.distance)<(p.refined?p.entryWidth/2:2.9));
        const driveway=!!entrance;
        if(entrance?.refined) {
          const inner=(s:RoadSample):RoadPoint=>{const q=parcelWorld(entrance,(s.distance-entrance.along)*side,entrance.d/2);return[q.x,entrance.y+.015,q.z];};
          terrain.quad(point(a,side*r,.025),point(b,side*r,.025),inner(b),inner(a),"sidewalk");
        }
        if(street.sidewalk&&!driveway) {
          strip(a,b,side*r,side*(r+street.sidewalk),.15,"sidewalk");
          // 連続縁石の立面。切下げ・交差点では開ける。
          const edge=[point(a,side*r,.025),point(a,side*r,.15),point(b,side*r,.15),point(b,side*r,.025)];
          terrain.quad(edge[0],edge[1],edge[2],edge[3],"sidewalk");
          terrain.quad(edge[3],edge[2],edge[1],edge[0],"sidewalk");
        }
        // 排水帯は路端にのみ置く。出入口では格子蓋付きへつながる。
        strip(a,b,side*(r-.21),side*(r-.04),.026,"drain");
      }
      if(street.kind==="main"&&Math.floor(mid.distance/6)%2===0&&!inJunction(mid,street))strip(a,b,-.055,.055,.041,"marking");
    }
  }
  for(const p of parcels) {
    const rect=(x0:number,z0:number,x1:number,z1:number,y:number,kind:SurfaceKind)=>{
      const ps=[[x0,z0],[x0,z1],[x1,z1],[x1,z0]].map(([x,z])=>{const q=parcelWorld(p,x,z);return[q.x,y,q.z] as RoadPoint;});
      terrain.quad(ps[0],ps[1],ps[2],ps[3],kind);
    };
    rect(-p.w/2,-p.d/2,p.w/2,p.d/2,p.y+.012,p.refined||p.use==="parking"?"gravel":"grass");
    rect(-p.w/2+.12,p.d/2-p.front,p.w/2-.12,p.d/2,p.y+.015,"sidewalk");
    if(p.refined&&p.use==="house") {
      // 裏庭と小さな前庭だけを緑にし、脇の通路と玄関への動線を空ける。
      rect(-p.w/2+.45,-p.d/2+.4,p.w/2-.45,-p.d/2+p.back-.3,p.y+.019,"grass");
      if(!p.hasParking)for(const side of [-1,1]) {
        const lo=side<0?-p.w/2+.45:p.entryWidth/2+.35,hi=side<0?-p.entryWidth/2-.35:p.w/2-.45;
        if(hi-lo>.4)rect(lo,p.d/2-p.front+.15,hi,p.d/2-.35,p.y+.019,"grass");
      }
    }
    const street=network.streets.find(s=>s.id===p.streetId)!;
    if(p.refined)for(const [lo,hi] of [[-p.w/2,-p.entryWidth/2],[p.entryWidth/2,p.w/2]]) {
      const distances=[lo,hi,...street.samples.map(s=>(s.distance-p.along)*p.side).filter(x=>x>lo&&x<hi)].sort((a,b)=>a-b);
      const edge=(x:number,inner:boolean):RoadPoint=>{
        if(inner){const q=parcelWorld(p,x,p.d/2);return[q.x,p.y+.015,q.z];}
        const s=network.at(street,p.along+x*p.side);return point(s,p.side*(street.width/2+street.sidewalk),street.sidewalk?.15:.025);
      };
      for(let i=1;i<distances.length;i++)terrain.quad(edge(distances[i-1],false),edge(distances[i],false),edge(distances[i],true),edge(distances[i-1],true),"sidewalk");
    }
    const ramp=[[-2.7,p.d/2],[-2.7,p.d/2+street.sidewalk+.8],[2.7,p.d/2+street.sidewalk+.8],[2.7,p.d/2]].map(([x,z],i)=>{const q=parcelWorld(p,x,z),road=network.nearest(q.x,q.z)!;return[q.x,i===1||i===2?road.y+.026:p.y+.016,q.z] as RoadPoint;});
    if(!p.refined)terrain.quad(ramp[0],ramp[1],ramp[2],ramp[3],"sidewalk");
    if(p.use==="parking") {
      for(let x=-4.8;x<=4.8;x+=2.4)rect(x,-p.d/2+.6,x+.07,-p.d/2+5.4,p.y+.025,"marking");
    } else if(!p.refined&&p.use!=="shop"&&p.use!=="arcade"||p.refined&&p.hasParking) {
      // 2.3mの駐車枠は各敷地の前庭だけに置く。
      const shift=p.refined?-1.3:0;
      rect(.15+shift,p.d/2-4.4,.23+shift,p.d/2-.4,p.y+.025,"marking");
      rect(2.45+shift,p.d/2-4.4,2.53+shift,p.d/2-.4,p.y+.025,"marking");
    }
  }
  // 共同利用地と道路への接続路も同じ地形・Havok面を使う。
  const surfaces:{points:RoadPoint[];kind:SurfaceKind}[]=[];
  const at=(x:number,z:number,lift=.018):RoadPoint=>[x,terrain.heightAt(x,z)+lift,z];
  for(const space of spaces) {
    for(let z=space.z-space.d/2;z<space.z+space.d/2;z+=2)for(let x=space.x-space.w/2;x<space.x+space.w/2;x+=2) {
      const x1=Math.min(x+2,space.x+space.w/2),z1=Math.min(z+2,space.z+space.d/2);
      surfaces.push({points:[at(x,z),at(x,z1),at(x1,z1),at(x1,z)],kind:space.use==="garden"?"soil":"path"});
    }
    for(const path of space.paths) {
      for(const p of path)p[1]=terrain.heightAt(p[0],p[2])+.022;
      for(let i=1;i<path.length;i++) {
        const a=path[i-1],b=path[i],len=Math.hypot(b[0]-a[0],b[2]-a[2]),steps=Math.ceil(len),dx=(b[0]-a[0])/len,dz=(b[2]-a[2])/len;
        for(let j=0;j<steps;j++) {
          const points=[[-1,j/steps],[-1,(j+1)/steps],[1,(j+1)/steps],[1,j/steps]].map(([side,t])=>{
            const x=a[0]+dx*len*t+dz*side*1.1,z=a[2]+dz*len*t-dx*side*1.1,road=network.nearest(x,z)!;
            return at(x,z,road.distance<road.street.width/2+road.street.sidewalk+2?.001:.025);
          });
          surfaces.push({points,kind:"sidewalk"});
        }
      }
    }
  }
  for(const {points:p,kind} of surfaces)terrain.quad(p[0],p[1],p[2],p[3],kind);
  return terrain;
}
