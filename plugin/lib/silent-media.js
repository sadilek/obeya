// Injected into every page of a browser launched through the plugin's Playwright (`playwright.mjs`).
// WebKit has no switch that mutes the browser: a worker's script played a walkthrough's narration
// through the machine's speakers. Here every <audio> and <video> plays muted and Web Audio reaches
// the speakers at zero gain, while the page sees what it asked for: `muted` reads back the value it
// set, `play()` resolves, an AudioContext runs and its clock advances.
(() => {
  const Media = window.HTMLMediaElement;
  if (!Media || Media.prototype.__silent) return;
  const proto = Media.prototype;
  const native = Object.getOwnPropertyDescriptor(proto, 'muted');
  // what the page has set, and reads back; the element itself stays muted
  const wanted = new WeakMap();
  const silence = (el) => {
    if (!wanted.has(el)) wanted.set(el, native.get.call(el));
    if (!native.get.call(el)) native.set.call(el, true);
  };
  Object.defineProperty(proto, 'muted', {
    configurable: true,
    enumerable: native.enumerable,
    get() {
      return wanted.has(this) ? wanted.get(this) : native.get.call(this);
    },
    set(value) {
      wanted.set(this, !!value);
      native.set.call(this, true);
    },
  });
  const nativePlay = proto.play;
  Object.defineProperty(proto, 'play', {
    configurable: true,
    writable: true,
    value: function play() {
      silence(this);
      return nativePlay.call(this);
    },
  });
  // an element that plays without `play()` (autoplay, its own controls): muted as it starts loading,
  // long before it has anything to play; in the document the event reaches the window
  for (const type of ['loadstart', 'play']) window.addEventListener(type, (e) => e.target instanceof Media && silence(e.target), true);
  // one that is not in the document: muted as it is made
  const NativeAudio = window.Audio;
  if (NativeAudio) {
    const Audio = function Audio(...args) {
      const el = new NativeAudio(...args);
      silence(el);
      return el;
    };
    Audio.prototype = NativeAudio.prototype;
    window.Audio = Audio;
  }
  const createElement = Document.prototype.createElement;
  Document.prototype.createElement = function (...args) {
    const el = createElement.apply(this, args);
    if (el instanceof Media) silence(el);
    return el;
  };
  Object.defineProperty(proto, '__silent', { value: true });

  // Web Audio: what a page connects to the speakers goes through a gain of zero to them
  const Node = window.AudioNode;
  const Destination = window.AudioDestinationNode;
  if (!Node || !Destination) return;
  const { connect, disconnect } = Node.prototype;
  const sinks = new WeakMap();
  const live = (target) => target instanceof Destination && !(window.OfflineAudioContext && target.context instanceof OfflineAudioContext);
  const sink = (destination) => {
    let gain = sinks.get(destination);
    if (!gain) {
      gain = destination.context.createGain();
      gain.gain.value = 0;
      connect.call(gain, destination);
      sinks.set(destination, gain);
    }
    return gain;
  };
  Node.prototype.connect = function (target, ...rest) {
    if (!live(target)) return connect.call(this, target, ...rest);
    connect.call(this, sink(target), ...rest);
    return target;
  };
  Node.prototype.disconnect = function (...args) {
    if (live(args[0])) args[0] = sink(args[0]);
    return disconnect.apply(this, args);
  };
})();
