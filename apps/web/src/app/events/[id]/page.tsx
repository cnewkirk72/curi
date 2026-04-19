// Event Detail — minimal stub so EventCard links resolve. Real detail
// view (hero image, full lineup avatars, description, ticket CTA, map)
// lands in Phase 3.7.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { AppHeader } from '@/components/app-header';
import { BottomNav } from '@/components/bottom-nav';
import { Chip, toneForGenre } from '@/components/chip';
import { createClient } from '@/lib/supabase/server';
import { timeLabel, formatPrice, groupLabel, nycDayKey } from '@/lib/format';

export const dynamic = 'force-dynamic';

// Explicit row type — see lib/events.ts for why we hand-type rather
// than rely on Supabase's generated inference for joined rows.
type EventDetailRow = {
  id: string;
  title: string;
  starts_at: string;
  genres: string[] | null;
  price_min: number | null;
  price_max: number | null;
  ticket_url: string | null;
  venue: { name: string; neighborhood: string | null } | null;
};

export default async function EventDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const supabase = createClient();
  const { data: raw, error } = await supabase
    .from('events')
    .select(
      `
      id, title, starts_at, genres, price_min, price_max, ticket_url,
      venue:venues ( name, neighborhood )
    `,
    )
    .eq('id', params.id)
    .single();

  if (error || !raw) notFound();
  const data = raw as unknown as EventDetailRow;

  const price = formatPrice(data.price_min, data.price_max);
  const day = groupLabel(nycDayKey(data.starts_at));

  return (
    <div className="relative min-h-dvh">
      <main className="relative mx-auto max-w-[430px] px-5 pb-28 pt-10">
        <AppHeader />

        <Link
          href="/"
          className="mt-2 inline-flex items-center gap-1.5 text-xs text-fg-muted hover:text-fg-primary"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to feed
        </Link>

        <section className="mt-6 animate-enter-up space-y-3">
          <div className="text-2xs uppercase tracking-widest text-fg-muted tabular">
            {day} · {timeLabel(data.starts_at)}
            {data.venue && (
              <>
                {' · '}
                <span className="text-fg-primary">{data.venue.name}</span>
              </>
            )}
          </div>
          <h1 className="font-display text-3xl font-semibold leading-tight tracking-display">
            {data.title}
          </h1>
          {price && (
            <div className="font-display text-sm font-medium text-accent tabular">
              {price}
            </div>
          )}
          {(data.genres ?? []).length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-2">
              {(data.genres ?? []).slice(0, 5).map((g) => (
                <Chip key={g} tone={toneForGenre(g)}>
                  {g}
                </Chip>
              ))}
            </div>
          )}
        </section>

        <div className="mt-10 curi-glass rounded-2xl p-5 text-sm text-fg-muted shadow-card">
          Full detail view — lineup avatars, description, map, ticket CTA —
          lands in Phase 3.7.
        </div>

        {data.ticket_url && (
          <a
            href={data.ticket_url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-6 inline-flex w-full items-center justify-center rounded-pill bg-accent px-6 py-3.5 font-display text-sm font-semibold text-bg-deep shadow-glow transition hover:bg-accent-hover active:scale-[0.97]"
          >
            Get tickets
          </a>
        )}
      </main>

      <BottomNav />
    </div>
  );
}
