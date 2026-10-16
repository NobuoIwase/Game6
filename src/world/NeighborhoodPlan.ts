import { BUILDING_PALETTES, type RoadPoint } from "../data/neighborhood";
import type { AssetDef } from "./AssetLibrary";
import { RoadNetwork, parcelCorners, parcelLocal, parcelWorld, parcelsOverlap, type Parcel, type RoadSample, type Street } from "./RoadNetwork";
import { Terrain, type SurfaceKind } from "./Terrain";

const hash=(s:string)=>{let n=2166136261;for(const c of s)n=Math.imul(n^c.charCodeAt(0),16777619);return n>>>0;};
export const inCentralPark=(x:number,z:number)=>((x+12)/34)**2+((z-23)/26)**2<1;
export function makeParcels(network:RoadNetwork,defs:AssetDef[],pilot:boolean):Parcel[] {
  const parcels:Parcel[]=[],catalog=new Map(defs.map(d=>[d.id,d]));
  for(const street of network.streets) {
    if(street.kind==="park")continue;
    for(const side of [-1,1]) {
      let along=11+hash(street.id+side)%7,order=0;
      while(along<street.length-10) {
        const key=street.id+":"+side+":"+order++,n=hash(key),s=network.at(street,along);
        let use:Parcel["use"]=street.kind==="main" ? (["company","shop","apartment","arcade"] as const)[n%4] : "house";
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
        const w=use==="parking"?12:bw+(use==="shop"?2:3.5),d=use==="parking"?14:bd+(use==="shop"?5:7);
        const nx=s.dz*side,nz=-s.dx*side,off=street.width/2+street.sidewalk+d/2+.8;
        const p:Parcel={id:key,x:s.x+nx*off,z:s.z+nz*off,y:s.y+.14,yaw:Math.atan2(-nx,-nz),w,d,assetId:id,use,streetId:street.id,along};
        const corners=parcelCorners(p);
        const allowed=corners.every(c=>Math.abs(c[0])<(pilot?83:194)&&Math.abs(c[2])<(pilot?83:194)&&!inCentralPark(c[0],c[2])&&!inCentralPark(p.x,p.z));
        // 道路の全サンプルを敷地座標で照合。四隅だけでは敷地中央を横切る路地を見落とす。
        const clearRoads=network.streets.every(road=>road.samples.every(q=>{
          if(Math.abs(q.x-p.x)>w+d+12||Math.abs(q.z-p.z)>w+d+12)return true;
          const local=parcelLocal(p,q.x,q.z),dx=Math.max(0,Math.abs(local.x)-w/2),dz=Math.max(0,Math.abs(local.z)-d/2);
          return Math.hypot(dx,dz)>road.width/2+road.sidewalk+.15;
        }));
        if(allowed&&clearRoads&&!parcels.some(q=>parcelsOverlap(p,q,1.6))) {
          parcels.push(p);along+=w+3+(n%5);
        } else along+=5.5;
      }
    }
  }
  return parcels;
}

export function makeTerrain(network:RoadNetwork,parcels:Parcel[]) {
  const terrain=new Terrain(network,parcels);terrain.generateGround();
  const point=(s:RoadSample,offset:number,lift:number):RoadPoint=>[s.x+s.dz*offset,s.y+lift,s.z-s.dx*offset];
  const strip=(a:RoadSample,b:RoadSample,lo:number,hi:number,lift:number,kind:SurfaceKind)=>terrain.quad(point(a,lo,lift),point(b,lo,lift),point(b,hi,lift),point(a,hi,lift),kind);
  const inJunction=(s:RoadSample,street:Street,offset=0)=>{
    const p=point(s,offset,0),n=network.nearest(p[0],p[2],street.id);
    return !!n&&n.distance<n.street.width/2+.8;
  };
  for(const street of network.streets) {
    const r=street.width/2;
    for(let i=1;i<street.samples.length;i++) {
      const a=street.samples[i-1],b=street.samples[i],mid=network.at(street,(a.distance+b.distance)/2);
      strip(a,b,-r,r,.025,street.kind==="park"?"path":"road");
      if(street.kind==="park")continue;
      for(const side of [-1,1]) {
        if(inJunction(mid,street,side*(r+.3)))continue;
        const driveway=parcels.some(p=>p.streetId===street.id&&Math.abs(p.along-mid.distance)<2.9&&((p.x-mid.x)*mid.dz-(p.z-mid.z)*mid.dx)*side>0);
        if(street.sidewalk&&!driveway) {
          strip(a,b,side*r,side*(r+street.sidewalk),.15,"sidewalk");
          // 連続縁石の立面。切下げ・交差点では開ける。
          const edge=[point(a,side*r,.025),point(a,side*r,.15),point(b,side*r,.15),point(b,side*r,.025)];
          terrain.quad(edge[0],edge[1],edge[2],edge[3],"sidewalk");
          terrain.quad(edge[3],edge[2],edge[1],edge[0],"sidewalk");
        }
        // 排水帯は路端にのみ置く。出入口では格子蓋付きへつながる。
        strip(a,b,side*(r-.21),side*(r-.04),.033,"drain");
      }
      if(street.kind==="main"&&Math.floor(mid.distance/6)%2===0&&!inJunction(mid,street))strip(a,b,-.055,.055,.041,"marking");
    }
  }
  for(const p of parcels) {
    const rect=(x0:number,z0:number,x1:number,z1:number,y:number,kind:SurfaceKind)=>{
      const ps=[[x0,z0],[x0,z1],[x1,z1],[x1,z0]].map(([x,z])=>{const q=parcelWorld(p,x,z);return[q.x,y,q.z] as RoadPoint;});
      terrain.quad(ps[0],ps[1],ps[2],ps[3],kind);
    };
    rect(-p.w/2,-p.d/2,p.w/2,p.d/2,p.y+(p.use==="parking"?.012:.005),p.use==="parking"?"gravel":"grass");
    rect(-p.w/2+.3,p.d/2-4.8,p.w/2-.3,p.d/2,p.y+.015,"gravel");
    const street=network.streets.find(s=>s.id===p.streetId)!;
    const ramp=[[-2.7,p.d/2],[-2.7,p.d/2+street.sidewalk+.8],[2.7,p.d/2+street.sidewalk+.8],[2.7,p.d/2]].map(([x,z],i)=>{const q=parcelWorld(p,x,z),road=network.nearest(q.x,q.z)!;return[q.x,i===1||i===2?road.y+.026:p.y+.016,q.z] as RoadPoint;});
    terrain.quad(ramp[0],ramp[1],ramp[2],ramp[3],"sidewalk");
    if(p.use==="parking") {
      for(let x=-4.8;x<=4.8;x+=2.4)rect(x,-p.d/2+.6,x+.07,-p.d/2+5.4,p.y+.025,"marking");
    } else if(p.use!=="shop"&&p.use!=="arcade") {
      // 2.3mの駐車枠は各敷地の前庭だけに置く。
      rect(.15,p.d/2-4.4,.23,p.d/2-.4,p.y+.025,"marking");
      rect(2.45,p.d/2-4.4,2.53,p.d/2-.4,p.y+.025,"marking");
    }
  }
  return terrain;
}
