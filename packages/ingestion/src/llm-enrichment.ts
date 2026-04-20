// LLM-driven artist enrichment (Phase 4c + 4f).
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
// Phase 4f additions:
//   - Prompt caching (system + tools) via runToolLoop.enablePromptCache.
//   - Stall fallback: when the 6-iteration cap is hit without a submit,
//     we force submit_enrichment via tool_choice and flag the result
//     with stalled=true rather than throwing. Stalled submissions emit
//     confidence='very-low' regardless of what the model claimed — so
//     the DB can distinguish a genuine low-confidence call from a
//     burned iter cap.
//   - Popularity fold-in: if the model calls fetch_artist_self_tags,
//     we capture follower count + canonical URL as a side effect so
//     the orchestrator doesn't need a dedicated second Firecrawl call.
//   - Spotify fact injection: when the caller has a Spotify match for
//     the artist, the genre strings land in the user message as prior
//     evidence. The model uses them to anchor taxonomy mapping rather
//     than guessing blind on MB-matched artists — directly addresses
//     the 42% empty-arrays failure mode from the 4e dry run.
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
import type { PopularityResult } from './popularity-discovery.js';

// ── Public types ────────────────────────────────────────────────────

export interface EnrichmentContext {
  /** Venue default_genres/default_vibes if available. */
  venueDefaults?: { genres: string[]; vibes: string[] };
  /** Names of artists on the same bill. */
  coBilledArtists?: string[];
  /** Any existing MusicBrainz tag hints from prior enrichment. */
  existingMbTags?: string[];
  /** Spotify genre strings when the orchestrator already resolved a
   *  confirmed Spotify match for this artist (confidence high/medium).
   *  Injected into the user prompt as prior evidence so the model can
   *  anchor its taxonomy mapping rather than guessing blind. These are
   *  NOT auto-persisted — they're just context. */
  spotifyGenres?: string[];
  /** Event city (default NYC). This is where the *show* is, not where
   *  the artist lives — Curi is NYC-only so this is effectively constant. */
  eventCity?: string;
  /** Event date (ISO string). */
  eventDate?: string;
}

/**
 * Confidence tier emitted by the enrichment pipeline.
 *
 *   high     — model is confident in the specific tags it chose
 *   medium   — model picked between close alternatives, best guess
 *   low      — signal was thin, submitted a minimal best-effort array
 *   very-low — stall fallback fired (iter cap burned without submit).
 *              Reserved for this case — the model itself never emits
 *              'very-low' through the tool.
 */
export type EnrichmentConfidence = 'high' | 'medium' | 'low' | 'very-low';

export interface EnrichmentResult {
  genres: string[];
  subgenres: string[];
  vibes: string[];
  confidence: EnrichmentConfidence;
  sources: string[];
  reasoning: string;
  /** Which tools the model invoked, in order (debug signal). */
  toolTrace: string[];
  /** Tags silently merged via tier-2 fuzzy match (for post-run review). */
  fuzzyMerges: Array<{ proposed: string; merged: string; distance: number }>;
  /** True when the iter-cap stall fallback fired. When true, confidence
   *  is forced to 'very-low' regardless of what the model claimed. */
  stalled: boolean;
  /** Popularity captured opportunistically from fetch_artist_self_tags
   *  calls. Null when the model never escalated to Firecrawl — in that
   *  case the orchestrator does a dedicated discoverPopularity pass. */
  popularity: PopularityResult | null;
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
 * enrichment call — and the system prompt is marked cacheable, so
 * any change to vocab busts the Anthropic ephemeral cache too. Cache
 * invalidates on process restart.
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
    '# External grounding signals',
    '',
    'The user message may include **prior evidence** from external sources: MusicBrainz tag hints, Spotify genres, venue defaults, co-billed artists. These are strong priors — they confirm the artist is a real, classifiable act with an identifiable sound. Use them as your **anchor** for taxonomic mapping:',
    '',
    '- If MusicBrainz tags say "techno, minimal", that is direct evidence the artist is a techno act — map those tags to our vocabulary and submit, don\'t guess blind.',
    '- If Spotify genres say "deep house, nu disco, disco house", translate those into our taxonomy (parent "house", subgenres "deep-house", "nu-disco", "disco-house" if novel). Spotify\'s genre strings generally map 1:1 or close — trust them more than you\'d trust a web search excerpt.',
    '- If venue defaults say "techno, bass music" and the co-billed artists are known techno producers, the act in front of you is almost certainly in that orbit.',
    '',
    'When these signals are present, **empty arrays are almost always wrong**. A grounded artist with external tags deserves at least a best-effort classification with the tags you do have — submit confidence="low" with what the external signals imply, not empty arrays.',
    '',
    '# Tools and escalation order',
    '',
    '1. **First: use your training knowledge + any external signals in the user message.** For well-documented artists or artists with strong external grounding (MB tags, Spotify genres), call `submit_enrichment` directly. Roughly 60–70% of queries should land here — especially ones with Spotify genres attached.',
    '2. **If training is thin and external signals are ambiguous, call `search_web`** for recent bio/press/RA context. Roughly 20% of queries need this.',
    "3. **If web search is also thin AND the context is electronic-leaning** (venue defaults or existing tags imply electronic/DJ music), call `find_artist_profile` then `fetch_artist_self_tags`. This is for underground NYC producers whose genres aren't captured by traditional sources. Roughly 10–15% of queries.",
    '',
    '    **Platform choice:** Default to `platform: "soundcloud"` — that is where DJs and club-oriented producers live, which covers most of Curi\'s catalog. Try `platform: "bandcamp"` only when SoundCloud returns no useful candidates AND the context looks album/label/experimental-oriented (experimental, ambient, noise, non-dance electronic, label roster signals, Pan/Hyperdub/Posh Isolation-adjacent acts). Do not call both platforms by default — the latency compounds on underground artists who are already slow to resolve.',
    '',
    'Do NOT call `fetch_artist_self_tags` on rock/jazz/folk/hip-hop acts — those have limited SoundCloud/Bandcamp presence and the call wastes credits.',
    '',
    "When you have a confident answer, call `submit_enrichment`. Always call it exactly once per artist — even if confidence is low, submit with `\"confidence\": \"low\"` and best-effort arrays rather than refusing.",
    '',
    '# Anti-patterns to avoid',
    '',
    'These are failure modes from prior runs — do not repeat them.',
    '',
    '- **Do not return empty arrays when external grounding exists.** If the user message includes MusicBrainz tags, Spotify genres, or venue defaults pointing toward a known music style, those are strong priors that the artist has a classifiable sound. Use those tags to anchor your mapping rather than submitting empty arrays with low confidence. An empty output on a grounded artist is a failure — prefer a low-confidence best-effort submission that translates the external tags into our vocabulary.',
    '- **Do not draw tags from the vocabulary list unless they are directly supported.** The vocabulary is for recognition, not selection. If "classic rock" is in the list but the artist is a Chicago house DJ, do NOT include "classic rock". Every tag you return must be grounded in specific evidence (training knowledge of this artist, external signals in the user message, or tool-result content).',
    '- **Do not pad arrays with generic placeholders** like "club", "electronic-dance", or "dance music" when a more specific subgenre applies. If the artist plays Jersey club, return "jersey-club"; if they play deep house, return "deep-house" under the "house" parent. Bare "club" and "electronic-dance" are almost always wrong on this platform.',
    '- **Do not conflate genres and subgenres.** A parent bucket like "house" belongs in `genres`, never in `subgenres`. A specific style like "deep-house" belongs in `subgenres`, never in `genres`.',
    '- **Confidence reflects precision, not coverage.** "high" means you are confident in the specific tags you chose. If you had to guess between two close subgenres, use "medium". If signal is thin, use "low" and submit a minimal best-effort array — do not pad with guesses to make the result look more complete. Fewer, more-accurate tags beat more, shakier ones.',
    '- **If Exa returns no profile candidates for an artist with a distinctive handle** (unusual spelling, numbers, underscores), you may call `fetch_artist_self_tags` directly with a guessed URL — Firecrawl 404s on bad guesses are harmless, so this is worth trying once before giving up. SoundCloud URL pattern: `https://soundcloud.com/{slug}`. Bandcamp URL pattern: `https://{slug}.bandcamp.com` (subdomain, not a path segment).',
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

  // Spotify genres go near the top — highest-quality grounding signal
  // when present, and we want the model to see it before it starts
  // reading venue defaults and co-bills.
  if (context.spotifyGenres && context.spotifyGenres.length) {
    lines.push('');
    lines.push(
      `Spotify genres (confirmed Spotify match for this artist — strong grounding signal): ${context.spotifyGenres.join(', ')}`,
    );
  }

  if (context.existingMbTags && context.existingMbTags.length) {
    lines.push('');
    lines.push(
      `Existing MusicBrainz tag hints (from prior enrichment — strong grounding signal): ${context.existingMbTags.join(', ')}`,
    );
  }

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

  if (context.eventCity) {
    lines.push('');
    lines.push(
      `Event city: ${context.eventCity} (where the show is — not necessarily where the artist lives)`,
    );
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
      "Search SoundCloud or Bandcamp for an artist's profile URL. Returns up to 3 candidate URLs with title + snippet so you can disambiguate common names — cross-check each candidate against the event context (bio/city/genre hints) before handing a URL to fetch_artist_self_tags. Default to platform='soundcloud'; use platform='bandcamp' as a secondary escalation for album/label/experimental-oriented artists when SoundCloud comes up empty. If no candidates come back for a distinctively-named artist, you may call fetch_artist_self_tags directly with a guessed URL — Firecrawl 404s are harmless. Pattern: https://soundcloud.com/{slug} or https://{slug}.bandcamp.com.",
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
 * through unchanged — the persistence layer creates the new
 * taxonomy_subgenres / vibe rows.
 *
 * Phase 4f: fold popularity capture into the result when the model
 * called fetch_artist_self_tags, and use the runToolLoop stall
 * fallback so burning the iter cap flags the result as 'very-low'
 * instead of crashing the whole run.
 */
export async function enrichArtistWithLLM(
  name: string,
  context: EnrichmentContext = {},
): Promise<EnrichmentResult> {
  const vocab = await loadVocabulary();

  let submitted: SubmittedEnrichment | null = null;
  const toolTrace: string[] = [];
  let popularity: PopularityResult | null = null;

  const recordPopularity = (url: string, followers: number | null, canonical: string | null): void => {
    const resolvedUrl = canonical ?? url;
    if (!popularity) {
      popularity = { attempted: true, sources: [] };
    }
    popularity.sources.push(resolvedUrl);
    if (/soundcloud\.com/i.test(resolvedUrl)) {
      popularity.soundcloudUrl = resolvedUrl;
      if (followers !== null && followers !== undefined) {
        popularity.soundcloudFollowers = followers;
      }
    } else if (/bandcamp\.com/i.test(resolvedUrl)) {
      popularity.bandcampUrl = resolvedUrl;
      if (followers !== null && followers !== undefined) {
        popularity.bandcampFollowers = followers;
      }
    }
  };

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
        // Capture popularity as a side effect — tier-3 artists get
        // their SC/BC URL + follower count "for free" from this call.
        recordPopularity(profileUrl, result.followers, result.canonicalUrl);
        return [
          `profile_genre: ${result.profileGenre ?? '(none)'}`,
          `bio: ${result.bio ?? '(none)'}`,
          `top_tags (most frequent first): ${
            result.tags.slice(0, 20).join(', ') || '(none)'
          }`,
          `followers: ${result.followers ?? '(not visible)'}`,
          `source: ${result.canonicalUrl ?? result.sourceUrl}`,
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

  const { stopReason, stalled } = await runToolLoop({
    system: buildSystemPrompt(vocab),
    userMessage: buildUserMessage(name, context),
    tools: TOOLS,
    executeToolCall,
    // System prompt embeds the full vocabulary (~2k subgenres worth of
    // tokens) and the tool definitions are ~1k tokens — both are
    // stable across every artist in a run, so cache hits save ~90% on
    // input tokens after the first call.
    enablePromptCache: true,
    // On iter-cap exhaustion, force submit rather than throwing. The
    // orchestrator inspects the stalled flag and treats results as
    // 'very-low' confidence regardless of what the model claimed.
    stallFallbackTool: 'submit_enrichment',
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
    // If stalled, force confidence to 'very-low' regardless of what
    // the model claimed — stalled submissions ran out of iterations
    // and couldn't complete their intended discovery path. 'very-low'
    // is distinct from 'low' so the DB can separate "genuinely thin
    // signal" from "burned iter cap without finishing".
    confidence: stalled ? 'very-low' : normalizeConfidence(s.confidence),
    sources: Array.isArray(s.sources)
      ? (s.sources as unknown[]).filter((x): x is string => typeof x === 'string')
      : [],
    reasoning: typeof s.reasoning === 'string' ? s.reasoning : '',
    toolTrace,
    fuzzyMerges,
    stalled,
    popularity,
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

function normalizeConfidence(c: unknown): EnrichmentConfidence {
  if (c === 'high' || c === 'medium' || c === 'low' || c === 'very-low') {
    return c;
  }
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
