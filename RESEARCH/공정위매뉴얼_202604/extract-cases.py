# 대규모내부거래 공시 업무 매뉴얼(2026.4.27) <참고: 주요 사례> 79문답 추출
# 출력: manual2026-lit-cases.json (build-ftc-qna.mjs 가 읽는 중간 산출물)
#
# 파싱 전략 (2022.3 FAQ 재추출기와 동일 계열):
#   ☞ 가 답변 시작 마커. i번째 ☞ 의 질문은 직전 ☞ 이후 구간에서 "i." 마커 뒤 텍스트.
#   구간 내 마지막 출현을 우선하되, 질문 검증(길이·☞ 미포함) 실패 시 앞 출현으로 후퇴.
import json
import re

t = open('txt_대규모내부거래.txt', encoding='utf-8').read()

starts = [m.start() for m in re.finditer(r'<참고 : 주요 사례>', t)]
sec = t[starts[-1]:]
end_m = re.search(r'<참고 : 공시 양식>', sec)
sec = sec[: end_m.start()]

# 페이지 마커·페이지번호 제거, 공백 정규화
sec = re.sub(r'===== PAGE \d+ =====', ' ', sec)
sec = re.sub(r'-\s?\d+\s?-', ' ', sec)
sec = re.sub(r'\s+', ' ', sec)

SUBSECTIONS = [
    ('가', '이사회 의결 및 공시대상 거래 여부'),
    ('나', '거래금액의 산정과 관련된 사항'),
    ('다', '동일 거래의 범위'),
    ('라', '상품ㆍ용역거래'),
]
# 소제목 위치·헤더 패턴 ("나. 거래금액의…" 처럼 접두 글자 포함으로만 매칭 —
# 본문이 소제목과 같은 문구로 시작하는 사례(#26)가 있어 제목 단독 매칭은 오절단을 만든다)
sub_pos = []
sub_patterns = []
for key, title in SUBSECTIONS:
    pat = re.compile(re.escape(key) + r'\.\s?' + re.escape(title))
    m = pat.search(sec)
    if not m:
        raise SystemExit(f'소제목 못 찾음: {key}. {title}')
    sub_pos.append((m.start(), m.end(), title))
    sub_patterns.append((pat, title))

# 표 구조가 텍스트 추출에서 유실되는 등 원문 자체의 한계가 있는 항목 — 재추출해도 재현되므로
# 항목별 주의 문구를 데이터에 동봉한다 (Codex 교차검토 중간 1)
ITEM_CAVEATS = {
    70: '원문 사례에 분기별 거래금액 표가 포함되어 있으나 PDF 텍스트 추출 과정에서 표의 행·열 구조가 '
        '유실되어 수치와 분기의 대응을 이 텍스트만으로 복원할 수 없습니다 — 정확한 수치는 원문 매뉴얼'
        '(공정위 2026. 4. 27., 주요 사례 #70)을 참조하세요. 계약② 기간 "\'24.3.1~\'24.2.28"은 원문 PDF '
        '표기 그대로이며, 문맥(25년 1/4분기까지의 표)상 종료일은 \'25.2.28의 오기로 보입니다.',
}

arrows = [m.start() for m in re.finditer('☞', sec)]
N = len(arrows)
items = []
prev_arrow = 0
for i, arrow in enumerate(arrows, start=1):
    window = sec[prev_arrow:arrow]
    marker = f'{i}.'
    cands = [m.start() for m in re.finditer(re.escape(marker), window)]
    if not cands:
        raise SystemExit(f'항목 {i}: 번호 마커 없음 (구간 {prev_arrow}~{arrow})')
    # 마커 유일성 게이트 — 질문·답변 속 날짜("2025.4.1.")·소수점이 항목 번호와 충돌하면
    # 조용한 오절단이 된다. 현재 79건 전 구간에서 후보가 정확히 1개임을 실측(Codex 재확인)했으므로
    # 복수 후보는 통과시키지 않고 빌드를 세워 수동 확인을 강제한다 (Codex 사소 1)
    if len(cands) != 1:
        raise SystemExit(f'항목 {i}: 번호 마커 후보 {len(cands)}개 — 원문 변경 여부 수동 확인 필요')
    q = None
    for c in reversed(cands):
        cand_q = window[c + len(marker):].strip()
        if 8 <= len(cand_q) <= 500 and '☞' not in cand_q:
            q = cand_q
            q_abs = prev_arrow + c
            break
    if q is None:
        raise SystemExit(f'항목 {i}: 질문 검증 실패, 후보 {len(cands)}개')
    # 질문 안에 소제목 헤더("나. 거래금액의…")가 박혀 있으면(섹션 경계) 헤더 뒤부터가 질문이다
    for pat, title in sub_patterns:
        hm = pat.search(q)
        if hm:
            q = q[hm.end():].strip()
    # 답변: ☞ 뒤부터 다음 항목 번호 마커 직전까지
    if i < N:
        nxt_window = sec[arrow:arrows[i]]
        nxt_cands = [m.start() for m in re.finditer(re.escape(f'{i+1}.'), nxt_window)]
        if len(nxt_cands) > 1:
            raise SystemExit(f'항목 {i}: 답변 종료 마커({i+1}.) 후보 {len(nxt_cands)}개 — 수동 확인 필요')
        a_end = arrow + (nxt_cands[-1] if nxt_cands else len(nxt_window))
        # 다음 질문 앞의 소제목 헤더도 답변에서 제외
        ans = sec[arrow + 1: a_end]
        for pat, title in sub_patterns:
            hm = pat.search(ans)
            if hm:
                ans = ans[: hm.start()].rstrip()
        ans = ans.strip()
    else:
        ans = sec[arrow + 1:].strip()
    # 현재 소제목
    subsection = None
    for s_start, s_end, title in sub_pos:
        if s_start <= q_abs:
            subsection = title
    if not ans:
        raise SystemExit(f'항목 {i}: 답변 없음')
    item = {'no': i, 'subsection': subsection, 'question': q, 'answer': ans}
    if i in ITEM_CAVEATS:
        item['caveats'] = [ITEM_CAVEATS[i]]
    items.append(item)
    prev_arrow = arrow

# ── 검증 게이트 ──
assert len(items) == 79, f'기대 79건, 실제 {len(items)}건'
for it in items:
    assert 8 <= len(it['question']) <= 500, f"질문 길이 이상 #{it['no']}: {len(it['question'])}"
    assert len(it['answer']) >= 10, f"답변 길이 이상 #{it['no']}"
    assert '☞' not in it['question'] and '☞' not in it['answer'], f"마커 잔존 #{it['no']}"

out = {
    'source': '대규모내부거래 등에 대한 이사회 의결 및 공시 업무 매뉴얼(2026. 4. 27.) <참고: 주요 사례>',
    'url': 'https://www.ftc.go.kr/www/selectBbsNttView.do?key=725&bordCd=101&nttSn=47396',
    'docYear': 2026,
    'items': items,
}
with open('manual2026-lit-cases.json', 'w', encoding='utf-8') as f:
    json.dump(out, f, ensure_ascii=False, indent=1)

from collections import Counter
print('총', len(items), '건 /', dict(Counter(i['subsection'] for i in items)))
for i in (1, 6, 11, 30, 47, 79):
    it = items[i - 1]
    print(f"--- #{i} [{it['subsection']}]")
    print('Q:', it['question'][:120])
    print('A:', it['answer'][:120])
