import type { PillarResult } from './analyzers'
import type { Violation } from '../types'

var WEIGHTS = { component: 0.35, token: 0.30, naming: 0.20, structure: 0.15 }

export interface DriftScore {
  score: number
  grade: string
  label: string
}

export function computeDriftScore(
  comp: PillarResult,
  token: PillarResult,
  naming: PillarResult,
  spacing: PillarResult
): DriftScore {
  var raw =
    comp.score * WEIGHTS.component +
    token.score * WEIGHTS.token +
    naming.score * WEIGHTS.naming +
    spacing.score * WEIGHTS.structure

  var score = Math.round(raw)
  return { score: score, grade: toGrade(score), label: toLabel(score) }
}

// Cap violations sent to UI — prevents massive postMessage payloads on large files
export function capViolations(violations: Violation[], limit: number): Violation[] {
  if (violations.length <= limit) return violations

  // Sort CRITICAL first, then MEDIUM, then LOW before capping
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
