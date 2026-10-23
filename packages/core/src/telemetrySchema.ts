export const TELEMETRY_SCHEMA = 1;
export const TELEMETRY_MAX_PAYLOAD_BYTES = 8 * 1024;

const MAX_MAP_ENTRIES = 64;
const MAX_COUNT = 1e9;
const KEY_PATTERN = /^[\w.:/@-]{1,80}$/;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const PAYLOAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VERSION_FORMAT = /^\d{1,4}\.\d{1,4}\.\d{1,4}(-[\w.]{1,30})?$/;

type Shape = (value: unknown) => boolean;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const isCount: Shape = (value) => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= MAX_COUNT;

const isAverage: Shape = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_COUNT;

const matches =(pattern: RegExp): Shape => (value) => typeof value === "string" && pattern.test(value);

const countMap: Shape = (value) =>
  isObject(value) && Object.keys(value).length <= MAX_MAP_ENTRIES && Object.entries(value).every(([key, count]) => KEY_PATTERN.test(key) && isCount(count));

const objectOf =
  (shape: Record<string, Shape>): Shape =>
  (value) =>
    isObject(value) && Object.keys(value).every((key) => Object.hasOwn(shape, key)) && Object.entries(shape).every(([key, check]) => check(value[key]));

const DAILY_PAYLOAD_SHAPE: Record<string, Shape> = {
  schema: (value) => value === TELEMETRY_SCHEMA,
  payloadId: matches(PAYLOAD_ID_PATTERN),
  day: matches(DAY_PATTERN),
  app: objectOf({ version: matches(VERSION_FORMAT), os: matches(KEY_PATTERN), nodeMajor: isCount }),
  retention: objectOf({ installAgeDays: isCount, daysActiveLast7: isCount, daysActiveLast28: isCount }),
  boards: objectOf({ total: isCount, created: isCount, active: isCount }),
  nodesCreated: countMap,
  runs: objectOf({
    started: isCount,
    done: isCount,
    error: isCount,
    interrupted: isCount,
    stopped: isCount,
    regenerations: isCount,
    byRuntime: countMap,
    byContextMode: countMap,
    failuresByRecovery: countMap,
  }),
  branching: objectOf({ maxDepth: isCount, maxChildren: isCount, avgChildren: isAverage }),
  undo: isCount,
};

const isShape = objectOf(DAILY_PAYLOAD_SHAPE);

export const isDailyPayload = (value: unknown): boolean => isShape(value) && JSON.stringify(value).length <= TELEMETRY_MAX_PAYLOAD_BYTES;
