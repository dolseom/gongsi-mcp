/**
 * 도구 입력 공통 zod 스키마 — 도구마다 따로 쓰던 날짜·접수번호·공개년월 형식 검증을 한 벌로.
 * `.describe()`·`.optional()` 은 호출부에서 붙인다 (zod 스키마는 불변이라 공유해도 안전하다).
 */

import { z } from 'zod';
import { isValidYMD } from '../rules/business-days.js';

/**
 * YYYYMMDD 실존 날짜.
 * 정규식만으로는 20260231 이 통과해 `Date` 롤오버로 기한이 조용히 3월로 틀어진다 — round-trip 으로 거른다.
 */
export const ymdSchema = z
  .string()
  .regex(/^\d{8}$/, 'YYYYMMDD 형식이어야 합니다 (예: 20260722)')
  .refine(isValidYMD, '실존하지 않는 날짜입니다 (예: 20260231 은 2월 31일)');

/** DART 접수번호 14자리 */
export const rceptNoSchema = z
  .string()
  .regex(/^\d{14}$/, '접수번호는 14자리 숫자여야 합니다 (예: 20260728000484)');

/** 기업집단포털 공개년월 YYYYMM */
export const yearMonthSchema = z
  .string()
  .regex(/^\d{6}$/, '공개년월은 YYYYMM 형식입니다 (예: 202605)');
