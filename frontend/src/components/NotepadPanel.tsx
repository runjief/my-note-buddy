import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { Pin, PinOff, Image as ImageIcon, Code, X, Maximize2 } from 'lucide-react'
import hljs from 'highlight.js/lib/core'
import 'highlight.js/styles/atom-one-dark.css'
import langJs    from 'highlight.js/lib/languages/javascript'
import langTs    from 'highlight.js/lib/languages/typescript'
import langPy    from 'highlight.js/lib/languages/python'
import langRust  from 'highlight.js/lib/languages/rust'
import langGo    from 'highlight.js/lib/languages/go'
import langJava  from 'highlight.js/lib/languages/java'
import langCpp   from 'highlight.js/lib/languages/cpp'
import langCss   from 'highlight.js/lib/languages/css'
import langHtml  from 'highlight.js/lib/languages/xml'
import langJson  from 'highlight.js/lib/languages/json'
import langYaml  from 'highlight.js/lib/languages/yaml'
import langBash  from 'highlight.js/lib/languages/bash'
import langSql   from 'highlight.js/lib/languages/sql'
import langMd    from 'highlight.js/lib/languages/markdown'
import type { Annotation } from '../types'
import { CodeEditorModal } from './CodeEditorModal'
import * as api from '../api'

hljs.registerLanguage('javascript', langJs)
hljs.registerLanguage('typescript', langTs)
hljs.registerLanguage('tsx', langTs)
hljs.registerLanguage('jsx', langJs)
hljs.registerLanguage('python', langPy)
hljs.registerLanguage('rust', langRust)
hljs.registerLanguage('go', langGo)
hljs.registerLanguage('java', langJava)
hljs.registerLanguage('cpp', langCpp)
hljs.registerLanguage('c', langCpp)
hljs.registerLanguage('css', langCss)
hljs.registerLanguage('html', langHtml)
hljs.registerLanguage('xml', langHtml)
hljs.registerLanguage('json', langJson)
hljs.registerLanguage('yaml', langYaml)
hljs.registerLanguage('bash', langBash)
hljs.registerLanguage('sh', langBash)
hljs.registerLanguage('sql', langSql)
hljs.registerLanguage('markdown', langMd)

const LS_SIZE_KEY = 'notepad-size'
const LS_PIN_KEY  = 'notepad-pins'
const DEFAULT_W   = 320
const DEFAULT_H   = 400
const MIN_W = 220
const MIN_H = 160

function loadSize() {
  try { const r = localStorage.getItem(LS_SIZE_KEY); if (r) return JSON.parse(r) } catch {}
  return { w: DEFAULT_W, h: DEFAULT_H }
}
function saveSize(w: number, h: number) {
  try { localStorage.setItem(LS_SIZE_KEY, JSON.stringify({ w, h })) } catch {}
}
function loadPins(): Set<string> {
  try { const r = localStorage.getItem(LS_PIN_KEY); if (r) return new Set(JSON.parse(r)) } catch {}
  return new Set()
}
function savePins(pins: Set<string>) {
  try { localStorage.setItem(LS_PIN_KEY, JSON.stringify([...pins])) } catch {}
}

// ── Code block parsing ─────────────────────────────────────────────────────────

interface TextSegment { kind: 'text'; content: string }
interface CodeSegment { kind: 'code'; lang: string; code: string; blockIdx: number }
type Segment = TextSegment | CodeSegment

function parseNoteBody(body: string): Segment[] {
  const segments: Segment[] = []
  const re = /```(\w*)\n([\s\S]*?)```/g
  let last = 0
  let blockIdx = 0
  let match: RegExpExecArray | null
  while ((match = re.exec(body)) !== null) {
    if (match.index > last) {
      segments.push({ kind: 'text', content: body.slice(last, match.index) })
    }
    segments.push({ kind: 'code', lang: match[1] || 'plaintext', code: match[2], blockIdx })
    blockIdx++
    last = match.index + match[0].length
  }
  if (last < body.length) {
    segments.push({ kind: 'text', content: body.slice(last) })
  }
  return segments
}

function replaceCodeBlock(body: string, blockIdx: number, newCode: string, newLang: string): string {
  const re = /```(\w*)\n([\s\S]*?)```/g
  let idx = 0
  return body.replace(re, (full, lang, code) => {
    if (idx++ === blockIdx) return `\`\`\`${newLang}\n${newCode}\`\`\``
    return full
  })
}

// ── Inline markdown renderer ───────────────────────────────────────────────────

// Supports: **bold**, *italic*, `code`, ==highlight==, https://urls
const INLINE_RE = /(`[^`\n]+`)|(\*\*([^*\n]+)\*\*)|(\*([^*\n]+)\*)|==([^=\n]+)==|(https?:\/\/[^\s,)>"]+)/g

function renderInlineText(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  INLINE_RE.lastIndex = 0
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index))
    if      (m[1]) nodes.push(<code key={m.index} className="note-inline-code">{m[1].slice(1, -1)}</code>)
    else if (m[2]) nodes.push(<strong key={m.index}>{m[3]}</strong>)
    else if (m[4]) nodes.push(<em key={m.index}>{m[5]}</em>)
    else if (m[6]) nodes.push(<mark key={m.index} className="note-mark">{m[6]}</mark>)
    else if (m[7]) nodes.push(<a key={m.index} href={m[7]} target="_blank" rel="noopener noreferrer">{m[7]}</a>)
    last = m.index + m[0].length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

// ── Plain-text ↔ raw-body position mapping ────────────────────────────────────

// Given raw markdown body and a plain-text selection string, returns [rawStart, rawEnd)
// that covers the corresponding raw range (expanding to include full ==...== markers).
function rawRangeForPlainSel(raw: string, sel: string): [number, number] | null {
  type Seg = { rawStart: number; rawEnd: number; plain: string; isMarker: boolean }
  const segs: Seg[] = []
  const re = /==([^=\n]+)==/g
  let last = 0, m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    if (m.index > last) segs.push({ rawStart: last, rawEnd: m.index, plain: raw.slice(last, m.index), isMarker: false })
    segs.push({ rawStart: m.index, rawEnd: m.index + m[0].length, plain: m[1], isMarker: true })
    last = m.index + m[0].length
  }
  if (last < raw.length) segs.push({ rawStart: last, rawEnd: raw.length, plain: raw.slice(last), isMarker: false })

  const plainStr = segs.map(s => s.plain).join('')
  const idx = plainStr.indexOf(sel)
  if (idx === -1) return null
  const plainEnd = idx + sel.length

  let pos = 0, rawStart = -1, rawEnd = -1
  for (const seg of segs) {
    const sEnd = pos + seg.plain.length
    if (rawStart === -1 && sEnd > idx) {
      rawStart = seg.isMarker ? seg.rawStart : seg.rawStart + (idx - pos)
    }
    if (rawEnd === -1 && sEnd >= plainEnd) {
      rawEnd = seg.isMarker ? seg.rawEnd : seg.rawStart + (plainEnd - pos)
      break
    }
    pos = sEnd
  }
  return rawStart !== -1 && rawEnd !== -1 ? [rawStart, rawEnd] : null
}

// ── Image rendering ────────────────────────────────────────────────────────────

function renderBodyWithImages(body: string, onZoom: (url: string) => void) {
  return body.split(/(!\[\]\([^)]+\))/g).map((part, i) => {
    const m = part.match(/^!\[\]\(([^)]+)\)$/)
    if (m) return (
      <img key={i} src={m[1]} className="note-image"
        onClick={() => onZoom(m[1])} alt="" title="Click to enlarge" />
    )
    return part ? <span key={i} style={{ whiteSpace: 'pre-wrap' }}>{renderInlineText(part)}</span> : null
  })
}

// ── Code block preview ─────────────────────────────────────────────────────────

const PREVIEW_LINES = 5

interface CodePreviewProps {
  seg: CodeSegment
  onEdit: (seg: CodeSegment) => void
  onView: (seg: CodeSegment) => void
}

function CodePreview({ seg, onEdit, onView }: CodePreviewProps) {
  const lines = seg.code.split('\n')
  const overflow = lines.length > PREVIEW_LINES
  const shown = overflow ? lines.slice(0, PREVIEW_LINES).join('\n') : seg.code

  const highlighted = useMemo(() => {
    const lang = seg.lang?.toLowerCase()
    try {
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(shown, { language: lang }).value
      }
      return hljs.highlightAuto(shown).value
    } catch {
      return hljs.highlight(shown, { language: 'plaintext' }).value
    }
  }, [shown, seg.lang])

  return (
    <div className="code-preview-block">
      <div className="code-preview-header">
        <span className="code-preview-lang">{seg.lang}</span>
        <div style={{ display: 'flex', gap: 4 }}>
          <button className="btn btn-xs" onClick={() => onView(seg)} title="View full code">
            <Maximize2 size={11} />
          </button>
          <button className="btn btn-xs" onClick={() => onEdit(seg)} title="Edit code">
            <Code size={11} />
            <span>Edit</span>
          </button>
        </div>
      </div>
      <pre className="code-preview-pre hljs"><code dangerouslySetInnerHTML={{ __html: highlighted }} /></pre>
      {overflow && (
        <div className="code-preview-more">
          +{lines.length - PREVIEW_LINES} more lines
          <button className="btn btn-xs" style={{ marginLeft: 8 }} onClick={() => onView(seg)}>
            View all
          </button>
        </div>
      )}
    </div>
  )
}

// ── Note card ──────────────────────────────────────────────────────────────────

interface NoteCardProps {
  ann: Annotation
  pinned: boolean
  onPin: () => void
  onUpdate: (ann: Annotation) => void
  onDelete: () => void
  onZoomImage: (url: string) => void
}

function NoteCard({ ann, pinned, onPin, onUpdate, onDelete, onZoomImage }: NoteCardProps) {
  const [body, setBody]       = useState(ann.note_body ?? '')
  const [preview, setPreview] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [r2Available, setR2Available] = useState<boolean | null>(null)
  const [editingCode, setEditingCode] = useState<CodeSegment | null>(null)
  const [viewingCode, setViewingCode]  = useState<CodeSegment | null>(null)
  const [addingCode, setAddingCode] = useState(false)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; sel: string } | null>(null)
  const saveTimer   = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fileRef     = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const ctxMenuRef  = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api.r2Status().then(s => setR2Available(s.configured)).catch(() => setR2Available(false))
  }, [])

  const persistBody = useCallback((v: string) => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(async () => {
      const updated = await api.patchAnnotation(ann.id, { note_body: v })
      onUpdate(updated)
    }, 800)
  }, [ann.id, onUpdate])

  const handleChange = (v: string) => {
    setBody(v)
    persistBody(v)
  }

  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current) }, [])

  useEffect(() => {
    if (!ctxMenu) return
    const handler = (e: MouseEvent) => {
      if (ctxMenuRef.current && !ctxMenuRef.current.contains(e.target as Node)) setCtxMenu(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [ctxMenu])

  const handleContextMenu = (e: React.MouseEvent) => {
    // Prefer active text selection; fall back to the <mark> element being right-clicked
    let sel = window.getSelection()?.toString().trim() ?? ''
    if (!sel) {
      const markEl = (e.target as HTMLElement).closest?.('mark')
      if (markEl) sel = markEl.textContent?.trim() ?? ''
    }
    if (!sel) return
    e.preventDefault()
    setCtxMenu({ x: e.clientX, y: e.clientY, sel })
  }

  const applyHighlight = () => {
    if (!ctxMenu) return
    const { sel } = ctxMenu
    const marked = `==${sel}==`
    let next: string

    if (body.includes(marked)) {
      // Exact highlight exists → remove it
      next = body.replace(marked, sel)
    } else {
      // Try direct substring match first (no existing highlights in range)
      const idx = body.indexOf(sel)
      if (idx !== -1) {
        next = body.slice(0, idx) + marked + body.slice(idx + sel.length)
      } else {
        // Selection crosses existing ==...== markers: map via plain text
        const range = rawRangeForPlainSel(body, sel)
        if (!range) { setCtxMenu(null); return }
        const [rawStart, rawEnd] = range
        // Strip any nested markers in the raw slice before re-wrapping
        const inner = body.slice(rawStart, rawEnd).replace(/==([^=\n]+)==/g, '$1')
        next = body.slice(0, rawStart) + `==${inner}==` + body.slice(rawEnd)
      }
    }
    handleChange(next)
    setCtxMenu(null)
    window.getSelection()?.removeAllRanges()
  }

  const insertAtCursor = (insertion: string, cursorOffset?: number) => {
    const ta = textareaRef.current
    if (!ta) { handleChange(body + insertion); return }
    const s = ta.selectionStart, e = ta.selectionEnd
    const next = body.slice(0, s) + insertion + body.slice(e)
    handleChange(next)
    requestAnimationFrame(() => {
      const pos = cursorOffset !== undefined ? s + cursorOffset : s + insertion.length
      ta.selectionStart = ta.selectionEnd = pos
      ta.focus()
    })
  }

  const openNewCodeBlock = () => {
    setAddingCode(true)
  }

  const handleNewCodeSave = (newCode: string, newLang: string) => {
    const fence = `\`\`\`${newLang}\n${newCode}\n\`\`\``
    const sep = body.trim() ? '\n' : ''
    handleChange(body.trim() + sep + fence)
    setAddingCode(false)
    setPreview(true)
  }

  const uploadFile = async (file: File) => {
    setUploading(true)
    try { const { url } = await api.uploadImage(file); insertAtCursor(`![](${url})`) }
    catch (err: any) { alert(`Upload failed: ${err.message}`) }
    finally { setUploading(false) }
  }

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return
    e.target.value = ''
    await uploadFile(file)
  }

  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items
    if (!items) return
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        const file = items[i].getAsFile()
        if (file && r2Available) {
          e.preventDefault()
          await uploadFile(file)
          return
        }
      }
    }
  }

  const handleCodeSave = (seg: CodeSegment, newCode: string, newLang: string) => {
    const next = replaceCodeBlock(body, seg.blockIdx, newCode, newLang)
    handleChange(next)
    setEditingCode(null)
  }

  const segments = parseNoteBody(body)
  const hasImages = /!\[\]\([^)]+\)/.test(body)

  return (
    <div className={`note-card ${pinned ? 'note-card-pinned' : ''}`}>
      <div className="note-card-toolbar">
        <button
          className={`btn btn-sm icon-btn ${pinned ? 'active' : ''}`}
          title={pinned ? 'Unpin' : 'Pin to top'}
          onMouseDown={e => { e.preventDefault(); onPin() }}
        >
          {pinned ? <PinOff size={13} /> : <Pin size={13} />}
        </button>
        <button className={`btn btn-sm ${!preview ? 'active' : ''}`}
          onMouseDown={e => { e.preventDefault(); setPreview(false) }}>Edit</button>
        <button className={`btn btn-sm ${preview ? 'active' : ''}`}
          onMouseDown={e => { e.preventDefault(); setPreview(true) }}>Preview</button>
        <button
          className="btn btn-sm icon-btn"
          title="Add code block"
          onMouseDown={e => { e.preventDefault(); openNewCodeBlock() }}
        >
          <Code size={13} />
        </button>
        {r2Available && (
          <button className="btn btn-sm icon-btn" disabled={uploading}
            onMouseDown={e => { e.preventDefault(); fileRef.current?.click() }}
            title="Upload image (or paste from clipboard)">
            {uploading ? <span style={{ fontSize: 11 }}>…</span> : <ImageIcon size={13} />}
          </button>
        )}
        {!r2Available && r2Available !== null && (
          <span title="R2 not configured" style={{ fontSize: 11, color: 'var(--text-3)', cursor: 'help' }}>
            <ImageIcon size={12} style={{ opacity: 0.4 }} />?
          </span>
        )}
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={handleFileChange} />
      </div>

      {preview ? (
        <div className="note-preview" onContextMenu={handleContextMenu}>
          {body.trim() ? (
            <>
              {segments.map((seg, i) => {
                if (seg.kind === 'text') {
                  const textContent = renderBodyWithImages(seg.content, onZoomImage)
                  return textContent.some(Boolean) ? <span key={i}>{textContent}</span> : null
                }
                return (
                  <CodePreview
                    key={i}
                    seg={seg}
                    onEdit={s => { setEditingCode(s); setPreview(false) }}
                    onView={s => setViewingCode(s)}
                  />
                )
              })}
              {hasImages && <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>Click image to enlarge</div>}
            </>
          ) : (
            <span style={{ color: 'var(--text-3)', fontStyle: 'italic' }}>Empty — press Edit to write</span>
          )}
        </div>
      ) : (
        <textarea ref={textareaRef} value={body}
          onChange={e => handleChange(e.target.value)}
          onPaste={handlePaste}
          placeholder="Write a note… paste images or insert code blocks"
          style={{ minHeight: 72 }} />
      )}

      <div className="note-card-actions">
        <button className="btn btn-sm btn-danger" onClick={onDelete}>Delete</button>
      </div>

      {editingCode && (
        <CodeEditorModal
          initialCode={editingCode.code}
          initialLang={editingCode.lang}
          onSave={(code, lang) => handleCodeSave(editingCode, code, lang)}
          onClose={() => setEditingCode(null)}
        />
      )}
      {viewingCode && (
        <CodeEditorModal
          initialCode={viewingCode.code}
          initialLang={viewingCode.lang}
          readOnly
          onClose={() => setViewingCode(null)}
        />
      )}
      {addingCode && (
        <CodeEditorModal
          initialCode=""
          initialLang=""
          onSave={handleNewCodeSave}
          onClose={() => setAddingCode(false)}
        />
      )}

      {ctxMenu && createPortal(
        <div ref={ctxMenuRef} className="note-ctx-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }}>
          <button onClick={applyHighlight}>
            {body.includes(`==${ctxMenu.sel}==`) ? 'Remove highlight' : 'Highlight'}
          </button>
        </div>,
        document.body
      )}
    </div>
  )
}

// ── Panel ──────────────────────────────────────────────────────────────────────

interface Props {
  nodeId: string
  nodeKw: string
  top: number
  notes: Annotation[]
  onClose: () => void
  onAddNote: (ann: Annotation) => void
  onUpdateNote: (ann: Annotation) => void
  onDeleteNote: (annId: string) => void
}

type ResizeEdge = 'left' | 'right' | 'bottom' | 'bottom-left' | 'bottom-right'

export function NotepadPanel({ nodeId, nodeKw, top, notes, onClose, onAddNote, onUpdateNote, onDeleteNote }: Props) {
  const panelRef   = useRef<HTMLDivElement>(null)
  const isDragging = useRef(false)
  const isResizing = useRef(false)

  const [pos,  setPos]  = useState(() => {
    const sz = loadSize()
    return { x: Math.max(8, window.innerWidth - sz.w - 24), y: Math.max(8, Math.min(top, window.innerHeight - 120)) }
  })
  const [size, setSize] = useState(loadSize)
  const [zoomedImg, setZoomedImg] = useState<string | null>(null)
  const [pins, setPins] = useState<Set<string>>(loadPins)

  const startSnap = useRef({ x: 0, y: 0, w: 0, h: 0, mx: 0, my: 0 })

  const togglePin = (annId: string) => {
    setPins(prev => {
      const next = new Set(prev)
      if (next.has(annId)) next.delete(annId)
      else next.add(annId)
      savePins(next)
      return next
    })
  }

  const sortedNotes = [...notes].sort((a, b) => {
    const ap = pins.has(a.id) ? 0 : 1
    const bp = pins.has(b.id) ? 0 : 1
    if (ap !== bp) return ap - bp
    return a.created_at < b.created_at ? 1 : -1
  })

  const handleHeaderMouseDown = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return
    e.preventDefault()
    isDragging.current = true
    startSnap.current = { x: pos.x, y: pos.y, w: size.w, h: size.h, mx: e.clientX, my: e.clientY }

    const onMove = (ev: MouseEvent) => {
      if (!isDragging.current) return
      const dx = ev.clientX - startSnap.current.mx
      const dy = ev.clientY - startSnap.current.my
      setPos({
        x: Math.max(0, Math.min(window.innerWidth - startSnap.current.w, startSnap.current.x + dx)),
        y: Math.max(0, Math.min(window.innerHeight - 40, startSnap.current.y + dy)),
      })
    }
    const onUp = () => { isDragging.current = false; document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [pos, size.w])

  const handleEdgeMouseDown = useCallback((e: React.MouseEvent, edge: ResizeEdge) => {
    e.preventDefault()
    e.stopPropagation()
    isResizing.current = true
    startSnap.current = { x: pos.x, y: pos.y, w: size.w, h: size.h, mx: e.clientX, my: e.clientY }

    const onMove = (ev: MouseEvent) => {
      if (!isResizing.current) return
      const dx = ev.clientX - startSnap.current.mx
      const dy = ev.clientY - startSnap.current.my
      setPos(p => {
        let nx = p.x, ny = p.y
        setSize((s: { w: number; h: number }) => {
          let nw = s.w, nh = s.h
          if (edge === 'right' || edge === 'bottom-right')  nw = Math.max(MIN_W, startSnap.current.w + dx)
          if (edge === 'left'  || edge === 'bottom-left') {
            nw = Math.max(MIN_W, startSnap.current.w - dx)
            nx = startSnap.current.x + startSnap.current.w - nw
          }
          if (edge === 'bottom' || edge === 'bottom-left' || edge === 'bottom-right')
            nh = Math.max(MIN_H, startSnap.current.h + dy)
          return { w: nw, h: nh }
        })
        return { x: nx, y: ny }
      })
    }
    const onUp = () => {
      isResizing.current = false
      setSize((s: { w: number; h: number }) => { saveSize(s.w, s.h); return s })
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [pos, size])

  const handleAdd = useCallback(async () => {
    const ann = await api.createAnnotation(nodeId, { type: 'note', note_body: '' })
    onAddNote(ann)
  }, [nodeId, onAddNote])

  return (
    <>
      <div
        ref={panelRef}
        className="notepad-panel"
        style={{ left: pos.x, top: pos.y, right: 'auto', width: size.w, height: size.h }}
      >
        <div className="notepad-edge notepad-edge-left"   onMouseDown={e => handleEdgeMouseDown(e, 'left')} />
        <div className="notepad-edge notepad-edge-right"  onMouseDown={e => handleEdgeMouseDown(e, 'right')} />
        <div className="notepad-edge notepad-edge-bottom" onMouseDown={e => handleEdgeMouseDown(e, 'bottom')} />
        <div className="notepad-edge notepad-edge-bl"     onMouseDown={e => handleEdgeMouseDown(e, 'bottom-left')} />
        <div className="notepad-edge notepad-edge-br"     onMouseDown={e => handleEdgeMouseDown(e, 'bottom-right')} />

        <div className="notepad-header" onMouseDown={handleHeaderMouseDown} style={{ cursor: 'grab' }}>
          <span>Notepad</span>
          <span className="notepad-kw">{nodeKw}</span>
          <button className="btn btn-sm icon-btn" style={{ border: 'none', padding: '3px 5px', flexShrink: 0 }}
            onClick={onClose} aria-label="Close"><X size={14} /></button>
        </div>

        <div className="notepad-body">
          {sortedNotes.map(ann => (
            <NoteCard key={ann.id} ann={ann}
              pinned={pins.has(ann.id)}
              onPin={() => togglePin(ann.id)}
              onUpdate={onUpdateNote}
              onDelete={() => onDeleteNote(ann.id)}
              onZoomImage={setZoomedImg} />
          ))}
          <button className="notepad-add-btn" onClick={handleAdd}>+ Add note</button>
        </div>
      </div>

      {zoomedImg && createPortal(
        <div className="note-image-overlay" onClick={() => setZoomedImg(null)}>
          <img src={zoomedImg} style={{ maxWidth: '90vw', maxHeight: '90vh', objectFit: 'contain' }} alt="" />
          <div style={{ position: 'absolute', top: 16, right: 20, color: '#fff', fontSize: 24, cursor: 'pointer' }}>
            <X size={24} />
          </div>
        </div>,
        document.body
      )}
    </>
  )
}
