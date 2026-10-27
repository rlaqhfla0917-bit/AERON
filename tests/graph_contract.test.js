'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

test('Neo4j HTTP response is mapped to scoped, sourced RAG context', async () => {
  const requests = [];
  const graph = http.createServer((req,res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const payload = JSON.parse(body);
      requests.push({url:req.url, auth:req.headers.authorization, ...payload});
      const isProcedure = payload.statement.includes('RETURN pr.name AS procedure');
      const fields = isProcedure
        ? ['procedure','steps','tools','warnings','source']
        : ['part','total','defects','cases'];
      const values = isProcedure
        ? [['BLADE 검사 절차',['관련 표면 기록'],['Inspection light'],[{text:'교범 확인',type:'CAUTION'}],'가상 교범']]
        : [['BLADE',2,[{name:'CRACKED',weight:2}],[{sum:'시료 외관 검사 사례',ac:'A320'}]]];
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({data:{fields,values}}));
    });
  });
  await new Promise(resolve => graph.listen(0,'127.0.0.1',resolve));
  const oldUri = process.env.NEO4J_URI;
  const oldPw = process.env.NEO4J_PW;
  try {
    process.env.NEO4J_URI = 'http://127.0.0.1:' + graph.address().port;
    process.env.NEO4J_PW = 'fixture-password';
    const {buildContext} = require('../server');
    const result = await buildContext('블레이드 검사 절차', null);
    assert.equal(result.part,'BLADE');
    assert.match(result.context,/결함 보고 총 2건/);
    assert.match(result.context,/검사 절차/);
    assert.match(result.context,/교범 확인/);
    assert.equal(requests.length,2);
    assert(requests.every(x => x.url === '/db/neo4j/query/v2'));
    assert(requests.every(x => x.parameters.part === 'BLADE'));
    assert(requests.every(x => x.auth.startsWith('Basic ')));
  } finally {
    if(oldUri === undefined) delete process.env.NEO4J_URI; else process.env.NEO4J_URI=oldUri;
    if(oldPw === undefined) delete process.env.NEO4J_PW; else process.env.NEO4J_PW=oldPw;
    await new Promise(resolve => graph.close(resolve));
  }
});
