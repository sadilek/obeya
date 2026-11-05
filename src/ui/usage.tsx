// The plans' usage limits in the bar: every limit of each plan with a login as a thin meter, one
// above the other in the list's order, in the grade the usage endpoint gives it, without labels or
// numbers, beside the harness's name once the bar shows two. A click (a tap on the phone) lists every limit of every plan
// with how much of it is used, when it starts anew and where the numbers come from.

import { useEffect, useRef, useState } from 'react';
import type { PlanUsage, Usage, UsageLimit } from '../core/types';
import { clock, snoozeWhen, t } from './strings';

/** A limit as the list names it. */
export function limitName(l: UsageLimit): string {
  if (l.scope) return t.usage.scoped(l.scope);
  return t.usage.kinds[l.kind] ?? t.usage.groups[l.group] ?? l.kind;
}

const percent = (n: number) => `${Math.round(n)} %`;

function Meter({ limit }: { limit: UsageLimit }) {
  return (
    <span className={`meter ${limit.severity}`} aria-hidden>
      <i style={{ width: `${Math.min(100, Math.max(0, limit.percent))}%` }} />
    </span>
  );
}

export function UsagePill({ usage }: { usage: Usage }) {
  // open by a click (a tap) until one elsewhere or Escape
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => ref.current?.contains(e.target as Node) || setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    addEventListener('pointerdown', away, true);
    addEventListener('keydown', esc);
    return () => {
      removeEventListener('pointerdown', away, true);
      removeEventListener('keydown', esc);
    };
  }, [open]);
  const plans = usage.plans.filter((p) => p.limits.length);
  // every plan with a login, whether agents run on it or not: what is left there decides what to start
  const faced = plans;
  if (!faced.length) return null;
  // the bar names a plan only beside another; the list names each
  const named = faced.length > 1;
  return (
    <div ref={ref} className={['pill usage', open && 'open'].filter(Boolean).join(' ')} id="usage">
      <button className="face" aria-expanded={open} aria-label={t.usage.title} onClick={() => setOpen(!open)}>
        {faced.map((p) => (
          <span key={p.harness} className="plan">
            {named && <span className="harness">{t.usage.short[p.harness]}</span>}
            <span className="stack">
              {p.limits.map((l, i) => (
                <Meter key={i} limit={l} />
              ))}
            </span>
          </span>
        ))}
      </button>
      <div className="tip" role="tooltip">
        {plans.map((p) => (
          <PlanList key={p.harness} plan={p} />
        ))}
      </div>
    </div>
  );
}

/** One plan's limits in the list, under its name. */
function PlanList({ plan }: { plan: PlanUsage }) {
  return (
    <>
      <p>
        <b>{t.usage.plans[plan.harness]}</b>
      </p>
      <ul className="usage-list">
        {plan.limits.map((l, i) => (
          <li key={i} className={l.severity}>
            <span className="name">{limitName(l)}</span>
            <Meter limit={l} />
            <b>{percent(l.percent)}</b>
            {l.resetsAt && <span className="hint when">{t.usage.resets(snoozeWhen(l.resetsAt))}</span>}
          </li>
        ))}
      </ul>
      <p className="hint">{t.usage.source(t.harnesses[plan.harness], clock(plan.at))}</p>
    </>
  );
}
