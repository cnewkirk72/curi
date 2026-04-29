// Phase 5.6.2 — public types for the SoundCloud follow-graph scraper.
//
// NOTE: This is a copy of packages/ingestion/src/soundcloud/types.ts.
// Both copies must stay in sync. Same dual-copy convention as
// apps/web/src/lib/supabase/types.ts ↔ packages/ingestion/src/db-types.ts.
// If we add a third consumer or move to a shared workspace package,
// extract into @curi/sc-scraper.
//
// Why the duplication: the canonical scraper lives in packages/ingestion
// for the Railway cron's use, but apps/web's server action (driving the
// /profile connect card) needs the same code path. Cross-workspace
// imports require a pnpm-lock.yaml regeneration that introduces deploy
// risk on Vercel's --frozen-lockfile install — the duplication keeps
// each workspace self-contained at the cost of two-file maintenance.

export type ScrapedFollow = {
  username: string;
  displayName: string;
  followedAt: string | null;
};

export class UserNotFoundError extends Error {
  constructor(public readonly username: string) {
    super(`SoundCloud user "${username}" not found`);
    this.name = 'UserNotFoundError';
  }
}

export class ScrapeFailedError extends Error {
  // `override` modifier required by newer TS lib — `Error` has a
  // built-in `cause` property in ES2022+. We're widening the type
  // from `unknown` to a more meaningful structured cause, so the
  // override declaration matches.
  constructor(message: string, public override readonly cause?: unknown) {
    super(message);
    this.name = 'ScrapeFailedError';
  }
}
