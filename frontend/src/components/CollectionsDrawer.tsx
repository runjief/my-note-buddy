import React, { useState, useMemo } from 'react'
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

const TYPE_ICON: Record<string, string> = {
  highlight: '●', bookmark: '★', note: '📝',
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

  const allAnns = useMemo(() => {
    const all: Annotation[] = []
    for (const anns of Object.values(state.annotationsByNode)) {
      // exclude crossouts and shadow-context annotations from collections
      all.push(...anns.filter(a => a.type !== 'crossout' && !a.is_shadow))
    }
    return all.sort((a, b) => (a.created_at > b.created_at ? -1 : 1))
  }, [state.annotationsByNode])

  const filtered = useMemo(
    () => (activeTab === 'all' ? allAnns : allAnns.filter(a => a.type === activeTab)),
    [allAnns, activeTab]
  )

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
    <div className="collections-drawer">
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
            onClick={() => setActiveTab(t.key)}
          >
            {t.icon && <span style={{ marginRight: 3 }}>{t.icon}</span>}
            {t.label}
          </button>
        ))}
      </div>
      <div className="drawer-body">
        {filtered.length === 0 && (
          <div className="drawer-empty">Nothing here yet.</div>
        )}
        {filtered.map(ann => {
          const { kw, breadcrumb } = findNodeAndBreadcrumb(ann.node_id, doc)
          return (
            <div key={ann.id} className="collection-item" onClick={() => handleJump(ann)}>
              <div className="ci-icon" style={ann.type === 'highlight' ? { color: 'goldenrod' } : {}}>
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
