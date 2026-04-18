// Smoke test: hit MusicBrainz for a handful of known-in-house artists and
// print what tags / genres come back. Verifies (a) the 1 req/sec gate holds,
// (b) results look usable, (c) nothing throws.
//
// Run from packages/ingestion/:
//   npx tsx scripts/smoke-musicbrainz.ts
import { enrichArtist } from '../src/musicbrainz.js';

const SAMPLE_ARTISTS = [
  'DJ Python',
  'Yaeji',
  'Floating Points',
  'Octo Octa',
  'Eris Drew',
  'mu tate', // lowercase, test robustness
  'Kaleena Zanders',
];

async function main() {
  const start = Date.now();
  for (const name of SAMPLE_ARTISTS) {
    const t0 = Date.now();
    const detail = await enrichArtist(name);
    const ms = Date.now() - t0;
    if (!detail) {
      console.log(`[${ms}ms] ${name} → no MB match`);
      continue;
    }
    const tagSummary = detail.tags
      .slice()
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
      .map((t) => `${t.name}(${t.count})`)
      .join(', ');
    const genreSummary = detail.genres
      .slice()
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
      .map((g) => `${g.name}(${g.count})`)
      .join(', ');
    console.log(`[${ms}ms] ${name} → mbid=${detail.id}`);
    console.log(`         tags:   ${tagSummary || '(none)'}`);
    console.log(`         genres: ${genreSummary || '(none)'}`);
  }
  const total = Date.now() - start;
  console.log(`\n${SAMPLE_ARTISTS.length} artists in ${total}ms`);
  console.log(
    `avg ${Math.round(total / SAMPLE_ARTISTS.length)}ms/artist — should be ≥ ~2100ms (search + lookup, 1 req/s each)`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
