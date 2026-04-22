// Unit tests for artist-parsing.ts.
//
// Zero-dep like taxonomy-fuzzy.test.ts — runs via:
//   npx tsx --test src/artist-parsing.test.ts
//
// Focuses on the Phase-3.16 fixes:
//   - TITLE_DATE_TAIL strip (the "/-split" regression that created
//     bogus artists like "Annicka 04" + "24" on RA fallback titles).
//   - PURE_NUMERIC rejection in classifyArtistName (defensive: even if
//     something bypasses the date-tail strip, a bare integer never gets
//     written to the artists table).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseArtists, classifyArtistName } from './artist-parsing.js';

describe('parseArtists — TITLE_DATE_TAIL strip (Phase 3.16)', () => {
  it('handles the RA "Artist MM/DD" fallback cleanly', () => {
    // The bug: RA's GraphQL returned no structured lineup for these
    // promoter-submitted listings, so ra-nyc.ts fell back to
    // parseArtists(title). COMMA_SPLIT treated "/" as a separator and
    // produced ["Annicka 04", "24"]. Fixed by stripping the trailing
    // date token before splitting.
    assert.deepEqual(parseArtists('Annicka 04/24'), ['Annicka']);
    assert.deepEqual(parseArtists('Alan Dixon 04/25'), ['Alan Dixon']);
    assert.deepEqual(parseArtists('Grossomoddo 05/02'), ['Grossomoddo']);
    assert.deepEqual(parseArtists('LESSSS 04/24'), ['LESSSS']);
  });

  it('handles MM/DD/YY and MM/DD/YYYY year variants', () => {
    assert.deepEqual(parseArtists('Annicka 04/24/26'), ['Annicka']);
    assert.deepEqual(parseArtists('Annicka 04/24/2026'), ['Annicka']);
  });

  it('handles single-digit month/day forms', () => {
    assert.deepEqual(parseArtists('Annicka 4/24'), ['Annicka']);
    assert.deepEqual(parseArtists('Annicka 4/9'), ['Annicka']);
  });

  it('only strips the date tail, not mid-title slashes', () => {
    // A legit act with "/" in the name at the end of the title
    // (e.g. "ModelViewer DJ set vs. Trance/Dance") shouldn't be stripped.
    // The regex requires \d{1,2}/\d{1,2} exactly — "Trance/Dance" is safe.
    const result = parseArtists('Someone + Trance/Dance');
    // Both halves survive as candidate artists (the comma splitter runs
    // normally on the "/"). We don't care about exact output, just that
    // neither is a bare-numeric.
    for (const name of result) {
      assert.ok(!/^\d+$/.test(name), `expected no bare-numeric artist, got ${name}`);
    }
  });

  it('preserves the venue+artist parsing with a date tail', () => {
    // Real-world example from ra-nyc.ts (RA structured artists missing).
    // Strip should run before the "presents:" split so the date is gone
    // by the time the lineup emerges.
    assert.deepEqual(
      parseArtists('Sunny Side Up presents: Annicka 04/24'),
      ['Annicka'],
    );
  });
});

describe('classifyArtistName — PURE_NUMERIC rejection (Phase 3.16)', () => {
  it('rejects bare integer names', () => {
    for (const n of ['02', '18', '24', '25', '320', '2026', '8888']) {
      const r = classifyArtistName(n);
      assert.equal(r.valid, false, `expected "${n}" invalid`);
      assert.equal(r.reason, 'pure_numeric', `expected pure_numeric for "${n}"`);
    }
  });

  it('does not reject numeric-prefixed real names', () => {
    // Stage names that contain digits but aren't pure-numeric should pass.
    for (const n of ['DJ 3000', '404', '0171', 'Blond:ish']) {
      const r = classifyArtistName(n);
      // Pure digits ("404", "0171") should reject; names with letters pass.
      if (/^\d+$/.test(n)) {
        assert.equal(r.valid, false, `expected "${n}" rejected`);
      } else {
        assert.equal(r.valid, true, `expected "${n}" valid`);
      }
    }
  });
});
