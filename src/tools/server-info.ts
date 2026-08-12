/**
 * server_info — 서버 자기소개·상태 진단
 *
 * 버전, 인증키 설정 여부(값은 절대 노출하지 않음), 오늘 호출 예산 잔량, 캐시 규모,
 * 로컬 데이터 신선도(공휴일 검증 연도·Q&A 건수)를 한 번에 돌려준다.
 *
 * 근거: 참고 아카이브 플레이북 권고 14 — "server_info 류 자기소개 도구가 없으면
 * 상태 점검을 도구로 할 수 없다" (dart-mcp 의 미흡점으로 기록된 항목).
 * "왜 느리지 / 한도가 얼마 남았지 / 키가 인식됐나" 류 질문의 진단 창구다.
 */

import { statSync } from 'node:fs';
import { z } from 'zod';
import { VERSION, getConfig } from '../lib/config.js';
import { getStore } from '../lib/store.js';
import { DAILY_LIMIT } from '../clients/dart.js';
import { holidayYearsStatus } from '../rules/business-days.js';
import { loadQnaKb } from '../kb/qna.js';

export const serverInfoInput = z.object({});

export function serverInfo(): unknown {
  const cfg = getConfig();
  const store = getStore();
  const cacheStats = store.stats();

  let dbBytes: number | null = null;
  try {
    dbBytes = store.dbPath === ':memory:' ? null : statSync(store.dbPath).size;
  } catch {
    dbBytes = null;
  }

  let qnaEntries: number | null = null;
  let qnaManualCheckDue: string | null = null;
  try {
    const kb = loadQnaKb();
    qnaEntries = kb.entries.length;
    qnaManualCheckDue = kb.manualCheckDue ?? null;
  } catch {
    // KB 로드 실패는 진단 응답 자체를 막지 않는다
  }

  const dartCallsToday = store.todayCallCount('dart');

  return {
    name: 'gongsi-mcp',
    version: VERSION,
    runtime: { node: process.versions.node, platform: process.platform },
    keys: {
      // 값은 어떤 경우에도 노출하지 않는다 — 설정 여부만
      dart_api_key_set: Boolean(cfg.dartApiKey),
      egroup_api_key_set: Boolean(cfg.egroupApiKey),
    },
    calls_today: {
      dart: dartCallsToday,
      egroup: store.todayCallCount('egroup'),
      dart_daily_limit: DAILY_LIMIT,
      dart_hard_stop_threshold: cfg.rateHardStop,
      dart_remaining_before_hard_stop: Math.max(0, cfg.rateHardStop - dartCallsToday),
      note: '하드스톱은 원문 다운로드만 거부합니다 — 목록 조회는 한도(20,000)까지 허용',
    },
    cache: {
      db_path: store.dbPath,
      db_bytes: dbBytes,
      corps_indexed: cacheStats.corps,
      bodies_cached: cacheStats.bodies,
      fts_available: store.ftsAvailable,
    },
    data: {
      holiday_years: holidayYearsStatus(),
      qna_entries: qnaEntries,
      qna_manual_check_due: qnaManualCheckDue,
    },
    config: {
      max_pages: cfg.maxPages,
      concurrency: cfg.concurrency,
      last_report_only: cfg.lastReportOnly,
    },
  };
}
