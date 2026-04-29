// Phase 5.7 — Spotify follow-graph pathfinder client.
//
// Public API: `fetchUserFollowedArtists(userId)` →
// `SpotifyFollowedArtist[]`.
//
// Hits Spotify's pathfinder GraphQL endpoint
// (`api-partner.spotify.com/pathfinder/v1/query`) using:
//   - Bot session token from `bot-token.ts` (Bearer auth)
//   - Persisted-query sha256 hash from `hash-resolver.ts`
//   - operationName: queryArtistsFollowed
//   - variables: { uri: "spotify:user:{userId}" }
//
// Designed to work from BOTH:
//   - the Vercel server action driving the /profile connect card
//     (synchronous; one user at a time; warm-cache friendly)
//   - the Railway cron iterating every connected user (sequential
//     with a 1.5 req/sec outer throttle, see refresh-spotify-follows.ts)
//
// Pure fetch-based — no Node-specific deps, no Supabase, no Playwright.
// Same architecture shape as packages/ingestion/src/soundcloud/
// follows-scraper.ts.
//
// Playwright fallback (./playwright-fallback.ts) is scaffolded but NOT
// re-exported from index.ts. Activate by editing this file when
// pathfinder breaks.

import { getBotAccessToken, invalidateBotToken } from './bot-token.js';
import { getPersistedQueryHash, invalidateHash } from './hash-resolver.js';
import {
  ScrapeFailedError,
  SpotifyAuthFailedError,
  UserNotFoundError,
  type SpotifyFollowedArtist,
} from './types.js';

const PATHFINDER_URL = 'https://api-partner.spotify.com/pathfinder/v1/query';

// Spotify's pagination is cursor-less: offset + limit. limit=100 is
// the max accepted; smaller pages waste round-trips.
const PAGE_SIZE = 100;

// Polite delay between paginated calls. With PAGE_SIZE=100 and
// typical follow counts of 50-1000, this adds at most ~10 sleeps
// per sync — negligible vs the perceived sync time.
const PAGE_THROTTLE_MS = 250;

// Defensive cap: 50 pages × 100 = 5000 followed artists. Spotify
// soft-caps follows at ~10k but pagination overhead beyond 5k is
// suspicious for a user (they probably script-followed). Bail and
// surface so the caller can decide whether to widen.
const MAX_PAGES = 50;

// Spotify user ID format: numeric (legacy `1249423375`-style) or
// alphanumeric (newer `bjornblanchard`-style). 1-100 chars.
// Defensive validation against URL-injection at the GraphQL boundary
// — the userId gets interpolated into the URI variable.
const SPOTIFY_USER_ID_RE = /^[a-zA-Z0-9_.-]{1,100}$/;

const FETCH_HEADERS_BASE: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Accept: 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Content-Type': 'application/json',
};

// Minimal structural type for what pathfinder returns. We type the
// fields we actually consume; everything else stays implicit so a
// future Spotify schema shift fails at the access boundary rather
// than silently parsing.
type PathfinderResponse = {
  data?: {
    userProfile?: {
      followedArtists?: {
        totalCount?: number;
        items?: ArtistRowApi[];
      };
    };
  };
  errors?: Array<{
    message: string;
    extensions?: { code?: string };
  }>;
};

type ArtistRowApi = {
  uri: string; // e.g. "spotify:artist:06HL4z0CvFAxyc27GXpf02"
  name: string;
  visuals?: {
    avatarImage?: {
      sources?: Array<{ url?: string }>;
    };
  };
  profile?: {
    followers?: number;
  };
  followedAt?: string;
};

/**
 * Fetch every artist the given Spotify user publicly follows.
 *
 * @param userId Spotify user ID (the path segment after
 *               `https://open.spotify.com/user/`). Strip the `?si=`
 *               sharing tracker and any leading slash — the caller
 *               (server action) is expected to have pre-extracted
 *               this from a pasted URL via `extractSpotifyUserId()`.
 * @returns Array of followed artists. Empty array if the user
 *          follows no one (vs throwing — caller decides whether 0 is
 *          worth surfacing).
 *
 * @throws SpotifyAuthFailedError if the bot's sp_dc cookie is
 *   missing/expired/anonymous — Christian needs to re-paste.
 * @throws UserNotFoundError if the userId doesn't resolve to a public
 *   Spotify user, or the profile is set to private.
 * @throws ScrapeFailedError for transient or unexpected failures
 *   (5xx, persistent 400 after hash retry, unparseable JSON).
 */
export async function fetchUserFollowedArtists(
  userId: string,
): Promise<SpotifyFollowedArtist[]> {
  if (!SPOTIFY_USER_ID_RE.test(userId)) {
    throw new ScrapeFailedError(
      `Invalid Spotify user ID "${userId}" — must match ${SPOTIFY_USER_ID_RE.source}`,
    );
  }

  const out: SpotifyFollowedArtist[] = [];
  let offset = 0;
  let pages = 0;
  let totalCount: number | null = null;

  while (true) {
    const page = await fetchPage(userId, offset, PAGE_SIZE);

    // Spotify returns null `userProfile` for non-existent or strict-
    // private profiles. queryArtistsFollowed surfaces a public
    // followed-artists list as long as the target's profile privacy
    // setting allows; private accounts return null here.
    if (!page) {
      if (offset === 0) {
        throw new UserNotFoundError(userId);
      }
      // Mid-pagination null is very unusual — bail rather than
      // silent truncation. Caller can retry the whole sync.
      throw new ScrapeFailedError(
        `Pathfinder returned null mid-pagination at offset ${offset} for user ${userId}`,
      );
    }

    if (totalCount === null) totalCount = page.totalCount;

    if (page.items.length === 0) break;

    for (const item of page.items) {
      // URI shape: "spotify:artist:{base62Id}". Defensive guard
      // against a malformed URI — skip rather than throw.
      const m = item.uri.match(/^spotify:artist:([A-Za-z0-9]+)$/);
      if (!m || !m[1]) continue;
      out.push({
        spotifyId: m[1],
        name: item.name,
        imageUrl: item.visuals?.avatarImage?.sources?.[0]?.url ?? null,
        followers: item.profile?.followers ?? null,
        followedAt: item.followedAt ?? null,
      });
    }

    offset += page.items.length;
    pages += 1;

    // Two ways to stop:
    //   1. We've consumed totalCount items — clean exit.
    //   2. We hit the defensive page cap (5k follows, almost
    //      certainly an automation issue).
    if (totalCount !== null && offset >= totalCount) break;

    if (pages >= MAX_PAGES) {
      throw new ScrapeFailedError(
        `Pagination cap (${MAX_PAGES} pages = ${MAX_PAGES * PAGE_SIZE} ` +
          `follows) hit for user ${userId} — investigate`,
      );
    }

    await sleep(PAGE_THROTTLE_MS);
  }

  return out;
}

// ─── Page fetcher ───────────────────────────────────────────────────────

type PageResult = {
  totalCount: number;
  items: ArtistRowApi[];
};

/**
 * Fetch a single pathfinder page. Handles three retry paths:
 *   - 401 → invalidate bot token, retry once. Persistent 401 means
 *     the sp_dc cookie itself is expired → SpotifyAuthFailedError.
 *   - 400 with PERSISTED_QUERY_NOT_FOUND → invalidate hash, retry
 *     once. Hash rotation is normal Spotify operation.
 *   - 429 → sleep 5s, retry once.
 */
async function fetchPage(
  userId: string,
  offset: number,
  limit: number,
): Promise<PageResult | null> {
  const attempt = async (): Promise<
    | { ok: true; result: PageResult | null }
    | { ok: false; status: number; code?: string }
  > => {
    const [token, hash] = await Promise.all([
      getBotAccessToken(),
      getPersistedQueryHash('queryArtistsFollowed'),
    ]);

    const body = JSON.stringify({
      operationName: 'queryArtistsFollowed',
      variables: {
        uri: `spotify:user:${userId}`,
        offset,
        limit,
      },
      extensions: {
        persistedQuery: {
          version: 1,
          sha256Hash: hash,
        },
      },
    });

    const res = await fetch(PATHFINDER_URL, {
      method: 'POST',
      headers: {
        ...FETCH_HEADERS_BASE,
        Authorization: `Bearer ${token}`,
      },
      body,
    });

    if (res.status === 401) {
      invalidateBotToken();
      return { ok: false, status: 401 };
    }
    if (res.status === 429) {
      return { ok: false, status: 429 };
    }
    if (res.status === 400) {
      const payload = (await res.json().catch(() => null)) as
        | PathfinderResponse
        | null;
      const code = payload?.errors?.[0]?.extensions?.code;
      if (code === 'PERSISTED_QUERY_NOT_FOUND') {
        invalidateHash('queryArtistsFollowed');
        return { ok: false, status: 400, code };
      }
      // Other 400s = malformed query / variable; unlikely to recover
      throw new ScrapeFailedError(
        `Pathfinder 400: ${payload?.errors?.[0]?.message ?? 'unknown'}`,
      );
    }
    if (!res.ok) {
      throw new ScrapeFailedError(
        `Pathfinder ${res.status} ${res.statusText}`,
      );
    }

    const json = (await res.json()) as PathfinderResponse;
    if (json.errors && json.errors.length > 0) {
      throw new ScrapeFailedError(
        `Pathfinder errors: ${json.errors.map((e) => e.message).join('; ')}`,
      );
    }

    const followed = json.data?.userProfile?.followedArtists;
    if (!followed) {
      // Profile is private or doesn't exist. Surface as "no result".
      return { ok: true, result: null };
    }
    return {
      ok: true,
      result: {
        totalCount: followed.totalCount ?? 0,
        items: followed.items ?? [],
      },
    };
  };

  const first = await attempt();
  if (first.ok) return first.result;

  // One retry: bot-token rotation, hash rotation, OR rate-limit cooldown.
  if (first.status === 429) await sleep(5000);

  const second = await attempt();
  if (second.ok) return second.result;

  // Persistent 401 = sp_dc cookie really is dead.
  if (second.status === 401) {
    throw new SpotifyAuthFailedError(
      'Pathfinder 401 after bot-token refresh — sp_dc cookie likely expired',
    );
  }
  // Persistent 400 = hash rotation didn't help; bundle structure
  // probably changed and our regex needs an update.
  if (second.status === 400 && second.code === 'PERSISTED_QUERY_NOT_FOUND') {
    throw new ScrapeFailedError(
      'Pathfinder PERSISTED_QUERY_NOT_FOUND after hash refresh — ' +
        'bundle reformat or operation renamed; update hash-resolver.ts',
    );
  }
  throw new ScrapeFailedError(
    `Pathfinder ${second.status} after retry — giving up`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
