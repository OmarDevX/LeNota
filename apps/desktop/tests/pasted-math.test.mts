import assert from 'node:assert/strict';
import test from 'node:test';
import { pastedMathToTiptap } from '../src/features/editor/pasted-math.ts';

test('converts ChatGPT-style Markdown note with mixed inline and display TeX', () => {
  const input = '# Vektörler\n\nÜç boyutlu $A_x$ bileşeni\n\n$$\n\\vec{A}=\\sqrt{A_x^2+A_y^2+A_z^2}\n$$\n\n- $\\alpha=59^\\circ$\n- **Açı:** $\\beta$';
  const result = pastedMathToTiptap(input)!;
  assert.equal(result[0].type, 'heading');
  assert.equal(result[1].content?.[1].type, 'mathExpression');
  assert.equal(result[2].content?.[0].attrs?.display, true);
  assert.equal(result[2].content?.[0].attrs?.latex, '\\vec{A}=\\sqrt{A_x^2+A_y^2+A_z^2}');
  assert.equal(result[3].type, 'bulletList');
  assert.equal(result[3].content?.[1].content?.[0].content?.[0].marks?.[0].type, 'bold');
});
test('handles backslash parentheses, brackets, and inline dollars', () => {
  const result = pastedMathToTiptap('A: \\(x+y\\) and \\[z^2\\] and $\\frac{1}{2}$')!;
  const nodes = result[0].content!.filter(n => n.type === 'mathExpression');
  assert.deepEqual(nodes.map(n => n.attrs?.display), [false,true,false]);
});
test('does not convert ordinary notes, escaped dollars, code fences or unclosed TeX', () => {
  for (const text of ['Price $5 and $10 today', 'No equations here', '```tex\n$x^2$\n```', '$x^2'])
    assert.equal(pastedMathToTiptap(text), null, text);
});
test('rejects huge clipboard inputs', () => assert.equal(pastedMathToTiptap('$$x$$'.repeat(60_000)), null));
