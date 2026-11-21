// Screenshots the owner adds to what they write on a card: stored once under Obeya's home,
// shown in the card's log, and handed to the agent as images along with the text.

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { IMAGE_TYPES, MAX_IMAGE_BYTES, MAX_IMAGES } from '../core/types';
import { BadRequest } from './board';

export { MAX_IMAGES };
const NAME = /^[0-9a-f-]{36}\.(png|jpg|gif|webp)$/;

export class Images {
  constructor(private dir: string) {}

  /** Stores an uploaded image and returns its id (the file name). */
  save(bytes: Uint8Array, type: string): string {
    const ext = IMAGE_TYPES[type.split(';')[0]!.trim().toLowerCase()];
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

  /** Copies the images (ids) it has into `other`, which then has them under the same ids. */
  copyTo(other: Images, ids: string[]) {
    for (const id of new Set(ids)) {
      const from = this.path(id);
      if (!from || other.path(id)) continue;
      mkdirSync(other.dir, { recursive: true });
      copyFileSync(from, join(other.dir, id));
    }
  }

  /** The files of images a message refers to; an unknown id is refused. */
  resolve(ids: unknown): string[] {
    if (ids === undefined) return [];
    if (!Array.isArray(ids)) throw new BadRequest('invalid', 'images must be a list of ids');
    if (ids.length > MAX_IMAGES) throw new BadRequest('tooManyImages', `a message may have at most ${MAX_IMAGES} screenshots`);
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
