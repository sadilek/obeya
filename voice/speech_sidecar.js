// Spoken confirmations for Obeya: one osascript (JXA) process that keeps the default system voice
// loaded, so a sentence renders in about half a second instead of the second `say` needs to start.
//
// Reads JSON lines on stdin: {"id": ..., "text": "...", "path": "<file.aiff>"}.
// Writes JSON lines on stdout: {"id": ...} once the AIFF is written, or {"id": ..., "error": "..."}.

ObjC.import('AppKit');

function run() {
  const stdin = $.NSFileHandle.fileHandleWithStandardInput;
  const stdout = $.NSFileHandle.fileHandleWithStandardOutput;
  const write = (msg) => stdout.writeData($(`${JSON.stringify(msg)}\n`).dataUsingEncoding($.NSUTF8StringEncoding));
  const synth = $.NSSpeechSynthesizer.alloc.init;
  write({ ready: true });
  let buf = '';
  while (true) {
    const data = stdin.availableData;
    if (Number(data.length) === 0) return; // Obeya went away (the bridge gives lengths as strings)
    buf += $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const job = JSON.parse(line);
      try {
        if (!synth.startSpeakingStringToURL(job.text, $.NSURL.fileURLWithPath(job.path))) throw new Error('synthesizer refused');
        while (synth.isSpeaking) $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.01));
        write({ id: job.id });
      } catch (e) {
        write({ id: job.id, error: String(e) });
      }
    }
  }
}
