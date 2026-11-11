// The legend of mouse and keys: a box over the greyed page, opened by `?` or the button in the bar.

import { Fragment } from 'react';
import { Over } from './over';
import { t } from './strings';
import { WishLink } from './wish';

/** The `?` button in the bar. */
export function HelpButton({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button className={on ? 'pill help on' : 'pill help'} title={t.help.button} aria-label={t.help.button} onClick={onClick}>
      ?
    </button>
  );
}

/**
 * The legend, with the link to the draft for Obeya's makers at its foot; a click beside it, Esc or `?` closes it. `note` is its foot while the bar still has the
 * button: opened by the button it says the key goes away with the button, opened by the key for the
 * first time it says the button has gone.
 */
export function Help({ onClose, note }: { onClose: () => void; note?: 'button' | 'gone' }) {
  return (
    <Over id="help" label={t.help.title} onClose={onClose}>
      <h2>{t.help.title}</h2>
      <div className="sections">
        {t.help.sections.map((s) => (
          <section key={s.title}>
            <h3>{s.title}</h3>
            <ul>
              {s.rows.map((r) => (
                <li key={r.text}>
                  <span>{r.text}</span>
                  <span className="keys">
                    {r.keys.map((combo, i) => (
                      <Fragment key={i}>
                        {i > 0 && <span className="or">{t.help.or}</span>}
                        {combo.map((k, j) => (
                          <Fragment key={j}>
                            {j > 0 && <span className="plus">+</span>}
                            <kbd>{k}</kbd>
                          </Fragment>
                        ))}
                      </Fragment>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      {/* what the owner misses goes to Obeya's makers; the legend closes for the draft */}
      <p className="wish-line">
        <WishLink onOpen={onClose} />
        <span className="w-legend">{t.wish.legend}</span>
      </p>
      {note && <p className="key-note">{note === 'button' ? t.help.keyNote.button : t.help.keyNote.gone}</p>}
    </Over>
  );
}

/** Set once the owner opened the legend with `?`: the bar's `?` button goes. */
export const HELP_KEY_KNOWN = 'obeya-help-key-known';

/** Set once the owner created a task by double-click on the canvas: the bar's button for a new task goes. */
export const DOUBLE_CLICK_KNOWN = 'obeya-double-click-known';

/** Set once the owner opened the search with `/`: the bar's button that teaches the key goes. */
export const SEARCH_KEY_KNOWN = 'obeya-search-key-known';

/**
 * What a bar's button that teaches a way of doing something opens (a task by double-click, the
 * search by `/`): how, and that the button goes after the first time; a click beside it, Esc or its button closes it.
 */
export function HowToHint({ label, text, onClose }: { label: string; text: string; onClose: () => void }) {
  return (
    <Over id="help" label={label} onClose={onClose} boxClass="hint-box" close={false}>
      <p>{text}</p>
      <button className="btn primary" autoFocus onClick={onClose}>
        {t.gotIt}
      </button>
    </Over>
  );
}
