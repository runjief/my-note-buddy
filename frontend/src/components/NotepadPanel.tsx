import React, { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import type { Annotation } from '../types'
import * as api from '../api'

const LS_SIZE_KEY = 'notepad-size'
const DEFAULT_W   = 300
const DEFAULT_H   = 380
const MIN_W       = 220
const MIN_H       = 180

function loadSize(): { w: number; h: number } {
  try {
    const raw = localStorage.getItem(LS_SIZE_KEY)
    if (raw) return JSON.parse(raw)
  } catch {}
  return { w: DEFAULT_W, h: DEFAULT_H }
}
function saveSize(w: number, h: number) {
  try { localStorage.setItem(LS_SIZE_KEY, JSON.stringify({ w, h })) } catch {}
}

// ── Image parsing ──────────────────────────────────────────────────────────────

function renderBodyWithImages(body: string, onZoom: (url: string) => void) {
  const parts = body.split(/(!\[\]\([^)]+\))/g)
  return parts.map((part, i) => {
    const m = part.match(/^!\[\]\(([^)]+)\)$/)
    if (m) {
      return (
        <img
          key={i}
          src={m[1]}
          className="note-image"
          onClick={() => onZoom(m[1])}
          alt=""
          title="Click to enlarge"
        />
      )
    }
    return part ? <span key={i} style={{ whiteSpace: 'pre-wrap' }}>{part}</span> : null
  })
}

// ── Note card ──────────────────────────────────────────────────────────────────

interface NoteCardProps {
  ann: Annotation
  onUpdate: (ann: Annotation) => void
  onDelete: () => void
  onZoomImage: (url: string) => void
}

function NoteCard({ ann, onUpdate, onDelete, onZoomImage }: NoteCardProps) {
  const [body, setBody] = useState(ann.note_body ?? '')
  // Default to preview if there is content
  const [preview, setPreview] = useState(() => !!(ann.note_body?.trim()))
  const [uploading, setUploading] = useState(false)
  const [r2Available, setR2Available] = useState<boolean | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fileRef   = useRef<HTMLInputElement>(null)
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
    const start = ta.selectionStart
    const end   = ta.selectionEnd
    const next  = body.slice(0, start) + insertion + body.slice(end)
    handleChange(next)
    requestAnimationFrame(() => {
      ta.selectionStart = ta.selectionEnd = start + insertion.length
      ta.focus()
    })
  }

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    setUploading(true)
    try {
      const { url } = await api.uploadImage(file)
      insertAtCursor(`![](${url})`)
    } catch (err: any) {
      alert(`Upload failed: ${err.message}`)
    } finally {
      setUploading(false)
    }
  }

  const hasImages = /!\[\]\([^)]+\)/.test(body)

  return (
    <div className="note-card">
      <div className="note-card-toolbar">
        <button
          className={`btn btn-sm ${!preview ? 'active' : ''}`}
          onMouseDown={e => { e.preventDefault(); setPreview(false) }}
          title="Edit mode"
        >Edit</button>
        <button
          className={`btn btn-sm ${preview ? 'active' : ''}`}
          onMouseDown={e => { e.preventDefault(); setPreview(true) }}
          title="Preview"
        >Preview</button>
        {r2Available && (
          <button
            className="btn btn-sm"
            onMouseDown={e => { e.preventDefault(); fileRef.current?.click() }}
            disabled={uploading}
            title="Upload image to Cloudflare R2"
          >
            {uploading ? '…' : '🖼'}
          </button>
        )}
        {!r2Available && r2Available !== null && (
          <span title="R2 not configured — see setup guide" style={{ fontSize: 11, color: 'var(--text-3)', cursor: 'help' }}>🖼?</span>
        )}
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={handleFileChange} />
      </div>

      {preview ? (
        <div
          className="note-preview"
          onClick={() => setPreview(false)}
          title="Click to edit"
        >
          {body.trim()
            ? renderBodyWithImages(body, onZoomImage)
            : <span style={{ color: 'var(--text-3)', fontStyle: 'italic' }}>Empty — click to edit</span>
          }
          {hasImages && <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>Click image to enlarge</div>}
        </div>
      ) : (
        <textarea
          ref={textareaRef}
          value={body}
          onChange={e => handleChange(e.target.value)}
          placeholder="Write a note… upload images with 🖼"
          style={{ minHeight: 72 }}
          onBlur={() => { if (body.trim()) setPreview(true) }}
        />
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

export function NotepadPanel({ nodeId, nodeKw, top, notes, onClose, onAddNote, onUpdateNote, onDeleteNote }: Props) {
  const panelRef  = useRef<HTMLDivElement>(null)
  const isDragging = useRef(false)
  const isResizing = useRef(false)
  const dragOrigin = useRef({ mouseX: 0, mouseY: 0, panelX: 0, panelY: 0 })
  const resizeOrigin = useRef({ mouseX: 0, mouseY: 0, w: 0, h: 0 })

  const [pos, setPos] = useState(() => ({
    x: Math.min(window.innerWidth - loadSize().w - 20, window.innerWidth - 320),
    y: Math.max(8, Math.min(top, window.innerHeight - 120)),
  }))
  const [size, setSize] = useState(loadSize)
  const [zoomedImg, setZoomedImg] = useState<string | null>(null)

  // ── Dragging (header) ────────────────────────────────────────
  const handleHeaderMouseDown = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return
    e.preventDefault()
    isDragging.current = true
    dragOrigin.current = { mouseX: e.clientX, mouseY: e.clientY, panelX: pos.x, panelY: pos.y }

    const onMove = (ev: MouseEvent) => {
      if (!isDragging.current) return
      setPos({
        x: Math.max(0, Math.min(window.innerWidth - size.w, dragOrigin.current.panelX + ev.clientX - dragOrigin.current.mouseX)),
        y: Math.max(0, Math.min(window.innerHeight - 60,    dragOrigin.current.panelY + ev.clientY - dragOrigin.current.mouseY)),
      })
    }
    const onUp = () => {
      isDragging.current = false
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [pos, size.w])

  // ── Resizing (bottom-right handle) ──────────────────────────
  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    isResizing.current = true
    resizeOrigin.current = { mouseX: e.clientX, mouseY: e.clientY, w: size.w, h: size.h }

    const onMove = (ev: MouseEvent) => {
      if (!isResizing.current) return
      const newW = Math.max(MIN_W, resizeOrigin.current.w + ev.clientX - resizeOrigin.current.mouseX)
      const newH = Math.max(MIN_H, resizeOrigin.current.h + ev.clientY - resizeOrigin.current.mouseY)
      setSize({ w: newW, h: newH })
    }
    const onUp = () => {
      isResizing.current = false
      setSize(s => { saveSize(s.w, s.h); return s })
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [size])

  // ── Add note ─────────────────────────────────────────────────
  const handleAdd = useCallback(async () => {
    const ann = await api.createAnnotation(nodeId, { type: 'note', note_body: '' })
    onAddNote(ann)
  }, [nodeId, onAddNote])

  // ── Click-outside to close ───────────────────────────────────
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (isDragging.current || isResizing.current) return
      if (zoomedImg) return   // image overlay is open
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose, zoomedImg])

  return (
    <>
      <div
        ref={panelRef}
        className="notepad-panel"
        style={{ left: pos.x, top: pos.y, right: 'auto', width: size.w, maxHeight: size.h }}
      >
        {/* Header — drag handle */}
        <div
          className="notepad-header"
          onMouseDown={handleHeaderMouseDown}
          style={{ cursor: isDragging.current ? 'grabbing' : 'grab' }}
        >
          <span>Notepad</span>
          <span style={{ color: 'var(--text-2)', fontWeight: 400, fontSize: 12, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginLeft: 8 }}>
            {nodeKw}
          </span>
          <button
            className="btn btn-sm"
            style={{ border: 'none', padding: '2px 6px', flexShrink: 0 }}
            onClick={onClose}
            aria-label="Close notepad"
          >✕</button>
        </div>

        {/* Notes */}
        <div className="notepad-body">
          {notes.map(ann => (
            <NoteCard
              key={ann.id}
              ann={ann}
              onUpdate={onUpdateNote}
              onDelete={() => onDeleteNote(ann.id)}
              onZoomImage={setZoomedImg}
            />
          ))}
          <button className="notepad-add-btn" onClick={handleAdd}>
            + Add note
          </button>
        </div>

        {/* Resize handle */}
        <div
          className="notepad-resize-handle"
          onMouseDown={handleResizeMouseDown}
          title="Drag to resize"
        />
      </div>

      {/* Image zoom overlay — rendered outside panel so it's not clipped */}
      {zoomedImg && createPortal(
        <div
          className="note-image-overlay"
          onClick={() => setZoomedImg(null)}
        >
          <img
            src={zoomedImg}
            style={{ maxWidth: '90vw', maxHeight: '90vh', borderRadius: 8, objectFit: 'contain' }}
            alt=""
          />
          <div style={{ position: 'absolute', top: 16, right: 20, color: '#fff', fontSize: 24, cursor: 'pointer', lineHeight: 1 }}>✕</div>
        </div>,
        document.body
      )}
    </>
  )
}
