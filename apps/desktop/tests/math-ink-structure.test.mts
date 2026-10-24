import assert from "node:assert/strict";
import test from "node:test";
import { compactSigmaScore, findEnclosingParentheses, findMultiStrokeSigmaCluster, multiStrokeSigmaScore } from "../src/features/editor/math-ink-structure.ts";

test("recognizes a rough three-stroke sigma like the reported failure",()=>{
  const sigma=[
    {points:[{x:34,y:110},{x:155,y:108},{x:300,y:104},{x:382,y:98}]},
    {points:[{x:34,y:110},{x:92,y:150},{x:190,y:205},{x:290,y:218}]},
    {points:[{x:290,y:218},{x:170,y:221},{x:55,y:216},{x:8,y:245},{x:210,y:255},{x:390,y:258}]},
  ];
  assert.ok(multiStrokeSigmaScore(sigma)>=.86);
});

test("finds the sigma cluster without stealing its upper and lower limits",()=>{
  const expression=[
    {points:[{x:175,y:4},{x:225,y:5},{x:230,y:35},{x:182,y:58}]}, // upper 5
    {points:[{x:34,y:110},{x:155,y:108},{x:300,y:104},{x:382,y:98}]},
    {points:[{x:34,y:110},{x:92,y:150},{x:190,y:205},{x:290,y:218}]},
    {points:[{x:290,y:218},{x:170,y:221},{x:55,y:216},{x:8,y:245},{x:210,y:255},{x:390,y:258}]},
    {points:[{x:80,y:292},{x:80,y:355},{x:105,y:320}]}, // lower k
    {points:[{x:130,y:325},{x:180,y:325}]},
  ];
  assert.deepEqual(findMultiStrokeSigmaCluster(expression),[1,2,3]);
});

test("does not call an integral or ordinary equals sign a sigma",()=>{
  const integral=[{points:[{x:30,y:5},{x:20,y:40},{x:18,y:90},{x:8,y:140}]}];
  const equals=[
    {points:[{x:0,y:20},{x:100,y:20}]},
    {points:[{x:0,y:50},{x:100,y:50}]},
  ];
  assert.equal(multiStrokeSigmaScore(integral),0);
  assert.equal(multiStrokeSigmaScore(equals),0);
  assert.equal(compactSigmaScore(integral),0);
  assert.equal(compactSigmaScore(equals),0);
});

test("recognizes a continuous/two-stroke sigma before its top bar becomes a fraction",()=>{
  const compact=[
    {points:[{x:10,y:8},{x:150,y:8},{x:285,y:5}]},
    {points:[{x:12,y:12},{x:95,y:70},{x:225,y:132},{x:70,y:225},{x:300,y:238}]},
  ];
  assert.ok(compactSigmaScore(compact)>=.86);
});

test("extracts the reported parenthesized k+1 body from its tall outer strokes",()=>{
  const body=[
    {points:[{x:22,y:0},{x:7,y:30},{x:2,y:70},{x:9,y:112},{x:24,y:140}]}, // (
    {points:[{x:55,y:38},{x:52,y:101},{x:82,y:66},{x:100,y:42},{x:78,y:69},{x:103,y:105}]}, // k
    {points:[{x:116,y:70},{x:154,y:70}]}, // + horizontal
    {points:[{x:135,y:50},{x:135,y:91}]}, // + vertical
    {points:[{x:177,y:45},{x:188,y:34},{x:188,y:105}]}, // 1
    {points:[{x:220,y:0},{x:236,y:30},{x:241,y:70},{x:234,y:112},{x:218,y:140}]}, // )
  ];
  assert.deepEqual(findEnclosingParentheses(body),{left:0,right:5,inner:[1,2,3,4]});
});

test("does not invent parentheses around k+1 with a tall final digit",()=>{
  const body=[
    {points:[{x:5,y:25},{x:5,y:90},{x:30,y:55}]},
    {points:[{x:45,y:60},{x:80,y:60}]},{points:[{x:62,y:42},{x:62,y:80}]},
    {points:[{x:100,y:20},{x:112,y:10},{x:112,y:95}]},
  ];
  assert.equal(findEnclosingParentheses(body),null);
});
