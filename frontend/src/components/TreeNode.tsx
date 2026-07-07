import React, { useState, useRef, useEffect } from 'react'
import { Bookmark, BookmarkCheck, FilePen, FileText, ChevronRight, Pencil } from 'lucide-react'
import type { TreeNode as TNode, Annotation, PendingSelection } from '../types'
import { useStore } from '../store'
import { AnnotatedText } from './AnnotatedText'
import * as api from '../api'

interface Props {
  node: TNode
  depth: number
  siblings: TNode[]
  siblingIndex: number
  onSelection: (sel: PendingSelection | null) => void
  onAnnotationAction: (ann: Annotation, rect: DOMRect) => void
  onNodeUpdate: (nodeId: string, updates: { kw?: string; say?: string }) => void
  isShadow?: boolean
}

export function TreeNodeComponent({
  node, depth, siblings, siblingIndex,
  onSelection, onAnnotationAction, onNodeUpdate,
  isShadow = false,
}: Props) {
  const { state, dispatch } = useStore()

  // ── All hooks MUST be declared before any early return ───────────────────────

  const kwRowRef = useRef<HTMLDivElement>(null)
  const shadowTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [editingKw,       setEditingKw]       = useState(false)
  const [editingSay,      setEditingSay]       = useState(false)
  const [kwDraft,         setKwDraft]         = useState(node.kw)
  const [sayDraft,        setSayDraft]        = useState(node.say)
  const [revealed,        setRevealed]        = useState(false)
  const [shadowReadMode,  setShadowReadMode]  = useState(false)

  const shadow = state.shadowByNode[node.id]
  const [shadowBody,   setShadowBody]   = useState(shadow?.body ?? '')
  const [shadowStatus, setShadowStatus] = useState<'empty' | 'partial' | 'complete'>(shadow?.status ?? 'empty')

  useEffect(() => { setKwDraft(node.kw)  }, [node.kw])
  useEffect(() => { setSayDraft(node.say) }, [node.say])
  useEffect(() => {
    if (shadow) { setShadowBody(shadow.body); setShadowStatus(shadow.status) }
  }, [shadow])

  // ── Derived state ────────────────────────────────────────────────────────────

  const isVisible    = state.visibleNodes.has(node.id)
  const isOpen       = state.openNodes.has(node.id)
  const nodeAnns     = state.annotationsByNode[node.id] ?? []
  const isBookmarked = nodeAnns.some(a => a.type === 'bookmark')
  const hasNote      = nodeAnns.some(a => a.type === 'note')

  // Split annotations: main view (non-shadow) vs shadow panel
  const mainAnns   = nodeAnns.filter(a => !a.is_shadow)
  const shadowAnns = nodeAnns.filter(a => a.is_shadow)

  // Early return after all hooks
  if (!isVisible) return null

  // ── Handlers ─────────────────────────────────────────────────────────────────

  const handleToggle = () => {
    const nextSibling = siblings[siblingIndex + 1]
    const firstChild  = node.children[0]
    dispatch({
      type: 'TOGGLE_OPEN',
      nodeId: node.id,
      siblingId:    nextSibling?.id,
      firstChildId: firstChild?.id,
    })
    // Auto-show notepad when expanding a node that has notes
    if (!isOpen && hasNote && state.notepadNodeId !== node.id) {
      const top = window.innerHeight / 2 - 190
      dispatch({ type: 'SET_NOTEPAD', nodeId: node.id, top })
    }
  }

  const saveKw = async () => {
    if (kwDraft === node.kw) { setEditingKw(false); return }
    const prev = node.kw
    setEditingKw(false)
    try {
      const res = await api.patchNode(node.id, kwDraft, undefined)
      onNodeUpdate(node.id, { kw: res.kw })
      dispatch({
        type: 'PUSH_UNDO',
        action: {
          description: `Edit keyword "${prev}"`,
          undo: async () => { const r = await api.patchNode(node.id, prev, undefined);   onNodeUpdate(node.id, { kw: r.kw }) },
          redo: async () => { const r = await api.patchNode(node.id, kwDraft, undefined); onNodeUpdate(node.id, { kw: r.kw }) },
        },
      })
    } catch { setKwDraft(prev) }
  }

  const saveSay = async () => {
    if (sayDraft === node.say) { setEditingSay(false); return }
    const prev = node.say
    setEditingSay(false)
    try {
      const res = await api.patchNode(node.id, undefined, sayDraft)
      onNodeUpdate(node.id, { say: res.say })
      dispatch({
        type: 'PUSH_UNDO',
        action: {
          description: `Edit content of "${node.kw}"`,
          undo: async () => { const r = await api.patchNode(node.id, undefined, prev);    onNodeUpdate(node.id, { say: r.say }) },
          redo: async () => { const r = await api.patchNode(node.id, undefined, sayDraft); onNodeUpdate(node.id, { say: r.say }) },
        },
      })
    } catch { setSayDraft(prev) }
  }

  const handleBookmark = async () => {
    try {
      const existing = nodeAnns.find(a => a.type === 'bookmark')
      if (existing) {
        await api.deleteAnnotation(existing.id)
        dispatch({ type: 'REMOVE_ANNOTATION', annId: existing.id, nodeId: node.id })
        dispatch({
          type: 'PUSH_UNDO',
          action: {
            description: `Remove bookmark on "${node.kw}"`,
            undo: async () => { const r = await api.restoreAnnotation(existing.id); dispatch({ type: 'RESTORE_ANNOTATION', ann: r }) },
            redo: async () => { await api.deleteAnnotation(existing.id); dispatch({ type: 'REMOVE_ANNOTATION', annId: existing.id, nodeId: node.id }) },
          },
        })
      } else {
        const ann = await api.createAnnotation(node.id, { type: 'bookmark' })
        dispatch({ type: 'ADD_ANNOTATION', ann })
        dispatch({
          type: 'PUSH_UNDO',
          action: {
            description: `Bookmark "${node.kw}"`,
            undo: async () => { await api.deleteAnnotation(ann.id); dispatch({ type: 'REMOVE_ANNOTATION', annId: ann.id, nodeId: node.id }) },
            redo: async () => { const r = await api.restoreAnnotation(ann.id); dispatch({ type: 'RESTORE_ANNOTATION', ann: r }) },
          },
        })
      }
    } catch (e) { console.error('Bookmark failed:', e) }
  }

  const handleNotepad = () => {
    if (state.notepadNodeId === node.id) {
      dispatch({ type: 'SET_NOTEPAD', nodeId: null })
    } else {
      const top = kwRowRef.current?.getBoundingClientRect().top ?? 120
      dispatch({ type: 'SET_NOTEPAD', nodeId: node.id, top })
    }
  }

  const handleShadowChange = (val: string) => {
    setShadowBody(val)
    const newStatus: 'empty' | 'partial' | 'complete' =
      val.trim() ? (shadowStatus === 'complete' ? 'complete' : 'partial') : 'empty'
    setShadowStatus(newStatus)
    if (shadowTimer.current) clearTimeout(shadowTimer.current)
    shadowTimer.current = setTimeout(async () => {
      try {
        const note = await api.upsertShadowNote(node.id, val, newStatus)
        dispatch({ type: 'SET_SHADOW', nodeId: node.id, note })
      } catch (e) { console.error('Shadow save failed:', e) }
    }, 600)
  }

  const cycleStatus = async () => {
    const cycle = { empty: 'partial', partial: 'complete', complete: 'empty' } as const
    const next = cycle[shadowStatus]
    setShadowStatus(next)
    try {
      const note = await api.upsertShadowNote(node.id, shadowBody, next)
      dispatch({ type: 'SET_SHADOW', nodeId: node.id, note })
    } catch (e) { console.error('Status cycle failed:', e) }
  }

  const statusEmoji = { empty: '○', partial: '◑', complete: '●' }

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div
      className={`node depth-${depth} ${isOpen ? 'open' : ''} ${isBookmarked ? 'bookmarked' : ''}`}
      id={`node-${node.id}`}
    >
      {/* kw row */}
      <div className="kw-row" ref={kwRowRef}>
        {editingKw ? (
          <input
            className="kw-input"
            value={kwDraft}
            autoFocus
            onChange={e => setKwDraft(e.target.value)}
            onBlur={saveKw}
            onKeyDown={e => {
              if (e.key === 'Enter') saveKw()
              if (e.key === 'Escape') { setKwDraft(node.kw); setEditingKw(false) }
            }}
          />
        ) : (
          <button className="kw-btn" onClick={handleToggle}>
            <ChevronRight size={13} className="chev" />
            {node.kw}
          </button>
        )}

        <div className="node-actions">
          <button title="Edit keyword" onClick={() => setEditingKw(true)}>
            <Pencil size={13} />
          </button>
          <button
            title={isBookmarked ? 'Remove bookmark' : 'Bookmark'}
            className={isBookmarked ? 'active-icon' : ''}
            onClick={handleBookmark}
          >
            {isBookmarked ? <BookmarkCheck size={14} /> : <Bookmark size={14} />}
          </button>
          <button
            title="Notepad"
            className={state.notepadNodeId === node.id ? 'active-icon' : ''}
            onClick={handleNotepad}
          >
            {hasNote ? <FilePen size={14} /> : <FileText size={14} />}
          </button>
        </div>

        {isShadow && (
          <button className={`shadow-status ${shadowStatus}`} onClick={cycleStatus}>
            {statusEmoji[shadowStatus]}
          </button>
        )}
      </div>

      {/* say block — normal reading mode */}
      {!isShadow && (
        <div className="say-wrap">
          <div className="say">
            <span className="lbl">
              Say it
              <button
                onClick={() => setEditingSay(v => !v)}
                style={{
                  marginLeft: 8, fontSize: 10, padding: '1px 6px', borderRadius: 4,
                  border: '1px solid var(--line-strong)', background: 'none',
                  color: 'var(--text-3)', cursor: 'pointer', fontFamily: 'inherit',
                }}
                title="Edit content"
              >
                {editingSay ? 'done' : '✏'}
              </button>
            </span>
            {editingSay ? (
              <textarea
                className="say-textarea"
                value={sayDraft}
                autoFocus
                onChange={e => setSayDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && e.ctrlKey) saveSay()
                  if (e.key === 'Escape') { setSayDraft(node.say); setEditingSay(false) }
                }}
              />
            ) : (
              <AnnotatedText
                nodeId={node.id}
                text={node.say}
                annotations={mainAnns}
                onSelection={onSelection}
                onAnnotationClick={onAnnotationAction}
              />
            )}
            {editingSay && (
              <div style={{ marginTop: 6, display: 'flex', gap: 6 }}>
                <button className="btn btn-sm btn-primary" onClick={saveSay}>Save (Ctrl+Enter)</button>
                <button className="btn btn-sm" onClick={() => { setSayDraft(node.say); setEditingSay(false) }}>Cancel</button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* say block — shadow right panel */}
      {isShadow && isOpen && (
        <div className="say-wrap" style={{ display: 'block' }}>
          <div className="shadow-panel-toolbar">
            <button
              className={`shadow-mode-toggle ${shadowReadMode ? '' : 'active'}`}
              onClick={() => setShadowReadMode(false)}
              title="Write mode"
            >
              ✏ Write
            </button>
            <button
              className={`shadow-mode-toggle ${shadowReadMode ? 'active' : ''}`}
              onClick={() => setShadowReadMode(true)}
              title="Annotate mode — right-click to highlight"
            >
              👁 Annotate
            </button>
            <button className="reveal-btn" onClick={() => setRevealed(v => !v)}>
              {revealed ? 'Hide' : 'Reveal'}
            </button>
          </div>

          {shadowReadMode ? (
            // Annotate mode: render shadow body as annotatable text
            shadowBody ? (
              <div className="shadow-annotated">
                <AnnotatedText
                  nodeId={node.id}
                  text={shadowBody}
                  annotations={shadowAnns}
                  onSelection={onSelection}
                  onAnnotationClick={onAnnotationAction}
                  shadowContext={true}
                />
              </div>
            ) : (
              <div className="shadow-empty-hint">Nothing written yet — switch to Write mode.</div>
            )
          ) : (
            // Write mode: editable textarea
            <textarea
              className="shadow-textarea"
              value={shadowBody}
              placeholder="Write from memory…"
              onChange={e => handleShadowChange(e.target.value)}
            />
          )}

          {revealed && <div className="shadow-revealed">{node.say}</div>}
        </div>
      )}

      {/* children */}
      {node.children.length > 0 && isOpen && (
        <div className="kids">
          {node.children.map((child, i) => (
            <TreeNodeComponent
              key={child.id}
              node={child}
              depth={depth + 1}
              siblings={node.children}
              siblingIndex={i}
              onSelection={onSelection}
              onAnnotationAction={onAnnotationAction}
              onNodeUpdate={onNodeUpdate}
              isShadow={isShadow}
            />
          ))}
        </div>
      )}
    </div>
  )
}
