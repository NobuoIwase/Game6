import { COMMUNITY_SPACES, type RoadPoint } from "../data/neighborhood";
import { RoadNetwork, parcelLocal, type Parcel } from "./RoadNetwork";

export interface CommunitySpace { id:string;x:number;z:number;w:number;d:number;use:string;paths:RoadPoint[][] }

// 敷地を横切らず、二つの近隣道路へ接続する。格子探索の結果は見通せる区間で簡約する。
export function makeCommunitySpaces(network:RoadNetwork,parcels:Parcel[]):CommunitySpace[] {
  const free=(x:number,z:number)=>!parcels.some(p=>{
    if(Math.abs(x-p.x)>p.w+p.d||Math.abs(z-p.z)>p.w+p.d)return false;
    const q=parcelLocal(p,x,z);return Math.abs(q.x)<p.w/2+1.65&&Math.abs(q.z)<p.d/2+1.65;
  });
  const clear=(a:RoadPoint,b:RoadPoint)=>{
    const steps=Math.ceil(Math.hypot(a[0]-b[0],a[2]-b[2])/.6);
    for(let i=0;i<=steps;i++){const t=i/(steps||1);if(!free(a[0]+(b[0]-a[0])*t,a[2]+(b[2]-a[2])*t))return false;}return true;
  };
  const result:CommunitySpace[]=[];
  for(const def of COMMUNITY_SPACES) {
    if(!free(def.x,def.z))continue;
    const streets=[...network.streets].sort((a,b)=>Math.min(...a.samples.map(s=>Math.hypot(s.x-def.x,s.z-def.z)))-Math.min(...b.samples.map(s=>Math.hypot(s.x-def.x,s.z-def.z))));
    const paths:RoadPoint[][]=[];
    for(const street of streets.slice(0,5)) {
      const targets=street.samples.filter(s=>Math.hypot(s.x-def.x,s.z-def.z)<90&&paths.every(p=>Math.hypot(s.x-p.at(-1)![0],s.z-p.at(-1)![2])>12));
      if(!targets.length)continue;
      const clearRoute=(a:RoadPoint,b:RoadPoint)=>{
        if(!clear(a,b))return false;
        const steps=Math.ceil(Math.hypot(a[0]-b[0],a[2]-b[2])/.6);
        for(let i=0;i<=steps;i++) {
          const t=i/(steps||1),x=a[0]+(b[0]-a[0])*t,z=a[2]+(b[2]-a[2])*t;
          if(paths.length&&Math.abs(x-def.x)<def.w/2+3&&Math.abs(z-def.z)<def.d/2+3&&Math.hypot(x-def.x,z-def.z)>3.5&&distanceToCommunityPaths({...def,paths},x,z)<2.6)return false;
        }
        return true;
      };
      const queue:[number,number][]=[[0,0]],parents=new Map<string,string|null>([["0,0",null]]);
      let finish:string|null=null,end:RoadPoint|null=null;
      for(let head=0;head<queue.length&&head<6500;head++) {
        const [ix,iz]=queue[head],x=def.x+ix*2,z=def.z+iz*2,key=ix+","+iz;
        const target=targets.find(t=>Math.hypot(x-t.x,z-t.z)<street.width/2-.15&&clearRoute([x,0,z],[t.x,0,t.z]));
        if(target){finish=key;end=[target.x,target.y,target.z];break;}
        for(const [dx,dz] of [[1,0],[0,1],[-1,0],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]]) {
          const nx=ix+dx,nz=iz+dz,nk=nx+","+nz;
          if(Math.abs(nx)>46||Math.abs(nz)>46||parents.has(nk)||!clearRoute([x,0,z],[def.x+nx*2,0,def.z+nz*2]))continue;
          parents.set(nk,key);queue.push([nx,nz]);
        }
      }
      if(!finish||!end)continue;
      const raw:RoadPoint[]=[end];
      for(let key:string|null=finish;key;key=parents.get(key)??null){const [x,z]=key.split(",").map(Number);raw.push([def.x+x*2,0,def.z+z*2]);}
      raw.reverse();const path:RoadPoint[]=[raw[0]];
      for(let i=0;i<raw.length-1;) {let j=raw.length-1;while(j>i+1&&!clearRoute(raw[i],raw[j]))j--;path.push(raw[j]);i=j;}
      paths.push(path);if(paths.length===2)break;
    }
    if(paths.length)result.push({...def,paths});
  }
  return result;
}

export function distanceToCommunityPaths(space:CommunitySpace,x:number,z:number) {
  let best=Infinity;
  for(const path of space.paths)for(let i=1;i<path.length;i++) {
    const a=path[i-1],b=path[i],dx=b[0]-a[0],dz=b[2]-a[2],t=Math.max(0,Math.min(1,((x-a[0])*dx+(z-a[2])*dz)/(dx*dx+dz*dz)));
    best=Math.min(best,Math.hypot(x-a[0]-t*dx,z-a[2]-t*dz));
  }
  return best;
}
