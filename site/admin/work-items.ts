export interface WorkAttempt<T> {
  key: string;
  createdAt?: string;
  value: T;
}

export interface WorkItem<T, U> {
  key: string;
  task?: T;
  request?: U;
  taskAttempts: number;
  mocAttempts: number;
}

function isNewer(left?: string, right?: string): boolean {
  return (left ?? "").localeCompare(right ?? "") > 0;
}

export function aggregateWorkAttempts<T, U>(tasks: WorkAttempt<T>[], requests: WorkAttempt<U>[]): WorkItem<T, U>[] {
  const groups = new Map<string, WorkItem<T, U>>();
  const latestTaskAt = new Map<string, string | undefined>();
  const latestMocAt = new Map<string, string | undefined>();
  for (const attempt of tasks) {
    const group = groups.get(attempt.key) ?? { key: attempt.key, taskAttempts: 0, mocAttempts: 0 };
    group.taskAttempts += 1;
    if (!group.task || isNewer(attempt.createdAt, latestTaskAt.get(attempt.key))) {
      group.task = attempt.value;
      latestTaskAt.set(attempt.key, attempt.createdAt);
    }
    groups.set(attempt.key, group);
  }
  for (const attempt of requests) {
    const group = groups.get(attempt.key) ?? { key: attempt.key, taskAttempts: 0, mocAttempts: 0 };
    group.mocAttempts += 1;
    if (!group.request || isNewer(attempt.createdAt, latestMocAt.get(attempt.key))) {
      group.request = attempt.value;
      latestMocAt.set(attempt.key, attempt.createdAt);
    }
    groups.set(attempt.key, group);
  }
  return [...groups.values()].sort((left, right) => {
    const leftDate = (left.task as { createdAt?: string } | undefined)?.createdAt ?? (left.request as { createdAt?: string } | undefined)?.createdAt ?? "";
    const rightDate = (right.task as { createdAt?: string } | undefined)?.createdAt ?? (right.request as { createdAt?: string } | undefined)?.createdAt ?? "";
    return rightDate.localeCompare(leftDate) || left.key.localeCompare(right.key);
  });
}
