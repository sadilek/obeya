// Spoken confirmations for Obeya: one osascript (JXA) process that keeps the system voice loaded, so
// a sentence renders in about half a second instead of the second `say` needs to start. The default
// voice speaks unless its language is another than the text's: then the named voice of that language
// (`say`'s, Samantha for English), else the first one.
//
// Reads JSON lines on stdin: {"id": ..., "text": "...", "path": "<file.aiff>", "language": "en", "voice": "Samantha"}.
// Writes JSON lines on stdout: {"id": ...} once the AIFF is written, or {"id": ..., "error": "..."}.

ObjC.import('AppKit');

function run() {
  const stdin = $.NSFileHandle.fileHandleWithStandardInput;
  const stdout = $.NSFileHandle.fileHandleWithStandardOutput;
  const write = (msg) => stdout.writeData($(`${JSON.stringify(msg)}\n`).dataUsingEncoding($.NSUTF8StringEncoding));
  const synth = $.NSSpeechSynthesizer.alloc.init;
  const attribute = (voice, key) => String($.NSSpeechSynthesizer.attributesForVoice(voice).objectForKey(key).js || '');
  const speaks = (voice, language) => attribute(voice, 'VoiceLocaleIdentifier').toLowerCase().startsWith(language);
  // a synthesizer per language, the default one where its voice speaks it
  const synths = {};
  const synthFor = (language, name) => {
    if (!language || speaks($.NSSpeechSynthesizer.defaultVoice, language)) return synth;
    if (!(language in synths)) {
      const voices = $.NSSpeechSynthesizer.availableVoices.js.filter((v) => speaks(v, language));
      const voice = voices.find((v) => attribute(v, 'VoiceName') === name) ?? voices[0];
      synths[language] = voice ? $.NSSpeechSynthesizer.alloc.initWithVoice(voice) : synth;
    }
    return synths[language];
  };
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
        const s = synthFor(job.language, job.voice);
        if (!s.startSpeakingStringToURL(job.text, $.NSURL.fileURLWithPath(job.path))) throw new Error('synthesizer refused');
        while (s.isSpeaking) $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.01));
        write({ id: job.id });
      } catch (e) {
        write({ id: job.id, error: String(e) });
      }
    }
  }
}
