import { traversePage, collectTokenLibrary } from './traversal'
import { analyzeComponents, analyzeTokens, analyzeNaming } from './analyzers'
import { analyzeSpacing } from './spacing'
import { computeDriftScore, capViolations, scorePillar } from './scoring'

figma.showUI(__html__, { width: 360, height: 560, title: 'DSIE - Design System Inspector' })

figma.ui.on('message', function(msg: { type: string; nodeId?: string }) {
  if (msg.type === 'RUN_ANALYSIS') {
    runAnalysis()
  }

  if (msg.type === 'SELECT_NODE' && msg.nodeId) {
    try {
      var node = figma.getNodeById(msg.nodeId)
      if (node && 'parent' in node) {
        figma.currentPage.selection = [node as SceneNode]
        figma.viewport.scrollAndZoomIntoView([node as SceneNode])
      }
    } catch (e) {}
  }
})

function sleep(ms: number): Promise<void> {
  return new Promise(function(resolve) { setTimeout(resolve, ms) })
}

async function runAnalysis(): Promise<void> {
  try {
    // ── Step 1: Token library ──────────────────────────────────────────────
    figma.ui.postMessage({ type: 'SCAN_START', pageName: figma.currentPage.name })
    await sleep(0)

    var library = collectTokenLibrary()
    figma.ui.postMessage({ type: 'SCAN_TOKENS_DONE' })
    await sleep(0)

    // ── Step 2: Traversal ──────────────────────────────────────────────────
    var traversalResult = traversePage(function(count: number) {
      figma.ui.postMessage({ type: 'SCAN_PROGRESS', count: count })
    })

    var nodes = traversalResult.nodes
    figma.ui.postMessage({ type: 'SCAN_ANALYSIS' })
    await sleep(0)

    // ── Step 3: Analyse pillars ────────────────────────────────────────────
    var compAnalysis    = analyzeComponents(nodes)
    var tokenAnalysis   = analyzeTokens(nodes, library)
    var namingAnalysis  = analyzeNaming(nodes)
    var spacingAnalysis = analyzeSpacing(nodes)
    figma.ui.postMessage({ type: 'SCAN_SCORING' })
    await sleep(0)

    // ── Step 4: Compute drift score ────────────────────────────────────────
    var allViolations = compAnalysis.violations
      .concat(tokenAnalysis.violations)
      .concat(namingAnalysis.violations)
      .concat(spacingAnalysis.violations)

    allViolations.sort(function(a, b) {
      var order: Record<string, number> = { CRITICAL: 0, MEDIUM: 1, LOW: 2 }
      return order[a.severity] - order[b.severity]
    })

    var compScore    = scorePillar('component', compAnalysis.result)
    var tokenScore   = scorePillar('token', tokenAnalysis.result)
    var namingScore  = scorePillar('naming', namingAnalysis.result)
    var spacingScore = scorePillar('spacing', spacingAnalysis.result)

    var drift = computeDriftScore(compScore, tokenScore, namingScore, spacingScore)
    var violationsToSend = capViolations(allViolations, 1000)

    // Per-pillar counts are derived from the VIOLATIONS ACTUALLY SENT, so a tab's
    // number can never disagree with what its filter shows.
    function countPillar(pillar: string): number {
      var n = 0
      for (var k = 0; k < violationsToSend.length; k++) {
        if (violationsToSend[k].pillar === pillar) n++
      }
      return n
    }

    figma.ui.postMessage({
      type: 'ANALYSIS_COMPLETE',
      score: drift.score,
      grade: drift.grade,
      label: drift.label,
      fileName: figma.root.name,
      pageName: figma.currentPage.name,
      scannedNodes: nodes.length,
      truncated: traversalResult.truncated,
      totalViolations: violationsToSend.length,
      pillars: {
        component: { score: compScore,    violations: countPillar('component'), weight: 0.35 },
        token:     { score: tokenScore,   violations: countPillar('token'),     weight: 0.30 },
        naming:    { score: namingScore,  violations: countPillar('naming'),    weight: 0.20 },
        spacing:   { score: spacingScore, violations: countPillar('spacing'),   weight: 0.15 },
      },
      violations: violationsToSend,
    })
  } catch (err) {
    figma.ui.postMessage({
      type: 'SCAN_ERROR',
      message: err instanceof Error ? err.message : 'Unknown error during analysis',
    })
  }
}
