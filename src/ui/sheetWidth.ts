// How wide the sheets on the right are: the owner drags their left edge, and this browser remembers it.

/** The sheets' own width: Koordinator, archive, configuration and a project's workstreams share it. */
export const SHEET_W = 380;
/** The space a sheet keeps from the window's right edge. */
export const SHEET_GAP = 14;
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
  Math.round(Math.max(MIN[kind], Math.min(w, vw - SHEET_GAP - CANVAS_MIN)));

/** How far above the window's bottom edge the microphone and what shows above it reach. */
const MIC_TOP = 158;
/**
 * How far right of the window's middle the microphone reaches: the attach button beside it and the
 * usual line under it naming whom it speaks to (a project's runs about 150 px), plus some room.
 */
const MIC_SIDE = 170;

/**
 * Where a sheet `w` wide ends at the bottom of a window `vw` wide: at the window's edge, the
 * same gap as on the right, unless it reaches the microphone in the middle, then above it.
 */
export const sheetBottom = (w: number, vw: number) => (vw - SHEET_GAP - w >= vw / 2 + MIC_SIDE ? SHEET_GAP : MIC_TOP);

/** The widths in effect in a window `vw` wide. */
export const widthsIn = (w: SheetWidths, vw: number) => ({
  sheet: clampWidth(w.sheet, vw, 'sheet'),
  read: clampWidth(w.read ?? Math.max(readingDefault(vw), w.sheet), vw, 'read'),
});

export function loadWidths(store: Pick<Storage, 'getItem'>): SheetWidths {
  try {
    const saved = JSON.parse(store.getItem(KEY) ?? 'null');
    return {
      sheet: typeof saved?.sheet === 'number' ? saved.sheet : SHEET_W,
      read: typeof saved?.read === 'number' ? saved.read : null,
    };
  } catch {
    return { sheet: SHEET_W, read: null };
  }
}

export function saveWidths(store: Pick<Storage, 'setItem'>, w: SheetWidths) {
  try {
    store.setItem(KEY, JSON.stringify(w));
  } catch {}
}
