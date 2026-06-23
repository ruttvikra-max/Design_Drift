// Spacing engine — four independent detectors over one geometry pass.
// Each detector targets a different error class and tags violations with the
// screen they belong to (for per-screen reporting), plus evidence + confidence.
//
//   1. off-scale      — value breaks the 4px grid (per-screen, universal)
//   2. uniformity     — gaps in one stack that should be equal but aren't
//   3. repeatedItems  — repeated sibling cards/rows with mismatched padding
//   4. familyDrift    — same element differs across a screen family
//
// Geometry is measured from child bounding boxes, so it works for auto-layout
// AND manual layouts.

import type { CollectedNode } from './traversal'
import type { Violation, Severity } from '../types'

export interface PillarResult {
  penalty: number
  universe: number
  violationCount: number
}

var SEV_WEIGHT: { [k: string]: number } = { CRITICAL: 3, MEDIUM: 2, LOW: 1 }

var GRID = 4             // spacing scale: values should be multiples of this
var TOL = 0.5            // px — sub-pixel noise
var SP_MIN = 1           // ignore 0 (touching) and negatives/overlaps
var SP_MAX = 256         // values above this are layout distances, not spacing tokens

interface Metrics {
  node: CollectedNode
  path: string
  padL: number; padT: number; padR: number; padB: number
  gaps: number[]
  axis: string           // 'x' | 'y'
  kids: CollectedNode[]  // children sorted along the layout axis
}

// ─── Geometry pass ──────────────────────────────────────────────────────────

function buildGeometry(nodes: CollectedNode[]): { metrics: Metrics[]; byId: { [id: string]: CollectedNode } } {
  var byId: { [id: string]: CollectedNode } = {}
  var childrenByParent: { [pid: string]: CollectedNode[] } = {}
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i]
    byId[n.id] = n
    if (n.parentId) {
      if (!childrenByParent[n.parentId]) childrenByParent[n.parentId] = []
      childrenByParent[n.parentId].push(n)
    }
  }

  var pathCache: { [id: string]: string } = {}
  function structuralPath(node: CollectedNode): string {
    if (pathCache[node.id] !== undefined) return pathCache[node.id]
    var parts: string[] = []
    var cur: CollectedNode | null = node
    var guard = 0
    while (cur && guard < 200) {
      if (cur.parentId !== null) parts.unshift(String(cur.childIndex))
      cur = cur.parentId ? (byId[cur.parentId] || null) : null
      guard++
    }
    var p = parts.join('/')
    pathCache[node.id] = p
    return p
  }

  var metrics: Metrics[] = []
  for (var ci = 0; ci < nodes.length; ci++) {
    var c = nodes[ci]
    if (c.scope === 'component') continue
    if (c.type === 'GROUP') continue            // group child coords are unreliable
    var kids = childrenByParent[c.id]
    if (!kids || kids.length < 1) continue
    if (c.width <= 0 || c.height <= 0) continue

    var minX = Infinity, minY = Infinity, maxR = -Infinity, maxB = -Infinity
    for (var ki = 0; ki < kids.length; ki++) {
      var k = kids[ki]
      if (k.x < minX) minX = k.x
      if (k.y < minY) minY = k.y
      if (k.x + k.width > maxR) maxR = k.x + k.width
      if (k.y + k.height > maxB) maxB = k.y + k.height
    }

    var spreadX = 0, spreadY = 0
    for (var si = 0; si < kids.length; si++) {
      if (Math.abs(kids[si].x - kids[0].x) > spreadX) spreadX = Math.abs(kids[si].x - kids[0].x)
      if (Math.abs(kids[si].y - kids[0].y) > spreadY) spreadY = Math.abs(kids[si].y - kids[0].y)
    }
    var horizontal = spreadX >= spreadY
    var sorted = kids.slice().sort(function(a, b) { return horizontal ? (a.x - b.x) : (a.y - b.y) })

    var gaps: number[] = []
    for (var gi = 1; gi < sorted.length; gi++) {
      var prev = sorted[gi - 1]
      var g = horizontal ? sorted[gi].x - (prev.x + prev.width) : sorted[gi].y - (prev.y + prev.height)
      gaps.push(g)
    }

    metrics.push({
      node: c, path: structuralPath(c),
      padL: minX, padT: minY, padR: c.width - maxR, padB: c.height - maxB,
      gaps: gaps, axis: horizontal ? 'x' : 'y', kids: sorted,
    })
  }

  return { metrics: metrics, byId: byId }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function locOf(n: CollectedNode): string {
  return (n.rootFrameName && n.rootFrameName.length) ? n.rootFrameName : ('Screen #' + n.screenIndex)
}
function famOf(n: CollectedNode): string {
  return (n.screenFamily && n.screenFamily.length) ? n.screenFamily : (n.rootFrameName || '')
}
function fmt(v: number): string {
  var r = Math.round(v * 10) / 10
  return (Number.isInteger(r) ? String(r) : r.toFixed(1)) + 'px'
}
function offGridBy(v: number): number {
  var nearest = Math.round(v / GRID) * GRID
  return Math.abs(v - nearest)
}
function inRange(v: number): boolean { return isFinite(v) && v >= SP_MIN && v <= SP_MAX }

// ─── Detector 1: off the 4px grid ──────────────────────────────────────────────

function detectOffScale(metrics: Metrics[], v: Violation[], seen: { [k: string]: boolean }): { penalty: number; universe: number } {
  var penalty = 0, universe = 0
  var ROLES = [
    { key: 'padT', label: 'Top padding' }, { key: 'padR', label: 'Right padding' },
    { key: 'padB', label: 'Bottom padding' }, { key: 'padL', label: 'Left padding' },
  ]
  for (var i = 0; i < metrics.length; i++) {
    var m = metrics[i]
    // paddings
    for (var r = 0; r < ROLES.length; r++) {
      var val = (m as any)[ROLES[r].key] as number
      if (!inRange(val)) continue
      universe++
      if (offGridBy(val) > TOL) {
        var k = m.node.id + ':' + ROLES[r].key
        if (seen[k]) continue
        seen[k] = true
        v.push({
          id: m.node.id + '_os_' + ROLES[r].key, nodeId: m.node.id, nodeName: m.node.name,
          pillar: 'spacing', severity: 'LOW', type: 'OFF_GRID_PADDING',
          detail: ROLES[r].label + ' ' + fmt(val) + ' is off the ' + GRID + 'px grid',
          actual: fmt(val), location: locOf(m.node),
        })
        penalty += SEV_WEIGHT.LOW
      }
    }
    // gaps
    for (var g = 0; g < m.gaps.length; g++) {
      var gv = m.gaps[g]
      if (!inRange(gv)) continue
      universe++
      if (offGridBy(gv) > TOL) {
        var gk = m.node.id + ':gap' + g
        if (seen[gk]) continue
        seen[gk] = true
        v.push({
          id: m.node.id + '_os_gap' + g, nodeId: m.node.id, nodeName: m.node.name,
          pillar: 'spacing', severity: 'MEDIUM', type: 'OFF_GRID_GAP',
          detail: 'Gap ' + fmt(gv) + ' is off the ' + GRID + 'px grid',
          actual: fmt(gv), location: locOf(m.node),
        })
        penalty += SEV_WEIGHT.MEDIUM
      }
    }
  }
  return { penalty: penalty, universe: universe }
}

// ─── Detector 2: gap uniformity within one container ───────────────────────────

function detectUniformity(metrics: Metrics[], v: Violation[], seen: { [k: string]: boolean }): { penalty: number; universe: number } {
  var penalty = 0, universe = 0
  for (var i = 0; i < metrics.length; i++) {
    var m = metrics[i]
    var vals: number[] = []
    for (var g = 0; g < m.gaps.length; g++) { if (inRange(m.gaps[g])) vals.push(m.gaps[g]) }
    if (vals.length < 3) continue   // need enough gaps to expect uniformity

    universe++
    var stats = mode(vals)
    if (stats.count * 2 <= vals.length) continue   // no dominant value → not meant to be uniform

    // count distinct off-mode values
    var offs: number[] = []
    for (var x = 0; x < vals.length; x++) { if (Math.abs(vals[x] - stats.value) > TOL) offs.push(vals[x]) }
    if (offs.length === 0 || offs.length >= vals.length - stats.count + 1) continue

    var k = m.node.id + ':uniform'
    if (seen[k]) continue
    seen[k] = true
    var sev: Severity = stats.count >= vals.length - 1 ? 'CRITICAL' : 'MEDIUM'
    penalty += SEV_WEIGHT[sev]
    v.push({
      id: m.node.id + '_uni', nodeId: m.node.id, nodeName: m.node.name,
      pillar: 'spacing', severity: sev, type: 'UNEVEN_GAPS',
      detail: 'Uneven spacing in this stack — ' + offs.length + ' gap(s) differ from ' + fmt(stats.value),
      actual: fmt(offs[0]), expected: fmt(stats.value), location: locOf(m.node),
      agreement: stats.count + ' of ' + vals.length + ' gaps are ' + fmt(stats.value),
    })
  }
  return { penalty: penalty, universe: universe }
}

// ─── Detector 3: repeated sibling items with mismatched padding ─────────────────

function detectRepeatedItems(metrics: Metrics[], byId: { [id: string]: CollectedNode }, v: Violation[], seen: { [k: string]: boolean }): { penalty: number; universe: number } {
  var penalty = 0, universe = 0
  var metricById: { [id: string]: Metrics } = {}
  for (var i = 0; i < metrics.length; i++) metricById[metrics[i].node.id] = metrics[i]

  // group container-metrics by their parent
  var byParent: { [pid: string]: Metrics[] } = {}
  for (var j = 0; j < metrics.length; j++) {
    var p = metrics[j].node.parentId
    if (!p) continue
    if (!byParent[p]) byParent[p] = []
    byParent[p].push(metrics[j])
  }

  for (var pid in byParent) {
    var sibs = byParent[pid]
    if (sibs.length < 3) continue

    // cohort = siblings of same type and similar size (repeated cards/rows)
    var used: { [id: string]: boolean } = {}
    for (var a = 0; a < sibs.length; a++) {
      if (used[sibs[a].node.id]) continue
      var cohort: Metrics[] = [sibs[a]]
      for (var b = a + 1; b < sibs.length; b++) {
        if (used[sibs[b].node.id]) continue
        if (sibs[b].node.type !== sibs[a].node.type) continue
        if (!similar(sibs[a].node, sibs[b].node)) continue
        cohort.push(sibs[b])
      }
      if (cohort.length < 3) continue
      for (var u = 0; u < cohort.length; u++) used[cohort[u].node.id] = true

      // compare a representative padding role (top + left — leading paddings)
      var ROLES = ['padT', 'padL']
      for (var rr = 0; rr < ROLES.length; rr++) {
        var entries: { m: Metrics; val: number }[] = []
        for (var c = 0; c < cohort.length; c++) {
          var val = (cohort[c] as any)[ROLES[rr]] as number
          if (inRange(val) || val === 0) entries.push({ m: cohort[c], val: val })
        }
        if (entries.length < 3) continue
        universe++
        var vals: number[] = []
        for (var e = 0; e < entries.length; e++) vals.push(entries[e].val)
        var st = mode(vals)
        if (st.count * 2 <= vals.length) continue
        for (var e2 = 0; e2 < entries.length; e2++) {
          if (Math.abs(entries[e2].val - st.value) <= TOL) continue
          var node = entries[e2].m.node
          var key = node.id + ':rep' + rr
          if (seen[key]) continue
          seen[key] = true
          penalty += SEV_WEIGHT.MEDIUM
          v.push({
            id: node.id + '_rep' + rr, nodeId: node.id, nodeName: node.name,
            pillar: 'spacing', severity: 'MEDIUM', type: 'REPEATED_ITEM_MISMATCH',
            detail: (ROLES[rr] === 'padT' ? 'Top' : 'Left') + ' padding ' + fmt(entries[e2].val) + ' differs from its matching siblings',
            actual: fmt(entries[e2].val), expected: fmt(st.value), location: locOf(node),
            agreement: st.count + ' of ' + entries.length + ' siblings use ' + fmt(st.value),
          })
        }
      }
    }
  }
  return { penalty: penalty, universe: universe }
}

// ─── Detector 4: cross-family drift ─────────────────────────────────────────────

function detectFamilyDrift(metrics: Metrics[], v: Violation[], seen: { [k: string]: boolean }): { penalty: number; universe: number } {
  var penalty = 0, universe = 0
  var groups: { [key: string]: Metrics[] } = {}
  for (var i = 0; i < metrics.length; i++) {
    var m = metrics[i]
    var key = famOf(m.node) + '||' + m.path + '::' + m.node.type
    if (!groups[key]) groups[key] = []
    groups[key].push(m)
  }

  for (var gk in groups) {
    var members = groups[gk]
    if (members.length < 2) continue
    var screens: number[] = []
    for (var s = 0; s < members.length; s++) { if (screens.indexOf(members[s].node.screenIndex) === -1) screens.push(members[s].node.screenIndex) }
    if (screens.length < 2) continue

    var maxGaps = 0
    for (var mg = 0; mg < members.length; mg++) { if (members[mg].gaps.length > maxGaps) maxGaps = members[mg].gaps.length }

    var dims: { kind: string; idx: number; label: string }[] = []
    for (var gd = 0; gd < maxGaps; gd++) dims.push({ kind: 'gap', idx: gd, label: maxGaps > 1 ? ('Gap #' + (gd + 1)) : 'Gap between items' })
    dims.push({ kind: 'padT', idx: -1, label: 'Top padding' })
    dims.push({ kind: 'padL', idx: -1, label: 'Left padding' })
    dims.push({ kind: 'padB', idx: -1, label: 'Bottom padding' })
    dims.push({ kind: 'padR', idx: -1, label: 'Right padding' })

    var flagged: { [id: string]: boolean } = {}
    for (var di = 0; di < dims.length; di++) {
      var dim = dims[di]
      var entries: { m: Metrics; val: number }[] = []
      for (var mi = 0; mi < members.length; mi++) {
        var val = dim.kind === 'gap' ? (dim.idx < members[mi].gaps.length ? members[mi].gaps[dim.idx] : NaN) : ((members[mi] as any)[dim.kind] as number)
        if (!inRange(val)) continue
        entries.push({ m: members[mi], val: val })
      }
      if (entries.length < 2) continue
      universe++
      var vals: number[] = []
      for (var e = 0; e < entries.length; e++) vals.push(entries[e].val)
      var st = mode(vals)
      if (entries.length > 2 && st.count * 2 <= entries.length) continue   // no canonical majority

      for (var e2 = 0; e2 < entries.length; e2++) {
        if (Math.abs(entries[e2].val - st.value) <= TOL) continue
        var node = entries[e2].m.node
        if (flagged[node.id]) continue
        var conf = st.count / entries.length
        var mag = Math.abs(entries[e2].val - st.value) / Math.max(st.value, entries[e2].val, 1)
        var sev: Severity = (entries.length === 2 || conf < 0.6) ? 'MEDIUM' : (mag >= 0.4 ? 'CRITICAL' : 'MEDIUM')
        var dk = node.id + ':' + dim.kind + dim.idx
        if (seen[dk]) continue
        seen[dk] = true
        flagged[node.id] = true
        penalty += SEV_WEIGHT[sev] * conf * Math.min(1, Math.max(0.3, mag))
        v.push({
          id: node.id + '_fd_' + dim.kind + dim.idx, nodeId: node.id, nodeName: node.name,
          pillar: 'spacing', severity: sev, type: 'FAMILY_DRIFT',
          detail: dim.label + ' ' + fmt(entries[e2].val) + ' — most ' + famOf(node) + ' screens use ' + fmt(st.value),
          actual: fmt(entries[e2].val), expected: fmt(st.value), location: locOf(node),
          agreement: st.count + ' of ' + entries.length + ' screens use ' + fmt(st.value),
        })
      }
    }
  }
  return { penalty: penalty, universe: universe }
}

// ─── Orchestrator ──────────────────────────────────────────────────────────────

export function analyzeSpacing(nodes: CollectedNode[]): { violations: Violation[]; result: PillarResult } {
  var geo = buildGeometry(nodes)
  var violations: Violation[] = []
  var seen: { [k: string]: boolean } = {}   // shared dedupe across detectors (node + role)
  var penalty = 0, universe = 0

  // Order matters for dedupe priority: most-specific signal first.
  var r4 = detectFamilyDrift(geo.metrics, violations, seen);   penalty += r4.penalty; universe += r4.universe
  var r2 = detectUniformity(geo.metrics, violations, seen);    penalty += r2.penalty; universe += r2.universe
  var r3 = detectRepeatedItems(geo.metrics, geo.byId, violations, seen); penalty += r3.penalty; universe += r3.universe
  var r1 = detectOffScale(geo.metrics, violations, seen);      penalty += r1.penalty; universe += r1.universe

  return { violations: violations, result: { penalty: penalty, universe: universe, violationCount: violations.length } }
}

// ─── util ────────────────────────────────────────────────────────────────────

function mode(vals: number[]): { value: number; count: number } {
  var counts: { [b: number]: number } = {}
  for (var i = 0; i < vals.length; i++) { var b = Math.round(vals[i]); counts[b] = (counts[b] || 0) + 1 }
  var mv = Math.round(vals[0]), mc = 0
  for (var k in counts) { if (counts[k] > mc) { mc = counts[k]; mv = Number(k) } }
  return { value: mv, count: mc }
}

function similar(a: CollectedNode, b: CollectedNode): boolean {
  var dw = Math.abs(a.width - b.width) / Math.max(a.width, b.width, 1)
  var dh = Math.abs(a.height - b.height) / Math.max(a.height, b.height, 1)
  return dw <= 0.1 && dh <= 0.1
}
