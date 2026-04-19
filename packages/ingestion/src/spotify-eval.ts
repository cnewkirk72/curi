#!/usr/bin/env node
// Quick eval harness for the Spotify Web API client.
//
// Runs searchArtistOnSpotify() against a curated list of names spanning
// well-known acts, mid-tier underground DJs, niche/emerging artists, and
// known-hard cases (single-token names, non-artist placeholders). Prints a
// compact table so we can eyeball match quality BEFORE wiring Spotify into
// the nightly enrichment path.
//
// Run:
//   pnpm --filter @curi/ingestion exec tsx src/spotify-eval.ts
//
// Or from inside packages/ingestion:
//   pnpm exec tsx src/spotify-eval.ts
//
// Requires SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in your local .env.
// Does NOT write to Supabase — read-only evaluation.

import { env } from './env.js';
import { searchArtistOnSpotify } from './spotify.js';

// Curated fixtures. Each row includes a rough expectation so we can
// eye-scan the output table. "expect" is a hint, not an assertion — the goal
// is to see where Spotify's catalog + our match rules agree or miss.
//
// Picks skew toward names that actually appear (or are likely to appear) on
// the NYC underground rotation, because that's the population we'll run this
// against in production.
const FIXTURES: Array<{ name: string; expect: string }> = [
  // Well-known electronic / dance — should come back high confidence.
  { name: 'Honey Dijon',       expect: 'high, house/disco' },
  { name: 'Four Tet',          expect: 'high, electronic' },
  { name: 'Floating Points',   expect: 'high, electronic' },
  { name: 'Peggy Gou',         expect: 'high, house' },
  { name: 'DJ Python',         expect: 'high, deconstructed club' },

  // Mid-tier underground — should resolve but popularity may push to medium.
  { name: 'Eris Drew',         expect: 'medium/high, house' },
  { name: 'Octo Octa',         expect: 'medium/high, house' },
  { name: 'DJ Voices',         expect: 'medium, eclectic' },
  { name: 'Anthony Naples',    expect: 'medium/high, house' },
  { name: 'Physical Therapy',  expect: 'medium, house/techno' },

  // Niche / new — common case; interesting to see coverage floor.
  { name: 'Kush Jones',        expect: 'medium, footwork' },
  { name: 'Jasmine Infiniti',  expect: 'medium, techno' },
  { name: 'BEARCAT',           expect: 'medium, electronic' },
  { name: 'MoMA Ready',        expect: 'medium, techno' },
  { name: 'Turtle Bugg',       expect: 'medium/low, house' },

  // Known-hard single-token names (MB false-positive pattern — Spotify also
  // has this problem but our confidence field is meant to surface it).
  { name: 'Yaya',              expect: 'likely low / null — ambiguous' },
  { name: 'BIGGIE',            expect: 'likely wrong-artist hit or low' },
  { name: 'Jupiter',           expect: 'likely low / null — many artists' },

  // Non-artist placeholders — should be rejected before hitting the API.
  { name: 'TBA',               expect: 'null (literal skip)' },
  { name: 'Various Artists',   expect: 'null (literal skip)' },

  // Diacritics + punctuation — sanity check on normalizeForCompare.
  { name: 'Björk',             expect: 'high, electronic/experimental' },
  { name: 'DJ /rupture',       expect: 'medium, eclectic' },
];

function pad(s: string, n: number): string {
  if (s.length >= n) return s.slice(0, n - 1) + '…';
  return s + ' '.repeat(n - s.length);
}

async function main(): Promise<void> {
  if (!env.spotifyClientId || !env.spotifyClientSecret) {
    console.error(
      'Spotify credentials not set. Add SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET to your .env and retry.',
    );
    process.exitCode = 2;
    return;
  }

  console.log(
    `Running Spotify match eval on ${FIXTURES.length} fixtures. This sends one\n` +
      `/search request per row (~100ms throttle). Read-only — nothing written.\n`,
  );

  // Header.
  console.log(
    pad('input', 22) +
      pad('conf', 8) +
      pad('match', 22) +
      pad('pop', 5) +
      pad('followers', 11) +
      'genres',
  );
  console.log('─'.repeat(100));

  let hits = 0;
  let misses = 0;
  let errors = 0;
  for (const { name, expect } of FIXTURES) {
    try {
      const m = await searchArtistOnSpotify(name);
      if (!m) {
        misses++;
        console.log(
          pad(name, 22) +
            pad('—', 8) +
            pad('(no match)', 22) +
            pad('—', 5) +
            pad('—', 11) +
            `  expect: ${expect}`,
        );
        continue;
      }
      // Defensive reads so a single weird response row doesn't crash the run.
      const genresList = m.genres ?? [];
      const genres = genresList.length > 0 ? genresList.join(', ') : '(none)';
      console.log(
        pad(name, 22) +
          pad(m.confidence, 8) +
          pad(m.name ?? '(unnamed)', 22) +
          pad(String(m.popularity ?? 0), 5) +
          pad((m.followers ?? 0).toLocaleString(), 11) +
          genres,
      );
      // Only count as a hit AFTER the print succeeds — prior version bumped
      // hits before the print, so a throw in the format block would also bump
      // the catch-branch miss counter, double-counting the row.
      hits++;
    } catch (err) {
      errors++;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(pad(name, 22) + pad('ERROR', 8) + msg);
    }
  }

  console.log('─'.repeat(100));
  console.log(
    `${hits} matched · ${misses} no-match · ${errors} errored · ${FIXTURES.length} total`,
  );
  console.log(
    '\nNext step: inspect rows marked (no match) or low confidence and decide\n' +
      'whether to (a) fall back to a second-pass fuzzy search, (b) route to an\n' +
      'LLM enrichment layer, or (c) accept the miss and leave genres empty.',
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
