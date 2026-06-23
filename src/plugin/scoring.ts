import type { PillarResult } from './analyzers'
import type { Violation, Pillar } from '../types'

// Overall pillar weights (must sum to 1)
var WEIGHTS = { component: 0.35, token: 0.30, naming: 0.20, spacing: 0.15 }

// Per-pillar leniency. The score is 100 * (1 - SCALE * rate), where rate is the
// share of checks that drifted (penalty / max possible penalty). A lower SCALE
// means a more forgiving pillar. Spacing is the most lenient per the product
// decision: drift only meaningfully lowers the score when it's widespread, so a
// single deliberate deviation still surfaces as a violation without tanking the
// grade.
var PENALTY_SCALE: { [k in Pillar]: number } = {
  component: 0.80,
  token: 0.80,
  naming: 0.70,
  spacing: 0.55,
}

var SEV_MAX = 3   // a CRITICAL violation's per-check weight

export interface DriftScore {
  score: number
  grade: string
  label: string
}

// Turn a pillar's raw penalty + universe into a 0–100 score.
export function scorePillar(pillar: Pillar, r: PillarResult): number {
  if (r.universe === 0) return 100
  var rate = r.penalty / (r.universe * SEV_MAX)
  if (rate > 1) rate = 1
  if (rate < 0) rate = 0
  var score = 100 * (1 - PENALTY_SCALE[pillar] * rate)
  return Math.max(0, Math.min(100, Math.round(score)))
}

export function computeDriftScore(
  component: number,
  token: number,
  naming: number,
  spacing: number
): DriftScore {
  var raw =
    component * WEIGHTS.component +
    token * WEIGHTS.token +
    naming * WEIGHTS.naming +
    spacing * WEIGHTS.spacing

  var score = Math.round(raw)
  return { score: score, grade: toGrade(score), label: toLabel(score) }
}

// Cap violations sent to the UI — prevents huge postMessage payloads on big files.
export function capViolations(violations: Violation[], limit: number): Violation[] {
  if (violations.length <= limit) return violations
  var sorted = violations.slice().sort(function(a, b) {
    var order: Record<string, number> = { CRITICAL: 0, MEDIUM: 1, LOW: 2 }
    return order[a.severity] - order[b.severity]
  })
  return sorted.slice(0, limit)
}

function toGrade(s: number): string {
  if (s >= 90) return 'A'
  if (s >= 75) return 'B'
  if (s >= 60) return 'C'
  if (s >= 40) return 'D'
  return 'F'
}

function toLabel(s: number): string {
  if (s >= 90) return 'HEALTHY'
  if (s >= 75) return 'STABLE'
  if (s >= 60) return 'DRIFTING'
  if (s >= 40) return 'DEGRADED'
  return 'CRITICAL'
}
