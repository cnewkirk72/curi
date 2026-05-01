-- Phase 5.8 — SoundCloud OAuth 2.1 token storage.
--
-- Adds three columns to user_prefs to persist the access/refresh tokens
-- minted by SC's OAuth flow (https://secure.soundcloud.com/authorize +
-- /oauth/token). The Phase 5.6 columns (soundcloud_username,
-- soundcloud_last_synced_at) keep their semantics — this phase coexists
-- with the legacy username-input scrape path and does not retire it.
--
-- The OAuth callback writes soundcloud_username from SC's /me response
-- (lowercased permalink), so the same column ends up populated whether
-- the user connects via OAuth or the legacy paste flow. Last-write-wins
-- is fine — both sources should agree if they're the same human.
--
-- Storage form: plain text under per-user RLS. user_prefs already has
-- the four-policy per-user pattern from migration 0005, so the new
-- columns inherit gating without a new policy. Encrypt-at-rest via
-- Supabase Vault is a deliberate follow-up, not blocking for MVP.
--
-- Sizing: three nullable columns × user count. A populated row carries
-- ~512 bytes of tokens; un-connected users leave them NULL. Negligible.

alter table public.user_prefs
  add column soundcloud_access_token text,
  add column soundcloud_refresh_token text,
  add column soundcloud_token_expires_at timestamptz;

comment on column public.user_prefs.soundcloud_access_token is
  'OAuth 2.1 access token for the user''s SoundCloud account. '
  'Phase 5.8 — plain text under per-user RLS. Encrypt-at-rest via Vault is a follow-up.';

comment on column public.user_prefs.soundcloud_refresh_token is
  'OAuth 2.1 refresh token for the user''s SoundCloud account. '
  'Used to mint a new access token when the existing one expires.';

comment on column public.user_prefs.soundcloud_token_expires_at is
  'Timestamp at which soundcloud_access_token expires. Used by the '
  'follows-fetch wrapper (Phase 5.9+) to decide whether to refresh '
  'pre-emptively vs. wait for a 401.';
