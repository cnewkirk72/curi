'use server';

// Server actions for /profile identity editing.
//
// Writes land on `public.profiles` (migration 0013). RLS is
// owner-only for mutations, so Postgres rejects cross-user writes
// automatically — we still gate here so unauth viewers get a
// useful signal rather than a silent RLS rejection.
//
// Avatar uploads land in the `avatars` Storage bucket under the
// per-user folder (`avatars/<uid>/…`). Storage RLS from 0013
// enforces the same per-user folder constraint, so even a crafted
// upload can't write to someone else's directory.
//
// Username validation happens in two places: server-side here for
// authoritative enforcement, and client-side in profile-form.tsx
// as a debounced "is this available?" check before submit (purely
// for UX — the server is still the gate).

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';

// ── Username validation ───────────────────────────────────────

/** Accepts 3–24 chars, lowercase letters, digits, underscore, dash.
 * No leading/trailing dash, no consecutive dashes. */
const USERNAME_REGEX = /^(?!-)(?!.*--)[a-z0-9_-]{3,24}(?<!-)$/;

/** Names we reserve for product use so users can't squat @curi,
 * @admin, etc. Matched case-insensitively via citext already, but
 * we lowercase-check here as a belt-and-suspenders step. */
const RESERVED_USERNAMES = new Set([
  'admin', 'administrator', 'root', 'support', 'help', 'sys',
  'curi', 'api', 'auth', 'mail', 'www', 'app',
  'login', 'logout', 'signup', 'signin', 'onboarding',
  'profile', 'me', 'you', 'settings',
  'events', 'event', 'saved', 'save',
  'about', 'privacy', 'terms', 'legal', 'contact',
]);

export type UsernameCheck =
  | { ok: true }
  | { ok: false; reason: 'too_short' | 'too_long' | 'invalid_chars' | 'reserved' | 'taken' };

/**
 * Validate a candidate username against format + reserved list +
 * uniqueness. Shared between the client-side debounced check and
 * the server action — callers must lowercase before calling.
 */
export async function checkUsernameAvailable(
  raw: string,
): Promise<UsernameCheck> {
  const username = (raw ?? '').trim().toLowerCase();

  if (username.length < 3) return { ok: false, reason: 'too_short' };
  if (username.length > 24) return { ok: false, reason: 'too_long' };
  if (!USERNAME_REGEX.test(username)) {
    return { ok: false, reason: 'invalid_chars' };
  }
  if (RESERVED_USERNAMES.has(username)) {
    return { ok: false, reason: 'reserved' };
  }

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Uniqueness check. citext makes the unique constraint case-
  // insensitive, so we match with a plain eq — the existing viewer's
  // own username is allowed through (they can re-save the same one
  // without this tripping).
  const { data, error } = await supabase
    .from('profiles')
    .select('id')
    .eq('username', username)
    .maybeSingle();

  if (error) {
    // eslint-disable-next-line no-console
    console.error('[profile] checkUsernameAvailable failed:', error.message);
    // Fail open — the UX is best-effort, the unique constraint at
    // the DB is the real gate.
    return { ok: true };
  }

  if (data && (data as { id: string }).id !== user?.id) {
    return { ok: false, reason: 'taken' };
  }

  return { ok: true };
}

// ── updateProfile ────────────────────────────────────────────

export type ProfileInput = {
  username?: string | null;
  display_name?: string | null;
};

export type ProfileResult =
  | { ok: true }
  | { ok: false; reason: 'unauth' | 'invalid_username' | 'taken' | 'failed' };

/**
 * Update the signed-in user's profile. Nullable fields in the input
 * are treated as "clear this column" — pass `undefined` (or omit
 * the field) to leave it alone.
 */
export async function updateProfile(
  input: ProfileInput,
): Promise<ProfileResult> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, reason: 'unauth' };

  // Normalize + validate username if present. Null explicitly clears.
  let nextUsername: string | null | undefined = undefined;
  if (input.username === null) {
    nextUsername = null;
  } else if (typeof input.username === 'string') {
    const normalized = input.username.trim().toLowerCase();
    if (normalized.length === 0) {
      nextUsername = null;
    } else {
      const check = await checkUsernameAvailable(normalized);
      if (!check.ok) {
        return {
          ok: false,
          reason: check.reason === 'taken' ? 'taken' : 'invalid_username',
        };
      }
      nextUsername = normalized;
    }
  }

  // Display name: trim, clamp to a reasonable length, allow empty
  // string to clear (via null). No other validation — display names
  // are free-form.
  let nextDisplayName: string | null | undefined = undefined;
  if (input.display_name === null) {
    nextDisplayName = null;
  } else if (typeof input.display_name === 'string') {
    const trimmed = input.display_name.trim().slice(0, 80);
    nextDisplayName = trimmed.length === 0 ? null : trimmed;
  }

  // Build the update payload from only the fields we're actually
  // touching — passing undefineds would blow away existing values
  // via `upsert`'s merge semantics.
  const patch: Record<string, unknown> = {};
  if (nextUsername !== undefined) patch.username = nextUsername;
  if (nextDisplayName !== undefined) patch.display_name = nextDisplayName;

  if (Object.keys(patch).length === 0) return { ok: true };

  const { error } = await supabase
    .from('profiles')
    .update(patch as never)
    .eq('id', user.id);

  if (error) {
    // eslint-disable-next-line no-console
    console.error('[profile] updateProfile failed:', error.message);
    // Supabase surfaces unique-violations as code 23505 — treat
    // those as "taken" for the client-side toast.
    if ((error as { code?: string }).code === '23505') {
      return { ok: false, reason: 'taken' };
    }
    return { ok: false, reason: 'failed' };
  }

  revalidatePath('/profile');
  revalidatePath('/');
  return { ok: true };
}

// ── Avatar upload / remove / use-Google ──────────────────────────────

/** Server side of the avatar upload. The client compresses to WebP,
 * then calls this with the raw bytes + content type. We write to
 * Storage under `avatars/<uid>/avatar-<ts>.webp` (timestamp prevents
 * CDN cache pinning on re-upload) and overwrite `profiles.avatar_url`
 * with the new public URL. */
export async function uploadAvatar(
  input: { bytes: ArrayBuffer; contentType: string },
): Promise<ProfileResult> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, reason: 'unauth' };

  // Conservative content-type allowlist. We tell the client to send
  // image/webp; we also accept jpeg/png in case a future client
  // path sends the raw picked file (size-permitting).
  const allowed = new Set(['image/webp', 'image/jpeg', 'image/png']);
  const contentType = (input.contentType ?? '').toLowerCase();
  if (!allowed.has(contentType)) {
    return { ok: false, reason: 'failed' };
  }

  // Extension picked off content-type so the Storage URL ends in
  // the right suffix — nothing downstream actually reads the
  // extension, but it keeps URLs legible.
  const ext = contentType === 'image/jpeg'
    ? 'jpg'
    : contentType === 'image/png'
    ? 'png'
    : 'webp';

  const path = `${user.id}/avatar-${Date.now()}.${ext}`;

  const { error: uploadErr } = await supabase
    .storage
    .from('avatars')
    .upload(path, input.bytes, {
      contentType,
      // upsert:false so we don't silently overwrite a file at this
      // exact timestamped path (shouldn't happen with Date.now()
      // but we'd rather fail loudly if it did).
      upsert: false,
    });

  if (uploadErr) {
    // eslint-disable-next-line no-console
    console.error('[profile] avatar upload failed:', uploadErr.message);
    return { ok: false, reason: 'failed' };
  }

  const { data: pub } = supabase.storage.from('avatars').getPublicUrl(path);
  const publicUrl = pub?.publicUrl;
  if (!publicUrl) return { ok: false, reason: 'failed' };

  const { error: updateErr } = await supabase
    .from('profiles')
    .update({ avatar_url: publicUrl } as never)
    .eq('id', user.id);

  if (updateErr) {
    // eslint-disable-next-line no-console
    console.error(
      '[profile] avatar avatar_url update failed:',
      updateErr.message,
    );
    return { ok: false, reason: 'failed' };
  }

  revalidatePath('/profile');
  revalidatePath('/');
  return { ok: true };
}

/** Clear profiles.avatar_url. Does NOT delete the Storage object —
 * keeping the file around makes un-removing trivial (flip the URL
 * back) and the bucket is cheap. If a user cycles through many
 * avatars we can add a janitor later. */
export async function removeAvatar(): Promise<ProfileResult> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, reason: 'unauth' };

  const { error } = await supabase
    .from('profiles')
    .update({ avatar_url: null } as never)
    .eq('id', user.id);

  if (error) {
    // eslint-disable-next-line no-console
    console.error('[profile] removeAvatar failed:', error.message);
    return { ok: false, reason: 'failed' };
  }

  revalidatePath('/profile');
  revalidatePath('/');
  return { ok: true };
}

/** Reset profiles.avatar_url to the Google-provided picture from
 * raw_user_meta_data. Useful as an "undo a custom avatar" shortcut
 * so users don't have to re-upload if they decide to go back.
 *
 * Named `applyGoogleAvatar` rather than `useGoogleAvatar` because
 * the React hook-naming heuristic in eslint-plugin-react-hooks
 * flags any `use`-prefixed call inside a component body — even
 * when it's a plain server action. Keeping the prefix-free name
 * sidesteps that and removes the need for a local eslint-disable. */
export async function applyGoogleAvatar(): Promise<ProfileResult> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, reason: 'unauth' };

  const googleUrl =
    (user.user_metadata?.picture as string | undefined) ??
    (user.user_metadata?.avatar_url as string | undefined) ??
    null;

  const { error } = await supabase
    .from('profiles')
    .update({ avatar_url: googleUrl } as never)
    .eq('id', user.id);

  if (error) {
    // eslint-disable-next-line no-console
    console.error('[profile] useGoogleAvatar failed:', error.message);
    return { ok: false, reason: 'failed' };
  }

  revalidatePath('/profile');
  revalidatePath('/');
  return { ok: true };
}
