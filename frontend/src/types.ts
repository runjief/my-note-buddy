export interface DocumentSummary {
  id: string
  title: string
  subtitle: string
  origin_document_id?: string | null
  origin_document_title?: string | null
}

export interface TreeNode {
  id: string
  section_id: string
  parent_id: string | null
  order: number
  kw: string
  say: string
  original_node_id?: string | null
  children: TreeNode[]
}

export interface Section {
  id: string
  document_id: string
  order: number
  title: string
  nodes: TreeNode[]
}

export interface DocumentFull extends DocumentSummary {
  footer: string
  sections: Section[]
}

export type AnnotationType = 'highlight' | 'crossout' | 'bookmark' | 'note'

export interface Annotation {
  id: string
  node_id: string
  type: AnnotationType
  range_start?: number
  range_end?: number
  color?: string
  selected_text?: string
  note_body?: string
  is_shadow?: boolean
  deleted_at?: string
  created_at: string
  updated_at: string
}

export type ShadowStatus = 'empty' | 'partial' | 'complete'

export interface ShadowNote {
  id: string
  node_id: string
  body: string
  status: ShadowStatus
  updated_at: string
}

export interface ShadowDocSummary {
  id: string
  title: string
  subtitle: string
  created_at: string
}

export interface UndoAction {
  description: string
  undo: () => Promise<void>
  redo: () => Promise<void>
}

export interface PendingSelection {
  nodeId: string
  start: number
  end: number
  text: string
  rect: DOMRect
  existingAnnId?: string
  isShadowContext?: boolean
}
