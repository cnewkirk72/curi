// Phase 5.6.2 — SoundCloud follow-graph scraper.
//
// NOTE: This is a copy of packages/ingestion/src/soundcloud/follows-scraper.ts.
// Both copies must stay in sync — see ./types.ts for the dual-copy
// rationale.
//
// Public API: `scrapeUserFollows(username)` → `ScrapedFollow[]`.
//
// Hits SC's api-v2 (the JSON backend their modern web app uses):
//   1. Resolve the user's public slug → numeric `id` via `/resolve`
//   2. Paginate `/users/{id}/followings` with `limit=200`, following
//      `next_href` until the cursor is null
//   3. Map each row to `ScrapedFollow` with the username lowercased
//
// Pure fetch-based — no Node-specific deps, no Supabase, no Playwright.
// Safe to import from a Vercel server action OR the Railway cron.

import { getClientId, invalidateClientId } from './client-id';
import {
  ScrapeFailedError,
  UserNotFoundError,
  type ScrapedFollow,
} from './types';

const API_V2 = 'https://api-v2.soundcloud.com';
const PAGE_SIZE = 200;
const PAGE_THROTTLE_MS = 200;

const USERNAME_RE = /^[a-zA-Z0-9_-]{1,80}$/;

const FETCH_HEADERS: HeadersInit = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Accept: 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
};

type ApiV2User = {
  id: number;
  permalink: string;
  username: string;
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
  created_at?: string;
};

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

async function resolveUserId(username: string): Promise<number> {
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
    throw new UserNotFoundError(username);
  }

  return data.id;
}

async function paginateFollowings(userId: number): Promise<ScrapedFollow[]> {
  const out: ScrapedFollow[] = [];

  const firstPageBuilder = (clientId: string) =>
    `${API_V2}/users/${userId}/followings?client_id=${clientId}&limit=${PAGE_SIZE}`;

  let nextUrl: string | ((cid: string) => string) = firstPageBuilder;
  let pages = 0;

  while (nextUrl) {
    const page: ApiV2FollowingsPage =
      typeof nextUrl === 'function'
        ? await fetchJsonWithRetry<ApiV2FollowingsPage>(nextUrl)
        : await fetchJsonAbsolute<ApiV2FollowingsPage>(nextUrl);

    for (const f of page.collection) {
      if (!f.permalink) continue;
      out.push({
        username: f.permalink.toLowerCase(),
        displayName: f.username ?? f.permalink,
        followedAt: f.created_at ?? null,
      });
    }

    nextUrl = page.next_href ?? '';
    pages += 1;

    if (nextUrl) await sleep(PAGE_THROTTLE_MS);

    if (pages >= 50) {
      throw new ScrapeFailedError(
        `Pagination cap (50 pages) hit for user ${userId} — something is wrong`,
      );
    }
  }

  return out;
}

type FetchOpts = {
  onNotFound?: () => never;
};

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
      invalidateClientId();
      return { ok: false, status: res.status };
    }
    if (res.status === 429) {
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

  if (first.status === 429) await sleep(5000);

  const second = await attempt();
  if (second.ok) return second.data;

  throw new ScrapeFailedError(
    `SC ${second.status} after retry — giving up`,
  );
}

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
