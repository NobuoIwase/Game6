import { Mesh, PhysicsBody, PhysicsMotionType, PhysicsShapeMesh, Scene, Vector3, VertexData, type Material } from "@babylonjs/core";
import { COL_ALL, COL_STATIC } from "../core/Physics";
import type { RoadPoint } from "../data/neighborhood";
import { RoadNetwork, parcelLocal, type Parcel } from "./RoadNetwork";

export type SurfaceKind = "grass" | "road" | "sidewalk" | "path" | "gravel" | "marking" | "drain";
interface Triangle { a: RoadPoint; b: RoadPoint; c: RoadPoint; normal: Vector3; den: number; kind: SurfaceKind; base: boolean }

// 描画・高さ・射線・Havokへ同一の三角形を渡す。y=0の隠れた衝突平面は置かない。
export class Terrain {
  readonly triangles: Triangle[] = [];
  readonly meshes: Mesh[] = [];
  private cells = new Map<string, Triangle[]>();
  private readonly cell = 12;
  constructor(readonly network: RoadNetwork, readonly parcels: Parcel[]) {}

  elevation(x: number,z: number) {
    let h=this.network.elevation(x,z);
    for(const p of this.parcels) {
      if(Math.abs(x-p.x)>p.w+p.d||Math.abs(z-p.z)>p.w+p.d)continue;
      const q=parcelLocal(p,x,z), d=Math.max(Math.abs(q.x)-p.w/2,Math.abs(q.z)-p.d/2);
      if(d<1.5) {const k=Math.max(0,Math.min(1,(1.5-d)/1.5));h=h*(1-k)+p.y*k;}
    }
    const road=this.network.nearest(x,z);
    if(road&&road.distance<road.street.width/2+road.street.sidewalk+.3)h=Math.min(h,road.y-.09);
    return h;
  }

  generateGround() {
    const coords:number[]=[];
    for(let x=-600;x<-216;x+=48)coords.push(x);
    for(let x=-216;x<=216;x+=4)coords.push(x);
    for(let x=264;x<=600;x+=48)coords.push(x);
    const rows=coords.map(z=>coords.map(x=>[x,this.elevation(x,z),z] as RoadPoint));
    for(let j=0;j<coords.length-1;j++)for(let i=0;i<coords.length-1;i++)
      this.quad(rows[j][i],rows[j+1][i],rows[j+1][i+1],rows[j][i+1],"grass",true);
  }

  triangle(a:RoadPoint,b:RoadPoint,c:RoadPoint,kind:SurfaceKind,base=false) {
    const den=(b[2]-c[2])*(a[0]-c[0])+(c[0]-b[0])*(a[2]-c[2]);
    const normal=Vector3.Cross(new Vector3(b[0]-a[0],b[1]-a[1],b[2]-a[2]),new Vector3(c[0]-a[0],c[1]-a[1],c[2]-a[2])).normalize();
    if(normal.lengthSquared()<.5)return;
    if(normal.y<0)normal.scaleInPlace(-1);
    const tri={a,b,c,normal,den,kind,base};this.triangles.push(tri);
    if(kind==="marking")return;
    for(let iz=Math.floor(Math.min(a[2],b[2],c[2])/this.cell);iz<=Math.floor(Math.max(a[2],b[2],c[2])/this.cell);iz++)
      for(let ix=Math.floor(Math.min(a[0],b[0],c[0])/this.cell);ix<=Math.floor(Math.max(a[0],b[0],c[0])/this.cell);ix++) {
        const key=ix+","+iz,list=this.cells.get(key)??[];list.push(tri);this.cells.set(key,list);
      }
  }
  quad(a:RoadPoint,b:RoadPoint,c:RoadPoint,d:RoadPoint,kind:SurfaceKind,base=false) {
    this.triangle(a,b,c,kind,base);this.triangle(a,c,d,kind,base);
  }
  private triangleHeight(t:Triangle,x:number,z:number):number|null {
    const {a,b,c,den}=t;
    if(Math.abs(den)<1e-8)return null;
    const u=((b[2]-c[2])*(x-c[0])+(c[0]-b[0])*(z-c[2]))/den;
    const v=((c[2]-a[2])*(x-c[0])+(a[0]-c[0])*(z-c[2]))/den;
    if(u<-.00001||v<-.00001||u+v>1.00001)return null;
    return u*a[1]+v*b[1]+(1-u-v)*c[1];
  }
  heightAt(x:number,z:number,fromY=Infinity) {
    let height=-Infinity;
    for(const t of this.cells.get(Math.floor(x/this.cell)+","+Math.floor(z/this.cell))??[]) {
      const y=this.triangleHeight(t,x,z);
      if(y!==null&&(t.base||y<=fromY+.6))height=Math.max(height,y);
    }
    return height===-Infinity?this.network.elevation(x,z):height;
  }
  raycast(origin:Vector3,dir:Vector3,maxDist:number):{dist:number;point:Vector3;normal:Vector3}|null {
    let ix=Math.floor(origin.x/this.cell),iz=Math.floor(origin.z/this.cell),best=maxDist+1,hit:Triangle|null=null;
    const sx=Math.sign(dir.x),sz=Math.sign(dir.z),dx=sx?this.cell/Math.abs(dir.x):Infinity,dz=sz?this.cell/Math.abs(dir.z):Infinity;
    let tx=sx?((ix+(sx>0?1:0))*this.cell-origin.x)/dir.x:Infinity;
    let tz=sz?((iz+(sz>0?1:0))*this.cell-origin.z)/dir.z:Infinity;
    const seen=new Set<Triangle>();
    const steps=Math.ceil(maxDist*(Math.abs(dir.x)+Math.abs(dir.z))/this.cell)+3;
    for(let k=0;k<steps;k++) {
      for(const t of this.cells.get(ix+","+iz)??[]) {
        if(seen.has(t))continue;seen.add(t);
        const den=Vector3.Dot(t.normal,dir);
        if(Math.abs(den)<1e-10)continue;
        const d=((t.a[0]-origin.x)*t.normal.x+(t.a[1]-origin.y)*t.normal.y+(t.a[2]-origin.z)*t.normal.z)/den;
        if(d<0||d>maxDist||d>=best)continue;
        const point=origin.add(dir.scale(d));
        let inside=this.triangleHeight(t,point.x,point.z)!==null;
        if(Math.abs(t.den)<1e-8) {
          const a=Vector3.FromArray(t.a),ab=Vector3.FromArray(t.b).subtract(a),ac=Vector3.FromArray(t.c).subtract(a),ap=point.subtract(a);
          const aa=Vector3.Dot(ab,ab),bb=Vector3.Dot(ac,ac),cc=Vector3.Dot(ab,ac),dd=Vector3.Dot(ap,ab),ee=Vector3.Dot(ap,ac),det=aa*bb-cc*cc;
          const u=(bb*dd-cc*ee)/det,v=(aa*ee-cc*dd)/det;
          inside=u>=-.00001&&v>=-.00001&&u+v<=1.00001;
        }
        if(inside){best=d;hit=t;}
      }
      const next=Math.min(tx,tz);if(next>maxDist||next>best)break;
      if(tx<=tz){ix+=sx;tx+=dx;}else{iz+=sz;tz+=dz;}
    }
    return hit?{dist:best,point:origin.add(dir.scale(best)),normal:hit.normal.clone()}:null;
  }
  buildMeshes(scene:Scene,materials:Record<SurfaceKind,Material>) {
    const groups=new Map<string,Triangle[]>();
    for(const t of this.triangles) {
      const x=(t.a[0]+t.b[0]+t.c[0])/3,z=(t.a[2]+t.b[2]+t.c[2])/3;
      const key=t.kind+":"+Math.floor(x/96)+","+Math.floor(z/96),list=groups.get(key)??[];
      list.push(t);groups.set(key,list);
    }
    for(const [key,list] of groups) {
      const positions:number[]=[],indices:number[]=[],normals:number[]=[],uvs:number[]=[];
      for(const t of list) {
        const points=[t.a,t.b,t.c];
        const cross=(t.b[2]-t.a[2])*(t.c[0]-t.a[0])-(t.b[0]-t.a[0])*(t.c[2]-t.a[2]);
        // Babylonの左手系は、上向き法線に対して時計回りの頂点順。
        if(cross>=0)[points[1],points[2]]=[points[2],points[1]];
        for(const p of points){indices.push(positions.length/3);positions.push(...p);normals.push(t.normal.x,t.normal.y,t.normal.z);uvs.push(p[0]/4,p[2]/4);}
      }
      const mesh=new Mesh("surface:"+key,scene),data=new VertexData();
      data.positions=positions;data.indices=indices;data.normals=normals;data.uvs=uvs;data.applyToMesh(mesh);
      mesh.material=materials[list[0].kind];mesh.receiveShadows=true;mesh.isPickable=false;mesh.freezeWorldMatrix();
      mesh.metadata={neighborhoodSurface:true,kind:list[0].kind};this.meshes.push(mesh);
      if(list[0].kind!=="marking") {
        const body=new PhysicsBody(mesh,PhysicsMotionType.STATIC,false,scene),shape=new PhysicsShapeMesh(mesh,scene);
        shape.filterMembershipMask=COL_STATIC;shape.filterCollideMask=COL_ALL;shape.material={friction:.85,restitution:.03};body.shape=shape;
      }
    }
  }
}
