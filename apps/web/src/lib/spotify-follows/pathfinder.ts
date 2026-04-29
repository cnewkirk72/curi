// Phase 5.7 — Spotify follow-graph pathfinder client.
//
// NOTE: Dual-copy of packages/ingestion/src/spotify-follows/pathfinder.ts.
// See ./types.ts for the dual-copy rationale.

import { getBotAccessToken, invalidateBotToken } from './bot-token';
import { getPersistedQueryHash, invalidateHash } from './hash-resolver';
import {
  ScrapeFailedError,
  SpotifyAuthFailedError,
  UserNotFoundError,
  type SpotifyFollowedArtist,
} from './types';

const PATHFINDER_URL = 'https://api-partner.spotify.com/pathfinder/v1/query';
const PAGE_SIZE = 100;
const PAGE_THROTTLE_MS = 250;
const MAX_PAGES = 50;
const SPOTIFY_USER_ID_RE = /^[a-zA-Z0-9_.-]{1,100}$/;

const FETCH_HEADERS_BASE: HeadersInit = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Accept: 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Content-Type': 'application/json',
};

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
  uri: string;
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

    if (!page) {
      if (offset === 0) {
        throw new UserNotFoundError(userId);
      }
      throw new ScrapeFailedError(
        `Pathfinder returned null mid-pagination at offset ${offset} for user ${userId}`,
      );
    }

    if (totalCount === null) totalCount = page.totalCount;

    if (page.items.length === 0) break;

    for (const item of page.items) {
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

type PageResult = {
  totalCount: number;
  items: ArtistRowApi[];
};

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

  if (first.status === 429) await sleep(5000);

  const second = await attempt();
  if (second.ok) return second.result;

  if (second.status === 401) {
    throw new SpotifyAuthFailedError(
      'Pathfinder 401 after bot-token refresh — sp_dc cookie likely expired',
    );
  }
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
