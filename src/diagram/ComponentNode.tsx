// Component 노드 — 이름 = 파일명. commit → vault rename.
// PR-1: zoom-density excerpt — zoom >= 1.0 시 본문 발췌 표시.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Handle, Position, useStore, type Node, type NodeProps, type ReactFlowState } from '@xyflow/react';

export interface ComponentNodeData extends Record<string, unknown> {
  name: string;
  editing: boolean;
  bodyExcerpt?: string;
  freshness?: number;
  onCommitName: (next: string) => void;
  onCancelName: () => void;
}

// xyflow v12: NodeProps now takes the full Node type.
export type ComponentNodeType = Node<ComponentNodeData, 'component'>;

export function ComponentNode({ data, selected }: NodeProps<ComponentNodeType>) {
  const { editing, name, bodyExcerpt, freshness, onCommitName, onCancelName } = data;
  const zoom = useStore((s: ReactFlowState) => s.transform[2]);
  const showBody = zoom >= 1.0 && !!bodyExcerpt;
  const bodyLines = zoom >= 1.5 ? 4 : 2;
  const [value, setValue] = useState(name);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { setValue(name); }, [name]);

  useEffect(() => {
    if (!editing) return;
    let cancelled = false;
    let tries = 0;
    const attempt = () => {
      if (cancelled) return;
      const el = taRef.current;
      if (!el || !el.isConnected) return;
      el.focus({ preventScroll: true });
      if (activeDocument.activeElement === el) {
        el.select();
        return;
      }
      if (tries++ < 8) window.setTimeout(attempt, 30);
    };
    const t = window.setTimeout(attempt, 30);
    return () => { cancelled = true; window.clearTimeout(t); };
  }, [editing]);

  useLayoutEffect(() => {
    if (!editing || !taRef.current) return;
    const el = taRef.current;
    // Dynamic auto-resize: must read scrollHeight after reset, so values are
    // computed per-render and CSS classes can't replace this.
    /* eslint-disable obsidianmd/no-static-styles-assignment -- dynamic textarea auto-resize */
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
    /* eslint-enable obsidianmd/no-static-styles-assignment */
  }, [value, editing]);

  const commit = () => onCommitName(value);
  const cancel = () => { setValue(name); onCancelName(); };

  return (
    <div
      className={`cn ${selected ? 'cn-selected' : ''} ${editing ? 'cn-editing' : ''}`}
      style={freshness && freshness > 0 ? { ['--m-freshness' as never]: freshness.toFixed(3) } : undefined}
    >
      <Handle id="l" type="source" position={Position.Left} className="cn-handle" />
      <Handle id="r" type="source" position={Position.Right} className="cn-handle" />
      <Handle id="t" type="source" position={Position.Top} className="cn-handle" />
      <Handle id="b" type="source" position={Position.Bottom} className="cn-handle" />

      {editing ? (
        <textarea
          ref={taRef}
          className="cn-input nodrag nopan"
          value={value}
          placeholder="…"
          rows={1}
          onChange={(e) => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(); return; }
            if (e.key === 'Escape') { e.preventDefault(); cancel(); }
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="cn-name">{name || '…'}</span>
      )}
      {showBody && (
        <div
          className="cn-body-excerpt"
          style={{ WebkitLineClamp: bodyLines }}
        >
          {bodyExcerpt}
        </div>
      )}
    </div>
  );
}
