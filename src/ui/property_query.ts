/**
 * @license
 * Copyright 2026 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { DataType } from "#src/util/data_type.js";
import type { DataTypeInterval } from "#src/util/lerp.js";
import {
  clampToInterval,
  dataTypeCompare,
  dataTypeValueNextAfter,
  parseDataTypeValue,
} from "#src/util/lerp.js";
import { parseValueWithUnit } from "#src/util/si_units.js";

export interface PropertyQueryToken {
  text: string;
  begin: number;
  end: number;
}

type PropertyQueryClauseBase = PropertyQueryToken;

export interface PropertyQuerySortClause extends PropertyQueryClauseBase {
  type: "sort";
  field: string;
  order: "<" | ">";
}

export interface PropertyQueryColumnClause extends PropertyQueryClauseBase {
  type: "column";
  field: string;
}

export interface PropertyQueryComparisonClause extends PropertyQueryClauseBase {
  type: "comparison";
  field: string;
  operator: "<" | "<=" | "=" | ">=" | ">";
  value: string;
}

export interface PropertyQueryCategoricalClause
  extends PropertyQueryClauseBase {
  type: "categorical";
  exclude: boolean;
  field: string;
  value: string | undefined;
}

export interface PropertyQueryRegexpClause extends PropertyQueryClauseBase {
  type: "regexp";
  pattern: string;
  closed: boolean;
}

export interface PropertyQueryTextClause extends PropertyQueryClauseBase {
  type: "text";
  value: string;
}

export type PropertyQueryClause =
  | PropertyQuerySortClause
  | PropertyQueryColumnClause
  | PropertyQueryComparisonClause
  | PropertyQueryCategoricalClause
  | PropertyQueryRegexpClause
  | PropertyQueryTextClause;

type WithoutSourceRange<T> = T extends PropertyQueryClause
  ? Omit<T, keyof PropertyQueryToken>
  : never;

export type SerializablePropertyQueryClause =
  WithoutSourceRange<PropertyQueryClause>;

export interface PropertyQuerySyntaxError {
  begin: number;
  end: number;
  message: string;
}

export interface ParsedPropertyQuery {
  clauses: PropertyQueryClause[];
  errors: PropertyQuerySyntaxError[];
}

export interface ResolvedPropertyQuerySort {
  fieldId: string;
  order: "<" | ">";
}

export interface ResolvedPropertyQueryNumericalConstraint {
  fieldId: string;
  bounds: DataTypeInterval;
}

export interface ResolvedPropertyQueryBase {
  prefix: string | undefined;
  regexp: RegExp | undefined;
  numericalConstraints: ResolvedPropertyQueryNumericalConstraint[];
  sortBy: ResolvedPropertyQuerySort[];
  includeColumns: string[];
}

export interface PropertyQueryNumericField {
  fieldId: string;
  dataType: DataType;
  bounds: DataTypeInterval;
  baseUnit?: string;
}

export type PropertyQueryResolution<T> =
  | { value: T }
  | { ignore: true }
  | { error: PropertyQuerySyntaxError };

export interface PropertyQueryResolverContext {
  errors: PropertyQuerySyntaxError[];
}

export interface PropertyQueryDomainResolver<
  Query extends ResolvedPropertyQueryBase,
> {
  createQuery: () => Query;
  resolveSortField: (
    clause: PropertyQuerySortClause,
  ) => PropertyQueryResolution<string>;
  resolveColumnField: (
    clause: PropertyQueryColumnClause,
  ) => PropertyQueryResolution<string>;
  resolveNumericField: (
    clause: PropertyQueryComparisonClause,
  ) => PropertyQueryResolution<PropertyQueryNumericField>;
  applyCategoricalClause: (
    query: Query,
    clause: PropertyQueryCategoricalClause,
    context: PropertyQueryResolverContext,
  ) => void;
  defaultSort: ResolvedPropertyQuerySort;
  regexpFlags?: string;
  textUnavailableError?: string;
  duplicateSortMessage?: (
    clause: PropertyQuerySortClause,
    fieldId: string,
  ) => string;
}

export function tokenizePropertyQuery(text: string): PropertyQueryToken[] {
  const tokens: PropertyQueryToken[] = [];
  let index = 0;
  while (index < text.length) {
    while (index < text.length && /\s/.test(text[index])) ++index;
    if (index === text.length) break;
    const begin = index;
    while (index < text.length && !/\s/.test(text[index])) ++index;
    tokens.push({ text: text.slice(begin, index), begin, end: index });
  }
  return tokens;
}

const comparisonPattern = /^([a-zA-Z][a-zA-Z0-9_]*)(<=|>=|<|>|=)(-?[0-9.].*)$/;
const categoricalPattern = /^(-?)#([a-zA-Z][a-zA-Z0-9_]*)(?:=(.*))?$/;

export function parsePropertyQuerySyntax(text: string): ParsedPropertyQuery {
  const clauses: PropertyQueryClause[] = [];
  const errors: PropertyQuerySyntaxError[] = [];
  for (const token of tokenizePropertyQuery(text)) {
    const { text, begin, end } = token;
    if (text.startsWith("<") || text.startsWith(">")) {
      const field = text.slice(1);
      if (field === "") {
        errors.push({ begin, end, message: "Sort field is missing" });
      } else {
        clauses.push({
          type: "sort",
          text,
          begin,
          end,
          field,
          order: text[0] as "<" | ">",
        });
      }
      continue;
    }
    if (text.startsWith("|")) {
      const field = text.slice(1);
      if (field === "") {
        errors.push({ begin, end, message: "Column field is missing" });
      } else {
        clauses.push({ type: "column", text, begin, end, field });
      }
      continue;
    }
    if (text.startsWith("/")) {
      const closed = text.length > 1 && text.endsWith("/");
      clauses.push({
        type: "regexp",
        text,
        begin,
        end,
        pattern: text.slice(1, closed ? -1 : undefined),
        closed,
      });
      continue;
    }
    const categoricalMatch = text.match(categoricalPattern);
    if (categoricalMatch !== null) {
      clauses.push({
        type: "categorical",
        text,
        begin,
        end,
        exclude: categoricalMatch[1] === "-",
        field: categoricalMatch[2],
        value: categoricalMatch[3],
      });
      continue;
    }
    const comparisonMatch = text.match(comparisonPattern);
    if (comparisonMatch !== null) {
      clauses.push({
        type: "comparison",
        text,
        begin,
        end,
        field: comparisonMatch[1],
        operator:
          comparisonMatch[2] as PropertyQueryComparisonClause["operator"],
        value: comparisonMatch[3],
      });
      continue;
    }
    clauses.push({ type: "text", text, begin, end, value: text });
  }
  return { clauses, errors };
}

function applyNumericalComparison(
  constraints: ResolvedPropertyQueryNumericalConstraint[],
  field: PropertyQueryNumericField,
  clause: PropertyQueryComparisonClause,
): PropertyQuerySyntaxError | undefined {
  let value: number;
  try {
    const parsedValue =
      field.baseUnit === undefined
        ? clause.value
        : parseValueWithUnit(clause.value, field.baseUnit);
    if (parsedValue === undefined) {
      throw new Error(`Invalid value: ${JSON.stringify(clause.value)}`);
    }
    value = parseDataTypeValue(field.dataType, `${parsedValue}`) as number;
  } catch (error) {
    return {
      begin: clause.begin + clause.field.length + clause.operator.length,
      end: clause.end,
      message: (error as Error).message,
    };
  }
  let constraint = constraints.find((x) => x.fieldId === field.fieldId);
  if (constraint === undefined) {
    constraint = { fieldId: field.fieldId, bounds: field.bounds };
    constraints.push(constraint);
  }
  const originalMin = clampToInterval(field.bounds, constraint.bounds[0]);
  const originalMax = clampToInterval(field.bounds, constraint.bounds[1]);
  let newMin = originalMin;
  let newMax = originalMax;
  switch (clause.operator) {
    case "<":
      newMax = dataTypeValueNextAfter(field.dataType, value, -1);
      break;
    case "<=":
      newMax = value;
      break;
    case "=":
      newMin = newMax = value;
      break;
    case ">=":
      newMin = value;
      break;
    case ">":
      newMin = dataTypeValueNextAfter(field.dataType, value, +1);
      break;
  }
  newMin = dataTypeCompare(originalMin, newMin) > 0 ? originalMin : newMin;
  newMax = dataTypeCompare(originalMax, newMax) < 0 ? originalMax : newMax;
  if (dataTypeCompare(newMin, newMax) > 0) {
    return {
      begin: clause.begin,
      end: clause.end,
      message: "Constraint would not match any values",
    };
  }
  constraint.bounds = [newMin, newMax] as DataTypeInterval;
  return undefined;
}

export function resolvePropertyQuery<Query extends ResolvedPropertyQueryBase>(
  text: string,
  resolver: PropertyQueryDomainResolver<Query>,
): Query | { errors: PropertyQuerySyntaxError[] } {
  const query = resolver.createQuery();
  const syntax = parsePropertyQuerySyntax(text);
  const errors = [...syntax.errors];
  const context = { errors };

  for (const clause of syntax.clauses) {
    if (clause.type === "categorical") {
      resolver.applyCategoricalClause(query, clause, context);
      continue;
    }
    if (clause.type === "sort") {
      const resolution = resolver.resolveSortField(clause);
      if ("error" in resolution) {
        errors.push(resolution.error);
      } else if (!("ignore" in resolution)) {
        const fieldId = resolution.value;
        if (query.sortBy.some((sort) => sort.fieldId === fieldId)) {
          errors.push({
            begin: clause.begin + 1,
            end: clause.end,
            message:
              resolver.duplicateSortMessage?.(clause, fieldId) ??
              `Duplicate sort field: ${fieldId}`,
          });
        } else {
          query.sortBy.push({ fieldId, order: clause.order });
        }
      }
      continue;
    }
    if (clause.type === "column") {
      const resolution = resolver.resolveColumnField(clause);
      if ("error" in resolution) {
        errors.push(resolution.error);
      } else if (!("ignore" in resolution)) {
        const fieldId = resolution.value;
        if (
          !query.sortBy.some((sort) => sort.fieldId === fieldId) &&
          !query.includeColumns.includes(fieldId)
        ) {
          query.includeColumns.push(fieldId);
        }
      }
      continue;
    }
    if (clause.type === "comparison") {
      const resolution = resolver.resolveNumericField(clause);
      if ("error" in resolution) {
        errors.push(resolution.error);
      } else if (!("ignore" in resolution)) {
        const error = applyNumericalComparison(
          query.numericalConstraints,
          resolution.value,
          clause,
        );
        if (error !== undefined) errors.push(error);
      }
      continue;
    }
    if (resolver.textUnavailableError !== undefined) {
      errors.push({
        begin: clause.begin,
        end: clause.end,
        message: resolver.textUnavailableError,
      });
      continue;
    }
    if (clause.type === "regexp") {
      if (query.regexp !== undefined || query.prefix !== undefined) {
        errors.push({
          begin: clause.begin,
          end: clause.end,
          message:
            query.regexp !== undefined
              ? "Only one regular expression allowed"
              : "Prefix cannot be combined with regular expression",
        });
        continue;
      }
      try {
        query.regexp = new RegExp(clause.pattern, resolver.regexpFlags);
      } catch {
        errors.push({
          begin: clause.begin,
          end: clause.end,
          message: "Invalid regular expression syntax",
        });
      }
    } else {
      if (query.regexp !== undefined) {
        errors.push({
          begin: clause.begin,
          end: clause.end,
          message: "Prefix cannot be combined with regular expression",
        });
        continue;
      }
      query.prefix =
        query.prefix === undefined
          ? clause.value
          : `${query.prefix} ${clause.value}`;
    }
  }

  if (errors.length !== 0) return { errors };
  if (query.sortBy.length === 0) query.sortBy.push(resolver.defaultSort);
  return query;
}

export function serializePropertyQueryClause(
  clause: SerializablePropertyQueryClause,
): string {
  switch (clause.type) {
    case "sort":
      return `${clause.order}${clause.field}`;
    case "column":
      return `|${clause.field}`;
    case "comparison":
      return `${clause.field}${clause.operator}${clause.value}`;
    case "categorical":
      return `${clause.exclude ? "-" : ""}#${clause.field}${
        clause.value === undefined ? "" : `=${clause.value}`
      }`;
    case "regexp":
      return `/${clause.pattern}/`;
    case "text":
      return clause.value;
  }
}

export function serializePropertyQueryClauses(
  clauses: SerializablePropertyQueryClause[],
): string {
  return clauses.map(serializePropertyQueryClause).join(" ");
}
