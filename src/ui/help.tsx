// The legend of mouse and keys: a box over the greyed page, opened by `?` or the button in the bar.

import { Fragment } from 'react';
import { t } from './strings';

/** The `?` button in the bar. */
export function HelpButton({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button className={on ? 'pill help on' : 'pill help'} title={t.help.button} aria-label={t.help.button} onClick={onClick}>
      ?
    </button>
  );
}

/** The legend; a click beside it, Esc or `?` closes it. */
export function Help({ onClose }: { onClose: () => void }) {
  return (
    <div id="help" onClick={onClose}>
      <div className="box" role="dialog" aria-label={t.help.title} onClick={(e) => e.stopPropagation()}>
        <button className="close" title={t.close} onClick={onClose}>
          ✕
        </button>
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
      </div>
    </div>
  );
}
