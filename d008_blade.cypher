// ============================================================
// D-008 — HPC 블레이드 서브그래프 시드
//   대표 시나리오: 엔진 오버홀 중 분해된 HPC 블레이드 외관 손상 검사
//
//   실행:
//     cypher-shell -a $NEO4J_URI -u $NEO4J_USER -p $NEO4J_PW -f seed/d008_blade.cypher
//     이어서:  node seed/load_sdr_blade.js <neo4j비밀번호>
//
//   원칙
//   1. 기존 SKIN(ATA 53) 서브그래프는 삭제하지 않는다 — P1 로드맵 자산이며
//      server.js의 별칭 맵도 '외판' 계열을 유지하므로 계속 조회된다.
//   2. LOC-01 / EV-01 / CAND-01 은 server.js가 ID로 하드참조하므로
//      ID를 유지하고 속성만 교체한다. (Q_ROBOT, 269~275행)
//   3. 수치는 지어내지 않는다.
//      - 허용한도·교체기준은 엔진 정비교범(EM/AMM)을 따르며 여기 적지 않는다.
//      - 결함 "분류"(어떤 결함이 생길 수 있는가)는 교범 기반 도메인 지식이라 여기 둔다.
//      - 결함 "통계"(몇 건 보고됐는가)는 load_sdr_blade.js 가 FAA SDR 실적재에서 역산한다.
//        따라서 caseCount·OCCURS_ON.weight 는 여기서 0으로만 초기화한다.
// ============================================================

// ── 1. 계통 · 부품 ──────────────────────────────────────────
MERGE (s72:System {code:'72'})
  SET s72.name = '엔진 (Engine)';

MERGE (p:Part {name:'BLADE'})
  SET p.caseCount = coalesce(p.caseCount, 0), p.confidence = 0.86, p.isGeneric = false;
MERGE (v:Part {name:'VANE'})
  SET v.caseCount = coalesce(v.caseCount, 0), v.confidence = 0.74, v.isGeneric = false;

MATCH (p:Part {name:'BLADE'}), (s72:System {code:'72'})
MERGE (p)-[r:PART_OF]->(s72) SET r.weight = coalesce(r.weight, 1);
MATCH (v:Part {name:'VANE'}), (s72:System {code:'72'})
MERGE (v)-[r:PART_OF]->(s72) SET r.weight = coalesce(r.weight, 1);

// ── 2. 결함 분류 — 기존 결함 코드만 재사용 (신규 코드 도입 없음) ──
//   server.js KORD(143행)·index.html KOR/DEFC/RISK 맵과 1:1 대응하는 코드만 사용.
//   weight 는 0으로 초기화 → load_sdr_blade.js 가 실적재 건수로 갱신.
MATCH (p:Part {name:'BLADE'})
MERGE (d:Defect {name:'CORRODED'}) MERGE (d)-[r:OCCURS_ON]->(p) SET r.weight = coalesce(r.weight, 0);
MATCH (p:Part {name:'BLADE'})
MERGE (d:Defect {name:'CRACKED'})  MERGE (d)-[r:OCCURS_ON]->(p) SET r.weight = coalesce(r.weight, 0);
MATCH (p:Part {name:'BLADE'})
MERGE (d:Defect {name:'DENTED'})   MERGE (d)-[r:OCCURS_ON]->(p) SET r.weight = coalesce(r.weight, 0);
MATCH (p:Part {name:'BLADE'})
MERGE (d:Defect {name:'WORN'})     MERGE (d)-[r:OCCURS_ON]->(p) SET r.weight = coalesce(r.weight, 0);
MATCH (p:Part {name:'BLADE'})
MERGE (d:Defect {name:'DAMAGED'})  MERGE (d)-[r:OCCURS_ON]->(p) SET r.weight = coalesce(r.weight, 0);

MATCH (v:Part {name:'VANE'})
MERGE (d:Defect {name:'DENTED'})   MERGE (d)-[r:OCCURS_ON]->(v) SET r.weight = coalesce(r.weight, 0);
MATCH (v:Part {name:'VANE'})
MERGE (d:Defect {name:'CORRODED'}) MERGE (d)-[r:OCCURS_ON]->(v) SET r.weight = coalesce(r.weight, 0);
MATCH (v:Part {name:'VANE'})
MERGE (d:Defect {name:'DAMAGED'})  MERGE (d)-[r:OCCURS_ON]->(v) SET r.weight = coalesce(r.weight, 0);

// ── 3. 출처 문서 ────────────────────────────────────────────
MERGE (doc:Document {title:'FAA-H-8083-32B Aviation Maintenance Technician Handbook — Powerplant'})
  SET doc.kind = 'handbook', doc.publisher = 'FAA';

// ── 4. 검사 절차 ────────────────────────────────────────────
MERGE (pr:Procedure {id:'PR-BLADE-VIS'})
  SET pr.name        = '블레이드 외관검사',
      pr.nameEn      = 'Compressor Blade Visual Inspection',
      pr.description = '오버홀로 분해된 압축기 블레이드를 스탠드에 거치하고 리딩엣지·압력면·흡입면을 동일 조건으로 촬영·기록하며 육안 검사한다. 허용한도 판정은 해당 엔진 정비교범(EM/AMM) 기준을 따른다.',
      pr.sourcePage  = 'Powerplant Ch.10 Engine Inspection';

MATCH (pr:Procedure {id:'PR-BLADE-VIS'}), (doc:Document)
WHERE doc.title STARTS WITH 'FAA-H-8083-32B'
MERGE (pr)-[:SOURCED_FROM]->(doc);

MATCH (d:Defect)-[:OCCURS_ON]->(:Part {name:'BLADE'}), (pr:Procedure {id:'PR-BLADE-VIS'})
MERGE (d)-[:REQUIRES_PROCEDURE]->(pr);
MATCH (d:Defect)-[:OCCURS_ON]->(:Part {name:'VANE'}), (pr:Procedure {id:'PR-BLADE-VIS'})
MERGE (d)-[:REQUIRES_PROCEDURE]->(pr);

// 절차가 "어느 부품을 대상으로 하는가"를 명시한다.
//   Defect 노드는 이름만으로 식별되어 계통 간 공유된다(CORRODED 는 블레이드에도 외판에도 붙는다).
//   그래서 결함만 타고 가면 다른 계통의 절차까지 딸려온다 — TARGETS 로 대상 부품을 고정한다.
MATCH (pr:Procedure {id:'PR-BLADE-VIS'}), (p:Part {name:'BLADE'}) MERGE (pr)-[:TARGETS]->(p);
MATCH (pr:Procedure {id:'PR-BLADE-VIS'}), (v:Part {name:'VANE'})  MERGE (pr)-[:TARGETS]->(v);

MATCH (pr:Procedure {id:'PR-BLADE-VIS'})
MERGE (st:Step {id:'ST-BLADE-1'}) SET st.seq=1, st.name='블레이드 개체 식별 — 스테이지·일련번호 대조'
MERGE (pr)-[:HAS_STEP]->(st);
MATCH (pr:Procedure {id:'PR-BLADE-VIS'})
MERGE (st:Step {id:'ST-BLADE-2'}) SET st.seq=2, st.name='표면 이물·오일 제거 후 스탠드 거치'
MERGE (pr)-[:HAS_STEP]->(st);
MATCH (pr:Procedure {id:'PR-BLADE-VIS'})
MERGE (st:Step {id:'ST-BLADE-3'}) SET st.seq=3, st.name='리딩엣지 촬영 — 요구컷 1'
MERGE (pr)-[:HAS_STEP]->(st);
MATCH (pr:Procedure {id:'PR-BLADE-VIS'})
MERGE (st:Step {id:'ST-BLADE-4'}) SET st.seq=4, st.name='압력면 촬영 — 요구컷 2'
MERGE (pr)-[:HAS_STEP]->(st);
MATCH (pr:Procedure {id:'PR-BLADE-VIS'})
MERGE (st:Step {id:'ST-BLADE-5'}) SET st.seq=5, st.name='흡입면 촬영 — 요구컷 3'
MERGE (pr)-[:HAS_STEP]->(st);
MATCH (pr:Procedure {id:'PR-BLADE-VIS'})
MERGE (st:Step {id:'ST-BLADE-6'}) SET st.seq=6, st.name='이상 부위 판정 — 교범 허용한도 대조 (정비사)'
MERGE (pr)-[:HAS_STEP]->(st);
MATCH (pr:Procedure {id:'PR-BLADE-VIS'})
MERGE (st:Step {id:'ST-BLADE-7'}) SET st.seq=7, st.name='판정·증빙 기록 및 다음 블레이드 이관'
MERGE (pr)-[:HAS_STEP]->(st);

// ── 5. 공구 ────────────────────────────────────────────────
MATCH (pr:Procedure {id:'PR-BLADE-VIS'})
MERGE (t:Tool {name:'검사용 조명'})          MERGE (pr)-[:REQUIRES_TOOL]->(t);
MATCH (pr:Procedure {id:'PR-BLADE-VIS'})
MERGE (t:Tool {name:'확대경'})               MERGE (pr)-[:REQUIRES_TOOL]->(t);
MATCH (pr:Procedure {id:'PR-BLADE-VIS'})
MERGE (t:Tool {name:'블레이드 검사 스탠드'})  MERGE (pr)-[:REQUIRES_TOOL]->(t);
MATCH (pr:Procedure {id:'PR-BLADE-VIS'})
MERGE (t:Tool {name:'무보풀 천·세척액'})      MERGE (pr)-[:REQUIRES_TOOL]->(t);

// ── 6. 안전 경고 ────────────────────────────────────────────
MATCH (pr:Procedure {id:'PR-BLADE-VIS'})
MERGE (w:SafetyWarning {text:'에어포일 모서리가 날카로워 취급 시 보호장갑을 착용한다.'})
  SET w.type='주의', w.sourcePage='Powerplant Ch.10'
MERGE (pr)-[:HAS_WARNING]->(w);
MATCH (pr:Procedure {id:'PR-BLADE-VIS'})
MERGE (w:SafetyWarning {text:'블레이드 개체 식별표를 분리하지 않는다 — 장착 위치 추적이 불가해진다.'})
  SET w.type='경고', w.sourcePage='Powerplant Ch.10'
MERGE (pr)-[:HAS_WARNING]->(w);
MATCH (pr:Procedure {id:'PR-BLADE-VIS'})
MERGE (w:SafetyWarning {text:'허용한도·수리가능 여부는 해당 엔진 정비교범 기준을 확인한다.'})
  SET w.type='주의', w.sourcePage='Powerplant Ch.10'
MERGE (pr)-[:HAS_WARNING]->(w);

// ── 7. 작업지시 — server.js 846행 기본 WO ID와 일치 ──────────
MERGE (w:WorkOrder {id:'WO-2026-0805-01'})
  SET w.purpose      = 'HPC 블레이드 외관검사 — 오버홀 분해품',
      w.aircraft     = 'CFM56-7B',
      w.locationText = 'HPC Stg4 · BLD-017',
      w.status       = '진행';

MATCH (w:WorkOrder {id:'WO-2026-0805-01'}), (p:Part {name:'BLADE'})
MERGE (w)-[:TARGETS]->(p);
MATCH (w:WorkOrder {id:'WO-2026-0805-01'}), (s:System {code:'72'})
MERGE (w)-[:TARGETS]->(s);

MATCH (w:WorkOrder {id:'WO-2026-0805-01'})
MERGE (st:Step {id:'WOS-0805-1'}) SET st.seq=1, st.name='작업 수락', st.riskLevel='하', st.approvalRequired=false, st.status='완료'
MERGE (w)-[:CONSISTS_OF]->(st);
MATCH (w:WorkOrder {id:'WO-2026-0805-01'})
MERGE (st:Step {id:'WOS-0805-2'}) SET st.seq=2, st.name='절차·주의사항 확인', st.riskLevel='하', st.approvalRequired=false, st.status='완료'
MERGE (w)-[:CONSISTS_OF]->(st);
MATCH (w:WorkOrder {id:'WO-2026-0805-01'})
MERGE (st:Step {id:'WOS-0805-3'}) SET st.seq=3, st.name='요구컷 3면 촬영', st.riskLevel='중', st.approvalRequired=false, st.status='진행'
MERGE (w)-[:CONSISTS_OF]->(st);
MATCH (w:WorkOrder {id:'WO-2026-0805-01'})
MERGE (st:Step {id:'WOS-0805-4'}) SET st.seq=4, st.name='정비사 판정', st.riskLevel='상', st.approvalRequired=true, st.status='대기'
MERGE (w)-[:CONSISTS_OF]->(st);
MATCH (w:WorkOrder {id:'WO-2026-0805-01'})
MERGE (st:Step {id:'WOS-0805-5'}) SET st.seq=5, st.name='Work Card 승인·기록', st.riskLevel='상', st.approvalRequired=true, st.status='대기'
MERGE (w)-[:CONSISTS_OF]->(st);

// ── 8. 로봇 HUD 시나리오 — ID 유지, 속성만 교체 ─────────────
//   server.js Q_ROBOT(269~275행)이 이 세 ID를 하드참조한다.
//   robot.html은 fs → 'HPC Stg'+fs, str → 'BLD-'+str 로 렌더링한다.
MERGE (l:InspectionLocation {id:'LOC-01'})
  SET l.fsFrom           = '4',
      l.stringer         = '017',
      l.areaName         = 'HPC 블레이드 (분해·스탠드 거치)',
      l.blindSpot        = false,
      l.accessDifficulty = '반복';   // 접근성이 아니라 '반복 촬영'이 로봇 투입 사유 (D-008)

MERGE (ev:EvidenceItem {id:'EV-01'})
  SET ev.qualityScore = 0.92, ev.retake = false;

MERGE (c:DefectCandidate {id:'CAND-01'})
  SET c.confidence = 0.87, c.bbox = '0.26,0.30,0.44,0.52';

// 판정 체인 — AI 후보 → 정비사 판정 → 확정 결함 (HITL 실증)
MATCH (c:DefectCandidate {id:'CAND-01'})
MERGE (j:Judgment {id:'JDG-01'})
  SET j.verdict='이상', j.judgedBy='박재현', j.at='2026-08-05T09:20:00'
MERGE (c)-[:JUDGED_BY]->(j);
MATCH (j:Judgment {id:'JDG-01'}), (d:Defect {name:'CORRODED'})
MERGE (j)-[:CONFIRMS]->(d);
MATCH (j:Judgment {id:'JDG-01'})
MERGE (a:Action {id:'ACT-01'}) SET a.type='수리'
MERGE (j)-[:RESULTED_IN]->(a);

// ── 9. 확인 쿼리 (실행 후 눈으로 검증) ───────────────────────
// MATCH (p:Part {name:'BLADE'})<-[r:OCCURS_ON]-(d:Defect) RETURN p.name, d.name, r.weight;
// MATCH (l:InspectionLocation {id:'LOC-01'}) RETURN l;
// MATCH (c:ExternalCase {partName:'BLADE'}) RETURN count(c);   // load_sdr_blade.js 실행 후
