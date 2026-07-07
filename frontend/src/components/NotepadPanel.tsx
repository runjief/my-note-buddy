import React, { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import type { Annotation } from '../types'
import * as api from '../api'

const LS_SIZE_KEY = 'notepad-size'
const LS_PIN_KEY  = 'notepad-pins'
const DEFAULT_W   = 300
const DEFAULT_H   = 380
const MIN_W = 200
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

// ── Image rendering ────────────────────────────────────────────────────────────

function renderBodyWithImages(body: string, onZoom: (url: string) => void) {
  return body.split(/(!\[\]\([^)]+\))/g).map((part, i) => {
    const m = part.match(/^!\[\]\(([^)]+)\)$/)
    if (m) return (
      <img key={i} src={m[1]} className="note-image"
        onClick={() => onZoom(m[1])} alt="" title="Click to enlarge" />
    )
    return part ? <span key={i} style={{ whiteSpace: 'pre-wrap' }}>{part}</span> : null
  })
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
  const [preview, setPreview] = useState(() => !!(ann.note_body?.trim()))
  const [uploading, setUploading] = useState(false)
  const [r2Available, setR2Available] = useState<boolean | null>(null)
  const saveTimer   = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fileRef     = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    api.r2Status().then(s => setR2Available(s.configured)).catch(() => setR2Available(false))
  }, [])

  const handleChange = (v: string) => {
    setBody(v)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(async () => {
      const updated = await api.patchAnnotation(ann.id, { note_body: v })
      onUpdate(updated)
    }, 800)
  }
  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current) }, [])

  const insertAtCursor = (insertion: string) => {
    const ta = textareaRef.current
    if (!ta) { handleChange(body + insertion); return }
    const s = ta.selectionStart, e = ta.selectionEnd
    const next = body.slice(0, s) + insertion + body.slice(e)
    handleChange(next)
    requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = s + insertion.length; ta.focus() })
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

  const hasImages = /!\[\]\([^)]+\)/.test(body)

  return (
    <div className={`note-card ${pinned ? 'note-card-pinned' : ''}`}>
      <div className="note-card-toolbar">
        <button
          className={`btn btn-sm ${pinned ? 'active' : ''}`}
          title={pinned ? 'Unpin' : 'Pin to top'}
          onMouseDown={e => { e.preventDefault(); onPin() }}
        >📌</button>
        <button className={`btn btn-sm ${!preview ? 'active' : ''}`}
          onMouseDown={e => { e.preventDefault(); setPreview(false) }}>Edit</button>
        <button className={`btn btn-sm ${preview ? 'active' : ''}`}
          onMouseDown={e => { e.preventDefault(); setPreview(true) }}>Preview</button>
        {r2Available && (
          <button className="btn btn-sm" disabled={uploading}
            onMouseDown={e => { e.preventDefault(); fileRef.current?.click() }}
            title="Upload image (or paste from clipboard)">{uploading ? '…' : '🖼'}</button>
        )}
        {!r2Available && r2Available !== null && (
          <span title="R2 not configured" style={{ fontSize: 11, color: 'var(--text-3)', cursor: 'help' }}>🖼?</span>
        )}
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={handleFileChange} />
      </div>

      {preview ? (
        <div className="note-preview" onClick={() => setPreview(false)} title="Click to edit">
          {body.trim()
            ? renderBodyWithImages(body, onZoomImage)
            : <span style={{ color: 'var(--text-3)', fontStyle: 'italic' }}>Empty — click to edit</span>}
          {hasImages && <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>Click image to enlarge</div>}
        </div>
      ) : (
        <textarea ref={textareaRef} value={body}
          onChange={e => handleChange(e.target.value)}
          onPaste={handlePaste}
          placeholder="Write a note… upload images with 🖼 or paste from clipboard"
          style={{ minHeight: 72 }}
          onBlur={() => { if (body.trim()) setPreview(true) }} />
      )}

      <div className="note-card-actions">
        <button className="btn btn-sm btn-danger" onClick={onDelete}>Delete</button>
      </div>
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

  // Snapshots at drag/resize start
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

  // Sort notes: pinned first, then by created_at desc
  const sortedNotes = [...notes].sort((a, b) => {
    const ap = pins.has(a.id) ? 0 : 1
    const bp = pins.has(b.id) ? 0 : 1
    if (ap !== bp) return ap - bp
    return a.created_at < b.created_at ? 1 : -1
  })

  // ── Header drag ────────────────────────────────────────────────
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

  // ── Edge resize ────────────────────────────────────────────────
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
        {/* Edge resize handles */}
        <div className="notepad-edge notepad-edge-left"   onMouseDown={e => handleEdgeMouseDown(e, 'left')} />
        <div className="notepad-edge notepad-edge-right"  onMouseDown={e => handleEdgeMouseDown(e, 'right')} />
        <div className="notepad-edge notepad-edge-bottom" onMouseDown={e => handleEdgeMouseDown(e, 'bottom')} />
        <div className="notepad-edge notepad-edge-bl"     onMouseDown={e => handleEdgeMouseDown(e, 'bottom-left')} />
        <div className="notepad-edge notepad-edge-br"     onMouseDown={e => handleEdgeMouseDown(e, 'bottom-right')} />

        {/* Header */}
        <div className="notepad-header" onMouseDown={handleHeaderMouseDown} style={{ cursor: 'grab' }}>
          <span>Notepad</span>
          <span className="notepad-kw">{nodeKw}</span>
          <button className="btn btn-sm" style={{ border: 'none', padding: '2px 6px', flexShrink: 0 }}
            onClick={onClose} aria-label="Close">✕</button>
        </div>

        {/* Body */}
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

      {/* Image zoom overlay */}
      {zoomedImg && createPortal(
        <div className="note-image-overlay" onClick={() => setZoomedImg(null)}>
          <img src={zoomedImg} style={{ maxWidth: '90vw', maxHeight: '90vh', objectFit: 'contain' }} alt="" />
          <div style={{ position: 'absolute', top: 16, right: 20, color: '#fff', fontSize: 24, cursor: 'pointer' }}>✕</div>
        </div>,
        document.body
      )}
    </>
  )
}
