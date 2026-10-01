// ============================================================
// .cypher 파일 실행기 — cypher-shell 설치 없이 HTTP Query API로 실행
//   (load_sdr_blade.js와 동일한 접속 규칙 / Node 내장 모듈만 사용)
//
//   실행:
//     node seed/run_cypher.js seed/d008_blade.cypher <neo4j비밀번호>
//     node seed/run_cypher.js seed/d008_blade.cypher --dry   # 실행 없이 문장만 확인
//
//   접속 정보: .env 또는 환경변수 NEO4J_URI / NEO4J_USER / NEO4J_PW / NEO4J_DATABASE
//
//   ※ Neo4j Aura 주의 — URI·USER·DATABASE 세 값이 모두 인스턴스 ID다.
//     NEO4J_DATABASE를 빠뜨리면 기본값 'neo4j'로 접속해 "Invalid credential"이 뜬다.
//     (비밀번호 문제로 오해하기 쉬움 — 실제로는 DB 이름 불일치)
//     예:  NEO4J_URI=https://xxxxxxxx.databases.neo4j.io
//          NEO4J_USER=xxxxxxxx    NEO4J_DATABASE=xxxxxxxx
// ============================================================
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// ── .env 로더 (server.js와 동일 규칙) ────────────────────────
try {
  const envPath = path.join(ROOT, '.env');
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').replace(/^﻿/, '').split(/\r?\n/).forEach(line => {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    });
  }
} catch (e) {}

const ARGS = process.argv.slice(2);
const DRY = ARGS.includes('--dry');
const positional = ARGS.filter(a => !a.startsWith('--'));
const FILE = positional[0];
if (!FILE) {
  console.error('사용법: node seed/run_cypher.js <파일.cypher> [비밀번호] [--dry]');
  process.exit(1);
}

const NEO4J_BASE = process.env.NEO4J_URI || 'http://localhost:7474';
const NEO4J_USER = process.env.NEO4J_USER || 'neo4j';
const NEO4J_DB = process.env.NEO4J_DATABASE || 'neo4j';
const PW = positional[1] || process.env.NEO4J_PW || 'neo4j';
const NEO4J = NEO4J_BASE.replace(/\/$/, '') + '/db/' + NEO4J_DB + '/query/v2';
const AUTH = 'Basic ' + Buffer.from(NEO4J_USER + ':' + PW).toString('base64');

function cypher(statement) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ statement, parameters: {} });
    const lib = NEO4J.startsWith('https') ? https : http;
    const req = lib.request(NEO4J, {
      method: 'POST',
      headers: { 'Authorization': AUTH, 'Content-Type': 'application/json',
                 'Accept': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      res.setEncoding('utf8');   // 청크 경계에서 한글이 잘리지 않게
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          if (j.errors && j.errors.length) return reject(new Error(j.errors[0].message));
          resolve(j);
        } catch (e) { reject(new Error('응답 파싱 실패: ' + d.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

// ── .cypher 파일 → 문장 배열 (주석 제거 후 세미콜론 분리) ────
function splitStatements(text) {
  const noComment = text.replace(/^﻿/, '')
    .split(/\r?\n/)
    .filter(l => !/^\s*\/\//.test(l))     // // 주석 줄 제거
    .join('\n');
  return noComment.split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

(async () => {
  const filePath = path.isAbsolute(FILE) ? FILE : path.join(process.cwd(), FILE);
  if (!fs.existsSync(filePath)) {
    console.error('파일을 찾을 수 없습니다:', filePath);
    process.exit(1);
  }
  const stmts = splitStatements(fs.readFileSync(filePath, 'utf8'));
  console.log('\n  파일:', path.basename(filePath));
  console.log('  실행할 Cypher 문장:', stmts.length + '개');
  console.log('  접속:', NEO4J_BASE, '/ user:', NEO4J_USER, '/ db:', NEO4J_DB);

  if (DRY) {
    console.log('\n  --dry 모드 — 실행하지 않음. 앞 3개 미리보기:');
    stmts.slice(0, 3).forEach((s, i) => console.log('   [' + (i + 1) + '] ' + s.split('\n')[0].slice(0, 80)));
    return;
  }

  let ok = 0, fail = 0;
  for (let i = 0; i < stmts.length; i++) {
    const head = stmts[i].split('\n')[0].slice(0, 60);
    try {
      await cypher(stmts[i]);
      ok++;
      process.stdout.write('.');
    } catch (e) {
      fail++;
      console.log('\n  ✗ [' + (i + 1) + '] ' + head);
      console.log('     → ' + e.message);
    }
  }
  console.log('\n\n  완료 — 성공 ' + ok + ' / 실패 ' + fail);
  if (fail === 0) console.log('  다음 단계:  node seed/load_sdr_blade.js <비밀번호>\n');
})();
