'use client';

// Identity editor on /profile.
//
// Sits above the PreferencesForm and owns everything that shows up
// on the user's public profile: avatar, display name, username.
// Behavior model is intentionally different from PreferencesForm:
//
//   - Avatar changes fire an immediate server action — picking a
//     file means you want it uploaded now.
//   - Username + display_name use a small local "dirty → Save"
//     pattern. Username also has a debounced availability check
//     (300ms after the last keystroke) so a user sees "taken"
//     before they try to commit.
//
// The avatar upload path does its own client-side compression to
// a max 512×512 WebP before handing bytes to the server action.
// That trims a 4MB phone photo down to ~40KB, which keeps Storage
// costs and cold-load CDN time in check.

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { Camera, Check, RotateCcw, Trash2, User as UserIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  applyGoogleAvatar,
  checkUsernameAvailable,
  removeAvatar,
  updateProfile,
  uploadAvatar,
  type UsernameCheck,
} from '@/lib/profile-actions';
import { initialsFor } from '@/lib/avatars';
import type { Profile } from '@/lib/profile';

type Props = {
  initial: Profile;
  /** The OAuth `picture` URL from auth.users.raw_user_meta_data.
   * Surfaces the "Use Google photo" affordance when the current
   * avatar differs from this. Null when the user has no Google
   * picture (shouldn't happen for our current OAuth setup). */
  googleAvatarUrl: string | null;
  /** Email fallback for initials when display_name is empty. */
  emailFallback: string | null;
};

export function ProfileForm({ initial, googleAvatarUrl, emailFallback }: Props) {
  // Avatar state lives in its own slot — it updates on every server
  // action, independent of the text-field draft/save dance.
  const [avatarUrl, setAvatarUrl] = useState<string | null>(initial.avatar_url);
  const [avatarPending, startAvatarTransition] = useTransition();
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Text-field draft/save state.
  const [usernameDraft, setUsernameDraft] = useState(initial.username ?? '');
  const [nameDraft, setNameDraft] = useState(initial.display_name ?? '');
  const [savedUsername, setSavedUsername] = useState(initial.username ?? '');
  const [savedName, setSavedName] = useState(initial.display_name ?? '');
  const [savePending, startSaveTransition] = useTransition();
  const [saveStatus, setSaveStatus] = useState<
    | { kind: 'idle' }
    | { kind: 'saved' }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  const [usernameCheck, setUsernameCheck] = useState<UsernameCheck | null>(null);
  const [checkingUsername, setCheckingUsername] = useState(false);

  const dirty = useMemo(
    () =>
      usernameDraft.trim().toLowerCase() !== (savedUsername ?? '') ||
      nameDraft.trim() !== (savedName ?? ''),
    [usernameDraft, nameDraft, savedUsername, savedName],
  );

  // Debounced username availability check. Fires 300ms after the
  // last keystroke when the draft differs from what's saved (so
  // "type the same thing back" doesn't ping the server).
  useEffect(() => {
    const draft = usernameDraft.trim().toLowerCase();
    if (!draft) {
      setUsernameCheck(null);
      return;
    }
    if (draft === (savedUsername ?? '')) {
      setUsernameCheck({ ok: true });
      return;
    }
    setCheckingUsername(true);
    const t = setTimeout(async () => {
      const result = await checkUsernameAvailable(draft);
      setUsernameCheck(result);
      setCheckingUsername(false);
    }, 300);
    return () => {
      clearTimeout(t);
      setCheckingUsername(false);
    };
  }, [usernameDraft, savedUsername]);

  // ── Avatar actions ──────────────────────────────────────────────

  function pickFile() {
    setAvatarError(null);
    fileInputRef.current?.click();
  }

  async function onFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset the input so picking the same file twice still fires
    // onChange — HTML input[type=file] is fickle about this.
    if (e.target) e.target.value = '';
    if (!file) return;
    if (!/^image\//.test(file.type)) {
      setAvatarError('Pick an image file.');
      return;
    }

    try {
      const { bytes, contentType } = await compressToWebp(file, 512);

      startAvatarTransition(async () => {
        const result = await uploadAvatar({ bytes, contentType });
        if (result.ok) {
          // We don't know the new public URL from the result —
          // easiest path is a soft reload of the page via Next's
          // revalidation (already triggered server-side). Update
          // locally with a cache-busting query too so the <img>
          // re-fetches even if the URL happens to match a previous.
          setAvatarUrl(
            avatarUrl
              ? `${avatarUrl.split('?')[0]}?t=${Date.now()}`
              : null,
          );
          // The next server render (after revalidatePath) will hand
          // us the real new URL through `initial`. To avoid a stale
          // local-only bust, force a router refresh.
          if (typeof window !== 'undefined') window.location.reload();
        } else if (result.reason === 'unauth') {
          setAvatarError('Sign in to upload an avatar.');
        } else {
          setAvatarError('Upload failed. Try again.');
        }
      });
    } catch {
      setAvatarError('Could not process that image.');
    }
  }

  function onRemoveAvatar() {
    startAvatarTransition(async () => {
      setAvatarError(null);
      const result = await removeAvatar();
      if (result.ok) {
        setAvatarUrl(null);
        if (typeof window !== 'undefined') window.location.reload();
      } else if (result.reason === 'unauth') {
        setAvatarError('Sign in to change your avatar.');
      } else {
        setAvatarError('Could not remove. Try again.');
      }
    });
  }

  function onUseGoogleAvatar() {
    startAvatarTransition(async () => {
      setAvatarError(null);
      const result = await applyGoogleAvatar();
      if (result.ok) {
        setAvatarUrl(googleAvatarUrl);
        if (typeof window !== 'undefined') window.location.reload();
      } else if (result.reason === 'unauth') {
        setAvatarError('Sign in to change your avatar.');
      } else {
        setAvatarError('Could not update. Try again.');
      }
    });
  }

  // ── Save identity (username + display_name) ─────────────────────

  function onSave() {
    const nextUsername = usernameDraft.trim().toLowerCase();
    const nextName = nameDraft.trim();

    startSaveTransition(async () => {
      const result = await updateProfile({
        username: nextUsername || null,
        display_name: nextName || null,
      });
      if (result.ok) {
        setSavedUsername(nextUsername);
        setSavedName(nextName);
        setSaveStatus({ kind: 'saved' });
      } else if (result.reason === 'unauth') {
        setSaveStatus({ kind: 'error', message: 'Sign in to save.' });
      } else if (result.reason === 'taken') {
        setSaveStatus({
          kind: 'error',
          message: 'That username is already taken.',
        });
      } else if (result.reason === 'invalid_username') {
        setSaveStatus({
          kind: 'error',
          message: 'Usernames need 3–24 letters, numbers, dashes, or underscores.',
        });
      } else {
        setSaveStatus({
          kind: 'error',
          message: 'Could not save. Try again in a moment.',
        });
      }
    });
  }

  function onReset() {
    setUsernameDraft(savedUsername ?? '');
    setNameDraft(savedName ?? '');
    setSaveStatus({ kind: 'idle' });
  }

  // ── Render ──────────────────────────────────────────────────────

  const displayInitials = initialsFor(
    (savedName || nameDraft || emailFallback || 'You').trim(),
  );
  const canOfferGoogleAvatar =
    !!googleAvatarUrl && googleAvatarUrl !== (avatarUrl ?? '');

  return (
    <section className="mt-6">
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="font-display text-2xs font-medium uppercase tracking-widest text-fg-muted">
          Identity
        </h3>
        <span className="text-2xs text-fg-dim">
          Shown on your profile and anywhere you appear
        </span>
      </div>

      <div className="curi-glass rounded-2xl p-5 shadow-card">
        {/* Avatar row */}
        <div className="flex items-center gap-4">
          <div className="relative">
            {avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={avatarUrl}
                alt=""
                className="h-16 w-16 rounded-full border border-border object-cover"
              />
            ) : (
              <div className="flex h-16 w-16 items-center justify-center rounded-full border border-border bg-bg-elevated font-display text-lg font-semibold text-fg-primary">
                {displayInitials}
              </div>
            )}
            <button
              type="button"
              onClick={pickFile}
              disabled={avatarPending}
              aria-label="Change avatar"
              className={cn(
                'absolute -bottom-1 -right-1 inline-flex h-7 w-7 items-center justify-center rounded-full',
                'bg-accent text-bg-deep shadow-glow',
                'transition duration-micro ease-expo hover:bg-accent-hover active:scale-[0.94]',
                'disabled:pointer-events-none disabled:opacity-60',
              )}
            >
              <Camera className="h-3.5 w-3.5" strokeWidth={2.5} />
            </button>
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-fg-primary">
              Profile photo
            </div>
            <div className="text-2xs text-fg-muted">
              WebP up to 512&thinsp;×&thinsp;512. Tap the camera to change.
            </div>
            {avatarError && (
              <div className="mt-1 text-2xs text-amber">{avatarError}</div>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={onFilePicked}
          />
        </div>

        {/* Avatar secondary actions */}
        {(avatarUrl || canOfferGoogleAvatar) && (
          <div className="mt-3 flex flex-wrap gap-2">
            {canOfferGoogleAvatar && (
              <button
                type="button"
                onClick={onUseGoogleAvatar}
                disabled={avatarPending}
                className="inline-flex items-center gap-1.5 rounded-pill border border-border bg-bg-elevated px-3 py-1 text-2xs text-fg-muted transition hover:text-fg-primary disabled:pointer-events-none disabled:opacity-60"
              >
                <RotateCcw className="h-3 w-3" />
                Use Google photo
              </button>
            )}
            {avatarUrl && (
              <button
                type="button"
                onClick={onRemoveAvatar}
                disabled={avatarPending}
                className="inline-flex items-center gap-1.5 rounded-pill border border-border bg-bg-elevated px-3 py-1 text-2xs text-fg-muted transition hover:text-fg-primary disabled:pointer-events-none disabled:opacity-60"
              >
                <Trash2 className="h-3 w-3" />
                Remove
              </button>
            )}
          </div>
        )}

        <div className="my-5 h-px bg-border/60" aria-hidden />

        {/* Display name */}
        <label className="block">
          <span className="mb-1.5 block font-display text-2xs font-medium uppercase tracking-widest text-fg-muted">
            Display name
          </span>
          <input
            type="text"
            value={nameDraft}
            onChange={(e) => {
              setNameDraft(e.target.value);
              setSaveStatus({ kind: 'idle' });
            }}
            placeholder="Your name"
            maxLength={80}
            className={cn(
              'w-full rounded-xl border border-border bg-bg-elevated px-4 py-2.5',
              'text-sm text-fg-primary placeholder:text-fg-dim',
              'transition focus:border-accent/50 focus:outline-none focus:ring-2 focus:ring-accent/30',
            )}
          />
        </label>

        {/* Username */}
        <label className="mt-4 block">
          <span className="mb-1.5 block font-display text-2xs font-medium uppercase tracking-widest text-fg-muted">
            Username
          </span>
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-fg-dim">
              @
            </span>
            <input
              type="text"
              value={usernameDraft}
              onChange={(e) => {
                setUsernameDraft(e.target.value.replace(/\s/g, ''));
                setSaveStatus({ kind: 'idle' });
              }}
              placeholder="pick-a-handle"
              maxLength={24}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className={cn(
                'w-full rounded-xl border border-border bg-bg-elevated py-2.5 pl-7 pr-4',
                'text-sm text-fg-primary placeholder:text-fg-dim lowercase',
                'transition focus:border-accent/50 focus:outline-none focus:ring-2 focus:ring-accent/30',
              )}
            />
          </div>
          <UsernameStatus
            draft={usernameDraft}
            savedUsername={savedUsername}
            check={usernameCheck}
            checking={checkingUsername}
          />
        </label>

        {/* Footer actions */}
        <div className="mt-5 flex items-center gap-3 border-t border-border pt-4">
          <div className="min-h-[18px] text-2xs text-fg-muted" aria-live="polite">
            {saveStatus.kind === 'saved' && !dirty ? (
              <span className="inline-flex items-center gap-1 text-accent">
                <Check className="h-3.5 w-3.5" strokeWidth={2.5} />
                Saved
              </span>
            ) : saveStatus.kind === 'error' ? (
              <span className="text-fg-primary">{saveStatus.message}</span>
            ) : dirty ? (
              <span>Unsaved changes</span>
            ) : null}
          </div>

          <button
            type="button"
            onClick={onReset}
            disabled={!dirty || savePending}
            className={cn(
              'text-xs font-medium text-fg-muted transition hover:text-fg-primary',
              'disabled:pointer-events-none disabled:opacity-40',
            )}
          >
            Reset
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={
              !dirty ||
              savePending ||
              (!!usernameDraft.trim() && usernameCheck?.ok === false)
            }
            className={cn(
              'inline-flex items-center justify-center rounded-pill bg-accent px-5 py-2',
              'font-display text-xs font-semibold text-bg-deep shadow-glow',
              'transition duration-micro ease-expo hover:bg-accent-hover active:scale-[0.97]',
              'disabled:pointer-events-none disabled:opacity-50 disabled:shadow-none',
            )}
          >
            {savePending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </section>
  );
}

// ── UsernameStatus ─────────────────────────────────────────────────

function UsernameStatus({
  draft,
  savedUsername,
  check,
  checking,
}: {
  draft: string;
  savedUsername: string;
  check: UsernameCheck | null;
  checking: boolean;
}) {
  const trimmed = draft.trim().toLowerCase();
  if (!trimmed) {
    return (
      <p className="mt-1.5 text-2xs text-fg-dim">
        3–24 letters, numbers, dashes, or underscores.
      </p>
    );
  }
  if (trimmed === savedUsername) {
    return (
      <p className="mt-1.5 flex items-center gap-1 text-2xs text-fg-muted">
        <UserIcon className="h-3 w-3" />
        This is your current handle.
      </p>
    );
  }
  if (checking) {
    return <p className="mt-1.5 text-2xs text-fg-dim">Checking…</p>;
  }
  if (!check) {
    return <p className="mt-1.5 text-2xs text-fg-dim">&nbsp;</p>;
  }
  if (check.ok) {
    return (
      <p className="mt-1.5 flex items-center gap-1 text-2xs text-accent">
        <Check className="h-3 w-3" strokeWidth={2.5} />
        Available
      </p>
    );
  }
  const message =
    check.reason === 'too_short'
      ? 'At least 3 characters.'
      : check.reason === 'too_long'
      ? 'Max 24 characters.'
      : check.reason === 'invalid_chars'
      ? 'Letters, numbers, dashes, or underscores only.'
      : check.reason === 'reserved'
      ? 'That one is reserved.'
      : 'Already taken.';
  return <p className="mt-1.5 text-2xs text-amber">{message}</p>;
}

// ── Client-side image compression ──────────────────────────────────
//
// Draws the picked file into a Canvas scaled to `max`x`max`
// (letterboxed — object-cover in the display handles the rest),
// then exports as WebP quality 0.85. The WebP output is roughly
// 20× smaller than the raw JPEG from a modern phone camera.
//
// Quality 0.85 is a deliberate middle — higher and you feel the
// bytes on slow connections, lower and the face starts to get
// that "overcooked" jpeg look. WebP at 0.85 on a 512² avatar
// lands at ~30–60KB in practice.

async function compressToWebp(
  file: File,
  max: number,
): Promise<{ bytes: ArrayBuffer; contentType: 'image/webp' }> {
  // createImageBitmap is faster than the old `new Image()` + onload
  // dance and handles orientation on iOS correctly out of the box.
  const bitmap = await createImageBitmap(file);
  const { width, height } = bitmap;
  const scale = Math.min(1, max / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));

  const canvas =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement('canvas'), { width: w, height: h });

  const ctx = (canvas as HTMLCanvasElement | OffscreenCanvas).getContext('2d');
  if (!ctx) throw new Error('canvas-2d-unavailable');
  // drawImage typed for both canvas types.
  (ctx as CanvasRenderingContext2D).drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  const blob: Blob = await new Promise((resolve, reject) => {
    if ('convertToBlob' in canvas) {
      (canvas as OffscreenCanvas)
        .convertToBlob({ type: 'image/webp', quality: 0.85 })
        .then(resolve, reject);
    } else {
      (canvas as HTMLCanvasElement).toBlob(
        (b) => (b ? resolve(b) : reject(new Error('toblob-null'))),
        'image/webp',
        0.85,
      );
    }
  });

  const bytes = await blob.arrayBuffer();
  return { bytes, contentType: 'image/webp' };
}
