// Component 노드 — 이름 = 파일명. commit → vault rename.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Handle, Position, type NodeProps } from 'reactflow';

export interface ComponentNodeData {
  name: string;
  editing: boolean;
  onCommitName: (next: string) => void;
  onCancelName: () => void;
}

export function ComponentNode({ data, selected }: NodeProps<ComponentNodeData>) {
  const { editing, name, onCommitName, onCancelName } = data;
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
    <div className={`cn ${selected ? 'cn-selected' : ''} ${editing ? 'cn-editing' : ''}`}>
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
    </div>
  );
}
