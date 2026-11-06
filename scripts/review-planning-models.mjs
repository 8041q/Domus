// Local-only inspection of generated copies. Never serves authoring files.
import { createServer } from 'vite';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
const model=process.argv[2]??'D8d';
if(!['D8d','C8c','V8v','Z7z','AInno20'].includes(model))throw new Error('Unknown model');
const directory=path.resolve('private/shading-response/topology-comparison',model);
const assets={reference:'reference.glb',shell:'source-shell.glb',candidate:'review.glb',compressed:'runtime.glb'};
const server=await createServer({configFile:false,publicDir:false,optimizeDeps:{noDiscovery:true,entries:[]},server:{host:'127.0.0.1',port:5198,strictPort:true,watch:{ignored:['**/private/**']},fs:{deny:['**/og_models/**','**/private/**','**/.env*','**/.git/**','**/*.{pem,crt}']}},plugins:[{
 name:'private-shading-review',configureServer(server){server.middlewares.use(async(req,res,next)=>{
  try {
   const url=new URL(req.url,'http://localhost');res.setHeader('Cache-Control','no-store');
   if(url.pathname==='/') {res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml('/',await readFile('scripts/review-planning-models.html','utf8')));return;}
   const key=url.pathname.match(/^\/review-assets\/(reference|shell|candidate|compressed)\.glb$/)?.[1];
   if(key){const requested=url.searchParams.get('model')??model;if(!['D8d','C8c','V8v','Z7z','AInno20'].includes(requested)){res.statusCode=400;res.end('Unknown model');return;}res.setHeader('Content-Type','model/gltf-binary');res.end(await readFile(path.resolve('private/shading-response/topology-comparison',requested,assets[key])));return;}
   next();
  }catch(error){res.statusCode=500;res.end(String(error));}
 });}
}]});
await server.listen();console.log(`Private ${model} review: http://127.0.0.1:5198`);
