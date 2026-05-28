// Module 노드 — 마인드맵 톤. 이름 = 파일명. commit 시 vault rename, blur 시 commit, Esc 시 취소.
// lab 학습: focus retry, transform: scale 금지(CSS).

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';

export interface ModuleNodeData extends Record<string, unknown> {
  name: string;
  tags: string[];
  editing: boolean;
  onCommitName: (next: string) => void;
  onCancelName: () => void;
}

// xyflow v12: NodeProps now takes the full Node type (not just the data).
export type ModuleNodeType = Node<ModuleNodeData, 'module'>;

export function ModuleNode({ data, selected }: NodeProps<ModuleNodeType>) {
  const { editing, name, tags, onCommitName, onCancelName } = data;
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
    <div className={`mn ${selected ? 'mn-selected' : ''} ${editing ? 'mn-editing' : ''}`}>
      <Handle id="l" type="source" position={Position.Left} className="mn-handle" />
      <Handle id="r" type="source" position={Position.Right} className="mn-handle" />
      <Handle id="t" type="source" position={Position.Top} className="mn-handle" />
      <Handle id="b" type="source" position={Position.Bottom} className="mn-handle" />

      <span className="mn-stripe" />
      <div className="mn-body">
        {editing ? (
          <textarea
            ref={taRef}
            className="mn-name-input nodrag nopan"
            value={value}
            placeholder="모듈 이름"
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
          <span className="mn-name">{name || '제목 없음'}</span>
        )}
        {tags.length > 0 && (
          <div className="mn-tags">
            {tags.map((t: string) => (
              <span key={t} className="mn-tag">{t}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
