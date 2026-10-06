import { useEffect, type ReactNode } from "react";
import { create } from "zustand";
import { Icon } from "./Icons";

interface PreviewTarget {
  url: string;
  name: string;
}

interface HoverTarget extends PreviewTarget {
  x: number;
  y: number;
}

interface ImagePreviewStore {
  opened?: PreviewTarget;
  hovered?: HoverTarget;
  open: (target: PreviewTarget) => void;
  close: () => void;
  hover: (target?: HoverTarget) => void;
}

const useImagePreview = create<ImagePreviewStore>((set) => ({
  open: (opened) => set({ opened, hovered: undefined }),
  close: () => set({ opened: undefined }),
  hover: (hovered) => set({ hovered }),
}));

const HOVER_SIZE_PX = 360;
const HOVER_OFFSET_PX = 16;

const hoverPositionOf = ({ x, y }: HoverTarget): { left: number; top: number } => {
  const fitsRight = x + HOVER_OFFSET_PX + HOVER_SIZE_PX <= window.innerWidth;
  const fitsBelow = y + HOVER_OFFSET_PX + HOVER_SIZE_PX <= window.innerHeight;
  return {
    left: fitsRight ? x + HOVER_OFFSET_PX : Math.max(0, x - HOVER_OFFSET_PX - HOVER_SIZE_PX),
    top: fitsBelow ? y + HOVER_OFFSET_PX : Math.max(0, y - HOVER_OFFSET_PX - HOVER_SIZE_PX),
  };
};

export const PreviewableImage = ({ url, name, children }: PreviewTarget & { children: ReactNode }) => {
  const { open, hover } = useImagePreview.getState();
  return (
    <button
      type="button"
      className="image-preview-trigger nodrag"
      title={name}
      onClick={() => open({ url, name })}
      onMouseEnter={(event) => hover({ url, name, x: event.clientX, y: event.clientY })}
      onMouseMove={(event) => hover({ url, name, x: event.clientX, y: event.clientY })}
      onMouseLeave={() => hover(undefined)}
    >
      {children}
    </button>
  );
};

export const ImagePreviewLayer = () => {
  const { opened, hovered, close } = useImagePreview();
  useEffect(() => {
    if (!opened) return;
    const closeOnEscape = (event: KeyboardEvent) => event.key === "Escape" && close();
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [opened, close]);
  return (
    <>
      {hovered && !opened && (
        <div className="image-hover" style={hoverPositionOf(hovered)}>
          <img src={hovered.url} alt="" />
        </div>
      )}
      {opened && (
        <div className="image-overlay" onClick={close}>
          <button className="image-overlay-close" onClick={close} title="Close (Esc)" aria-label="Close preview"><Icon name="close" /></button>
          <img src={opened.url} alt={opened.name} onClick={(event) => event.stopPropagation()} />
          <div className="image-overlay-name">{opened.name}</div>
        </div>
      )}
    </>
  );
};
