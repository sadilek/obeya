// Injected into every page of the plugin's headless Chromium (the browser skill's and the demo's).
// `--mute-audio` mutes only what Chrome plays itself: a page's `speechSynthesis` went to the
// system's voice and spoke out loud on the machine. Here it speaks nothing and goes on as if it
// had: utterances queue, each fires `start` and, after about as long as it would have taken to say,
// `end`; `pause`, `resume` and `cancel` fire the events of the spec. Voices, rates and the rest
// stay as the browser has them. They go on the prototype: WebKit drops the page's `speechSynthesis`
// object once nothing holds it and hands out a fresh one, without what was set on the old.
(() => {
  const synth = window.speechSynthesis;
  if (!synth || synth.__silent) return;
  const queue = [];
  let current = null;
  let timer = 0;
  let paused = false;
  let started = 0;
  let left = 0;
  const fire = (utterance, type, extra = {}) =>
    utterance.dispatchEvent(
      type === 'error'
        ? new SpeechSynthesisErrorEvent(type, { utterance, ...extra })
        : new SpeechSynthesisEvent(type, { utterance, charIndex: 0, elapsedTime: 0, ...extra }),
    );
  const finish = () => {
    const utterance = current;
    current = null;
    fire(utterance, 'end', { charIndex: utterance.text.length });
    next();
  };
  const run = () => {
    started = performance.now();
    timer = setTimeout(finish, left);
  };
  function next() {
    if (current || paused || queue.length === 0) return;
    current = queue.shift();
    // about 14 characters a second at rate 1, the pace of a system voice
    left = (current.text.length * 70) / (current.rate || 1);
    // the timer first: a handler of the event may pause or cancel
    run();
    fire(current, 'start');
  }
  Object.defineProperties(Object.getPrototypeOf(synth), {
    __silent: { value: true },
    speaking: { get: () => current !== null },
    pending: { get: () => queue.length > 0 },
    paused: { get: () => paused },
    speak: {
      value(utterance) {
        // not instanceof: an utterance from another frame of the page is one too
        if (Object.prototype.toString.call(utterance) !== '[object SpeechSynthesisUtterance]') throw new TypeError('speak needs a SpeechSynthesisUtterance');
        // as Chrome does: a page the user has not interacted with yet may not speak
        if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return void setTimeout(() => fire(utterance, 'error', { error: 'not-allowed' }));
        queue.push(utterance);
        setTimeout(next);
      },
    },
    cancel: {
      value() {
        const dropped = queue.splice(0);
        if (current) {
          clearTimeout(timer);
          const utterance = current;
          current = null;
          fire(utterance, 'error', { error: 'interrupted' });
        }
        for (const utterance of dropped) fire(utterance, 'error', { error: 'canceled' });
      },
    },
    pause: {
      value() {
        if (paused) return;
        paused = true;
        if (!current) return;
        clearTimeout(timer);
        left -= performance.now() - started;
        fire(current, 'pause');
      },
    },
    resume: {
      value() {
        if (!paused) return;
        paused = false;
        if (!current) return next();
        run();
        fire(current, 'resume');
      },
    },
  });
})();
