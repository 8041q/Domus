import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { compactPrimitive, dedup, flatten, getBounds, join, prune, transformPrimitive, weld } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptSimplifier } from 'meshoptimizer';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const METADATA = ['domus_schema_version', 'domus_name', 'domus_category', 'domus_display_width_m',
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

function canonicalGeometry(positions, indices) {
  // Blender can emit equivalent CAD faces in different vertex orders. Sorting
  // welded positions and oriented triangles makes collapse tie-breaking stable.
  const keys=new Map(),sourceKeys=[];
  for(let i=0;i<positions.length;i+=3) {
    const point=Array.from(positions.subarray(i,i+3),value=>Math.round(value*1e6)/1e6);
    const key=point.join('/');sourceKeys.push(key);if(!keys.has(key))keys.set(key,point);
  }
  const rows=[...keys].sort((a,b)=>a[1][0]-b[1][0]||a[1][1]-b[1][1]||a[1][2]-b[1][2]);
  const lookup=new Map(rows.map(([key],i)=>[key,i]));
  const remap=sourceKeys.map(key=>lookup.get(key)),triangles=[];
  for(let i=0;i<indices.length;i+=3) {
    const t=Array.from(indices.subarray(i,i+3),vertex=>remap[vertex]);
    if(new Set(t).size<3)continue;
    const first=t.indexOf(Math.min(...t));triangles.push([t[first],t[(first+1)%3],t[(first+2)%3]]);
  }
  triangles.sort((a,b)=>a[0]-b[0]||a[1]-b[1]||a[2]-b[2]);
  return {positions:new Float32Array(rows.flatMap(([,point])=>point)),indices:new Uint32Array(triangles.flat())};
}

/** Regenerate smooth normals with real hard edges after changing topology. CAD
 * normal splits must not keep thousands of otherwise redundant vertices alive. */
function creaseNormals(positions, indices) {
  const usable=[];
  for(let i=0;i<indices.length;i+=3) {
    const [a,b,c]=Array.from(indices.subarray(i,i+3),v=>v*3);
    const u=[0,1,2].map(k=>positions[b+k]-positions[a+k]),v=[0,1,2].map(k=>positions[c+k]-positions[a+k]);
    if(Math.hypot(u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0])>1e-12) usable.push(...indices.subarray(i,i+3));
  }
  indices=new Uint32Array(usable);
  const adjacency=new Map(), faceNormals=[];
  for(let i=0;i<indices.length;i+=3) {
    const [a,b,c]=Array.from(indices.subarray(i,i+3),v=>v*3);
    const u=[0,1,2].map(k=>positions[b+k]-positions[a+k]),v=[0,1,2].map(k=>positions[c+k]-positions[a+k]);
    const n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
    const length=Math.hypot(...n)||1,face=faceNormals.length;
    faceNormals.push({normal:n.map(value=>value/length),weighted:n});
    for(const vertex of indices.subarray(i,i+3)) { if(!adjacency.has(vertex))adjacency.set(vertex,[]);adjacency.get(vertex).push(face); }
  }
  const resultPositions=[],resultNormals=[],mapping=new Map();
  for(const [vertex,faces] of adjacency) {
    const groups=[];
    for(const face of faces) {
      const n=faceNormals[face].normal;
      const group=groups.find(group=>group.some(f=>faceNormals[f].normal.reduce((sum,value,k)=>sum+value*n[k],0)>.766));
      if(group)group.push(face);else groups.push([face]);
    }
    for(const group of groups) {
      const index=resultPositions.length/3,n=[0,0,0];
      resultPositions.push(...positions.subarray(vertex*3,vertex*3+3));
      for(const face of group) for(let k=0;k<3;k++)n[k]+=faceNormals[face].weighted[k];
      const length=Math.hypot(...n)||1;resultNormals.push(...n.map(v=>v/length));
      for(const face of group)mapping.set(`${vertex}/${face}`,index);
    }
  }
  return {positions:new Float32Array(resultPositions),normals:new Float32Array(resultNormals),
    indices:Uint32Array.from(indices,(vertex,i)=>mapping.get(`${vertex}/${Math.floor(i/3)}`))};
}

/** Geometry-only reduction. Private part roles are discarded after the selective
 * stage. No global rescaling is used to conceal lost extremities. */
export async function simplifyPlanningShell(input, output = input, options = {}) {
  const { method = 'protected', targetTriangles = 10000, maxError = .003, stableSurfaceError = .0015, thinSurfaceError = .0015, remeshResolution = 128 } = options;
  if (!['protected', 'remesh'].includes(method) || !Number.isInteger(targetTriangles) || targetTriangles < 12
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
    // Reconnect identical positions across imported normal seams. Geometry and
    // broad material boundaries remain; source shading topology is disposable.
    ({positions,indices}=canonicalGeometry(positions,indices));
    normals=smoothNormals(positions,indices);
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
    let count,error;
    if(stableSurface&&!remeshed) {
      const result=MeshoptSimplifier.simplifyWithAttributes(indices,positions,3,normals,3,[.001,.001,.001],locks,
        Math.min(indices.length,quota*3),Math.min(maxError,stableSurfaceError,role==='thin'?thinSurfaceError:Infinity),flags);
      indices=result[0];count=indices.length;error=result[1];
    } else [count,error]=MeshoptSimplifier.simplifyWithUpdate(indices,positions,3,normals,3,[.001,.001,.001],locks,
      Math.min(indices.length,quota*3),maxError,flags);
    indices=indices.slice(0,count); normalizeNormals(normals);
    for(let i=0;i<positions.length;i+=3) if(Math.hypot(positions[i]-beforePositions[i],positions[i+1]-beforePositions[i+1],positions[i+2]-beforePositions[i+2])>1e-7) repositionedVertices++;
    ({positions,normals,indices}=creaseNormals(positions,indices));
    const buffer=primitive.getAttribute('POSITION').getBuffer();
    primitive.setAttribute('POSITION',doc.createAccessor().setBuffer(buffer).setType('VEC3').setArray(positions));
    primitive.setAttribute('NORMAL',doc.createAccessor().setBuffer(buffer).setType('VEC3').setArray(normals));
    primitive.setIndices(doc.createAccessor().setBuffer(buffer).setType('SCALAR').setArray(indices));
    for(const semantic of primitive.listSemantics()) if(!['POSITION','NORMAL'].includes(semantic)) primitive.setAttribute(semantic,null);
    primitive.setExtras({}); compactPrimitive(primitive);
    partReports.push({role,sourceTriangles:part.indices.length/3,triangles:indices.length/3,remeshed,errorMetres:error});
  }
  for(const collection of ['listNodes','listMeshes','listMaterials','listAccessors','listBuffers','listScenes']) {
    for(const property of root[collection]()) { property.setName(''); property.setExtras({}); }
  }
  root.setExtras({});
  await doc.transform(dedup(),flatten(),join({keepNamed:false}),prune());
  if(metadata) scene.addChild(doc.createNode('Planning model').setExtras(metadata));
  const after=getBounds(scene);
  const boundsDriftMetres=Math.max(...['min','max'].flatMap(edge=>bounds[edge].map((value,i)=>Math.abs(value-after[edge][i]))));
  const afterTriangles=root.listMeshes().reduce((sum,mesh)=>sum+mesh.listPrimitives().reduce((n,p)=>n+p.getIndices().getCount()/3,0),0);
  const report={method,targetTriangles,beforeTriangles,afterTriangles,remeshedParts,repositionedVertices,boundsDriftMetres,parts:partReports};
  if(!Number.isFinite(boundsDriftMetres)||boundsDriftMetres>.003) throw new Error(`Simplification changed bounds by ${(boundsDriftMetres*1000).toFixed(2)} mm; candidate rejected`);
  await io.write(output,doc);
  return report;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [input,output,...args]=process.argv.slice(2);
  const options=args.length?JSON.parse(args.join(' ')):{};
  console.log(JSON.stringify(await simplifyPlanningShell(input,output??input,options)));
}
