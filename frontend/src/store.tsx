import React, { createContext, useContext, useReducer, useCallback, useRef } from 'react'
import type { Annotation, ShadowNote, UndoAction, PendingSelection } from './types'

// ── Undo stack ───────────────────────────────────────────────────────────────

const MAX_UNDO = 50

interface UndoState {
  stack: UndoAction[]
  cursor: number  // points at last executed action (stack[cursor] = last done)
  lastAction: UndoAction | null
}

// ── App store ─────────────────────────────────────────────────────────────────

export interface AppState {
  // annotations keyed by node_id for O(1) lookup
  annotationsByNode: Record<string, Annotation[]>
  // shadow notes keyed by node_id
  shadowByNode: Record<string, ShadowNote>
  // tree open/visible state
  openNodes: Set<string>
  visibleNodes: Set<string>
  seenNodes: Set<string>
  // UI
  shadowMode: boolean
  syncScroll: boolean
  collectionsOpen: boolean
  notepadNodeId: string | null   // which node has notepad open
  notepadTop: number
  searchOpen: boolean
  pendingSelection: PendingSelection | null
  // undo
  undoStack: UndoAction[]
  lastUndo: string | null  // description of last undoable action (shown in toast)
}

type Action =
  | { type: 'SET_ANNOTATIONS'; nodeId: string; anns: Annotation[] }
  | { type: 'ADD_ANNOTATION'; ann: Annotation }
  | { type: 'UPDATE_ANNOTATION'; ann: Annotation }
  | { type: 'REMOVE_ANNOTATION'; annId: string; nodeId: string }
  | { type: 'RESTORE_ANNOTATION'; ann: Annotation }
  | { type: 'SET_ALL_ANNOTATIONS'; anns: Annotation[] }
  | { type: 'MERGE_ANNOTATIONS'; anns: Annotation[] }
  | { type: 'SET_SHADOW'; nodeId: string; note: ShadowNote }
  | { type: 'SET_ALL_SHADOWS'; notes: ShadowNote[] }
  | { type: 'TOGGLE_OPEN'; nodeId: string; siblingId?: string; firstChildId?: string }
  | { type: 'EXPAND_ALL'; allIds: string[] }
  | { type: 'SHOW_SKELETON'; allIds: string[] }
  | { type: 'RESET'; firstSiblings: string[] }
  | { type: 'FORCE_REVEAL'; nodeIds: string[] }
  | { type: 'MERGE_REVEAL_ALL'; allIds: string[] }
  | { type: 'TOGGLE_SHADOW_MODE' }
  | { type: 'SET_SHADOW_MODE'; active: boolean }
  | { type: 'TOGGLE_SYNC_SCROLL' }
  | { type: 'TOGGLE_COLLECTIONS' }
  | { type: 'SET_NOTEPAD'; nodeId: string | null; top?: number }
  | { type: 'TOGGLE_SEARCH' }
  | { type: 'SET_SELECTION'; sel: PendingSelection | null }
  | { type: 'PUSH_UNDO'; action: UndoAction }
  | { type: 'POP_UNDO' }
  | { type: 'CLEAR_UNDO_TOAST' }

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'SET_ANNOTATIONS': {
      return {
        ...state,
        annotationsByNode: { ...state.annotationsByNode, [action.nodeId]: action.anns },
      }
    }
    case 'SET_ALL_ANNOTATIONS': {
      const byNode: Record<string, Annotation[]> = {}
      for (const ann of action.anns) {
        if (!byNode[ann.node_id]) byNode[ann.node_id] = []
        byNode[ann.node_id].push(ann)
      }
      return { ...state, annotationsByNode: byNode }
    }
    case 'ADD_ANNOTATION': {
      const existing = state.annotationsByNode[action.ann.node_id] ?? []
      return {
        ...state,
        annotationsByNode: {
          ...state.annotationsByNode,
          [action.ann.node_id]: [...existing, action.ann],
        },
      }
    }
    case 'UPDATE_ANNOTATION': {
      const existing = state.annotationsByNode[action.ann.node_id] ?? []
      return {
        ...state,
        annotationsByNode: {
          ...state.annotationsByNode,
          [action.ann.node_id]: existing.map(a => a.id === action.ann.id ? action.ann : a),
        },
      }
    }
    case 'REMOVE_ANNOTATION': {
      const existing = state.annotationsByNode[action.nodeId] ?? []
      return {
        ...state,
        annotationsByNode: {
          ...state.annotationsByNode,
          [action.nodeId]: existing.filter(a => a.id !== action.annId),
        },
      }
    }
    case 'RESTORE_ANNOTATION': {
      const existing = state.annotationsByNode[action.ann.node_id] ?? []
      // add back if not already present
      const has = existing.some(a => a.id === action.ann.id)
      return {
        ...state,
        annotationsByNode: {
          ...state.annotationsByNode,
          [action.ann.node_id]: has
            ? existing.map(a => a.id === action.ann.id ? action.ann : a)
            : [...existing, action.ann],
        },
      }
    }
    case 'SET_SHADOW': {
      return { ...state, shadowByNode: { ...state.shadowByNode, [action.nodeId]: action.note } }
    }
    case 'SET_ALL_SHADOWS': {
      const byNode: Record<string, ShadowNote> = {}
      for (const n of action.notes) byNode[n.node_id] = n
      return { ...state, shadowByNode: byNode }
    }
    case 'TOGGLE_OPEN': {
      const isOpen = state.openNodes.has(action.nodeId)
      const isSeen = state.seenNodes.has(action.nodeId)
      const open = new Set(state.openNodes)
      const visible = new Set(state.visibleNodes)
      const seen = new Set(state.seenNodes)

      if (!isSeen) {
        seen.add(action.nodeId)
        if (action.siblingId) visible.add(action.siblingId)
        if (action.firstChildId) visible.add(action.firstChildId)
      }
      isOpen ? open.delete(action.nodeId) : open.add(action.nodeId)
      return { ...state, openNodes: open, visibleNodes: visible, seenNodes: seen }
    }
    case 'EXPAND_ALL': {
      return {
        ...state,
        openNodes: new Set(action.allIds),
        visibleNodes: new Set(action.allIds),
        seenNodes: new Set(action.allIds),
      }
    }
    case 'SHOW_SKELETON': {
      return {
        ...state,
        openNodes: new Set(),
        visibleNodes: new Set(action.allIds),
        seenNodes: new Set(action.allIds),
      }
    }
    case 'RESET': {
      return {
        ...state,
        openNodes: new Set(),
        visibleNodes: new Set(action.firstSiblings),
        seenNodes: new Set(),
      }
    }
    case 'FORCE_REVEAL': {
      const visible = new Set(state.visibleNodes)
      const seen = new Set(state.seenNodes)
      const open = new Set(state.openNodes)
      for (const id of action.nodeIds) {
        visible.add(id)
        seen.add(id)
        open.add(id)
      }
      return { ...state, visibleNodes: visible, seenNodes: seen, openNodes: open }
    }
    case 'MERGE_REVEAL_ALL': {
      const visible = new Set([...state.visibleNodes, ...action.allIds])
      const seen    = new Set([...state.seenNodes,    ...action.allIds])
      const open    = new Set([...state.openNodes,    ...action.allIds])
      return { ...state, visibleNodes: visible, seenNodes: seen, openNodes: open }
    }
    case 'MERGE_ANNOTATIONS': {
      const byNode = { ...state.annotationsByNode }
      for (const ann of action.anns) {
        const existing = byNode[ann.node_id] ?? []
        if (!existing.some(a => a.id === ann.id)) {
          byNode[ann.node_id] = [...existing, ann]
        }
      }
      return { ...state, annotationsByNode: byNode }
    }
    case 'TOGGLE_SHADOW_MODE':
      return { ...state, shadowMode: !state.shadowMode }
    case 'SET_SHADOW_MODE':
      return { ...state, shadowMode: action.active }
    case 'TOGGLE_SYNC_SCROLL':
      return { ...state, syncScroll: !state.syncScroll }
    case 'TOGGLE_COLLECTIONS':
      return { ...state, collectionsOpen: !state.collectionsOpen }
    case 'SET_NOTEPAD':
      return {
        ...state,
        notepadNodeId: action.nodeId,
        notepadTop: action.top ?? state.notepadTop,
      }
    case 'TOGGLE_SEARCH':
      return { ...state, searchOpen: !state.searchOpen }
    case 'SET_SELECTION':
      return { ...state, pendingSelection: action.sel }
    case 'PUSH_UNDO': {
      const stack = [...state.undoStack.slice(-MAX_UNDO + 1), action.action]
      return { ...state, undoStack: stack, lastUndo: action.action.description }
    }
    case 'POP_UNDO': {
      const stack = [...state.undoStack]
      stack.pop()
      return { ...state, undoStack: stack, lastUndo: null }
    }
    case 'CLEAR_UNDO_TOAST':
      return { ...state, lastUndo: null }
    default:
      return state
  }
}

function makeInitialState(firstSiblings: string[] = []): AppState {
  return {
    annotationsByNode: {},
    shadowByNode: {},
    openNodes: new Set(),
    visibleNodes: new Set(firstSiblings),
    seenNodes: new Set(),
    shadowMode: false,
    syncScroll: true,
    collectionsOpen: false,
    notepadNodeId: null,
    notepadTop: 120,
    searchOpen: false,
    pendingSelection: null,
    undoStack: [],
    lastUndo: null,
  }
}

// ── Context ───────────────────────────────────────────────────────────────────

interface StoreCtx {
  state: AppState
  dispatch: React.Dispatch<Action>
}

const StoreContext = createContext<StoreCtx | null>(null)

export function StoreProvider({
  children,
  firstSiblings,
}: {
  children: React.ReactNode
  firstSiblings: string[]
}) {
  const [state, dispatch] = useReducer(reducer, undefined, () =>
    makeInitialState(firstSiblings)
  )
  return (
    <StoreContext.Provider value={{ state, dispatch }}>
      {children}
    </StoreContext.Provider>
  )
}

export function useStore() {
  const ctx = useContext(StoreContext)
  if (!ctx) throw new Error('useStore outside StoreProvider')
  return ctx
}
