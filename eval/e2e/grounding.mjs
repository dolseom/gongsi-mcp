// e2e 근거 대조 — 답변 속 인용·금액·비율·조문이 **이 실행의 도구 출력에 실제로 있었나**.
//
// 왜: grade.mjs 는 문항별 기대 문구만 본다. 서버 지침의 "법령 수치·조문·날짜는 도구 출력만 쓰고
// 기억으로 보충하지 마세요" · "정의·예외·단서는 도구 문장을 따옴표로 그대로 인용" 위반은
// 기대 문구에 안 걸리면 통과한다. 이 모듈은 문항과 무관하게 그 위반을 **센다** (판정이 아니라 측정).
// korean-law-mcp citation-content-matcher(정규화 후 포함 검사)에서 착안 — 2026-10-18.
//
// ⚠️ "근거 없음" = 이 실행의 도구 출력에서 못 찾음. 틀렸다는 뜻이 아니다(계산 결과·질문 속 숫자일 수 있다).
//    부작용 없는 모듈이다 — 테스트(test/eval-e2e-grounding.test.mjs)가 import 한다.

/** tool_result content(문자열 또는 블록 배열) → 전체 텍스트 */
function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);
  return content.map((b) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : JSON.stringify(b))).join('\n');
}

/**
 * stream-json → { answer, toolText }. toolText 는 지정 접두사 도구의 결과 **전문**을 이은 것이다
 * (parse-stream.mjs 는 200자 head 만 남기므로 쓰지 않는다).
 */
export function extractRun(streamText, toolPrefix = 'mcp__gongsi__') {
  const nameById = new Map();
  const parts = [];
  let answer = '';
  for (const line of String(streamText).split(/\r?\n/)) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    let ev;
    try {
      ev = JSON.parse(s);
    } catch {
      continue;
    }
    const content = ev.message?.content;
    if (ev.type === 'assistant' && Array.isArray(content)) {
      for (const b of content) if (b?.type === 'tool_use') nameById.set(b.id, b.name);
    } else if (ev.type === 'user' && Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === 'tool_result' && String(nameById.get(b.tool_use_id) ?? '').startsWith(toolPrefix)) {
          parts.push(contentText(b.content));
        }
      }
    } else if (ev.type === 'result' && typeof ev.result === 'string') {
      answer = ev.result;
    }
  }
  return { answer, toolText: parts.join('\n') };
}

/** 공백·강조·따옴표·가운뎃점 변형 제거 — 표기 차이만 흡수하고 내용은 건드리지 않는다 */
export function normalizeText(s) {
  return String(s)
    .replace(/\\n/g, ' ')
    .replace(/[\s*_`~"'“”‘’「」『』·ㆍ・‧∙,.]/g, '');
}

const UNIT = { 조: 1e12, 억: 1e8, 만: 1e4 };

/** "1억 2,000만원" · "5,000만 원" · "60억원" → 원. 해석 불가면 null */
export function parseKoreanAmount(expr) {
  const s = expr.replace(/[\s,]/g, '');
  let total = 0;
  let matched = false;
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)(조|억|만)/g)) {
    total += Number(m[1]) * UNIT[m[2]];
    matched = true;
  }
  const tail = /(?:조|억|만)?(\d+)원$/.exec(s);
  if (!matched) return tail ? Number(tail[1]) : null;
  return Math.round(total);
}

// '조' 는 뒤에 숫자·원이 올 때만 금액 단위다 — "제27조에" 의 조를 27조원으로 읽지 않게
const AMOUNT_RE = /\d[\d,]*(?:\.\d+)?\s*(?:조(?=\s*[\d원])|억|만)(?:\s*\d[\d,]*(?:\.\d+)?\s*(?:억|만))*\s*원?/g;
const PERCENT_RE = /\d+(?:\.\d+)?\s*%/g;
const ARTICLE_RE = /제\s*\d+\s*조(?:\s*의\s*\d+)?/g;
const QUOTE_RE = /[“"]([^“”"\n]{15,300})[”"]|「([^」\n]{15,300})」/g;

/** 도구 출력에 나온 금액(원)·비율 값 집합 — JSON 정수(원 단위)와 한글 금액 표기 둘 다 */
function corpusValues(toolText) {
  const won = new Set();
  const pct = new Set();
  for (const m of toolText.matchAll(AMOUNT_RE)) {
    const v = parseKoreanAmount(m[0]);
    if (v !== null) won.add(v);
  }
  for (const m of toolText.matchAll(/\d[\d,]{3,}/g)) won.add(Number(m[0].replace(/,/g, '')));
  for (const m of toolText.matchAll(PERCENT_RE)) pct.add(Number(m[0].replace(/[\s%]/g, '')));
  // 비율이 0.75 같은 소수로 실리는 경우 (rate 필드)
  for (const m of toolText.matchAll(/(?<![\d.])0\.\d+/g)) pct.add(Math.round(Number(m[0]) * 10000) / 100);
  return { won, pct };
}

/**
 * 답변의 주장 단위를 뽑아 도구 출력과 대조한다.
 * @returns {{ claims: number, grounded: number, ungrounded: Array<{kind: string, text: string}> }}
 */
export function checkGrounding(answer, toolText) {
  const normTool = normalizeText(toolText);
  const { won, pct } = corpusValues(toolText);
  const ungrounded = [];
  let claims = 0;
  const seen = new Set();
  const check = (kind, text, ok) => {
    const key = `${kind}:${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    claims++;
    if (!ok) ungrounded.push({ kind, text });
  };

  for (const m of answer.matchAll(QUOTE_RE)) {
    const q = (m[1] ?? m[2]).trim();
    // 곧은 따옴표는 짝이 어긋나기 쉽다 — 강조 기호(**)를 품은 구간은 인용이 아니라 문단 사이를 잡은 것이다
    if (q.includes('**')) continue;
    // 「…」 는 법령명 표기에도 쓰인다 — 그것도 도구 출력에 있어야 하는 것은 같다
    check('quote', q, normTool.includes(normalizeText(q)));
  }
  for (const m of answer.matchAll(AMOUNT_RE)) {
    const v = parseKoreanAmount(m[0]);
    if (v === null) continue;
    check('amount', m[0].trim(), won.has(v));
  }
  for (const m of answer.matchAll(PERCENT_RE)) {
    check('percent', m[0].trim(), pct.has(Number(m[0].replace(/[\s%]/g, ''))));
  }
  for (const m of answer.matchAll(ARTICLE_RE)) {
    const a = m[0].replace(/\s/g, '');
    check('article', a, normTool.includes(a));
  }
  return { claims, grounded: claims - ungrounded.length, ungrounded };
}
