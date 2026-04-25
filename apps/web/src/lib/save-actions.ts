'use server';

// Server actions for toggling user_saves. Separate from
// lib/supabase/actions.ts because that file is scoped to auth —
// mixing concerns there would obscure what's happening when a
// future engineer goes looking for "the auth actions."
//
// RLS on user_saves (owner-only insert/delete per 0001_init.sql)
// means we don't have to re-check ownership here — Postgres will
// reject the write if auth.uid() doesn't match user_id. What we
// *do* check is whether there's a session at all, so unauth
// viewers get bounced to /login rather than silently no-op'ing
// on a write that RLS then rejects.

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import type { TablesInsert } from '@/lib/supabase/types';

type Result = { ok: true } | { ok: false; reason: 'unauth' | 'failed' };

/**
 * Persist a save for the current user. Uses an upsert so repeated
 * clicks (e.g. a double-tap from an optimistic-update race) are
 * idempotent rather than violating the primary key.
 */
export async function saveEvent(eventId: string): Promise<Result> {
  const supabase = createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    // The SaveButton handles the unauth-case redirect on the
    // client too, but we defend in depth here — a progressively
    // enhanced form POST could still reach this action with no
    // session, and we want a useful signal rather than a silent
    // RLS rejection.
    return { ok: false, reason: 'unauth' };
  }

  // Cast through TablesInsert because @supabase/ssr 0.5.1's bundled
  // supabase-js inference resolves this table's Insert type to
  // `never` — the generated Database type is correct, so the cast
  // is purely a tooling-bridge, not a runtime concern.
  const row: TablesInsert<'user_saves'> = {
    user_id: user.id,
    event_id: eventId,
  };
  const { error } = await supabase
    .from('user_saves')
    .upsert(row as never, {
      onConflict: 'user_id,event_id',
      ignoreDuplicates: true,
    });

  if (error) {
    // eslint-disable-next-line no-console
    console.error('[saves] saveEvent failed:', error.message);
    return { ok: false, reason: 'failed' };
  }

  // Revalidate anything that depends on the saved set. Home +
  // event detail render the bookmark; Saved renders the list;
  // Profile renders the count.
  revalidatePath('/');
  revalidatePath('/saved');
  revalidatePath('/profile');
  revalidatePath(`/events/${eventId}`);

  return { ok: true };
}

/**
 * Remove a save. A missing row is treated as success (the user
 * wanted it gone; it's gone) rather than an error.
 */
export async function unsaveEvent(eventId: string): Promise<Result> {
  const supabase = createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return { ok: false, reason: 'unauth' };

  const { error } = await supabase
    .from('user_saves')
    .delete()
    .eq('user_id', user.id)
    .eq('event_id', eventId);

  if (error) {
    // eslint-disable-next-line no-console
    console.error('[saves] unsaveEvent failed:', error.message);
    return { ok: false, reason: 'failed' };
  }

  revalidatePath('/');
  revalidatePath('/saved');
  revalidatePath('/profile');
  revalidatePath(`/events/${eventId}`);

  return { ok: true };
}

