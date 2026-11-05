import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import * as THREE from 'three';
import { createTestServer } from './helpers/vite.mjs';
const vite=await createTestServer({server:{middlewareMode:true,hmr:false},appType:'custom',logLevel:'silent'});
after(()=>vite.close());
const {productElevation,productMount}=await vite.ssrLoadModule('/src/core/productMount.ts');
const {PRODUCTS}=await vite.ssrLoadModule('/src/core/products.ts');
const {objectsBlockEachOther}=await vite.ssrLoadModule('/src/core/placement.ts');
const {PlannerScene}=await vite.ssrLoadModule('/src/renderer/PlannerScene.ts');
test('ceiling fixtures follow room height and allow a bed underneath',()=>{
 const fixture={...PRODUCTS.sofa,id:'ceiling-test',name:'AInno20 — planning model',height:1.4};
 PRODUCTS[fixture.id]=fixture;
 try{
  assert.equal(productMount(fixture),'ceiling');
  assert.equal(productElevation(fixture,2.8),1.4);
  assert.equal(productElevation(fixture,3.2),1.8000000000000003);
  assert.equal(objectsBlockEachOther({productId:fixture.id},{productId:'sofa'}),false);
  const scene=Object.create(PlannerScene.prototype),model=new THREE.Group();
  model.userData.productId=fixture.id;
  let height=2.8;
  Object.assign(scene,{objectModels:new Map([['fixture',model]]),contactShadows:new Map(),invalidateShadows(){},sceneSnapshot:()=>({room:{height}})});
  scene.syncObjectTransform('fixture',1,2,0);assert.ok(Math.abs(model.position.y+fixture.height-height)<1e-6);
  height=3.1;scene.syncObjectTransform('fixture',1,2,0);assert.ok(Math.abs(model.position.y+fixture.height-height)<1e-6);
  assert.equal(scene.createContactShadow(fixture.id).children.length,0);
 }finally{delete PRODUCTS[fixture.id];}
});
