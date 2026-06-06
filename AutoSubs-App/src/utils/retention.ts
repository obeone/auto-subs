// src/utils/retention.ts
//
// Pure transcript-retention logic, intentionally free of any Tauri / filesystem
// imports so it can be unit-tested in a plain Node (vitest) environment and
// reused by the storage layer in `file-utils.ts`.

export interface RetentionPolicy {
  /** Maximum number of transcripts to keep. `null` = unlimited, `0` = keep none. */
  maxCount: number | null;
  /** Maximum age, in minutes, to keep. `null` = unlimited, `0` = keep none. */
  maxAgeMinutes: number | null;
}

/** Minimal shape needed to decide whether a transcript should be pruned. */
export interface RetentionCandidate {
  filename: string;
  createdAt: Date | string | number;
}

function toEpochMs(value: Date | string | number): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return new Date(value).getTime();
}

/**
 * Decide which transcripts to delete for a given retention policy.
 *
 * Semantics (matches the settings UI: "0 items to infinity, 0 min to infinity"):
 *   - `null`  → unlimited; that limit is not applied.
 *   - `0`     → keep nothing; everything is selected for deletion.
 *   - `> 0`   → the maximum number / age to retain.
 *
 * When both limits are set, a transcript is pruned if EITHER limit would remove
 * it (the most aggressive limit wins). Returns the filenames to delete; the
 * input array is not mutated and ordering of the result is not significant.
 *
 * @param docs  Candidate transcripts (any order).
 * @param policy Retention limits.
 * @param now   Reference time in epoch milliseconds (defaults to `Date.now()`).
 */
export function selectTranscriptsToPrune(
  docs: RetentionCandidate[],
  policy: RetentionPolicy,
  now: number = Date.now(),
): string[] {
  const toDelete = new Set<string>();

  // Age limit: delete a transcript once its age reaches the limit, i.e. when it
  // was created at or before the cutoff (delete when age >= maxAgeMinutes). With
  // maxAgeMinutes === 0 the cutoff equals `now`, so everything already created
  // is deleted → "keep nothing".
  if (policy.maxAgeMinutes != null) {
    const cutoff = now - policy.maxAgeMinutes * 60_000;
    for (const doc of docs) {
      const created = toEpochMs(doc.createdAt);
      if (!Number.isNaN(created) && created <= cutoff) {
        toDelete.add(doc.filename);
      }
    }
  }

  // Count limit: keep only the newest `maxCount` transcripts, delete the rest.
  // maxCount === 0 → slice(0) → everything selected.
  if (policy.maxCount != null) {
    const newestFirst = [...docs].sort(
      (a, b) => toEpochMs(b.createdAt) - toEpochMs(a.createdAt),
    );
    for (const doc of newestFirst.slice(Math.max(0, policy.maxCount))) {
      toDelete.add(doc.filename);
    }
  }

  return [...toDelete];
}

/** True when the policy imposes no limits and pruning can be skipped entirely. */
export function isUnlimitedRetention(policy: RetentionPolicy): boolean {
  return policy.maxCount == null && policy.maxAgeMinutes == null;
}
