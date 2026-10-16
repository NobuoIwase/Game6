import { NODES, DISTRICT_NODES, PILOT_STREETS, DISTRICT_STREETS, type RoadPoint, type StreetDef } from "../data/neighborhood";

export interface RoadSample { x: number; y: number; z: number; dx: number; dz: number; distance: number }
export interface Street extends StreetDef { samples: RoadSample[]; length: number }
export interface RoadProjection { street: Street; x: number; y: number; z: number; distance: number; along: number; dx: number; dz: number }
export interface Parcel { id: string; x: number; z: number; y: number; yaw: number; w: number; d: number; assetId: string; use: "house" | "apartment" | "estate" | "company" | "shop" | "arcade" | "parking"; streetId: string; along: number }

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const cubic = (a: number, b: number, c: number, d: number, t: number) => .5 * ((2*b) + (-a+c)*t + (2*a-5*b+4*c-d)*t*t + (-a+3*b-3*c+d)*t*t*t);

export class RoadNetwork {
  readonly nodes = { ...NODES, ...DISTRICT_NODES };
  readonly streets: Street[];
  constructor(pilot = false) {
    this.streets = [...PILOT_STREETS, ...(pilot ? [] : DISTRICT_STREETS)].map(def => {
      const knots = [this.nodes[def.from], ...def.via, this.nodes[def.to]];
      const samples: RoadSample[] = [];
      let distance = 0;
      for (let j=0; j<knots.length-1; j++) {
        const a=knots[Math.max(0,j-1)], b=knots[j], c=knots[j+1], d=knots[Math.min(knots.length-1,j+2)];
        const steps = Math.ceil(Math.hypot(c[0]-b[0],c[2]-b[2])/1.5);
        for(let k=0; k<steps; k++) {
          const t=k/steps, x=cubic(a[0],b[0],c[0],d[0],t), z=cubic(a[2],b[2],c[2],d[2],t);
          const prev=samples.at(-1);
          if(prev) distance+=Math.hypot(x-prev.x,z-prev.z);
          samples.push({x, y:b[1]+(c[1]-b[1])*t, z, dx:0, dz:0, distance});
        }
      }
      const end=knots.at(-1)!, prev=samples.at(-1)!;
      distance+=Math.hypot(end[0]-prev.x,end[2]-prev.z);
      samples.push({x:end[0],y:end[1],z:end[2],dx:0,dz:0,distance});
      samples.forEach((s,i)=>{const a=samples[Math.max(0,i-1)], b=samples[Math.min(samples.length-1,i+1)]; const n=Math.hypot(b.x-a.x,b.z-a.z); s.dx=(b.x-a.x)/n;s.dz=(b.z-a.z)/n;});
      return {...def,samples,length:distance};
    });
  }
  at(street: Street, distance: number): RoadSample {
    const i = Math.max(1, street.samples.findIndex(s=>s.distance>=clamp(distance,0,street.length)));
    const a=street.samples[i-1],b=street.samples[i], t=clamp((distance-a.distance)/(b.distance-a.distance),0,1);
    const dx=a.dx*(1-t)+b.dx*t,dz=a.dz*(1-t)+b.dz*t, len=Math.hypot(dx,dz);
    return {x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t,dx:dx/len,dz:dz/len,distance};
  }
  nearest(x: number, z: number, exclude?: string): RoadProjection | null {
    let best: RoadProjection|null=null, best2=Infinity;
    for(const street of this.streets) {
      if(street.id===exclude) continue;
      for(let i=1;i<street.samples.length;i++) {
        const a=street.samples[i-1],b=street.samples[i],dx=b.x-a.x,dz=b.z-a.z,l2=dx*dx+dz*dz;
        const t=clamp(((x-a.x)*dx+(z-a.z)*dz)/l2,0,1), px=a.x+dx*t,pz=a.z+dz*t,d2=(x-px)**2+(z-pz)**2;
        if(d2>=best2)continue;
        best2=d2;const len=Math.sqrt(l2);
        best={street,x:px,y:a.y+(b.y-a.y)*t,z:pz,distance:Math.sqrt(d2),along:a.distance+len*t,dx:dx/len,dz:dz/len};
      }
    }
    return best;
  }
  // 地形の素地。道路際では中心線の標高へ切盛りし、奥ではなだらかな丘へ戻す。
  elevation(x: number, z: number): number {
    const natural = Math.max(0, (x+45)*.034) + Math.max(0,z-30)*.012;
    const p=this.nearest(x,z);
    if(!p)return natural;
    const edge=p.street.width/2+p.street.sidewalk;
    const t=clamp((p.distance-edge)/12,0,1), k=t*t*(3-2*t);
    return (p.y-.09)*(1-k)+natural*k;
  }
  // 除外道路を与えて迂回路の接続と長さを検証する。
  route(from: string,to: string,excluded: string[]=[]): { length: number; streets: string[] } | null {
    const dist=new Map([[from,0]]),prev=new Map<string,{node:string;street:string}>(),todo=new Set(Object.keys(this.nodes));
    while(todo.size) {
      const at=[...todo].sort((a,b)=>(dist.get(a)??Infinity)-(dist.get(b)??Infinity))[0];todo.delete(at);
      if(!Number.isFinite(dist.get(at)))break;
      if(at===to)break;
      for(const s of this.streets) {
        if(excluded.includes(s.id))continue;
        const next=s.from===at?s.to:s.to===at?s.from:null;
        if(!next)continue;
        const d=dist.get(at)!+s.length;
        if(d<(dist.get(next)??Infinity)){dist.set(next,d);prev.set(next,{node:at,street:s.id});}
      }
    }
    if(!dist.has(to))return null;
    const streets:string[]=[];let at=to;
    while(at!==from){const p=prev.get(at)!;streets.unshift(p.street);at=p.node;}
    return {length:dist.get(to)!,streets};
  }
}

export function parcelLocal(p: Pick<Parcel,"x"|"z"|"yaw">,x:number,z:number) {
  const c=Math.cos(p.yaw),s=Math.sin(p.yaw),dx=x-p.x,dz=z-p.z;
  return {x:dx*c-dz*s,z:dx*s+dz*c};
}
export function parcelWorld(p: Pick<Parcel,"x"|"z"|"yaw">,x:number,z:number) {
  const c=Math.cos(p.yaw),s=Math.sin(p.yaw);
  return {x:p.x+x*c+z*s,z:p.z-x*s+z*c};
}
export function parcelCorners(p: Pick<Parcel,"x"|"z"|"yaw"|"w"|"d">,padding=0): RoadPoint[] {
  return [[-1,-1],[1,-1],[1,1],[-1,1]].map(([sx,sz])=>{const q=parcelWorld(p,sx*(p.w/2+padding),sz*(p.d/2+padding));return [q.x,0,q.z];});
}
export function parcelsOverlap(a: Parcel,b: Parcel,gap=1): boolean {
  const ac=parcelCorners(a,gap/2),bc=parcelCorners(b,gap/2);
  for(const yaw of [a.yaw,b.yaw])for(const [x,z] of [[Math.cos(yaw),-Math.sin(yaw)],[Math.sin(yaw),Math.cos(yaw)]]) {
    const aa=ac.map(p=>p[0]*x+p[2]*z),bb=bc.map(p=>p[0]*x+p[2]*z);
    if(Math.max(...aa)<Math.min(...bb)||Math.max(...bb)<Math.min(...aa))return false;
  }
  return true;
}
