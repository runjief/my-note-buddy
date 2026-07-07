import React, { useState, useEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import type {
  DocumentSummary, DocumentFull,
  TreeNode, Section, ShadowDocSummary,
} from './types'
import * as api from './api'
import { StoreProvider, useStore } from './store'
import { Tree } from './components/Tree'
import { SelectionToolbar } from './components/AnnotatedText'
import { NotepadPanel } from './components/NotepadPanel'
import { SearchOverlay } from './components/SearchOverlay'
import { CollectionsDrawer } from './components/CollectionsDrawer'
import './styles/app.css'

// ── Error boundary ────────────────────────────────────────────────────────────

interface EBState { error: Error | null }
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, EBState> {
  state: EBState = { error: null }
  static getDerivedStateFromError(e: Error) { return { error: e } }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 48, maxWidth: 560, margin: '0 auto' }}>
          <h2 style={{ color: 'var(--danger)', marginBottom: 12 }}>Something went wrong</h2>
          <pre style={{ fontSize: 12, color: 'var(--text-2)', whiteSpace: 'pre-wrap', marginBottom: 20 }}>
            {this.state.error.message}
          </pre>
          <button className="btn btn-primary" onClick={() => this.setState({ error: null })}>Try again</button>
        </div>
      )
    }
    return this.props.children
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function updateNodeInSections(sections: Section[], nodeId: string, updates: { kw?: string; say?: string }): Section[] {
  return sections.map(sec => ({
    ...sec,
    nodes: updateNodesRecursive(sec.nodes, nodeId, updates),
  }))
}
function updateNodesRecursive(nodes: TreeNode[], nodeId: string, updates: { kw?: string; say?: string }): TreeNode[] {
  return nodes.map(n =>
    n.id === nodeId ? { ...n, ...updates } : { ...n, children: updateNodesRecursive(n.children, nodeId, updates) }
  )
}
function findNode(id: string, nodes: TreeNode[]): TreeNode | null {
  for (const n of nodes) {
    if (n.id === id) return n
    const c = findNode(id, n.children)
    if (c) return c
  }
  return null
}
function flattenNodeIds(sections: Section[]): string[] {
  const ids: string[] = []
  function walk(nodes: TreeNode[]) { for (const n of nodes) { ids.push(n.id); walk(n.children) } }
  sections.forEach(s => walk(s.nodes))
  return ids
}

// ── Document list ─────────────────────────────────────────────────────────────

function DocumentList({ onOpen }: { onOpen: (id: string) => void }) {
  const [docs, setDocs] = useState<DocumentSummary[]>([])
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => { api.listDocuments().then(setDocs).catch(console.error) }, [])

  const parseAndImport = async (text: string) => {
    let payload: object
    try {
      const json = JSON.parse(text)
      if (json.version === 1 || (json.config && json.data)) payload = json
      else throw new Error('Unrecognised JSON')
    } catch {
      const configM = text.match(/const CONFIG\s*=\s*({[\s\S]*?});/)
      const dataM   = text.match(/const DATA\s*=\s*(\[[\s\S]*?\]);/)
      if (!configM || !dataM) throw new Error('Cannot parse — expected JSON or review-tree HTML')
      payload = { config: JSON.parse(configM[1]), data: JSON.parse(dataM[1]) }
    }
    return api.importDocument(payload)
  }

  const handleFileImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    try {
      const { id } = await parseAndImport(await file.text())
      onOpen(id)
    } catch (err: any) { alert(err.message ?? 'Import failed') }
  }

  const handlePasteImport = async () => {
    try {
      const { id } = await parseAndImport(pasteText)
      setPasteOpen(false); setPasteText('')
      onOpen(id)
    } catch (err: any) { alert(err.message ?? 'Import failed') }
  }

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    if (!confirm('Delete this document and all its annotations?')) return
    await api.deleteDocument(id)
    setDocs(d => d.filter(x => x.id !== id))
  }

  // Group: originals with their shadows nested
  const originals = docs.filter(d => !d.origin_document_id)
  const shadows   = docs.filter(d => !!d.origin_document_id)

  return (
    <div className="doc-list-page">
      <h1>Note Tool</h1>

      {originals.map(d => {
        const docShadows = shadows.filter(s => s.origin_document_id === d.id)
        return (
          <React.Fragment key={d.id}>
            <div className="doc-card" onClick={() => onOpen(d.id)}>
              <div>
                <h2>{d.title}</h2>
                {d.subtitle && <p>{d.subtitle}</p>}
              </div>
              <div className="card-actions">
                <button className="btn btn-sm btn-danger" onClick={e => handleDelete(e, d.id)}>Delete</button>
              </div>
            </div>
            {docShadows.map(sd => (
              <div key={sd.id} className="doc-card doc-card-shadow" onClick={() => onOpen(sd.id)}>
                <div className="shadow-doc-indicator">
                  <span className="shadow-doc-tag">Shadow</span>
                  {sd.title.replace(/^\[Shadow\]\s*/, '').split('—')[0].trim()}
                </div>
                <div className="card-actions">
                  <button className="btn btn-sm btn-danger" onClick={e => handleDelete(e, sd.id)}>Delete</button>
                </div>
              </div>
            ))}
          </React.Fragment>
        )
      })}

      {/* Orphaned shadow docs (whose parent was deleted) */}
      {shadows.filter(s => !originals.some(o => o.id === s.origin_document_id)).map(sd => (
        <div key={sd.id} className="doc-card doc-card-shadow" onClick={() => onOpen(sd.id)}>
          <div>
            <span className="shadow-doc-tag">Shadow</span>
            <span style={{ color: 'var(--text-2)', fontSize: 13 }}>{sd.title}</span>
          </div>
          <div className="card-actions">
            <button className="btn btn-sm btn-danger" onClick={e => handleDelete(e, sd.id)}>Delete</button>
          </div>
        </div>
      ))}

      <div style={{ marginTop: 24, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <button className="btn btn-primary" onClick={() => fileRef.current?.click()}>
          Import file (HTML / JSON)
        </button>
        <button className="btn" onClick={() => setPasteOpen(true)}>Paste JSON</button>
        <input ref={fileRef} type="file" accept=".html,.json" hidden onChange={handleFileImport} />
      </div>

      {pasteOpen && (
        <div style={{ marginTop: 16 }}>
          <p style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 8 }}>
            Paste the JSON Claude generated (<code>{`{config, data}`}</code> or full export).
          </p>
          <textarea
            style={{
              width: '100%', height: 180, fontFamily: 'monospace', fontSize: 12,
              background: 'var(--sub-bg)', border: '1px solid var(--line-strong)',
              borderRadius: 8, padding: 10, color: 'var(--text)', outline: 'none', resize: 'vertical',
            }}
            value={pasteText}
            onChange={e => setPasteText(e.target.value)}
            placeholder='{"config": {"title": "..."}, "data": [...]}'
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button className="btn btn-primary" onClick={handlePasteImport}>Import</button>
            <button className="btn" onClick={() => { setPasteOpen(false); setPasteText('') }}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Document view ─────────────────────────────────────────────────────────────

function DocView({ docId, onBack }: { docId: string; onBack: () => void; onNavigate: (id: string) => void }) {
  const [doc, setDoc] = useState<DocumentFull | null>(null)
  const { state, dispatch } = useStore()

  // Split / resizing
  const [splitPercent, setSplitPercent] = useState(50)
  const [isDraggingSplitter, setIsDraggingSplitter] = useState(false)
  const shadowContainerRef = useRef<HTMLDivElement>(null)
  const leftScrollRef  = useRef<HTMLDivElement>(null)
  const rightScrollRef = useRef<HTMLDivElement>(null)
  const syncLock = useRef(false)

  // Shadow doc compare mode
  const [compareMode, setCompareMode] = useState(false)
  const [compareDoc, setCompareDoc] = useState<DocumentFull | null>(null)
  const [shadowDocs, setShadowDocs] = useState<ShadowDocSummary[]>([])
  const [showCompareDropdown, setShowCompareDropdown] = useState(false)

  // Shadow write mode picker
  const [showShadowPicker, setShowShadowPicker] = useState(false)

  // Toasts
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const showToast = (msg: string, ms = 4000) => {
    setToast(msg)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), ms)
  }

  // ── Load current doc ──────────────────────────────────────────
  useEffect(() => {
    setDoc(null)
    setCompareMode(false)
    setCompareDoc(null)
    setShadowDocs([])
    Promise.all([
      api.getDocument(docId),
      api.getAnnotations(docId),
      api.getShadowNotes(docId),
    ]).then(([d, anns, shadows]) => {
      setDoc(d)
      dispatch({ type: 'SET_ALL_ANNOTATIONS', anns })
      dispatch({ type: 'SET_ALL_SHADOWS', notes: shadows })
      dispatch({ type: 'RESET', firstSiblings: d.sections.flatMap(s => s.nodes.length > 0 ? [s.nodes[0].id] : []) })
      // Load shadow docs list (for compare dropdown)
      api.getShadowDocs(docId).then(setShadowDocs).catch(() => {})
    }).catch(console.error)
  }, [docId])

  // ── Keyboard shortcuts ─────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); dispatch({ type: 'TOGGLE_SEARCH' }) }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'z') {
        e.preventDefault()
        const last = state.undoStack[state.undoStack.length - 1]
        if (last) { last.undo().catch(console.error); dispatch({ type: 'POP_UNDO' }) }
      }
      if (e.key === 'Escape') {
        if (state.pendingSelection) dispatch({ type: 'SET_SELECTION', sel: null })
        if (state.notepadNodeId)    dispatch({ type: 'SET_NOTEPAD', nodeId: null })
        if (showShadowPicker)       setShowShadowPicker(false)
        if (showCompareDropdown)    setShowCompareDropdown(false)
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [state.undoStack, state.pendingSelection, state.notepadNodeId, showShadowPicker, showCompareDropdown, dispatch])

  // ── Sync scroll ───────────────────────────────────────────────
  useEffect(() => {
    if ((!state.syncScroll && !compareMode) || (!state.shadowMode && !compareMode)) return
    const left  = leftScrollRef.current
    const right = rightScrollRef.current
    if (!left || !right) return
    const onLeft = () => {
      if (syncLock.current) return
      syncLock.current = true
      right.scrollTop = (left.scrollTop / Math.max(1, left.scrollHeight - left.clientHeight))
        * (right.scrollHeight - right.clientHeight)
      setTimeout(() => { syncLock.current = false }, 20)
    }
    const onRight = () => {
      if (syncLock.current) return
      syncLock.current = true
      left.scrollTop = (right.scrollTop / Math.max(1, right.scrollHeight - right.clientHeight))
        * (left.scrollHeight - left.clientHeight)
      setTimeout(() => { syncLock.current = false }, 20)
    }
    left.addEventListener('scroll', onLeft)
    right.addEventListener('scroll', onRight)
    return () => { left.removeEventListener('scroll', onLeft); right.removeEventListener('scroll', onRight) }
  }, [state.syncScroll, state.shadowMode, compareMode])

  // ── Resizable splitter ────────────────────────────────────────
  const handleSplitterMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const container = shadowContainerRef.current
    if (!container) return
    setIsDraggingSplitter(true)
    const startX = e.clientX
    const startPct = splitPercent
    const onMove = (ev: MouseEvent) => {
      const pct = Math.max(15, Math.min(85, startPct + ((ev.clientX - startX) / container.clientWidth) * 100))
      setSplitPercent(pct)
    }
    const onUp = () => {
      setIsDraggingSplitter(false)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [splitPercent])

  // ── Jump to node ──────────────────────────────────────────────
  const handleJump = useCallback((nodeId: string, ancestorIds: string[]) => {
    dispatch({ type: 'FORCE_REVEAL', nodeIds: ancestorIds })
    requestAnimationFrame(() => {
      const el = document.getElementById(`node-${nodeId}`)
      if (!el) return
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      el.classList.add('pulse')
      setTimeout(() => el.classList.remove('pulse'), 700)
    })
  }, [dispatch])

  // ── Node updates ──────────────────────────────────────────────
  const handleNodeUpdate = useCallback((nodeId: string, updates: { kw?: string; say?: string }) => {
    setDoc(d => d ? { ...d, sections: updateNodeInSections(d.sections, nodeId, updates) } : d)
  }, [])
  const handleCompareNodeUpdate = useCallback((nodeId: string, updates: { kw?: string; say?: string }) => {
    setCompareDoc(d => d ? { ...d, sections: updateNodeInSections(d.sections, nodeId, updates) } : d)
  }, [])

  // ── Compare mode ──────────────────────────────────────────────
  const enterCompareWith = useCallback(async (otherDocId: string) => {
    try {
      const [otherDoc, otherAnns] = await Promise.all([
        api.getDocument(otherDocId),
        api.getAnnotations(otherDocId),
      ])
      setCompareDoc(otherDoc)
      dispatch({ type: 'MERGE_ANNOTATIONS', anns: otherAnns })
      dispatch({ type: 'MERGE_REVEAL_ALL', allIds: flattenNodeIds(otherDoc.sections) })
      setCompareMode(true)
      setShowCompareDropdown(false)
    } catch (e) { console.error('Compare load failed:', e) }
  }, [dispatch])

  const exitCompareMode = () => { setCompareMode(false); setCompareDoc(null) }

  // ── Annotation creation ───────────────────────────────────────
  const handleHighlight = useCallback(async (color: string) => {
    const sel = state.pendingSelection
    if (!sel || sel.existingAnnId) return
    try {
      const ann = await api.createAnnotation(sel.nodeId, {
        type: 'highlight', range_start: sel.start, range_end: sel.end,
        color, selected_text: sel.text.slice(0, 200),
        is_shadow: sel.isShadowContext ?? false,
      })
      dispatch({ type: 'ADD_ANNOTATION', ann })
      dispatch({
        type: 'PUSH_UNDO',
        action: {
          description: `Highlight "${sel.text.slice(0, 20)}…"`,
          undo: async () => { await api.deleteAnnotation(ann.id); dispatch({ type: 'REMOVE_ANNOTATION', annId: ann.id, nodeId: sel.nodeId }) },
          redo: async () => { const r = await api.restoreAnnotation(ann.id); dispatch({ type: 'RESTORE_ANNOTATION', ann: r }) },
        },
      })
    } catch (e) { console.error('Highlight failed:', e) }
    dispatch({ type: 'SET_SELECTION', sel: null })
    window.getSelection()?.removeAllRanges()
  }, [state.pendingSelection, dispatch])

  const handleCrossout = useCallback(async () => {
    const sel = state.pendingSelection
    if (!sel || sel.existingAnnId) return
    try {
      const ann = await api.createAnnotation(sel.nodeId, {
        type: 'crossout', range_start: sel.start, range_end: sel.end,
        selected_text: sel.text.slice(0, 200),
        is_shadow: sel.isShadowContext ?? false,
      })
      dispatch({ type: 'ADD_ANNOTATION', ann })
      dispatch({
        type: 'PUSH_UNDO',
        action: {
          description: 'Crossout',
          undo: async () => { await api.deleteAnnotation(ann.id); dispatch({ type: 'REMOVE_ANNOTATION', annId: ann.id, nodeId: sel.nodeId }) },
          redo: async () => { const r = await api.restoreAnnotation(ann.id); dispatch({ type: 'RESTORE_ANNOTATION', ann: r }) },
        },
      })
    } catch (e) { console.error('Crossout failed:', e) }
    dispatch({ type: 'SET_SELECTION', sel: null })
    window.getSelection()?.removeAllRanges()
  }, [state.pendingSelection, dispatch])

  const handleRemoveAnnotation = useCallback(async () => {
    const sel = state.pendingSelection
    if (!sel?.existingAnnId) return
    const { existingAnnId, nodeId } = sel
    try {
      await api.deleteAnnotation(existingAnnId)
      dispatch({ type: 'REMOVE_ANNOTATION', annId: existingAnnId, nodeId })
      dispatch({
        type: 'PUSH_UNDO',
        action: {
          description: 'Remove annotation',
          undo: async () => { const r = await api.restoreAnnotation(existingAnnId); dispatch({ type: 'RESTORE_ANNOTATION', ann: r }) },
          redo: async () => { await api.deleteAnnotation(existingAnnId); dispatch({ type: 'REMOVE_ANNOTATION', annId: existingAnnId, nodeId }) },
        },
      })
    } catch (e) { console.error('Remove annotation failed:', e) }
    dispatch({ type: 'SET_SELECTION', sel: null })
  }, [state.pendingSelection, dispatch])

  // ── Export ────────────────────────────────────────────────────
  const handleExport = useCallback(async () => {
    if (!doc) return
    const data = await (await fetch(`/api/documents/${doc.id}/export`)).json()
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href = url
    a.download = `${doc.title.replace(/[^a-z0-9]/gi, '-').toLowerCase()}.json`
    a.click()
    URL.revokeObjectURL(url)
  }, [doc])

  // ── Shadow write mode ─────────────────────────────────────────
  const handleToggleShadow = useCallback(async () => {
    if (state.shadowMode) { dispatch({ type: 'SET_SHADOW_MODE', active: false }); return }
    // Entering shadow mode: check if saved shadow docs exist to load from
    try {
      const docs = await api.getShadowDocs(docId)
      setShadowDocs(docs)
      if (docs.length > 0) {
        setShowShadowPicker(true)
      } else {
        dispatch({ type: 'SET_SHADOW_MODE', active: true })
      }
    } catch {
      dispatch({ type: 'SET_SHADOW_MODE', active: true })
    }
  }, [state.shadowMode, docId, dispatch])

  const handleContinueShadow = () => { setShowShadowPicker(false); dispatch({ type: 'SET_SHADOW_MODE', active: true }) }
  const handleFreshShadow = async () => {
    await api.clearShadowNotes(docId).catch(console.error)
    dispatch({ type: 'SET_ALL_SHADOWS', notes: [] })
    setShowShadowPicker(false)
    dispatch({ type: 'SET_SHADOW_MODE', active: true })
  }
  const handleLoadShadowDoc = async (shadowDocId: string) => {
    try {
      const notes = await api.loadShadowDoc(docId, shadowDocId)
      dispatch({ type: 'SET_ALL_SHADOWS', notes })
      setShowShadowPicker(false)
      dispatch({ type: 'SET_SHADOW_MODE', active: true })
    } catch (e) { console.error('Load shadow failed:', e) }
  }

  const handleSaveShadow = useCallback(async () => {
    if (!doc) return
    try {
      const result = await api.createShadowDoc(doc.id)
      const updated = await api.getShadowDocs(doc.id)
      setShadowDocs(updated)
      showToast(
        `Shadow saved as "${result.title}". ` +
        `It now appears in the document list and can be opened independently.`
      )
    } catch (e) { console.error('Shadow save failed:', e) }
  }, [doc])

  // ── Derived ───────────────────────────────────────────────────
  const notepadNotes = doc && state.notepadNodeId
    ? (state.annotationsByNode[state.notepadNodeId] ?? []).filter(a => a.type === 'note')
    : []
  const notepadNode = doc && state.notepadNodeId
    ? (() => { for (const s of doc.sections) { const f = findNode(state.notepadNodeId, s.nodes); if (f) return f } return null })()
    : null
  const sel = state.pendingSelection
  const isCurrentShadow = !!doc?.origin_document_id

  // In compare mode: left = original, right = shadow
  const leftDoc    = compareMode ? (isCurrentShadow ? compareDoc : doc) : doc
  const rightDoc   = compareMode ? (isCurrentShadow ? doc : compareDoc) : null
  const leftUpdate = compareMode ? (isCurrentShadow ? handleCompareNodeUpdate : handleNodeUpdate) : handleNodeUpdate
  const rightUpdate = compareMode ? (isCurrentShadow ? handleNodeUpdate : handleCompareNodeUpdate) : handleNodeUpdate

  if (!doc) return <div style={{ padding: 40, color: 'var(--text-2)' }}>Loading…</div>

  return (
    <div className="doc-view">
      {/* ── Header ── */}
      <div className="doc-header">
        <button className="btn btn-sm" onClick={onBack}>← Back</button>
        <h1>
          {isCurrentShadow && <span className="shadow-doc-tag" style={{ marginRight: 8 }}>Shadow</span>}
          {doc.title.replace(/^\[Shadow\]\s*/, '')}
        </h1>
        <div className="toolbar">
          {/* Shadow mode button (write-from-memory mode) */}
          {!compareMode && (
            <button
              className={`btn btn-sm ${state.shadowMode ? 'active' : ''}`}
              onClick={handleToggleShadow}
              title="Shadow mode: write from memory"
            >
              ✍ Shadow
            </button>
          )}
          {state.shadowMode && !compareMode && (
            <>
              <button
                className={`btn btn-sm ${state.syncScroll ? 'active' : ''}`}
                onClick={() => dispatch({ type: 'TOGGLE_SYNC_SCROLL' })}
                title="Sync scroll"
              >⇄</button>
              <button
                className="btn btn-sm btn-primary"
                onClick={handleSaveShadow}
                title="Save as independent document"
              >💾 Save as doc</button>
            </>
          )}

          {/* Compare mode button */}
          {!state.shadowMode && (
            <>
              {isCurrentShadow ? (
                // Shadow doc → compare with original directly
                <button
                  className={`btn btn-sm ${compareMode ? 'active' : ''}`}
                  onClick={compareMode ? exitCompareMode : () => enterCompareWith(doc.origin_document_id!)}
                  title={compareMode ? 'Exit compare' : 'Compare with original'}
                >
                  {compareMode ? '✕ Compare' : '⇔ Original'}
                </button>
              ) : shadowDocs.length > 0 ? (
                // Normal doc with saved shadows → dropdown
                <div style={{ position: 'relative' }}>
                  <button
                    className={`btn btn-sm ${compareMode ? 'active' : ''}`}
                    onClick={compareMode ? exitCompareMode : () => setShowCompareDropdown(v => !v)}
                  >
                    {compareMode ? '✕ Compare' : '⇔ Compare'}
                  </button>
                  {showCompareDropdown && (
                    <div className="compare-dropdown">
                      {shadowDocs.map(sd => (
                        <button key={sd.id} className="compare-dropdown-item" onClick={() => enterCompareWith(sd.id)}>
                          {sd.title.replace(/^\[Shadow\]\s*/, '')}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : null}
            </>
          )}

          {compareMode && (
            <button
              className={`btn btn-sm ${state.syncScroll ? 'active' : ''}`}
              onClick={() => dispatch({ type: 'TOGGLE_SYNC_SCROLL' })}
              title="Sync scroll"
            >⇄</button>
          )}

          <div className="divider" />
          <button className="btn btn-sm" onClick={() => dispatch({ type: 'TOGGLE_SEARCH' })}>
            🔍 <span style={{ color: 'var(--text-3)', fontSize: 11 }}>⌘K</span>
          </button>
          <button
            className={`btn btn-sm ${state.collectionsOpen ? 'active' : ''}`}
            onClick={() => dispatch({ type: 'TOGGLE_COLLECTIONS' })}
          >❤</button>
          <div className="divider" />
          <button className="btn btn-sm" onClick={handleExport} title="Export as JSON">↓ Export</button>
        </div>
      </div>

      {/* ── Body ── */}
      <div className={`doc-body ${(state.shadowMode || compareMode) ? 'shadow-mode' : 'normal-mode'}`}>
        {!state.shadowMode && !compareMode ? (
          // Normal single-pane view
          <div className="main-pane" ref={leftScrollRef as any}>
            <Tree sections={doc.sections} onNodeUpdate={handleNodeUpdate} />
            {doc.footer && (
              <footer style={{ marginTop: 40, fontSize: 12, color: 'var(--text-3)', borderTop: '1px solid var(--line)', paddingTop: 14 }}>
                {doc.footer}
              </footer>
            )}
          </div>
        ) : compareMode ? (
          // Compare mode: two full document Trees
          <div className="shadow-panes" ref={shadowContainerRef} style={{ userSelect: isDraggingSplitter ? 'none' : undefined }}>
            <div className="shadow-pane" ref={leftScrollRef} style={{ width: `${splitPercent}%` }}>
              <div className="shadow-pane-label">
                {isCurrentShadow ? 'Original' : 'Current'}
                {leftDoc && <span style={{ marginLeft: 6, opacity: 0.6, fontWeight: 400 }}>{leftDoc.title.replace(/^\[Shadow\]\s*/, '').slice(0, 40)}</span>}
              </div>
              {leftDoc && <Tree sections={leftDoc.sections} onNodeUpdate={leftUpdate} isShadow={false} />}
            </div>
            <div className="splitter" onMouseDown={handleSplitterMouseDown} title="Drag to resize" />
            <div className="shadow-pane" ref={rightScrollRef} style={{ width: `${100 - splitPercent}%` }}>
              <div className="shadow-pane-label">
                {isCurrentShadow ? 'Shadow (this doc)' : 'Shadow'}
                {rightDoc && <span style={{ marginLeft: 6, opacity: 0.6, fontWeight: 400 }}>{rightDoc.title.replace(/^\[Shadow\]\s*/, '').slice(0, 40)}</span>}
              </div>
              {rightDoc && <Tree sections={rightDoc.sections} onNodeUpdate={rightUpdate} isShadow={false} />}
            </div>
          </div>
        ) : (
          // Shadow WRITE mode: left = this doc, right = shadow textareas
          <div className="shadow-panes" ref={shadowContainerRef} style={{ userSelect: isDraggingSplitter ? 'none' : undefined }}>
            <div className="shadow-pane" ref={leftScrollRef} style={{ width: `${splitPercent}%` }}>
              <div className="shadow-pane-label">Original</div>
              <Tree sections={doc.sections} onNodeUpdate={handleNodeUpdate} isShadow={false} />
            </div>
            <div className="splitter" onMouseDown={handleSplitterMouseDown} title="Drag to resize" />
            <div className="shadow-pane" ref={rightScrollRef} style={{ width: `${100 - splitPercent}%` }}>
              <div className="shadow-pane-label">Shadow — write from memory</div>
              <Tree sections={doc.sections} onNodeUpdate={handleNodeUpdate} isShadow={true} />
            </div>
          </div>
        )}
      </div>

      {/* ── Portals ── */}
      {sel && createPortal(
        <SelectionToolbar
          selection={sel}
          onHighlight={handleHighlight}
          onCrossout={handleCrossout}
          onDismiss={() => dispatch({ type: 'SET_SELECTION', sel: null })}
          onRemove={sel.existingAnnId ? handleRemoveAnnotation : undefined}
        />,
        document.body
      )}

      {state.notepadNodeId && notepadNode && createPortal(
        <NotepadPanel
          nodeId={state.notepadNodeId}
          nodeKw={notepadNode.kw}
          top={state.notepadTop}
          notes={notepadNotes}
          onClose={() => dispatch({ type: 'SET_NOTEPAD', nodeId: null })}
          onAddNote={ann => dispatch({ type: 'ADD_ANNOTATION', ann })}
          onUpdateNote={ann => dispatch({ type: 'UPDATE_ANNOTATION', ann })}
          onDeleteNote={async (annId) => {
            try {
              await api.deleteAnnotation(annId)
              dispatch({ type: 'REMOVE_ANNOTATION', annId, nodeId: state.notepadNodeId! })
              dispatch({
                type: 'PUSH_UNDO',
                action: {
                  description: 'Delete note',
                  undo: async () => { const r = await api.restoreAnnotation(annId); dispatch({ type: 'RESTORE_ANNOTATION', ann: r }) },
                  redo: async () => { await api.deleteAnnotation(annId); dispatch({ type: 'REMOVE_ANNOTATION', annId, nodeId: state.notepadNodeId! }) },
                },
              })
            } catch (e) { console.error('Delete note failed:', e) }
          }}
        />,
        document.body
      )}

      {state.searchOpen && createPortal(
        <SearchOverlay doc={doc} onClose={() => dispatch({ type: 'TOGGLE_SEARCH' })} onJump={handleJump} />,
        document.body
      )}
      {state.collectionsOpen && (
        <CollectionsDrawer doc={doc} onClose={() => dispatch({ type: 'TOGGLE_COLLECTIONS' })} onJump={handleJump} />
      )}

      {/* ── Shadow write-mode picker ── */}
      {showShadowPicker && createPortal(
        <div className="modal-overlay" onClick={() => setShowShadowPicker(false)}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <h3>Shadow Mode</h3>
            <p style={{ fontSize: 13, color: 'var(--text-2)', margin: '6px 0 16px' }}>
              You have {shadowDocs.length} saved shadow document{shadowDocs.length !== 1 ? 's' : ''}.
            </p>
            <div className="modal-options">
              <button className="modal-option" onClick={handleContinueShadow}>
                <span className="modal-option-icon">✏</span>
                <span>Continue current draft</span>
              </button>
              {shadowDocs.map(sd => (
                <button key={sd.id} className="modal-option" onClick={() => handleLoadShadowDoc(sd.id)}>
                  <span className="modal-option-icon">📂</span>
                  <span>Load: <strong>{sd.title.replace(/^\[Shadow\]\s*/, '')}</strong></span>
                </button>
              ))}
              <button className="modal-option modal-option-danger" onClick={handleFreshShadow}>
                <span className="modal-option-icon">🗑</span>
                <span>Start fresh (clear current draft)</span>
              </button>
            </div>
            <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end' }}>
              <button className="btn btn-sm" onClick={() => setShowShadowPicker(false)}>Cancel</button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* ── Undo toast ── */}
      {state.lastUndo && (
        <div className="undo-toast">
          <span>{state.lastUndo}</span>
          <button onClick={() => {
            const last = state.undoStack[state.undoStack.length - 1]
            if (last) { last.undo().catch(console.error); dispatch({ type: 'POP_UNDO' }) }
          }}>Undo</button>
          <button onClick={() => dispatch({ type: 'CLEAR_UNDO_TOAST' })}>✕</button>
        </div>
      )}

      {/* ── Generic toast ── */}
      {toast && (
        <div className="undo-toast" style={{ bottom: state.lastUndo ? 72 : 24, maxWidth: 480, whiteSpace: 'normal', textAlign: 'center' }}>
          <span>{toast}</span>
          <button onClick={() => setToast(null)}>✕</button>
        </div>
      )}
    </div>
  )
}

// ── Hash router ───────────────────────────────────────────────────────────────

function useHashRouter() {
  const [hash, setHash] = useState(() => window.location.hash)
  useEffect(() => {
    const handler = () => setHash(window.location.hash)
    window.addEventListener('hashchange', handler)
    return () => window.removeEventListener('hashchange', handler)
  }, [])
  const docId = hash.match(/^#\/doc\/([^/?]+)/)?.[1] ?? null
  const navigate = {
    toDoc: (id: string) => { window.location.hash = `/doc/${id}` },
    toList: () => { window.location.hash = '/' },
  }
  return { docId, navigate }
}

// ── Root ──────────────────────────────────────────────────────────────────────

export default function App() {
  const { docId, navigate } = useHashRouter()

  if (!docId) {
    return (
      <ErrorBoundary>
        <DocumentList onOpen={navigate.toDoc} />
      </ErrorBoundary>
    )
  }

  return (
    <ErrorBoundary>
      <StoreProvider firstSiblings={[]}>
        <DocView docId={docId} onBack={navigate.toList} onNavigate={navigate.toDoc} />
      </StoreProvider>
    </ErrorBoundary>
  )
}
