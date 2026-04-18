// Phase-2 stub. Takes a RawEvent and upserts into `events`, keyed on (source, source_id).
// Full implementation lands in Phase 2 after Checkpoint 1 confirms the schema.
import type { RawEvent } from './types.js';

export async function upsertEvent(_event: RawEvent): Promise<void> {
  throw new Error('normalizer.upsertEvent not implemented — Phase 2');
}
