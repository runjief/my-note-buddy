import React, { useRef, useCallback, useState } from 'react'
import type { Annotation, PendingSelection } from '../types'

interface Props {
  nodeId: string
  text: string
  annotations: Annotation[]
  onSelection: (sel: PendingSelection | null) => void
  onAnnotationClick: (ann: Annotation, rect: DOMRect) => void
  shadowContext?: boolean
}

// ── Segment builder ───────────────────────────────────────────────────────────
function buildSegments(text: string, anns: Annotation[]) {
  const ranged = anns
    .filter(a => (a.type === 'highlight' || a.type === 'crossout') && a.range_start != null)
    .sort((a, b) => (a.range_start ?? 0) - (b.range_start ?? 0))

  type Segment =
    | { kind: 'plain'; text: string }
    | { kind: 'highlight'; text: string; ann: Annotation }
    | { kind: 'crossout'; text: string; ann: Annotation }

  const segments: Segment[] = []
  let pos = 0

  for (const ann of ranged) {
    const s = ann.range_start!
    const e = ann.range_end!
    if (s >= e || e <= pos) continue
    const clampedS = Math.max(s, pos)
    if (clampedS > pos) segments.push({ kind: 'plain', text: text.slice(pos, clampedS) })
    const slice = text.slice(clampedS, e)
    if (ann.type === 'highlight') segments.push({ kind: 'highlight', text: slice, ann })
    else segments.push({ kind: 'crossout', text: slice, ann })
    pos = e
  }
  if (pos < text.length) segments.push({ kind: 'plain', text: text.slice(pos) })
  return segments
}

// ── Correct offset calculation (annotation-library approach) ──────────────────
function getRangeOffsets(container: HTMLElement, range: Range): { start: number; end: number } {
  const pre = range.cloneRange()
  pre.selectNodeContents(container)
  pre.setEnd(range.startContainer, range.startOffset)
  const start = pre.toString().length
  return { start, end: start + range.toString().length }
}

const COLORS: Record<string, string> = {
  yellow: 'rgba(255,220,0,0.5)',
  orange: 'rgba(255,140,0,0.45)',
  green:  'rgba(80,200,80,0.4)',
  blue:   'rgba(80,160,255,0.4)',
  pink:   'rgba(255,100,160,0.4)',
}

export function AnnotatedText({ nodeId, text, annotations, onSelection, onAnnotationClick, shadowContext }: Props) {
  const ref = useRef<HTMLDivElement>(null)

  // Right-click on plain text → show annotation toolbar positioned above selection
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !ref.current) { onSelection(null); return }
    if (!sel.rangeCount) { onSelection(null); return }
    const range = sel.getRangeAt(0)
    if (!ref.current.contains(range.commonAncestorContainer)) { onSelection(null); return }
    e.preventDefault()
    const { start, end } = getRangeOffsets(ref.current, range)
    if (start === end) { onSelection(null); return }
    // Use the selection's bounding rect (not cursor position) so toolbar doesn't cover the text
    const selRect = range.getBoundingClientRect()
    onSelection({ nodeId, start, end, text: range.toString(), rect: selRect, isShadowContext: shadowContext })
  }, [nodeId, onSelection, shadowContext])

  const segments = buildSegments(text, annotations)

  return (
    <div ref={ref} onContextMenu={handleContextMenu}>
      {segments.map((seg, i) => {
        if (seg.kind === 'plain') return <span key={i}>{seg.text}</span>
        if (seg.kind === 'highlight') {
          const bg = COLORS[seg.ann.color ?? 'yellow'] ?? COLORS.yellow
          return (
            <mark key={i} className="hl" style={{ backgroundColor: bg }}
              onContextMenu={e => {
                e.preventDefault()
                e.stopPropagation()
                // Use the mark element's bounding rect so toolbar is above the highlighted word
                onAnnotationClick(seg.ann, (e.currentTarget as HTMLElement).getBoundingClientRect())
              }}>
              {seg.text}
            </mark>
          )
        }
        return (
          <del key={i} className="xout"
            onContextMenu={e => {
              e.preventDefault()
              e.stopPropagation()
              onAnnotationClick(seg.ann, (e.currentTarget as HTMLElement).getBoundingClientRect())
            }}>
            {seg.text}
          </del>
        )
      })}
    </div>
  )
}

// ── Selection toolbar ─────────────────────────────────────────────────────────

interface ToolbarProps {
  selection: PendingSelection
  onHighlight: (color: string) => void
  onCrossout: () => void
  onDismiss: () => void
  onRemove?: () => void
}

const SWATCHES = [
  { key: 'yellow', display: '#ffe566' },
  { key: 'orange', display: '#ff8c00' },
  { key: 'green',  display: '#4caf50' },
  { key: 'blue',   display: '#5090ff' },
  { key: 'pink',   display: '#ff64a0' },
]

const TOOLBAR_H = 84  // approximate rendered height
const TOOLBAR_GAP = 8

export function SelectionToolbar({ selection, onHighlight, onCrossout, onDismiss, onRemove }: ToolbarProps) {
  const [crossoutHover, setCrossoutHover] = useState(false)
  const toolbarW = 260

  const { rect } = selection
  // Position above the selection; fall back below if not enough room
  const left = Math.max(8, Math.min(window.innerWidth - toolbarW - 8,
    rect.left + rect.width / 2 - toolbarW / 2))
  const top = rect.top >= TOOLBAR_H + TOOLBAR_GAP
    ? rect.top - TOOLBAR_H - TOOLBAR_GAP
    : rect.bottom + TOOLBAR_GAP

  const preview = selection.text.slice(0, 40) + (selection.text.length > 40 ? '…' : '')

  return (
    <div
      className="selection-toolbar"
      style={{ top, left, width: toolbarW, flexDirection: 'column', gap: 6 }}
      // Prevent mousedown from blurring the selection or triggering click-outside handler
      onMouseDown={e => e.stopPropagation()}
    >
      <div style={{
        fontSize: 12, color: 'var(--text-2)', maxWidth: '100%',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        textDecoration: crossoutHover ? 'line-through' : 'none',
        background: crossoutHover ? 'rgba(192,57,43,0.08)' : 'transparent',
        borderRadius: 4, padding: '2px 4px', transition: 'all 0.12s',
      }}>
        {preview}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, width: '100%' }}>
        {SWATCHES.map(({ key, display }) => (
          <div
            key={key}
            className="color-swatch"
            style={{ backgroundColor: display }}
            title={`Highlight ${key}`}
            onMouseDown={e => { e.preventDefault(); e.stopPropagation(); onHighlight(key) }}
          />
        ))}
        <div style={{ width: 1, height: 16, background: 'var(--line-strong)', margin: '0 2px', flexShrink: 0 }} />
        <button
          className="sel-btn"
          title="Crossout"
          onMouseEnter={() => setCrossoutHover(true)}
          onMouseLeave={() => setCrossoutHover(false)}
          onMouseDown={e => { e.preventDefault(); e.stopPropagation(); onCrossout() }}
        >
          ~~
        </button>
        <div style={{ flex: 1 }} />
        {onRemove
          ? <button className="sel-btn" onMouseDown={e => { e.preventDefault(); e.stopPropagation(); onRemove() }} style={{ color: 'var(--danger)' }}>Remove</button>
          : <button className="sel-btn" onMouseDown={e => { e.preventDefault(); e.stopPropagation(); onDismiss() }} style={{ color: 'var(--text-3)' }}>✕</button>
        }
      </div>
    </div>
  )
}
