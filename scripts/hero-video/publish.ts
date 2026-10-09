// Publishes a rendered hero video to obeya.si: uploads `demo.mp4` and `captions.vtt` from the
// render's directory as `hero.mp4` and `hero.vtt` of the release `site-media` (creating the
// release the first time, replacing the assets after that), then runs the Pages workflow, which
// fetches them into site/media/. It acts as the GitHub account `sadilek` through GH_TOKEN, without
// switching the account gh has active. With `--poster` it first takes the poster
// (`site/img/hero-poster.jpg`) again from the new video; that file is in git and goes out with
// the next push of main.
//
//   node scripts/hero-video/publish.ts [--poster]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = 'sadilek/obeya';
const ACCOUNT = 'sadilek';
const RELEASE = 'site-media';
const OUT = process.env.HERO_OUT ?? path.join(os.homedir(), 'demos', 'obeya-hero');
const poster = process.argv.includes('--poster');

const video = path.join(OUT, 'demo.mp4');
const captions = path.join(OUT, 'captions.vtt');
for (const f of [video, captions]) {
  if (!fs.existsSync(f)) fail(`missing ${f}: render first (scripts/hero-video/README.md)`);
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', env });
  if (r.status !== 0) fail(`${cmd} ${args.slice(0, 2).join(' ')} failed`);
}

// without GH_TOKEN, which gh would hand back instead of the account's own token
const { GH_TOKEN: _, GITHUB_TOKEN: __, ...plain } = process.env;
const token = spawnSync('gh', ['auth', 'token', '--user', ACCOUNT], { encoding: 'utf8', env: plain });
if (token.status !== 0 || !token.stdout.trim()) fail(`no gh login for ${ACCOUNT}: gh auth login, then try again\n${token.stderr}`);
const env = { ...process.env, GH_TOKEN: token.stdout.trim() };

const posterFile = path.join(import.meta.dirname, '..', '..', 'site', 'img', 'hero-poster.jpg');
if (poster) {
  console.log('Taking the poster from the new video');
  run('uv', ['run', '--with', 'pillow', 'python', path.join(import.meta.dirname, 'poster.py'), video, posterFile]);
}

// gh names an asset after its file, so the files go up under their site names from a temp directory
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hero-publish-'));
try {
  const files = [path.join(tmp, 'hero.mp4'), path.join(tmp, 'hero.vtt')] as const;
  fs.copyFileSync(video, files[0], fs.constants.COPYFILE_FICLONE);
  fs.copyFileSync(captions, files[1], fs.constants.COPYFILE_FICLONE);
  const exists = spawnSync('gh', ['release', 'view', RELEASE, '--repo', REPO], { env, stdio: 'ignore' }).status === 0;
  if (exists) {
    console.log(`Replacing hero.mp4 and hero.vtt in the release ${RELEASE}`);
    run('gh', ['release', 'upload', RELEASE, ...files, '--clobber', '--repo', REPO], env);
  } else {
    console.log(`Creating the release ${RELEASE} with hero.mp4 and hero.vtt`);
    run('gh', ['release', 'create', RELEASE, ...files, '--repo', REPO, '--title', 'Site media',
      '--notes', 'Video for obeya.si, fetched by the Pages workflow.', '--prerelease', '--latest=false'], env);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('Running the Pages workflow');
run('gh', ['workflow', 'run', 'pages.yml', '--repo', REPO], env);
console.log(`Published: https://github.com/${REPO}/actions/workflows/pages.yml shows the run.`);
if (poster) console.log('The poster changed: commit site/img/hero-poster.jpg and push main, which publishes it.');
