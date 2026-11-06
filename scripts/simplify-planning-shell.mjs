import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { compactPrimitive, dedup, flatten, getBounds, join, prune, transformPrimitive, weld } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptSimplifier } from 'meshoptimizer';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const METADATA = ['domus_mount', 'domus_schema_version', 'domus_name', 'domus_category', 'domus_display_width_m',
  'domus_display_depth_m', 'domus_display_height_m', 'domus_collision', 'domus_clearance_front_m',
  'domus_clearance_back_m', 'domus_clearance_sides_m', 'domus_display_profile'];

function measure(positions, indices) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let area = 0, volume = 0;
  for (const vertex of indices) for (let axis = 0; axis < 3; axis++) {
    const value = positions[vertex * 3 + axis];
    min[axis] = Math.min(min[axis], value); max[axis] = Math.max(max[axis], value);
  }
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    const u = [0, 1, 2].map(k => positions[b + k] - positions[a + k]);
    const v = [0, 1, 2].map(k => positions[c + k] - positions[a + k]);
    const cross=[u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0]];
    area += Math.hypot(...cross) / 2;
    volume += cross.reduce((sum,value,k)=>sum+value*(positions[a+k]-(min[k]+max[k])/2),0)/6;
  }
  return { min, max, size: max.map((value, i) => value - min[i]), area, thickness:area?2*Math.abs(volume)/area:0 };
}

/** Pin representative extrema. Existing holes retain their mesh topology; CAD
 * crease vertices must remain reducible rather than all becoming constraints. */
function featureLocks(positions, indices, role) {
  const remap = MeshoptSimplifier.generatePositionRemap(positions, 3);
  const locks = new Uint8Array(positions.length / 3);
  const extremal = Array(6).fill(-1), values = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity];
  for (const vertex of indices) for (let axis = 0; axis < 3; axis++) {
    const value = positions[vertex * 3 + axis];
    for (const end of [0, 1]) {
      const slot = axis * 2 + end;
      if (end ? value > values[slot] : value < values[slot]) { values[slot] = value; extremal[slot] = remap[vertex]; }
    }
  }
  for (const vertex of extremal) if (vertex >= 0) locks[vertex] = 1;
  return Uint8Array.from(remap, vertex => locks[vertex]);
}

function normalizeNormals(normals) {
  for (let i = 0; i < normals.length; i += 3) {
    const length = Math.hypot(normals[i], normals[i+1], normals[i+2]);
    if (length > 1e-12) for (let k=0;k<3;k++) normals[i+k] /= length;
    else { normals[i]=0; normals[i+1]=1; normals[i+2]=0; }
  }
}

function smoothNormals(positions, indices) {
  const normals = new Float32Array(positions.length);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i]*3, b = indices[i+1]*3, c = indices[i+2]*3;
    const ux=positions[b]-positions[a], uy=positions[b+1]-positions[a+1], uz=positions[b+2]-positions[a+2];
    const vx=positions[c]-positions[a], vy=positions[c+1]-positions[a+1], vz=positions[c+2]-positions[a+2];
    const n=[uy*vz-uz*vy, uz*vx-ux*vz, ux*vy-uy*vx];
    for (const offset of [a,b,c]) for(let axis=0;axis<3;axis++) normals[offset+axis]+=n[axis];
  }
  normalizeNormals(normals); return normals;
}

/** Canonicalize complete attributes, never positions alone. This stabilizes
 * CAD export order without welding different shading fans together. */
function canonicalShading(positions, normals, indices) {
  const rows=[],lookup=new Map(),remap=[];
  for(let i=0;i<positions.length;i+=3) {
    const row=[...positions.subarray(i,i+3),...normals.subarray(i,i+3)];
    const key=row.join('/');
    if(!lookup.has(key)){lookup.set(key,rows.length);rows.push(row);}
    remap.push(lookup.get(key));
  }
  const order=rows.map((row,index)=>({row,index})).sort((a,b)=>{
    for(let k=0;k<6;k++)if(a.row[k]!==b.row[k])return a.row[k]-b.row[k];return 0;
  });
  const sorted=new Uint32Array(rows.length);order.forEach((item,i)=>sorted[item.index]=i);
  const faces=[];
  for(let i=0;i<indices.length;i+=3){const t=Array.from(indices.subarray(i,i+3),v=>sorted[remap[v]]);const first=t.indexOf(Math.min(...t));faces.push([t[first],t[(first+1)%3],t[(first+2)%3]]);}
  faces.sort((a,b)=>a[0]-b[0]||a[1]-b[1]||a[2]-b[2]);
  return {positions:new Float32Array(order.flatMap(x=>x.row.slice(0,3))),normals:new Float32Array(order.flatMap(x=>x.row.slice(3))),indices:new Uint32Array(faces.flat())};
}

/** Attribute seams remain separate. Projection is confined to this primitive
 * (one part/material) and rejects the opposite side of a thin surface. */
export function transferSurfaceNormals(sourcePositions, sourceIndices, sourceNormals, positions, normals, maxDistance, projectPositions=false) {
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.BufferAttribute(sourcePositions,3));
  geometry.setIndex(new THREE.BufferAttribute(sourceIndices.slice(),1));
  const tree=new MeshBVH(geometry,{indirect:true});
  const point=new THREE.Vector3(), closest=new THREE.Vector3(), direction=new THREE.Vector3();
  const bary=new THREE.Vector3(), result=new THREE.Vector3(), corner=new THREE.Vector3();
  const bestPoint=new THREE.Vector3(), triangle=new THREE.Triangle();
  for(let i=0;i<positions.length;i+=3) {
    point.fromArray(positions,i);direction.fromArray(normals,i);
    let best=maxDistance*maxDistance,face=-1,alignment=-1;
    tree.shapecast({
      intersectsBounds:box=>box.distanceToPoint(point)**2<=best+1e-14,
      intersectsTriangle:(t,index)=>{
        const dot=t.getNormal(result).dot(direction);
        if(dot<.1)return false;
        t.closestPointToPoint(point,closest);const distance=closest.distanceToSquared(point);
        if(distance<best-1e-14 || (distance<=best+1e-14 && dot>alignment)) {
          best=distance;face=index;alignment=dot;bestPoint.copy(closest);
        }
        return false;
      }
    });
    if(face<0)continue;
    const offsets=[0,1,2].map(k=>sourceIndices[face*3+k]*3);
    triangle.set(...offsets.map(offset=>new THREE.Vector3().fromArray(sourcePositions,offset)));
    triangle.getBarycoord(bestPoint,bary);result.set(0,0,0);
    for(let k=0;k<3;k++)result.addScaledVector(corner.fromArray(sourceNormals,offsets[k]),bary.getComponent(k));
    if(result.dot(direction)>.1)result.normalize().toArray(normals,i);
    if(projectPositions)bestPoint.toArray(positions,i);
  }
  geometry.dispose();normalizeNormals(normals);
}

export function coincidentOppositeArea(positions, indices) {
  const faces=new Map();let area=0;
  for(let i=0;i<indices.length;i+=3) {
    const points=Array.from(indices.subarray(i,i+3),v=>Array.from(positions.subarray(v*3,v*3+3),x=>Math.round(x*1e6)).join('/'));
    if(new Set(points).size<3)continue;
    const first=points.indexOf([...points].sort()[0]);
    const ordered=[points[first],points[(first+1)%3],points[(first+2)%3]];
    const key=[...ordered].sort().join('|'), winding=ordered.join('|');
    if(faces.has(key)&&faces.get(key)!==winding) {
      const [a,b,c]=Array.from(indices.subarray(i,i+3),v=>new THREE.Vector3().fromArray(positions,v*3));
      area+=new THREE.Triangle(a,b,c).getArea();
    } else faces.set(key,winding);
  }
  return area;
}

/** Geometry-only reduction. Private part roles are discarded after the selective
 * stage. No global rescaling is used to conceal lost extremities. */
export async function simplifyPlanningShell(input, output = input, options = {}) {
  const { normalWeight = 1, thinNormalWeight = normalWeight, method = 'protected', targetTriangles = 10000, maxError = .003, stableSurfaceError = .0015, thinSurfaceError = .0015, remeshResolution = 128 } = options;
  if (!Number.isFinite(thinNormalWeight) || thinNormalWeight<=0 || thinNormalWeight>1 || !Number.isFinite(normalWeight) || normalWeight <= 0 || normalWeight > 1 || !['protected', 'remesh'].includes(method) || !Number.isInteger(targetTriangles) || targetTriangles < 12
    || !Number.isFinite(maxError) || maxError <= 0 || !Number.isFinite(stableSurfaceError) || stableSurfaceError <= 0 || !Number.isFinite(thinSurfaceError) || thinSurfaceError <= 0
    || !Number.isInteger(remeshResolution) || remeshResolution < 4 || remeshResolution > 256) {
    throw new Error('Invalid planning simplification options');
  }
  await Promise.all([MeshoptDecoder.ready, MeshoptSimplifier.ready]);
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  const doc = await io.read(input), root = doc.getRoot(), scene = root.listScenes()[0];
  if (!scene || root.listAnimations().length || root.listSkins().length || root.listTextures().length) throw new Error('Planning input must be a static, texture-free scene');
  if(root.listMeshes().some(mesh=>mesh.listPrimitives().some(primitive=>primitive.listTargets().length))) throw new Error('Planning input must not contain morph targets');
  const beforeTriangles = root.listNodes().reduce((sum, node) => sum + (node.getMesh()?.listPrimitives()??[]).reduce((n,p) => n+(p.getIndices()?.getCount()??p.getAttribute('POSITION').getCount())/3,0),0);
  const bounds = getBounds(scene);
  const extras = root.listNodes().find(node => node.getExtras().domus_schema_version)?.getExtras();
  const metadata = extras && Object.fromEntries(METADATA.filter(key => extras[key] !== undefined).map(key => [key, extras[key]]));
  await doc.transform(flatten());
  // Work in world metres, isolating instances before mutating shared accessors.
  for (const node of root.listNodes()) {
    const source=node.getMesh(); if(!source) continue;
    const mesh=doc.createMesh();
    for(const original of source.listPrimitives()) {
      const primitive=original.clone();
      for(const semantic of primitive.listSemantics()) {
        const accessor=primitive.getAttribute(semantic);
        primitive.setAttribute(semantic,accessor.clone().setArray(accessor.getArray().slice()));
      }
      if(primitive.getIndices()) primitive.setIndices(primitive.getIndices().clone().setArray(primitive.getIndices().getArray().slice()));
      transformPrimitive(primitive,node.getWorldMatrix());mesh.addPrimitive(primitive);
    }
    node.setMesh(mesh).setTranslation([0,0,0]).setRotation([0,0,0,1]).setScale([1,1,1]);
  }
  await doc.transform(prune(),weld());
  const parts=[];
  for(const node of root.listNodes()) for(const primitive of node.getMesh()?.listPrimitives()??[]) {
    compactPrimitive(primitive);
    const position=primitive.getAttribute('POSITION'), index=primitive.getIndices();
    if(!position || !index || primitive.getMode()!==4) throw new Error('Planning input must contain indexed triangles');
    const positions=new Float32Array(position.getArray()), indices=new Uint32Array(index.getArray());
    const role=node.getExtras().domus_part_role??'feature';
    const shape=measure(positions,indices);
    parts.push({primitive,role,positions,indices,shape,singleMaterial:node.getMesh().listPrimitives().length===1,
      weight:Math.sqrt(shape.area)*(role==='feature'?1.5:role==='thin'?1.1:.7)});
  }
  const weight=parts.reduce((sum,p)=>sum+p.weight,0);
  let remeshedParts=0, repositionedVertices=0;
  const partReports=[];
  for(const part of parts) {
    const {primitive,role,shape}=part;
    let {positions,indices}=part, normals=primitive.getAttribute('NORMAL')?.getArray();
    normals=normals ? new Float32Array(normals) : smoothNormals(positions,indices);
    ({positions,normals,indices}=canonicalShading(positions,normals,indices));
    const sourcePositions=positions.slice(),sourceIndices=indices.slice(),sourceNormals=normals.slice();
    const sourceOppositeArea=coincidentOppositeArea(positions,indices);
    let remeshed=false;
    const quota=Math.max(12,Math.round(targetTriangles*part.weight/weight));
    if(method==='remesh' && role==='bulk' && part.singleMaterial && indices.length>300 && Math.min(...shape.size)>.025) {
      const resolution=Math.min(256,Math.max(remeshResolution,Math.ceil(Math.max(...shape.size)/.0025)));
      positions=MeshoptSimplifier.remesh(indices,positions,3,resolution,['Solve']);
      if(!positions.length) throw new Error('Remesher produced an empty component');
      indices=MeshoptSimplifier.generatePositionRemap(positions,3);
      normals=smoothNormals(positions,indices);
      remeshedParts++; remeshed=true;
    }
    const locks=featureLocks(positions,indices,role);
    const beforePositions=positions.slice();
    const flags=['Permissive','ErrorAbsolute','Sparse'];
    const stableSurface=role==='thin'||Math.min(...shape.size)<.012||shape.thickness<.012;
    if(remeshed||stableSurface)flags.push('PreserveFolds');
    const board=role==='feature' && shape.size[0]>.4 && shape.size[1]>.2 && shape.size[2]<.2;
    const colour=primitive.getMaterial()?.getBaseColorFactor().slice(0,3)??[1,1,1];
    const overlay=stableSurface && Math.max(...colour)-Math.min(...colour)>.2;
    const perforatedPanel=role==='feature' && shape.size[0]>.4 && shape.size[1]<.08;
    const upright=role==='feature' && shape.size[0]<.2 && shape.size[1]>.15;
    const attributeWeight=(perforatedPanel||board||upright)?Math.max(.03,normalWeight):role==='thin'?thinNormalWeight:normalWeight;
    let count,error;
    if(stableSurface&&!remeshed) {
      const result=MeshoptSimplifier.simplifyWithAttributes(indices,positions,3,normals,3,[attributeWeight,attributeWeight,attributeWeight],locks,
        Math.min(indices.length,quota*3),Math.min(maxError,perforatedPanel?Math.min(stableSurfaceError,.0015):stableSurfaceError,overlay?.0001:Infinity,role==='thin'?thinSurfaceError:Infinity),flags);
      indices=result[0];count=indices.length;error=result[1];
    } else [count,error]=MeshoptSimplifier.simplifyWithUpdate(indices,positions,3,normals,3,[attributeWeight,attributeWeight,attributeWeight],locks,
      Math.min(indices.length,quota*3),maxError,flags);
    indices=indices.slice(0,count); normalizeNormals(normals);
    for(let i=0;i<positions.length;i+=3) if(Math.hypot(positions[i]-beforePositions[i],positions[i+1]-beforePositions[i+1],positions[i+2]-beforePositions[i+2])>1e-7) repositionedVertices++;
    // Restore per-corner shading fans after permissive geometry reduction.
    // Face direction disambiguates the two sides of a nearby thin surface.
    const expandedPositions=new Float32Array(indices.length*3),expandedNormals=new Float32Array(indices.length*3);
    for(let i=0;i<indices.length;i+=3) {
      const triangle=new THREE.Triangle(...Array.from(indices.subarray(i,i+3),v=>new THREE.Vector3().fromArray(positions,v*3)));
      const direction=triangle.getNormal(new THREE.Vector3());
      for(let k=0;k<3;k++){
        expandedPositions.set(positions.subarray(indices[i+k]*3,indices[i+k]*3+3),(i+k)*3);
        const guide=new THREE.Vector3().fromArray(normals,indices[i+k]*3);
        (guide.lengthSq()>1e-12?guide.normalize():direction).toArray(expandedNormals,(i+k)*3);
      }
    }
    positions=expandedPositions;normals=expandedNormals;indices=Uint32Array.from({length:positions.length/3},(_,i)=>i);
    transferSurfaceNormals(sourcePositions,sourceIndices,sourceNormals,positions,normals,maxError*2);
    let oppositeArea=coincidentOppositeArea(positions,indices);
    const reducedTriangles=indices.length/3;
    const overlapFallback=oppositeArea>sourceOppositeArea+1e-5;
    if(overlapFallback) {
      // A collapse can leave the same triangle twice with opposite winding.
      // Keep one surface for double-sided materials; never create two depth
      // competitors. Single-sided solids retain the unreduced part instead.
      if(primitive.getMaterial()?.getDoubleSided()) {
        const seen=new Set(),clean=[];
        for(let i=0;i<indices.length;i+=3) {
          const key=Array.from(indices.subarray(i,i+3),v=>Array.from(positions.subarray(v*3,v*3+3),x=>Math.round(x*1e6)).join('/')).sort().join('|');
          if(!seen.has(key)){seen.add(key);clean.push(...indices.subarray(i,i+3));}
        }
        indices=new Uint32Array(clean);oppositeArea=coincidentOppositeArea(positions,indices);
      } else {positions=sourcePositions;indices=sourceIndices;normals=sourceNormals;oppositeArea=sourceOppositeArea;}
    }
    const buffer=primitive.getAttribute('POSITION').getBuffer();
    primitive.setAttribute('POSITION',doc.createAccessor().setBuffer(buffer).setType('VEC3').setArray(positions));
    primitive.setAttribute('NORMAL',doc.createAccessor().setBuffer(buffer).setType('VEC3').setArray(normals));
    primitive.setIndices(doc.createAccessor().setBuffer(buffer).setType('SCALAR').setArray(indices));
    for(const semantic of primitive.listSemantics()) if(!['POSITION','NORMAL'].includes(semantic)) primitive.setAttribute(semantic,null);
    primitive.setExtras({}); compactPrimitive(primitive);
    partReports.push({role,sourceTriangles:part.indices.length/3,triangles:indices.length/3,remeshed,errorMetres:error,sourceOppositeArea,oppositeArea,overlapFallback,reducedTriangles});
  }
  for(const collection of ['listNodes','listMeshes','listMaterials','listAccessors','listBuffers','listScenes']) {
    for(const property of root[collection]()) { property.setName(''); property.setExtras({}); }
  }
  root.setExtras({});
  await doc.transform(weld(),dedup(),flatten(),join({keepNamed:false}),prune());
  if(metadata) scene.addChild(doc.createNode('Planning model').setExtras(metadata));
  const after=getBounds(scene);
  const boundsDriftMetres=Math.max(...['min','max'].flatMap(edge=>bounds[edge].map((value,i)=>Math.abs(value-after[edge][i]))));
  const afterTriangles=root.listMeshes().reduce((sum,mesh)=>sum+mesh.listPrimitives().reduce((n,p)=>n+p.getIndices().getCount()/3,0),0);
  const report={method,normalWeight,targetTriangles,beforeTriangles,afterTriangles,remeshedParts,repositionedVertices,boundsDriftMetres,parts:partReports};
  if(!Number.isFinite(boundsDriftMetres)||boundsDriftMetres>.003) throw new Error(`Simplification changed bounds by ${(boundsDriftMetres*1000).toFixed(2)} mm; candidate rejected`);
  await io.write(output,doc);
  return report;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [input,output,...args]=process.argv.slice(2);
  const options=args.length?JSON.parse(args.join(' ')):{};
  console.log(JSON.stringify(await simplifyPlanningShell(input,output??input,options)));
}
