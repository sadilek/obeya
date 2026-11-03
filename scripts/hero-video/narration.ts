// What the hero video says, scene by scene, in the order `demo.ts` plays them. Spoken in the owner's
// ElevenLabs voice (eleven_v4), which reads the audio tags in square brackets; captions leave them out.
// `command` is what the owner says into the microphone, `dictation` what they say into Obeya's text
// field, `comments` holds what they say about the demo video: the same clip goes into Obeya's voice input.

export const narration = {
  canvas:
    'This is Obeya, a canvas for directing coding agents. [short pause] Every task is a card on the wall. If your repository contains plan documents with several workstreams, they show up as projects. [short pause] The colour says whether an agent is working on a card, or whether the card needs you.',
  arrange:
    'You lay out the wall the way you think about the work. [short pause] Draw a lasso around cards to put them in a group, and give it a name. [short pause] Drag cards wherever you want them. [short pause] To add something, hold the space bar and say it.',
  command: 'Tipjar should split the bill. Add a field for how many people there are, and show what each person pays.',
  starts:
    'Obeya confirms in one line, with a few seconds to undo, and puts the task on the wall. [short pause] It checks the task against the work already running, so that no two agents change the same code at once. [short pause] Then an agent starts on it, in a workspace of its own.',
  sidebar:
    'What you say on the canvas goes to Obeya, and its sidebar keeps the conversation. [short pause] You can also type into the chat. One message can mix typed words, pasted text, a screenshot, and your voice:',
  dictation: 'It should also accept a comma as the decimal point.',
  preferences:
    'Below the chat are your preferences, the rules every agent follows. [short pause] Obeya also proposes new ones itself, from how you answer and decide. Once you accept one, every agent follows it.',
  working:
    'Nobody needs to watch the agents. [short pause] Each one reads the code, writes the change and a test, runs the checks, and then shows what it built: in a short video, or in another artifact that fits the work. [short pause] Like every chat in Obeya, the card stays compact: what the agent does along the way folds away under its history.',
  demo: 'Then the card needs you. [short pause] It brings a narrated demo of the change and a short report. You judge the result by watching it, not by reading code.',
  comments:
    'If you have something to say about a moment in the video, hold the space bar while it plays and say it. [long pause] Start the number of people at two. [long pause] You can add comments as often as you like, whenever you notice something. [long pause] Show what each person pays in bold. [long pause] Your comments wait until you have watched to the end. Then they go to the agent together, each with its place in the video.',
  feedback: 'The agent works them in, and comes back with a new demo.',
  approval: 'If it is right, you approve it.',
  landed: 'The change you approved has landed. [short pause] Splitting the bill is on main now, and its card says Live.',
  proposals:
    'While they work, agents notice things beyond their task. They leave the task as it is and propose a new card, and you decide whether it gets built. [short pause] And Obeya itself, the one you talk to in the sidebar, proposes cards too: in regular retrospectives it looks back at how the agents worked, and where they keep stumbling, it suggests a fix. [long pause] Not every thought is ready to be built right away, though. A rough idea goes on the wall as an idea, and you think it through with an agent first: it asks back, weighs the options and keeps a brief. [short pause] It also suggests the next step itself. [short pause] This idea is too big for a single task, so it can be planned as a project, with a plan document and its workstreams.',
  room: 'Many cards run like this at once, each with its own agent, while you make the decisions. [short pause] Obeya is open source and runs on your machine, with the Claude Code or Codex you are logged in to, on your own subscription. [short pause] And it comes with you: pair your phone, and when something needs you, Obeya lets you know. You watch the demo, answer by voice, and approve, wherever you are. [long pause] Of course, Obeya is built with Obeya. [short pause] And this video, too, was recorded by Obeya itself, the way its agents record the demo of every change. So it also shows you what such a demo looks like.',
};
