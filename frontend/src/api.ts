import type { DocumentSummary, DocumentFull, Annotation, ShadowNote, ShadowDocSummary } from './types'

const BASE = '/api'

async function req<T>(path: string, options?: RequestInit): Promise<T> {
  const r = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  if (!r.ok) throw new Error(`API ${r.status}: ${path}`)
  return r.json()
}

// Documents
export const listDocuments = () => req<DocumentSummary[]>('/documents')
export const getDocument = (id: string) => req<DocumentFull>(`/documents/${id}`)
export const deleteDocument = (id: string) => req(`/documents/${id}`, { method: 'DELETE' })
export const renameDocument = (id: string, title: string) =>
  req<{ id: string; title: string }>(`/documents/${id}/rename`, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  })

// Nodes
export const patchNode = (id: string, kw?: string, say?: string) =>
  req<{ id: string; kw: string; say: string; history_id: string }>(`/nodes/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ kw, say }),
  })
export const getNodeHistory = (id: string) =>
  req<Array<{ id: string; kw: string; say: string; created_at: string }>>(`/nodes/${id}/history`)
export const restoreNode = (nodeId: string, historyId: string) =>
  req<{ id: string; kw: string; say: string }>(`/nodes/${nodeId}/history/${historyId}/restore`, {
    method: 'POST',
  })

// Annotations
export const getAnnotations = (docId: string) =>
  req<Annotation[]>(`/documents/${docId}/annotations`)
export const createAnnotation = (
  nodeId: string,
  body: {
    type: string
    range_start?: number
    range_end?: number
    color?: string
    selected_text?: string
    note_body?: string
    is_shadow?: boolean
  }
) => req<Annotation>(`/nodes/${nodeId}/annotations`, { method: 'POST', body: JSON.stringify(body) })
export const patchAnnotation = (id: string, body: { note_body?: string; color?: string; type?: string }) =>
  req<Annotation>(`/annotations/${id}`, { method: 'PATCH', body: JSON.stringify(body) })
export const deleteAnnotation = (id: string) =>
  req<{ id: string }>(`/annotations/${id}`, { method: 'DELETE' })
export const restoreAnnotation = (id: string) =>
  req<Annotation>(`/annotations/${id}/restore`, { method: 'POST' })

// Shadow notes
export const getShadowNotes = (docId: string) =>
  req<ShadowNote[]>(`/documents/${docId}/shadow-notes`)
export const upsertShadowNote = (nodeId: string, body: string, status: string) =>
  req<ShadowNote>(`/nodes/${nodeId}/shadow-note`, {
    method: 'PUT',
    body: JSON.stringify({ body, status }),
  })
export const clearShadowNotes = (docId: string) =>
  req<{ ok: boolean }>(`/documents/${docId}/shadow-notes`, { method: 'DELETE' })

// Shadow documents
export const getShadowDocs = (docId: string) =>
  req<ShadowDocSummary[]>(`/documents/${docId}/shadow-docs`)
export const createShadowDoc = (docId: string) =>
  req<{ id: string; title: string }>(`/documents/${docId}/create-shadow-doc`, { method: 'POST' })
export const loadShadowDoc = (docId: string, shadowDocId: string) =>
  req<ShadowNote[]>(`/documents/${docId}/load-shadow/${shadowDocId}`, { method: 'POST' })

// Import (used by paste/file import)
export const importDocument = (payload: object) =>
  req<{ id: string; title: string }>('/documents/import', {
    method: 'POST',
    body: JSON.stringify(payload),
  })

// Image upload (Cloudflare R2)
export const r2Status = () => req<{ configured: boolean }>('/r2-status')
export async function uploadImage(file: File): Promise<{ url: string }> {
  const form = new FormData()
  form.append('file', file)
  const r = await fetch(`${BASE}/upload/image`, { method: 'POST', body: form })
  if (!r.ok) throw new Error(`Upload failed: ${r.status}`)
  return r.json()
}
