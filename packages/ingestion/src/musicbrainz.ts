// Phase-2 stub — MusicBrainz enrichment with strict 1 req/sec token bucket.
// Full implementation lands in Phase 2.
//
// Required header: User-Agent: Curi/0.1 (cmitsuo7@yahoo.com)
// Endpoint: https://musicbrainz.org/ws/2/artist?query={name}&fmt=json

export async function enrichArtist(_artistName: string): Promise<void> {
  throw new Error('musicbrainz.enrichArtist not implemented — Phase 2');
}
