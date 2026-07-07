import React, { useState, useMemo, useEffect, useRef } from 'react'
import type { Annotation, DocumentFull, TreeNode } from '../types'
import { useStore } from '../store'
import * as api from '../api'

type Tab = 'all' | 'highlight' | 'bookmark' | 'note'

const TABS: { key: Tab; label: string; icon: string }[] = [
  { key: 'all', label: 'All', icon: '' },
  { key: 'highlight', label: 'Highlights', icon: '●' },
  { key: 'bookmark', label: 'Bookmarks', icon: '★' },
  { key: 'note', label: 'Notes', icon: '📝' },
]

const HIGHLIGHT_COLORS: { value: string; label: string; swatch: string }[] = [
  { value: '',       label: 'All colors', swatch: 'linear-gradient(135deg,#ffd54f,#ff9800,#66bb6a,#42a5f5,#f48fb1)' },
  { value: 'yellow', label: 'Yellow',     swatch: '#ffd54f' },
  { value: 'orange', label: 'Orange',     swatch: '#ff9800' },
  { value: 'green',  label: 'Green',      swatch: '#66bb6a' },
  { value: 'blue',   label: 'Blue',       swatch: '#42a5f5' },
  { value: 'pink',   label: 'Pink',       swatch: '#f48fb1' },
]

const TYPE_ICON: Record<string, string> = {
  highlight: '●', bookmark: '★', note: '📝',
}

const COLOR_STYLE: Record<string, string> = {
  yellow: '#ffd54f', orange: '#ff9800', green: '#66bb6a',
  blue: '#42a5f5', pink: '#f48fb1',
}

function annPreview(ann: Annotation): string {
  if (ann.type === 'bookmark') return '(bookmarked)'
  if (ann.type === 'note') return ann.note_body?.slice(0, 80) || '(empty note)'
  if (ann.selected_text) return ann.selected_text.slice(0, 80)
  return `(${ann.type})`
}

function findNodeAndBreadcrumb(
  nodeId: string,
  doc: DocumentFull
): { kw: string; breadcrumb: string } {
  for (const sec of doc.sections) {
    const found = findInNodes(nodeId, sec.nodes, sec.title)
    if (found) return found
  }
  return { kw: nodeId, breadcrumb: '' }
}

function findInNodes(
  nodeId: string,
  nodes: TreeNode[],
  sectionTitle: string
): { kw: string; breadcrumb: string } | null {
  for (const n of nodes) {
    if (n.id === nodeId) return { kw: n.kw, breadcrumb: sectionTitle }
    const child = findInNodes(nodeId, n.children, sectionTitle)
    if (child) return child
  }
  return null
}

function getAncestorIds(nodeId: string, doc: DocumentFull): string[] {
  for (const sec of doc.sections) {
    const path = findPath(nodeId, sec.nodes, [])
    if (path) return path
  }
  return [nodeId]
}

function findPath(nodeId: string, nodes: TreeNode[], acc: string[]): string[] | null {
  for (const n of nodes) {
    const cur = [...acc, n.id]
    if (n.id === nodeId) return cur
    const child = findPath(nodeId, n.children, cur)
    if (child) return child
  }
  return null
}

interface Props {
  doc: DocumentFull
  onClose: () => void
  onJump: (nodeId: string, ancestorIds: string[]) => void
}

export function CollectionsDrawer({ doc, onClose, onJump }: Props) {
  const { state, dispatch } = useStore()
  const [activeTab, setActiveTab] = useState<Tab>('all')
  const [colorFilter, setColorFilter] = useState<string>('')
  const drawerRef = useRef<HTMLDivElement>(null)

  // Reset color filter when switching tabs
  const handleTabChange = (tab: Tab) => {
    setActiveTab(tab)
    if (tab !== 'highlight') setColorFilter('')
  }

  // Close when clicking outside the drawer
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (drawerRef.current && !drawerRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    const id = setTimeout(() => document.addEventListener('mousedown', handler), 50)
    return () => { clearTimeout(id); document.removeEventListener('mousedown', handler) }
  }, [onClose])

  const allAnns = useMemo(() => {
    const all: Annotation[] = []
    for (const anns of Object.values(state.annotationsByNode)) {
      all.push(...anns.filter(a => a.type !== 'crossout' && !a.is_shadow))
    }
    return all.sort((a, b) => (a.created_at > b.created_at ? -1 : 1))
  }, [state.annotationsByNode])

  const filtered = useMemo(() => {
    let result = activeTab === 'all' ? allAnns : allAnns.filter(a => a.type === activeTab)
    if (activeTab === 'highlight' && colorFilter) {
      result = result.filter(a => a.color === colorFilter)
    }
    return result
  }, [allAnns, activeTab, colorFilter])

  const handleRemove = async (ann: Annotation) => {
    await api.deleteAnnotation(ann.id)
    dispatch({ type: 'REMOVE_ANNOTATION', annId: ann.id, nodeId: ann.node_id })
    dispatch({
      type: 'PUSH_UNDO',
      action: {
        description: `Remove ${ann.type}`,
        undo: async () => { const r = await api.restoreAnnotation(ann.id); dispatch({ type: 'RESTORE_ANNOTATION', ann: r }) },
        redo: async () => { await api.deleteAnnotation(ann.id); dispatch({ type: 'REMOVE_ANNOTATION', annId: ann.id, nodeId: ann.node_id }) },
      },
    })
  }

  const handleJump = (ann: Annotation) => {
    const ancestors = getAncestorIds(ann.node_id, doc)
    onJump(ann.node_id, ancestors)
  }

  return (
    <div className="collections-drawer" ref={drawerRef}>
      <div className="drawer-header">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3>Collections</h3>
          <button className="btn btn-sm" style={{ border: 'none' }} onClick={onClose}>✕</button>
        </div>
      </div>
      <div className="drawer-tabs">
        {TABS.map(t => (
          <button
            key={t.key}
            className={`drawer-tab ${activeTab === t.key ? 'active' : ''}`}
            onClick={() => handleTabChange(t.key)}
          >
            {t.icon && <span style={{ marginRight: 3 }}>{t.icon}</span>}
            {t.label}
          </button>
        ))}
      </div>

      {/* Color filter row — only visible on highlight tab */}
      {activeTab === 'highlight' && (
        <div className="drawer-color-filter">
          {HIGHLIGHT_COLORS.map(c => (
            <button
              key={c.value}
              className={`color-swatch-btn ${colorFilter === c.value ? 'active' : ''}`}
              title={c.label}
              onClick={() => setColorFilter(c.value)}
              style={{ background: c.swatch }}
            />
          ))}
        </div>
      )}

      <div className="drawer-body">
        {filtered.length === 0 && (
          <div className="drawer-empty">Nothing here yet.</div>
        )}
        {filtered.map(ann => {
          const { kw, breadcrumb } = findNodeAndBreadcrumb(ann.node_id, doc)
          const dotColor = ann.type === 'highlight' ? (COLOR_STYLE[ann.color ?? ''] ?? 'goldenrod') : undefined
          return (
            <div key={ann.id} className="collection-item" onClick={() => handleJump(ann)}>
              <div className="ci-icon" style={dotColor ? { color: dotColor } : {}}>
                {TYPE_ICON[ann.type]}
              </div>
              <div className="ci-body">
                <div className="ci-preview">{annPreview(ann)}</div>
                <div className="ci-breadcrumb">{breadcrumb} › {kw}</div>
              </div>
              <button
                className="ci-remove"
                onClick={e => { e.stopPropagation(); handleRemove(ann) }}
                title="Remove"
              >
                ✕
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
