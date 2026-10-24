import test from 'node:test';
import assert from 'node:assert/strict';
import { SpatialIndex, paddedWorldBounds, viewportNeedsRefresh, canvasMountUrgency, estimatedNoteBounds } from '../src/features/editor/spatial-visibility.ts';

test('spatial index renders viewport objects, preserving stable source order',()=>{
  const notes=Array.from({length:10000},(_,i)=>({id:i,x:i*600,y:0,width:300,minHeight:100,plainText:'hello'}));
  const index=new SpatialIndex(notes,n=>estimatedNoteBounds(n));
  const result=index.query({left:3000,top:-100,right:5200,bottom:1500});
  assert.deepEqual(result.map(n=>n.id),[5,6,7,8]);
  assert.equal(notes.length,10000,'render filtering never mutates original page data');
});
test('spatial index handles negative positions, oversized objects, duplicate buckets, and edge touches',()=>{
  const items=[
    {id:'oversize',b:{left:-10000,top:-10000,right:10000,bottom:10000}},
    {id:'negative',b:{left:-800,top:-800,right:-10,bottom:-10}},
    {id:'edge',b:{left:100,top:10,right:300,bottom:100}},
    {id:'outside',b:{left:301,top:101,right:400,bottom:200}},
  ];
  const index=new SpatialIndex(items,item=>item.b);
  assert.deepEqual(index.query({left:-20,top:-20,right:100,bottom:100}).map(item=>item.id),['oversize','negative','edge']);
});
test('viewport panning refreshes only when visible bounds approach the buffer edge',()=>{
  const size={width:1200,height:800};
  const initial={x:0,y:0,zoom:1};
  const bounds=paddedWorldBounds(initial,size);
  assert.equal(viewportNeedsRefresh(bounds,{x:-150,y:0,zoom:1},size),false);
  assert.equal(viewportNeedsRefresh(bounds,{x:-1400,y:0,zoom:1},size),true);
  assert.equal(viewportNeedsRefresh(bounds,{x:-1400,y:0,zoom:.5},size),true);
});
test('long rich notes remain eligible for rendering when their top is far above the viewport',()=>{
  const bounds=estimatedNoteBounds({x:0,y:0,width:400,minHeight:100,plainText:'x'.repeat(10000)});
  assert.ok(bounds.bottom>=22000);
});
test('full width query returns all items, including objects in overflow buckets',()=>{
  const items=Array.from({length:1000},(_,i)=>({x:i*200,y:-100,width:100,minHeight:100,plainText:'abc'}));
  const index=new SpatialIndex(items,item=>estimatedNoteBounds(item));
  assert.equal(index.query({left:-1e6,top:-1e6,right:1e6,bottom:1e6}).length,items.length);
});

test('active pan defers expensive editor mounts but forces a refresh before exposing blank space',()=>{
  const size={width:1200,height:800};
  const bounds=paddedWorldBounds({x:0,y:0,zoom:1},size);
  assert.equal(canvasMountUrgency(bounds,{x:-100,y:0,zoom:1},size),'none');
  assert.equal(canvasMountUrgency(bounds,{x:-950,y:0,zoom:1},size),'defer');
  assert.equal(canvasMountUrgency(bounds,{x:-1210,y:0,zoom:1},size),'now');
  assert.equal(canvasMountUrgency(bounds,{x:0,y:0,zoom:1},size),'none');
});
