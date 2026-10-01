// Screenshots the owner adds to what they write on a card: stored once under Obeya's home,
// shown in the card's log, and handed to the agent as images along with the text.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BadRequest } from './board';

const TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
/** What the model takes per image (5 MB base64); the browser scales screenshots down to fit. */
export const MAX_IMAGE_BYTES = 3_750_000;
/** Per message: enough to show a flow, few enough to keep the agent's context small. */
export const MAX_IMAGES = 6;
const NAME = /^[0-9a-f-]{36}\.(png|jpg|gif|webp)$/;

export class Images {
  constructor(private dir: string) {}

  /** Stores an uploaded image and returns its id (the file name). */
  save(bytes: Uint8Array, type: string): string {
    const ext = TYPES[type.split(';')[0]!.trim().toLowerCase()];
    if (!ext) throw new BadRequest('imageType', 'only PNG, JPEG, GIF or WebP images');
    if (!bytes.length) throw new BadRequest('imageType', 'empty image');
    if (bytes.length > MAX_IMAGE_BYTES) throw new BadRequest('imageTooLarge', `an image may have at most ${MAX_IMAGE_BYTES} bytes`);
    mkdirSync(this.dir, { recursive: true });
    const id = `${crypto.randomUUID()}.${ext}`;
    writeFileSync(join(this.dir, id), bytes);
    return id;
  }

  /** The file of a stored image, or null for anything else. */
  path(id: string): string | null {
    if (!NAME.test(id)) return null;
    const p = join(this.dir, id);
    return existsSync(p) ? p : null;
  }

  /** The files of images a message refers to; an unknown id is refused. */
  resolve(ids: unknown): string[] {
    if (ids === undefined) return [];
    if (!Array.isArray(ids) || ids.length > MAX_IMAGES) throw new BadRequest('invalid', `images must be a list of at most ${MAX_IMAGES} ids`);
    return ids.map((id) => {
      const p = typeof id === 'string' ? this.path(id) : null;
      if (!p) throw new BadRequest('invalid', 'unknown image');
      return p;
    });
  }
}

/** The media type of a stored image, from its file name. */
export function mediaType(file: string): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' {
  const ext = file.split('.').at(-1);
  return ext === 'jpg' ? 'image/jpeg' : (`image/${ext}` as 'image/png' | 'image/gif' | 'image/webp');
}

/** The note an agent's message gets about its images, so it can refer to them later. */
export function imageNote(files: string[]): string {
  if (!files.length) return '';
  return `\n\n${files.length === 1 ? 'The owner attached a screenshot' : `The owner attached ${files.length} screenshots`} (shown below; files: ${files.join(', ')}).`;
}
