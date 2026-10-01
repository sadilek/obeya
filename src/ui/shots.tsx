// Screenshots in what the owner writes: pasted, dropped or picked, scaled down so the agent can
// read them, uploaded at once; shown as thumbnails that open large over the page.

import { type ClipboardEvent, type DragEvent, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ApiError, api, at } from './api';
import { errorText, t } from './strings';

const TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
/** The longest side the model looks at in detail; larger screenshots only cost upload and context. */
const MAX_SIDE = 2000;
/** What the server takes per image (the model's limit). */
const MAX_BYTES = 3_750_000;

/** The images among pasted or dropped files. */
export const imageFiles = (files: FileList | null | undefined) => [...(files ?? [])].filter((f) => f.type.startsWith('image/'));

/** A screenshot as the agent reads it: at most MAX_SIDE on its long side, PNG, or JPEG when that is too large. */
export async function prepareImage(file: Blob): Promise<Blob> {
  const bmp = await createImageBitmap(file).catch(() => null);
  // not an image the browser can read: the server says so
  if (!bmp) return file;
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  if (scale === 1 && TYPES.includes(file.type) && file.size <= MAX_BYTES) return file;
  const canvas = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  let blob = await canvas.convertToBlob({ type: 'image/png' });
  for (const quality of [0.9, 0.8, 0.65]) {
    if (blob.size <= MAX_BYTES) break;
    blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  }
  return blob;
}

export const imageUrl = (id: string) => at(`/images/${encodeURIComponent(id)}`);

/**
 * Screenshots going into a text field: pasted, dropped or picked, uploaded at once. `onChange`
 * hears every change the owner makes, so a card can keep them as they are added.
 */
export function useShotInput({ initial = [], onChange, off = false }: { initial?: string[]; onChange?: (ids: string[]) => void; off?: boolean } = {}) {
  const [images, setImages] = useState<string[]>(initial);
  const [uploading, setUploading] = useState(0);
  const [dropping, setDropping] = useState(false);
  const [error, setError] = useState('');
  const picker = useRef<HTMLInputElement>(null);
  const change = useRef(onChange);
  change.current = onChange;
  // only the owner's changes are passed on, not the initial screenshots
  const touched = useRef(false);
  useEffect(() => {
    if (touched.current) change.current?.(images);
  }, [images]);
  const update = (fn: (cur: string[]) => string[]) => {
    touched.current = true;
    setImages(fn);
  };
  const attach = async (files: File[]) => {
    if (off || !files.length) return;
    setError('');
    setUploading((n) => n + files.length);
    for (const f of files) {
      try {
        const id = await api.uploadImage(await prepareImage(f));
        update((cur) => [...cur, id]);
      } catch (e) {
        setError(e instanceof ApiError ? errorText(e.code) : t.offlineError);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };
  return {
    off,
    images,
    uploading,
    dropping,
    error,
    picker,
    attach,
    remove: (id: string) => update((cur) => cur.filter((x) => x !== id)),
    /** After sending: the field is empty again. */
    clear: () => setImages([]),
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
        const files = imageFiles(e.dataTransfer.files);
        if (off || !files.length) return;
        e.preventDefault();
        attach(files);
      },
    },
    /** For the text field: a pasted screenshot is attached instead of pasted as text. */
    onPaste: (e: ClipboardEvent) => {
      const files = imageFiles(e.clipboardData.files);
      if (off || !files.length) return;
      e.preventDefault();
      attach(files);
    },
  };
}
export type ShotInput = ReturnType<typeof useShotInput>;

/** The screenshots in a text field, each to remove, and those still uploading. */
export function ShotStrip({ shots }: { shots: ShotInput }) {
  if (!shots.images.length && !shots.uploading) return null;
  return (
    <div className="c-shots">
      {shots.images.map((id) => (
        <span key={id} className="c-shot">
          <img src={imageUrl(id)} alt={t.shots.alt} />
          <button title={t.shots.remove} onClick={() => shots.remove(id)}>
            ×
          </button>
        </span>
      ))}
      {Array.from({ length: shots.uploading }, (_, i) => (
        <span key={`u${i}`} className="c-shot loading">
          {t.shots.uploading}
        </span>
      ))}
    </div>
  );
}

/** The button in the text field's corner that picks screenshots from disk. */
export function AttachButton({ shots }: { shots: ShotInput }) {
  if (shots.off) return null;
  return (
    <>
      <button className="c-attach" title={t.shots.attach} aria-label={t.shots.attach} onClick={() => shots.picker.current?.click()}>
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
          shots.attach(imageFiles(e.target.files));
          e.target.value = '';
        }}
      />
    </>
  );
}

/** Thumbnails of screenshots; a click shows one large, Esc or a click closes it. */
export function Shots({ ids }: { ids?: string[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!ids?.length) return null;
  return (
    <span className="shots">
      {ids.map((id) => (
        <button key={id} className="shot" title={t.shots.enlarge} onClick={() => setOpen(id)}>
          <img src={imageUrl(id)} alt={t.shots.alt} loading="lazy" />
        </button>
      ))}
      {open && <Lightbox src={imageUrl(open)} onClose={() => setOpen(null)} />}
    </span>
  );
}

/** One image over the whole page; outside the panel, which the camera transforms. */
export function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    addEventListener('keydown', h);
    return () => removeEventListener('keydown', h);
  }, [onClose]);
  return createPortal(
    <div className="lightbox" title={t.shots.close} onClick={onClose}>
      <img src={src} alt={t.shots.alt} />
    </div>,
    document.body,
  );
}
