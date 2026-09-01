/**
 * Serialize catalog hydration and collapse duplicate work for one revision.
 * Failed applications deliberately do not advance `appliedRevision`, so a
 * caller can retry the same document after a transient failure or a 304.
 */
export interface RevisionHydrationQueue<T> {
  readonly appliedRevision: string | null;
  enqueue(value: T, force?: boolean): Promise<void>;
}

export function createRevisionHydrationQueue<T>(
  revisionOf: (value: T) => string,
  apply: (value: T) => Promise<void>,
): RevisionHydrationQueue<T> {
  let tail: Promise<void> = Promise.resolve();
  let appliedRevision: string | null = null;

  const enqueue = (value: T, force = false): Promise<void> => {
    const revision = revisionOf(value);
    const run = tail
      .catch(() => undefined)
      .then(async () => {
        if (!force && appliedRevision === revision) return;
        await apply(value);
        appliedRevision = revision;
      });
    // Keep the queue usable after a failed task while returning the original
    // rejection to the caller that requested it.
    tail = run.catch(() => undefined);
    return run;
  };

  return {
    get appliedRevision() { return appliedRevision; },
    enqueue,
  };
}
