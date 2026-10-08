// What the hero video says, scene by scene, in the order `demo.ts` plays them. Spoken in the owner's
// ElevenLabs voice (eleven_v4), which reads the audio tags in square brackets; captions leave them out.
// `command` is what the owner says into the microphone: the same clip goes into Obeya's voice input.

export const narration = {
  canvas:
    'This is Obeya, a canvas for directing coding agents. [short pause] Every task is a card on the wall. If your repository contains plan documents with several workstreams, they show up as projects. [short pause] The colour says whether an agent is working on a card, or whether the card needs you. [short pause] To add something, hold the space bar and say it.',
  command: 'Tipjar should split the bill. Add a field for how many people there are, and show what each person pays.',
  starts:
    'Obeya confirms in one line, with a few seconds to undo, and puts the task on the wall. [short pause] The coordinator checks it against the work already running, so that no two agents change the same code at once. [short pause] Then an agent starts on it, in a workspace of its own.',
  working:
    'Nobody needs to watch it. [short pause] It reads the code, writes the change and a test, runs the checks, and records a short demo of what it built.',
  demo: 'Then the card needs you. [short pause] It brings a narrated demo of the change and a short report. You judge the result by watching it, not by reading code.',
  approval:
    'If it is right, you approve it, and the change lands on main. [short pause] Feedback instead goes back to the agent, which works on it and comes back with a new demo.',
  proposals:
    'While they work, agents notice things beyond their task. They leave the task as it is and propose a new card, and you decide whether it gets built. [long pause] Not every thought is ready to be built, though. A rough idea goes on the wall as an idea, and you think it through with an agent first: it asks back, weighs the options and keeps a brief. [short pause] When an idea turns out too big for a single task, the agent plans it as a project, with a plan document and its workstreams.',
  room: 'Many cards run like this at once, each with its own agent, while you make the decisions. [short pause] Obeya is open source and runs on your machine, with the Claude Code you are logged in to, on your own subscription. [long pause] Of course, Obeya is built with Obeya. [short pause] And this video, too, was recorded by Obeya itself, the way its agents record the demo of every change. So it also shows you what such a demo looks like.',
};
