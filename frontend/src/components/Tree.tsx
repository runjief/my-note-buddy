import React, { useCallback } from 'react'
import type { Section, Annotation, PendingSelection } from '../types'
import { useStore } from '../store'
import { TreeNodeComponent } from './TreeNode'

interface Props {
  sections: Section[]
  isShadow?: boolean
  onNodeUpdate: (nodeId: string, updates: { kw?: string; say?: string }) => void
}

function flattenNodeIds(sections: Section[]): string[] {
  const ids: string[] = []
  function walk(nodes: typeof sections[0]['nodes']) {
    for (const n of nodes) { ids.push(n.id); walk(n.children) }
  }
  sections.forEach(s => walk(s.nodes))
  return ids
}

function firstSiblingsOf(sections: Section[]): string[] {
  return sections.flatMap(s => s.nodes.length > 0 ? [s.nodes[0].id] : [])
}

export function Tree({ sections, isShadow = false, onNodeUpdate }: Props) {
  const { dispatch } = useStore()

  const allIds = flattenNodeIds(sections)

  const handleExpandAll = () => dispatch({ type: 'EXPAND_ALL', allIds })
  const handleSkeleton  = () => dispatch({ type: 'SHOW_SKELETON', allIds })
  const handleReset     = () => dispatch({ type: 'RESET', firstSiblings: firstSiblingsOf(sections) })

  const handleSelection = useCallback(
    (sel: PendingSelection | null) => dispatch({ type: 'SET_SELECTION', sel }),
    [dispatch]
  )

  const handleAnnotationClick = useCallback(
    (ann: Annotation, rect: DOMRect) => {
      dispatch({
        type: 'SET_SELECTION',
        sel: {
          nodeId: ann.node_id,
          start: ann.range_start ?? 0,
          end: ann.range_end ?? 0,
          text: ann.selected_text ?? '',
          rect,
          existingAnnId: ann.id,
        },
      })
    },
    [dispatch]
  )

  return (
    <div>
      {!isShadow && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 20, flexWrap: 'wrap' }}>
          <button className="btn btn-sm" onClick={handleSkeleton}>Show all keywords</button>
          <button className="btn btn-sm" onClick={handleExpandAll}>Expand all</button>
          <button className="btn btn-sm" onClick={handleReset}>Reset</button>
        </div>
      )}
      {sections.map(sec => (
        <section key={sec.id} className="section">
          <h2 className="section-title">{sec.title}</h2>
          <div className="kids">
            {sec.nodes.map((node, i) => (
              <TreeNodeComponent
                key={node.id}
                node={node}
                depth={1}
                siblings={sec.nodes}
                siblingIndex={i}
                onSelection={handleSelection}
                onAnnotationAction={handleAnnotationClick}
                onNodeUpdate={onNodeUpdate}
                isShadow={isShadow}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
