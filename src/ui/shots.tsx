// Screenshots in what the owner writes: pasted, dropped or picked, scaled down so the agent can
// read them, uploaded at once; shown as thumbnails that grow large over the page on a click, where
// those not sent yet take marks (marks.ts). Other files dropped go into the text by their path, for
// the agent to read them (`fileTo`).

import { type ClipboardEvent, type DragEvent, type MouseEvent, type PointerEvent, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { IMAGE_TYPES, MAX_FILE_BYTES, MAX_IMAGE_BYTES } from '../core/types';
import { api, ApiError, at, failText } from './api';
import { droppedPath, withBytes } from './appDrop';
import { draftOf, draftsHome, dropDraft, insertFilesAt, markupOf, pathWord, setMarkup, updateDraft, updateDraftAt, useDraft } from './draft';
import { useKnown } from './stored';
import { badgeOf, CLICK_PX, drawMarks, EDGE, type Mark, markOf, markSize, type Point, RED, roundedRect } from './marks';
import { confirmPasteHint, pastedShots, pickedShots, usePasteHint } from './pasteHint';
import { pasteKeys, t } from './strings';
import { behindThumb, type Box, onto, ZOOM_EASE, ZOOM_MS } from './zoomBox';

/** The longest side the model looks at in detail; larger screenshots only cost upload and context. */
export const MAX_SIDE = 2000;

/** The images among pasted or dropped files. */
export const imageFiles = (files: FileList | null | undefined) => [...(files ?? [])].filter(isImage);
const isImage = (f: File) => f.type.startsWith('image/');

/** A screenshot as the agent reads it: at most MAX_SIDE on its long side, PNG, or JPEG when that is too large. */
export async function prepareImage(file: Blob): Promise<Blob> {
  const bmp = await createImageBitmap(file).catch(() => null);
  // not an image the browser can read: the server says so
  if (!bmp) return file;
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  if (scale === 1 && IMAGE_TYPES[file.type] && file.size <= MAX_IMAGE_BYTES) return file;
  const canvas = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  let blob = await canvas.convertToBlob({ type: 'image/png' });
  for (const quality of [0.9, 0.8, 0.65]) {
    if (blob.size <= MAX_IMAGE_BYTES) break;
    blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  }
  return blob;
}

export const imageUrl = (id: string) => at(`/images/${encodeURIComponent(id)}`);

/** The screenshot at `src` with the marks drawn into it, as the agent gets it. */
async function markedImage(src: string, marks: Mark[]): Promise<Blob> {
  const res = await fetch(src);
  if (!res.ok) throw new Error(`image: ${res.status}`);
  const bmp = await createImageBitmap(await res.blob());
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0);
  drawMarks(ctx, marks, bmp.width, bmp.height);
  return prepareImage(await canvas.convertToBlob({ type: 'image/png' }));
}

/** Screenshots for a draft, uploaded one after the other; `added` hears each one that arrived. How many did. */
export async function attachTo(key: string, files: File[], added?: () => void) {
  let arrived = 0;
  if (!files.length) return arrived;
  // a switch to another canvas meanwhile: the screenshots go to the draft they were pasted into
  const home = draftsHome();
  updateDraft(key, (d) => ({ error: '', uploading: d.uploading + files.length }));
  for (const f of files) {
    try {
      const id = await api.uploadImage(await prepareImage(await withBytes(f)));
      updateDraftAt(home, key, (d) => ({ images: [...d.images, id] }));
      arrived++;
      added?.();
    } catch (e) {
      updateDraftAt(home, key, { error: failText(e) });
    } finally {
      updateDraftAt(home, key, (d) => ({ uploading: d.uploading - 1 }));
    }
  }
  return arrived;
}

/**
 * Files for a draft that are no screenshots, one after the other; the path of each goes into its
 * text by `put` as it is known, into the draft's text at `home` without one. That is the file's own
 * path: the app's drop names it, and for a browser's Obeya looks for the file on its machine. Where
 * it finds none, the file is uploaded and its copy's path goes in. How many did.
 */
export async function fileTo(key: string, files: File[], put?: (path: string) => void) {
  let arrived = 0;
  if (!files.length) return arrived;
  // a switch to another canvas meanwhile: the paths go to the draft the files were dropped into
  const home = draftsHome();
  updateDraft(key, (d) => ({ error: '', uploading: d.uploading + files.length }));
  for (const f of files) {
    try {
      const own = droppedPath(f) ?? (await api.findFile(f).catch(() => null));
      if (!own && f.size > MAX_FILE_BYTES) throw new ApiError('fileTooLarge', '');
      const path = own ?? (await api.uploadFile(f));
      if (put) put(path);
      else insertFilesAt(home, key, [pathWord(path)]);
      arrived++;
    } catch (e) {
      updateDraftAt(home, key, { error: failText(e) });
    } finally {
      updateDraftAt(home, key, (d) => ({ uploading: d.uploading - 1 }));
    }
  }
  return arrived;
}

/** Pasted or dropped files for a draft whose text is its own: the screenshots as screenshots, the others by their paths. How many arrived. */
export async function filesTo(key: string, files: File[]) {
  const shots = attachTo(key, files.filter(isImage));
  const others = fileTo(key, files.filter((f) => !isImage(f)));
  return (await shots) + (await others);
}

/**
 * Screenshots going into a text field: pasted, dropped or picked, uploaded at once. They belong to
 * the field's `draft` (`draft.ts`), or without one to this field alone. `onChange` hears every
 * change the owner makes, so a card can keep them as they are added. Other files dropped or picked
 * go in by their path (`fileTo`): into the draft's text, or by `put` for a field that keeps its text itself.
 */
export function useShotInput({ draft, initial = [], onChange, off = false, put }: { draft?: string; initial?: string[]; onChange?: (ids: string[]) => void; off?: boolean; put?: (path: string) => void } = {}) {
  const own = useId();
  const key = draft ?? `shots:${own}`;
  // a field of its own starts with its screenshots, and they go with it
  useState(() => !draft && initial.length && updateDraft(key, { images: initial }));
  useEffect(() => (draft ? undefined : () => dropDraft(key)), [key]);
  const { images, uploading, marking, error } = useDraft(key);
  const [dropping, setDropping] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const change = useRef(onChange);
  change.current = onChange;
  const update = (fn: (cur: string[]) => string[]) => {
    updateDraft(key, (d) => ({ images: fn(d.images) }));
    change.current?.(draftOf(key).images);
  };
  const pasteHint = usePasteHint(key, !off);
  const putRef = useRef(put);
  putRef.current = put;
  /** The screenshots among `files` as screenshots, the others by their paths. How many arrived. */
  const attach = async (files: File[]) => {
    if (off) return 0;
    const shots = attachTo(key, files.filter(isImage), () => change.current?.(draftOf(key).images));
    const others = fileTo(key, files.filter((f) => !isImage(f)), putRef.current && ((path) => putRef.current?.(pathWord(path))));
    return (await shots) + (await others);
  };
  const failed = (e: unknown) => updateDraft(key, { error: failText(e) });
  return {
    key,
    off,
    pasteHint,
    images,
    uploading,
    marking,
    dropping,
    error,
    picker,
    attach,
    remove: (id: string) => {
      setMarkup(id, null);
      update((cur) => cur.filter((x) => x !== id));
    },
    /**
     * The marks the owner left on screenshot `id` (a marked one, or still the original): drawn into
     * the original, the new image takes its place in the field; without marks the original does.
     */
    mark: async (id: string, marks: Mark[]) => {
      const was = markupOf(id);
      const original = was?.original ?? id;
      if (JSON.stringify(marks) === JSON.stringify(was?.marks ?? [])) return;
      const into = (next: string) => {
        setMarkup(id, null);
        update((cur) => cur.map((x) => (x === id ? next : x)));
      };
      if (!marks.length) return into(original);
      updateDraft(key, (d) => ({ error: '', marking: [...d.marking, id] }));
      try {
        const next = await api.uploadImage(await markedImage(imageUrl(original), marks));
        setMarkup(next, { original, marks });
        into(next);
      } catch (e) {
        failed(e);
      } finally {
        updateDraft(key, (d) => ({ marking: d.marking.filter((x) => x !== id) }));
      }
    },
    /** After sending: the field is empty again, or without those sent while more were added. */
    clear: (sent?: string[]) => updateDraft(key, (d) => ({ images: sent ? d.images.filter((id) => !sent.includes(id)) : [] })),
    /** For the element screenshots may be dropped on. */
    drop: {
      onDragOver: (e: DragEvent) => {
        if (off || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDropping(true);
      },
      onDragLeave: () => setDropping(false),
      onDrop: (e: DragEvent) => {
        setDropping(false);
        const files = [...e.dataTransfer.files];
        if (off || !files.length) return;
        e.preventDefault();
        attach(files);
      },
    },
    /** For the text field: a pasted screenshot is attached instead of pasted as text, a file copied in the file manager goes in by its path. */
    onPaste: (e: ClipboardEvent) => {
      const files = [...e.clipboardData.files];
      if (off || !files.length) return;
      e.preventDefault();
      if (files.some(isImage)) pastedShots();
      attach(files);
    },
  };
}
export type ShotInput = ReturnType<typeof useShotInput>;

/**
 * The screenshots in a text field, each to enlarge and mark or to remove, and those still uploading;
 * after the first one picked from disk, the hint that pasting works too, until it is confirmed.
 */
export function ShotStrip({ shots }: { shots: ShotInput }) {
  const enlarge = useEnlarge(shots);
  if (!shots.images.length && !shots.uploading && !shots.pasteHint) return null;
  return (
    <div className="c-shots">
      {shots.images.map((id) => (
        <span key={id} className={shots.marking.includes(id) ? 'c-shot marking' : 'c-shot'}>
          <button className="open" title={t.shots.markUp} onClick={(e) => enlarge.open(id, e)}>
            <img src={imageUrl(id)} alt={t.shots.alt} />
          </button>
          <button className="remove" title={t.remove} onClick={() => shots.remove(id)}>
            ×
          </button>
        </span>
      ))}
      {Array.from({ length: shots.uploading }, (_, i) => (
        <span key={`u${i}`} className="c-shot loading">
          {t.shots.uploading}
        </span>
      ))}
      {shots.pasteHint && (
        <div className="c-paste-hint" role="note">
          <p>{t.shots.pasteHint(pasteKeys())}</p>
          <button className="btn small primary" onClick={confirmPasteHint}>
            {t.gotIt}
          </button>
        </div>
      )}
      {enlarge.view}
    </div>
  );
}

/** The button in the text field's corner that picks screenshots from disk. */
export function AttachButton({ shots, title = t.shots.attach }: { shots: ShotInput; title?: string }) {
  // the field the cursor stood in when the picker opened
  const typing = useRef<HTMLElement | null>(null);
  /**
   * Back from the picker (an image picked or none), the cursor goes back into that field: a phone took
   * its keyboard down for the picker, and focusing the field anew brings it up again.
   */
  const back = () => {
    const f = typing.current;
    typing.current = null;
    if (!f?.isConnected) return;
    f.blur();
    f.focus();
  };
  const backRef = useRef(back);
  backRef.current = back;
  useEffect(() => {
    const input = shots.picker.current;
    if (!input) return;
    const cancel = () => backRef.current();
    input.addEventListener('cancel', cancel);
    return () => input.removeEventListener('cancel', cancel);
  }, [shots.off]);
  if (shots.off) return null;
  return (
    <>
      <button
        className="c-attach"
        title={title}
        aria-label={title}
        // the cursor stays in the field: on a phone the keyboard stays up, and the field does not jump away from under the finger
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          const el = document.activeElement;
          typing.current = el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement ? el : null;
          shots.picker.current?.click();
        }}
      >
        <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
          <rect x="2.5" y="4" width="15" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <circle cx="7" cy="8.5" r="1.5" fill="currentColor" />
          <path d="M3.5 14.5 8 10.5l3 2.5 2.5-2 3 3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        </svg>
      </button>
      <input
        ref={shots.picker}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          // once they have arrived, the hint that pasting is quicker
          void shots.attach(imageFiles(e.target.files)).then((n) => n && pickedShots(shots.key));
          e.target.value = '';
          back();
        }}
      />
    </>
  );
}

/** Thumbnails of screenshots; a click shows one large, Esc or a click closes it. */
export function Shots({ ids }: { ids?: string[] }) {
  const enlarge = useEnlarge();
  if (!ids?.length) return null;
  return (
    <span className="shots">
      {ids.map((id) => (
        <button key={id} className="shot" title={t.shots.enlarge} onClick={(e) => enlarge.open(id, e)}>
          <img src={imageUrl(id)} alt={t.shots.alt} loading="lazy" />
        </button>
      ))}
      {enlarge.view}
    </span>
  );
}

/**
 * One screenshot of a row of thumbnails shown large: `open` from the click on its thumbnail, `view`
 * to render. Those of a field (`shots`) open to be marked: the original with its marks.
 */
function useEnlarge(shots?: ShotInput) {
  const [open, setOpen] = useState<{ id: string; thumb: HTMLImageElement } | null>(null);
  const markup = open && shots ? markupOf(open.id) : undefined;
  return {
    open: (id: string, e: MouseEvent<HTMLElement>) => {
      const thumb = e.currentTarget.querySelector('img');
      if (thumb) setOpen({ id, thumb });
    },
    view: open && (
      <Lightbox
        src={imageUrl(markup?.original ?? open.id)}
        thumb={open.thumb}
        marking={shots && { marks: markup?.marks ?? [], done: (marks) => void shots.mark(open.id, marks) }}
        onClose={() => setOpen(null)}
      />
    ),
  };
}

/** Set once the owner put a mark on a screenshot: the hint on how goes. */
const MARKS_KNOWN = 'obeya-marks-known';

/** The marks over the image, in its pixels (`w`×`h`), and the frame being drawn (`drawing`). */
function MarkLayer({ marks, w, h, drawing }: { marks: Mark[]; w: number; h: number; drawing?: Mark | null }) {
  const s = markSize(w, h);
  const all = [...marks, ...(drawing ? [drawing] : [])];
  const number = (i: number, x: number, y: number) => (
    <text x={x} y={y + s.font * 0.05} fill={EDGE} fontSize={s.font} fontWeight={700} fontFamily="system-ui, sans-serif" textAnchor="middle" dominantBaseline="central">
      {i + 1}
    </text>
  );
  return (
    <>
      {all.map((m, i) => {
        if (m.kind === 'pin')
          return (
            <g key={i}>
              <circle cx={m.x} cy={m.y} r={s.radius} fill={RED} stroke={EDGE} strokeWidth={s.edge * 2} />
              {number(i, m.x, m.y)}
            </g>
          );
        const b = badgeOf(m, s);
        const frame = roundedRect(m.x, m.y, m.w, m.h, b.frame);
        const badge = roundedRect(b.x, b.y, b.side, b.side, b.corners);
        // the white rim around frame and badge first, then their red over it, so none runs between them
        return (
          <g key={i} strokeLinejoin="round">
            <path d={frame} fill="none" stroke={EDGE} strokeWidth={s.line + 2 * s.edge} />
            <path d={badge} fill="none" stroke={EDGE} strokeWidth={s.edge * 2} />
            <path d={badge} fill={RED} />
            <path d={frame} fill="none" stroke={RED} strokeWidth={s.line} />
            {number(i, b.x + b.side / 2, b.y + b.side / 2)}
          </g>
        );
      })}
    </>
  );
}

/**
 * One image over the whole page, outside the panel, which the camera transforms. Like the demo
 * video's zoom (detail.tsx useZoom) it grows out of its thumbnail and goes back into it, wherever
 * that stands by then; Esc or a click closes it. With `marking` a drag on the image frames a
 * region and a click sets a numbered pin; Undo (⌘Z) takes back the last mark, and Done, Esc or a
 * click beside the image closes it with the marks.
 */
function Lightbox({ src, thumb, marking, onClose }: { src: string; thumb: HTMLImageElement; marking?: { marks: Mark[]; done: (marks: Mark[]) => void }; onClose: () => void }) {
  const img = useRef<HTMLImageElement>(null);
  /** The marks, laid over the image: its size and place, kept in step with it. */
  const layer = useRef<SVGSVGElement>(null);
  const [closing, setClosing] = useState(false);
  const [marks, setMarks] = useState(marking?.marks ?? []);
  const marksRef = useRef(marks);
  marksRef.current = marks;
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [drag, setDrag] = useState<{ a: Point; b: Point; from: Point; moved: number } | null>(null);
  const [marksKnown, knowMarks] = useKnown(MARKS_KNOWN);
  const add = (m: Mark) => {
    setMarks((cur) => [...cur, m]);
    knowMarks();
  };
  const undo = () => setMarks((cur) => cur.slice(0, -1));
  /** Where the pointer is on the image, in its pixels. */
  const onImage = (e: PointerEvent): Point => {
    const r = layer.current!.getBoundingClientRect();
    const k = size!.w / r.width;
    return { x: Math.max(0, Math.min(size!.w, (e.clientX - r.left) * k)), y: Math.max(0, Math.min(size!.h, (e.clientY - r.top) * k)) };
  };
  const place = () => {
    const el = img.current;
    const l = layer.current;
    if (!el || !l) return;
    Object.assign(l.style, { left: `${el.offsetLeft}px`, top: `${el.offsetTop}px`, width: `${el.offsetWidth}px`, height: `${el.offsetHeight}px` });
  };
  /** The image and the marks over it, which move as one. */
  const moving = () => [img.current, layer.current].filter((x): x is HTMLImageElement | SVGSVGElement => !!x);
  /** The transform and crop that put the large image onto its thumbnail, or none while the thumbnail is out of sight. */
  const onThumb = () => {
    const el = img.current!;
    const r = thumb.getBoundingClientRect();
    if (!thumb.isConnected || !r.width || !el.naturalWidth) return null;
    const { box, inset } = behindThumb({ left: r.left, top: r.top, width: r.width, height: r.height }, el.naturalWidth / el.naturalHeight);
    // where it stands large, untransformed (the lightbox covers the window from its corner)
    const large: Box = { left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight };
    return { transform: onto(box, large), clipPath: `inset(${inset.y * 100}% ${inset.x * 100}%)` };
  };
  const close = () => {
    if (closing) return;
    setClosing(true);
    setDrag(null);
    marking?.done(marksRef.current);
    const to = onThumb();
    if (!to) return onClose();
    // from where it is, also when still growing
    const { transform, clipPath } = getComputedStyle(img.current!);
    for (const el of moving()) {
      el.getAnimations().forEach((a) => a.cancel());
      const back = el.animate([{ transform, clipPath }, to], { duration: ZOOM_MS, easing: ZOOM_EASE, fill: 'forwards' });
      if (el === img.current) back.onfinish = onClose;
    }
  };
  const closeRef = useRef(close);
  closeRef.current = close;
  // grows out of its thumbnail, which stays hidden while it is out
  useLayoutEffect(() => {
    const el = img.current!;
    const grow = () => {
      setSize({ w: el.naturalWidth, h: el.naturalHeight });
      place();
      const from = onThumb();
      if (from) for (const x of moving()) x.animate([from, { transform: 'none', clipPath: 'inset(0)' }], { duration: ZOOM_MS, easing: ZOOM_EASE });
    };
    // a resized window resizes the image, and the marks with it
    const resized = new ResizeObserver(place);
    resized.observe(el);
    if (el.complete) grow();
    else el.addEventListener('load', grow, { once: true });
    thumb.style.visibility = 'hidden';
    return () => {
      el.removeEventListener('load', grow);
      resized.disconnect();
      thumb.style.visibility = '';
    };
  }, []);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
      // the undo of the marks, not of the text field behind
      if (marking && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        e.stopPropagation();
        undo();
      }
    };
    addEventListener('keydown', h, true);
    return () => removeEventListener('keydown', h, true);
  }, []);
  const drawing = drag && drag.moved >= CLICK_PX ? markOf(drag.a, drag.b, drag.moved) : null;
  return createPortal(
    // a click here is not one on the card or field the thumbnail sits in
    <div
      className={['lightbox', marking && 'marking', closing && 'closing'].filter(Boolean).join(' ')}
      title={marking ? undefined : t.close}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        close();
      }}
    >
      <img ref={img} src={src} alt={t.shots.alt} />
      {marking && (
        <>
          <svg
            ref={layer}
            className="lb-marks"
            viewBox={size ? `0 0 ${size.w} ${size.h}` : undefined}
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => {
              if (e.button !== 0 || !size || closing) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              const a = onImage(e);
              setDrag({ a, b: a, from: { x: e.clientX, y: e.clientY }, moved: 0 });
            }}
            onPointerMove={(e) => {
              if (!drag) return;
              const moved = Math.max(drag.moved, Math.hypot(e.clientX - drag.from.x, e.clientY - drag.from.y));
              setDrag({ ...drag, b: onImage(e), moved });
            }}
            onPointerUp={(e) => {
              if (!drag) return;
              setDrag(null);
              add(markOf(drag.a, onImage(e), drag.moved));
            }}
            onPointerCancel={() => setDrag(null)}
          >
            {size && <MarkLayer marks={marks} w={size.w} h={size.h} drawing={drawing} />}
          </svg>
          <div className="lb-bar" onClick={(e) => e.stopPropagation()}>
            {!marksKnown && <span className="lb-hint">{t.shots.markHint}</span>}
            <button className="btn" title={t.shots.undoTitle} disabled={!marks.length} onClick={undo}>
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <path d="M5.5 3 2.5 6l3 3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M3 6h6.5a4 4 0 0 1 0 8H7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
              {t.shots.undo}
            </button>
            <button className="btn primary" onClick={close}>
              {t.shots.done}
            </button>
          </div>
        </>
      )}
    </div>,
    document.body,
  );
}
