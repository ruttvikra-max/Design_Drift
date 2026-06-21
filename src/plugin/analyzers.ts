// Analyzers — pure functions, no Figma API calls. Input: CollectedNode[]. Output: violations + pillar score.

import type { CollectedNode, TokenLibrary } from './traversal'
import type { Violation } from '../types'

export interface PillarResult {
  score: number
  violations: number
  universe: number
}

// Fields considered structural (high severity overrides)
var STRUCTURAL_FIELDS = ['children']
// Fields considered content changes (medium)
var CONTENT_FIELDS = ['characters']
// Fields considered visual only (low — often intentional theming)
var VISUAL_FIELDS = ['fills', 'strokes', 'opacity', 'effects', 'cornerRadius']

// Component types that require slash notation
var SLASH_REQUIRED = ['COMPONENT', 'COMPONENT_SET']
// Types checked for naming
var NAMING_CANDIDATES = ['FRAME', 'GROUP', 'SECTION', 'INSTANCE', 'COMPONENT', 'COMPONENT_SET']

// ─── Pillar 1: Component Integrity ───────────────────────────────────────────

export function analyzeComponents(nodes: CollectedNode[]): { violations: Violation[]; result: PillarResult } {
  var violations: Violation[] = []
  var universe = 0
  var weighted = 0

  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i]
    if (!n.isInstance) continue
    universe++

    if (n.mainComponentId === null) {
      violations.push({
        id: n.id + '_c1',
        nodeId: n.id,
        nodeName: n.name,
        pillar: 'component',
        severity: 'CRITICAL',
        type: 'DETACHED_INSTANCE',
        detail: 'Detached from source component — no link to library',
      })
      weighted += 3
      continue
    }

    var hasStructural = containsAny(n.overriddenFields, STRUCTURAL_FIELDS)
    var hasContent = containsAny(n.overriddenFields, CONTENT_FIELDS)
    var hasVisual = containsAny(n.overriddenFields, VISUAL_FIELDS)

    if (hasStructural) {
      violations.push({
        id: n.id + '_c2',
        nodeId: n.id,
        nodeName: n.name,
        pillar: 'component',
        severity: 'MEDIUM',
        type: 'STRUCTURAL_OVERRIDE',
        detail: 'Children structure changed from source component',
      })
      weighted += 2
    } else if (hasContent || hasVisual) {
      violations.push({
        id: n.id + '_c3',
        nodeId: n.id,
        nodeName: n.name,
        pillar: 'component',
        severity: 'LOW',
        type: 'VISUAL_OVERRIDE',
        detail: 'Visual or text properties overridden from component',
      })
      weighted += 1
    }
  }

  return {
    violations: violations,
    result: {
      score: universe === 0 ? 100 : Math.max(0, Math.round(100 * (1 - weighted / (universe * 3)))),
      violations: violations.length,
      universe: universe,
    },
  }
}

// ─── Pillar 2: Token Compliance ───────────────────────────────────────────────

export function analyzeTokens(
  nodes: CollectedNode[],
  library: TokenLibrary
): { violations: Violation[]; result: PillarResult } {
  var violations: Violation[] = []
  var universe = 0
  var weighted = 0

  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i]

    // Fill
    if (n.hasSolidFill) {
      universe++
      if (!n.isFillBound) {
        var tokenExists = n.fillColorHex !== null && library.colorHexes.has(n.fillColorHex)
        var fillSev = tokenExists ? 'MEDIUM' : 'CRITICAL'
        violations.push({
          id: n.id + '_t1',
          nodeId: n.id,
          nodeName: n.name,
          pillar: 'token',
          severity: fillSev,
          type: tokenExists ? 'TOKEN_NOT_BOUND' : 'HARDCODED_COLOR',
          detail: tokenExists
            ? 'Color matches a token but is not bound — use Variables or Styles'
            : 'Hardcoded fill color — bind to a token or create one',
        })
        weighted += tokenExists ? 2 : 3
      }
    }

    // Stroke
    if (n.hasStroke) {
      universe++
      if (!n.isStrokeBound) {
        violations.push({
          id: n.id + '_t2',
          nodeId: n.id,
          nodeName: n.name,
          pillar: 'token',
          severity: 'MEDIUM',
          type: 'HARDCODED_STROKE',
          detail: 'Stroke color not bound to a token',
        })
        weighted += 2
      }
    }

    // Corner radius
    if (n.rawCornerRadius !== null) {
      universe++
      if (!n.isCornerRadiusBound) {
        violations.push({
          id: n.id + '_t3',
          nodeId: n.id,
          nodeName: n.name,
          pillar: 'token',
          severity: 'LOW',
          type: 'HARDCODED_RADIUS',
          detail: 'Corner radius ' + n.rawCornerRadius + 'px — bind to a spacing/radius token',
        })
        weighted += 1
      }
    }

    // Font size
    if (n.rawFontSize !== null) {
      universe++
      if (!n.isFontSizeBound) {
        violations.push({
          id: n.id + '_t4',
          nodeId: n.id,
          nodeName: n.name,
          pillar: 'token',
          severity: 'MEDIUM',
          type: 'HARDCODED_FONT_SIZE',
          detail: 'Font size ' + n.rawFontSize + 'px — bind to a text style or variable',
        })
        weighted += 2
      }
    }
  }

  return {
    violations: violations,
    result: {
      score: universe === 0 ? 100 : Math.max(0, Math.round(100 * (1 - weighted / (universe * 3)))),
      violations: violations.length,
      universe: universe,
    },
  }
}

// ─── Pillar 3: Naming Governance ──────────────────────────────────────────────

export function analyzeNaming(nodes: CollectedNode[]): { violations: Violation[]; result: PillarResult } {
  var violations: Violation[] = []
  var universe = 0
  var weighted = 0

  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i]

    var isCandidate = NAMING_CANDIDATES.indexOf(n.type) > -1
    if (!isCandidate) continue
    universe++

    // 1. Auto-named check (takes priority)
    if (n.isAutoNamed) {
      var autoSev = n.depth <= 2 ? 'CRITICAL' : 'MEDIUM'
      violations.push({
        id: n.id + '_n1',
        nodeId: n.id,
        nodeName: n.name,
        pillar: 'naming',
        severity: autoSev,
        type: 'AUTO_NAMED',
        detail: 'Default Figma name at depth ' + n.depth + ' — give it a meaningful name',
      })
      weighted += autoSev === 'CRITICAL' ? 3 : 2
      continue
    }

    // 2. Slash convention check for component types
    if (SLASH_REQUIRED.indexOf(n.type) > -1 && n.name.indexOf('/') === -1) {
      violations.push({
        id: n.id + '_n2',
        nodeId: n.id,
        nodeName: n.name,
        pillar: 'naming',
        severity: 'LOW',
        type: 'MISSING_SLASH_HIERARCHY',
        detail: '"' + n.name + '" should use slash notation e.g. Button/Primary',
      })
      weighted += 1
    }
  }

  return {
    violations: violations,
    result: {
      score: universe === 0 ? 100 : Math.max(0, Math.round(100 * (1 - weighted / (universe * 3)))),
      violations: violations.length,
      universe: universe,
    },
  }
}

// ─── Pillar 4: Spacing ────────────────────────────────────────────────────────
// Approach A: flags hardcoded spacing not bound to a variable.
// Approach B: groups same-named frames across root screens, flags values that
//             deviate from the majority — catches spacing drift between screens
//             even when no variable system exists.

export function analyzeSpacing(nodes: CollectedNode[]): { violations: Violation[]; result: PillarResult } {
  var violations: Violation[] = []
  var universe = 0
  var weighted = 0

  // ── B: Cross-frame consistency ─────────────────────────────────────────────
  // Key: "nodeName::nodeType" — groups elements with identical names across screens
  var groups: { [key: string]: CollectedNode[] } = {}

  for (var gi = 0; gi < nodes.length; gi++) {
    var gn = nodes[gi]
    if (!gn.hasAutoLayout) continue
    if (gn.scope === 'component') continue
    if (!gn.rootFrameId) continue
    if (gn.isAutoNamed) continue           // skip "Frame 12" — not meaningful
    var gkey = gn.name + '::' + gn.type
    if (!groups[gkey]) groups[gkey] = []
    groups[gkey].push(gn)
  }

  var flaggedIds: { [id: string]: boolean } = {}

  for (var groupKey in groups) {
    var members = groups[groupKey]

    // Collect distinct root frames in this group
    var framesSeen: string[] = []
    for (var fi = 0; fi < members.length; fi++) {
      var fid = members[fi].rootFrameId
      if (fid && framesSeen.indexOf(fid) === -1) framesSeen.push(fid)
    }
    if (framesSeen.length < 2) continue    // only one screen — nothing to compare

    // For each spacing property, find the majority value and flag outliers
    var PROPS = ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'itemSpacing']
    var LABELS = ['padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'gap']

    for (var pi = 0; pi < PROPS.length; pi++) {
      var prop = PROPS[pi]
      var label = LABELS[pi]

      // Collect values per member
      var vals: number[] = []
      for (var vi = 0; vi < members.length; vi++) {
        var v = members[vi][prop as keyof CollectedNode]
        if (typeof v === 'number') vals.push(v)
      }
      if (vals.length < 2) continue

      // Find mode
      var counts: { [n: number]: number } = {}
      for (var ci = 0; ci < vals.length; ci++) { counts[vals[ci]] = (counts[vals[ci]] || 0) + 1 }
      var modeVal = vals[0]
      var modeCount = 0
      for (var ck in counts) {
        if (counts[ck] > modeCount) { modeCount = counts[ck]; modeVal = Number(ck) }
      }

      // Flag members whose value differs from mode
      for (var mi = 0; mi < members.length; mi++) {
        var memberVal = members[mi][prop as keyof CollectedNode]
        if (typeof memberVal !== 'number') continue
        if (memberVal === modeVal) continue

        var mid = members[mi].id
        if (flaggedIds[mid]) continue

        // CRITICAL when clear majority agrees; MEDIUM when it's ambiguous
        var sev: 'CRITICAL' | 'MEDIUM' = modeCount >= members.length - 1 ? 'CRITICAL' : 'MEDIUM'

        violations.push({
          id: mid + '_s_b_' + prop,
          nodeId: mid,
          nodeName: members[mi].name,
          pillar: 'spacing',
          severity: sev,
          type: 'SPACING_INCONSISTENT',
          detail: label + ': ' + memberVal + 'px — expected ' + modeVal + 'px (in ' + members[mi].rootFrameName + ')',
        })
        universe++
        weighted += sev === 'CRITICAL' ? 3 : 2
        flaggedIds[mid] = true
      }
    }
  }

  // ── A: Unbound spacing check ───────────────────────────────────────────────
  // Only fires for nodes NOT already flagged by B (B is a stronger signal).
  for (var ai = 0; ai < nodes.length; ai++) {
    var an = nodes[ai]
    if (!an.hasAutoLayout) continue
    if (an.scope === 'component') continue
    if (flaggedIds[an.id]) continue

    var hasPadding = (an.paddingTop !== null && an.paddingTop > 0) ||
                     (an.paddingRight !== null && an.paddingRight > 0) ||
                     (an.paddingBottom !== null && an.paddingBottom > 0) ||
                     (an.paddingLeft !== null && an.paddingLeft > 0)

    if (hasPadding) {
      universe++
      if (!an.isPaddingBound) {
        var pStr = [an.paddingTop, an.paddingRight, an.paddingBottom, an.paddingLeft]
          .map(function(v) { return v !== null ? String(v) : '0' }).join('/')
        violations.push({
          id: an.id + '_s_a_pad',
          nodeId: an.id,
          nodeName: an.name,
          pillar: 'spacing',
          severity: 'LOW',
          type: 'HARDCODED_PADDING',
          detail: 'Padding ' + pStr + 'px — not bound to a spacing variable',
        })
        weighted += 1
      }
    }

    if (an.itemSpacing !== null && an.itemSpacing > 0) {
      universe++
      if (!an.isItemSpacingBound) {
        violations.push({
          id: an.id + '_s_a_gap',
          nodeId: an.id,
          nodeName: an.name,
          pillar: 'spacing',
          severity: 'LOW',
          type: 'HARDCODED_GAP',
          detail: 'Gap ' + an.itemSpacing + 'px — not bound to a spacing variable',
        })
        weighted += 1
      }
    }
  }

  return {
    violations: violations,
    result: {
      score: universe === 0 ? 100 : Math.max(0, Math.round(100 * (1 - weighted / (universe * 3)))),
      violations: violations.length,
      universe: universe,
    },
  }
}

// ─── Util ─────────────────────────────────────────────────────────────────────

function containsAny(arr: string[], targets: string[]): boolean {
  for (var i = 0; i < targets.length; i++) {
    if (arr.indexOf(targets[i]) > -1) return true
  }
  return false
}
