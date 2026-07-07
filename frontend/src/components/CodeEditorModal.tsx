import React, { useRef, useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import Editor from '@monaco-editor/react'
import type { editor as MonacoEditor } from 'monaco-editor'
import { X, WrapText } from 'lucide-react'

const LS_LANG_KEY = 'notepad-default-lang'

const LANGUAGES = [
  'javascript', 'typescript', 'tsx', 'jsx',
  'python', 'rust', 'go', 'java', 'cpp', 'c',
  'css', 'html', 'json', 'yaml', 'bash', 'sh',
  'sql', 'markdown', 'plaintext',
]

function loadDefaultLang(): string {
  try { return localStorage.getItem(LS_LANG_KEY) ?? 'javascript' } catch { return 'javascript' }
}
function saveDefaultLang(lang: string) {
  try { localStorage.setItem(LS_LANG_KEY, lang) } catch {}
}

interface Props {
  initialCode: string
  initialLang: string
  readOnly?: boolean
  onSave?: (code: string, lang: string) => void
  onClose: () => void
}

export function CodeEditorModal({ initialCode, initialLang, readOnly = false, onSave, onClose }: Props) {
  const [code, setCode] = useState(initialCode)
  const [lang, setLang] = useState(() => initialLang || loadDefaultLang())
  const [formatting, setFormatting] = useState(false)
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null)

  // Sync lang changes to localStorage
  useEffect(() => {
    if (!readOnly) saveDefaultLang(lang)
  }, [lang, readOnly])

  const handleFormat = async () => {
    const ed = editorRef.current
    if (!ed || formatting) return
    setFormatting(true)
    try {
      const action = ed.getAction('editor.action.formatDocument')
      if (action) {
        await action.run()
      }
    } catch {}
    setFormatting(false)
  }

  const handleSave = () => {
    onSave?.(code, lang)
    onClose()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose()
    if ((e.metaKey || e.ctrlKey) && e.key === 's' && !readOnly) {
      e.preventDefault()
      handleSave()
    }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'f' && !readOnly) {
      e.preventDefault()
      handleFormat()
    }
  }

  return createPortal(
    <div className="code-modal-overlay" onMouseDown={onClose} onKeyDown={handleKeyDown}>
      <div className="code-modal" onMouseDown={e => e.stopPropagation()}>
        <div className="code-modal-header">
          {!readOnly ? (
            <select
              className="code-lang-select"
              value={lang}
              onChange={e => setLang(e.target.value)}
            >
              {LANGUAGES.map(l => <option key={l} value={l}>{l}</option>)}
            </select>
          ) : (
            <span className="code-lang-badge">{lang || 'code'}</span>
          )}
          <div style={{ flex: 1 }} />
          {!readOnly && (
            <button
              className="code-modal-btn"
              onClick={handleFormat}
              disabled={formatting}
              title="Format code (Ctrl+Shift+F)"
            >
              <WrapText size={13} />
              <span>{formatting ? 'Formatting…' : 'Format'}</span>
            </button>
          )}
          {!readOnly && onSave && (
            <button className="code-modal-btn code-modal-btn-primary" onClick={handleSave} title="Save (Ctrl+S)">
              Save
            </button>
          )}
          <button className="code-modal-btn" onClick={onClose} title="Close (Esc)">
            <X size={14} />
          </button>
        </div>
        <div className="code-modal-body">
          <Editor
            height="100%"
            language={lang}
            value={code}
            onChange={v => { if (!readOnly) setCode(v ?? '') }}
            onMount={ed => {
              editorRef.current = ed
              ed.focus()
            }}
            theme="vs-dark"
            options={{
              readOnly,
              minimap: { enabled: false },
              fontSize: 14,
              lineNumbers: 'on',
              scrollBeyondLastLine: false,
              automaticLayout: true,
              tabSize: 2,
              wordWrap: 'on',
              padding: { top: 12, bottom: 12 },
              renderLineHighlight: 'line',
              cursorBlinking: 'smooth',
              fontFamily: "'Fira Code', 'Consolas', monospace",
              fontLigatures: true,
            }}
          />
        </div>
      </div>
    </div>,
    document.body
  )
}
