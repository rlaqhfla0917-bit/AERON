'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {classifyIntent, composeAnswer} = require('../server');
test('Korean maintenance question intent', () => {
  assert.equal(classifyIntent('검사 절차 알려줘'), 'procedure');
  assert.equal(classifyIntent('필요 공구 뭐야'), 'tool');
  assert.equal(classifyIntent('과거 사례 보여줘'), 'case');
  assert.equal(classifyIntent('작업 시 주의사항'), 'warning');
});
test('fallback without inventing procedures', () => {
  const result = composeAnswer('procedure','BLADE',null,[]);
  assert.match(result.text, /조회되지 않았어요/);
  assert.deepEqual(result.data, {});
});
test('summarize defects from retrieved context', () => {
  const result = composeAnswer('stat','BLADE',{total:3,defects:[{name:'CRACKED',weight:2}]},[]);
  assert.match(result.text, /총 3건/);
  assert.match(result.text, /균열 2건/);
});
test('unknown request results in follow-up options', () => {
  const result = composeAnswer('summary','BLADE',null,[]);
  assert.ok(result.chips.includes('검사 절차'));
});
