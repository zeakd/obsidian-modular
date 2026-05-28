// Floating edge — source/target 노드의 위치를 보고 가장 가까운 측면에서 bezier.

import { useMemo } from 'react';
import { BaseEdge, getBezierPath, useStore, type EdgeProps, type ReactFlowState, Position } from '@xyflow/react';

interface NodeRect { x: number; y: number; width: number; height: number }

function getIntersection(from: NodeRect, to: NodeRect): { x: number; y: number; pos: Position } {
  const fx = from.x + from.width / 2;
  const fy = from.y + from.height / 2;
  const tx = to.x + to.width / 2;
  const ty = to.y + to.height / 2;
  const dx = tx - fx;
  const dy = ty - fy;
  const w = from.width / 2;
  const h = from.height / 2;
  if (dx === 0 && dy === 0) return { x: fx, y: fy, pos: Position.Right };
  const sx = dx === 0 ? Infinity : w / Math.abs(dx);
  const sy = dy === 0 ? Infinity : h / Math.abs(dy);
  const s = Math.min(sx, sy);
  const x = fx + dx * s;
  const y = fy + dy * s;
  let pos: Position;
  if (sx < sy) pos = dx > 0 ? Position.Right : Position.Left;
  else pos = dy > 0 ? Position.Bottom : Position.Top;
  return { x, y, pos };
}

export function FloatingEdge(props: EdgeProps) {
  const { id, source, target, style, markerEnd, selected } = props;

  // xyflow v12: `nodeInternals` was renamed to `nodeLookup`, and node
  // dimensions/positions live under `measured` (size) + `internals.positionAbsolute`.
  const sourceNode = useStore((s: ReactFlowState) => s.nodeLookup.get(source));
  const targetNode = useStore((s: ReactFlowState) => s.nodeLookup.get(target));

  const path = useMemo(() => {
    if (!sourceNode || !targetNode) return '';
    const sw = sourceNode.measured?.width ?? sourceNode.width ?? 120;
    const sh = sourceNode.measured?.height ?? sourceNode.height ?? 36;
    const tw = targetNode.measured?.width ?? targetNode.width ?? 120;
    const th = targetNode.measured?.height ?? targetNode.height ?? 36;
    const sx = sourceNode.internals.positionAbsolute.x;
    const sy = sourceNode.internals.positionAbsolute.y;
    const tx = targetNode.internals.positionAbsolute.x;
    const ty = targetNode.internals.positionAbsolute.y;
    const sRect: NodeRect = { x: sx, y: sy, width: sw, height: sh };
    const tRect: NodeRect = { x: tx, y: ty, width: tw, height: th };
    const s = getIntersection(sRect, tRect);
    const t = getIntersection(tRect, sRect);
    const [p] = getBezierPath({
      sourceX: s.x, sourceY: s.y, sourcePosition: s.pos,
      targetX: t.x, targetY: t.y, targetPosition: t.pos,
    });
    return p;
  }, [sourceNode, targetNode]);

  if (!path) return null;
  const baseStyle = { ...(style ?? {}) };
  if (selected) {
    baseStyle.stroke = 'var(--accent)';
    baseStyle.strokeWidth = 1.6;
  }
  return <BaseEdge id={id} path={path} markerEnd={markerEnd} style={baseStyle} interactionWidth={20} />;
}
