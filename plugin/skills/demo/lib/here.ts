// The directory this skill's files are in. Obeya's compiled server carries the modules it imports
// (the setup check, the voices) inside its binary, where `import.meta.dirname` names a directory
// no other process can read; the server then says where the files are on disk (`useLib`).
//
// Plain Node with type stripping, like the director.

import path from 'node:path';

let dir = import.meta.dirname;

/** The skill's files are in `lib`, not where these modules run from. */
export function useLib(lib: string) {
  dir = lib;
}

/** A file of the skill's `lib` directory. */
export const lib = (...parts: string[]) => path.join(dir, ...parts);

