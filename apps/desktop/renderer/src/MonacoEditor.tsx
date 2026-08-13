import { useEffect, useRef, useState } from 'react';
import * as monaco from 'monaco-editor/editor/editor.api';

import type { TextSelection } from './workspaceState';
import { makeTextSelection } from './workspaceState';

interface TextEditorProps {
  ariaLabel: string;
  uri: string;
  value: string;
  readOnly: boolean;
  onChange?: (value: string) => void;
  onSelection?: (selection: TextSelection | null) => void;
  onSave?: () => void;
  focusToken?: number;
  tabFocusMode?: boolean;
  commentAnchors?: ReadonlyArray<{ id: string; start: number; end: number }>;
  revealRequest?: { token: number; start: number; end: number } | null;
}

const editorOptions: monaco.editor.IStandaloneEditorConstructionOptions = {
  automaticLayout: false,
  fontFamily: "'Cascadia Mono', Consolas, monospace",
  fontSize: 14,
  lineHeight: 23,
  minimap: { enabled: false },
  overviewRulerLanes: 0,
  padding: { top: 14, bottom: 14 },
  renderLineHighlight: 'line',
  scrollBeyondLastLine: false,
  wordWrap: 'on',
  wrappingIndent: 'same',
  accessibilitySupport: 'auto',
};

export const MonacoTextEditor = ({
  ariaLabel,
  uri,
  value,
  readOnly,
  onChange,
  onSelection,
  onSave,
  focusToken,
  tabFocusMode = false,
  commentAnchors = [],
  revealRequest = null,
}: TextEditorProps): React.JSX.Element => {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelRef = useRef<monaco.editor.ITextModel | null>(null);
  const decorationsRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const callbacks = useRef({ onChange, onSelection, onSave });
  const initialValue = useRef(value);
  const initialReadOnly = useRef(readOnly);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    callbacks.current = { onChange, onSelection, onSave };
  }, [onChange, onSave, onSelection]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !window.MonacoEnvironment) {
      setStatus('error');
      return;
    }
    const model = monaco.editor.createModel(
      initialValue.current,
      'markdown',
      monaco.Uri.parse(uri),
    );
    const editor = monaco.editor.create(container, {
      ...editorOptions,
      model,
      readOnly: initialReadOnly.current,
      ariaLabel,
    });
    editorRef.current = editor;
    modelRef.current = model;
    decorationsRef.current = editor.createDecorationsCollection();
    const change = model.onDidChangeContent(() => callbacks.current.onChange?.(model.getValue()));
    const selection = editor.onDidChangeCursorSelection(({ selection: range }) => {
      const start = model.getOffsetAt(range.getStartPosition());
      const end = model.getOffsetAt(range.getEndPosition());
      callbacks.current.onSelection?.(makeTextSelection(model.getValue(), start, end));
    });
    const saveAction = editor.addAction({
      id: 'news-writer.save-current-document',
      label: '保存当前文档',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => {
        callbacks.current.onSave?.();
      },
    });
    const observer = new ResizeObserver(() => editor.layout());
    observer.observe(container);
    setStatus('ready');
    return () => {
      callbacks.current.onSelection?.(null);
      observer.disconnect();
      change.dispose();
      selection.dispose();
      saveAction.dispose();
      decorationsRef.current?.clear();
      decorationsRef.current = null;
      editor.dispose();
      model.dispose();
      editorRef.current = null;
      modelRef.current = null;
    };
  }, [ariaLabel, uri]);

  useEffect(() => {
    const model = modelRef.current;
    if (model && model.getValue() !== value) model.setValue(value);
  }, [value]);

  useEffect(() => editorRef.current?.updateOptions({ readOnly }), [readOnly]);
  useEffect(() => editorRef.current?.updateOptions({ tabFocusMode }), [tabFocusMode]);
  useEffect(() => {
    const model = modelRef.current;
    const decorations = decorationsRef.current;
    if (!model || !decorations) return;
    decorations.set(
      commentAnchors.map((anchor) => ({
        range: monaco.Range.fromPositions(
          model.getPositionAt(anchor.start),
          model.getPositionAt(anchor.end),
        ),
        options: {
          className: 'comment-anchor-decoration',
          hoverMessage: { value: '此处有批注' },
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      })),
    );
  }, [commentAnchors]);
  useEffect(() => {
    const editor = editorRef.current;
    const model = modelRef.current;
    if (!editor || !model || !revealRequest) return;
    const range = monaco.Range.fromPositions(
      model.getPositionAt(revealRequest.start),
      model.getPositionAt(revealRequest.end),
    );
    editor.setSelection(range);
    editor.revealRangeInCenter(range, monaco.editor.ScrollType.Smooth);
    editor.focus();
  }, [revealRequest]);
  useEffect(() => {
    if (focusToken) editorRef.current?.focus();
  }, [focusToken]);

  return (
    <div
      ref={containerRef}
      className="monaco-surface"
      data-monaco-status={status}
      data-testid={`monaco-${ariaLabel}`}
    />
  );
};

interface DiffEditorProps {
  original: string;
  modified: string;
  sessionId: string;
  originalId: string;
  modifiedId: string;
  focusToken?: number;
  tabFocusMode?: boolean;
}

export const MonacoDiffEditor = ({
  original,
  modified,
  sessionId,
  originalId,
  modifiedId,
  focusToken,
  tabFocusMode = false,
}: DiffEditorProps): React.JSX.Element => {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !window.MonacoEnvironment) {
      setStatus('error');
      return;
    }
    const originalModel = monaco.editor.createModel(
      original,
      'markdown',
      monaco.Uri.parse(
        `inmemory://news-writer/session/${sessionId}/version/${originalId}/original`,
      ),
    );
    const modifiedModel = monaco.editor.createModel(
      modified,
      'markdown',
      monaco.Uri.parse(
        `inmemory://news-writer/session/${sessionId}/version/${modifiedId}/modified`,
      ),
    );
    const editor = monaco.editor.createDiffEditor(container, {
      ...editorOptions,
      readOnly: true,
      originalEditable: false,
      renderSideBySide: true,
      ariaLabel: '历史版本与当前最新版差异',
    });
    editor.setModel({ original: originalModel, modified: modifiedModel });
    editorRef.current = editor;
    const observer = new ResizeObserver(() => editor.layout());
    observer.observe(container);
    setStatus('ready');
    return () => {
      observer.disconnect();
      editor.dispose();
      originalModel.dispose();
      modifiedModel.dispose();
      editorRef.current = null;
    };
  }, [modified, modifiedId, original, originalId, sessionId]);

  useEffect(() => {
    if (focusToken) editorRef.current?.focus();
  }, [focusToken]);
  useEffect(() => editorRef.current?.updateOptions({ tabFocusMode }), [tabFocusMode]);

  return <div ref={containerRef} className="monaco-surface" data-monaco-status={status} />;
};
