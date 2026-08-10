import assert from "node:assert/strict";
import test from "node:test";
import { isOnRenderedTextLine, textForInlineHandwriting } from "../src/features/editor/recognized-text-placement.ts";

test("adds a word boundary when handwriting continues an existing line",()=>{
  assert.equal(textForInlineHandwriting("world","Hello","")," world");
  assert.equal(textForInlineHandwriting("beautiful","Hello ","world"),"beautiful ");
});

test("does not put a space before punctuation",()=>{
  assert.equal(textForInlineHandwriting(",","Hello"," world"),",");
  assert.equal(textForInlineHandwriting("world","(",")"),"world");
});

test("distinguishes the same rendered line from a lower blank line",()=>{
  assert.equal(isOnRenderedTextLine(120,105,125),true);
  assert.equal(isOnRenderedTextLine(170,105,125),false);
});
