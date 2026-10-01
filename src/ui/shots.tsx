// Screenshots in what the owner writes: pasted, dropped or picked, scaled down so the agent can
// read them, uploaded at once; shown as thumbnails that open large over the page.

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { at } from './api';
import { t } from './strings';

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
