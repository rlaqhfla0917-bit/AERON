// ============================================================
// D-008 — 동체 외판(ATA 53) 검사 절차 서브그래프 시드
//   목적: 동일 온톨로지가 다른 계통에도 적용됨을 실제로 보인다.
//         블레이드(ATA 72)와 같은 클래스·관계만 사용하며,
//         스키마 변경도 서버 코드 변경도 없다.
//
//   실행:
//     node seed/run_cypher.js seed/d008_skin.cypher
//     (접속 정보는 환경변수 NEO4J_URI / NEO4J_USER / NEO4J_PW / NEO4J_DATABASE)
//
//   원칙 — d008_blade.cypher 와 동일
//   1. 기존 SKIN 서브그래프(Part·Defect·ExternalCase)는 건드리지 않는다.
//      이미 FAA SDR 실적재로 채워져 있으므로 caseCount·weight 를 덮어쓰지 않는다.
//   2. 결함 "분류"는 기존에 적재된 것을 그대로 재사용한다. 신규 결함 코드를 만들지 않는다.
//   3. 수치는 지어내지 않는다. 허용 깊이·수리 범위는 기종별 SRM 소관이므로 여기 적지 않는다.
// ============================================================

// ── 1. 계통 · 부품 ──────────────────────────────────────────
//   이미 있으면 이름만 보정하고, 통계 속성은 건드리지 않는다.
MERGE (s53:System {code:'53'})
  SET s53.name = coalesce(s53.name, '동체 (Fuselage)');

MERGE (p:Part {name:'SKIN'})
  SET p.caseCount  = coalesce(p.caseCount, 0),
      p.confidence = coalesce(p.confidence, 0.80),
      p.isGeneric  = coalesce(p.isGeneric, false);

MATCH (p:Part {name:'SKIN'}), (s53:System {code:'53'})
MERGE (p)-[r:PART_OF]->(s53) SET r.weight = coalesce(r.weight, 1);

// ── 2. 출처 문서 ────────────────────────────────────────────
MERGE (doc:Document {title:'FAA-H-8083-31B Aviation Maintenance Technician Handbook — Airframe, Vol.1'})
  SET doc.kind = 'handbook', doc.publisher = 'FAA';

// ── 3. 검사 절차 ────────────────────────────────────────────
MERGE (pr:Procedure {id:'PR-SKIN-VIS'})
  SET pr.name        = '동체 외판 육안검사',
      pr.nameEn      = 'Fuselage Skin Visual Inspection',
      pr.description = '동체 외판 구역을 좌표로 특정하고 표면을 청결히 한 뒤 부식·균열·덴트 유무를 육안으로 확인한다. 접근이 어려운 사각지대는 촬영으로 증빙을 남긴다. 허용 깊이·수리 범위 판정은 해당 기종 구조수리교범(SRM) 기준을 따른다.',
      pr.sourcePage  = 'Airframe Vol.1 — Aircraft Cleaning and Corrosion Control';

MATCH (pr:Procedure {id:'PR-SKIN-VIS'}), (doc:Document)
WHERE doc.title STARTS WITH 'FAA-H-8083-31B'
MERGE (pr)-[:SOURCED_FROM]->(doc);

// 이미 적재된 SKIN 결함 전부에 연결 — 어떤 결함이 있는지 가정하지 않는다.
MATCH (d:Defect)-[:OCCURS_ON]->(:Part {name:'SKIN'}), (pr:Procedure {id:'PR-SKIN-VIS'})
MERGE (d)-[:REQUIRES_PROCEDURE]->(pr);

// 절차가 "어느 부품을 대상으로 하는가"를 명시한다.
//   Defect 노드는 이름만으로 식별되어 계통 간 공유된다(CORRODED 는 외판에도 블레이드에도 붙는다).
//   TARGETS 가 없으면 외판을 물었을 때 블레이드 절차가 딸려 나온다.
MATCH (pr:Procedure {id:'PR-SKIN-VIS'}), (p:Part {name:'SKIN'}) MERGE (pr)-[:TARGETS]->(p);

// ── 4. 절차 단계 ────────────────────────────────────────────
MATCH (pr:Procedure {id:'PR-SKIN-VIS'})
MERGE (st:Step {id:'ST-SKIN-1'}) SET st.seq=1, st.name='검사 구역 식별 — FS·스트링거 좌표 대조'
MERGE (pr)-[:HAS_STEP]->(st);
MATCH (pr:Procedure {id:'PR-SKIN-VIS'})
MERGE (st:Step {id:'ST-SKIN-2'}) SET st.seq=2, st.name='표면 오염·유막 제거 후 검사 조명 확보'
MERGE (pr)-[:HAS_STEP]->(st);
MATCH (pr:Procedure {id:'PR-SKIN-VIS'})
MERGE (st:Step {id:'ST-SKIN-3'}) SET st.seq=3, st.name='육안 검사 — 부식·균열·덴트 유무 확인'
MERGE (pr)-[:HAS_STEP]->(st);
MATCH (pr:Procedure {id:'PR-SKIN-VIS'})
MERGE (st:Step {id:'ST-SKIN-4'}) SET st.seq=4, st.name='사각지대 촬영 — 접근 곤란 구역 증빙 확보'
MERGE (pr)-[:HAS_STEP]->(st);
MATCH (pr:Procedure {id:'PR-SKIN-VIS'})
MERGE (st:Step {id:'ST-SKIN-5'}) SET st.seq=5, st.name='이상 부위 판정 — 교범 허용한도 대조 (정비사)'
MERGE (pr)-[:HAS_STEP]->(st);
MATCH (pr:Procedure {id:'PR-SKIN-VIS'})
MERGE (st:Step {id:'ST-SKIN-6'}) SET st.seq=6, st.name='판정·증빙 기록 및 후속 조치 지정'
MERGE (pr)-[:HAS_STEP]->(st);

// ── 5. 공구 ────────────────────────────────────────────────
//   블레이드 절차와 공유되는 공구(조명·확대경·무보풀 천)는 같은 노드를 재사용한다.
//   같은 공구가 두 계통에 걸쳐 쓰인다는 사실 자체가 그래프에 남는다.
MATCH (pr:Procedure {id:'PR-SKIN-VIS'})
MERGE (t:Tool {name:'검사용 조명'})       MERGE (pr)-[:REQUIRES_TOOL]->(t);
MATCH (pr:Procedure {id:'PR-SKIN-VIS'})
MERGE (t:Tool {name:'확대경'})            MERGE (pr)-[:REQUIRES_TOOL]->(t);
MATCH (pr:Procedure {id:'PR-SKIN-VIS'})
MERGE (t:Tool {name:'무보풀 천·세척액'})   MERGE (pr)-[:REQUIRES_TOOL]->(t);
MATCH (pr:Procedure {id:'PR-SKIN-VIS'})
MERGE (t:Tool {name:'검사거울'})          MERGE (pr)-[:REQUIRES_TOOL]->(t);
MATCH (pr:Procedure {id:'PR-SKIN-VIS'})
MERGE (t:Tool {name:'와전류탐상기'})       MERGE (pr)-[:REQUIRES_TOOL]->(t);
MATCH (pr:Procedure {id:'PR-SKIN-VIS'})
MERGE (t:Tool {name:'깊이 게이지'})        MERGE (pr)-[:REQUIRES_TOOL]->(t);

// ── 6. 안전 경고 ────────────────────────────────────────────
MATCH (pr:Procedure {id:'PR-SKIN-VIS'})
MERGE (w:SafetyWarning {text:'부식 제거 전 인접 구조·배선 손상 여부를 먼저 확인한다.'})
  SET w.type='경고', w.sourcePage='Airframe Vol.1'
MERGE (pr)-[:HAS_WARNING]->(w);
MATCH (pr:Procedure {id:'PR-SKIN-VIS'})
MERGE (w:SafetyWarning {text:'허용 깊이·수리 범위는 해당 기종 구조수리교범(SRM) 기준을 확인한다.'})
  SET w.type='주의', w.sourcePage='Airframe Vol.1'
MERGE (pr)-[:HAS_WARNING]->(w);
MATCH (pr:Procedure {id:'PR-SKIN-VIS'})
MERGE (w:SafetyWarning {text:'사각지대는 육안 확인만으로 판정하지 않고 촬영 증빙을 남긴다.'})
  SET w.type='주의', w.sourcePage='Airframe Vol.1'
MERGE (pr)-[:HAS_WARNING]->(w);

// ── 7. 적재 확인 ────────────────────────────────────────────
//   블레이드와 외판이 같은 구조로 채워졌는지 한눈에 비교한다.
MATCH (p:Part) WHERE p.name IN ['BLADE','SKIN']
OPTIONAL MATCH (p)-[:PART_OF]->(s:System)
OPTIONAL MATCH (d:Defect)-[:OCCURS_ON]->(p)
OPTIONAL MATCH (d)-[:REQUIRES_PROCEDURE]->(pr:Procedure)
OPTIONAL MATCH (pr)-[:HAS_STEP]->(st:Step)
OPTIONAL MATCH (pr)-[:REQUIRES_TOOL]->(t:Tool)
OPTIONAL MATCH (pr)-[:HAS_WARNING]->(w:SafetyWarning)
RETURN p.name AS 부품, s.code AS 계통,
       count(DISTINCT d)  AS 결함,
       count(DISTINCT pr) AS 절차,
       count(DISTINCT st) AS 단계,
       count(DISTINCT t)  AS 공구,
       count(DISTINCT w)  AS 주의사항
ORDER BY 부품;
