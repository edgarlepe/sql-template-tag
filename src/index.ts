/**
 * Unwraps the value type from an {@link Sql} instance, otherwise returns the
 * type itself.
 */
type UnwrapSql<T> = T extends Sql<infer U> ? U : T;

/**
 * Unwraps the value types from an array of {@link Sql} instances, otherwise
 * returns the types themselves.
 */
type UnwrapSqlArray<T extends ReadonlyArray<unknown>> = {
  [K in keyof T]: UnwrapSql<T[K]>;
};

/**
 * Flattens a nested array type into a single-level array type.
 */
type Flatten<T extends ReadonlyArray<unknown>> = T extends [
  infer First,
  ...infer Rest,
]
  ? First extends ReadonlyArray<unknown>
    ? [...First, ...Flatten<Rest>]
    : [First, ...Flatten<Rest>]
  : [];

/**
 * Computes the flattened {@link Value} tuple produced from a tuple of raw
 * template arguments (which may themselves be {@link Sql} instances).
 */
type FlattenValues<T extends ReadonlyArray<RawValue>> = Flatten<
  UnwrapSqlArray<T>
>;

/**
 * Augment this interface from a consumer module to narrow {@link Value}:
 *
 * ```ts
 * declare module "sql-template-tag" {
 *   interface Register {
 *     value: string | number | boolean | Date | null;
 *   }
 * }
 * ```
 *
 * Without augmentation, {@link Value} falls back to `unknown`.
 */
export interface Register {}

/**
 * Values supported by SQL engine. Defaults to `unknown`; narrow by augmenting
 * the {@link Register} interface.
 */
export type Value = Register extends { value: infer V } ? V : unknown;

/**
 * Supported value or SQL instance.
 */
export type RawValue = Value | Sql;

/**
 * A SQL instance can be nested within each other to build SQL strings.
 *
 * The `Values` type parameter is the flattened tuple of bound values produced
 * by the template, i.e., the type of the `values` property after any nested
 * {@link Sql} instances have been inlined.
 */
export class Sql<Values extends ReadonlyArray<Value> = readonly any[]> {
  readonly values: Values;
  readonly strings: string[];

  constructor(rawStrings: readonly string[], rawValues: readonly RawValue[]) {
    if (rawStrings.length - 1 !== rawValues.length) {
      if (rawStrings.length === 0) {
        throw new TypeError("Expected at least 1 string");
      }

      throw new TypeError(
        `Expected ${rawStrings.length} strings to have ${
          rawStrings.length - 1
        } values`,
      );
    }

    const valuesLength = rawValues.reduce<number>(
      (len, value) => len + (value instanceof Sql ? value.values.length : 1),
      0,
    );

    const values = new Array<Value>(valuesLength);
    this.strings = new Array(valuesLength + 1);

    this.strings[0] = rawStrings[0];

    // Iterate over raw values, strings, and children. The value is always
    // positioned between two strings, e.g. `index + 1`.
    let i = 0,
      pos = 0;
    while (i < rawValues.length) {
      const child = rawValues[i++];
      const rawString = rawStrings[i];

      // Check for nested `sql` queries.
      if (child instanceof Sql) {
        // Append child prefix text to current string.
        this.strings[pos] += child.strings[0];

        let childIndex = 0;
        while (childIndex < child.values.length) {
          values[pos++] = child.values[childIndex++];
          this.strings[pos] = child.strings[childIndex];
        }

        // Append raw string to current string.
        this.strings[pos] += rawString;
      } else {
        values[pos++] = child;
        this.strings[pos] = rawString;
      }
    }

    this.values = values as unknown as Values;
  }

  get sql() {
    const len = this.strings.length;
    let i = 1;
    let value = this.strings[0];
    while (i < len) value += `?${this.strings[i++]}`;
    return value;
  }

  get statement() {
    const len = this.strings.length;
    let i = 1;
    let value = this.strings[0];
    while (i < len) value += `:${i}${this.strings[i++]}`;
    return value;
  }

  get text() {
    const len = this.strings.length;
    let i = 1;
    let value = this.strings[0];
    while (i < len) value += `$${i}${this.strings[i++]}`;
    return value;
  }

  inspect() {
    return {
      sql: this.sql,
      statement: this.statement,
      text: this.text,
      values: this.values,
    };
  }
}

/**
 * Create a SQL query for a list of values.
 */
export function join<T extends RawValue[] = any[]>(
  values: T,
  separator = ",",
  prefix = "",
  suffix = "",
): Sql<FlattenValues<T>> {
  if (values.length === 0) {
    throw new TypeError(
      "Expected `join([])` to be called with an array of multiple elements, but got an empty array",
    );
  }

  return new Sql<FlattenValues<T>>(
    [prefix, ...Array(values.length - 1).fill(separator), suffix],
    values,
  );
}

/**
 * Create a SQL query for a list of structured values.
 */
export function bulk<T extends ReadonlyArray<RawValue> = readonly any[]>(
  data: ReadonlyArray<T>,
  separator = ",",
  prefix = "",
  suffix = "",
): Sql<Value[]> {
  const length = data.length && data[0].length;

  if (length === 0) {
    throw new TypeError(
      "Expected `bulk([][])` to be called with a nested array of multiple elements, but got an empty array",
    );
  }

  const values = data.map((item, index) => {
    if (item.length !== length) {
      throw new TypeError(
        `Expected \`bulk([${index}][])\` to have a length of ${length}, but got ${item.length}`,
      );
    }

    return new Sql(["(", ...Array(item.length - 1).fill(separator), ")"], item);
  });

  return new Sql<Value[]>(
    [prefix, ...Array(values.length - 1).fill(separator), suffix],
    values,
  );
}

/**
 * Create raw SQL statement.
 */
export function raw(value: string): Sql<[]> {
  return new Sql<[]>([value], []);
}

/**
 * Placeholder value for "no text".
 */
export const empty = raw("");

/**
 * Concatenates multiple SQL templates into a single SQL template.
 *
 * @param templates - The array of SQL templates to concatenate into a single
 * SQL template.
 * @param separator - The string to insert between each SQL template when
 * concatenating their strings.
 * @returns A new SQL template representing the concatenation of the input SQL
 * templates with their values flattened into a single array.
 */
export function concat<const T extends Sql[]>(
  templates: T,
  separator = " ",
): Sql<FlattenValues<T>> {
  const strings: string[] = [];
  const values: Value[] = [];

  for (const template of templates) {
    if (strings.length === 0) {
      strings.push(...template.strings);
    } else {
      strings[strings.length - 1] += separator + template.strings[0];
      strings.push(...template.strings.slice(1));
    }

    values.push(...template.values);
  }

  return new Sql<FlattenValues<T>>(strings, values);
}

/**
 * Create a SQL object from a template string.
 */
export default function sql<T extends ReadonlyArray<RawValue> = readonly any[]>(
  strings: TemplateStringsArray,
  ...values: T
): Sql<FlattenValues<T>> {
  return new Sql<FlattenValues<T>>(strings, values);
}
