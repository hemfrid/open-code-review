// SPDX-License-Identifier: Apache-2.0
// Post-processing seam over the OCR envelope. Spec §3.7: stages run in the hub after
// completeReview validates the envelope and before the poster; none of them touch the
// pod or the poster. v1 ships severityFloor only; the Kodus-derived stages are stubs.

import { SEVERITIES, type OcrComment, type OcrEnvelope, type Severity } from './envelope.ts';

export type StageContext = {
  projectName: string;
  prNumber: number;
  jobId: number;
  /** Diff text per path, when a stage needs it (verifierPass, validateSuggestions). */
  diffs?: Record<string, string>;
  log?: (msg: string) => void;
};

export type Stage = (envelope: OcrEnvelope, ctx: StageContext) => Promise<OcrEnvelope> | OcrEnvelope;

/** Run stages in order; each receives the previous stage's output. Stages must not mutate their input. */
export async function runStages(envelope: OcrEnvelope, ctx: StageContext, stages: Stage[]): Promise<OcrEnvelope> {
  let current = envelope;
  for (const stage of stages) current = await stage(current, ctx);
  return current;
}

const rank = (s: Severity | undefined): number => {
  // critical=4 ... low=1; a missing severity counts as low, matching ocr's normalisation.
  const i = SEVERITIES.indexOf(s ?? 'low');
  return i < 0 ? 1 : SEVERITIES.length - i;
};

/**
 * Move comments at or below `floor` out of `comments` into `routed_to_summary`.
 * Nothing is deleted: the poster renders routed findings in the summary comment.
 * Unanchored comments (start_line 0) are left alone; the poster already folds them.
 */
export function severityFloor(floor: Severity | ''): Stage {
  return (envelope) => {
    if (!floor) return envelope;
    const threshold = rank(floor);
    const keep: OcrComment[] = [];
    const routed = [...(envelope.routed_to_summary ?? [])];
    for (const c of envelope.comments) {
      const anchored = c.start_line >= 1 || c.end_line >= 1;
      if (anchored && rank(c.severity) <= threshold) routed.push({ comment: c, reason: `severity ${c.severity ?? 'low'} at or below floor ${floor}` });
      else keep.push(c);
    }
    return { ...envelope, comments: keep, routed_to_summary: routed };
  };
}

/**
 * Spec §3.7 verifierPass: one seat call per finding judging it against its diff hunk
 * (from `existing_code` located in ctx.diffs[path]); drop or downgrade unsupported
 * findings. Generator/evaluator split borrowed from Kodus. Not implemented in Phase 1.
 */
export function verifierPass(_opts: { model: string; call: (prompt: string) => Promise<string> }): Stage {
  return () => { throw new Error('verifierPass: not implemented (spec §3.7, v1.1)'); };
}

/**
 * Spec §3.7 dedupe: collapse findings sharing `path` and normalised `existing_code`
 * (whitespace-insensitive), keeping the highest severity. Not implemented in Phase 1.
 */
export function dedupe(): Stage {
  return () => { throw new Error('dedupe: not implemented (spec §3.7, v1.1)'); };
}

/**
 * Spec §3.7 validateSuggestions: apply each `suggestion_code` in a scratch checkout and
 * annotate the envelope with whether it applies and changes the diff. Runs as a second
 * review.sh step because it needs the pod's checkout. Not implemented in Phase 1.
 */
export function validateSuggestions(): Stage {
  return () => { throw new Error('validateSuggestions: not implemented (spec §3.7, v1.1)'); };
}
