/** The durable activity window is intentionally small and date-keyed. */
export const MAX_DAILY_PROGRESS_ENTRIES = 366;
export const MAX_DAILY_ACTIVITY_ENTRIES = MAX_DAILY_PROGRESS_ENTRIES;
export const MAX_DAILY_PROGRESS_COUNT = 0xffffffff;

export interface DailyProgressAggregate {
  readonly date: string;
  readonly marked: number;
  readonly unmarked: number;
}

export interface ProgressActivity {
  readonly daily: readonly DailyProgressAggregate[];
}

export const EMPTY_PROGRESS_ACTIVITY: ProgressActivity = { daily: [] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isDateKey(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= MAX_DAILY_PROGRESS_COUNT;
}

function checkedAggregate(value: unknown): DailyProgressAggregate {
  if (!isRecord(value) || !isDateKey(value.date) || !isCount(value.marked) || !isCount(value.unmarked)) throw new TypeError('Daily progress activity is malformed.');
  if (value.marked + value.unmarked > MAX_DAILY_PROGRESS_COUNT) throw new TypeError('Daily progress activity exceeds the per-day limit.');
  return { date: value.date, marked: value.marked, unmarked: value.unmarked };
}

/** Normalize a durable activity payload without retaining caller-owned data. */
export function normalizeProgressActivity(value: unknown): ProgressActivity {
  if (value === undefined || value === null) return { daily: [] };
  if (!isRecord(value) || !Array.isArray(value.daily) || value.daily.length > MAX_DAILY_PROGRESS_ENTRIES) throw new TypeError('Daily progress activity is malformed.');
  const daily = value.daily.map(checkedAggregate).sort((left, right) => left.date.localeCompare(right.date));
  for (let index = 1; index < daily.length; index += 1) {
    if (daily[index - 1].date === daily[index].date) throw new TypeError(`Daily progress date ${daily[index].date} is duplicated.`);
  }
  return { daily };
}

export function cloneProgressActivity(value: ProgressActivity | undefined): ProgressActivity {
  const normalized = normalizeProgressActivity(value);
  return { daily: normalized.daily.map((entry) => ({ ...entry })) };
}

function dateKey(value: Date | number | string): string {
  if (typeof value === 'string') {
    if (!isDateKey(value)) throw new TypeError('Progress activity date is invalid.');
    return value;
  }
  const date = new Date(typeof value === 'number' ? value : value.valueOf());
  if (Number.isNaN(date.valueOf())) throw new TypeError('Progress activity date is invalid.');
  return date.toISOString().slice(0, 10);
}

function checkedDelta(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative integer.`);
  return value;
}

/**
 * Add one already-observed activity delta.  There is one row per date, so
 * re-saving the returned activity is idempotent rather than append-only.
 * Older rows are discarded once the bounded retention window is exceeded.
 */
export function recordDailyProgress(
  activity: ProgressActivity | undefined,
  date: Date | number | string,
  marked: number,
  unmarked: number
): ProgressActivity {
  const nextMarked = checkedDelta(marked, 'Marked progress');
  const nextUnmarked = checkedDelta(unmarked, 'Unmarked progress');
  const key = dateKey(date);
  const current = normalizeProgressActivity(activity);
  const existing = current.daily.find((entry) => entry.date === key);
  const aggregateMarked = (existing?.marked ?? 0) + nextMarked;
  const aggregateUnmarked = (existing?.unmarked ?? 0) + nextUnmarked;
  if (aggregateMarked + aggregateUnmarked > MAX_DAILY_PROGRESS_COUNT) throw new TypeError('Daily progress activity exceeds the per-day limit.');
  const withoutDate = current.daily.filter((entry) => entry.date !== key);
  withoutDate.push({ date: key, marked: aggregateMarked, unmarked: aggregateUnmarked });
  withoutDate.sort((left, right) => left.date.localeCompare(right.date));
  return { daily: withoutDate.slice(-MAX_DAILY_PROGRESS_ENTRIES) };
}

/** Replace one date's aggregate; useful when replaying a durable event. */
export function setDailyProgress(
  activity: ProgressActivity | undefined,
  date: Date | number | string,
  marked: number,
  unmarked: number
): ProgressActivity {
  const key = dateKey(date);
  const nextMarked = checkedDelta(marked, 'Marked progress');
  const nextUnmarked = checkedDelta(unmarked, 'Unmarked progress');
  if (nextMarked + nextUnmarked > MAX_DAILY_PROGRESS_COUNT) throw new TypeError('Daily progress activity exceeds the per-day limit.');
  const current = normalizeProgressActivity(activity);
  const daily = current.daily.filter((entry) => entry.date !== key);
  daily.push({ date: key, marked: nextMarked, unmarked: nextUnmarked });
  daily.sort((left, right) => left.date.localeCompare(right.date));
  return { daily: daily.slice(-MAX_DAILY_PROGRESS_ENTRIES) };
}

export const addDailyProgress = recordDailyProgress;
export const upsertDailyProgress = setDailyProgress;
export const normalizeDailyProgress = normalizeProgressActivity;
