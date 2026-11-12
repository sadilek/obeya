// What a card's worker is told before it does anything: its instructions, and its task as the
// message that starts its session, for a card of the repository, a review card and a card in a
// folder without git.

import { basename } from 'node:path';
import { DEFAULT_DEMO_DIRECTORY } from '../../plugin/skills/demo/lib/settings.ts';
import { type Language, LANGUAGE_NAMES, ownersLanguage, repositoryLanguage } from '../core/locale';
import { dimensions } from '../core/page-tags';
import { type Harness, type Item, type Mock, type TaskAuthor, taskAuthor } from '../core/types';
import { decisionLog } from './advisor';
import type { Board } from './board';
import { DEMO_SKILL, DEMO_SKILL_FILE, demoSkillName, OBEYA_PLUGIN } from './demo';
import { HOST_DIR, hostName, remote } from './hosts';
import { fromJson, type StoredContribution } from './row';
import { TO_OBEYA } from './to-obeya';
import { folderOf, sharesOf, type WorkerOptions } from './worker-options';


/** What a worker hears of a card's task someone else than the owner wrote: its language tells nothing of the owner's (`ownersLanguage`). */
const TASK_BY: Record<Exclude<TaskAuthor, 'owner'>, string> = {
  plan: "The card's task comes from the project's plan doc, not from the owner: its language tells nothing about theirs.",
  coordinator: "Obeya's work retrospective wrote the card's task, not the owner: its language tells nothing about theirs.",
  idea: "The idea's agent wrote the card's task, not the owner: its language tells nothing about theirs.",
  proposal: "A worker proposed the card's task and the owner took it on: its language tells nothing about theirs.",
};

/** What the briefing needs of the workers: where a review card's PR head is fetched from, and the boards a card's proposals may be on. */
export interface BriefingHost {
  prSource(c: StoredContribution): string;
  proposalBoards(): Board[];
}

export class WorkerBriefing {
  constructor(
    private o: WorkerOptions,
    private w: BriefingHost,
  ) {}

  private get folder() {
    return folderOf(this.o);
  }

  private get shares() {
    return sharesOf(this.o);
  }

  /** The language of the card's demos (design: Language): the repository's, else the demo settings' narration language. */
  demoLanguage(): Language {
    return this.o.adapter.demo?.language ?? this.o.demoLanguage?.() ?? this.o.board.conversation();
  }

  system(preferences: string, harness: Harness, prototype = false, card?: Item): string {
    // a task the owner wrote is their first words to the worker; one an agent or a plan doc wrote is not
    const by = card?.body.trim() ? taskAuthor(card) : undefined;
    const language = by === 'owner' ? ownersLanguage(this.o.board.conversation(), "the card's task") : `${ownersLanguage(this.o.board.conversation())}${by ? ` ${TASK_BY[by]}` : ''}`;
    const folder = !!this.folder;
    return `
You are a worker agent directed through Obeya, a canvas on which the owner directs coding agents like an engineering director directs a team. ${
      folder
        ? 'You work on exactly one card, directly in a folder that is not a git repository. Other workers may work on other cards in the same folder at the same time, and so may the owner.'
        : 'You work on exactly one card, in a workspace of the repository (a clone or worktree) that belongs to that card, on your own branch. Other workers may work on other cards at the same time in their own workspaces.'
    }

The owner does not watch you work and does not read code. They see your card's conversation: your status lines, questions, replies and handovers. Talk to them only through the Obeya tools:
- report: a short status line at milestones.
- reply: your answer to a note or feedback from the owner, in a sentence or two: what you change because of it, or why nothing.
- ask: a decision that is not yours (product behaviour, trade-offs, anything irreversible or external). Make routine judgement calls yourself. After ask, end your turn; the answer arrives as the next message.
${prototype ? '- propose_build: propose that the idea be built on your prototype, once it convinced. You make no other cards; mention other problems you noticed in your summary.' : '- propose_card: a separate problem or idea you noticed, as a card for the agent who will take it on; do not widen your task. A follow-up to your task that is due only later becomes such a card too, with start_at. withdraw_proposal takes back one of yours that turned out wrong.'}
- ready_for_review: ${folder ? 'the work is done' : 'the work is committed'} and the checks pass. Then end your turn.${this.o.toObeya ? '\n- to_obeya: what the owner\'s words ask of Obeya rather than you.' : ''}

${
      folder
        ? "Obeya's messages tell you what happened: feedback, an answer, a note from the owner, your changes discarded, the approval. What to do about it is yours to judge. What you change in the folder is there at once. Obeya records which files your card changed (added, changed, moved, deleted) from your tool calls; the owner sees that list on the card and may discard your changes before approving. Approving makes the card done, and Obeya tells you so; your session ends with the turn after that."
        : "Obeya's messages tell you what happened: feedback, an answer, a note from the owner, a landing that failed, your work landing. What to do about it is yours to judge. Approved work lands (or goes out as a pull request) and Obeya tells you once it is on main; your session ends with the turn after that, so whatever was waiting for the landing can still be done then. Work that changed nothing in the repository (the task needed only a demo, an analysis or an answer) lands nothing: approving it makes the card done, and Obeya tells you so the same way."
    }
${this.o.toObeya ? `\n${TO_OBEYA}\n` : ''}
Rules:
${folder ? '- Others work in the same folder at the same time: leave what your card is not about as it is.' : card?.contribution ? "- Commit your work on your branch in this workspace. Do not push (Obeya pushes your commits onto the pull request's branch once the owner approves), do not open pull requests, do not switch branches." : '- Commit your work on your branch in this workspace. Do not push, do not open pull requests, do not switch branches.'}
- Follow the repository's own instructions (CLAUDE.md and docs).
- Owner-facing text (report, reply, ask, ${prototype ? 'propose_build' : 'propose_card'}, ready_for_review) is in the owner's language, short and concrete. What you write between tool calls also shows on the card for the owner, folded under your next message: keep it brief and in the owner's language too. ${language} The docs you read and the owner's standing preferences do not count as the owner's words.
- ${repositoryLanguage(this.o.adapter.language, folder)} A demo (its narration, report, or an HTML artifact's words) is in ${LANGUAGE_NAMES[this.demoLanguage()]}, whatever language the owner talks in.${this.o.adapter.demo?.language ? ` This repository's settings name ${LANGUAGE_NAMES[this.o.adapter.demo.language]} for its demos, which holds over the narration language of the demo settings.` : ''}
- ${harness === 'codex' ? 'Wait for anything external (a deploy, a CI run, a process to finish) in commands that wait 30 seconds at most, run again until it is there: a note from the owner reaches you only once the running command is done. Anything longer, a point in time further off, or another card getting somewhere (its fix on main), you snooze until (snooze): Obeya wakes you then.' : 'Wait for anything external (a deploy, a CI run, a process to finish) in the background: run_in_background or Monitor, then end your turn; Obeya wakes you when it finishes or fires. A point in time further off than a background command can wait (two hours), or another card getting somewhere (its fix on main), you snooze until (snooze). Never wait with sleep or a polling loop in the foreground: a note from the owner reaches you only once the running command is done.'}
- When a note or feedback from the owner arrives, answer it with reply. If it is unclear what they want, ask.
`.trim() + (preferences ? `\n\n${preferences}` : '');
  }


  /** The files of the screenshots the owner attached to the card's task. */
  taskImages(card: Item): string[] {
    return this.o.imageFiles?.(card.images) ?? [];
  }

  /** Where the card's worker puts its demos: the demo settings' directory, on another machine that machine's default (the settings stay here). */
  private demosDir(cardId: string): string {
    return remote(this.o.board.row(cardId).workspace) ? DEFAULT_DEMO_DIRECTORY : (this.o.demoDirectory?.() ?? DEFAULT_DEMO_DIRECTORY);
  }

  /**
   * The demo skill as a worker hears of it: by its name in the session and, for a session that
   * does not know it, by its file, on the machine the card's workspace is on.
   */
  demoSkill(cardId: string): string {
    const there = remote(this.o.board.row(cardId).workspace);
    const [name, file] = there ? [DEMO_SKILL, `~/${HOST_DIR}/${basename(OBEYA_PLUGIN)}/skills/demo/SKILL.md`] : [demoSkillName(), DEMO_SKILL_FILE];
    return `the demo skill (\`${name}\`; if your session does not know it, read its file ${file} and follow that)`;
  }

  /**
   * `headProblem`: on a review card's start, why its workspace is not on the PR's head (null where
   * it is), so the worker fetches it itself.
   */
  briefing(card: Item, branch: string, resumed = false, headProblem?: string | null): string {
    const parts = [`Your card: “${card.title}”.`];
    const contribution = fromJson(this.o.board.row(card.id).contribution);
    if (contribution) return this.reviewBriefing(card, contribution, branch, resumed, headProblem);
    const idea = card.prototypeOf ? this.o.board.card(card.prototypeOf) : undefined;
    if (card.prototypeOf)
      parts.push(
        [
          `This card is a throwaway prototype for the idea “${idea?.title ?? ''}”, so the owner can see the idea before deciding on it; other prototypes may try other approaches beside it. It never lands itself: the owner either discards it (its code is thrown away, its demo stays in the archive) or has the idea built on its branch, by a worker who takes over what carries and brings it to production quality.`,
          'So build only what the demo needs to show, as quickly as you can: no tests, no polish, no docs or plan changes, and do not run the checks. Commit it on your branch anyway, so the demo can be reproduced and the idea can be built on it. The demo only needs to make the idea visible: a video of 30–60 s, or an HTML artifact when the idea is something to look at (drafts of a logo, say).',
          "Your questions and the owner's answers also reach the idea's exploration agent, so ask on this card; the idea will not ask them again.",
          idea?.idea?.brief ? `The idea as discussed so far:

${idea.idea.brief}` : '',
          mocksText(idea?.idea?.mocks),
        ]
          .filter(Boolean)
          .join('\n\n'),
      );
    if (card.body.trim()) parts.push(`${card.body.trim()}${this.o.board.numbersNote(card.body, card.id)}`);
    // the owner's own words: the language the worker writes them in until they say more (`ownersLanguage`)
    if (card.body.trim() && taskAuthor(card) === 'owner') parts.push('The owner wrote this task themselves: write to them in its language.');
    if (card.mocks?.length) parts.push(mocksText(card.mocks));
    if (card.builtOn) parts.push(this.builtOnPrototype(card.builtOn, !!card.parent));
    // the card it follows up on may be on another canvas (a proposal from a worker there)
    const fromOn = (b: Board) => b.item(card.from!) ?? b.archived.entry(card.from!).find((i) => i.id === card.from);
    const fromBoard = card.from && !card.prototypeOf ? this.w.proposalBoards().find(fromOn) : undefined;
    const from = fromBoard && fromOn(fromBoard);
    if (fromBoard && from) {
      const summary = fromBoard.summary(from.id)?.trim();
      const there = fromBoard === this.o.board ? '' : ` on the canvas “${fromBoard.canvas.name}”`;
      parts.push(`This card follows up on the card “${from.title}”${there}.${summary ? ` Its worker handed it over with this summary:\n\n${summary}` : ''}`);
    }
    const shots = this.taskImages(card);
    if (shots.length)
      parts.push(`${shots.length === 1 ? 'The owner attached a screenshot' : `The owner attached ${shots.length} screenshots`} to the card (shown with this message; files: ${shots.join(', ')}).`);
    const project = card.parent ? this.o.board.item(card.parent) : undefined;
    if (project?.plan) parts.push(`This is workstream ${card.label ?? ''} of the project “${project.title}”. Read its plan doc ${project.plan.file} first; it holds the context and decisions.`);
    const decisions = project ? this.o.board.decisions(project.id) : [];
    if (decisions.length) parts.push(`Decisions taken in this project so far:\n${decisionLog(decisions)}`);
    const s = project?.plan ? fromJson(this.o.board.row(card.id).shipped) : null;
    if (s) {
      const what = [s.pr && `pull request #${s.pr.number} (${s.pr.url})`, s.commit && `commit ${s.commit.slice(0, 7)}`].filter(Boolean).join(', ');
      parts.push(
        `A part of this workstream has landed already${what ? ` (${what})` : ''}, but the plan doc keeps the workstream open. Look at what landed and do the rest.`,
      );
    }
    if (this.folder) return this.folderBriefing(card.id, parts, resumed);
    parts.push(
      card.builtOn
        ? `You are on branch ${branch}, which holds the prototype's commits (and any earlier work on this card): look at its log and diff first.`
        : resumed
          ? `You are on branch ${branch}, which already holds earlier work on this card, perhaps uncommitted: look at its log, \`git status\` and diff first and go on from there.`
          : `You are on branch ${branch}, fresh from the default branch.`,
    );
    if (this.o.adapter.setup) parts.push(`First run \`${this.o.adapter.setup}\` in the clone.`);
    if (fromJson(this.o.board.row(card.id).new_repo)?.made)
      parts.push(
        `This repository is new: Obeya created it for this card with a first commit of what its folder held (a default .gitignore, else nothing). It is local only, with no remote. Besides the task, set it up as part of your work: a CLAUDE.md with what the task says about how to work in this repository, and its Obeya settings (\`.obeya/settings.json\`) with the skill \`obeya:settings\`, as the card “${this.o.board.t.adapterSetup.title(basename(this.o.repoPath ?? ''))}” would.`,
      );
    const { run, stop } = this.o.adapter.app ?? {};
    const parking = stop ? ' While the card waits for the owner, Obeya stops the app in your workspace; your next message then says so.' : '';
    const far = hostName(this.o.board.row(card.id).workspace) ? " (this workspace is on another machine: Obeya forwards that address's port, and only that one, to the owner's)" : '';
    const tryIt = ` Once it runs and opens in a browser, give its address with app_running, so the owner can try it by hand from the card${far}.`;
    if (run?.trim()) parts.push(`How to run the app: ${run.trim()}${parking}${tryIt}`);
    else parts.push(`${parking}${tryIt}`.trim());
    if (this.o.adapter.checks?.length && !card.prototypeOf) parts.push(`Before ready_for_review, run: ${this.o.adapter.checks.map((c) => `\`${c}\``).join(', ')}.`);
    parts.push(
      [
        `Then show the owner the result with a demo, so they can judge at a glance whether the work is done, and hand it over with ready_for_review.`,
        `Usually that is a video of the change, recorded with ${this.demoSkill(card.id)} as its instructions say (directory, chapter titles). Its length follows the size of the change, never padded: 30–60 s for a small one (a fix: the broken behaviour, then the fixed one), 1½–3 min for a larger one.${this.shares ? ` The owner may share the demo, a video or an HTML artifact, with colleagues of the team on a page of its own: hand it over with that page (title, text${dimensions(this.o.adapter.demo?.site?.tags).length ? ', tags' : ''}), written for them.` : ''} ${run?.trim() ? 'Run the app for it as the recipe above says.' : "The repository's settings say nothing yet about how to run the app: find it out from the repository (README, scripts, configuration) and say in your summary how you ran it."}`,
        `When the result is something to look at rather than something that happens (drafts of a logo or a layout side by side, a comparison of variants, an analysis, an answer), make an HTML artifact instead: an index.html in a new directory under ${this.demosDir(card.id)} (never in git), self-contained or with the files it loads beside it, made for the owner to decide on, and hand it over with kind 'html' (drafts the owner is to choose from before you go on come with ask's demo instead). It shows in a sandboxed frame on the card, about 800 px wide, without Obeya's API.`,
        'Where either would do, record the video: watching the work happen is what the owner enjoys most.',
        "Where the work itself is a file for the owner (a document, a report, a spreadsheet in the repository), name it in ready_for_review's files: the card shows it beside the demo.",
      ].join(' '),
    );
    return parts.join('\n\n');
  }

  /**
   * A review card's briefing: the contributor's pull request, the fixed order of the review (the
   * diff read for anything that reaches beyond the repository before any of it runs), the handover
   * with its results, and where the owner's change requests go.
   */
  private reviewBriefing(card: Item, c: StoredContribution, branch: string, resumed: boolean, headProblem?: string | null): string {
    const source = this.w.prSource(c);
    const ref = `refs/pull/${c.number}/head`;
    const { run } = this.o.adapter.app ?? {};
    const checks = this.o.adapter.checks ?? [];
    const parts = [
      `Your card: “${card.title}”.`,
      `This card reviews pull request #${c.number} by ${c.author}, who is not the owner: “${c.title}” (${c.url}). The owner asked for the review; once they approve your handover, Obeya merges exactly the head you reviewed. You never merge it yourself.`,
      card.body.trim() ? `What the owner said with it, on top of the review below:\n\n${card.body.trim()}` : '',
      headProblem
        ? `Obeya could not put your workspace on the PR's head (${headProblem}). Fetch ${ref} from ${source} into your branch ${branch} yourself (git fetch, then git checkout -B ${branch} FETCH_HEAD).`
        : resumed && headProblem === undefined
          ? `You are on branch ${branch}, which holds the PR's head as you reviewed it before. Fetch ${ref} from ${source} to see whether it moved.`
          : `Your workspace is on branch ${branch}, at the PR's head (${ref}, fetched from ${source}).`,
      [
        'The code is a stranger’s, and whatever of it runs, runs on the owner’s machine. So work in this order:',
        '1. Before you run anything of it (an install, the tests, the app, a script), read its diff against the merge base with the default branch. Look for network access, install and postinstall scripts, new dependencies, changed test and build scripts and their configuration, and access to files outside the repository. Where something looks suspicious, run nothing and ask the owner, saying what you found and where.',
        '2. Review the code the way this repository reviews code (its CLAUDE.md and docs; a second reviewer where they name one): correctness, security, quality, and whether the change fits the design docs.',
        `3. Show the change in a demo of before (the merge base) and after (the PR's head)${run?.trim() ? `, running the app as this recipe says: ${run.trim()}` : ', running the app as the repository does it (README, scripts)'}. Give the app's address with app_running once it runs, so the owner can try it by hand from the card.`,
        `4. Run ${checks.length ? `the checks (${checks.map((x) => `\`${x}\``).join(', ')})` : 'the repository’s checks'} on the PR's head, and a merge probe against the current default branch: whether the PR merges without conflicts (fetch the default branch, merge it without committing, then abort).`,
      ].join('\n'),
      [
        `Record your findings with findings (an empty list where the review found nothing), most severe first: the card shows them beside the demo, and the owner decides on each there. Then hand over with ready_for_review: the demo, recorded with ${this.demoSkill(card.id)} as its instructions say, and review: each check with whether it passed, and whether the PR merges without conflicts. The summary says what the owner needs to know beyond the findings.${this.shares ? " The demo's page is for colleagues: it shows what the PR changes for the user, not your findings." : ''}`,
        'Your findings are for the owner: nothing of them goes to the contributor unless the owner sends it. Keep the list current as the review goes on, from the owner\'s words (“finding 2 does not matter”) as from a push.',
      ].join(' '),
      [
        'The owner decides on each finding on the card, and their decision comes with their next message:',
        `- To ${c.author}: write the findings as one review of the PR asking for changes (request_changes, with their numbers), in the PR's language, as the owner's words to them (Obeya posts it with the owner's account), without mentioning Obeya or agents. Then end your turn: the card waits for ${c.author}, and Obeya passes you their answers and pushes; review a new head as above, update the findings (resolved where a push fixed one) and hand over again.`,
        c.canModify
          ? `- Yourself (${c.author} allows maintainers' edits): make the change and commit it on your branch, run the checks, mark the finding fixed, and hand over again with a new demo and pr_draft, the text that goes onto the PR with your commits (what you changed and why, in the PR's language, as the owner's words, without mentioning Obeya or agents). Once the owner approves, Obeya pushes your commits onto the PR's branch and posts the text. Findings for ${c.author} decided together with yours, or while yours wait for the owner, go with them in the same text, not with request_changes. In the squash merge ${c.author} stays its author.`
          : `- ${c.author} does not allow maintainers' edits, so findings go to them or become follow-up tasks.`,
        '- As a follow-up task: you make it a task of its own beside your card, outside this PR (follow_up_task), which marks it later in your findings. Findings that belong together become one task: as the owner\'s words say first, else as you bundled them in your findings (with), so bundle there only what one worker would sensibly do in one go.',
        '- Ignored: Obeya marks it dropped in your findings; nothing is to be done for it.',
        'Words of the owner\'s that ask the same in so many words (“send them finding 1”, “fix that yourself”) count the same. Anything else they say (a question, more to look at) you answer or do on the card, and nothing goes to the PR.',
      ].join('\n'),
    ];
    return parts.filter(Boolean).join('\n\n');
  }

  /** The end of the briefing in a folder without git: where the card works, and how it hands over without a branch. */
  private folderBriefing(cardId: string, parts: string[], resumed: boolean): string {
    const changed = this.folder!.changed(cardId).length;
    parts.push(
      `You work directly in the folder ${this.o.board.row(cardId).workspace}, which is not a git repository: what you change there is there at once, for everyone.${resumed && changed ? ` Your card changed ${changed === 1 ? 'one file' : `${changed} files`} there before; the card lists them.` : ''}`,
    );
    if (this.o.adapter.setup) parts.push(`First run \`${this.o.adapter.setup}\` in the folder.`);
    const run = this.o.adapter.app?.run?.trim();
    if (run) parts.push(`How to run the app: ${run} Once it runs and opens in a browser, give its address with app_running, so the owner can try it by hand from the card.`);
    if (this.o.adapter.checks?.length) parts.push(`Before ready_for_review, run: ${this.o.adapter.checks.map((c) => `\`${c}\``).join(', ')}.`);
    parts.push(
      [
        'Then hand it over with ready_for_review: your summary says what you did and what the owner needs to know, and its files name the files your card made or changed that are the result for the owner (a document, a report, a spreadsheet), which the card shows first. The card shows the owner what you changed in the folder, file by file (added, changed, moved, deleted, with the changed lines of text files), and they may discard those changes before approving.',
        `A demo is needed only where something can be seen: a draft or an overview to look at as an HTML artifact (an index.html in a new directory under ${this.demosDir(cardId)}, outside the folder, self-contained or with the files it loads beside it, made for the owner to decide on), handed over with kind 'html'; something that happens on screen as a video, recorded with ${this.demoSkill(cardId)}.`,
      ].join(' '),
    );
    return parts.join('\n\n');
  }

  /** What the worker of an idea, or of a workstream of the project it became, built on a prototype hears of it: what the branch holds, the prototype's handover and the owner's answers on it. */
  private builtOnPrototype(prototypeId: string, workstream: boolean): string {
    const prototype = this.o.board.card(prototypeId);
    const summary = this.o.board.summary(prototypeId)?.trim();
    const answers = this.o.board.decisionsOn(prototypeId);
    return [
      `${workstream ? 'The plan doc builds this workstream' : 'The owner chose to build this idea'} on the prototype “${prototype?.title ?? ''}”${workstream ? `, one of those built for the idea the project came from` : ''}, and your branch is that prototype's. It is a throwaway prototype: built quickly to show the idea, without tests, polish or docs, with shortcuts. Take over what carries and bring it to production quality: tests, the repository's checks, the design doc and other docs, shortcuts removed. Rewrite or drop what does not hold up; nothing on the branch counts as reviewed code. The task is ${workstream ? 'the workstream as its plan doc describes it' : "the idea's brief above"}; the prototype is a means to it, not the result.`,
      summary ? `The prototype's worker handed it over with this summary:\n\n${summary}` : '',
      answers.length ? `What the owner answered on the prototype:\n${answers.map((d) => `- ${d.question} → ${d.answer}`).join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
  }
}

/** The mocks of an idea's brief as a worker reads them, after the brief they belong to. */
function mocksText(mocks: Mock[] | undefined): string {
  if (!mocks?.length) return '';
  return ['Mocks of the brief, as the owner saw them rendered (how its variants look):', ...mocks.map((m) => `${m.title || 'Mock'}:\n\n\`\`\`html\n${m.html}\n\`\`\``)].join('\n\n');
}
