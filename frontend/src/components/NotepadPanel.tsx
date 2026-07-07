import React, { useState, useEffect, useRef, useCallback } from 'react'
import type { Annotation } from '../types'
import * as api from '../api'

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

// ── Image parsing ──────────────────────────────────────────────────────────────

function renderBodyWithImages(body: string) {
  const parts = body.split(/(!\[\]\([^)]+\))/g)
  return parts.map((part, i) => {
    const m = part.match(/^!\[\]\(([^)]+)\)$/)
    if (m) return <NoteImage key={i} url={m[1]} />
    return part ? <span key={i} style={{ whiteSpace: 'pre-wrap' }}>{part}</span> : null
  })
}

function NoteImage({ url }: { url: string }) {
  const [enlarged, setEnlarged] = useState(false)
  return (
    <>
      <img
        src={url}
        className="note-image"
        onClick={() => setEnlarged(true)}
        alt=""
        title="Click to enlarge"
      />
      {enlarged && (
        <div className="note-image-overlay" onClick={() => setEnlarged(false)}>
          <img src={url} style={{ maxWidth: '90vw', maxHeight: '90vh', borderRadius: 8, objectFit: 'contain' }} alt="" />
        </div>
      )}
    </>
  )
}

// ── Note card ──────────────────────────────────────────────────────────────────

interface NoteCardProps {
  ann: Annotation
  onUpdate: (ann: Annotation) => void
  onDelete: () => void
}

function NoteCard({ ann, onUpdate, onDelete }: NoteCardProps) {
  const [body, setBody] = useState(ann.note_body ?? '')
  const [preview, setPreview] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [r2Available, setR2Available] = useState<boolean | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
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
    // restore cursor after insertion
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
          onClick={() => setPreview(false)}
          title="Edit mode"
        >Edit</button>
        {hasImages && (
          <button
            className={`btn btn-sm ${preview ? 'active' : ''}`}
            onClick={() => setPreview(true)}
            title="Preview with images"
          >Preview</button>
        )}
        {r2Available && (
          <button
            className="btn btn-sm"
            onClick={() => fileRef.current?.click()}
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
        <div className="note-preview" onClick={() => setPreview(false)} title="Click to edit">
          {renderBodyWithImages(body)}
          {!body && <span style={{ color: 'var(--text-3)', fontStyle: 'italic' }}>Empty</span>}
        </div>
      ) : (
        <textarea
          ref={textareaRef}
          value={body}
          onChange={e => handleChange(e.target.value)}
          placeholder="Write a note… (paste image URL as ![](url))"
        />
      )}

      <div className="note-card-actions">
        <button className="btn btn-sm btn-danger" onClick={onDelete}>Delete</button>
      </div>
    </div>
  )
}

// ── Panel ──────────────────────────────────────────────────────────────────────

export function NotepadPanel({ nodeId, nodeKw, top, notes, onClose, onAddNote, onUpdateNote, onDeleteNote }: Props) {
  const panelRef = useRef<HTMLDivElement>(null)
  const isDragging = useRef(false)
  const dragOrigin = useRef({ mouseX: 0, mouseY: 0, panelX: 0, panelY: 0 })

  const [pos, setPos] = useState(() => ({
    x: window.innerWidth - 320,
    y: Math.max(8, Math.min(top, window.innerHeight - 120)),
  }))

  const handleHeaderMouseDown = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return
    e.preventDefault()
    isDragging.current = true
    dragOrigin.current = { mouseX: e.clientX, mouseY: e.clientY, panelX: pos.x, panelY: pos.y }

    const onMove = (ev: MouseEvent) => {
      if (!isDragging.current) return
      const dx = ev.clientX - dragOrigin.current.mouseX
      const dy = ev.clientY - dragOrigin.current.mouseY
      setPos({
        x: Math.max(0, Math.min(window.innerWidth - 280, dragOrigin.current.panelX + dx)),
        y: Math.max(0, Math.min(window.innerHeight - 60, dragOrigin.current.panelY + dy)),
      })
    }

    const onUp = () => {
      isDragging.current = false
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [pos])

  const handleAdd = useCallback(async () => {
    const ann = await api.createAnnotation(nodeId, { type: 'note', note_body: '' })
    onAddNote(ann)
  }, [nodeId, onAddNote])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (isDragging.current) return
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        // Don't close if clicking an image overlay
        const target = e.target as HTMLElement
        if (target.closest('.note-image-overlay')) return
        onClose()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  return (
    <div
      ref={panelRef}
      className="notepad-panel"
      style={{ left: pos.x, top: pos.y, right: 'auto' }}
    >
      <div
        className="notepad-header"
        onMouseDown={handleHeaderMouseDown}
        style={{ cursor: 'grab' }}
      >
        <span>Notepad</span>
        <span style={{ color: 'var(--text-2)', fontWeight: 400, fontSize: 12, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {nodeKw}
        </span>
        <button
          className="btn btn-sm"
          style={{ border: 'none', padding: '2px 6px' }}
          onClick={onClose}
          aria-label="Close notepad"
        >
          ✕
        </button>
      </div>
      <div className="notepad-body">
        {notes.map(ann => (
          <NoteCard
            key={ann.id}
            ann={ann}
            onUpdate={onUpdateNote}
            onDelete={() => onDeleteNote(ann.id)}
          />
        ))}
        <button className="notepad-add-btn" onClick={handleAdd}>
          + Add note
        </button>
      </div>
    </div>
  )
}
