// ============================================================
// D-008 — FAA SDR CSV 에서 엔진 블레이드·베인 사례를 ExternalCase 로 적재
//   레포에 기존 ETL 스크립트가 없어 새로 작성. Node 내장 모듈만 사용(무설치).
//
//   실행:
//     node seed/load_sdr_blade.js <neo4j비밀번호>
//     node seed/load_sdr_blade.js --dry     # 적재 없이 무엇이 들어갈지만 출력
//
//   선행: seed/d008_blade.cypher 를 먼저 실행 (Part/Defect 노드가 있어야 통계 역산 가능)
//   접속 정보는 server.js와 동일 규칙 (.env 또는 환경변수 NEO4J_URI/USER/PW).
//
//   ※ 통계는 지어내지 않는다 — Part.caseCount 와 OCCURS_ON.weight 를
//     '실제 적재된 ExternalCase 건수'로 역산해 SET 한다.
// ============================================================
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// ── .env 로더 (server.js 13~25행과 동일 규칙) ────────────────
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
const NEO4J_BASE = process.env.NEO4J_URI || 'http://localhost:7474';
const NEO4J_USER = process.env.NEO4J_USER || 'neo4j';
const NEO4J_DB = process.env.NEO4J_DATABASE || 'neo4j';
const PW = ARGS.find(a => !a.startsWith('--')) || process.env.NEO4J_PW || 'neo4j';
const NEO4J = NEO4J_BASE.replace(/\/$/, '') + '/db/' + NEO4J_DB + '/query/v2';
const AUTH = 'Basic ' + Buffer.from(NEO4J_USER + ':' + PW).toString('base64');

function cypher(statement, parameters) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ statement, parameters: parameters || {} });
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
          const fields = (j.data && j.data.fields) || [];
          const rows = ((j.data && j.data.values) || []).map(v => {
            const o = {}; fields.forEach((f, i) => o[f] = v[i]); return o;
          });
          resolve(rows);
        } catch (e) { reject(new Error('Neo4j 응답 파싱 실패: ' + d.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

// ── CSV 파서 (따옴표·줄바꿈 포함 필드 대응) ──────────────────
function parseCSV(text) {
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ── SDR PartCondition → 온톨로지 결함 코드 ───────────────────
//   KORD(server.js 143행)에 있는 코드로만 매핑. 매핑되지 않는 조건(VIBRATION,
//   STALLED, LEAKING 등 운항 이벤트)은 제외해 화면에 정체불명 코드가 뜨지 않게 한다.
const COND = {
  DAMAGED: 'DAMAGED', 'BIRD INGESTION': 'DAMAGED', BROKEN: 'DAMAGED',
  FAILED: 'DAMAGED', SEPARATED: 'DAMAGED', BURNED: 'DAMAGED',
  CORRODED: 'CORRODED', CORROSION: 'CORRODED',
  CRACKED: 'CRACKED', CRACK: 'CRACKED', CRACKS: 'CRACKED',
  DENTED: 'DENTED', DENT: 'DENTED', NICKED: 'DENTED', NICK: 'DENTED', BENT: 'DENTED',
  WORN: 'WORN', WEAR: 'WORN', ERODED: 'WORN', EROSION: 'WORN',
  GOUGED: 'GOUGED', PUNCTURED: 'PUNCTURED',
};

function extract() {
  const rows = parseCSV(fs.readFileSync(path.join(ROOT, 'data', 'SDR-2026.csv'), 'utf8'));
  const head = rows[0];
  const idx = {}; head.forEach((h, i) => idx[h.trim()] = i);
  const get = (r, k) => ((r[idx[k]] || '') + '').trim();

  const cases = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length < head.length - 5) continue;
    const jasc = get(r, 'JASCCode');
    const partName = get(r, 'PartName').toUpperCase();
    const disc = get(r, 'Discrepancy');
    const engineModel = get(r, 'EngineModel');
    const engineMake = get(r, 'EngineMake');

    // 엔진 문맥(ATA 72 또는 엔진 모델 보유)의 블레이드·베인 사례만
    const isBladePart = /\bBLADES?\b/.test(partName);
    const isVanePart = /\bVANES?\b/.test(partName);
    const mentionsBlade = /\bBLADES?\b/.test(disc.toUpperCase());
    if (!(jasc.startsWith('72') || engineModel)) continue;
    if (!(isBladePart || isVanePart || mentionsBlade)) continue;

    const cond = COND[get(r, 'PartCondition').toUpperCase()];
    if (!cond) continue;                      // 매핑 불가 조건 제외
    if (!disc || disc.length < 30) continue;  // 요약이 빈약하면 제외

    cases.push({
      id: 'SDR-' + (get(r, 'OperatorControlNumber') || i),
      partName: isVanePart ? 'VANE' : 'BLADE',
      aircraft: [engineMake, engineModel].filter(Boolean).join(' ')
                || [get(r, 'AircraftMake'), get(r, 'AircraftModel')].filter(Boolean).join(' ')
                || '타사',
      condition: cond,
      summary: disc.replace(/\s+/g, ' ').slice(0, 400),
      jasc: jasc,
      at: get(r, 'DifficultyDate'),
    });
  }
  const seen = new Set();
  return cases.filter(c => (seen.has(c.id) ? false : (seen.add(c.id), true)));
}

async function main() {
  const cases = extract();
  const byCond = {};
  cases.forEach(c => byCond[c.condition] = (byCond[c.condition] || 0) + 1);

  console.log('  SDR 블레이드/베인 사례 추출: ' + cases.length + '건');
  console.log('  부품별: BLADE ' + cases.filter(c => c.partName === 'BLADE').length
            + ' · VANE ' + cases.filter(c => c.partName === 'VANE').length);
  console.log('  결함별: ' + Object.entries(byCond).map(([k, v]) => k + ' ' + v).join(', '));

  if (DRY) {
    console.log('\n  --dry 모드 — 적재하지 않음. 샘플 3건:');
    cases.slice(0, 3).forEach(c =>
      console.log('   · [' + c.condition + '] ' + c.aircraft + ' — ' + c.summary.slice(0, 90)));
    return;
  }

  // 재실행 안전 — 같은 출처의 기존 적재분을 지우고 다시 넣는다
  await cypher(`MATCH (c:ExternalCase {source:'SDR-2026-D008'}) DETACH DELETE c`, {});
  const ins = await cypher(`
    UNWIND $cases AS row
    MERGE (c:ExternalCase {id: row.id})
      SET c.partName   = row.partName,
          c.aircraft   = row.aircraft,
          c.condition  = row.condition,
          c.summary    = row.summary,
          c.jascCode   = row.jasc,
          c.reportedAt = row.at,
          c.source     = 'SDR-2026-D008'
    RETURN count(c) AS n`, { cases });
  console.log('  ✓ ExternalCase 적재: ' + ((ins[0] && ins[0].n) || 0) + '건');

  // ── 통계 역산 — 지어낸 수치 대신 실적재 건수로 채운다 ──────
  const counts = await cypher(`
    UNWIND ['BLADE','VANE'] AS pname
    MATCH (p:Part {name: pname})
    OPTIONAL MATCH (c:ExternalCase {partName: pname, source:'SDR-2026-D008'})
    WITH p, count(c) AS n
    SET p.caseCount = n
    RETURN p.name AS part, n`, {});
  counts.forEach(r => console.log('  ✓ Part.caseCount ' + r.part + ' = ' + r.n));

  const w = await cypher(`
    MATCH (d:Defect)-[r:OCCURS_ON]->(p:Part)
    WHERE p.name IN ['BLADE','VANE']
    OPTIONAL MATCH (c:ExternalCase {partName: p.name, condition: d.name, source:'SDR-2026-D008'})
    WITH d, p, r, count(c) AS n
    SET r.weight = n
    RETURN p.name AS part, d.name AS defect, n ORDER BY n DESC`, {});
  console.log('  ✓ OCCURS_ON.weight 갱신 (실적재 기준):');
  w.forEach(r => console.log('     ' + r.part + ' · ' + r.defect + ' = ' + r.n));
  console.log('\n  ※ 통계는 SDR 실적재에서 역산한 값입니다. 결함 "분류"는 교범 기반이고,');
  console.log('    "건수"는 데이터가 말하는 만큼만 표기됩니다.');
}

main().catch(e => { console.error('  ✗ 실패: ' + e.message); process.exitCode = 1; });
