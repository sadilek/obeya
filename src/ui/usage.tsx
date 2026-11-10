// The plans' usage limits in the bar: every limit of each plan with a login as a thin meter, one
// above the other in the list's order, in the grade the usage endpoint gives it, without labels or
// numbers, beside the harness's name once the bar shows two. A tick on each meter marks how much of
// its window has gone by: green while the usage stays at or under it, red once it runs ahead. A
// click (a tap on the phone) lists every limit of every plan with how much of it is used, when it
// starts anew and how long until then, and where the numbers come from.

import { useEffect, useRef, useState } from 'react';
import type { PlanUsage, Usage, UsageLimit } from '../core/types';
import { clock, countdown, snoozeWhen, t } from './strings';

/** How long each group's window lasts: the session five hours, the week seven days. */
const WINDOW_MS: Record<string, number> = { session: 5 * 3600_000, weekly: 7 * 24 * 3600_000 };

/** How much of a limit's window has gone by at `now`, 0–100; none for a window of unknown length or reset. */
export function elapsed(l: UsageLimit, now: number): number | undefined {
  const length = WINDOW_MS[l.group];
  if (!length || !l.resetsAt) return undefined;
  const left = Date.parse(l.resetsAt) - now;
  if (Number.isNaN(left)) return undefined;
  return Math.min(100, Math.max(0, 100 - (left / length) * 100));
}

/** The time, anew every half minute, for the marks and countdowns that move with it. */
function useNow() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** A limit as the list names it. */
export function limitName(l: UsageLimit): string {
  if (l.scope) return t.usage.scoped(l.scope);
  return t.usage.kinds[l.kind] ?? t.usage.groups[l.group] ?? l.kind;
}

const percent = (n: number) => `${Math.round(n)} %`;

function Meter({ limit, now }: { limit: UsageLimit; now: number }) {
  const gone = elapsed(limit, now);
  return (
    <span className={`meter ${limit.severity}`} aria-hidden>
      <i style={{ width: `${Math.min(100, Math.max(0, limit.percent))}%` }} />
      {gone !== undefined && <b className={`pace ${limit.percent > gone ? 'ahead' : 'behind'}`} style={{ left: `${gone}%` }} />}
    </span>
  );
}

export function UsagePill({ usage }: { usage: Usage }) {
  // open by a click (a tap) until one elsewhere or Escape
  const [open, setOpen] = useState(false);
  const now = useNow();
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
                <Meter key={i} limit={l} now={now} />
              ))}
            </span>
          </span>
        ))}
      </button>
      <div className="tip" role="tooltip">
        {plans.map((p) => (
          <PlanList key={p.harness} plan={p} now={now} />
        ))}
      </div>
    </div>
  );
}

/** One plan's limits in the list, under its name. */
function PlanList({ plan, now }: { plan: PlanUsage; now: number }) {
  return (
    <>
      <p>
        <b>{t.usage.plans[plan.harness]}</b>
      </p>
      <ul className="usage-list">
        {plan.limits.map((l, i) => (
          <li key={i} className={l.severity}>
            <span className="name">{limitName(l)}</span>
            <Meter limit={l} now={now} />
            <b>{percent(l.percent)}</b>
            {l.resetsAt && (
              <span className="hint when">
                {t.usage.resets(snoozeWhen(l.resetsAt))}
                {Date.parse(l.resetsAt) > now && ` · ${t.usage.left(countdown(Date.parse(l.resetsAt) - now))}`}
              </span>
            )}
          </li>
        ))}
      </ul>
      <p className="hint">{t.usage.source(t.harnesses[plan.harness], clock(plan.at))}</p>
    </>
  );
}
