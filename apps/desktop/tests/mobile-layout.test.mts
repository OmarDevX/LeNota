import test from 'node:test';
import assert from 'node:assert/strict';
import { mobileFileType } from '../src/lib/mobile-files.ts';
// Pure gesture geometry lives separately to keep these tests independent of React.
import { pinchViewport } from '../src/features/editor/touch-geometry.ts';

test('pinch keeps the world point under the moving midpoint', () => {
  const before = {x:10,y:20,zoom:1};
  const after = pinchViewport(before,[{x:100,y:100},{x:200,y:100}],[{x:90,y:120},{x:290,y:120}]);
  assert.deepEqual(after,{x:-90,y:-40,zoom:2});
  assert.equal((190-after.x)/after.zoom,(150-before.x)/before.zoom);
});
test('pinch clamps zoom without moving the anchor', () => {
  const after = pinchViewport({x:0,y:0,zoom:2},[{x:0,y:10},{x:100,y:10}],[{x:-50,y:10},{x:150,y:10}]);
  assert.equal(after.zoom,2.5); assert.equal((50-after.x)/after.zoom,25);
});
test('coincident touch points do not produce nonfinite viewports', () => {
  const value = pinchViewport({x:0,y:0,zoom:1},[{x:0,y:0},{x:0,y:0}],[{x:0,y:0},{x:0,y:0}]);
  assert.ok(Object.values(value).every(Number.isFinite));
});
test('opaque Android URI imports preserve common attachment MIME types', () => {
  assert.equal(mobileFileType(Uint8Array.from([137,80,78,71,13,10,26,10])).mime,'image/png');
  assert.equal(mobileFileType(Uint8Array.from([255,216,255,0])).extension,'jpg');
  assert.equal(mobileFileType(new TextEncoder().encode('%PDF-1.7')).mime,'application/pdf');
  assert.equal(mobileFileType(new Uint8Array()).mime,'application/octet-stream');
});
