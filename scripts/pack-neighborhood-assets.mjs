// 既存498種・23パックを一切書き換えず、独立素材を追加パックへ変換する。
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { mergeDocuments, dedup, prune, unpartition, meshopt } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
await MeshoptEncoder.ready;await MeshoptDecoder.ready;
const io=new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.encoder':MeshoptEncoder,'meshopt.decoder':MeshoptDecoder});
const root=path.resolve('.asset-work/neighborhood-inputs/arcade/TokyoArcadeBuilding_v1');
const audit=JSON.parse(await fs.readFile(path.join(root,'qa/export_audit.json'),'utf8'));
const oldCatalog=JSON.parse(await fs.readFile('public/assets/models/catalog.json','utf8'));
const id='tokyo_arcade_001',pack='neighborhood_00';
if(oldCatalog.assets.some(a=>a.id===id))throw Error('Existing ID would be replaced: '+id);
const doc=new Document(),scene=doc.createScene('neighborhood');doc.getRoot().setDefaultScene(scene);
const states={};
for(const state of ['normal','lod1','lod2','wreck']) {
  const name=`tokyo_arcade_${state}.glb`,file=path.join(root,'models',name),bytes=await fs.readFile(file);
  if(crypto.createHash('sha256').update(bytes).digest('hex')!==audit[name].sha256)throw Error('Source hash differs: '+name);
  const src=await io.read(file),holder=src.createNode(`${id}|${state}`);
  for(const s of src.getRoot().listScenes())for(const n of s.listChildren())holder.addChild(n);
  for(const s of src.getRoot().listScenes())s.dispose();
  src.createScene('source').addChild(holder);
  const merged=mergeDocuments(doc,src);
  for(const s of doc.getRoot().listScenes())if(s!==scene)s.dispose();
  scene.addChild(merged.get(holder));
  states[state]={min:audit[name].bounds_gltf_m[0],max:audit[name].bounds_gltf_m[1],tris:audit[name].triangles};
}
const assets=[{id,name:'まちかどゲーム・事務所棟',role:'building',pack,states}];
const apartmentRoot=path.resolve('.asset-work/neighborhood-inputs/apartment/tokyo_small_apartment_v1');
const apartment=JSON.parse(await fs.readFile(path.join(apartmentRoot,'asset_manifest.json'),'utf8'));
if(oldCatalog.assets.some(a=>a.id===apartment.asset_id))throw Error('Existing apartment ID would be replaced');
const apartmentStates={};
for(const state of ['normal','lod1','lod2','wreck']) {
  const record=apartment.states[state],file=path.join(apartmentRoot,'runtime',state+'.glb'),bytes=await fs.readFile(file);
  if(crypto.createHash('sha256').update(bytes).digest('hex')!==record.sha256)throw Error('Apartment source hash differs');
  const src=await io.read(file),holder=src.createNode(`${apartment.asset_id}|${state}`);
  for(const s of src.getRoot().listScenes())for(const n of s.listChildren())holder.addChild(n);
  for(const s of src.getRoot().listScenes())s.dispose();
  src.createScene('source').addChild(holder);
  const merged=mergeDocuments(doc,src);
  for(const s of doc.getRoot().listScenes())if(s!==scene)s.dispose();
  scene.addChild(merged.get(holder));
  apartmentStates[state]={min:record.bounds_glTF_m[0],max:record.bounds_glTF_m[1],tris:record.triangles};
}
assets.push({id:apartment.asset_id,name:apartment.name_ja,role:'building',pack,states:apartmentStates});
await doc.transform(dedup(),prune({keepLeaves:true,keepAttributes:true}),unpartition(),meshopt({encoder:MeshoptEncoder,level:'medium'}));
const bytes=await io.writeBinary(doc);await fs.writeFile(`public/assets/models/${pack}.glb`,bytes);
await fs.writeFile('public/assets/models/neighborhood-catalog.json',JSON.stringify({assets,sources:[{asset_id:id,library_file_id:'libfile_26f96e3537b881919a0184acc619b4e6',package_sha256:'ffe57eb322435d6f5ffb6c9f63d4f20c76e7480b3f600629977f7ef511258e3f',front:'glTF +Z',origin:'front-center ground',foundation:0.18},{asset_id:apartment.asset_id,library_file_id:'libfile_67a02f4f13bc8191bcaa2bce78ed9300',package_sha256:'f1b111d7f6c47981c7229a939610c286c9bfc90ae4eb67d3ebd7ad751d11b1f1',front:'glTF +Z',origin:'front-center ground',floor_surfaces:[.3,3.1]}]},null,2));
console.log(JSON.stringify({pack,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),states},null,2));
