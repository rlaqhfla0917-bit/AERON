// ============================================================
// MRO Copilot — 로컬 서비스 서버 (Node 내장 기능만, 무설치)
// 브라우저 → 이 서버 → Neo4j HTTP Query API → 실데이터
// 실행:  node server.js <neo4j비밀번호>
//   예)  node server.js my-password
// 접속:  http://localhost:5173
// ============================================================
const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const {resolvePublicFile, isTrustedOrigin} = require('./security');

// ── .env 로컬 로더 (있으면 읽음) — 무설치, 의존성 없음 ──────
// 서비스/.env 에 KEY=VALUE 한 줄씩 넣어두면 자동으로 읽음.
// .env 는 .gitignore 로 깃에서 제외됨 → 키·비번이 코드/깃에 안 박힘.
// (이미 설정된 환경변수가 우선 — Render 등 클라우드에선 .env 없이 환경변수로)
try{
  const envPath = path.join(__dirname, '.env');
  if(fs.existsSync(envPath)){
    fs.readFileSync(envPath,'utf8').replace(/^﻿/,'').split(/\r?\n/).forEach(line=>{
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
      if(m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g,'');
    });
  }
}catch(e){}

const PORT   = process.env.PORT || 5173;
// Neo4j 접속 — 환경변수 있으면 클라우드(Aura), 없으면 로컬
//   로컬:  node server.js <비밀번호>
//   Aura:  NEO4J_URI, NEO4J_USER, NEO4J_PW 환경변수로 지정
const NEO4J_BASE = process.env.NEO4J_URI || 'http://localhost:7474';
const NEO4J_USER = process.env.NEO4J_USER || 'neo4j';
const NEO4J_DB   = process.env.NEO4J_DATABASE || 'neo4j';
const PW     = process.env.NEO4J_PW || process.argv[2] || '';
const NEO4J  = NEO4J_BASE.replace(/\/$/,'') + '/db/' + NEO4J_DB + '/query/v2';
const AUTH   = 'Basic ' + Buffer.from(NEO4J_USER + ':' + PW).toString('base64');
const ROOT   = __dirname;

// ── LLM 설정 ────────────────────────────────────────────────
// 키가 있으면 RAG+LLM, 없으면 자동으로 규칙 기반 fallback (데모 안전장치).
// provider 자동 감지: ANTHROPIC_API_KEY 있으면 Claude, 아니면 GEMINI_API_KEY로 제미나이.
//   → 팀에서 provider를 바꿔도 환경변수만 갈면 되고 코드는 그대로.
const GEMINI_KEY     = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL   = process.env.GEMINI_MODEL || 'gemini-flash-latest';
// 한 모델이 할당량에 걸려도 답이 나가게 — 순서대로 넘어가며 시도한다.
//   'latest' 별칭은 최신 모델을 가리켜 무료 한도가 빡빡하다. 막히면 안정판으로 내려간다.
const GEMINI_CHAIN   = (process.env.GEMINI_MODELS
  || [GEMINI_MODEL, 'gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-1.5-flash'].join(','))
  .split(',').map(s=>s.trim()).filter(Boolean)
  .filter((m,i,a)=>a.indexOf(m)===i);
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL= process.env.ANTHROPIC_MODEL || 'claude-opus-5'; // 비용 아끼려면 claude-haiku-4-5
const LLM_PROVIDER   = process.env.LLM_PROVIDER || (ANTHROPIC_KEY ? 'anthropic' : (GEMINI_KEY ? 'gemini' : 'none'));
const LLM_ON         = LLM_PROVIDER==='anthropic' ? !!ANTHROPIC_KEY
                     : LLM_PROVIDER==='gemini'    ? !!GEMINI_KEY : false;
const LLM_MODEL      = LLM_PROVIDER==='anthropic' ? ANTHROPIC_MODEL : GEMINI_MODEL;

// ── 현장용어사전 로드 (음성/텍스트 현장어 → 표준어) ─────────
// 대한항공 정비사 VOC + 검색. RAG 근거와 부품 해석 양쪽에 사용.
let FIELD_TERMS = [];
try{
  const localTerms = path.join(ROOT, '현장용어사전.csv');
  const sampleTerms = path.join(ROOT, 'sample_field_terms.csv');
  const raw = fs.readFileSync(fs.existsSync(localTerms) ? localTerms : sampleTerms, 'utf8').replace(/^﻿/,'');
  FIELD_TERMS = raw.split(/\r?\n/).slice(1).filter(Boolean).map(line=>{
    const c = line.split(',');
    return {term:c[0], std:c[1], cat:c[2], mean:c[3], src:c[4]};
  }).filter(r=>r.term);
}catch(e){ FIELD_TERMS = []; }

// 질문에 들어있는 현장용어 → 표준어 매핑 목록
function slangHits(q){
  const s = (q||'');
  const seen = new Set(); const out = [];
  for(const r of FIELD_TERMS){
    if(r.term && s.includes(r.term) && !seen.has(r.std)){ seen.add(r.std); out.push(r); }
  }
  return out;
}

// ── 한국어/구어 → 부품명 사전 (자연어 매칭) ────────────────
const SYNONYM = {
  // 엔진 (ATA 72) — D-008 대표 시나리오: 오버홀 중 분해된 HPC 블레이드 외관검사
  '블레이드':'BLADE','blade':'BLADE','에어포일':'BLADE','airfoil':'BLADE','날개깃':'BLADE',
  '베인':'VANE','vane':'VANE','정익':'VANE',
  // 기체 구조 (ATA 53) — 기존 자산. 별칭 유지: 축적된 지식그래프 검색 호환
  '외판':'SKIN','스킨':'SKIN','skin':'SKIN','표피':'SKIN','판':'SKIN',
  '스트링거':'STRINGER','stringer':'STRINGER','세로재':'STRINGER',
  '프레임':'FRAME','frame':'FRAME','골조':'FRAME',
  '트랙':'TRACK','track':'TRACK','좌석레일':'TRACK','시트트랙':'TRACK','레일':'TRACK',
  '빔':'BEAM','beam':'BEAM','플로어빔':'BEAM','바닥보':'BEAM',
  '패널':'PANEL','panel':'PANEL','플로어패널':'PANEL',
  '앵글':'ANGLE','angle':'ANGLE','ㄱ형강':'ANGLE',
  '웹':'WEB','web':'WEB',
  '서포트':'SUPPORT','support':'SUPPORT','지지대':'SUPPORT','받침':'SUPPORT',
  '브래킷':'BRACKET','bracket':'BRACKET','브라켓':'BRACKET',
  '피팅':'FITTING','fitting':'FITTING','연결구':'FITTING',
  '힌지':'HINGE','hinge':'HINGE','경첩':'HINGE',
  '실':'SILL','sill':'SILL','도어실':'SILL',
  '더블러':'DOUBLER','doubler':'DOUBLER','보강판':'DOUBLER',
  '채널':'CHANNEL','channel':'CHANNEL',
  '거싯':'GUSSET','gusset':'GUSSET',
  '인터코스탈':'INTERCOSTAL','intercostal':'INTERCOSTAL',
  '스티프너':'STIFFENER','stiffener':'STIFFENER','보강재':'STIFFENER',
  '벌크헤드':'BARRIER','격벽':'BARRIER',
  '데크':'DECK','deck':'DECK','프레셔데크':'DECK',
};

// ── Neo4j HTTP Query API 호출 ──────────────────────────────
function cypher(statement, parameters){
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ statement, parameters: parameters || {} });
    const lib = NEO4J.startsWith('https') ? https : http;
    const req = lib.request(NEO4J, {
      method:'POST',
      headers:{ 'Authorization':AUTH, 'Content-Type':'application/json',
                'Accept':'application/json', 'Content-Length':Buffer.byteLength(body) }
    }, res => {
      res.setEncoding('utf8');      // 청크 경계에서 한글이 잘리지 않게
      let d=''; res.on('data',c=>d+=c);
      res.on('end',()=>{
        try{
          const j = JSON.parse(d);
          if(j.errors && j.errors.length) return reject(new Error(j.errors[0].message));
          const fields = (j.data && j.data.fields) || [];
          const rows = ((j.data && j.data.values) || []).map(v=>{
            const o={}; fields.forEach((f,i)=>o[f]=v[i]); return o;
          });
          resolve(rows);
        }catch(e){ reject(new Error('Neo4j 응답 파싱 실패: '+d.slice(0,200))); }
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

// ── ① 의도 파악 (규칙 기반) ────────────────────────────────
// ★ 나중에 LLM으로 교체할 함수. 지금은 키워드로 6종 분류.
function classifyIntent(q){
  const s=(q||'').toLowerCase().replace(/\s/g,'');
  if(/조심|주의|알아야|유의|위험|경고|안전/.test(s)) return 'warning';
  if(/어떻게|절차|방법|순서|어떤식|하는법/.test(s))   return 'procedure';
  if(/공구|장비|챙겨|준비물|뭐가지고|도구/.test(s))   return 'tool';
  if(/전에|과거|사례|예전|이력|비슷한/.test(s))       return 'case';
  if(/원래|무슨결함|어떤결함|많이|자주|반복|통계/.test(s)) return 'stat';
  return 'summary';  // 애매하면 짧은 요약 + 되물음
}

// ── ③ 답변 생성 (의도별 대화체) ────────────────────────────
// ★ 나중에 LLM으로 교체할 함수. 지금은 조회된 데이터로 템플릿 문장.
const KORD={DAMAGED:'손상',CORRODED:'부식',CRACKED:'균열',DENTED:'찍힘',GOUGED:'긁힘',PUNCTURED:'천공',WORN:'마모'};
function composeAnswer(intent, part, data, procs){
  const total=data?data.total:0;
  const defs=(data&&data.defects||[]).filter(x=>x.name);
  const cases=(data&&data.cases||[]).filter(c=>c.sum);
  const pr=(procs||[]);
  // 절차들에서 공구·주의사항·단계 모으기
  const warns=[], tools=[], steps=[];
  pr.forEach(p=>{ (p.warnings||[]).forEach(w=>w.text&&warns.push(w));
    (p.tools||[]).forEach(t=>tools.push(t)); (p.steps||[]).forEach(s=>steps.push(s)); });
  const uWarns=[...new Map(warns.map(w=>[w.text,w])).values()];
  const uTools=[...new Set(tools)];
  const partKo = part;

  if(intent==='warning'){
    if(!uWarns.length) return {text:`${partKo} 작업 관련 특별 주의사항은 조회되지 않았어요. 검사 절차를 볼까요?`, chips:['검사 절차','필요 공구'], data:{}};
    const list=uWarns.slice(0,3).map((w,i)=>`${i+1}. ${w.text}`).join('\n');
    return {text:`네, ${partKo} 작업 전 ${uWarns.length}가지 주의하세요.\n\n${list}`,
      chips:['검사 절차','필요 공구','과거 사례'], data:{warnings:uWarns.slice(0,3)}};
  }
  if(intent==='procedure'){
    const p=pr[0];
    if(!p) return {text:`${partKo} 검사 절차가 조회되지 않았어요.`, chips:['주의사항'], data:{}};
    const st=(p.steps||[]).map((s,i)=>`${i+1}. ${s}`).join('\n');
    return {text:`${p.procedure} 절차예요.\n\n${st}`,
      chips:['필요 공구','주의사항','과거 사례'], data:{procedure:p.procedure, steps:p.steps, page:p.page, source:p.source}};
  }
  if(intent==='tool'){
    if(!uTools.length) return {text:`${partKo} 관련 공구가 조회되지 않았어요.`, chips:['검사 절차'], data:{}};
    return {text:`${partKo} 검사엔 이 공구를 챙기세요.\n\n${uTools.map(t=>'· '+t).join('\n')}`,
      chips:['검사 절차','주의사항'], data:{tools:uTools}};
  }
  if(intent==='case'){
    if(!cases.length) return {text:`${partKo}의 좌표 있는 과거 사례가 없어요. 결함 통계를 볼까요?`, chips:['결함 통계'], data:{}};
    const c=cases[0];
    return {text:`네, ${partKo}에서 비슷한 사례가 있었어요.\n\n"${(c.sum||'').slice(0,120)}…"\n(${c.ac||''} · ${c.fs?'FR'+c.fs:''}${c.str?' / STR'+c.str:''})`,
      chips:['검사 절차','주의사항'], data:{cases:cases.slice(0,2)}};
  }
  if(intent==='stat'){
    if(!defs.length) return {text:`${partKo} 결함 통계가 없어요.`, chips:[], data:{}};
    const top=defs.slice(0,3).map(d=>`${KORD[d.name]||d.name} ${d.weight}건`).join(', ');
    return {text:`${partKo}은(는) 총 ${total}건 보고됐고, 많은 순으로 ${top}이에요.`,
      chips:['과거 사례','검사 절차','주의사항'], data:{defects:defs.slice(0,5), total}};
  }
  // summary: 짧게 + 되물음
  const top=defs[0]?(KORD[defs[0].name]||defs[0].name):'결함';
  return {text:`${partKo}에 대해 결함 이력·과거 사례·검사 절차·주의사항을 알려드릴 수 있어요. 무엇이 궁금하세요?`,
    chips:['주의사항','검사 절차','필요 공구','과거 사례','결함 통계'], data:{}};
}

// ── 검색어 → 부품명 해석 ───────────────────────────────────
async function resolvePart(term){
  const raw = (term||'').trim();
  const low = raw.toLowerCase();
  // 1) 사전 정확/부분 매칭
  for(const k of Object.keys(SYNONYM)){
    if(low.includes(k.toLowerCase())) return SYNONYM[k];
  }
  // 2) 영문 토큰이 부품명과 부분일치
  const parts = await cypher('MATCH (p:Part) RETURN p.name AS name, p.caseCount AS c ORDER BY c DESC', {});
  const upper = raw.toUpperCase();
  const hit = parts.find(p => upper.includes(p.name) || p.name.includes(upper));
  if(hit) return hit.name;
  return null;
}

// ── 부품 지식 조회 (서비스① 핵심 질의) ────────────────────
const Q_PART = `
MATCH (p:Part) WHERE toUpper(p.name) = toUpper($part)
OPTIONAL MATCH (p)-[ps:PART_OF]->(s:System)
WITH p, s ORDER BY ps.weight DESC
WITH p, head(collect(s)) AS sys
OPTIONAL MATCH (d:Defect)-[r:OCCURS_ON]->(p)
WITH p, sys, d, r ORDER BY r.weight DESC
WITH p, sys, collect({name:d.name, weight:r.weight}) AS defects
OPTIONAL MATCH (c:ExternalCase {partName:p.name}) WHERE c.summary IS NOT NULL
WITH p, sys, defects, collect({ac:c.aircraft, cond:c.condition, fs:c.fsFrom, str:c.stringer, sum:c.summary}) AS cs
RETURN p.name AS part, p.caseCount AS total, p.confidence AS conf, p.isGeneric AS generic,
       sys.code AS sysCode, sys.name AS sysName, defects, cs[..3] AS cases`;

// ── 부품의 정비절차·공구·주의사항 (FAA 핸드북 지식) ──
// 절차 기준으로 묶어 중복 제거. 어떤 결함에 적용되는지는 defects 로 유지.
const Q_PROCEDURE = `
MATCH (p:Part) WHERE toUpper(p.name)=toUpper($part)
MATCH (d:Defect)-[:OCCURS_ON]->(p)
MATCH (d)-[:REQUIRES_PROCEDURE]->(pr:Procedure)
MATCH (pr)-[:TARGETS]->(p)
// Defect 노드는 이름으로만 식별되어 계통 간 공유된다(CORRODED 는 블레이드에도 외판에도 붙는다).
// 결함만 타고 가면 다른 계통 절차까지 나오므로, 절차가 이 부품을 대상으로 하는지 확인한다.
WITH pr, collect(DISTINCT d.name) AS defects
OPTIONAL MATCH (pr)-[:HAS_STEP]->(st:Step)
WITH pr, defects, st ORDER BY st.seq
WITH pr, defects, collect(DISTINCT st.name) AS steps
OPTIONAL MATCH (pr)-[:REQUIRES_TOOL]->(t:Tool)
WITH pr, defects, steps, collect(DISTINCT t.name) AS tools
OPTIONAL MATCH (pr)-[:HAS_WARNING]->(w:SafetyWarning)
OPTIONAL MATCH (pr)-[:SOURCED_FROM]->(doc:Document)
WITH pr, defects, steps, tools,
     collect(DISTINCT {text:w.text, type:w.type, src:w.sourcePage}) AS warnings,
     head(collect(doc.title)) AS source
RETURN pr.name AS procedure, pr.nameEn AS procedureEn, pr.description AS desc,
       pr.sourcePage AS page, defects, steps, tools, warnings, source
ORDER BY pr.id`;

// 환류 사례 포함 여부(검증사례)
const Q_VERIFIED = `
MATCH (v:VerifiedCase)-[:ON_PART]->(p:Part) WHERE toUpper(p.name)=toUpper($part)
RETURN v.aircraft AS ac, v.condition AS cond, v.fsFrom AS fs, v.stringer AS str,
       v.action AS action, v.approvedBy AS by, v.approvedAt AS at`;

// ── 서비스② 오케스트레이션 — 작업지시 흐름 ─────────────────
const Q_WORKORDER = `
MATCH (w:WorkOrder {id:$wo})
OPTIONAL MATCH (w)-[:TARGETS]->(p:Part)
OPTIONAL MATCH (w)-[:TARGETS]->(s:System)
WITH w, head(collect(DISTINCT p.name)) AS partName, head(collect(DISTINCT s.code)) AS sysCode
MATCH (w)-[:CONSISTS_OF]->(st:Step)
WITH w, partName, sysCode, st ORDER BY st.seq
RETURN w.id AS wo, w.purpose AS purpose, w.aircraft AS aircraft, w.locationText AS loc,
       w.status AS status, partName, sysCode,
       collect({seq:st.seq, name:st.name, risk:st.riskLevel, approval:st.approvalRequired, status:st.status}) AS steps`;

const Q_JUDGMENT = `
MATCH (c:DefectCandidate)-[:JUDGED_BY]->(j:Judgment)-[:CONFIRMS]->(d:Defect)
OPTIONAL MATCH (j)-[:RESULTED_IN]->(a:Action)
RETURN c.id AS cand, c.confidence AS conf, j.verdict AS verdict, j.judgedBy AS by,
       j.at AS at, d.name AS defect, a.type AS action`;

// ── 서비스③ 로봇 HUD — 검사 시나리오 ──────────────────────
const Q_ROBOT = `
MATCH (l:InspectionLocation {id:'LOC-01'})
OPTIONAL MATCH (ev:EvidenceItem {id:'EV-01'})
OPTIONAL MATCH (c:DefectCandidate {id:'CAND-01'})
RETURN l.fsFrom AS fs, l.stringer AS str, l.areaName AS area, l.blindSpot AS blind,
       l.accessDifficulty AS access, ev.qualityScore AS quality, ev.retake AS retake,
       c.confidence AS candConf, c.bbox AS bbox`;

// ============================================================
// LLM + RAG — 자유 질문·추론·현장어 대응 (규칙 기반 위에 얹음)
//   [현장어 정규화] → [Neo4j·교범 근거 검색(RAG)] → [LLM 답변]
//   근거 밖은 답하지 않게 제약(환각 억제). 실패하면 규칙 기반으로 fallback.
// ============================================================
const SYS_PROMPT = `당신은 'MRO Copilot', 항공정비 현장에서 정비사를 돕는 음성·텍스트 도우미입니다. 옆에서 같이 일하는 선배 정비사처럼, 자연스럽고 편안한 한국어 대화체로 답하세요.

[대화 방식]
- 근거를 그대로 베껴 나열하지 말고, 이해한 내용을 자연스러운 문장으로 풀어 설명하세요. 절차처럼 단계가 중요할 땐 짧은 목록을 쓰되, 앞뒤를 말로 이어 붙이세요.
- 이건 하나로 이어지는 대화입니다. 앞선 대화를 기억하고 맥락을 이어받아 답하세요. "그건", "아까 그거", "그럼?" 같은 말도 이전 흐름으로 이해하세요. 같은 말을 반복하지 말고 이어서 대답하세요.
- 핵심부터 말하고 너무 길지 않게. 보통 2~4문장, 절차 설명은 조금 더 길어도 됩니다.

[무엇을 어떻게 답할지 — 질문을 세 종류로 나눠 판단하세요]

① 이 작업·이 부품에 대한 질문 (검사 절차, 결함 이력, 과거 사례, 주의사항, 지금 필요한 공구)
   → 아래 [근거]에 있는 내용으로만 답하세요. 근거에 없으면 "그건 제 자료엔 없어요"라고 말하고
     대신 무엇을 알려줄 수 있는지 제안하세요.

② 정비 일반 상식 (공구가 무엇인지, 용어의 뜻, 장비의 용도, 결함 유형의 일반적 성격)
   → 근거에 없더라도 아는 대로 설명하세요. 이건 지어내는 것이 아니라 상식입니다.
     예: "토크 렌치가 뭐야?" → 규정 토크로 조이는 공구라고 설명.
     설명 끝에 이 작업의 근거와 연결해 주고, 규격·수치가 걸린 부분은
     "정확한 값은 해당 엔진 정비교범(EM/AMM)을 보셔야 합니다"라고 덧붙이세요.

③ 허용한도·수치·합격 기준 (균열 길이 몇 mm까지 허용인지 등)
   → 값을 말하지 마세요. 교범 소관입니다. "교범(EM/AMM) 기준을 확인하셔야 합니다"라고 안내하세요.

[근거가 서로 다를 때]
- 같은 항목(공구, 촬영 횟수 등)이 여러 근거에 나오면 '[이 작업의 …]' 또는 '[로봇 촬영 실적]' 처럼
  지금 작업에 대한 근거를 먼저 믿으세요. '[교범 절차의 참고 공구]'는 일반 절차이지 이 작업의 확정 목록이 아닙니다.
- '요구컷 3장'은 한 번 촬영할 때 찍는 장수이지, 로봇이 몇 번 촬영했는지가 아닙니다. 둘을 섞지 마세요.

[지켜야 할 것]
- 최종 결함 판정은 정비사가 합니다. 당신은 판정하지 않고 정보만 제공하세요.
- 현장용어(메가네·야마·복스 등)로 물어도 이해하고, 필요하면 표준용어를 함께 알려주세요.
- 이름을 물으면 'MRO Copilot'이라고 답하고, 무엇을 할 수 있냐고 물으면: 부품 결함 이력·검사 절차·필요 공구·주의사항·과거 사례 안내, 로봇 촬영 결과 정리, 작업기록 초안 도움 을 한다고 답하세요.`;

// Gemini generateContent 호출 (Node 내장 https만) — model 은 GEMINI_CHAIN 에서 넘어온다
function geminiCall(model, system, turns){
  return new Promise((resolve, reject)=>{
    const contents = turns.map(t=>({ role: t.role==='model'?'model':'user', parts:[{text:t.text}] }));
    const payload = JSON.stringify({
      system_instruction:{ parts:[{text:system}] },
      contents,
      // gemini-flash-latest는 thinking 모델 → 생각이 토큰을 먹어 답이 잘림.
      // 생각 끄기(thinkingBudget:0)는 이 모델에서 빈 응답 → 대신 여유를 넉넉히 준다.
      //   2048로는 생각만 하다 끝나 '빈 응답'으로 떨어지는 일이 잦았다.
      generationConfig:{ temperature:0.6, maxOutputTokens:8192 }  // 자연스러움 위해 온도↑
    });
    const req = https.request({
      method:'POST',
      hostname:'generativelanguage.googleapis.com',
      path:'/v1beta/models/'+model+':generateContent?key='+GEMINI_KEY,
      headers:{ 'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(payload) }
    }, r=>{
      r.setEncoding('utf8');        // 청크 경계에서 한글이 잘리지 않게
      let d=''; r.on('data',c=>d+=c);
      r.on('end',()=>{
        try{
          const j = JSON.parse(d);
          if(j.error) return reject(new Error(j.error.message||'gemini error'));
          const cand = (j.candidates||[])[0]||{};
          const parts = (cand.content||{}).parts || [];
          const text = (parts.find(p=>p && p.text)||{}).text || '';  // 생각 파트 건너뛰고 텍스트만
          if(!text) return reject(new Error('빈 응답'));
          resolve(text.trim());
        }catch(e){ reject(new Error('Gemini 파싱 실패: '+d.slice(0,150))); }
      });
    });
    req.on('error', reject);
    req.write(payload); req.end();
  });
}

// 모델 체인을 순서대로 시도 — 하나가 할당량·빈 응답으로 막혀도 다음 모델이 답한다.
async function geminiComplete(system, turns){
  const fails = [];
  for(const model of GEMINI_CHAIN){
    try{
      const text = await geminiCall(model, system, turns);
      if(model !== GEMINI_CHAIN[0]) console.log('  · LLM 대체모델 사용: '+model);
      return text;
    }catch(e){
      // 마지막 모델의 사유만 남기면 앞 모델이 왜 막혔는지 알 수 없다 — 전부 모아서 올린다.
      fails.push(model+': '+e.message);
      console.log('  ! '+model+' 실패('+e.message+')');
    }
  }
  throw new Error(fails.join(' | ') || 'LLM 실패');
}

// Claude (Anthropic Messages API) 호출 (Node 내장 https만)
function anthropicComplete(system, turns){
  return new Promise((resolve, reject)=>{
    const messages = turns.map(t=>({ role: t.role==='model'?'assistant':'user', content: t.text }));
    const payload = JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 2000,          // 짧은 답이지만 생각 토큰 여유 포함
      system,
      messages
    });
    const req = https.request({
      method:'POST',
      hostname:'api.anthropic.com',
      path:'/v1/messages',
      headers:{ 'x-api-key':ANTHROPIC_KEY, 'anthropic-version':'2023-06-01',
                'content-type':'application/json', 'content-length':Buffer.byteLength(payload) }
    }, r=>{
      r.setEncoding('utf8');        // 청크 경계에서 한글이 잘리지 않게
      let d=''; r.on('data',c=>d+=c);
      r.on('end',()=>{
        try{
          const j = JSON.parse(d);
          if(j.type==='error' || j.error) return reject(new Error((j.error&&j.error.message)||'anthropic error'));
          if(j.stop_reason==='refusal') return reject(new Error('안전상 거부됨'));
          const blk = (j.content||[]).find(b=>b.type==='text') || {};
          const text = blk.text || '';
          if(!text) return reject(new Error('빈 응답'));
          resolve(text.trim());
        }catch(e){ reject(new Error('Anthropic 파싱 실패: '+d.slice(0,150))); }
      });
    });
    req.on('error', reject);
    req.write(payload); req.end();
  });
}

// provider 디스패처 — answerLLM은 이것만 부른다 (교체 지점 일원화)
function llmComplete(system, turns){
  return LLM_PROVIDER==='anthropic' ? anthropicComplete(system, turns)
                                    : geminiComplete(system, turns);
}

// RAG: 질문에서 부품·현장어를 뽑아 Neo4j·교범 근거를 텍스트로 조립
async function buildContext(q, wctx){
  const hits = slangHits(q);
  // Neo4j 죽어있어도 LLM은 호출되게 — 각 조회를 개별 try/catch로 감쌈
  let part='BLADE', data=null, procs=[];
  try{ part = await resolvePart(q) || 'BLADE'; }catch(e){}
  try{ data = (await cypher(Q_PART, {part}))[0] || null; }catch(e){}
  try{ procs = await cypher(Q_PROCEDURE, {part}); }catch(e){}
  const L=[];
  if(data){
    L.push(`[부품] ${data.part} — 결함 보고 총 ${data.total||0}건`);
    const defs=(data.defects||[]).filter(x=>x.name).slice(0,5).map(d=>`${KORD[d.name]||d.name} ${d.weight}건`).join(', ');
    if(defs) L.push(`[결함 통계] ${defs}`);
    const cs=(data.cases||[]).filter(c=>c.sum)[0];
    if(cs) L.push(`[과거 사례] "${(cs.sum||'').slice(0,120)}" (${cs.ac||''}${cs.fs?' · FR'+cs.fs:''})`);
  }
  const p=procs[0];
  if(p && (p.steps||[]).length) L.push(`[검사 절차] ${p.procedure}: `+p.steps.map((s,i)=>`${i+1})${s}`).join(' '));
  const tools=[...new Set([].concat(...procs.map(x=>x.tools||[])))];
  if(tools.length) L.push(`[교범 절차의 참고 공구] ${tools.join(', ')}`);
  const warns=[...new Map([].concat(...procs.map(x=>x.warnings||[])).filter(w=>w&&w.text).map(w=>[w.text,w])).values()].slice(0,4);
  if(warns.length) L.push(`[주의사항] `+warns.map((w,i)=>`${i+1})${w.text}`).join(' '));
  if(hits.length) L.push(`[현장용어] `+hits.map(h=>`'${h.term}'=${h.std}`).join(', '));
  // 정비사가 지금 보고 있는 작업 — 화면과 챗봇이 같은 것을 보게 한다.
  //   (이게 없으면 화면에 뜬 공구를 챗봇이 "없다"고 답한다)
  if(wctx && (wctx.id || wctx.defect)){
    const w = WORKS.find(x=>x.id===wctx.id);
    L.push(`[지금 작업] ${wctx.id||''} ${w?w.ac:''} ${w?w.area:''} — ${wctx.defect||(w&&w.defect)||''} 판정 대기`);
    if(wctx.next) L.push(`[다음 조치] ${wctx.next}`);
    if(Array.isArray(wctx.acts) && wctx.acts.length)
      L.push(`[조치 순서] ` + wctx.acts.map((a,i)=>`${i+1})${a}`).join(' '));
    if(Array.isArray(wctx.tools) && wctx.tools.length)
      L.push(`[이 작업의 필요 공구 — 정비사 화면에 표시된 확정 목록] ${wctx.tools.join(', ')}`);
    if(w && w.qc && w.qc.attempts && w.qc.attempts.length){
      const last = w.qc.attempts[w.qc.attempts.length-1];
      const fa   = w.qc.attempts.find(a=>a.result==='FAIL');
      L.push(`[로봇 촬영 실적] 이 블레이드는 로봇이 ${w.qc.shots}회 촬영했고 `
        + `최종 사진에 담긴 비율은 ${Math.round(last.coverage*100)}% 입니다`
        + (fa ? ` (1차 ${Math.round(fa.coverage*100)}% 불합격 — ${fa.reason} → ${fa.replan?fa.replan.detail:'자세 재계산'} 후 재촬영)` : ''));
    }
  }
  return { part, context:L.join('\n') };
}

// LLM 경로: 근거 조립 → Gemini → 답변 + 이어가기 칩
async function answerLLM(q, history, wctx){
  const ctx = await buildContext(q, wctx);
  const userMsg = `[근거]\n${ctx.context || '(관련 근거 없음)'}\n\n[질문]\n${q}`;
  // 최근 대화(최대 6턴)를 앞에 붙여 맥락 유지
  const turns = [];
  (Array.isArray(history)?history:[]).slice(-6).forEach(h=>{
    const t = (h && h.text || '').trim(); if(!t) return;
    turns.push({ role: h.role==='bot' ? 'model' : 'user', text: t });
  });
  turns.push({ role:'user', text: userMsg });
  while(turns.length && turns[0].role!=='user') turns.shift();  // 첫 턴은 user로 시작
  const text = await llmComplete(SYS_PROMPT, turns);
  return { part:ctx.part, answer:{ text, chips:['검사 절차','필요 공구','주의사항','과거 사례'],
    data:{ source:'FAA-H-8083-31B · Neo4j (RAG)' } } };
}

// ============================================================
// 관리자 대시보드 — 시연 시드 데이터 + 실데이터 집계
//   숫자는 "실측 / 시연 / 검증목표" 3층으로 라벨.
//   PoC 대시보드 = 달성 성과가 아니라 [측정설계 + 목표 + 시연 실측].
//   아래 DEMO_WORK 를 대시보드가 실제로 집계 → "살아있는" 시연.
// ============================================================
function ago(min){ return new Date(Date.now()-min*60000).toISOString(); }

// 정비사 계정 5명 (각자 로봇 페어) — 로그인 시 '누구인지' 선택
const TECHS = [
  {id:'박재현', grade:'숙련', robot:'MR-01', uid:'K-311001'},
  {id:'이수민', grade:'중급', robot:'MR-02', uid:'K-311002'},
  {id:'최동욱', grade:'중급', robot:'MR-03', uid:'K-311003'},
  {id:'김하늘', grade:'신입', robot:'MR-04', uid:'K-311004'},
  {id:'한지원', grade:'신입', robot:'MR-05', uid:'K-311005'},
];
const techOf = id => TECHS.find(t=>t.id===id) || null;

// 오늘의 작업 (라이브 공유 상태) — owner로 정비사별 배정
//   정비사 앱: 자기 작업만(/api/works?tech=). 판정 → completeWork() → 관리자 대시보드 실시간 반영
//   정비사 1인당 8건 생성 (앞 2건 완료 baseline, 나머지 6건 대기) — 시연 깊이 확보
function seedWorks(){
  const defs=[
    ['BLADE','부식','주의',160],['BLADE','균열','긴급',150],['BLADE','찍힘','주의',95],
    ['VANE','찍힘','주의',120],['BLADE','균열','긴급',150],['VANE','부식','주의',130],
    ['BLADE','이상없음','정상',90],['BLADE','마모','주의',145],
  ];
  // 오버홀 대상 엔진 (분해 상태로 샵 입고) — 기체가 아니라 엔진 단위로 작업이 배정됨
  const acs=['CFM56-7B','V2500-A5','GE90-115B','CF34-10E','LEAP-1B'];
  // 검사 위치 = HPC 스테이지 · 블레이드 개체 ID
  const frs=['HPC Stg3 · BLD-012','HPC Stg4 · BLD-017','HPC Stg4 · BLD-042','HPC Stg5 · BLD-008',
             'HPC Stg3 · BLD-031','HPC Stg6 · BLD-023','HPC Stg5 · BLD-055','HPC Stg4 · BLD-061',
             'HPC Stg6 · BLD-004','HPC Stg3 · BLD-049'];
  const arr=[];
  TECHS.forEach((t,ti)=>{
    for(let k=0;k<8;k++){
      // 숙련일수록 더 많이 처리 → 부하(미완료) 차이 발생 (숙련5/중급6/신입7 대기)
      const doneCut = t.grade==='숙련'?3:(t.grade==='중급'?2:1);
      const d=defs[(ti*3+k)%defs.length], done=k<doneCut;
      // 증빙 갭 데모용: 일부 완료건은 직접촬영(사진 자동연결 약함), 일부는 재검사(조치 미완)
      const verd = d[1]==='이상없음' ? '정상' : ((ti+k)%4===3 ? '재검사' : (k===0 ? '수리' : '정상'));
      const cap = done ? ((ti+k)%3!==0) : null;   // true=로봇 촬영, false=직접(사진 증빙 누락)
      // state = Work Order 실행 상태(9단계). status(대기/완료)는 state에서 파생 —
      //   기존 코드가 전부 status 문자열을 보고 있어 그대로 두고 state를 얹는다.
      const st = done ? (verd==='수리' ? 'AWAITING_APPROVAL' : 'COMPLETED') : 'ASSIGNED';
      arr.push({ id:'W-'+(ti+1)+String(k+1).padStart(2,'0'), owner:t.id,
        ac:acs[(ti+k)%acs.length], part:d[0], area:frs[(ti*2+k)%frs.length], defect:d[1], risk:d[2],
        state:st, timeline:[], qc:null,
        status:done?'완료':'대기', robot:cap, verdict:done?verd:null,
        base:d[3], lead:done?Math.round(d[3]*0.8):null, tech:t.grade,
        quality:done?(verd!=='재검사'):null, retake:done&&verd==='재검사', at:done?ago(28+ti*17+k*33):null });
    }
  });
  return arr;
}
// ── Work Order 상태기계 ────────────────────────────────────────────────
//  ASSIGNED → IN_PROGRESS → ROBOT_EXECUTING → QUALITY_CHECK →(FAIL) RECAPTURE → QUALITY_CHECK
//           → AWAITING_INSPECTION →(정비사 판정) COMPLETED | AWAITING_APPROVAL |↺ROBOT_EXECUTING
//  status(대기/완료)는 여기서 파생한다. 수리 판정은 정비사 손을 떠났으므로 '완료'로 본다
//  (관리자 승인만 남은 상태) — 그래야 정비사 목록에 다시 뜨지 않는다.
const STATE_KO = {
  ASSIGNED:'작업 배정', IN_PROGRESS:'작업 시작', ROBOT_EXECUTING:'로봇 검사 중',
  QUALITY_CHECK:'촬영 품질 판정', RECAPTURE:'재촬영', AWAITING_INSPECTION:'정비사 판정 대기',
  AWAITING_APPROVAL:'관리자 승인 대기', COMPLETED:'완료',
};
function statusOf(state){
  return (state==='COMPLETED' || state==='AWAITING_APPROVAL') ? '완료' : '대기';
}
function setState(w, next, by, note){
  if(!w) return w;
  if(w.state===next){   // 같은 상태 재진입 — 이력만 남긴다 (from 을 비우지 않는다)
    if(note){ w.timeline=w.timeline||[];
      w.timeline.push({at:new Date().toISOString(), from:w.state, state:next, by:by||'system', note}); }
    return w;
  }
  w.timeline = w.timeline || [];
  w.timeline.push({at:new Date().toISOString(), from:w.state, state:next, by:by||'system', note:note||''});
  if(w.timeline.length>40) w.timeline.shift();
  w.state  = next;
  w.status = statusOf(next);
  return w;
}
let WORKS = seedWorks();
// 시드 완료건에도 검사 이력을 채운다 — 안 하면 관리자 Drawer 가 '아직 촬영 전'으로 비어 보인다.
//   (값은 작업 ID 시드 기반 재현 — 화면에 'PoC 재현'으로 명시)
function backfill(w){
  if(w.state!=='COMPLETED' && w.state!=='AWAITING_APPROVAL') return;
  qcRun(w);
  const q=w.qc, t0=w.at||new Date().toISOString();
  const push=(state,by,note)=>w.timeline.push({at:t0, state, by, note});
  w.timeline=[];
  push('IN_PROGRESS', w.owner, '작업 시작');
  push('ROBOT_EXECUTING', w.owner, w.robot?'로봇 촬영':'직접 촬영');
  push('QUALITY_CHECK','robot','촬영 품질 판정');
  if(q && q.attempts.length>1){
    const fa=q.attempts[0];
    push('RECAPTURE','robot','1차 '+Math.round(fa.coverage*100)+'% 불합격 — '+fa.reason+' → '+fa.replan.detail);
    push('QUALITY_CHECK','robot','재촬영 후 재판정');
  }
  push('AWAITING_INSPECTION','robot','촬영 '+(q?q.shots:1)+'회 · 최종 '+(q?Math.round(q.attempts[q.attempts.length-1].coverage*100):0)+'% 합격');
  if(w.verdict==='수리'){ push('AWAITING_APPROVAL', w.owner, '수리 판정 — 관리자 승인 요청'); }
  else { push('COMPLETED', w.owner, (w.verdict||'정상')+' 판정 — 완료'); }
}
// 데모 리셋용 초기 스냅샷 (교육생이 작업을 다 완료해도 '새 작업 배정'으로 다시 체험)
//   실제 스냅샷은 아래 backfill 이후에 다시 잡는다 (qcRun 이 쓰는 상수가 그 뒤에 선언되기 때문)
let WORKS_SEED = JSON.parse(JSON.stringify(WORKS));
// ── 가동 보드 라이브 엔진 (LIVE) — 실제 상태만 반영 (정비사↔관리자 100% 일치) ──
//   정비사가 앱에서 단계 보고 → 그 pair만 실시간 진행. 비활성 정비사는 실제 배정 상태(대기 N건/유휴)로 정직 표시.
//   (가짜 자동진행 없음 — 화면과 실제가 절대 어긋나지 않게)
const STEP_NAMES = ['작업 배정','로봇 촬영','AI 이상후보','정비사 판정','작업 기록'];
const STEP_ROBOT = ['이동중','촬영중','대기','대기','대기'];
let LIVE = {};                 // techId -> 세션 라이브 상태 (로그인~로그아웃 동안 유지)
const IDLE_MS = 600000;        // 무보고 10분이면 세션 만료 (탭 닫힘 대비 안전장치)
function clearLive(){ LIVE = {}; }
function clearLiveFor(id){ if(id) delete LIVE[id]; }
// 실제 정비사 단계 진행 보고 → 해당 pair 실시간 갱신 (세션 유지: 작업 사이에도 '작업중')
function reportProgress(techId, workId, step){
  const w=WORKS.find(x=>x.id===workId);
  const id=techId||(w&&w.owner); if(!id||!techOf(id)) return;
  const now=Date.now(); let L=LIVE[id]; if(!L) L=LIVE[id]={ workStart:now };
  const s=Math.max(1,Math.min(4,step||1));
  // 정비사 단계 보고를 Work Order 상태로도 반영한다 (LIVE 세션에만 두면 작업 단위 추적이 안 된다)
  if(w && w.state!=='COMPLETED' && w.state!=='AWAITING_APPROVAL'){
    if(s===1) setState(w, 'IN_PROGRESS', id, '작업 시작');
    else if(s===2) setState(w, 'ROBOT_EXECUTING', id, '로봇 촬영 시작');
    else if(s===3){
      setState(w, 'QUALITY_CHECK', 'robot', '촬영 품질 판정');
      const q = qcRun(w);
      if(q && q.attempts.length>1){
        const fa = q.attempts[0];
        setState(w, 'RECAPTURE', 'robot',
          '1차 '+Math.round(fa.coverage*100)+'% 불합격 — '+fa.reason+' → '+fa.replan.detail);
        setState(w, 'QUALITY_CHECK', 'robot', '재촬영 후 재판정');
      }
    }
    else if(s>=4){
      const q = qcRun(w);
      setState(w, 'AWAITING_INSPECTION', 'robot',
        '촬영 '+(q?q.shots:1)+'회 · 최종 '+(q?Math.round(q.attempts[q.attempts.length-1].coverage*100):0)+'% 합격');
    }
  }
  L.wo = workId?('WO·'+workId):'—';
  L.woId = workId||null;
  L.task = w ? (w.ac+' '+w.part+' '+w.area+' — '+w.defect+' 점검') : '점검';
  L.stepNum=s; L.stepLabel=s+'/5 '+STEP_NAMES[s-1];
  L.robot=STEP_ROBOT[s-1]; L.prog=Math.round(s/5*100); L.status='작업중';
  if(!L.workStart) L.workStart=now; L.lastActive=now;
}
function fmtMin(ms){ return Math.max(0,Math.round(ms/60000))+'분'; }
// 가동보드용 파이프라인 한 줄 요약 — Work Order 의 실제 state/qc 에서만 만든다.
//   tone: blue=진행 amber=재계획.대기 green=합격.완료 red=불합격
function pipeOf(w){
  if(!w) return null;
  const q=w.qc, last=q&&q.attempts[q.attempts.length-1], fail=q&&q.attempts.find(a=>a.result==='FAIL');
  const pct=a=>Math.round(a.coverage*100)+'%';
  switch(w.state){
    case 'IN_PROGRESS':
      return {label:'작업 배정 확인', detail:'로봇 대기', tone:'blue'};
    case 'ROBOT_EXECUTING':
      return {label:'인지 · 촬영', detail:'Indy7 정렬 후 촬영', tone:'blue'};
    case 'QUALITY_CHECK':
      return fail
        ? {label:'품질 판정 · 재계획', detail:'1차 '+pct(fail)+' 불합격 — '+fail.reason, tone:'red'}
        : {label:'품질 판정', detail: last?('사진에 담김 '+pct(last)):'판정 중', tone:'blue'};
    case 'RECAPTURE':
      return {label:'재촬영', detail: fail&&fail.replan?fail.replan.detail:'촬영 자세 재계산', tone:'amber'};
    case 'AWAITING_INSPECTION':
      return {label:'정비사 판정 대기', detail: q?('촬영 '+q.shots+'회 · 최종 '+pct(last)):'증거 확보', tone:'amber'};
    case 'AWAITING_APPROVAL':
      return {label:'관리자 승인 대기', detail:(w.verdict||'수리')+' 판정', tone:'amber'};
    case 'COMPLETED':
      return {label:'완료', detail:(w.verdict||'')+' 판정 기록', tone:'green'};
    default:
      return {label:'배정됨', detail:'착수 전', tone:'gray'};
  }
}
// 가동보드 pair = 로그인 근무 중이면 세션 상태('작업중' 유지), 아니면 실제 배정 상태(대기/유휴)
function livePairs(){
  const now=Date.now();
  return TECHS.map(t=>{
    const L=LIVE[t.id];
    const mine=WORKS.filter(w=>w.owner===t.id);
    const waitN=mine.filter(w=>w.status!=='완료').length, doneN=mine.length-waitN;
    if(L && now-(L.lastActive||0) < IDLE_MS){   // 로그인·근무 중인 세션
      if(waitN===0)   // 배정 작업 다 끝냄
        return { tech:t.id, grade:t.grade, robot:t.robot, rst:'충전중', wo:'—', woId:null, state:null,
          pipe:{label:'유휴', detail:'배정 작업 완료', tone:'gray'},
          task:'배정 작업 모두 완료 · 유휴 (완료 '+doneN+'건)', step:'완료', prog:100, status:'완료',
          elapsed:fmtMin(now-(L.workStart||now)), parallel:null, real:true };
      // 세션(LIVE)과 Work Order 상태가 어긋나지 않게 파생 시점에 한 번 더 맞춘다.
      //   (판정.승인으로 작업이 끝났는데 보드에 '3/5 촬영'이 남는 경우 방지)
      const lw = L.woId ? WORKS.find(x=>x.id===L.woId) : null;
      const closed = lw && (lw.state==='COMPLETED' || lw.state==='AWAITING_APPROVAL');
      return { tech:t.id, grade:t.grade, robot:t.robot, rst: closed?'대기':(L.robot||'대기'),
        wo: closed?'—':(L.wo||'—'), woId: closed?null:(L.woId||null),
        state: closed?null:((lw&&lw.state)||null),
        pipe:  closed?{label:'다음 작업 준비', detail:'직전 작업 완료', tone:'green'}:pipeOf(lw),
        task: closed?('직전 작업 완료('+(lw.verdict||'')+') · 다음 작업 준비'):(L.task||'점검'),
        step: closed?'다음 작업 준비':(L.stepLabel||'—'),
        prog: closed?100:(L.prog||0), status:L.status||'작업중',
        elapsed:fmtMin(now-(L.workStart||now)),
        parallel:(!closed && L.stepNum===2)?'로봇 촬영 중 — 정비사 인접부 육안점검 병행':null, real:true };
    }
    if(L) delete LIVE[t.id];   // 세션 만료 → 정리
    const idle = waitN>0;
    return { tech:t.id, grade:t.grade, robot:t.robot, rst: idle?'대기':'충전중',
      wo:'—', woId:null, state:null,
      pipe: idle?{label:'착수 전', detail:'배정 대기 '+waitN+'건', tone:'gray'}
                :{label:'유휴', detail:'배정 작업 완료', tone:'gray'}, task: idle?('배정 대기 '+waitN+'건 · 완료 '+doneN+'건'):('배정 작업 완료 · 유휴 (완료 '+doneN+'건)'),
      step:'—', prog:0, status: idle?'대기':'유휴', elapsed:'—', parallel:null, real:false };
  });
}
function liveFleet(pairs){
  const m={촬영:0,이동:0,대기:0,충전:0,오류:0};
  (pairs||[]).forEach(p=>{ const r=p.rst;
    if(r==='촬영중')m.촬영++; else if(r==='이동중')m.이동++; else if(r==='충전중')m.충전++; else if(r==='오류')m.오류++; else m.대기++; });
  const dot={촬영:'#2b5fa8',이동:'#2e7d4f',대기:'#9aa3b2',충전:'#d9a514',오류:'#e05243'};
  return Object.entries(m).filter(([k,v])=>v>0||k!=='오류').map(([label,n])=>({label,n,dot:dot[label]}));
}

// ── 데모 자동재생 (혼자 시연용) — 로그인 안 한 정비사가 실제 배정 작업을 자동 진행·완료 ──
//   실제 작업을 처리하므로 화면과 일치 유지. 로그인해 작업 중인 정비사는 절대 건드리지 않음.
//   환류(Neo4j)는 쓰지 않음 — 검증 지식은 사람 승인만 (HITL 유지).
let AUTO = false;
// 자동재생 완료 — 사람이 하는 것과 같은 상태기계를 탄다 (화면과 실제가 어긋나지 않게)
function autoComplete(id){
  const w=WORKS.find(x=>x.id===id);
  if(!w || w.state==='COMPLETED' || w.state==='AWAITING_APPROVAL') return;
  w.robot=true;
  w.verdict = w.defect==='이상없음' ? '정상' : (w.risk==='긴급' ? '수리' : '정상');
  w.retake=false; w.quality=true; w.lead=Math.round(w.base*0.8); w.at=new Date().toISOString();
  qcRun(w);
  if(w.verdict==='수리'){
    setState(w, 'AWAITING_APPROVAL', '자동재생', '수리 판정 — 관리자 승인 요청');
    ACTIVITY.unshift({at:w.at, id:w.id, part:w.part, area:w.area, verdict:'수리', by:'로봇',
      text:w.part+' '+w.defect+' — 수리 판정 → 관리자 승인 대기'});
  }else{
    setState(w, 'COMPLETED', '자동재생', '정상 판정 — 완료');
    ACTIVITY.unshift({at:w.at, id:w.id, part:w.part, area:w.area, verdict:w.verdict, by:'로봇', text:actText(w)});
  }
  if(ACTIVITY.length>60) ACTIVITY.length=60;
}
function autoTick(){
  if(!AUTO) return;
  const now=Date.now();
  TECHS.forEach(t=>{
    const L=LIVE[t.id];
    if(L && !L.auto && now-(L.lastActive||0) < IDLE_MS) return;   // 사람이 실제 작업 중 → 건너뜀
    const waits=WORKS.filter(w=>w.owner===t.id && w.status!=='완료');
    if(!waits.length){ if(L&&L.auto) delete LIVE[t.id]; return; } // 배정 작업 다 함 → 유휴
    let A=(L&&L.auto)?L:(LIVE[t.id]={auto:true, curId:waits[0].id, step:TECHS.indexOf(t)%5, workStart:now}); // 정비사별 시작 단계 stagger
    if(A.charging){   // 완료 직후 충전 페이즈 (로봇 현황에 '충전중' 표시)
      A.charging=false; A.robot='충전중'; A.status='충전/점검'; A.wo='—';
      A.task='로봇 충전·점검 · 다음 작업 준비'; A.stepLabel='충전'; A.stepNum=0; A.prog=0; A.lastActive=now; return;
    }
    A.step=(A.step||0)+1;
    if(A.step>5 || !WORKS.find(w=>w.id===A.curId && w.status!=='완료')){
      if(A.curId) autoComplete(A.curId);                          // 실제 완료 처리
      const next=WORKS.find(w=>w.owner===t.id && w.status!=='완료');
      if(!next){ delete LIVE[t.id]; return; }
      A.curId=next.id; A.step=0; A.workStart=now; A.charging=true; A.lastActive=now; return; // 다음 틱 충전
    }
    const w=WORKS.find(x=>x.id===A.curId), s=Math.max(1,Math.min(5,A.step));
    if(w && w.state!=='COMPLETED' && w.state!=='AWAITING_APPROVAL'){
      if(s===1) setState(w,'IN_PROGRESS','자동재생','작업 시작');
      else if(s===2) setState(w,'ROBOT_EXECUTING','자동재생','로봇 촬영 시작');
      else if(s===3){
        // 품질 판정. 실패면 여기서 한 틱 머문다 -> 보드에 '1차 불합격'이 실제로 보인다
        setState(w,'QUALITY_CHECK','robot','촬영 품질 판정');
        qcRun(w);
      }
      else if(s===4){
        const q=w.qc;
        if(q && q.attempts.length>1){
          // 재촬영도 한 틱 노출 (원인과 재계획 내용을 보드에서 읽을 수 있게)
          const fa=q.attempts[0];
          setState(w,'RECAPTURE','robot','1차 '+Math.round(fa.coverage*100)+'% 불합격 — '+fa.reason+' → '+fa.replan.detail);
        }else{
          setState(w,'AWAITING_INSPECTION','robot','정비사 판정 대기');
        }
      }
      else if(s===5){
        const q=w.qc;
        if(q && q.attempts.length>1) setState(w,'QUALITY_CHECK','robot','재촬영 후 재판정');
        setState(w,'AWAITING_INSPECTION','robot','정비사 판정 대기');
      }
    }
    A.woId=A.curId;
    A.wo='WO·'+A.curId; A.task=w?(w.ac+' '+w.part+' '+w.area+' — '+w.defect+' 점검'):'점검';
    A.stepNum=s;
    // 5단계는 아직 판정 전이다 (판정은 다음 틱의 autoComplete). 라벨을 상태와 맞춘다.
    A.stepLabel = (w && w.state==='RECAPTURE') ? (s+'/5 재촬영')
                : (s===5) ? '5/5 정비사 판정 대기' : (s+'/5 '+STEP_NAMES[s-1]);
    A.robot=STEP_ROBOT[s-1];
    A.prog=Math.round(s/5*100); A.status='작업중'; A.lastActive=now;
  });
}
setInterval(autoTick, 3000);   // 3초마다 한 단계씩
function actText(w){ return w.part+' '+w.defect+' 검사 완료 → '+w.verdict+' ('+(w.robot?'로봇':'직접')+' 촬영)'; }
function deriveActivity(works){
  return works.filter(w=>w.status==='완료')
    .map(w=>({at:w.at, id:w.id, part:w.part, area:w.area, verdict:w.verdict, by:w.robot?'로봇':'직접', text:actText(w)}))
    .sort((a,b)=> a.at<b.at?1:-1);
}
let ACTIVITY = deriveActivity(WORKS);
// 데모 리셋 — 작업 목록·이력을 초기 상태로 복원 (환류로 쌓인 Neo4j 지식은 유지)
function resetWorks(){
  WORKS = JSON.parse(JSON.stringify(WORKS_SEED));
  ACTIVITY = deriveActivity(WORKS);
  clearLive();   // 진행 상태 해제 → 실제 배정 상태로
}

// 환류(write-back) — 승인된 작업을 Neo4j 지식그래프에 검증사례로 축적
//   source:'PoC시연' 태그 → 나중에 시연 데이터만 정리 가능
//   (정리 쿼리:  MATCH (v:VerifiedCase {source:'PoC시연'}) DETACH DELETE v)
const Q_VERIFY_WRITE = `
MERGE (p:Part {name:$part})
CREATE (v:VerifiedCase {id:$id, aircraft:$ac, condition:$cond, action:$verdict,
        approvedBy:$by, owner:$by, capturedBy:$cap, area:$area, approvedAt:$at, source:'PoC시연'})
MERGE (v)-[:ON_PART]->(p)
RETURN v.id AS id`;

// 정비사 판정 → 작업 완료 처리 + 이력 기록 + (승인 시) Neo4j 환류 축적
// 정비사 판정.
//   정상  → 완료 + 환류
//   수리  → 관리자 승인 대기 (승인 시점에 환류)
//   재검사 → 로봇 검사로 되돌림 (작업이 정비사 목록에 다시 뜬다)
async function completeWork(id, capturedBy, verdict){
  const w = WORKS.find(x=>x.id===id);
  if(!w || w.state==='COMPLETED' || w.state==='AWAITING_APPROVAL') return null;
  w.robot   = capturedBy!=='direct';
  w.verdict = verdict || '정상';
  w.retake  = (w.verdict==='재검사');
  w.quality = (w.verdict!=='재검사');
  w.lead    = Math.round(w.base * (w.verdict==='재검사'?0.9:0.8));
  w.at      = new Date().toISOString();

  if(w.verdict==='재검사'){
    // 다시 찍어야 한다 -> 완료가 아니다. 촬영 이력을 비워 새 검사가 돌게 한다.
    w.qc = null;
    setState(w, 'ROBOT_EXECUTING', w.owner||'정비사', '정비사 재검사 요청 — 로봇 재촬영');
    ACTIVITY.unshift({at:w.at, id:w.id, part:w.part, area:w.area, verdict:'재검사',
      by:w.robot?'로봇':'직접', text:w.part+' '+w.defect+' — 정비사 재검사 요청 → 로봇 재촬영 대기'});
    if(ACTIVITY.length>60) ACTIVITY.length=60;
    return w;
  }
  if(w.verdict==='수리'){
    setState(w, 'AWAITING_APPROVAL', w.owner||'정비사', '수리 판정 — 관리자 승인 요청');
    ACTIVITY.unshift({at:w.at, id:w.id, part:w.part, area:w.area, verdict:'수리',
      by:w.robot?'로봇':'직접', text:w.part+' '+w.defect+' — 수리 판정 → 관리자 승인 대기'});
    if(ACTIVITY.length>60) ACTIVITY.length=60;
    return w;
  }
  setState(w, 'COMPLETED', w.owner||'정비사', '정상 판정 — 완료');
  ACTIVITY.unshift({at:w.at, id:w.id, part:w.part, area:w.area, verdict:w.verdict, by:w.robot?'로봇':'직접', text:actText(w)});
  // 환류: 승인(수리/정상)된 작업만 지식그래프에 축적 (HITL). 재검사는 제외.
  w.hwanryu = false;
  if(w.verdict!=='재검사'){
    try{
      await cypher(Q_VERIFY_WRITE, {id:'V-'+w.id+'-'+Date.now(), part:w.part, ac:w.ac,
        cond:w.defect, verdict:w.verdict, by:(w.owner||'정비사'),
        cap:(w.robot?'robot':'direct'), area:(w.area||''), at:w.at});
      w.hwanryu = true;
      console.log('  ↻ 환류 축적: '+w.id+' ('+w.part+' '+w.defect+') → Neo4j VerifiedCase');
    }catch(e){ console.log('  ! 환류 실패: '+e.message); }
  }
  // 가동보드 — 완료 후에도 근무 세션 유지 ('다음 작업 준비'). 로그아웃/유휴 시 대기로 복귀
  if(w.owner && techOf(w.owner)){
    let L=LIVE[w.owner]; if(!L) L=LIVE[w.owner]={ workStart:Date.now() };
    L.wo='—'; L.task='직전 작업 완료('+w.verdict+') · 다음 작업 준비';
    L.stepNum=0; L.stepLabel='다음 작업 준비'; L.robot='대기'; L.prog=100; L.status='작업중';
    L.lastActive=Date.now();
  }
  return w;
}

// 관리자 승인 — 수리 판정 건을 최종 완료 처리하고 그때 환류한다 (HITL)
async function approveWork(id, note){
  const w = WORKS.find(x=>x.id===id);
  if(!w || w.state!=='AWAITING_APPROVAL') return null;
  setState(w, 'COMPLETED', '관리자', note || '수리 판정 승인');
  w.at = new Date().toISOString();
  ACTIVITY.unshift({at:w.at, id:w.id, part:w.part, area:w.area, verdict:w.verdict, by:'관리자',
    text:w.part+' '+w.defect+' 수리 판정 — 관리자 승인 완료'});
  if(ACTIVITY.length>60) ACTIVITY.length=60;
  w.hwanryu = false;
  try{
    await cypher(Q_VERIFY_WRITE, {id:'V-'+w.id+'-'+Date.now(), part:w.part, ac:w.ac,
      cond:w.defect, verdict:w.verdict, by:(w.owner||'정비사'),
      cap:(w.robot?'robot':'direct'), area:(w.area||''), at:w.at});
    w.hwanryu = true;
    console.log('  ↻ 환류 축적(승인): '+w.id+' → Neo4j VerifiedCase');
  }catch(e){ console.log('  ! 환류 실패: '+e.message); }
  return w;
}

// 증빙 완결성 — 완료 작업의 사진/판정/조치/기록 4항목 (관제·KPI: 증빙 자동연결률)
function evChecks(w){
  return { photo: w.robot?1:0,               // 로봇 촬영=자동 연결 / 직접=수동(누락 위험)
           verdict: w.verdict?1:0,           // 정비사 판정
           action: (w.verdict==='재검사')?0:1, // 재검사=조치 미완
           wo: 1 };                          // Work Card 자동 연결
}
const EVNAME={photo:'사진',verdict:'판정',action:'조치',wo:'기록'};
// 결함 유형별 실제 사진 — assets/defects/ 폴더를 스캔해 사례마다 다르게 배정
//   파일명 규칙: {key}-{번호}.jpg  (key: corrosion·crack·dent·wear·damage·puncture·scratch)
function scanDefectImages(){
  try{
    const dir=path.join(ROOT,'assets','defects'), map={};
    fs.readdirSync(dir).forEach(f=>{ const m=/^([a-z]+)-\d+\.(jpe?g|png|webp)$/i.exec(f);
      if(m){ const k=m[1].toLowerCase(); (map[k]=map[k]||[]).push('assets/defects/'+f); } });
    Object.values(map).forEach(a=>a.sort());
    return map;
  }catch(e){ return {}; }   // 폴더 없으면 빈 맵 → 프론트가 스키매틱으로 대체
}
// 작업에 붙일 결함 사진 — 폴더를 스캔해 결함 종류에 맞는 것 중 작업 ID로 하나 고정.
//   서버가 고르므로 정비사 화면과 관리자 화면이 같은 사진을 본다.
const DEFECT_KEY = {'부식':'corrosion','균열':'crack','찍힘':'dent','마모':'wear',
                    '손상':'damage','천공':'puncture','긁힘':'scratch',
                    '이상없음':'normal'};   // 결함 없는 블레이드 사진
function pickDefectImage(w){
  if(!w) return null;
  const pool = (scanDefectImages()[DEFECT_KEY[w.defect]]) || [];
  if(!pool.length) return null;
  return pool[_seed(w.id) % pool.length];
}

// 케이스의 담당 정비사 유추 — 저장된 owner 우선, 없으면 case id(V-W-{n}xx)에서
function caseTech(v){
  let name = (v.owner || v.by || '');
  if(!techOf(name)){ const m=/W-(\d)/.exec(v.id||''); if(m){ const t=TECHS[(+m[1])-1]; if(t) name=t.id; } }
  return techOf(name) || null;
}

async function buildDashboard(){
  const W = WORKS, cnt = f => W.filter(f).length, done = W.filter(w=>w.status==='완료');
  const waiting = W.filter(w=>w.status!=='완료');
  const pairs = livePairs();   // 가동보드 (실제 상태) — 한 번 계산해 재사용
  // ── 오늘 현황
  const today = { total:W.length, done:done.length, ongoing:waiting.length,
                  urgent:cnt(w=>w.risk==='긴급'), delayed:cnt(w=>w.status!=='완료'&&w.risk==='긴급') };
  // ── 품질·활용
  const ops = { defects:cnt(w=>w.status==='완료'&&w.defect!=='이상없음'), retake:cnt(w=>w.retake),
                robotRate: done.length?Math.round(done.filter(w=>w.robot).length/done.length*100):0,
                approvalWait:cnt(w=>w.state==='AWAITING_APPROVAL') };
  // ── 병목 (라이브 파생)
  const bottleneck = { '검사 대기':waiting.length,
                       '승인 대기':cnt(w=>w.state==='AWAITING_APPROVAL'),
                       '재검사':cnt(w=>w.retake) };
  // ── 결함 Top3 (완료 기준)
  const dm={}; W.forEach(w=>{ if(w.status==='완료'&&w.defect!=='이상없음') dm[w.defect]=(dm[w.defect]||0)+1; });
  const defectTop = Object.entries(dm).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([name,n])=>({name,n}));
  // ── HERO ① 작업효율(실측)
  const redu = done.filter(w=>w.base&&w.lead).map(w=>(w.base-w.lead)/w.base);
  const efficiency = redu.length?Math.round(redu.reduce((a,b)=>a+b,0)/redu.length*100):0;
  const savedMin = done.reduce((a,w)=>a+((w.base&&w.lead)?(w.base-w.lead):0),0);
  // ── HERO ② 정비품질(실측)
  const quality = done.length?Math.round(done.filter(w=>w.quality).length/done.length*100):0;
  // ── 지식그래프 기반 KPI (Neo4j 연결) — 관리자는 그래프에서 KPI를 도출
  let gCases=null, gVerified=null, gParts=null, gDefTypes=null, gProc=null, gTool=null, gTop=[];
  try{ gCases   =(await cypher('MATCH (c:ExternalCase) RETURN count(c) AS n',{}))[0].n; }catch(e){}
  try{ gVerified=(await cypher('MATCH (v:VerifiedCase) RETURN count(v) AS n',{}))[0].n; }catch(e){}
  try{ gParts   =(await cypher('MATCH (p:Part) RETURN count(p) AS n',{}))[0].n; }catch(e){}
  try{ gDefTypes=(await cypher('MATCH (d:Defect) RETURN count(DISTINCT d.name) AS n',{}))[0].n; }catch(e){}
  try{ gProc    =(await cypher('MATCH (p:Procedure) RETURN count(p) AS n',{}))[0].n; }catch(e){}
  try{ gTool    =(await cypher('MATCH (t:Tool) RETURN count(DISTINCT t.name) AS n',{}))[0].n; }catch(e){}
  try{ gTop     = await cypher('MATCH (d:Defect)-[r:OCCURS_ON]->(:Part) RETURN d.name AS name, sum(r.weight) AS n ORDER BY n DESC LIMIT 4',{}); }catch(e){ gTop=[]; }
  // ── AI 판단 근거 (제안 + 근거) — 실데이터 기반, 추정치는 kind로 명시 (정직 라벨)
  const approvalN = ops.approvalWait, waitN = waiting.length, retakeN = ops.retake;
  const avgLead = (()=>{ const a=done.filter(w=>w.lead); return a.length?Math.round(a.reduce((s,w)=>s+w.lead,0)/a.length):0; })();
  const apprElapsed = (()=>{ const q=W.filter(w=>w.status==='완료'&&w.verdict==='수리'&&w.at);
    return q.length?Math.max(...q.map(w=>Math.round((Date.now()-new Date(w.at).getTime())/60000))):0; })();
  const idle = liveFleet(pairs).filter(f=>f.label==='대기'||f.label==='충전').reduce((s,f)=>s+f.n,0);
  const suggestions = [];
  if(approvalN>0) suggestions.push({
    id:'S1', tag:'병목', title:'판정 승인 구간 병목', priority:'높음',
    summary:`승인 대기 ${approvalN}건 적체 — 검사·촬영 완료본이 승인 단계에서 대기 중입니다.`,
    recommend:'대기 시간이 긴 건부터 우선 승인 처리를 권장합니다.',
    basis:[
      {label:'승인 대기', value:`${approvalN}건`, kind:'실측'},
      {label:'현재 최장 대기', value:`${apprElapsed}분`, kind:'실측'},
      {label:'평균 처리(리드타임)', value:`${avgLead}분`, kind:'실측'},
      {label:'연결된 검증사례', value:`${gVerified!=null?gVerified:'—'}건`, kind:'Neo4j'},
      {label:'병목 발생 확률', value:`${Math.min(95, 45+approvalN*12+(apprElapsed>avgLead?15:0))}%`, kind:'추정'},
    ],
    evidence:`Neo4j 검증사례 ${gVerified!=null?gVerified:'—'}건과 연결 · execution_event 승인 구간 타임스탬프 기준`,
    confidence: Math.min(92, 60+approvalN*8),
  });
  if(waitN>0) suggestions.push({
    id:'S2', tag:'배분', title:'검사 대기 작업 배분', priority:'중간',
    summary:`검사 대기 ${waitN}건 — 로봇 가동률 ${ops.robotRate}%로 여력이 있습니다.`,
    recommend:'유휴 로봇(대기·충전)에 대기 작업을 배정하면 처리량 향상이 예상됩니다.',
    basis:[
      {label:'검사 대기', value:`${waitN}건`, kind:'실측'},
      {label:'로봇 가동률', value:`${ops.robotRate}%`, kind:'실측'},
      {label:'유휴 로봇', value:`${idle}대`, kind:'실측'},
      {label:'긴급 포함', value:`${today.urgent}건`, kind:'실측'},
    ],
    evidence:'가동보드 로봇 상태 분포 · 작업 위험도(ATA·결함) 기준 우선순위',
    confidence: 74,
  });
  if(retakeN>0) suggestions.push({
    id:'S3', tag:'품질', title:'재검사 발생 주의', priority:'중간',
    summary:`재검사 ${retakeN}건 — 촬영 품질·기록 누락이 주 원인으로 보입니다.`,
    recommend:'재촬영 상한에 도달한 건은 원격 전문가 연결을 권장합니다.',
    basis:[
      {label:'재검사', value:`${retakeN}건`, kind:'실측'},
      {label:'증빙 완결률', value:`${quality}%`, kind:'실측'},
      {label:'주요 원인', value:'촬영 각도·초점', kind:'추정'},
    ],
    evidence:'품질 반려 사유 분포 · 사례 연결 완결성(사진·판정·조치·지시)',
    confidence: 70,
  });
  if(suggestions.length===0) suggestions.push({
    id:'S0', tag:'정상', title:'현재 개입 필요 없음', priority:'—',
    summary:'병목·재검사 없음 — 운영이 안정적입니다.', recommend:'현재 페이스 유지를 권장합니다.',
    basis:[{label:'승인 대기', value:'0건', kind:'실측'},{label:'검사 대기', value:`${waitN}건`, kind:'실측'}],
    evidence:'라이브 집계', confidence: 88,
  });
  // ── 품질(관제): 증빙 완결성 감시 + 재검사 (완료 작업 기준, 실집계)
  const evList = done.map(w=>({ id:w.id, part:w.part, area:w.area, owner:w.owner, defect:w.defect, checks:evChecks(w) }));
  const evComplete = evList.filter(e=>Object.values(e.checks).every(x=>x)).length;
  const evGaps = evList.filter(e=>!Object.values(e.checks).every(x=>x))
    .map(e=>({ id:e.id, part:e.part, area:e.area, owner:e.owner, defect:e.defect,
               miss: Object.keys(e.checks).filter(k=>!e.checks[k]).map(k=>EVNAME[k]) }));
  const retakes = done.filter(w=>w.retake).map(w=>({ id:w.id, part:w.part, area:w.area, owner:w.owner, defect:w.defect }));
  const qual = { evTotal:done.length, evComplete, evRate: done.length?Math.round(evComplete/done.length*100):100, evGaps, retakes };
  // ── 인재(관제): 부하 분포 + 정비사별 현황 + 신입 지원 (실집계)
  const CAP = 6;   // 1인 권장 미완료 상한
  const members = TECHS.map(t=>{
    const mine=W.filter(w=>w.owner===t.id);
    const wait=mine.filter(w=>w.status!=='완료').length, doneN=mine.length-wait;
    const rt=mine.filter(w=>w.retake).length;
    const L=LIVE[t.id];
    const active = L ? (L.auto?'자동 진행':'작업중') : (wait>0?'대기':'유휴');
    return { tech:t.id, grade:t.grade, robot:t.robot, done:doneN, wait, retake:rt, active, over: wait>CAP };
  });
  const byGrade = ['숙련','중급','신입'].map(g=>{
    const ms=members.filter(m=>m.grade===g); if(!ms.length) return null;
    return { grade:g, n:ms.length,
      load:+(ms.reduce((s,m)=>s+m.wait,0)/ms.length).toFixed(1),
      done:+(ms.reduce((s,m)=>s+m.done,0)/ms.length).toFixed(1) };
  }).filter(Boolean);
  const topDefKor = (gTop&&gTop[0]) ? (KORD[gTop[0].name]||gTop[0].name) : '부식';
  const rookieSupport = members.filter(m=>m.grade==='신입').map(m=>({
    tech:m.tech, robot:m.robot,
    reason: m.retake>0 ? ('재검사 '+m.retake+'건 — 판정 정확도 지원 필요') : ('경험 축적 단계 (완료 '+m.done+'건)'),
    recommend: topDefKor+' 등 다발 결함의 검증사례·숙련자 판정 이력 연결 추천',
    cases: gVerified }));
  const people = { byGrade, members, cap:CAP, rookieSupport };
  // ── 지연·위험 알림 (미완료 긴급)
  const alerts = W.filter(w=>w.status!=='완료'&&w.risk==='긴급')
    .map(w=>({id:w.id, part:w.part, defect:w.defect, risk:w.risk, why:'긴급'}));
  // 상단 알림 스트립 — 문제만 (정상이면 빈 배열)
  const strip = [];
  if(today.delayed>0) strip.push({label:'🔴 긴급 '+today.delayed});
  const roboErr = pairs.filter(p=>p.rst==='오류').length;
  if(roboErr>0) strip.push({label:'🤖 로봇 오류 '+roboErr});
  return {
    generatedAt:new Date().toISOString(),
    today, ops, bottleneck, defectTop, alerts, strip, suggestions, autoDemo:AUTO, qual, people,
    pairs, fleet: liveFleet(pairs),
    activity: ACTIVITY.slice(0,8),
    hero:{
      efficiency:{title:'작업 효율', metric:'평균 리드타임 단축률', now:efficiency, unit:'%', target:20,
                  note:`오늘 절감 ${savedMin}분 ≈ ${(savedMin/60).toFixed(1)}시간`, kind:'실측', up:true},
      quality:   {title:'정비 품질', metric:'증빙·기록 완결률', now:quality, unit:'%', target:95, kind:'실측', up:true},
      economy:   {title:'경제 효과', metric:'로봇 1대 회수 (0.5 FTE)', now:'1,040h', unit:'/년',
                  target:'3,100~4,000만원', note:'투자회수 2~4년', kind:'검증 목표', up:true},
      capability:{title:'역량 향상', metric:'신입–숙련 작업시간 격차', before:45, now:18, unit:'%',
                  note:'신입도 숙련자 수준으로', kind:'검증 목표', up:false},
    },
    trend:{labels:['6주전','5주전','4주전','3주전','2주전','지난주'],
           efficiency:[8,11,14,17,20,efficiency], quality:[78,82,86,88,90,quality], kind:'시뮬'},
    graph:{ connected: gParts!=null, cases:gCases, verified:gVerified, parts:gParts,
            defectTypes:gDefTypes, procedures:gProc, tools:gTool,
            defectTop:(gTop||[]).map(x=>({name:x.name, n:x.n})) },
  };
}

// ── 라우팅 ─────────────────────────────────────────────────
const MIME = {'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css',
  '.jpg':'image/jpeg','.png':'image/png','.svg':'image/svg+xml',
  '.mp4':'video/mp4','.webm':'video/webm'};   // 시뮬 영상 (assets/sim.mp4)

const server = http.createServer(async (req,res)=>{
  const u = new URL(req.url, 'http://localhost');
  // Local prototype: reject cross-origin browser writes.
  if(req.method === 'POST' && !isTrustedOrigin(req.headers.origin, PORT)){
    return json(res, {error:'untrusted browser origin'}, 403);
  }

  // API: 부품 목록
  if(u.pathname === '/api/parts'){
    try{ const rows = await cypher('MATCH (p:Part) RETURN p.name AS name, p.caseCount AS c ORDER BY c DESC LIMIT 40',{});
      return json(res, rows);
    }catch(e){ return json(res,{error:e.message},500); }
  }

  // API: 부품 지식 조회
  if(u.pathname === '/api/query'){
    const term = u.searchParams.get('q') || '';
    try{
      const part = await resolvePart(term);
      if(!part) return json(res, {found:false, term});
      const rows = await cypher(Q_PART, {part});
      const vrows = await cypher(Q_VERIFIED, {part});
      let procs = [];
      try { procs = await cypher(Q_PROCEDURE, {part}); } catch(e){ procs = []; }
      return json(res, {found:true, term, part, data:rows[0]||null, verified:vrows, procedures:procs});
    }catch(e){ return json(res, {error:e.message}, 500); }
  }

  // ============================================================
  // API: 챗봇 — 질문 의도에 맞는 대화형 답변
  // 구조: [① 의도 파악] → [② 지식 조회(Neo4j)] → [③ 답변 생성]
  // ★ 나중에 LLM+RAG로 갈 때: ①과 ③만 LLM으로 교체. ②(지식 조회)는 그대로.
  //   → classifyIntent()·composeAnswer()만 바꾸면 되고 화면은 손 안 댐.
  // ============================================================
  if(u.pathname === '/api/ask'){
    // GET(?q=) 또는 POST({q, history:[{role,text}]}) 둘 다 지원
    let q='', history=[], wctx=null;
    if(req.method === 'POST'){
      try{ const p = JSON.parse(await readBody(req) || '{}'); q = p.q || ''; history = p.history || []; wctx = p.ctx || null; }catch(e){}
    } else {
      q = u.searchParams.get('q') || '';
    }
    try{
      // LLM 켜져 있으면 RAG+LLM 우선. 실패하면 아래 규칙 기반으로 자동 fallback.
      //   실패해도 화면엔 규칙 답변이 태연히 나가므로 "챗봇이 멍청해졌다"로만 보인다.
      //   → 사유를 llmError 로 함께 내보내 화면에서 확인할 수 있게 한다.
      let llmErr = null;
      if(LLM_ON){
        // geminiComplete 안에서 모델 체인을 순서대로 시도한다 — 전부 막혔을 때만 여기로 온다.
        try{
          const out = await answerLLM(q, history, wctx);
          return json(res, {q, part:out.part, mode:'llm', answer:out.answer});
        }catch(e){
          llmErr = e.message;
          console.log('  ! LLM fallback('+e.message+') → 규칙 기반');
        }
      }
      const intent = classifyIntent(q);        // ① 의도 (규칙)
      // ② 지식 조회 — Neo4j 죽어있어도 500 대신 빈 데이터로 우아하게 처리
      let part='BLADE', data=null, procs=[];
      try{ part = await resolvePart(q) || 'BLADE'; }catch(e){}
      try{ data = (await cypher(Q_PART, {part}))[0] || null; }catch(e){}
      try{ procs = await cypher(Q_PROCEDURE, {part}); }catch(e){}
      const answer = composeAnswer(intent, part, data, procs);  // ③ 답변 생성
      return json(res, {q, intent, part, mode:'rule', llmError:llmErr, answer});
    }catch(e){ return json(res, {error:e.message}, 500); }
  }

  // API: 서비스② 오케스트레이션 (작업지시 흐름 + 판정)
  if(u.pathname === '/api/workflow'){
    const wo = u.searchParams.get('wo') || 'WO-2026-0805-01';
    try{
      const w = await cypher(Q_WORKORDER, {wo});
      const j = await cypher(Q_JUDGMENT, {});
      return json(res, {wo:w[0]||null, judgment:j[0]||null});
    }catch(e){ return json(res, {error:e.message}, 500); }
  }

  // API: 오늘의 작업 목록 (정비사 앱 첫 화면)
  if(u.pathname === '/api/works'){
    const tech = u.searchParams.get('tech');           // 정비사 앱: 자기 작업만
    const list = tech ? WORKS.filter(w=>w.owner===tech) : WORKS;
    return json(res, list.map(w=>({id:w.id, ac:w.ac, part:w.part, area:w.area, defect:w.defect,
      risk:w.risk, status:w.status, state:w.state, stateKo:STATE_KO[w.state]||w.state,
      tech:w.tech, owner:w.owner, verdict:w.verdict})));
  }
  // API: 정비사 단계 진행 보고 → 가동보드 라이브 갱신 (실시간)
  if(u.pathname === '/api/works/progress' && req.method==='POST'){
    try{ const p=JSON.parse(await readBody(req)||'{}'); reportProgress(p.tech, p.id, p.step||1);
      return json(res, {ok:true}); }catch(e){ return json(res, {error:e.message}, 500); }
  }
  // API: 정비사 로그아웃 → 가동보드 세션 정리 (그 pair는 대기로 복귀)
  if(u.pathname === '/api/works/logout' && req.method==='POST'){
    try{ const p=JSON.parse(await readBody(req)||'{}'); clearLiveFor(p.tech); }catch(e){}
    return json(res, {ok:true});
  }
  // API: 데모 자동재생 on/off (혼자 시연용)
  if(u.pathname === '/api/demo/auto' && req.method==='POST'){
    try{ const p=JSON.parse(await readBody(req)||'{}'); AUTO=!!p.on;
      if(!AUTO) Object.keys(LIVE).forEach(k=>{ if(LIVE[k]&&LIVE[k].auto) delete LIVE[k]; }); // 끄면 자동 세션 정리
    }catch(e){}
    return json(res, {ok:true, auto:AUTO});
  }
  // API: 정비사 판정 → 작업 완료 (관리자 대시보드에 실시간 반영 + 이력 기록)
  if(u.pathname === '/api/works/complete' && req.method==='POST'){
    try{
      const p = JSON.parse(await readBody(req) || '{}');
      const w = await completeWork(p.id, p.capturedBy, p.verdict);
      return json(res, {ok:!!w, work:w});
    }catch(e){ return json(res, {error:e.message}, 500); }
  }
  // API: Work Order 상세 — 하나의 WO를 처음부터 끝까지 추적 (가동보드 클릭 -> Drawer)
  if(u.pathname === '/api/wo'){
    const w = WORKS.find(x=>x.id===u.searchParams.get('id'));
    if(!w) return json(res, {error:'not found'}, 404);
    const t = techOf(w.owner);
    return json(res, {
      id:w.id, ac:w.ac, part:w.part, area:w.area, defect:w.defect, risk:w.risk,
      state:w.state, stateKo:STATE_KO[w.state]||w.state, status:w.status,
      verdict:w.verdict, capturedBy:(w.robot===null?null:(w.robot?'robot':'direct')),
      tech: t?{id:t.id, grade:t.grade, robot:t.robot}:null,
      assess: assess(w), qc: w.qc, timeline: w.timeline||[],
      hwanryu: !!w.hwanryu, at: w.at||null,
    });
  }
  // API: 관리자 승인 — 수리 판정 건을 최종 완료 (이때 지식그래프 환류)
  if(u.pathname === '/api/works/approve' && req.method==='POST'){
    try{
      const p = JSON.parse(await readBody(req) || '{}');
      const w = await approveWork(p.id, p.note);
      return json(res, {ok:!!w, work:w});
    }catch(e){ return json(res, {error:e.message}, 500); }
  }
  // API: 데모 새 작업 배정 — 작업 목록을 초기 상태로 리셋 (시연 반복용)
  if(u.pathname === '/api/works/reset' && req.method==='POST'){
    resetWorks();
    return json(res, {ok:true, count:WORKS.filter(w=>w.status!=='완료').length});
  }
  // API: AI 제안에 대한 관리자 판단 기록 → 활동 이력에 남김 (HITL 흔적)
  if(u.pathname === '/api/suggestion/ack' && req.method==='POST'){
    try{
      const p = JSON.parse(await readBody(req) || '{}');
      const label = p.action || '참고함';
      ACTIVITY.unshift({ at:new Date().toISOString(), id:p.id||'AI', kind:'ai', by:'관리자',
        text:`AI 제안 '${p.title||'운영 제안'}' → 관리자 ${label}` });
      if(ACTIVITY.length>50) ACTIVITY.length=50;
      return json(res, {ok:true});
    }catch(e){ return json(res, {error:e.message}, 500); }
  }

  // API: 케이스 브라우저 (지식 탭) — Neo4j 검증사례(환류) + 외부사례(FAA SDR) 읽기 전용
  if(u.pathname === '/api/cases'){
    try{
      const kor = n => KORD[n] || n || '-';
      let V=[], E=[];
      try{ V = await cypher(`
        MATCH (v:VerifiedCase)
        OPTIONAL MATCH (v)-[:ON_PART]->(p:Part)
        RETURN v.id AS id, v.aircraft AS aircraft, v.condition AS defect, v.action AS action,
               v.approvedBy AS by, v.owner AS owner, v.capturedBy AS cap, v.area AS area,
               v.approvedAt AS at, v.source AS source, coalesce(p.name, v.partName) AS part
        ORDER BY v.approvedAt DESC LIMIT 40`, {}); }catch(e){}
      try{ E = await cypher(`
        MATCH (c:ExternalCase) WHERE c.summary IS NOT NULL
        RETURN c.aircraft AS aircraft, c.condition AS defect, c.summary AS summary,
               c.partName AS part, c.fsFrom AS fs, c.stringer AS str LIMIT 12`, {}); }catch(e){}
      const verified = V.map((v,i)=>{
        const t = caseTech(v);                       // 담당 정비사(유추)
        const direct = v.cap==='direct';
        const checks = {photo: direct?0:1, verdict:1, action:(v.action==='재검사'?0:1), wo:1};
        return { id: v.id || ('VC-'+String(i+1).padStart(4,'0')), src:'검증사례',
          at: v.at || '', aircraft: v.aircraft || '-', part: v.part || '-', area: v.area||'',
          defect: kor(v.defect), verdict: v.action || '정상 판정',
          by: t?t.id:(v.by||'정비사'), tech: t?t.id:'', robot: t?t.robot:'', grade: t?t.grade:'',
          capture: v.cap==='direct'?'직접 촬영':(v.cap==='robot'?'로봇 촬영':'로봇/직접'),
          poc: v.source==='PoC시연',
          checks, complete: Object.values(checks).every(x=>x) };
      });
      const external = E.map((c,i)=>{
        const checks = {photo:0, verdict:1, action:0, wo:0}; // 외부 참조 — 내부 증빙 미연결(완결성 미달)
        return { id:'SDR-'+String(i+1).padStart(4,'0'), src:'외부사례', at:'',
          aircraft: c.aircraft || '타사', part: c.part || '-', defect: kor(c.defect),
          verdict:'참조', by:'FAA SDR', capture:'외부 보고', summary:(c.summary||'').slice(0,140),
          checks, complete:false };
      });
      return json(res, { count:verified.length+external.length,
        verifiedN:verified.length, externalN:external.length, cases:[...verified, ...external],
        defectImages: scanDefectImages() });   // 사례별 실사진 배정용 (폴더 스캔)
    }catch(e){ return json(res, {error:e.message}, 500); }
  }

  // API: 관리자 대시보드 (라이브 집계 + 실데이터 + 활동 이력)
  if(u.pathname === '/api/dashboard'){
    try{ return json(res, await buildDashboard()); }
    catch(e){ return json(res, {error:e.message}, 500); }
  }

  // API: 서비스③ 로봇 검사 HUD
  if(u.pathname === '/api/robot'){
    // 촬영 평가는 지식그래프와 무관하다 -> 그래프가 죽어도 정비사 화면은 계속 돌아야 한다
    const w = WORKS.find(x=>x.id===u.searchParams.get('work'));
    // 촬영 시점이 곧 품질 판정 시점이다 -> 정비사 화면도 같은 판단 내용을 받는다
    //   (관리자만 보고 정비사는 못 보면, 그 사진으로 판정할 사람이 근거를 모른 채 판정하게 된다)
    if(w) qcRun(w);
    const out = { assess: assess(w), qc: w? w.qc : null, image: pickDefectImage(w) };
    try{
      out.scene = (await cypher(Q_ROBOT, {}))[0] || null;
      out.part  = (await cypher(Q_PART, {part:'BLADE'}))[0] || null;
    }catch(e){ out.scene=null; out.part=null; out.graphError=e.message||'graph unavailable'; }
    return json(res, out);
  }

  // 정적 파일 — 최초 진입은 통합 로그인 랜딩(역할 선택). 정비사=/index.html, 관리자=/manager.html
  let f = u.pathname === '/' ? '/login.html' : u.pathname;
  const fp = resolvePublicFile(ROOT, f);
  if(!fp) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(fp, (err,data)=>{
    if(err){ res.writeHead(404); return res.end('not found: '+f); }
    res.writeHead(200, {'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream'});
    res.end(data);
  });
});

// ── 로봇 촬영 결과 평가 (작업 단위 결정론적 생성) ─────────────────────────
//  실제 비전 모델을 학습시키지 않는 PoC 범위이므로, 값은 규칙 + 작업 ID 시드로 만든다.
//  * 작업 ID가 시드라 같은 작업은 언제 열어도 같은 값 -> 정비사 화면과 관리자 화면이 어긋나지 않는다.
//  * 결함 종류마다 기저 신뢰도가 다르다 (아래 근거는 실제 육안/영상 검사 특성)
//  * 실도입 시 이 함수를 실제 검사 모델의 출력으로 교체한다.
const CONF_BASE = {
  '균열':  [0.79, '미세 균열은 표면 반사에 묻혀 대비가 낮습니다'],
  '부식':  [0.91, '변색 대비가 뚜렷해 검출이 안정적입니다'],
  '찍힘':  [0.86, '형상 변화가 뚜렷하나 깊이 판단은 사람 확인이 필요합니다'],
  '마모':  [0.83, '경계가 완만해 진행 정도 판단에 편차가 있습니다'],
  '흠집':  [0.85, '길이는 명확하나 깊이는 촬영각에 민감합니다'],
  '손상':  [0.81, '형태가 다양해 유형 분류 신뢰도가 낮습니다'],
  '이상없음': [0.94, '결함 신호가 관찰되지 않았습니다'],
};
function _seed(s){ let h=2166136261; for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619);} return h>>>0; }
function _rng(seed){ let a=seed; return ()=>{ a|=0; a=a+0x6D2B79F5|0;
  let t=Math.imul(a^a>>>15,1|a); t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; }
const _cl = (v,lo,hi)=>Math.max(lo,Math.min(hi,v));

function assess(w){
  if(!w) return null;
  const rnd = _rng(_seed(w.id + '|' + (w.defect||'')));
  const [base, why] = CONF_BASE[w.defect] || [0.85, '표준 조건에서 촬영됐습니다'];
  const jitter = (rnd()-0.5)*0.09;
  // 재검사가 걸린 건은 촬영 조건이 나빴다는 뜻 -> 신뢰도.품질을 함께 낮춘다
  const pen = w.retake ? 0.07 : 0;
  const conf    = _cl(base + jitter - pen, 0.60, 0.97);
  const quality = _cl(0.93 + (rnd()-0.5)*0.07 - pen*1.2, 0.68, 0.99);
  // 1차 촬영 실패율은 결함 유형에 따라 다르다.
  //   미세 균열.마모는 경계가 흐려 촬영 조건(거리.각도)에 민감해 한 번에 못 담는 경우가 잦다.
  //   실패하면 로봇이 원인을 판단해 자세를 바꿔 재촬영한다 (시뮬레이션의 닫힌 루프와 같은 규칙).
  const RECAP = {'균열':0.35,'마모':0.30,'손상':0.25,'흠집':0.20,'찍힘':0.15,'부식':0.12,'이상없음':0.05};
  const shots   = (rnd() < ((RECAP[w.defect]!==undefined?RECAP[w.defect]:0.2) + (w.retake?0.25:0))) ? 2 : 1;
  return {
    conf: Math.round(conf*100)/100,
    quality: Math.round(quality*100)/100,
    shots,
    cuts: 3,                                   // 리딩엣지.압력면.흡입면
    why,
    lowConf: conf < 0.80,                      // 낮으면 화면에서 사람 확인을 더 강조
  };
}

// ── 촬영 품질 검사 이력 (PyBullet 시뮬레이션과 같은 규칙을 작업 ID 시드로 재현) ──
//  주의: 실시간 PyBullet 연결이 아니다. 화면에 'PoC 재현'으로 명시한다.
//  실도입 시 이 함수를 로봇에서 올라오는 실제 검사 결과로 교체한다.
const QC_REGIONS = ['팁','루트','외곽 엣지'];
const REG_PASS = 0.88, COV_PASS = 0.90;
function qcRun(w){
  if(!w) return null;
  if(w.qc) return w.qc;                       // 한 번 정해지면 고정 (새로고침해도 같은 값)
  const a = assess(w); if(!a) return null;
  const rnd = _rng(_seed(w.id + '|qc'));
  const mk = (cov, badIdx) => {
    const rg = {};
    QC_REGIONS.forEach((r,i)=>{ rg[r] = (i===badIdx)
      ? Math.round((0.45 + rnd()*0.30)*100)/100
      : Math.round((0.92 + rnd()*0.07)*100)/100; });
    return rg;
  };
  const attempts = [];
  if(a.shots > 1){
    // 1차 실패 — 한 부위가 화각을 벗어났다
    const bad = Math.floor(rnd()*QC_REGIONS.length);
    const cov1 = Math.round((0.70 + rnd()*0.13)*100)/100;
    const region = QC_REGIONS[bad];
    // 실패 원인에 따라 재계획 방식이 갈린다 (시뮬레이션과 같은 판단)
    const replan = (region==='외곽 엣지')
      ? { kind:'tilt',  detail:'카메라 이동 + 광축 0° → +12°' }
      : { kind:'dist',  detail:'촬영 거리 확보 · 높이 0.50 m → 0.60 m' };
    attempts.push({ n:1, coverage:cov1, regions:mk(cov1, bad), result:'FAIL',
                    reason:region+'가 사진에서 잘림', replan });
    attempts.push({ n:2, coverage:a.quality, regions:mk(a.quality, -1), result:'PASS' });
  }else{
    attempts.push({ n:1, coverage:a.quality, regions:mk(a.quality, -1), result:'PASS' });
  }
  w.qc = { attempts, shots:attempts.length, pass:true,
           covPass:COV_PASS, regPass:REG_PASS, source:'PoC 재현 (실시간 로봇 연결 아님)' };
  return w.qc;
}

// 상수 선언이 끝난 시점에 시드 완료건 이력을 채우고 스냅샷을 다시 잡는다
WORKS.forEach(backfill);
WORKS_SEED = JSON.parse(JSON.stringify(WORKS));

function json(res, obj, code){
  res.writeHead(code||200, {'Content-Type':'application/json; charset=utf-8'});
  res.end(JSON.stringify(obj));
}

// POST 요청 본문 읽기 (대화기록 수신용)
function readBody(req){
  return new Promise((resolve)=>{
    req.setEncoding('utf8');        // 청크 경계에서 한글이 잘리지 않게
    let d=''; req.on('data',c=>{ d+=c; if(d.length>1e6) d=d.slice(0,1e6); });
    req.on('end',()=>resolve(d)); req.on('error',()=>resolve(''));
  });
}

// ── 시작 시 연결 점검 ──────────────────────────────────────
if (require.main === module) {
server.listen(PORT, '127.0.0.1', async ()=>{
  console.log('\n  MRO Copilot 서비스 서버');
  console.log('  ─────────────────────────────');
  try{
    const r = await cypher('MATCH (p:Part) RETURN count(p) AS n',{});
    console.log('  ✓ Neo4j 연결 성공 — 부품 노드 '+r[0].n+'개');
  }catch(e){
    console.log('  ✗ Neo4j 연결 실패: '+e.message+' (근거 조회 제한 — 비번 확인)');
  }
  // LLM·현장용어 상태는 Neo4j 성패와 무관하게 항상 표시
  console.log('  ✓ 현장용어사전 '+FIELD_TERMS.length+'개 로드');
  console.log('  '+(LLM_ON?'✓ LLM 켜짐 — '+LLM_PROVIDER+' ('+(LLM_PROVIDER==='gemini'?GEMINI_CHAIN.join(' → '):LLM_MODEL)+')':'· LLM 꺼짐 — 규칙 기반 (API 키 없음)'));
  console.log('  ✓ 브라우저에서 열기:  http://127.0.0.1:'+PORT+'\n');
});
}

module.exports = {classifyIntent, composeAnswer};
