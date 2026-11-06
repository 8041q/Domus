/** Restore surface attributes on a previously verified, budget-safe display mesh.
 * Geometry stays fixed; source attributes are restored per manufactured part.
 * Correspondence and normal transfer stay part-local. */
import * as THREE from 'three';
import {MeshBVH} from 'three-mesh-bvh';
import {NodeIO} from '@gltf-transform/core';
import {ALL_EXTENSIONS} from '@gltf-transform/extensions';
import {flatten, transformPrimitive, weld, prune, dedup, join, unpartition} from '@gltf-transform/functions';
import {transferSurfaceNormals} from './simplify-planning-shell.mjs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export async function restorePlanningSurfaces(baseline,reference,output){
 const io=new NodeIO().registerExtensions(ALL_EXTENSIONS),target=await io.read(baseline),source=await io.read(reference);
 const carrier=target.getRoot().listNodes().find(n=>n.getExtras().domus_schema_version)?.getExtras();
 const fields=['domus_mount','domus_schema_version','domus_name','domus_category','domus_display_profile','domus_display_width_m','domus_display_depth_m','domus_display_height_m','domus_collision','domus_clearance_front_m','domus_clearance_back_m','domus_clearance_sides_m'];
 const metadata=carrier&&Object.fromEntries(fields.filter(k=>carrier[k]!==undefined).map(k=>[k,carrier[k]]));
 await source.transform(flatten());await target.transform(flatten());
 const entries=[];
 for(const node of source.getRoot().listNodes())for(const original of node.getMesh()?.listPrimitives()??[]){
  const primitive=original.clone();for(const name of primitive.listSemantics()){const a=primitive.getAttribute(name);primitive.setAttribute(name,a.clone().setArray(a.getArray().slice()));}
  if(primitive.getIndices())primitive.setIndices(primitive.getIndices().clone().setArray(primitive.getIndices().getArray().slice()));
  transformPrimitive(primitive,node.getWorldMatrix());
  const positions=new Float32Array(primitive.getAttribute('POSITION').getArray()),normals=new Float32Array(primitive.getAttribute('NORMAL').getArray()),indices=new Uint32Array(primitive.getIndices().getArray());
  const geometry=new THREE.BufferGeometry().setAttribute('position',new THREE.BufferAttribute(positions,3));geometry.setIndex(new THREE.BufferAttribute(indices.slice(),1));geometry.computeBoundingBox();
  entries.push({positions,normals,indices,geometry,tree:new MeshBVH(geometry,{indirect:true}),material:primitive.getMaterial(),colour:primitive.getMaterial().getBaseColorFactor()});
 }
 const buffer=target.createBuffer(),scene=target.getRoot().listScenes()[0],groups=new Map(),point=new THREE.Vector3(),faceNormal=new THREE.Vector3(),triangle=new THREE.Triangle();let unmatched=0,triangles=0;
 for(const node of [...target.getRoot().listNodes()])if(node.getMesh()){
  for(const original of node.getMesh().listPrimitives()){
   const primitive=original.clone();for(const name of primitive.listSemantics()){const a=primitive.getAttribute(name);primitive.setAttribute(name,a.clone().setArray(a.getArray().slice()));}transformPrimitive(primitive,node.getWorldMatrix());
   const p=primitive.getAttribute('POSITION').getArray(),guides=primitive.getAttribute('NORMAL').getArray(),idx=primitive.getIndices().getArray(),colour=primitive.getMaterial().getBaseColorFactor();
   for(let i=0;i<idx.length;i+=3){
    const vertices=Array.from(idx.subarray(i,i+3),v=>new THREE.Vector3().fromArray(p,v*3));triangle.set(...vertices);if(triangle.getArea()<1e-12)continue;triangle.getMidpoint(point);triangle.getNormal(faceNormal);
    let chosen=null,best=Infinity;
    // A centroid alone can select a tiny overlapping trim or internal plate.
    // Require one source part to explain the complete triangle instead.
    const probes=[point.clone(),...vertices];
    for(const entry of entries){
     const colourError=Math.hypot(...colour.slice(0,3).map((x,k)=>x-entry.colour[k]));
     if(colourError>.25)continue;
     const lower=probes.reduce((sum,p)=>sum+entry.geometry.boundingBox.distanceToPoint(p)**2,0)/4;
     if(lower>=best||lower>.01)continue;
     let cost=0,valid=true;
     for(const probe of probes){
      let distance=.1;
      entry.tree.shapecast({intersectsBounds:box=>box.distanceToPoint(probe)<distance+1e-8,
       intersectsTriangle:t=>{if(t.getNormal(new THREE.Vector3()).dot(faceNormal)<.1)return false;const closest=t.closestPointToPoint(probe,new THREE.Vector3());distance=Math.min(distance,closest.distanceTo(probe));return false;}});
      if(distance>=.1){valid=false;break;}
      cost+=distance*distance/4;
      if(cost>=best){valid=false;break;}
     }
     if(valid&&cost<best){best=cost;chosen=entry;}
    }

    if(!chosen){unmatched++;throw new Error('No same-facing source surface matches '+JSON.stringify({point:point.toArray(),normal:faceNormal.toArray(),colour}));}
    if(!groups.has(chosen))groups.set(chosen,{positions:[],normals:[]});
    const group=groups.get(chosen);group.positions.push(...vertices.flatMap(v=>v.toArray()));
    for(const vertex of idx.subarray(i,i+3))group.normals.push(...faceNormal.toArray());triangles++;
   }
  }
  node.setMesh(null);
 }
 const parts=[];
 for(const [source,values]of groups){
  const part={source,positions:new Float32Array(values.positions),normals:new Float32Array(values.normals)};
  transferSurfaceNormals(source.positions,source.indices,source.normals,part.positions,part.normals,.1);
  parts.push(part);
 }
 const materialCache=new Map();
 for(const {source:entry,positions,normals} of parts){
  let material=materialCache.get(entry.material);
  if(!material){/* Copy all PBR extensions through the document graph. */
   const {copyToDocument}=await import('@gltf-transform/functions');material=copyToDocument(target,source,[entry.material]).get(entry.material);materialCache.set(entry.material,material);}
  const primitive=target.createPrimitive().setMaterial(material)
   .setAttribute('POSITION',target.createAccessor().setBuffer(buffer).setType('VEC3').setArray(positions))
   .setAttribute('NORMAL',target.createAccessor().setBuffer(buffer).setType('VEC3').setArray(normals))
   .setIndices(target.createAccessor().setBuffer(buffer).setType('SCALAR').setArray(Uint32Array.from({length:positions.length/3},(_,i)=>i)));
  scene.addChild(target.createNode().setMesh(target.createMesh().addPrimitive(primitive)));
 }
 for(const collection of ['listNodes','listMeshes','listMaterials','listAccessors','listBuffers','listScenes'])for(const item of target.getRoot()[collection]()){item.setName('');if(!item.getExtras().domus_schema_version)item.setExtras({});}
 await target.transform(weld(),dedup(),join({keepNamed:false}),prune(),unpartition());if(metadata)scene.addChild(target.createNode('Planning model').setExtras(metadata));await io.write(output,target);for(const e of entries)e.geometry.dispose();
 return {method:'surface-transfer',beforeTriangles:triangles,afterTriangles:triangles,unmatched};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await restorePlanningSurfaces(...process.argv.slice(2))));
