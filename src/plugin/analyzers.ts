// Analyzers â€” pure functions, no Figma API calls. Input: CollectedNode[].
// Output: violations + a PillarResult carrying the raw penalty + universe
// (the score itself is computed in scoring.ts so the curve lives in one place).

import type { CollectedNode, TokenLibrary } from './traversal'
import type { Violation, Severity } from '../types'

export interface PillarResult {
  penalty: number       // accumulated, severity/confidence/magnitude weighted
  universe: number      // number of checks performed (denominator for scoring)
  violationCount: number
}

var SEV_WEIGHT: { [k: string]: number } = { CRITICAL: 3, MEDIUM: 2, LOW: 1 }

// Component override classes
var STRUCTURAL_FIELDS = ['children']

// Types checked for naming
var SLASH_REQUIRED = ['COMPONENT', 'COMPONENT_SET']
var NAMING_CANDIDATES = ['FRAME', 'GROUP', 'SECTION', 'INSTANCE', 'COMPONENT', 'COMPONENT_SET']

// Colors so common they're almost always intentional, not a missing token
var NEUTRAL_HEXES = ['#ffffff', '#000000']

// â”€â”€â”€ Pillar 1: Component Integrity â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Precision-focused: an instance overriding its own fills/text is the *normal*
// use of instances, so we no longer flag that. We only flag the two things that
// genuinely indicate drift: a broken link to the source, and structural edits.

export function analyzeComponents(nodes: CollectedNode[]): { violations: Violation[]; result: PillarResult } {
  var violations: Violation[] = []
  var universe = 0
  var penalty = 0

  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i]
    if (!n.isInstance) continue
    universe++

    if (n.mainComponentId === null) {
      violations.push({
        id: n.id + '_c1', nodeId: n.id, nodeName: n.name,
        pillar: 'component', severity: 'CRITICAL', type: 'MISSING_MAIN_COMPONENT',
        detail: 'Instance has no link to a source component (deleted or detached)',
      })
      penalty += SEV_WEIGHT.CRITICAL
      continue
    }

    if (containsAny(n.overriddenFields, STRUCTURAL_FIELDS)) {
      violations.push({
        id: n.id + '_c2', nodeId: n.id, nodeName: n.name,
        pillar: 'component', severity: 'MEDIUM', type: 'STRUCTURAL_OVERRIDE',
        detail: 'Child structure changed from the source component',
      })
      penalty += SEV_WEIGHT.MEDIUM
    }
  }

  return { violations: violations, result: { penalty: penalty, universe: universe, violationCount: violations.length } }
}

// â”€â”€â”€ Pillar 2: Token Compliance â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Respects file context: if the file has no token system at all, we don't nag
// about binding to tokens. Pure white/black fills are treated as intentional.

export function analyzeTokens(
  nodes: CollectedNode[],
  library: TokenLibrary
): { violations: Violation[]; result: PillarResult } {
  var violations: Violation[] = []
  var universe = 0
  var penalty = 0

  // No token system in this file â†’ token-binding violations are just noise.
  if (!library.hasAnyTokens) {
    return { violations: violations, result: { penalty: 0, universe: 0, violationCount: 0 } }
  }

  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i]

    // Fill
    if (n.hasSolidFill) {
      var isNeutral = n.fillColorHex !== null && NEUTRAL_HEXES.indexOf(n.fillColorHex) > -1
      if (!isNeutral) {
        universe++
        if (!n.isFillBound) {
          var tokenExists = n.fillColorHex !== null && library.colorHexes.has(n.fillColorHex)
          var fillSev: Severity = tokenExists ? 'MEDIUM' : 'CRITICAL'
          violations.push({
            id: n.id + '_t1', nodeId: n.id, nodeName: n.name,
            pillar: 'token', severity: fillSev,
            type: tokenExists ? 'TOKEN_NOT_BOUND' : 'HARDCODED_COLOR',
            detail: tokenExists
              ? 'Color matches a token but is not bound â€” use the Variable or Style'
              : 'Hardcoded fill color â€” bind to a token or create one',
            actual: n.fillColorHex || undefined,
          })
          penalty += SEV_WEIGHT[fillSev]
        }
      }
    }

    // Stroke
    if (n.hasStroke) {
      universe++
      if (!n.isStrokeBound) {
        violations.push({
          id: n.id + '_t2', nodeId: n.id, nodeName: n.name,
          pillar: 'token', severity: 'MEDIUM', type: 'HARDCODED_STROKE',
          detail: 'Stroke color not bound to a token',
        })
        penalty += SEV_WEIGHT.MEDIUM
      }
    }

    // Corner radius
    if (n.rawCornerRadius !== null) {
      universe++
      if (!n.isCornerRadiusBound) {
        violations.push({
          id: n.id + '_t3', nodeId: n.id, nodeName: n.name,
          pillar: 'token', severity: 'LOW', type: 'HARDCODED_RADIUS',
          detail: 'Corner radius ' + n.rawCornerRadius + 'px â€” bind to a radius token',
        })
        penalty += SEV_WEIGHT.LOW
      }
    }

    // Font size
    if (n.rawFontSize !== null) {
      universe++
      if (!n.isFontSizeBound) {
        violations.push({
          id: n.id + '_t4', nodeId: n.id, nodeName: n.name,
          pillar: 'token', severity: 'MEDIUM', type: 'HARDCODED_FONT_SIZE',
          detail: 'Font size ' + n.rawFontSize + 'px â€” bind to a text style or variable',
        })
        penalty += SEV_WEIGHT.MEDIUM
      }
    }
  }

  return { violations: violations, result: { penalty: penalty, universe: universe, violationCount: violations.length } }
}

// â”€â”€â”€ Pillar 3: Naming Governance â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function analyzeNaming(nodes: CollectedNode[]): { violations: Violation[]; result: PillarResult } {
  var violations: Violation[] = []
  var universe = 0
  var penalty = 0

  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i]
    if (NAMING_CANDIDATES.indexOf(n.type) === -1) continue
    universe++

    if (n.isAutoNamed) {
      // Severity scales with depth: a default-named screen matters far more than
      // a default-named utility frame buried deep in the tree.
      var autoSev: Severity = n.depth === 0 ? 'CRITICAL' : (n.depth <= 2 ? 'MEDIUM' : 'LOW')
      violations.push({
        id: n.id + '_n1', nodeId: n.id, nodeName: n.name,
        pillar: 'naming', severity: autoSev, type: 'AUTO_NAMED',
        detail: 'Default Figma name at depth ' + n.depth + ' â€” give it a meaningful name',
      })
      penalty += SEV_WEIGHT[autoSev]
      continue
    }

    if (SLASH_REQUIRED.indexOf(n.type) > -1 && n.name.indexOf('/') === -1) {
      violations.push({
        id: n.id + '_n2', nodeId: n.id, nodeName: n.name,
        pillar: 'naming', severity: 'LOW', type: 'MISSING_SLASH_HIERARCHY',
        detail: '"' + n.name + '" should use slash notation, e.g. Button/Primary',
      })
      penalty += SEV_WEIGHT.LOW
    }
  }

  return { violations: violations, result: { penalty: penalty, universe: universe, violationCount: violations.length } }
}

// â”€â”€â”€ Util â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function containsAny(arr: string[], targets: string[]): boolean {
  for (var i = 0; i < targets.length; i++) {
    if (arr.indexOf(targets[i]) > -1) return true
  }
  return false
}
