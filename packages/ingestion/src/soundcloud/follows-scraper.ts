// Phase 5.6.2 — SoundCloud follow-graph scraper.
//
// Public API: `scrapeUserFollows(username)` → `ScrapedFollow[]`.
//
// Hits SC's api-v2 (the JSON backend their modern web app uses):
//   1. Resolve the user's public slug → numeric `id` via `/resolve`
//   2. Paginate `/users/{id}/followings` with `limit=200`, following
//      `next_href` until the cursor is null
//   3. Map each row to `ScrapedFollow` with the username lowercased
//
// Designed to work from BOTH:
//   - the Vercel server action driving the /profile connect card
//     (synchronous; one user at a time; warm-cache friendly)
//   - the Railway cron iterating every connected user (sequential
//     with a 1 req/sec outer throttle, see refresh-soundcloud-follows.ts)
//
// Pure fetch-based — no Node-specific deps, no Supabase, no Playwright.
// That keeps the Next.js bundle size cost of `transpilePackages` minimal
// (the scraper compiles to a small fetch wrapper).
//
// Playwright fallback (./playwright-fallback.ts) is scaffolded but NOT
// re-exported from index.ts. Activate by editing this file when api-v2
// breaks.

import { getClientId, invalidateClientId } from './client-id.js';
import {
  ScrapeFailedError,
  UserNotFoundError,
  type ScrapedFollow,
} from './types.js';

const API_V2 = 'https://api-v2.soundcloud.com';
const PAGE_SIZE = 200; // SC's per-page max
const PAGE_THROTTLE_MS = 200; // Polite delay between paginated calls

// SC's username slug rules: alphanumerics, hyphens, underscores, 1-80
// chars. Defensive validation against URL injection — the username
// gets interpolated into a URL via `encodeURIComponent`, so the regex
// is belt-and-suspenders.
const USERNAME_RE = /^[a-zA-Z0-9_-]{1,80}$/;

// Plain Record because packages/ingestion's tsconfig doesn't pull in
// DOM lib types — the apps/web copy uses `HeadersInit`. Functionally
// identical at the fetch() boundary; the type just narrows to a
// shape every fetch implementation accepts.
const FETCH_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Accept: 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
};

// Shape of a user node in api-v2 responses. Fields we don't use are
// intentionally typed as `unknown` rather than omitted so a future SC
// schema shift fails type-check rather than silently parsing.
type ApiV2User = {
  id: number;
  permalink: string; // The slug. Lowercased by SC.
  username: string; // The display name (yes, confusingly).
  kind: 'user' | string;
};

type ApiV2FollowingsPage = {
  collection: ApiV2Following[];
  next_href: string | null;
};

type ApiV2Following = {
  id: number;
  permalink: string;
  username: string;
  created_at?: string; // ISO timestamp; not always present.
};

/**
 * Scrape every artist the given SoundCloud user publicly follows.
 *
 * @param username SC profile slug (the path segment after `soundcloud.com/`).
 *                 Pass without leading slash. Caller is expected to have
 *                 stripped the `soundcloud.com/` prefix already.
 * @returns Array of followed artists. Empty array if the user follows
 *          no one (vs. throwing — the caller can decide whether 0 is
 *          worth surfacing as a confusing "0 imported" toast).
 *
 * @throws UserNotFoundError if the username doesn't resolve to a public user.
 * @throws ScrapeFailedError for transient or unexpected failures.
 */
export async function scrapeUserFollows(
  username: string,
): Promise<ScrapedFollow[]> {
  if (!USERNAME_RE.test(username)) {
    throw new ScrapeFailedError(
      `Invalid username "${username}" — must match ${USERNAME_RE.source}`,
    );
  }

  const userId = await resolveUserId(username);
  return paginateFollowings(userId);
}

// ─── /resolve — slug → numeric id ──────────────────────────────────────

async function resolveUserId(username: string): Promise<number> {
  // Note: we URL-encode the slug, but SC's resolver is permissive about
  // case and trailing slashes. The validation regex above already gates
  // most ambiguity.
  const buildUrl = (clientId: string) =>
    `${API_V2}/resolve?url=${encodeURIComponent(
      `https://soundcloud.com/${username}`,
    )}&client_id=${clientId}`;

  const data = await fetchJsonWithRetry<ApiV2User>(buildUrl, {
    onNotFound: () => {
      throw new UserNotFoundError(username);
    },
  });

  if (data.kind !== 'user') {
    // The slug resolved to something — track, playlist, etc — that
    // isn't a user account. Treat as not-found from the user's POV.
    throw new UserNotFoundError(username);
  }

  return data.id;
}

// ─── /users/{id}/followings — paginated ────────────────────────────────

async function paginateFollowings(userId: number): Promise<ScrapedFollow[]> {
  const out: ScrapedFollow[] = [];

  // First page URL builder is parameterized by client_id (the retry
  // loop swaps it on 401/403 rotation). Subsequent pages use SC's
  // `next_href` directly, which already embeds a fresh client_id.
  const firstPageBuilder = (clientId: string) =>
    `${API_V2}/users/${userId}/followings?client_id=${clientId}&limit=${PAGE_SIZE}`;

  let nextUrl: string | ((cid: string) => string) = firstPageBuilder;
  let pages = 0;

  while (nextUrl) {
    const page: ApiV2FollowingsPage =
      typeof nextUrl === 'function'
        ? await fetchJsonWithRetry<ApiV2FollowingsPage>(nextUrl)
        : // For follow-up pages we use the absolute URL from `next_href`
          // unmodified, since SC has already attached its own client_id
          // to it. If THAT 401s mid-pagination (rare), we re-throw —
          // a partial result here would be silently wrong, better to
          // surface and let the caller retry the whole sync.
          await fetchJsonAbsolute<ApiV2FollowingsPage>(nextUrl);

    for (const f of page.collection) {
      if (!f.permalink) continue; // Defensive: SC has emitted nulls
      out.push({
        username: f.permalink.toLowerCase(),
        displayName: f.username ?? f.permalink,
        followedAt: f.created_at ?? null,
      });
    }

    nextUrl = page.next_href ?? '';
    pages += 1;

    // Polite throttle between paginated calls. With PAGE_SIZE=200 and
    // typical follow counts of 50-500, this adds at most 2 sleeps per
    // sync — negligible vs the perceived sync time.
    if (nextUrl) await sleep(PAGE_THROTTLE_MS);

    // Defensive cap: 50 pages = 10,000 follows. Power users might have
    // 1-2k follows; 10k means something's wrong (infinite loop, or
    // an SC user who follows the platform itself). Bail.
    if (pages >= 50) {
      throw new ScrapeFailedError(
        `Pagination cap (50 pages) hit for user ${userId} — something is wrong`,
      );
    }
  }

  return out;
}

// ─── Fetch helpers ─────────────────────────────────────────────────────

type FetchOpts = {
  /** Called when the response is 404. Default: throw ScrapeFailedError.
   *  /resolve uses this hook to map 404 → UserNotFoundError. */
  onNotFound?: () => never;
};

/**
 * Fetch a JSON URL whose construction depends on the client_id. On
 * 401/403, invalidate the cache, re-resolve client_id, and retry once.
 * On 429, sleep 5s and retry once.
 */
async function fetchJsonWithRetry<T>(
  buildUrl: (clientId: string) => string,
  opts: FetchOpts = {},
): Promise<T> {
  const attempt = async (): Promise<{ ok: true; data: T } | { ok: false; status: number }> => {
    const clientId = await getClientId();
    const url = buildUrl(clientId);
    const res = await fetch(url, { headers: FETCH_HEADERS });
    if (res.status === 404) {
      if (opts.onNotFound) opts.onNotFound();
      throw new ScrapeFailedError(`SC 404: ${url}`);
    }
    if (res.status === 401 || res.status === 403) {
      // client_id rotated. Invalidate + retry once.
      invalidateClientId();
      return { ok: false, status: res.status };
    }
    if (res.status === 429) {
      // Rate limited. Wait + retry once.
      return { ok: false, status: 429 };
    }
    if (!res.ok) {
      throw new ScrapeFailedError(
        `SC ${res.status} ${res.statusText}: ${url}`,
      );
    }
    return { ok: true, data: (await res.json()) as T };
  };

  const first = await attempt();
  if (first.ok) return first.data;

  // One retry: client_id rotation OR rate-limit cooldown.
  if (first.status === 429) await sleep(5000);

  const second = await attempt();
  if (second.ok) return second.data;

  throw new ScrapeFailedError(
    `SC ${second.status} after retry — giving up`,
  );
}

/**
 * Fetch a JSON URL whose absolute form is already constructed (e.g.
 * SC's `next_href` between paginated pages). No retry on 401/403 here
 * — the URL was minted by SC moments ago, so a failure mid-pagination
 * means something's drifted, and we'd rather surface than partially
 * complete. Caller decides whether to start a fresh sync.
 */
async function fetchJsonAbsolute<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: FETCH_HEADERS });
  if (!res.ok) {
    throw new ScrapeFailedError(
      `SC pagination ${res.status} ${res.statusText}: ${url}`,
    );
  }
  return (await res.json()) as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
