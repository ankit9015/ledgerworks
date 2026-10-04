/**
 * The vocabulary shared by the verifier (L3.5), the migration output (L3.6), the API and the UI.
 * Types only here; the rules that choose a value live in the verifier. See DECISIONS.md (D46).
 */
export const VERDICT_CLASSES = [
  'verified_improvement',
  'inconclusive',
  'no_effect',
  'harmful',
  'unverifiable',
] as const;
export type VerdictClass = (typeof VERDICT_CLASSES)[number];

/**
 * How far a verdict can be trusted. `indicative` is the cap for anything measured on a sampled
 * shadow (a sample is not a scaled-down database). Only a full shadow can give `verified`.
 */
export const EVIDENCE_LEVELS = ['verified', 'indicative'] as const;
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];

export const RISK_LEVELS = ['low', 'medium', 'high'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/** What a person may be told. A sampled improvement is never called "verified". */
export function verdictLabel(cls: VerdictClass, evidence: EvidenceLevel): string {
  if (cls === 'verified_improvement')
    return evidence === 'verified'
      ? 'verified improvement'
      : 'indicative improvement (measured on a sample)';
  return cls.replaceAll('_', ' ') + (evidence === 'indicative' ? ' (measured on a sample)' : '');
}
