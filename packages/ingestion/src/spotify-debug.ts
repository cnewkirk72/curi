#!/usr/bin/env node
// Raw Spotify API debug probe. Bypasses our client wrapper and dumps the
// literal JSON coming back from Spotify so we can see exactly what's
// populated on the wire.
//
// Why: the eval consistently shows popularity=0, followers=0, genres=[] for
// matched artists — including Honey Dijon and Four Tet, which obviously
// have real data on Spotify's own site. The /v1/artists/{id} second-call
// fix is confirmed applied (see searchArtistOnSpotify in spotify.ts), yet
// fields stay empty. This probes whether:
//
//   (a) Spotify is returning empty fields in the raw payload — which
//       would match the Nov 2024 Web API deprecation for apps registered
//       after that date (popularity / genres / followers restricted), or
//   (b) Our client wrapper is dropping the data between fetch and toMatch
//
// Run:
//   pnpm --filter @curi/ingestion exec tsx src/spotify-debug.ts

import { env } from './env.js';

async function main(): Promise<void> {
  if (!env.spotifyClientId || !env.spotifyClientSecret) {
    console.error(
      'Spotify credentials not set. Add SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET to your .env.local and retry.',
    );
    process.exit(2);
  }

  // 1. Token (Client Credentials)
  const basic = Buffer.from(
    `${env.spotifyClientId}:${env.spotifyClientSecret}`,
  ).toString('base64');
  const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!tokenRes.ok) {
    const body = await tokenRes.text().catch(() => '');
    console.error(`token failed ${tokenRes.status}: ${body}`);
    process.exit(1);
  }
  const tokenJson = (await tokenRes.json()) as { access_token: string };
  const token = tokenJson.access_token;
  console.log(`✓ token acquired (len ${token.length})`);

  // 2. Raw /v1/search for Honey Dijon
  const query = encodeURIComponent('Honey Dijon');
  const searchRes = await fetch(
    `https://api.spotify.com/v1/search?q=${query}&type=artist&limit=3`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const searchJson = (await searchRes.json()) as {
    artists?: { items?: Array<Record<string, unknown>> };
  };
  const firstItem = searchJson.artists?.items?.[0];

  console.log('\n── RAW /v1/search?q=Honey+Dijon (first item) ──');
  console.log(JSON.stringify(firstItem, null, 2));

  if (!firstItem || typeof firstItem.id !== 'string') {
    console.error('no artist in search response; bailing');
    process.exit(1);
  }
  const id = firstItem.id;

  // 3. Raw /v1/artists/{id}
  const artistRes = await fetch(`https://api.spotify.com/v1/artists/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const artistJson = (await artistRes.json()) as Record<string, unknown>;

  console.log('\n── RAW /v1/artists/' + id + ' ──');
  console.log(JSON.stringify(artistJson, null, 2));

  // 4. Field-by-field summary
  console.log('\n── KEY FIELDS ──');
  const pop = (artistJson as { popularity?: unknown }).popularity;
  const followers = (artistJson as { followers?: { total?: unknown } }).followers;
  const genres = (artistJson as { genres?: unknown }).genres;
  console.log(`popularity:         ${pop === undefined ? '(undefined)' : JSON.stringify(pop)}`);
  console.log(`followers.total:    ${followers?.total === undefined ? '(undefined)' : JSON.stringify(followers.total)}`);
  console.log(`genres:             ${genres === undefined ? '(undefined)' : JSON.stringify(genres)}`);
  console.log(
    `\nInterpretation:\n` +
      `  • If popularity / followers.total / genres are populated → our wrapper is the problem.\n` +
      `  • If they are 0 / 0 / [] or undefined → this is the Nov 2024 Web API deprecation for new apps.\n` +
      `    In that case Spotify is not a viable enrichment source; pivot to Last.fm or LLM.\n`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
