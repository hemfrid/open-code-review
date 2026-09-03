// SPDX-License-Identifier: Apache-2.0
// OCR JSON envelope: types, validation, normalisation, and review_jobs row derivation.
// Spec: spec-hub-direct-relay-review.md §1.3 (shape), §3.5 (completeReview steps 1-4).
//
// Validation is hand-rolled so this module has zero dependencies; the hub may swap
// the checks in parseEnvelope for a zod schema without changing the exported types.

export const CATEGORIES = ['bug', 'security', 'performance', 'maintainability', 'test', 'style', 'documentation', 'other'] as const;
export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type Category = (typeof CATEGORIES)[number];
export type Severity = (typeof SEVERITIES)[number];

export type OcrStatus = 'success' | 'completed_with_warnings' | 'completed_with_errors' | 'skipped' | 'failed' | string;
export type TerminalState = 'complete' | 'partial' | 'failed' | 'skipped';

export type OcrComment = {
  path: string;
  content: string;
  start_line: number;   // 0 = unanchored, fold into summary
  end_line: number;
  existing_code?: string;
  suggestion_code?: string;
  thinking?: string;
  category?: Category;
  severity?: Severity;
  [k: string]: unknown;
};

export type OcrSummary = {
  files_reviewed: number;
  comments: number;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  elapsed: string;      // Go duration string, e.g. "1m12s"
  budget_exceeded?: boolean;
  [k: string]: unknown;
};

export type CoverageItem = { item_id?: string; path: string; old_path?: string; fingerprint?: string; classification?: string; reason?: string; [k: string]: unknown };

export type OcrManifest = {
  schema_version?: string | number;
  run_id?: string;
  parent_run_id?: string;
  operation?: string;
  terminal_state: TerminalState;
  repository?: { identity_sha256?: string };
  input?: { mode?: string; requested_from?: string; resolved_base?: string; resolved_head?: string; exact_range?: string; [k: string]: unknown };
  execution?: { ocr_version?: string; provider?: string; model?: string; configured_concurrency?: number; rule_config_sha256?: string; runtime_config_sha256?: string; [k: string]: unknown };
  coverage?: { selected?: CoverageItem[]; completed?: CoverageItem[]; reused?: CoverageItem[]; failed?: CoverageItem[]; waived?: CoverageItem[] };
  run_failure?: unknown;
  elapsed_ms?: number;
  [k: string]: unknown;
};

export type OcrWarning = { file?: string; message: string; type?: string; [k: string]: unknown };

export type OcrEnvelope = {
  status: OcrStatus;
  llm?: { provider?: string; model?: string };
  trace_id?: string;
  message?: string;
  summary?: OcrSummary;
  tool_calls?: { total?: number; by_tool?: Record<string, number> };
  comments: OcrComment[];
  groups?: unknown;
  warnings?: OcrWarning[];
  project_summary?: unknown;
  resume?: { resumed_from?: string; reused_files?: number; rerun_files?: number; previous_model?: string; current_model?: string };
  session_id?: string;
  manifest?: OcrManifest;
  retry_report?: unknown;
  /** Added by hub post-processing (postprocess.ts); never emitted by ocr itself. */
  routed_to_summary?: Array<{ comment: OcrComment; reason: string }>;
  [k: string]: unknown;
};

export type ParseResult = { ok: true; envelope: OcrEnvelope } | { ok: false; error: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

export function normalizeCategory(v: unknown): Category {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return (CATEGORIES as readonly string[]).includes(s) ? (s as Category) : 'other';
}

export function normalizeSeverity(v: unknown): Severity {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return (SEVERITIES as readonly string[]).includes(s) ? (s as Severity) : 'low';
}

/** Validate the required envelope fields, normalise enums, keep unknown fields. */
export function parseEnvelope(input: unknown): ParseResult {
  if (!isObj(input)) return { ok: false, error: 'envelope is not an object' };
  if (typeof input.status !== 'string' || !input.status) return { ok: false, error: 'envelope.status missing' };
  if (!Array.isArray(input.comments)) return { ok: false, error: 'envelope.comments missing or not an array' };
  if (input.llm !== undefined && !isObj(input.llm)) return { ok: false, error: 'envelope.llm is not an object' };
  if (input.summary !== undefined && !isObj(input.summary)) return { ok: false, error: 'envelope.summary is not an object' };
  if (input.manifest !== undefined) {
    if (!isObj(input.manifest)) return { ok: false, error: 'envelope.manifest is not an object' };
    const ts = input.manifest.terminal_state;
    if (!['complete', 'partial', 'failed', 'skipped'].includes(String(ts))) return { ok: false, error: `manifest.terminal_state invalid: ${String(ts)}` };
  }
  if (input.warnings !== undefined && !Array.isArray(input.warnings)) return { ok: false, error: 'envelope.warnings is not an array' };

  const comments: OcrComment[] = [];
  for (let i = 0; i < input.comments.length; i++) {
    const c = input.comments[i];
    if (!isObj(c)) return { ok: false, error: `comments[${i}] is not an object` };
    if (typeof c.path !== 'string' || !c.path) return { ok: false, error: `comments[${i}].path missing` };
    if (typeof c.content !== 'string') return { ok: false, error: `comments[${i}].content missing` };
    const start = c.start_line ?? 0, end = c.end_line ?? 0;
    if (!isInt(start) || !isInt(end) || start < 0 || end < 0) return { ok: false, error: `comments[${i}] line numbers invalid` };
    const out: OcrComment = { ...c, path: c.path, content: c.content, start_line: start, end_line: end };
    if (c.category !== undefined) out.category = normalizeCategory(c.category);
    if (c.severity !== undefined) out.severity = normalizeSeverity(c.severity);
    for (const k of ['existing_code', 'suggestion_code', 'thinking'] as const) {
      if (c[k] !== undefined && typeof c[k] !== 'string') return { ok: false, error: `comments[${i}].${k} is not a string` };
    }
    comments.push(out);
  }
  const envelope: OcrEnvelope = { ...(input as object), status: input.status, comments } as OcrEnvelope;
  return { ok: true, envelope };
}

/** Parse a Go time.Duration string ("1m12s", "45s", "2h3m", "1.5s", "250ms") into milliseconds. */
export function parseGoDuration(s: string | undefined | null): number | null {
  if (typeof s !== 'string' || !s.trim()) return null;
  const str = s.trim();
  if (str === '0') return 0;
  const re = /(\d+(?:\.\d+)?)(ms|us|µs|ns|h|m|s)/g;   // longer units first, else "250ms" tokenises as "250m"+"s"
  let total = 0, consumed = 0, m: RegExpExecArray | null;
  const unit: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1000, ms: 1, us: 0.001, 'µs': 0.001, ns: 0.000001 };
  while ((m = re.exec(str)) !== null) { total += parseFloat(m[1]) * unit[m[2]]; consumed += m[0].length; }
  if (consumed !== str.replace(/^-/, '').length) return null;
  return Math.round(str.startsWith('-') ? -total : total);
}

export type JobStatus = 'succeeded' | 'partial' | 'failed';

/** Spec §3.5 step 4: exit code and manifest terminal state decide the job row status. */
export function deriveJobStatus(exitCode: number, envelope: OcrEnvelope | null): JobStatus {
  if (exitCode !== 0 || !envelope) return 'failed';
  const ts = envelope.manifest?.terminal_state;
  if (ts === 'complete') return 'succeeded';
  if (ts === 'partial') return 'partial';
  if (ts === 'failed') return 'failed';
  if (ts === 'skipped') return 'succeeded';
  // Older ocr builds may omit the manifest: fall back to the envelope status.
  switch (envelope.status) {
    case 'success': case 'completed_with_warnings': case 'skipped': return 'succeeded';
    case 'completed_with_errors': return 'partial';
    default: return 'failed';
  }
}

export type ReviewJobRowSummary = {
  ocrStatus: string;
  terminalState: TerminalState | null;
  filesReviewed: number | null;
  commentsTotal: number;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  elapsedMs: number | null;
  llmModel: string | null;
  sessionId: string | null;
};

/** Columns for the review_jobs row (spec §3.4), derived from the envelope. */
export function summarizeForRow(envelope: OcrEnvelope): ReviewJobRowSummary {
  const s = envelope.summary;
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    ocrStatus: envelope.status,
    terminalState: envelope.manifest?.terminal_state ?? null,
    filesReviewed: num(s?.files_reviewed),
    commentsTotal: envelope.comments.length,
    inputTokens: num(s?.input_tokens),
    outputTokens: num(s?.output_tokens),
    totalTokens: num(s?.total_tokens),
    elapsedMs: num(envelope.manifest?.elapsed_ms) ?? parseGoDuration(s?.elapsed),
    llmModel: envelope.llm?.model ?? envelope.manifest?.execution?.model ?? null,
    sessionId: envelope.session_id ?? null,
  };
}

/** Copy of the envelope with model reasoning removed (non-owner API responses, spec §5). */
export function stripThinking(envelope: OcrEnvelope): OcrEnvelope {
  const strip = (c: OcrComment): OcrComment => { const { thinking: _t, ...rest } = c; return rest as OcrComment; };
  return {
    ...envelope,
    comments: envelope.comments.map(strip),
    ...(envelope.routed_to_summary ? { routed_to_summary: envelope.routed_to_summary.map((r) => ({ ...r, comment: strip(r.comment) })) } : {}),
  };
}
