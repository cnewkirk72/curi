'use client';

// Onboarding step 5 — default feed window + three consent toggles.
//
// Four controls, all persisted to user_prefs:
//   - default_when         ('weekend' | 'tonight' | 'week' | null)
//   - notify_artist_drops  (bool)
//   - location_opt_in      (bool)
//   - calendar_opt_in      (bool)
//
// The consent toggles don't *do* anything on their own — they're
// affirmative opt-ins we stash for future UX (notifications, nearby,
// .ics export). We ask now so we don't have to build an interstitial
// later when those features ship. Default off on all three keeps us
// from silently opting users into anything.

import { ArrowRight, Bell, CalendarDays, MapPin } from 'lucide-react';
import { cn } from '@/lib/utils';

export type WindowPick = 'weekend' | 'tonight' | 'week' | null;

type Props = {
  defaultWhen: WindowPick;
  notifyArtistDrops: boolean;
  locationOptIn: boolean;
  calendarOptIn: boolean;
  onChangeWindow: (value: WindowPick) => void;
  onToggleNotify: () => void;
  onToggleLocation: () => void;
  onToggleCalendar: () => void;
  onBack: () => void;
  onContinue: () => void;
};

export function WhenStep({
  defaultWhen,
  notifyArtistDrops,
  locationOptIn,
  calendarOptIn,
  onChangeWindow,
  onToggleNotify,
  onToggleLocation,
  onToggleCalendar,
  onBack,
  onContinue,
}: Props) {
  return (
    <div className="flex flex-col gap-6 px-5 pb-10 pt-4 animate-enter-up">
      <header className="space-y-2">
        <p className="font-display text-2xs uppercase tracking-widest text-accent">
          Step 5 of 5
        </p>
        <h2 className="font-display text-2xl font-semibold leading-tight tracking-display">
          When & how
          <br />
          you want in.
        </h2>
        <p className="text-sm text-fg-muted">
          Your defaults — you can change these anytime from Profile.
        </p>
      </header>

      {/* Window card group */}
      <section>
        <div className="mb-3 flex items-baseline justify-between">
          <span className="font-display text-2xs font-medium uppercase tracking-widest text-fg-muted">
            Default window
          </span>
          <button
            type="button"
            onClick={() => onChangeWindow(null)}
            className={cn(
              'text-2xs text-fg-dim transition hover:text-fg-primary',
              defaultWhen === null && 'text-accent',
            )}
          >
            {defaultWhen === null ? 'No default' : 'Clear'}
          </button>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <WindowCard
            label="Tonight"
            sub="Next 24h"
            active={defaultWhen === 'tonight'}
            onClick={() => onChangeWindow('tonight')}
          />
          <WindowCard
            label="Weekend"
            sub="Fri → Sun"
            active={defaultWhen === 'weekend'}
            onClick={() => onChangeWindow('weekend')}
          />
          <WindowCard
            label="This week"
            sub="Next 7 days"
            active={defaultWhen === 'week'}
            onClick={() => onChangeWindow('week')}
          />
        </div>
      </section>

      {/* Perm toggles */}
      <section className="space-y-2">
        <span className="mb-1 block font-display text-2xs font-medium uppercase tracking-widest text-fg-muted">
          Notifications & access
        </span>
        <PermRow
          icon={<Bell className="h-4 w-4" strokeWidth={2} />}
          label="Artist drops"
          description="Ping me when artists I follow announce an NYC date."
          on={notifyArtistDrops}
          onToggle={onToggleNotify}
        />
        <PermRow
          icon={<MapPin className="h-4 w-4" strokeWidth={2} />}
          label="Use my location"
          description="Sort events by how close they are to where I am."
          on={locationOptIn}
          onToggle={onToggleLocation}
        />
        <PermRow
          icon={<CalendarDays className="h-4 w-4" strokeWidth={2} />}
          label="Add to calendar"
          description="Let me drop saved events into my calendar in one tap."
          on={calendarOptIn}
          onToggle={onToggleCalendar}
        />
      </section>

      {/* Footer CTA */}
      <div className="sticky bottom-3 z-10 mt-auto flex items-center gap-3 pt-2">
        <button
          type="button"
          onClick={onBack}
          className="text-sm font-medium text-fg-muted transition hover:text-fg-primary"
        >
          Back
        </button>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onContinue}
          className={cn(
            'inline-flex items-center justify-center gap-2 rounded-pill bg-accent px-6 py-3',
            'font-display text-sm font-semibold text-bg-deep shadow-glow',
            'transition duration-micro ease-expo hover:bg-accent-hover active:scale-[0.97]',
          )}
        >
          Finish
          <ArrowRight className="h-4 w-4" strokeWidth={2.5} />
        </button>
      </div>
    </div>
  );
}

// ── WindowCard ───────────────────────────────────────────────────────

function WindowCard({
  label,
  sub,
  active,
  onClick,
}: {
  label: string;
  sub: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex flex-col items-start gap-1 rounded-xl border p-3 text-left',
        'transition duration-micro ease-expo active:scale-[0.97]',
        active
          ? 'border-accent/50 bg-accent-chip shadow-glow-sm'
          : 'border-border bg-bg-elevated hover:border-accent/30 hover:text-fg-primary',
      )}
    >
      <span
        className={cn(
          'font-display text-sm font-semibold',
          active ? 'text-accent' : 'text-fg-primary',
        )}
      >
        {label}
      </span>
      <span className="text-2xs text-fg-muted">{sub}</span>
    </button>
  );
}

// ── PermRow ───────────────────────────────────────────────────────────

function PermRow({
  icon,
  label,
  description,
  on,
  onToggle,
}: {
  icon: React.ReactNode;
  label: string;
  description: string;
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={on}
      className={cn(
        'flex w-full items-start gap-3 rounded-2xl border p-3.5 text-left',
        'transition duration-micro ease-expo active:scale-[0.99]',
        on
          ? 'border-accent/40 bg-accent-chip/60'
          : 'border-border bg-bg-elevated hover:bg-bg-elevated-hover',
      )}
    >
      <span
        className={cn(
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-pill',
          on ? 'bg-accent text-bg-deep' : 'border border-border bg-bg-deep text-fg-muted',
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-fg-primary">
          {label}
        </span>
        <span className="mt-0.5 block text-2xs text-fg-muted">
          {description}
        </span>
      </span>
      <Toggle on={on} />
    </button>
  );
}

function Toggle({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'relative inline-flex h-6 w-10 shrink-0 items-center self-center rounded-pill border transition',
        on ? 'border-accent/40 bg-accent/80' : 'border-border bg-bg-deep',
      )}
    >
      <span
        className={cn(
          'absolute top-1/2 h-4 w-4 -translate-y-1/2 rounded-full bg-fg-primary shadow-card transition',
          on ? 'left-5 bg-bg-deep' : 'left-1',
        )}
      />
    </span>
  );
}
