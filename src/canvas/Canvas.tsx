// Canvas — vault-backed 마인드맵 (v2: id-based).
// 새 entity 생성 흐름:
//   1. 빈 캔버스 더블클릭 → in-memory pending 카드 (vault 호출 X)
//   2. 사용자가 이름 입력 + Enter / blur → store.createModule(name, position)
//   3. 이름이 비어 있거나 Esc → pending 사라짐, 파일 안 생김
// 기존 entity 의 이름 편집 (노드 더블클릭) 은 vault.fileManager.renameFile (폴더 rename).

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  ReactFlow,
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
} from '@xyflow/react';

import { Notice } from 'obsidian';
import type { VaultStore } from '../data/vault-store';
import type { Entity, EntityId, Workspace } from '../data/types';
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
  | { kind: 'component'; parentId: EntityId; position: { x: number; y: number } };

interface CanvasProps {
  store: VaultStore;
}

function partitionEntities(w: Workspace): {
  modules: Entity[];
  components: Entity[];
  byId: Map<EntityId, Entity>;
} {
  const modules: Entity[] = [];
  const components: Entity[] = [];
  for (const e of w.entities.values()) {
    if (e.kind === 'module') modules.push(e);
    else components.push(e);
  }
  return { modules, components, byId: w.entities };
}

function CanvasInner({ store }: CanvasProps) {
  const w = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const { modules, components, byId } = useMemo(() => partitionEntities(w), [w]);
  const rf = useReactFlow();
  const rootRef = useRef<HTMLDivElement>(null);
  const [selectedId, setSelectedId] = useState<EntityId | null>(null);
  const [editingId, setEditingId] = useState<EntityId | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const zoom = useStore((s: ReactFlowState) => s.transform[2]);

  // 기존 entity 의 이름 commit → vault rename (폴더 rename).
  const onCommitRename = useCallback((id: EntityId, next: string) => {
    const trimmed = next.trim();
    if (!trimmed) { setEditingId(null); return; }
    void store.renameEntity(id, trimmed).then(() => setEditingId(null));
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
      : store.createChildComponent(p.parentId, trimmed, p.position);
    promise
      .then((id) => { setPending(null); setSelectedId(id); })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        new Notice(`Modular: cannot create — ${msg}`, 4000);
        // pending 유지 — 사용자가 다른 이름 시도 가능
      });
  }, [pending, store]);
  const onPendingCancel = useCallback(() => setPending(null), []);

  // 선택된 entity. Tab 시 이 entity 의 자식 component 추가.
  const selectedEntityId = useMemo<EntityId | null>(() => {
    if (!selectedId || selectedId === PENDING_ID) return null;
    return byId.has(selectedId) ? selectedId : null;
  }, [selectedId, byId]);

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
  const wRef = useRef(w);
  wRef.current = w;
  const selectedEntityIdRef = useRef(selectedEntityId);
  selectedEntityIdRef.current = selectedEntityId;
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const inField = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (inField) return;
      if (e.key !== 'Tab') return;
      const id = selectedEntityIdRef.current;
      if (!id) return;
      if (pendingRef.current) return;
      e.preventDefault();
      const snap = wRef.current;
      const parent = snap.entities.get(id);
      if (!parent) return;
      const siblings = [...snap.entities.values()].filter((c) => c.parentId === id);
      const x = parent.position.x + MODULE_W_EST + COMPONENT_GAP_X;
      const y = parent.position.y + siblings.length * COMPONENT_GAP_Y;
      setPending({ kind: 'component', parentId: id, position: { x, y } });
      setSelectedId(PENDING_ID);
    };
    activeDocument.addEventListener('keydown', onKey);
    return () => activeDocument.removeEventListener('keydown', onKey);
  }, []);

  const [rfNodes, setRfNodes] = useState<Node[]>([]);
  const [rfEdges, setRfEdges] = useState<Edge[]>([]);

  // snapshot + pending → rfNodes
  useEffect(() => {
    setRfNodes((current) => {
      const prevById = new Map(current.map((n) => [n.id, n]));
      const next: Node[] = [];
      const componentsHidden = zoom < ZOOM_REVEAL;
      const dragInFlight = dragRef.current !== null;
      const draggingId = dragRef.current?.entityId ?? null;
      const draggingChildren = dragRef.current?.childIds ?? [];
      const isDragMember = (id: string) => id === draggingId || draggingChildren.includes(id);

      for (const m of modules) {
        const existing = prevById.get(m.id);
        const data: ModuleNodeData = {
          name: m.name,
          tags: m.tags ?? [],
          editing: m.id === editingId,
          bodyExcerpt: m.bodyExcerpt,
          onCommitName: (v: string) => onCommitRename(m.id, v),
          onCancelName: onCancelRename,
        };
        next.push({
          id: m.id,
          type: 'module',
          position: (dragInFlight && existing && isDragMember(m.id)) ? existing.position : m.position,
          data,
          draggable: m.id !== editingId,
          selected: m.id === selectedId,
        });
      }

      for (const c of components) {
        const existing = prevById.get(c.id);
        const data: ComponentNodeData = {
          name: c.name,
          editing: c.id === editingId,
          bodyExcerpt: c.bodyExcerpt,
          onCommitName: (v: string) => onCommitRename(c.id, v),
          onCancelName: onCancelRename,
        };
        next.push({
          id: c.id,
          type: 'component',
          position: (dragInFlight && existing && isDragMember(c.id)) ? existing.position : c.position,
          data,
          draggable: c.id !== editingId,
          selected: c.id === selectedId,
          hidden: componentsHidden,
        });
      }

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
  }, [modules, components, editingId, selectedId, zoom, pending, onCommitRename, onCancelRename, onPendingCommit, onPendingCancel]);

  // edges
  useEffect(() => {
    const componentsHidden = zoom < ZOOM_REVEAL;
    const out: Edge[] = [];
    if (!componentsHidden) {
      // parent → child own edge (모든 entity 가 parent 가질 수 있음)
      for (const c of components) {
        if (!c.parentId || !byId.has(c.parentId)) continue;
        out.push({
          id: `own:${c.parentId}:${c.id}`,
          source: c.parentId, target: c.id,
          type: 'floating',
          style: { stroke: 'rgba(0,0,0,0.16)', strokeWidth: 1, strokeDasharray: '3 3' },
          deletable: false, focusable: false,
        });
      }
      for (const t of w.tasks) {
        out.push({
          id: `task:${t.fromId}→${t.toId}`,
          source: t.fromId, target: t.toId,
          type: 'floating', reconnectable: true,
          style: { stroke: 'var(--m-task-edge)', strokeWidth: 1.3 },
        });
      }
    } else {
      // 줌 아웃: component task 의 root module 추적 → module-module edge dedupe
      const moduleSet = new Set(modules.map((m) => m.id));
      const rootModuleOf = (id: EntityId): EntityId | null => {
        let cur: EntityId | null = id;
        const guard = new Set<EntityId>();
        while (cur && !moduleSet.has(cur)) {
          if (guard.has(cur)) return null;
          guard.add(cur);
          const e = byId.get(cur);
          cur = e?.parentId ?? null;
        }
        return cur;
      };
      const seen = new Set<string>();
      for (const t of w.tasks) {
        const a = rootModuleOf(t.fromId);
        const b = rootModuleOf(t.toId);
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
  }, [modules, components, byId, w.tasks, zoom]);

  // entity drag — 자식 따라옴
  const dragRef = useRef<{ entityId: EntityId; lastPos: { x: number; y: number }; childIds: EntityId[] } | null>(null);

  const onNodeDragStart = useCallback((_: unknown, node: Node) => {
    dragRef.current = null;
    const collectDescendants = (rootId: EntityId): EntityId[] => {
      const out: EntityId[] = [];
      const stack: EntityId[] = [rootId];
      while (stack.length > 0) {
        const cur = stack.pop()!;
        for (const c of components) {
          if (c.parentId === cur) {
            out.push(c.id);
            stack.push(c.id);
          }
        }
      }
      return out;
    };
    const childIds = collectDescendants(node.id);
    if (childIds.length === 0 && node.type !== 'module') return;
    dragRef.current = { entityId: node.id, lastPos: { x: node.position.x, y: node.position.y }, childIds };
  }, [components]);

  const onNodeDrag = useCallback((_: unknown, node: Node) => {
    const off = dragRef.current;
    if (!off || off.entityId !== node.id) return;
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
    if (off && off.entityId === node.id) {
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
        void store.deleteEntity(ch.id);
      }
      if (ch.type === 'select') { if (ch.selected) setSelectedId(ch.id); }
    }
  }, [store]);

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

  const onNodeClick: NodeMouseHandler = useCallback((_, node) => {
    if (node.id === PENDING_ID) return;
    setSelectedId(node.id);
    void store.openInSideLeaf(node.id);
  }, [store]);

  const onNodeContextMenu: NodeMouseHandler = useCallback((e, node) => {
    if (node.id === PENDING_ID) return;
    e.preventDefault();
    setSelectedId(node.id);
    store.openContextMenu(node.id, e as unknown as MouseEvent, {
      onRename: (id: EntityId) => setEditingId(id),
      onAddChild: (id: EntityId) => {
        const snap = wRef.current;
        const parent = snap.entities.get(id);
        if (!parent) return;
        const siblings = [...snap.entities.values()].filter((c) => c.parentId === id);
        const x = parent.position.x + MODULE_W_EST + COMPONENT_GAP_X;
        const y = parent.position.y + siblings.length * COMPONENT_GAP_Y;
        setPending({ kind: 'component', parentId: id, position: { x, y } });
        setSelectedId(PENDING_ID);
      },
      onDelete: (id: EntityId) => {
        const snap = wRef.current;
        const hasChildren = [...snap.entities.values()].some((c) => c.parentId === id);
        const target = snap.entities.get(id);
        const label = target?.name ?? id;
        // eslint-disable-next-line no-alert -- intentional native confirm pending Modal port
        if (hasChildren && !confirm(`'${label}' 와 모든 자식을 삭제할까요? (폴더 통째로 사라집니다)`)) return;
        void store.deleteEntity(id);
        if (selectedIdRef.current === id) setSelectedId(null);
      },
    });
  }, [store]);

  const onPaneClick = useCallback(() => {
    setSelectedId(null);
  }, []);

  // delete + Esc + ⌘Enter
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const inField = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (inField) return;
      if (e.key === 'Backspace' || e.key === 'Delete') {
        const sel = rf.getNodes().filter((n) => n.selected && n.id !== PENDING_ID);
        const selE = rf.getEdges().filter((ed) => ed.selected && !ed.id.startsWith('own:') && !ed.id.startsWith('agg:'));
        const snap = wRef.current;
        for (const n of sel) {
          const hasChildren = [...snap.entities.values()].some((c) => c.parentId === n.id);
          const label = snap.entities.get(n.id)?.name ?? n.id;
          // eslint-disable-next-line no-alert -- intentional native confirm pending Modal port
          if (hasChildren && !confirm(`'${label}' 와 모든 자식을 삭제할까요? (폴더 통째로 사라집니다)`)) continue;
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
        if (pendingRef.current) setPending(null);
        setEditingId(null);
        setSelectedId(null);
      }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        const sel = selectedIdRef.current;
        if (sel && sel !== PENDING_ID) {
          e.preventDefault();
          void store.openInNewSplit(sel);
        }
      }
    };
    activeDocument.addEventListener('keydown', onKey);
    return () => activeDocument.removeEventListener('keydown', onKey);
  }, [rf, store]);

  return (
    <div className="modular-canvas" ref={rootRef}>
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        onNodeDoubleClick={onNodeDoubleClick}
        onNodeContextMenu={onNodeContextMenu}
        onPaneClick={onPaneClick}
        onConnect={onConnect}
        onNodeDragStart={onNodeDragStart}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        onReconnect={(oldEdge: Edge, newConn: Connection) => {
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
        moduleCount={modules.length}
        componentCount={components.length}
        zoom={zoom}
        canAddComponent={selectedEntityId !== null && !pending}
        canOpenInLeaf={selectedId !== null && selectedId !== PENDING_ID}
      />
      {modules.length === 0 && !pending && <EmptyHint />}
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
