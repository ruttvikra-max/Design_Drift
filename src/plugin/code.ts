import { traversePage, collectTokenLibrary } from './traversal'
import { analyzeComponents, analyzeTokens, analyzeNaming, analyzeSpacing } from './analyzers'
import { computeDriftScore, capViolations } from './scoring'

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

    var drift = computeDriftScore(
      compAnalysis.result, tokenAnalysis.result,
      namingAnalysis.result, spacingAnalysis.result
    )
    var violationsToSend = capViolations(allViolations, 500)

    figma.ui.postMessage({
      type: 'ANALYSIS_COMPLETE',
      score: drift.score,
      grade: drift.grade,
      label: drift.label,
      fileName: figma.root.name,
      pageName: figma.currentPage.name,
      scannedNodes: nodes.length,
      truncated: traversalResult.truncated,
      totalViolations: allViolations.length,
      pillars: {
        component: { score: compAnalysis.result.score,   violations: compAnalysis.result.violations,   weight: 0.35 },
        token:     { score: tokenAnalysis.result.score,   violations: tokenAnalysis.result.violations,   weight: 0.30 },
        naming:    { score: namingAnalysis.result.score,  violations: namingAnalysis.result.violations,  weight: 0.20 },
        spacing:   { score: spacingAnalysis.result.score, violations: spacingAnalysis.result.violations, weight: 0.15 },
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
