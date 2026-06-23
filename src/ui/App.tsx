import React, { useState, useEffect, useRef } from 'react'
import type { AnalysisResult, Violation, Pillar } from '../../src/types'
import './App.css'

type View = 'idle' | 'scanning' | 'results' | 'error'
type ActiveFilter = 'all' | Pillar
type StepState = 'pending' | 'active' | 'done'

const IDLE_STEPS: StepState[] = ['pending', 'pending', 'pending', 'pending']

export default function App() {
  const [view, setView] = useState<View>('idle')
  const [result, setResult] = useState<AnalysisResult | null>(null)
  const [filter, setFilter] = useState<ActiveFilter>('all')
  const [scanCount, setScanCount] = useState(0)
  const [scanPageName, setScanPageName] = useState('')
  const [stepStates, setStepStates] = useState<StepState[]>(IDLE_STEPS)
  const [errorMsg, setErrorMsg] = useState('')

  // Timers and pending result are refs so they don't trigger re-renders
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  const pendingResult = useRef<AnalysisResult | null>(null)

  function clearTimers() {
    timers.current.forEach(clearTimeout)
    timers.current = []
  }

  function after(ms: number, fn: () => void) {
    const t = setTimeout(fn, ms)
    timers.current.push(t)
  }

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data.pluginMessage
      if (!msg) return

      if (msg.type === 'SCAN_START') {
        clearTimers()
        pendingResult.current = null
        setScanCount(0)
        setScanPageName(msg.pageName as string)

        // Step 1 active immediately
        setStepStates(['active', 'pending', 'pending', 'pending'])
        setView('scanning')

        // Auto-advance step 1 → step 2 after 900ms (matches widget)
        after(900, () => setStepStates(['done', 'active', 'pending', 'pending']))
      }

      // Live element counter while step 2 runs
      if (msg.type === 'SCAN_PROGRESS') {
        setScanCount(msg.count as number)
      }

      if (msg.type === 'ANALYSIS_COMPLETE') {
        // Hold the result — don't show it yet
        pendingResult.current = msg as AnalysisResult

        // Cancel any pending step 1→2 timer (for very fast files)
        clearTimers()

        // Step 2 done → step 3 active (950ms) → step 4 active (600ms) → results
        setStepStates(['done', 'done', 'active', 'pending'])
        after(950, () => {
          setStepStates(['done', 'done', 'done', 'active'])
          after(600, () => {
            setStepStates(['done', 'done', 'done', 'done'])
            after(250, () => {
              if (pendingResult.current) {
                setResult(pendingResult.current)
                setFilter('all')
                setView('results')
              }
            })
          })
        })
      }

      if (msg.type === 'SCAN_ERROR') {
        clearTimers()
        setErrorMsg((msg as any).message || 'Unknown error')
        setView('error')
      }
    }

    window.addEventListener('message', handler)
    return () => {
      window.removeEventListener('message', handler)
      clearTimers()
    }
  }, [])

  const runAnalysis = () => {
    clearTimers()
    parent.postMessage({ pluginMessage: { type: 'RUN_ANALYSIS' } }, '*')
  }

  const selectNode = (nodeId: string) => {
    parent.postMessage({ pluginMessage: { type: 'SELECT_NODE', nodeId } }, '*')
  }

  const filteredViolations = result?.violations.filter(
    v => filter === 'all' || v.pillar === filter
  ) ?? []

  if (view === 'idle') return <IdleView onRun={runAnalysis} />
  if (view === 'scanning') return <ScanningView stepStates={stepStates} scanCount={scanCount} pageName={scanPageName} />
  if (view === 'error') return <ErrorView message={errorMsg} onRetry={runAnalysis} />
  if (view === 'results' && result) {
    return (
      <ResultsView
        result={result}
        violations={filteredViolations}
        filter={filter}
        onFilterChange={setFilter}
        onSelectNode={selectNode}
        onRunAgain={runAnalysis}
      />
    )
  }

  return <IdleView onRun={runAnalysis} />
}

// ─── Idle View ────────────────────────────────────────────────────────────────

function IdleView({ onRun }: { onRun: () => void }) {
  return (
    <div className="view idle-view">
      <div className="idle-logo">
        <div className="idle-logo-mark">⬡</div>
        <div className="idle-logo-name">DSIE</div>
        <div className="idle-logo-sub">Design System Inspector</div>
      </div>

      <div className="idle-pillars">
        <div className="idle-pillar" style={{ color: 'var(--pillar-component)' }}>
          <span className="idle-pillar-dot" />
          Component Integrity
        </div>
        <div className="idle-pillar" style={{ color: 'var(--pillar-token)' }}>
          <span className="idle-pillar-dot" />
          Token Compliance
        </div>
        <div className="idle-pillar" style={{ color: 'var(--pillar-naming)' }}>
          <span className="idle-pillar-dot" />
          Naming Governance
        </div>
        <div className="idle-pillar" style={{ color: 'var(--pillar-spacing)' }}>
          <span className="idle-pillar-dot" />
          Spacing Consistency
        </div>
      </div>

      <button className="btn-primary run-btn" onClick={onRun}>
        Run Analysis
      </button>

      <p className="idle-hint">Scans the current page</p>
    </div>
  )
}

// ─── Scanning View ─────────────────────────────────────────────────────────────

const STEP_META = [
  { title: 'Reading token library',  sub: 'Variables and local styles'   },
  { title: 'Scanning elements',      sub: ''                              },
  { title: 'Analysing pillars',      sub: 'Component · Token · Naming'   },
  { title: 'Computing drift score',  sub: 'Weighting and grading'        },
]

function ScanningView({ stepStates, scanCount, pageName }: {
  stepStates: StepState[]
  scanCount: number
  pageName: string
}) {
  const doneCount = stepStates.filter(s => s === 'done').length
  const hasActive = stepStates.includes('active')
  const progress = (doneCount / 4) * 100 + (hasActive ? 5 : 0)

  return (
    <div className="view scan-view">
      <div className="scan-header">
        <div className="scan-header-label">Analysing</div>
        <div className="scan-header-page">{pageName || 'Current page'}</div>
        <div className="scan-track">
          <div className="scan-fill" style={{ width: `${progress}%` }} />
        </div>
      </div>

      <div className="scan-steps">
        {STEP_META.map((meta, i) => {
          const sub = i === 1
            ? (scanCount > 0 ? `${scanCount.toLocaleString()} elements` : 'Traversing element tree')
            : meta.sub
          return (
            <ScanStep
              key={i}
              title={meta.title}
              sub={sub}
              state={stepStates[i]}
              isLast={i === STEP_META.length - 1}
            />
          )
        })}
      </div>
    </div>
  )
}

function ScanStep({ title, sub, state, isLast }: {
  title: string
  sub: string
  state: StepState
  isLast: boolean
}) {
  return (
    <div className={`scan-step scan-step--${state}`}>
      {!isLast && <div className={`scan-step-line scan-step-line--${state}`} />}
      <div className="scan-step-ind">
        {state === 'done'    && <i className="ti ti-check" aria-hidden="true" />}
        {state === 'active'  && <div className="scan-pulse" />}
      </div>
      <div className="scan-step-body">
        <div className="scan-step-title">{title}</div>
        {sub && <div className="scan-step-sub">{sub}</div>}
      </div>
    </div>
  )
}

function ErrorView({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="view scanning-view">
      <div style={{ fontSize: 28, marginBottom: 8 }}>⚠</div>
      <div className="scanning-label" style={{ color: 'var(--severity-critical)' }}>Scan failed</div>
      <div className="scanning-sub" style={{ textAlign: 'center', maxWidth: 260, marginTop: 4 }}>{message}</div>
      <button className="btn-primary" style={{ marginTop: 20, maxWidth: 160 }} onClick={onRetry}>Try again</button>
    </div>
  )
}

// ─── Results View ──────────────────────────────────────────────────────────────

interface ResultsProps {
  result: AnalysisResult
  violations: Violation[]
  filter: ActiveFilter
  onFilterChange: (f: ActiveFilter) => void
  onSelectNode: (id: string) => void
  onRunAgain: () => void
}

function ResultsView({ result, violations, filter, onFilterChange, onSelectNode, onRunAgain }: ResultsProps) {
  const scoreColor = getScoreColor(result.score)

  return (
    <div className="view results-view">

      {/* Header */}
      <div className="results-header">
        <div className="results-meta">
          <span className="results-filename">{result.pageName}</span>
          <span className="results-node-count">
            {result.scannedNodes.toLocaleString()} elements
            {result.truncated ? ' (capped)' : ''}
          </span>
        </div>
        <button className="btn-ghost" onClick={onRunAgain}>Re-scan</button>
      </div>

      {/* Score */}
      <div className="score-card">
        <div className="score-left">
          <div className="score-number" style={{ color: scoreColor }}>{result.score}</div>
          <div className="score-grade" style={{ color: scoreColor }}>{result.grade}</div>
        </div>
        <div className="score-right">
          <div className="score-label" style={{ color: scoreColor }}>{result.label}</div>
          <div className="score-bar-stack">
            <PillarBar label="Component" score={result.pillars.component.score} color="var(--pillar-component)" />
            <PillarBar label="Token" score={result.pillars.token.score} color="var(--pillar-token)" />
            <PillarBar label="Naming" score={result.pillars.naming.score} color="var(--pillar-naming)" />
            <PillarBar label="Spacing" score={result.pillars.spacing.score} color="var(--pillar-spacing)" />
          </div>
        </div>
      </div>

      {/* Total issues summary */}
      <div className="issues-summary">
        {result.totalViolations === 0 ? (
          <span className="issues-summary-clean">No issues found — designs are consistent 🎉</span>
        ) : (
          <>
            <span className="issues-summary-count">{result.totalViolations.toLocaleString()}</span>
            <span className="issues-summary-label">
              {result.totalViolations === 1 ? 'issue to review' : 'issues to review'} — pick a pillar below to navigate
            </span>
          </>
        )}
      </div>

      {/* Filter tabs */}
      <div className="filter-tabs">
        <FilterTab label="All" count={result.totalViolations} active={filter === 'all'} onClick={() => onFilterChange('all')} />
        <FilterTab label="Component" count={result.pillars.component.violations} active={filter === 'component'} onClick={() => onFilterChange('component')} color="var(--pillar-component)" />
        <FilterTab label="Token" count={result.pillars.token.violations} active={filter === 'token'} onClick={() => onFilterChange('token')} color="var(--pillar-token)" />
        <FilterTab label="Naming" count={result.pillars.naming.violations} active={filter === 'naming'} onClick={() => onFilterChange('naming')} color="var(--pillar-naming)" />
        <FilterTab label="Spacing" count={result.pillars.spacing.violations} active={filter === 'spacing'} onClick={() => onFilterChange('spacing')} color="var(--pillar-spacing)" />
      </div>

      {/* Cap notice */}
      {result.violations.length < result.totalViolations && (
        <div className="cap-notice">
          Showing top {result.violations.length} of {result.totalViolations.toLocaleString()} — critical issues first
        </div>
      )}

      {/* Violation list */}
      <div className="violation-list">
        {violations.length === 0 && (
          <div className="violation-empty">No violations in this pillar</div>
        )}
        {violations.map(v => (
          <ViolationRow key={v.id} violation={v} onSelect={() => onSelectNode(v.nodeId)} />
        ))}
      </div>
    </div>
  )
}

// ─── Sub-components ────────────────────────────────────────────────────────────

function PillarBar({ label, score, color }: { label: string; score: number; color: string }) {
  return (
    <div className="pillar-bar-row">
      <span className="pillar-bar-label">{label}</span>
      <div className="pillar-bar-track">
        <div className="pillar-bar-fill" style={{ width: `${score}%`, background: color }} />
      </div>
      <span className="pillar-bar-score" style={{ color }}>{score}</span>
    </div>
  )
}

function FilterTab({ label, count, active, onClick, color }: {
  label: string; count: number; active: boolean; onClick: () => void; color?: string
}) {
  return (
    <button
      className={`filter-tab ${active ? 'filter-tab--active' : ''}`}
      style={active && color ? { borderColor: color, color } : {}}
      onClick={onClick}
    >
      {label}
      <span className="filter-tab-count">{count}</span>
    </button>
  )
}

function ViolationRow({ violation, onSelect }: { violation: Violation; onSelect: () => void }) {
  const pillarColor = {
    component: 'var(--pillar-component)',
    token: 'var(--pillar-token)',
    naming: 'var(--pillar-naming)',
    spacing: 'var(--pillar-spacing)',
  }[violation.pillar]

  const severityColor = {
    CRITICAL: 'var(--severity-critical)',
    MEDIUM: 'var(--severity-medium)',
    LOW: 'var(--severity-low)',
  }[violation.severity]

  const hasEvidence = violation.expected || violation.location || violation.agreement

  return (
    <button className="violation-row" onClick={onSelect} title="Click to select node in Figma">
      <div className="violation-row-left">
        <div className="violation-severity-dot" style={{ background: severityColor }} />
        <div className="violation-info">
          <div className="violation-name">{violation.nodeName}</div>
          <div className="violation-detail">{violation.detail}</div>
          {hasEvidence && (
            <div className="violation-evidence">
              {violation.expected && violation.actual && (
                <span className="violation-evidence-cmp">
                  <span className="violation-evidence-actual">{violation.actual}</span>
                  <span className="violation-evidence-arrow">vs</span>
                  <span className="violation-evidence-expected">{violation.expected}</span>
                </span>
              )}
              {violation.location && <span className="violation-evidence-chip">{violation.location}</span>}
              {violation.agreement && <span className="violation-evidence-agree">{violation.agreement}</span>}
            </div>
          )}
        </div>
      </div>
      <div className="violation-row-right">
        <span className="violation-pillar-tag" style={{ color: pillarColor }}>
          {violation.pillar}
        </span>
        <span className="violation-select-arrow">→</span>
      </div>
    </button>
  )
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function getScoreColor(score: number): string {
  if (score >= 90) return 'var(--score-healthy)'
  if (score >= 75) return 'var(--score-stable)'
  if (score >= 60) return 'var(--score-drifting)'
  if (score >= 40) return 'var(--score-degraded)'
  return 'var(--score-critical)'
}
