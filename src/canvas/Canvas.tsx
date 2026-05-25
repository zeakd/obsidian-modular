// Canvas — vault-backed 마인드맵.
// 새 entity 생성 흐름:
//   1. 빈 캔버스 더블클릭 → in-memory pending 카드 (vault 호출 X)
//   2. 사용자가 이름 입력 + Enter / blur → store.createModule(name, position)
//   3. 이름이 비어 있거나 Esc → pending 사라짐, 파일 안 생김
// 기존 entity 의 이름 편집 (노드 더블클릭) 은 vault.fileManager.renameFile.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import ReactFlow, {
  Background,
  BackgroundVariant,
  ReactFlowProvider,
  useReactFlow,
  useStore,
  applyNodeChanges,
  applyEdgeChanges,
  ConnectionMode,
  type Node,
  type Edge,
  type Connection,
  type NodeChange,
  type EdgeChange,
  type NodeMouseHandler,
  type ReactFlowState,
} from 'reactflow';

import { Notice } from 'obsidian';
import type { VaultStore } from '../data/vault-store';
import { ModuleNode, type ModuleNodeData } from '../diagram/ModuleNode';
import { ComponentNode, type ComponentNodeData } from '../diagram/ComponentNode';
import { FloatingEdge } from '../diagram/FloatingEdge';

const nodeTypes = { module: ModuleNode, component: ComponentNode };
const edgeTypes = { floating: FloatingEdge };

const GRID = 16;
const ZOOM_REVEAL = 0.7;
const MODULE_W_EST = 260;
const COMPONENT_GAP_X = 32;
const COMPONENT_GAP_Y = 56;
const PENDING_ID = '__pending__';

type Pending =
  | { kind: 'module'; position: { x: number; y: number } }
  | { kind: 'component'; parentPath: string; position: { x: number; y: number } };

interface CanvasProps {
  store: VaultStore;
}

function CanvasInner({ store }: CanvasProps) {
  const w = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const rf = useReactFlow();
  const rootRef = useRef<HTMLDivElement>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const zoom = useStore((s: ReactFlowState) => s.transform[2]);

  // 기존 entity 의 이름 commit → vault rename.
  const onCommitRename = useCallback((path: string, next: string) => {
    const trimmed = next.trim();
    if (!trimmed) { setEditingId(null); return; }
    void store.renameEntity(path, trimmed).then(() => setEditingId(null));
  }, [store]);
  const onCancelRename = useCallback(() => setEditingId(null), []);

  // pending(ghost) 의 commit/cancel.
  const onPendingCommit = useCallback((next: string) => {
    const p = pending;
    if (!p) return;
    const trimmed = next.trim();
    if (!trimmed) { setPending(null); return; }
    const promise = p.kind === 'module'
      ? store.createModule(trimmed, p.position)
      : store.createChildComponent(p.parentPath, trimmed, p.position);
    promise
      .then((path) => { setPending(null); setSelectedId(path); })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        new Notice(`Modular: cannot create — ${msg}`, 4000);
        // pending 유지 — 사용자가 다른 이름 시도 가능
      });
  }, [pending, store]);
  const onPendingCancel = useCallback(() => setPending(null), []);

  // 선택된 entity 의 path (module 또는 component). Tab 시 이 entity 의 자식 component 추가.
  const selectedEntityPath = useMemo(() => {
    if (!selectedId || selectedId === PENDING_ID) return null;
    if (w.modules.some((m) => m.path === selectedId)) return selectedId;
    if (w.components.some((c) => c.path === selectedId)) return selectedId;
    return null;
  }, [selectedId, w.modules, w.components]);

  // 빈 캔버스 더블클릭 → pending module
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onDbl = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('.react-flow__node')) return;
      if (target.closest('.react-flow__handle')) return;
      if (target.closest('.cv-status')) return;
      if (target.closest('.cv-empty')) return;
      const world = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const x = Math.round((world.x - MODULE_W_EST / 2) / GRID) * GRID;
      const y = Math.round((world.y - 30) / GRID) * GRID;
      setPending({ kind: 'module', position: { x, y } });
      setSelectedId(PENDING_ID);
    };
    el.addEventListener('dblclick', onDbl);
    return () => el.removeEventListener('dblclick', onDbl);
  }, [rf]);

  // Tab → 선택된 entity 의 자식 component pending
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const inField = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (inField) return;
      if (e.key !== 'Tab') return;
      if (!selectedEntityPath) return;
      if (pending) return;
      e.preventDefault();
      // parent 의 현재 위치 + 기존 자식 개수로 새 위치
      const parentModule = w.modules.find((m) => m.path === selectedEntityPath);
      const parentComp = w.components.find((c) => c.path === selectedEntityPath);
      const parent = parentModule ?? parentComp;
      if (!parent) return;
      const siblings = w.components.filter((c) => c.parentPath === selectedEntityPath);
      const x = parent.position.x + MODULE_W_EST + COMPONENT_GAP_X;
      const y = parent.position.y + siblings.length * COMPONENT_GAP_Y;
      setPending({ kind: 'component', parentPath: selectedEntityPath, position: { x, y } });
      setSelectedId(PENDING_ID);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selectedEntityPath, w.modules, w.components, pending]);

  const [rfNodes, setRfNodes] = useState<Node[]>([]);
  const [rfEdges, setRfEdges] = useState<Edge[]>([]);

  // snapshot + pending → rfNodes
  useEffect(() => {
    setRfNodes((current) => {
      const byId = new Map(current.map((n) => [n.id, n]));
      const next: Node[] = [];
      const componentsHidden = zoom < ZOOM_REVEAL;

      for (const m of w.modules) {
        const existing = byId.get(m.path);
        const data: ModuleNodeData = {
          name: m.name,
          tags: m.tags,
          editing: m.path === editingId,
          onCommitName: (v: string) => onCommitRename(m.path, v),
          onCancelName: onCancelRename,
        };
        next.push({
          id: m.path,
          type: 'module',
          position: existing ? existing.position : m.position,
          data,
          draggable: m.path !== editingId,
          selected: m.path === selectedId,
        });
      }

      for (const c of w.components) {
        const existing = byId.get(c.path);
        const data: ComponentNodeData = {
          name: c.name,
          editing: c.path === editingId,
          onCommitName: (v: string) => onCommitRename(c.path, v),
          onCancelName: onCancelRename,
        };
        next.push({
          id: c.path,
          type: 'component',
          position: existing ? existing.position : c.position,
          data,
          draggable: c.path !== editingId,
          selected: c.path === selectedId,
          hidden: componentsHidden,
        });
      }

      // pending ghost 노드
      if (pending) {
        if (pending.kind === 'module') {
          const data: ModuleNodeData = {
            name: '', tags: [],
            editing: true,
            onCommitName: onPendingCommit,
            onCancelName: onPendingCancel,
          };
          next.push({
            id: PENDING_ID, type: 'module',
            position: pending.position, data,
            draggable: false, selected: true,
          });
        } else {
          const data: ComponentNodeData = {
            name: '',
            editing: true,
            onCommitName: onPendingCommit,
            onCancelName: onPendingCancel,
          };
          next.push({
            id: PENDING_ID, type: 'component',
            position: pending.position, data,
            draggable: false, selected: true,
            hidden: componentsHidden,
          });
        }
      }
      return next;
    });
  }, [w.modules, w.components, editingId, selectedId, zoom, pending, onCommitRename, onCancelRename, onPendingCommit, onPendingCancel]);

  // edges
  useEffect(() => {
    const componentsHidden = zoom < ZOOM_REVEAL;
    const out: Edge[] = [];
    if (!componentsHidden) {
      // 부모 → 자식 own edge (재귀, 모든 entity 가 parent 가질 수 있음)
      const allEntityPaths = new Set<string>([
        ...w.modules.map((m) => m.path),
        ...w.components.map((c) => c.path),
      ]);
      for (const c of w.components) {
        if (!allEntityPaths.has(c.parentPath)) continue;
        out.push({
          id: `own:${c.parentPath}:${c.path}`,
          source: c.parentPath, target: c.path,
          type: 'floating',
          style: { stroke: 'rgba(0,0,0,0.16)', strokeWidth: 1, strokeDasharray: '3 3' },
          deletable: false, focusable: false,
        });
      }
      for (const t of w.componentTasks) {
        out.push({
          id: t.id, source: t.fromPath, target: t.toPath,
          type: 'floating', reconnectable: true,
          style: { stroke: 'var(--m-task-edge)', strokeWidth: 1.3 },
          label: t.label,
        });
      }
    } else {
      // 줌 아웃: component task 의 root module 추적 → module-module edge dedupe
      const moduleSet = new Set(w.modules.map((m) => m.path));
      const parentOf = new Map<string, string>();
      for (const c of w.components) parentOf.set(c.path, c.parentPath);
      const rootModuleOf = (path: string): string | null => {
        let cur = path;
        const guard = new Set<string>();
        while (!moduleSet.has(cur)) {
          if (guard.has(cur)) return null;
          guard.add(cur);
          const p = parentOf.get(cur);
          if (!p) return null;
          cur = p;
        }
        return cur;
      };
      const seen = new Set<string>();
      for (const t of w.componentTasks) {
        const a = rootModuleOf(t.fromPath);
        const b = rootModuleOf(t.toPath);
        if (!a || !b || a === b) continue;
        const [src, dst] = a < b ? [a, b] : [b, a];
        const key = `${src}|${dst}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          id: `agg:${key}`, source: src, target: dst, type: 'floating',
          style: { stroke: 'var(--m-task-edge)', strokeWidth: 1.3 },
          deletable: false, focusable: false,
        });
      }
    }
    setRfEdges(out);
  }, [w.modules, w.components, w.componentTasks, zoom]);

  // module drag — 자식 component 따라옴
  const dragRef = useRef<{ modulePath: string; lastPos: { x: number; y: number }; childIds: string[] } | null>(null);

  const onNodeDragStart = useCallback((_: unknown, node: Node) => {
    // 재귀로 모든 후손 collect — module 뿐 아니라 component drag 도 자식 따라옴
    const collectDescendants = (rootPath: string): string[] => {
      const out: string[] = [];
      const stack = [rootPath];
      while (stack.length > 0) {
        const cur = stack.pop()!;
        for (const c of w.components) {
          if (c.parentPath === cur) {
            out.push(c.path);
            stack.push(c.path);
          }
        }
      }
      return out;
    };
    const childIds = collectDescendants(node.id);
    if (childIds.length === 0 && node.type !== 'module') {
      dragRef.current = null;
      return;
    }
    dragRef.current = { modulePath: node.id, lastPos: { x: node.position.x, y: node.position.y }, childIds };
  }, [w.components]);

  const onNodeDrag = useCallback((_: unknown, node: Node) => {
    const off = dragRef.current;
    if (!off || off.modulePath !== node.id) return;
    const dx = node.position.x - off.lastPos.x;
    const dy = node.position.y - off.lastPos.y;
    if (dx === 0 && dy === 0) return;
    off.lastPos = { x: node.position.x, y: node.position.y };
    const childSet = new Set(off.childIds);
    setRfNodes((curr) =>
      curr.map((n) => (childSet.has(n.id)
        ? { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } }
        : n
      )),
    );
  }, []);

  const onNodeDragStop = useCallback((_: unknown, node: Node) => {
    if (node.id === PENDING_ID) return;
    void store.updateEntityPosition(node.id, { x: node.position.x, y: node.position.y });
    const off = dragRef.current;
    if (off && off.modulePath === node.id) {
      const childSet = new Set(off.childIds);
      const curr = rf.getNodes();
      for (const cn of curr) {
        if (childSet.has(cn.id)) {
          void store.updateEntityPosition(cn.id, { x: cn.position.x, y: cn.position.y });
        }
      }
      dragRef.current = null;
    }
  }, [rf, store]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setRfNodes((curr) => applyNodeChanges(changes, curr));
    for (const ch of changes) {
      if (ch.type === 'remove') {
        if (ch.id === PENDING_ID) { setPending(null); continue; }
        const node = rf.getNode(ch.id);
        if (!node) continue;
        if (node.type === 'module') void store.deleteEntity(ch.id);
        else if (node.type === 'component') void store.deleteEntity(ch.id);
      }
      if (ch.type === 'select') { if (ch.selected) setSelectedId(ch.id); }
    }
  }, [rf, store]);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setRfEdges((curr) => applyEdgeChanges(changes, curr));
    for (const ch of changes) {
      if (ch.type === 'remove') {
        if (ch.id.startsWith('own:') || ch.id.startsWith('agg:')) continue;
        if (ch.id.startsWith('task:')) {
          const rest = ch.id.slice('task:'.length);
          const arrow = rest.indexOf('→');
          if (arrow > 0) {
            void store.removeComponentTask(rest.slice(0, arrow), rest.slice(arrow + 1));
          }
        }
      }
    }
  }, [store]);

  const onConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target || c.source === c.target) return;
    if (c.source === PENDING_ID || c.target === PENDING_ID) return;
    const srcNode = rf.getNode(c.source);
    const tgtNode = rf.getNode(c.target);
    if (srcNode?.type !== 'component' || tgtNode?.type !== 'component') return;
    void store.addComponentTask(c.source, c.target);
  }, [rf, store]);

  const onNodeDoubleClick: NodeMouseHandler = useCallback((_, node) => {
    if (node.id === PENDING_ID) return;
    setEditingId(node.id);
  }, []);

  const onPaneClick = useCallback(() => setSelectedId(null), []);

  // delete + Esc + ⌘Enter
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const inField = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (inField) return;
      if (e.key === 'Backspace' || e.key === 'Delete') {
        const sel = rf.getNodes().filter((n) => n.selected && n.id !== PENDING_ID);
        const selE = rf.getEdges().filter((ed) => ed.selected && !ed.id.startsWith('own:') && !ed.id.startsWith('agg:'));
        for (const n of sel) {
          // expanded entity (자식 있을 가능성) 는 한 번 더 확인 받음
          const hasChildren = w.components.some((c) => c.parentPath === n.id);
          if (hasChildren) {
            const ok = confirm(`'${n.id}' 와 모든 자식을 삭제할까요? (폴더 통째로 사라집니다)`);
            if (!ok) continue;
          }
          void store.deleteEntity(n.id);
        }
        for (const ed of selE) {
          if (ed.id.startsWith('task:')) {
            const rest = ed.id.slice('task:'.length);
            const arrow = rest.indexOf('→');
            if (arrow > 0) void store.removeComponentTask(rest.slice(0, arrow), rest.slice(arrow + 1));
          }
        }
        if (sel.length > 0) setSelectedId(null);
      }
      if (e.key === 'Escape' && !inField) {
        if (pending) setPending(null);
        setEditingId(null);
        setSelectedId(null);
      }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        if (selectedId && selectedId !== PENDING_ID) void store.openInSplitLeaf(selectedId);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [rf, store, selectedId, pending]);

  return (
    <div className="modular-canvas" ref={rootRef}>
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDoubleClick={onNodeDoubleClick}
        onPaneClick={onPaneClick}
        onConnect={onConnect}
        onNodeDragStart={onNodeDragStart}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        onReconnect={(oldEdge, newConn) => {
          if (!newConn.source || !newConn.target) return;
          if (oldEdge.id.startsWith('own:') || oldEdge.id.startsWith('agg:')) return;
          if (oldEdge.id.startsWith('task:')) {
            const rest = oldEdge.id.slice('task:'.length);
            const arrow = rest.indexOf('→');
            if (arrow > 0) {
              void store.removeComponentTask(rest.slice(0, arrow), rest.slice(arrow + 1));
              void store.addComponentTask(newConn.source, newConn.target);
            }
          }
        }}
        connectionMode={ConnectionMode.Loose}
        proOptions={{ hideAttribution: true }}
        nodesDraggable
        nodesConnectable
        elementsSelectable
        panOnDrag
        panOnScroll
        zoomOnScroll={false}
        zoomOnPinch
        zoomOnDoubleClick={false}
        minZoom={0.2}
        maxZoom={2}
        snapToGrid
        snapGrid={[GRID, GRID]}
        defaultViewport={{ x: 240, y: 180, zoom: 1 }}
        nodesFocusable={false}
        deleteKeyCode={null}
      >
        <Background variant={BackgroundVariant.Dots} gap={GRID * 2} size={1} color="rgba(0,0,0,0.08)" />
      </ReactFlow>

      <Status
        moduleCount={w.modules.length}
        componentCount={w.components.length}
        zoom={zoom}
        canAddComponent={selectedEntityPath !== null && !pending}
        canOpenInLeaf={selectedId !== null && selectedId !== PENDING_ID}
      />
      {w.modules.length === 0 && !pending && <EmptyHint />}
    </div>
  );
}

function EmptyHint() {
  return (
    <div className="cv-empty">
      <div className="cv-empty-icon">⌗</div>
      <div className="cv-empty-title">빈 캔버스</div>
      <div className="cv-empty-hint">
        아무 곳이나 <kbd>더블클릭</kbd> 후 이름을 입력하면 모듈 파일이 생깁니다.
      </div>
    </div>
  );
}

function Status({
  moduleCount, componentCount, zoom, canAddComponent, canOpenInLeaf,
}: {
  moduleCount: number; componentCount: number; zoom: number;
  canAddComponent: boolean; canOpenInLeaf: boolean;
}) {
  const inDetail = zoom >= ZOOM_REVEAL;
  return (
    <div className="cv-status">
      <span>모듈 {moduleCount}</span>
      <span className="cv-status-sep">·</span>
      <span>컴포넌트 {componentCount}</span>
      <span className="cv-status-sep">·</span>
      <span>zoom {(zoom * 100).toFixed(0)}%</span>
      <span className="cv-status-sep">·</span>
      <span>{inDetail ? '상세' : '요약 (모듈 간 선)'}</span>
      <span className="cv-status-sep">·</span>
      <span><kbd>더블클릭</kbd> 모듈</span>
      {canAddComponent && (
        <>
          <span className="cv-status-sep">·</span>
          <span><kbd>Tab</kbd> 컴포넌트</span>
        </>
      )}
      {canOpenInLeaf && (
        <>
          <span className="cv-status-sep">·</span>
          <span><kbd>⌘</kbd><kbd>Enter</kbd> 파일 열기</span>
        </>
      )}
      <span className="cv-status-sep">·</span>
      <span><kbd>delete</kbd> 삭제</span>
    </div>
  );
}

export function Canvas(props: CanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
