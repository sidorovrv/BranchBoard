import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  useReactFlow,
  useStore as useFlowStore,
  useViewport,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type OnConnectEnd,
  type OnReconnect,
} from "@xyflow/react";
import { ancestorEdgeIds, hiddenByCollapse, liveEdges, liveNodes, satelliteLinksOf, wireSidesByEdge } from "@branchboard/core";
import { copySelectedNodes, isTextField, pasteCopiedNodes } from "../nodeClipboard";
import { commitGraphEdit, createAndFocus, handleSidePointer, isBoundSidePointer, isFocusClick } from "../actions";
import { createFileNode, droppedFiles, hasFiles, pastedFiles, pasteFiles } from "../attachments";
import { AlignmentGuides, useDragSnap } from "../dragSnap";
import { useGraphWithLiveMoves, useLiveMoves } from "../liveMoves";
import { isMacPlatform } from "../platform";
import { useSettings } from "../settings";
import { useKeyboardPan } from "../keyboardPan";
import { loadViewport, saveViewport } from "../savedViewport";
import { hasScrollableAncestor, wheelPixels } from "../wheelPan";
import { boardId, registerViewCentre, sendBoardCommand, useBoard } from "../store";
import { MiniMapNode } from "./MiniMapNode";
import { NodeShell } from "./NodeShell";
import { WireEdge } from "./WireEdge";

const nodeTypes = { bb: NodeShell };
const edgeTypes = { wire: WireEdge };

const FOCUS_DURATION_MS = 400;
const FOCUS_MAX_ZOOM = 1;
const MAX_ZOOM = 12;

const ZoomReadout = () => {
  const { zoom } = useViewport();
  const { fitView } = useReactFlow();
  return (
    <Panel position="bottom-left" className="zoom-readout">
      <span>{Math.round(zoom * 100)}%</span>
      <button onClick={() => void fitView({ duration: FOCUS_DURATION_MS })}>Fit</button>
    </Panel>
  );
};

const LAYOUT_SETTLE_MS = 800;

const useKeepBoardStationary = () => {
  const width = useFlowStore((state) => state.width);
  const height = useFlowStore((state) => state.height);
  const container = useFlowStore((state) => state.domNode);
  const { getViewport, setViewport } = useReactFlow();
  const previous = useRef<{ left: number; top: number } | undefined>(undefined);
  const mountedAt = useRef(performance.now());
  useEffect(() => {
    if (!container || width === 0 || height === 0) return;
    const { left, top } = container.getBoundingClientRect();
    const before = previous.current;
    previous.current = { left, top };
    const isStillSettling = performance.now() - mountedAt.current < LAYOUT_SETTLE_MS;
    if (!before || isStillSettling || (before.left === left && before.top === top)) return;
    const { x, y, zoom } = getViewport();
    void setViewport({ x: x - (left - before.left), y: y - (top - before.top), zoom });
  }, [width, height, container, getViewport, setViewport]);
};

const PINCH_ZOOM_SPEED = 0.01;
const MIN_ZOOM = 0.1;

const TOUCHPAD_PAN_SPEED = 0.5;
const WHEEL_GESTURE_GAP_MS = 220;

const useWheelOverNodes = () => {
  const container = useFlowStore((state) => state.domNode);
  const { getViewport, setViewport } = useReactFlow();
  useEffect(() => {
    if (!container) return;
    let gesture: { mode: "scroll" | "pan"; lastEventAt: number } | undefined;
    const modeOfGesture = (event: WheelEvent, target: Element, deltaX: number, deltaY: number): "scroll" | "pan" => {
      const isContinuing = gesture !== undefined && event.timeStamp - gesture.lastEventAt < WHEEL_GESTURE_GAP_MS;
      const mode = isContinuing ? gesture!.mode : hasScrollableAncestor(target, container, deltaX, deltaY) ? "scroll" : "pan";
      gesture = { mode, lastEventAt: event.timeStamp };
      return mode;
    };
    const panBoard = (event: WheelEvent, target: Element) => {
      const { x: deltaX, y: deltaY } = wheelPixels(event);
      if (modeOfGesture(event, target, deltaX, deltaY) === "scroll") return;
      event.preventDefault();
      const { x, y, zoom } = getViewport();
      void setViewport({ x: Math.round(x - deltaX * TOUCHPAD_PAN_SPEED), y: Math.round(y - deltaY * TOUCHPAD_PAN_SPEED), zoom });
    };
    const zoomAtPointer = (event: WheelEvent) => {
      const target = event.target as Element;
      if (!target.closest(".nowheel")) return;
      if (!event.ctrlKey) {
        if (isMacPlatform) panBoard(event, target);
        return;
      }
      event.preventDefault();
      const { x, y, zoom } = getViewport();
      const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * Math.exp(-event.deltaY * PINCH_ZOOM_SPEED)));
      const bounds = container.getBoundingClientRect();
      const pointerX = event.clientX - bounds.left;
      const pointerY = event.clientY - bounds.top;
      const ratio = nextZoom / zoom;
      void setViewport({ x: pointerX - (pointerX - x) * ratio, y: pointerY - (pointerY - y) * ratio, zoom: nextZoom });
    };
    container.addEventListener("wheel", zoomAtPointer, { passive: false });
    return () => container.removeEventListener("wheel", zoomAtPointer);
  }, [container, getViewport, setViewport]);
};

const useDerivedNodes = (): Node[] => {
  const graph = useBoard((state) => state.view.graph);
  const isInline = useSettings((state) => state.settings.subagentDisplay) === "inline";
  return useMemo(() => {
    const hidden = hiddenByCollapse(graph);
    return liveNodes(graph).map((node) => ({
      id: node.id,
      type: "bb",
      position: { x: node.x, y: node.y },
      data: { nodeId: node.id },
      hidden: hidden.has(node.id) || (node.satelliteOf !== undefined && (isInline || hidden.has(node.satelliteOf))),
      draggable: !node.pinned,
    }));
  }, [graph, isInline]);
};

const LIVE_MOVE_SETTLE_MS = 400;

const useDerivedEdges =(): Edge[] => {
  const graph = useGraphWithLiveMoves();
  const selectedIds = useBoard((state) => state.selectedIds);
  const direction = useSettings((state) => state.settings.flowDirection);
  const isInline = useSettings((state) => state.settings.subagentDisplay) === "inline";
  return useMemo(() => {
    const hidden = hiddenByCollapse(graph);
    const highlighted = selectedIds.length === 1 ? ancestorEdgeIds(graph, selectedIds[0]) : undefined;
    const sidesByEdge = wireSidesByEdge(graph, direction);
    const wires: Edge[] = liveEdges(graph).map((edge) => ({
      id: edge.id,
      source: edge.fromId,
      sourceHandle: `${sidesByEdge.get(edge.id)!.fromSide}-source`,
      target: edge.toId,
      targetHandle: `${sidesByEdge.get(edge.id)!.toSide}-target`,
      type: "wire",
      hidden: hidden.has(edge.fromId) || hidden.has(edge.toId),
      data: {
        isHighlighted: highlighted?.has(edge.id) ?? false,
        isDimmed: highlighted !== undefined && !highlighted.has(edge.id),
        isFlowing: graph.nodes[edge.toId]?.status === "running",
        sourceKind: graph.nodes[edge.fromId]?.kind,
      },
    }));
    const satelliteLinks: Edge[] = satelliteLinksOf(graph, direction).map((link) => ({
      id: `satellite:${link.satelliteId}`,
      source: link.parentId,
      sourceHandle: `${link.sides.fromSide}-source`,
      target: link.satelliteId,
      targetHandle: `${link.sides.toSide}-target`,
      type: "wire",
      className: "satellite-link",
      data: { isSatelliteLink: true },
      selectable: false,
      deletable: false,
      focusable: false,
      reconnectable: false,
      hidden: isInline || hidden.has(link.parentId),
    }));
    return [...wires, ...satelliteLinks];
  }, [graph, selectedIds, direction, isInline]);
};

export const Canvas = () => {
  const theme = useSettings((state) => state.settings.theme);
  const keyboardPan = useSettings((state) => state.settings.keyboardPan);
  const derivedNodes = useDerivedNodes();
  const edges = useDerivedEdges();
  const pendingFocus = useBoard((state) => state.pendingFocus);
  const { screenToFlowPosition, fitView, getNode, setCenter, getViewport } = useReactFlow();
  const ownBoardId = useMemo(() => boardId(), []);
  const savedViewport = useMemo(() => loadViewport(ownBoardId), [ownBoardId]);
  useEffect(() => {
    const saveCurrent = () => saveViewport(ownBoardId, getViewport());
    const saveWhenHidden = () => document.visibilityState === "hidden" && saveCurrent();
    document.addEventListener("visibilitychange", saveWhenHidden);
    window.addEventListener("pagehide", saveCurrent);
    return () => {
      document.removeEventListener("visibilitychange", saveWhenHidden);
      window.removeEventListener("pagehide", saveCurrent);
      saveCurrent();
    };
  }, [ownBoardId, getViewport]);
  const viewWidth = useFlowStore((state) => state.width);
  const viewHeight = useFlowStore((state) => state.height);
  const [nodes, setNodes] = useState<Node[]>([]);
  useKeepBoardStationary();
  useWheelOverNodes();
  useKeyboardPan();

  useEffect(() => {
    setNodes((previous) => {
      const known = new Map(previous.map((node) => [node.id, node]));
      return derivedNodes.map((node) => {
        const old = known.get(node.id);
        if (!old) return node;
        return { ...node, selected: old.selected, measured: old.measured, ...(old.dragging ? { position: old.position, dragging: true } : {}) };
      });
    });
  }, [derivedNodes]);

  const focus = useCallback(
    (id: string) => {
      useBoard.getState().select([id]);
      setNodes((current) => current.map((node) => ({ ...node, selected: node.id === id })));
      void fitView({ nodes: [{ id }], duration: FOCUS_DURATION_MS, maxZoom: FOCUS_MAX_ZOOM });
    },
    [fitView],
  );

  const zoomOntoNode = useCallback(
    (id: string) => {
      const target = getNode(id);
      if (!target?.measured?.width || !target.measured.height || !viewWidth || !viewHeight) return;
      const fillZoom = Math.min(viewWidth / target.measured.width, viewHeight / target.measured.height);
      const zoom = fillZoom * (useSettings.getState().settings.altClickZoom / 100);
      void setCenter(target.position.x + target.measured.width / 2, target.position.y + target.measured.height / 2, { zoom, duration: FOCUS_DURATION_MS });
    },
    [getNode, setCenter, viewWidth, viewHeight],
  );

  useEffect(() => useBoard.getState().registerFocus(focus), [focus]);

  useEffect(() => {
    const onMouseDown = (event: MouseEvent) => void handleSidePointer(event, zoomOntoNode);
    const suppressBrowserNavigation = (event: MouseEvent) => isBoundSidePointer(event) && event.preventDefault();
    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("mouseup", suppressBrowserNavigation, true);
    window.addEventListener("auxclick", suppressBrowserNavigation, true);
    return () => {
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("mouseup", suppressBrowserNavigation, true);
      window.removeEventListener("auxclick", suppressBrowserNavigation, true);
    };
  }, [zoomOntoNode]);

  useEffect(() => {
    if (pendingFocus && nodes.find((node) => node.id === pendingFocus)?.measured) {
      useBoard.getState().requestFocus(undefined);
      focus(pendingFocus);
    }
  }, [pendingFocus, nodes, focus]);

  const lastPointer = useRef<{ x: number; y: number } | undefined>(undefined);
  const pendingSelection = useBoard((state) => state.pendingSelection);

  const viewportCentre = useCallback(() => {
    const bounds = document.querySelector(".react-flow")?.getBoundingClientRect();
    return screenToFlowPosition({ x: bounds ? bounds.left + bounds.width / 2 : window.innerWidth / 2, y: bounds ? bounds.top + bounds.height / 2 : window.innerHeight / 2 });
  }, [screenToFlowPosition]);

  useEffect(() => {
    registerViewCentre(viewportCentre);
    return () => registerViewCentre(() => undefined);
  }, [viewportCentre]);

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const files = pastedFiles(event);
      if (files.length > 0) {
        event.preventDefault();
        const { defaultNodeWidth, defaultNodeHeight } = useSettings.getState().settings;
        const centre = viewportCentre();
        void pasteFiles(files, { x: centre.x - defaultNodeWidth / 2, y: centre.y - defaultNodeHeight / 2 });
        return;
      }
      void pasteCopiedNodes(event, lastPointer.current ?? viewportCentre());
    };
    const onCopy = (event: ClipboardEvent) => void copySelectedNodes(event);
    const onSelectAll = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "a" || isTextField(event.target)) return;
      event.preventDefault();
      setNodes((current) => current.map((node) => ({ ...node, selected: !node.hidden })));
    };
    window.addEventListener("paste", onPaste);
    window.addEventListener("copy", onCopy);
    window.addEventListener("keydown", onSelectAll);
    return () => {
      window.removeEventListener("paste", onPaste);
      window.removeEventListener("copy", onCopy);
      window.removeEventListener("keydown", onSelectAll);
    };
  }, [viewportCentre]);

  useEffect(() => {
    if (!pendingSelection || !pendingSelection.every((id) => nodes.some((node) => node.id === id))) return;
    useBoard.getState().requestSelection(undefined);
    useBoard.getState().select(pendingSelection);
    setNodes((current) => current.map((node) => ({ ...node, selected: pendingSelection.includes(node.id) })));
  }, [pendingSelection, nodes]);

  const onConnect = useCallback((connection: Connection) => void commitGraphEdit({ type: "connect", fromId: connection.source, toId: connection.target }), []);

  const onReconnect: OnReconnect = useCallback((oldEdge, connection) => {
    const end = connection.source !== oldEdge.source ? "from" : "to";
    void commitGraphEdit({ type: "reattach", edgeId: oldEdge.id, end, nodeId: end === "from" ? connection.source : connection.target });
  }, []);

  const onBoardDragOver = useCallback((event: DragEvent) => hasFiles(event) && event.preventDefault(), []);

  const onBoardDrop = useCallback(
    (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const { defaultNodeWidth, defaultNodeHeight } = useSettings.getState().settings;
      void createFileNode(droppedFiles(event), { x: position.x - defaultNodeWidth / 2, y: position.y - defaultNodeHeight / 2 });
    },
    [screenToFlowPosition],
  );

  const onBoardDoubleClick = useCallback(
    (event: React.MouseEvent) => {
      if (!(event.target as HTMLElement).classList.contains("react-flow__pane")) return;
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const { defaultNodeWidth, defaultNodeHeight } = useSettings.getState().settings;
      void sendBoardCommand<{ nodeId: string }>({ type: "reply", parentIds: [], position: { x: position.x - defaultNodeWidth / 2, y: position.y - defaultNodeHeight / 2 } }).then(
        (created) => created && useBoard.getState().requestFocus(created.nodeId),
      );
    },
    [screenToFlowPosition],
  );

  const onConnectEnd: OnConnectEnd = useCallback(
    (event, state) => {
      if (state.toNode || !state.fromNode || state.fromHandle?.type !== "source") return;
      const parent = useBoard.getState().view.graph.nodes[state.fromNode.id];
      if (!parent) return;
      const pointer = "changedTouches" in event ? event.changedTouches[0] : event;
      const released = screenToFlowPosition({ x: pointer.clientX, y: pointer.clientY });
      const isVertical = useSettings.getState().settings.flowDirection === "vertical";
      const position = isVertical ? { x: Math.round(released.x - parent.w / 2), y: Math.round(released.y) } : { x: Math.round(released.x), y: Math.round(released.y - parent.h / 2) };
      void createAndFocus({ type: "reply", parentIds: [parent.id], position });
    },
    [screenToFlowPosition],
  );

  const { guides, adjustChanges, startDrag, finishDrag } = useDragSnap();

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const adjusted = adjustChanges(changes);
      const moved = Object.fromEntries(adjusted.flatMap((change) => (change.type === "position" && change.dragging && change.position ? [[change.id, change.position]] : [])));
      if (Object.keys(moved).length > 0) useLiveMoves.getState().update(moved);
      setNodes((current) => applyNodeChanges(adjusted, current));
    },
    [adjustChanges],
  );

  const onNodeDragStop = useCallback(
    (_event: unknown, _node: Node, dragged: Node[]) => {
      void sendBoardCommand({ type: "moveNodes", positions: finishDrag(dragged) }).finally(() => setTimeout(() => useLiveMoves.getState().clear(), LIVE_MOVE_SETTLE_MS));
    },
    [finishDrag],
  );

  const onBeforeDelete = useCallback(
    async ({ nodes: doomedNodes, edges: doomedEdges }: { nodes: Node[]; edges: Edge[] }) => {
      const doomedIds = new Set(doomedNodes.map((node) => node.id));
      if (doomedIds.size > 0) void sendBoardCommand({ type: "deleteNodes", ids: [...doomedIds] });
      doomedEdges
        .filter((edge) => !doomedIds.has(edge.source) && !doomedIds.has(edge.target))
        .forEach((edge) => void commitGraphEdit({ type: "disconnect", edgeId: edge.id }));
      return false;
    },
    [],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onDoubleClick={onBoardDoubleClick}
      onMouseMove={(event) => (lastPointer.current = screenToFlowPosition({ x: event.clientX, y: event.clientY }))}
      onDragOver={onBoardDragOver}
      onDrop={onBoardDrop}
      zoomOnDoubleClick={false}
      panOnScroll={isMacPlatform}
      disableKeyboardA11y={keyboardPan === "arrows"}
      multiSelectionKeyCode={["Shift", "Meta", "Control"]}
      onConnect={onConnect}
      onConnectEnd={onConnectEnd}
      onReconnect={onReconnect}
      onBeforeDelete={onBeforeDelete}
      onNodeClick={(event, node) => isFocusClick(event.nativeEvent) && zoomOntoNode(node.id)}
      onNodeDragStart={startDrag}
      onNodeDragStop={onNodeDragStop}
      onSelectionChange={({ nodes: selected }) => useBoard.getState().select(selected.map((node) => node.id))}
      connectionMode={ConnectionMode.Strict}
      onlyRenderVisibleElements
      minZoom={MIN_ZOOM}
      maxZoom={MAX_ZOOM}
      fitView={!savedViewport}
      defaultViewport={savedViewport}
      onMoveEnd={(_event, viewport) => saveViewport(ownBoardId, viewport)}
      fitViewOptions={{ maxZoom: FOCUS_MAX_ZOOM }}
      deleteKeyCode={["Delete", "Backspace"]}
      colorMode={theme}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1.6} />
      <MiniMap pannable zoomable nodeComponent={MiniMapNode} nodeStrokeWidth={3} />
      <Controls showInteractive={false} />
      <ZoomReadout />
      <AlignmentGuides guides={guides} />
    </ReactFlow>
  );
};
