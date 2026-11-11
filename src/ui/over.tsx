// A dialog over the greyed page: its box, and the ✕ in its corner. A press beside the box closes it
// (one that starts in the box, as when selecting its text, does not).

import { type ReactNode, useRef } from 'react';
import { t } from './strings';

export function Over({ id, label, onClose, boxClass, close = true, modal, children }: {
  /** What the dialog's own look (width, columns) goes by. */
  id?: string;
  label: string;
  onClose: () => void;
  boxClass?: string;
  /** Without, the box has no ✕: a button of its own closes it. */
  close?: boolean;
  modal?: boolean;
  children: ReactNode;
}) {
  const pressed = useRef(false);
  return (
    <div id={id} className="dimmed" onPointerDown={(e) => (pressed.current = e.target === e.currentTarget)} onClick={(e) => pressed.current && e.target === e.currentTarget && onClose()}>
      <div className={boxClass ? `box ${boxClass}` : 'box'} role="dialog" aria-modal={modal} aria-label={label}>
        {close && (
          <button className="close" title={t.close} onClick={onClose}>
            ✕
          </button>
        )}
        {children}
      </div>
    </div>
  );
}
