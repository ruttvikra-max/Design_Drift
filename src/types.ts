export type Severity = 'CRITICAL' | 'MEDIUM' | 'LOW'
export type Pillar = 'component' | 'token' | 'naming' | 'spacing'

export interface Violation {
  id: string
  nodeId: string
  nodeName: string
  pillar: Pillar
  severity: Severity
  type: string
  detail: string
}

export interface PillarSummary {
  score: number
  violations: number
  weight: number
}

export interface AnalysisResult {
  score: number
  grade: string
  label: string
  fileName: string
  pageName: string
  scannedNodes: number
  totalViolations: number
  truncated: boolean
  pillars: {
    component: PillarSummary
    token: PillarSummary
    naming: PillarSummary
    spacing: PillarSummary
  }
  violations: Violation[]
}
