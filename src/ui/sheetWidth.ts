// How wide the sheets on the right are: the owner drags their left edge, and this browser remembers it.

import { useEffect, useRef, useState } from 'react';
import { readJson, writeJson } from './stored';

/** The sheets' own width: Coordinator, archive, configuration and a project's workstreams share it. */
export const SHEET_W = 380;
/** Room the canvas keeps beside a sheet, however wide it is dragged. */
const CANVAS_MIN = 240;
const MIN = { sheet: 320, read: 380 };
const KEY = 'obeya-sheet-width';

/**
 * The widths the owner chose; `read` (a plan doc read in the sheet) follows the window until chosen,
 * never narrower than the sheet it widens.
 */
export type SheetWidths = { sheet: number; read: number | null };

/** How wide the sheet gets for reading a plan doc unless the owner chose: what the window spares beside the project. */
export const readingDefault = (vw: number) => Math.min(760, Math.max(MIN.read, vw - 520));

/** `w` within what the window allows for a sheet of `kind`; on a narrow window the sheet's minimum wins. */
export const clampWidth = (w: number, vw: number, kind: 'sheet' | 'read') =>
  Math.round(Math.max(MIN[kind], Math.min(w, vw - CANVAS_MIN)));

/** The widths in effect in a window `vw` wide. */
export const widthsIn = (w: SheetWidths, vw: number) => ({
  sheet: clampWidth(w.sheet, vw, 'sheet'),
  read: clampWidth(w.read ?? Math.max(readingDefault(vw), w.sheet), vw, 'read'),
});

export function loadWidths(store: Pick<Storage, 'getItem'>): SheetWidths {
  const saved = readJson<{ sheet?: unknown; read?: unknown }>(store, KEY);
  return {
    sheet: typeof saved?.sheet === 'number' ? saved.sheet : SHEET_W,
    read: typeof saved?.read === 'number' ? saved.read : null,
  };
}

export const saveWidths = (store: Pick<Storage, 'setItem' | 'removeItem'>, w: SheetWidths) => void writeJson(store, KEY, w);

/**
 * The sheets' widths in effect in this window (`sheetW`), and the grip at the open sheet's left edge
 * that sets them for a sheet of `kind`: dragged it widens or narrows the sheet (`resizing` meanwhile),
 * a double click puts it back to its default. What the owner chose is remembered once they let go.
 */
export function useSheetWidths() {
  const [widths, setWidths] = useState<SheetWidths>(() => loadWidths(localStorage));
  const sheetW = widthsIn(widths, innerWidth);
  const grip = useRef<{ x: number; w: number; kind: 'sheet' | 'read' } | null>(null);
  const [resizing, setResizing] = useState(false);
  useEffect(() => {
    if (!resizing) saveWidths(localStorage, widths);
  }, [widths, resizing]);
  const up = () => {
    grip.current = null;
    setResizing(false);
  };
  const gripFor = (kind: 'sheet' | 'read') => ({
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      grip.current = { x: e.clientX, w: sheetW[kind], kind };
      setResizing(true);
    },
    onPointerMove: (e: React.PointerEvent) => {
      const g = grip.current;
      if (!g) return;
      const w = clampWidth(g.w + g.x - e.clientX, innerWidth, g.kind);
      setWidths((ws) => ({ ...ws, [g.kind]: w }));
    },
    onPointerUp: up,
    onPointerCancel: up,
    onDoubleClick: () => setWidths((ws) => ({ ...ws, [kind]: kind === 'sheet' ? SHEET_W : null })),
  });
  return { sheetW, resizing, gripFor };
}
