// The platforms Obeya is built and released for, in one table: scripts/build.ts compiles the server
// for them, scripts/build-app.ts bundles and signs the app, scripts/release.ts collects the
// installers, scripts/check-update.ts installs the update, scripts/release-status.ts checks a draft.

import { join } from 'node:path';
import { endingIn } from './common';

/** A file Tauri's bundler leaves: in which directory of the bundle, ending in what, and its name in the release. */
export type Asset = { from: string; ends: string; name: string };

type Platform = {
  /** Rust's target triple, which Tauri builds and names the sidecar for. */
  triple: string;
  /** The updater's name for it, in latest.json. */
  platform: string;
  installers: Asset[];
  /** What the updater installs, signed with a `.sig` beside it. */
  update: Asset;
};

export const TARGETS = {
  'darwin-arm64': {
    triple: 'aarch64-apple-darwin',
    platform: 'darwin-aarch64',
    installers: [{ from: 'dmg', ends: '.dmg', name: 'Obeya-macOS-arm64.dmg' }],
    update: { from: 'macos', ends: '.app.tar.gz', name: 'Obeya-macOS-arm64.app.tar.gz' },
  },
  'darwin-x64': {
    triple: 'x86_64-apple-darwin',
    platform: 'darwin-x86_64',
    installers: [{ from: 'dmg', ends: '.dmg', name: 'Obeya-macOS-x64.dmg' }],
    update: { from: 'macos', ends: '.app.tar.gz', name: 'Obeya-macOS-x64.app.tar.gz' },
  },
  'windows-x64': {
    triple: 'x86_64-pc-windows-msvc',
    platform: 'windows-x86_64',
    installers: [{ from: 'nsis', ends: '-setup.exe', name: 'Obeya-Windows-x64-setup.exe' }],
    update: { from: 'nsis', ends: '-setup.exe', name: 'Obeya-Windows-x64-setup.exe' },
  },
  'linux-x64': {
    triple: 'x86_64-unknown-linux-gnu',
    platform: 'linux-x86_64',
    installers: [
      { from: 'appimage', ends: '.AppImage', name: 'Obeya-Linux-x86_64.AppImage' },
      { from: 'deb', ends: '.deb', name: 'obeya_amd64.deb' },
    ],
    update: { from: 'appimage', ends: '.AppImage', name: 'Obeya-Linux-x86_64.AppImage' },
  },
  'linux-arm64': {
    triple: 'aarch64-unknown-linux-gnu',
    platform: 'linux-aarch64',
    installers: [
      { from: 'appimage', ends: '.AppImage', name: 'Obeya-Linux-aarch64.AppImage' },
      { from: 'deb', ends: '.deb', name: 'obeya_arm64.deb' },
    ],
    update: { from: 'appimage', ends: '.AppImage', name: 'Obeya-Linux-aarch64.AppImage' },
  },
} satisfies Record<string, Platform>;

export type Target = keyof typeof TARGETS;

export const isTarget = (t: string): t is Target => Object.hasOwn(TARGETS, t);

/** What `t` is not, for a script that was given it: the targets there are. */
export const unknownTarget = (t: string) => `unknown target ${t} (known: ${Object.keys(TARGETS).join(', ')})`;

/** This machine's target. */
export const here = () => `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}` as Target;

/** Where `asset` lies in `bundle` (Tauri's bundle directory), if it is there. */
export const bundled = (bundle: string, asset: Pick<Asset, 'from' | 'ends'>) => endingIn(join(bundle, asset.from), asset.ends);
