export function findMap<T, K extends keyof T>(
  items: T[],
  key: K,
): NonNullable<T[K]> | undefined;
export function findMap<T, U>(items: T[], fn: MapFn<T, U>): U | undefined;
export function findMap<T>(items: T[], fnOrKey: Accessor<T>) {
  for (const item of items) {
    const value = resolve(item, fnOrKey);
    if (value != null) {
      return value;
    }
  }
  return undefined;
}

export function filterMap<T, K extends keyof T>(
  items: T[],
  key: K,
): NonNullable<T[K]>[];
export function filterMap<T, U>(items: T[], fn: MapFn<T, U>): U[];
export function filterMap<T>(items: T[], fnOrKey: Accessor<T>) {
  const result: unknown[] = [];
  for (const item of items) {
    const value = resolve(item, fnOrKey);
    if (value != null) {
      result.push(value);
    }
  }
  return result;
}

export function groupBy<T extends object, K>(
  items: (T | null | undefined)[],
  keyFn: (item: T) => K,
): Map<K, T[]> {
  const result = new Map<K, T[]>();
  for (const item of items) {
    if (!item) {
      continue;
    }
    const key = keyFn(item);
    const list = result.get(key);
    if (list) {
      list.push(item);
    } else {
      result.set(key, [item]);
    }
  }
  return result;
}

export function firstNonEmpty<T>(list: (T[] | undefined)[]): T[] {
  return list.find((a): a is T[] => a !== undefined && a.length > 0) ?? [];
}

function resolve<T>(item: T, fnOrKey: Accessor<T>) {
  return typeof fnOrKey === "function" ? fnOrKey(item) : item[fnOrKey];
}

type MapFn<T, U> = (item: T) => U | undefined | null;

type Accessor<T> = MapFn<T, unknown> | keyof T;
