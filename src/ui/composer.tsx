// The field the owner writes in under a conversation, the same on a card and in Obeya's sheet: one
// frame with the text, the screenshot button and Send in its bottom corner, as wide as the
// conversation above it. The text grows with what is written, up to a part of the window.

import { useLayoutEffect, useRef, useState } from 'react';
import { api } from './api';
import { AttachButton, ShotStrip, useShotInput } from './shots';
import { t } from './strings';

/** What the owner writes to an agent or to Obeya; screenshots are pasted, dropped or picked, unless `noImages`. */
export function Composer({
  placeholder,
  onSend,
  button = t.send,
  allowEmpty = false,
  noImages = false,
  obeya,
  onText,
  className,
}: {
  placeholder: string;
  onSend: (text: string, images?: string[]) => Promise<void> | void;
  button?: string;
  allowEmpty?: boolean;
  noImages?: boolean;
  /** Obeya reads what is typed: it gets ready while the owner types; a text here says so under the field. */
  obeya?: true | string;
  /** Hears the text as it is typed. */
  onText?: (text: string) => void;
  className?: string;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const shots = useShotInput({ off: noImages });
  const images = shots.images;
  const field = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    // as high as the text; the stylesheet caps it, and beyond that it scrolls
    const el = field.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);
  const ready = (!!text.trim() || images.length > 0 || allowEmpty) && !busy && !shots.uploading;
  const send = async () => {
    if (!ready) return;
    setBusy(true);
    await onSend(text.trim(), images.length ? images : undefined);
    setBusy(false);
    setText('');
    onText?.('');
    shots.clear();
  };
  return (
    <div className={['composer', className, shots.dropping && 'dropping'].filter(Boolean).join(' ')} {...shots.drop}>
      <ShotStrip shots={shots} />
      <div className="c-field">
        <textarea
          ref={field}
          value={text}
          placeholder={placeholder}
          rows={1}
          onFocus={obeya ? () => api.warmVoice() : undefined}
          onChange={(e) => {
            setText(e.target.value);
            onText?.(e.target.value);
          }}
          onPaste={shots.onPaste}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="c-tools">
          <AttachButton shots={shots} />
          <button className="btn primary c-send" disabled={!ready} onClick={send}>
            {button}
          </button>
        </div>
      </div>
      {shots.error && <p className="p-error c-error">{shots.error}</p>}
      {typeof obeya === 'string' && <div className="c-listener">→ {obeya}</div>}
    </div>
  );
}
