// The container of the sheets on the right: a column docked to the window's edge, from top to
// bottom, that slides in and out. The canvas is what remains to its left (`--side`, set by App),
// and one is open at a time: Obeya's chat, a project's, the inbox.

import { forwardRef, type ReactNode } from 'react';

export const Docked = forwardRef<HTMLElement, { id: string; on: boolean; className?: string; label?: string; children: ReactNode }>(function Docked({ id, on, className, label, children }, ref) {
  return (
    <aside id={id} ref={ref} className={['sheet', on && 'on', className].filter(Boolean).join(' ')} aria-label={label}>
      {children}
    </aside>
  );
});
