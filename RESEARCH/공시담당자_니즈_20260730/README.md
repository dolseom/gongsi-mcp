# 공시담당자·IR담당자 니즈 딥리서치 (2026-07-30)

dart-ftc-mcp 3축 구조 우선순위 검증을 위한 실무자 니즈 조사.

## 결론 요약

**3축 구조·축1 최우선 유지.** 조정: ① 축2에 "자진시정 10영업일 골든타임 감시" 추가, ② J004 정합성 자가점검 신설, ③ 공정위 Q&A 지식베이스 내장(경계사례 판정 근거 + 평가셋), ④ 정정 리스크 안내(커뮤니티 미충족 수요).

**궁극 목표**: "물어볼 사람이 없는 공시담당자가 '이거 공시사항이야?'라는 전화를 받은 순간부터 점검을 통과할 때까지, 모든 판단 질문에 근거를 동봉해 답하는 로컬 도구 — 자동화가 아니라 혼자서도 갖는 확신." (`outputs/04_질문코퍼스_궁극목표.md`)

## 읽는 순서

1. `outputs/00_executive_summary.md` — 5분 요약 + 3축 판정표
2. `outputs/04_질문코퍼스_궁극목표.md` — **실제 질문 1,102건 → 궁극 목표 도출** ← 최종 결론
3. `outputs/03_실무자_육성.md` — 실무자가 직접 쓴 글 49건 (블로그·브런치·블라인드·지식iN, 원문 인용)
4. `outputs/01_full_report/05_결론_3축_우선순위_검증.md` — 조정 제안 상세
5. `outputs/01_full_report/02~04` — 근거 본문 (위반 통계 / 페인포인트 구조 / 도구 공백)
6. `outputs/02_appendices/unresolved_refuted.md` — 단정하지 않은 것들

## 검증 체계

- `artifacts/claim_ledger.jsonl` — 핵심 주장 24건 원장 (high-risk 13건 전건 반증 검색 수행)
- `sources/sources.jsonl` — 소스 204건 / `sources/bibliography.md` — 등급별 목록
- `outputs/verified_claims.json` — 게이트 통과 23건 (본문 단정의 유일한 근거)
- 게이트: `validate_ledger.py` exit 0, signature는 `state.json` 참조

## 원자료

- `artifacts/agent_results/S1~S5_findings.md` — 조사 에이전트 5개의 상세 발견 (원문 인용 포함)
  - S1 공정위 컴플라이언스 (공정위 보도자료 PDF·FKI 건의서 원문 직접 추출)
  - S2 작성 관행 (선례 참고 워크플로 1인칭 기록)
  - S3 기한·과태료 관리 / S4 도구 생태계 / S5 담당자 직무 실태
