import React, { useState, useEffect, useRef, useMemo } from 'react'
import type { DocumentFull, TreeNode } from '../types'
import { useStore } from '../store'

interface SearchResult {
  sectionTitle: string
  node: TreeNode
  matchIn: 'kw' | 'say' | 'note'
  snippet: string
  ancestorIds: string[]
}

function flattenNodes(sections: DocumentFull['sections']): Array<{ node: TreeNode; sectionTitle: string; ancestorIds: string[] }> {
  const result: Array<{ node: TreeNode; sectionTitle: string; ancestorIds: string[] }> = []

  function walk(nodes: TreeNode[], sectionTitle: string, ancestors: string[]) {
    for (const node of nodes) {
      result.push({ node, sectionTitle, ancestorIds: ancestors })
      walk(node.children, sectionTitle, [...ancestors, node.id])
    }
  }

  for (const sec of sections) {
    walk(sec.nodes, sec.title, [])
  }

  return result
}

function buildSnippet(text: string, query: string, radius = 60): string {
  const idx = text.toLowerCase().indexOf(query.toLowerCase())
  if (idx === -1) return text.slice(0, 120)
  const start = Math.max(0, idx - radius)
  const end = Math.min(text.length, idx + query.length + radius)
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '')
}

function highlightSnippet(snippet: string, query: string): React.ReactNode {
  if (!query) return snippet
  const parts = snippet.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'))
  return parts.map((p, i) =>
    p.toLowerCase() === query.toLowerCase() ? <mark key={i}>{p}</mark> : p
  )
}

interface Props {
  doc: DocumentFull
  onClose: () => void
  onJump: (nodeId: string, ancestorIds: string[]) => void
}

export function SearchOverlay({ doc, onClose, onJump }: Props) {
  const { state } = useStore()
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  const allNodes = useMemo(() => flattenNodes(doc.sections), [doc])

  const results = useMemo((): SearchResult[] => {
    if (!query.trim()) return []
    const q = query.trim().toLowerCase()
    const found: SearchResult[] = []

    for (const { node, sectionTitle, ancestorIds } of allNodes) {
      const kwMatch = node.kw.toLowerCase().includes(q)
      const sayMatch = node.say.toLowerCase().includes(q)

      // Check note content
      const nodeNotes = state.annotationsByNode[node.id] ?? []
      const noteMatch = nodeNotes.find(
        a => a.type === 'note' && !a.is_shadow && a.note_body?.toLowerCase().includes(q)
      )

      if (kwMatch) {
        found.push({ sectionTitle, node, matchIn: 'kw', snippet: node.kw, ancestorIds })
      } else if (sayMatch) {
        found.push({
          sectionTitle, node, matchIn: 'say',
          snippet: buildSnippet(node.say, q),
          ancestorIds,
        })
      } else if (noteMatch) {
        found.push({
          sectionTitle, node, matchIn: 'note',
          snippet: buildSnippet(noteMatch.note_body ?? '', q),
          ancestorIds,
        })
      }
    }
    return found.slice(0, 40)
  }, [query, allNodes, state.annotationsByNode])

  const handleJump = (r: SearchResult) => {
    onJump(r.node.id, [...r.ancestorIds, r.node.id])
    onClose()
  }

  return (
    <div className="search-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="search-box">
        <div className="search-input-row">
          <span style={{ color: 'var(--text-3)', fontSize: 16 }}>🔍</span>
          <input
            ref={inputRef}
            placeholder="Search keywords, content and notes…"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
          <span style={{ fontSize: 12, color: 'var(--text-3)' }}>Esc</span>
        </div>
        <div className="search-results">
          {query.trim() === '' && (
            <div className="search-empty">Type to search across all nodes and notes, including collapsed ones.</div>
          )}
          {query.trim() !== '' && results.length === 0 && (
            <div className="search-empty">No results for "{query}"</div>
          )}
          {results.map((r, i) => (
            <div key={i} className="search-result-item" onClick={() => handleJump(r)}>
              <div className="result-breadcrumb">
                {r.sectionTitle} › <span style={{ color: 'var(--text-2)' }}>
                  {r.matchIn === 'say' ? 'content' : r.matchIn === 'note' ? 'note' : 'keyword'}
                </span>
              </div>
              <div className="result-kw">{r.node.kw}</div>
              {(r.matchIn === 'say' || r.matchIn === 'note') && (
                <div className="result-snippet">
                  {highlightSnippet(r.snippet, query.trim())}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
