// LLM-driven artist enrichment (Phase 4c).
//
// Given an artist name + event context, ask Sonnet 4.6 to produce a
// structured genre/subgenre/vibe tag set. The model uses three tools
// to escalate when its training knowledge is thin:
//
//   1. search_web               → Exa neural search for fresh context
//   2. find_artist_profile      → Exa domain-scoped SC/BC lookup
//   3. fetch_artist_self_tags   → Firecrawl pull of artist-authored
//                                  hashtags from profile + recent tracks
//
// And one terminal tool:
//
//   4. submit_enrichment        → called exactly once with the final
//                                  result. The loop exits when the
//                                  model stops (end_turn) after this.
//
// Post-processing: the model's output is normalized through the same
// fuzzy-taxonomy matcher from Phase 4a (canonical form + Levenshtein
// near-match), so spelling drift ("hardtranse") silently merges into
// the existing vocabulary ("hard-trance") instead of creating a
// near-duplicate row.

import { supabase } from './supabase.js';
import {
  runToolLoop,
  type ToolDefinition,
  type ToolInvocation,
} from './anthropic.js';
import { searchExa, findProfileUrls, type ExaResult } from './exa.js';
import { fetchArtistSelfTags } from './firecrawl.js';
import { findNearMatch, normalizeForTaxonomy } from './taxonomy-fuzzy.js';

// ── Public types ────────────────────────────────────────────────────

export interface EnrichmentContext {
  /** Venue default_genres/default_vibes if available. */
  venueDefaults?: { genres: string[]; vibes: string[] };
  /** Names of artists on the same bill. */
  coBilledArtists?: string[];
  /** Any existing MusicBrainz tag hints from prior enrichment. */
  existingMbTags?: string[];
  /** City (default NYC). */
  city?: string;
  /** Event date (ISO string). */
  eventDate?: string;
}

export interface EnrichmentResult {
  genres: string[];
  subgenres: string[];
  vibes: string[];
  confidence: 'high' | 'medium' | 'low';
  sources: string[];
  reasoning: string;
  /** Which tools the model invoked, in order (debug signal). */
  toolTrace: string[];
  /** Tags silently merged via tier-2 fuzzy match (for post-run review). */
  fuzzyMerges: Array<{ proposed: string; merged: string; distance: number }>;
}

// ── Vocabulary loader ─────────────────────────────────────────────────

interface Vocabulary {
  parentGenres: string[]; // flattened taxonomy_map.genres, deduped
  subgenres: string[]; // taxonomy_subgenres.input_tag
  vibes: string[]; // distinct artists.vibes values
}

let vocabCache: Vocabulary | null = null;

/**
 * Load the current taxonomy vocabulary from Supabase. Cached per
 * process because it's used to seed the system prompt for every
 * enrichment call. Cache invalidates on process restart — acceptable
 * since a full backfill runs in one process.
 */
export async function loadVocabulary(): Promise<Vocabulary> {
  if (vocabCache) return vocabCache;
  const client = supabase();

  const [mapRes, subRes, artistsRes] = await Promise.all([
    client.from('taxonomy_map').select('genres'),
    client.from('taxonomy_subgenres').select('input_tag'),
    client.from('artists').select('vibes'),
  ]);

  if (mapRes.error) throw mapRes.error;
  if (subRes.error) throw subRes.error;
  if (artistsRes.error) throw artistsRes.error;

  const parentSet = new Set<string>();
  for (const row of mapRes.data ?? []) {
    for (const g of row.genres ?? []) parentSet.add(g);
  }

  const subSet = new Set<string>();
  for (const row of subRes.data ?? []) {
    if (row.input_tag) subSet.add(row.input_tag);
  }

  const vibeSet = new Set<string>();
  for (const row of artistsRes.data ?? []) {
    for (const v of row.vibes ?? []) vibeSet.add(v);
  }

  vocabCache = {
    parentGenres: [...parentSet].sort(),
    subgenres: [...subSet].sort(),
    vibes: [...vibeSet].sort(),
  };
  return vocabCache;
}

/** Clear the cached vocabulary. Exposed for tests / long-lived processes. */
export function _resetVocabularyCache(): void {
  vocabCache = null;
}

// ── Prompt builders ───────────────────────────────────────────────────

function buildSystemPrompt(vocab: Vocabulary): string {
  return [
    'You are a music genre classification assistant for Curi, a NYC electronic music events app.',
    '',
    "For each artist, return a structured classification: canonical parent genres, specific subgenres, and artist-level musical-character vibes.",
    '',
    '# Task boundaries',
    '',
    "- **Genres** are broad parent buckets (house, techno, trance, hip-hop, jazz, etc).",
    "- **Subgenres** are the specific flavor (deep-house, hard-trance, deconstructed-club, etc).",
    "- **Vibes** are *artist-level* musical-character descriptors. Examples: melodic, hypnotic, dark, euphoric, driving, experimental, ambient, groovy, cinematic, industrial.",
    "- Do NOT return **event-level** vibes such as warehouse, peak-time, basement, daytime, queer, underground — those are properties of a show or venue, not an artist.",
    '',
    '# Existing vocabulary',
    '',
    'This list exists so you **recognize** and **spell consistently** when a term truly applies — it is NOT a menu to pick from. Only include a tag (existing or new) when it is directly supported by your training knowledge or by tool-result evidence for the specific artist in question. When a term does fit, spell it exactly as shown (the downstream pipeline uses exact matching). A near-duplicate with a typo creates a junk row; an unsupported pick from this list creates a wrong classification.',
    '',
    `Parent genres (${vocab.parentGenres.length}): ${vocab.parentGenres.join(', ') || '(none seeded yet)'}`,
    '',
    `Subgenres (${vocab.subgenres.length}): ${vocab.subgenres.join(', ') || '(none seeded yet)'}`,
    '',
    `Vibes (${vocab.vibes.length}): ${vocab.vibes.join(', ') || '(none seeded yet)'}`,
    '',
    '# Tools and escalation order',
    '',
    '1. **First: use your training knowledge.** For well-documented artists you already know, call `submit_enrichment` directly. Roughly 60% of queries land here.',
    '2. **If training is thin, call `search_web`** for recent bio/press/RA context. Roughly 25% of queries need this.',
    "3. **If web search is also thin AND the context is electronic-leaning** (venue defaults or existing tags imply electronic/DJ music), call `find_artist_profile` then `fetch_artist_self_tags`. This is for underground NYC producers whose genres aren't captured by traditional sources. Roughly 15% of queries.",
    '',
    'Do NOT call `fetch_artist_self_tags` on rock/jazz/folk/hip-hop acts — those have limited SoundCloud/Bandcamp presence and the call wastes credits.',
    '',
    "When you have a confident answer, call `submit_enrichment`. Always call it exactly once per artist — even if confidence is low, submit with `\"confidence\": \"low\"` and best-effort arrays rather than refusing.",
    '',
    '# Anti-patterns to avoid',
    '',
    'These are failure modes from prior runs — do not repeat them.',
    '',
    '- **Do not draw tags from the vocabulary list unless they are directly supported.** The vocabulary is for recognition, not selection. If "classic rock" is in the list but the artist is a Chicago house DJ, do NOT include "classic rock". Every tag you return must be grounded in specific evidence (training knowledge of this artist, or tool-result content).',
    '- **Do not pad arrays with generic placeholders** like "club", "electronic-dance", or "dance music" when a more specific subgenre applies. If the artist plays Jersey club, return "jersey-club"; if they play deep house, return "deep-house" under the "house" parent. Bare "club" and "electronic-dance" are almost always wrong on this platform.',
    '- **Do not conflate genres and subgenres.** A parent bucket like "house" belongs in `genres`, never in `subgenres`. A specific style like "deep-house" belongs in `subgenres`, never in `genres`.',
    '- **Confidence reflects precision, not coverage.** "high" means you are confident in the specific tags you chose. If you had to guess between two close subgenres, use "medium". If signal is thin, use "low" and submit a minimal best-effort array — do not pad with guesses to make the result look more complete. Fewer, more-accurate tags beat more, shakier ones.',
    '- **If Exa returns no profile candidates for an artist with a distinctive handle** (unusual spelling, numbers, underscores), you may call `fetch_artist_self_tags` directly with a guessed URL like `https://soundcloud.com/{slug}` — Firecrawl 404s on bad guesses are harmless, so this is worth trying once before giving up.',
    '',
    '# Output standards',
    '',
    '- Genre/subgenre/vibe strings: **lowercase-with-hyphens** for multi-word terms ("deep-house" not "Deep House"), matching the existing vocabulary shape.',
    '- Keep arrays concise: 1–3 genres, 1–4 subgenres, 1–3 vibes for most artists.',
    '- `sources`: URLs only, drawn from tool results. Empty array when classification is training-only.',
    '- `reasoning`: one sentence explaining the classification.',
  ].join('\n');
}

function buildUserMessage(name: string, context: EnrichmentContext): string {
  const lines: string[] = [
    'Classify the following artist:',
    '',
    `Artist name: ${name}`,
  ];

  if (
    context.venueDefaults &&
    (context.venueDefaults.genres.length || context.venueDefaults.vibes.length)
  ) {
    lines.push('');
    lines.push(
      'Venue default signals (useful for deciding whether the act is electronic-leaning):',
    );
    if (context.venueDefaults.genres.length) {
      lines.push(`  - default genres: ${context.venueDefaults.genres.join(', ')}`);
    }
    if (context.venueDefaults.vibes.length) {
      lines.push(`  - default vibes: ${context.venueDefaults.vibes.join(', ')}`);
    }
  }

  if (context.coBilledArtists && context.coBilledArtists.length) {
    lines.push('');
    lines.push(
      `Co-billed artists (context clues): ${context.coBilledArtists.join(', ')}`,
    );
  }

  if (context.existingMbTags && context.existingMbTags.length) {
    lines.push('');
    lines.push(
      `Existing MusicBrainz tag hints: ${context.existingMbTags.join(', ')}`,
    );
  }

  if (context.city) {
    lines.push('');
    lines.push(`City: ${context.city}`);
  }
  if (context.eventDate) {
    lines.push(`Event date: ${context.eventDate}`);
  }

  return lines.join('\n');
}

// ── Tool schemas ───────────────────────────────────────────────────────

const TOOLS: ToolDefinition[] = [
  {
    name: 'search_web',
    description:
      "Neural web search for an artist when your training knowledge is thin. Returns ~8 results with titles, URLs, and excerpted text. Use when you need bio/press/RA context you don't already have.",
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Search query. Include the artist name plus disambiguating context like "dj", "producer", "nyc", genre hints.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'find_artist_profile',
    description:
      "Search SoundCloud or Bandcamp for an artist's profile URL. Returns up to 3 candidate URLs with title + snippet so you can disambiguate common names — cross-check each candidate against the event context (bio/city/genre hints) before handing a URL to fetch_artist_self_tags. If no candidates come back for a distinctively-named underground artist, you may call fetch_artist_self_tags directly with a guessed URL (e.g. https://soundcloud.com/{slug}) — Firecrawl 404s on bad guesses are harmless.",
    input_schema: {
      type: 'object',
      properties: {
        artist_name: { type: 'string' },
        platform: { type: 'string', enum: ['soundcloud', 'bandcamp'] },
      },
      required: ['artist_name', 'platform'],
    },
  },
  {
    name: 'fetch_artist_self_tags',
    description:
      "Pull aggregated genre hashtags from the artist's profile page — profile-level genre field, bio, and deduplicated per-track hashtags ranked by frequency. Use after find_artist_profile for underground producers whose genres aren't captured by press.",
    input_schema: {
      type: 'object',
      properties: {
        profile_url: {
          type: 'string',
          description: 'SoundCloud or Bandcamp profile URL.',
        },
        limit: {
          type: 'number',
          description: 'Max recent tracks to sample. Default 10.',
        },
      },
      required: ['profile_url'],
    },
  },
  {
    name: 'submit_enrichment',
    description:
      'Submit the final classification. Call exactly once — even low-confidence submissions go through this tool. Do not return classification in free text.',
    input_schema: {
      type: 'object',
      properties: {
        genres: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Canonical parent genre slugs, lowercase-with-hyphens. Use existing vocabulary when applicable.',
        },
        subgenres: {
          type: 'array',
          items: { type: 'string' },
          description: 'Specific subgenre slugs, lowercase-with-hyphens.',
        },
        vibes: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Artist-level musical-character vibes (melodic, hypnotic, dark, etc). NOT event-level (warehouse, peak-time).',
        },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        sources: {
          type: 'array',
          items: { type: 'string' },
          description: 'URLs consulted (from tool results). Empty if training-only.',
        },
        reasoning: {
          type: 'string',
          description: 'One sentence explaining the classification.',
        },
      },
      required: [
        'genres',
        'subgenres',
        'vibes',
        'confidence',
        'sources',
        'reasoning',
      ],
    },
  },
];

// ── Orchestrator ────────────────────────────────────────────────────────

interface SubmittedEnrichment {
  genres: unknown;
  subgenres: unknown;
  vibes: unknown;
  confidence: unknown;
  sources: unknown;
  reasoning: unknown;
}

/**
 * Run the enrichment pipeline for one artist. Result has been post-
 * processed through the Phase 4a fuzzy matcher so near-duplicates
 * collapse into the existing vocabulary. Genuinely novel tags pass
 * through unchanged — the persistence layer (Phase 4e integration)
 * creates the new taxonomy_subgenres / vibe rows.
 */
export async function enrichArtistWithLLM(
  name: string,
  context: EnrichmentContext = {},
): Promise<EnrichmentResult> {
  const vocab = await loadVocabulary();

  let submitted: SubmittedEnrichment | null = null;
  const toolTrace: string[] = [];

  const executeToolCall = async (call: ToolInvocation): Promise<string> => {
    toolTrace.push(call.name);
    switch (call.name) {
      case 'search_web': {
        const query = String(call.input.query ?? '');
        const results = await searchExa(query, {
          numResults: 8,
          includeContents: true,
        });
        return formatSearchResults(results);
      }
      case 'find_artist_profile': {
        const artistName = String(call.input.artist_name ?? '');
        const platform = call.input.platform as 'soundcloud' | 'bandcamp';
        const results = await findProfileUrls(artistName, platform, 3);
        if (results.length === 0) {
          return 'no candidates found on this platform';
        }
        return results
          .map((r, i) => {
            const lines = [
              `[${i + 1}] ${r.url}`,
              `    title: ${r.title ?? '(none)'}`,
            ];
            if (r.snippet) {
              lines.push(`    snippet: ${r.snippet.slice(0, 200)}`);
            }
            return lines.join('\n');
          })
          .join('\n\n');
      }
      case 'fetch_artist_self_tags': {
        const profileUrl = String(call.input.profile_url ?? '');
        const limit =
          typeof call.input.limit === 'number' ? call.input.limit : 10;
        const result = await fetchArtistSelfTags(profileUrl, limit);
        return [
          `profile_genre: ${result.profileGenre ?? '(none)'}`,
          `bio: ${result.bio ?? '(none)'}`,
          `top_tags (most frequent first): ${
            result.tags.slice(0, 20).join(', ') || '(none)'
          }`,
          `source: ${result.sourceUrl}`,
        ].join('\n');
      }
      case 'submit_enrichment': {
        submitted = call.input as unknown as SubmittedEnrichment;
        return 'submitted';
      }
      default:
        throw new Error(`unknown tool: ${call.name}`);
    }
  };

  const { stopReason } = await runToolLoop({
    system: buildSystemPrompt(vocab),
    userMessage: buildUserMessage(name, context),
    tools: TOOLS,
    executeToolCall,
  });

  if (!submitted) {
    throw new Error(
      `enrichArtistWithLLM: Sonnet stopped (${
        stopReason ?? 'unknown'
      }) without calling submit_enrichment for "${name}"`,
    );
  }

  const fuzzyMerges: EnrichmentResult['fuzzyMerges'] = [];
  const s: SubmittedEnrichment = submitted;

  return {
    genres: dedupeClean(s.genres),
    subgenres: mergeFuzzy(s.subgenres, vocab.subgenres, fuzzyMerges),
    vibes: mergeFuzzy(s.vibes, vocab.vibes, fuzzyMerges),
    confidence: normalizeConfidence(s.confidence),
    sources: Array.isArray(s.sources)
      ? (s.sources as unknown[]).filter((x): x is string => typeof x === 'string')
      : [],
    reasoning: typeof s.reasoning === 'string' ? s.reasoning : '',
    toolTrace,
    fuzzyMerges,
  };
}

// ── Post-processing helpers ────────────────────────────────────────────────

function dedupeClean(arr: unknown): string[] {
  if (!Array.isArray(arr)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of arr) {
    if (typeof x !== 'string') continue;
    const clean = x.trim().toLowerCase();
    if (!clean.length || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

function normalizeConfidence(c: unknown): 'high' | 'medium' | 'low' {
  if (c === 'high' || c === 'medium' || c === 'low') return c;
  return 'low';
}

/**
 * Collapse model-proposed tags into the existing vocabulary via the
 * Phase 4a fuzzy matcher. Order: tier-1 canonical exact → tier-2
 * Levenshtein near-match → tier-3 passthrough. Tier-2 merges are
 * recorded on the result so a human can audit them post-backfill.
 */
function mergeFuzzy(
  proposed: unknown,
  existing: string[],
  merges: EnrichmentResult['fuzzyMerges'],
): string[] {
  const cleanProposed = dedupeClean(proposed);
  const byCanonical = new Map<string, string>();
  for (const e of existing) {
    byCanonical.set(normalizeForTaxonomy(e), e);
  }

  const out: string[] = [];
  const seen = new Set<string>();

  for (const tag of cleanProposed) {
    // Tier 1: canonical exact (handles peaktime/peak-time collapse).
    const canon = normalizeForTaxonomy(tag);
    const exact = byCanonical.get(canon);
    if (exact) {
      if (!seen.has(exact)) {
        seen.add(exact);
        out.push(exact);
      }
      continue;
    }

    // Tier 2: Levenshtein near-match (dist ≤ 2, shared len ≥ 6).
    const near = findNearMatch(tag, existing);
    if (near) {
      merges.push({
        proposed: tag,
        merged: near.match,
        distance: near.distance,
      });
      if (!seen.has(near.match)) {
        seen.add(near.match);
        out.push(near.match);
      }
      continue;
    }

    // Tier 3: genuinely novel — passthrough.
    if (!seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
  }

  return out;
}

function formatSearchResults(results: ExaResult[]): string {
  if (results.length === 0) return 'no results';
  return results
    .map((r, i) => {
      const lines = [
        `[${i + 1}] ${r.title ?? '(untitled)'}`,
        `    ${r.url}`,
      ];
      if (r.publishedDate) lines.push(`    published: ${r.publishedDate}`);
      if (r.snippet) lines.push(`    snippet: ${r.snippet.slice(0, 200)}`);
      if (r.text) lines.push(`    excerpt: ${r.text.slice(0, 600)}`);
      return lines.join('\n');
    })
    .join('\n\n');
}
