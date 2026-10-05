// What Obeya hands an adapter that lives outside this repository (in the repository it is for, at
// `.obeya/adapter/`, or at a path the configuration names): such a module cannot import Obeya's
// files by a relative path, so its default export gets them passed, `(kit) => adapter`. A script
// of the adapter that Obeya runs as a process of its own (the share command) imports this module
// from the path in `OBEYA_KIT`.

export { generic, repoName } from './generic';
export type { RepoAdapter, RepoInfo } from './types';
export { ARTIFACT_DIR, artifactFiles, artifactPageHtml, day, demoPageHtml, esc, PAGE_STYLE, withHeightReport } from '../server/demo-page';
