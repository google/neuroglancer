/**
 * @license
 * Copyright 2024 Google Inc.
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

import { escapeRegExp } from "lodash-es";
import { defaultStringCompare } from "#src/util/string.js";

export type PropertyPredicate = { equals: string } | { regexp: RegExp };

export interface QueryRange {
  begin: number;
  end: number;
}

export interface QueryTerm {
  // Start offset in query string;
  range: QueryRange;
  property: string;
  predicate: PropertyPredicate;
}

// A clause specifies a conjunction (AND) of terms. All tools matching the
// clause are either included or excluded from the overall results.
export interface QueryClause {
  // Indicates if this clause is an inclusion or an exclusion.
  include: boolean;
  range: QueryRange;
  terms: QueryTerm[];
}

// A query specifies an ordered list of inclusion/exclusion clauses.
export interface Query {
  clauses: QueryClause[];
}

export interface ParseError {
  range: QueryRange;
  message: string;
}

const TOKEN_PATTERN =
  /^(\s*)(?:(\+|-)|([a-zA-Z]+):(?:("(?:[^"\\]|\\.)*")|([^\s"/][^\s"]*)|\/((?:[^/\\]|\\.)*)\/)(?=$|\s))/;

export interface PartialQuery {
  raw: string;
  query: Query;
  errors: ParseError[];
  endOffset: number;
}

export function parsePartialToolQuery(query: string): PartialQuery {
  let offset = 0;
  const raw = query;

  const parsedQuery: Query = { clauses: [] };
  let currentClause: QueryClause | undefined;

  const errors: ParseError[] = [];

  const endClause = () => {
    if (currentClause === undefined) return;
    if (currentClause.terms.length === 0) {
      if (currentClause.include === false) {
        errors.push({
          range: { begin: currentClause.range.begin, end: offset },
          message: "Exclusion clause must have at least one term",
        });
      }
      currentClause.range.end = offset;
      parsedQuery.clauses.push(currentClause);
    } else {
      currentClause.range.end =
        currentClause.terms[currentClause.terms.length - 1].range.end;
      parsedQuery.clauses.push(currentClause);
    }
  };

  for (let nextOffset: number; true; offset = nextOffset) {
    // Parse include/exclude token.
    const tokenMatch = query.match(TOKEN_PATTERN);

    if (tokenMatch === null) {
      break;
    }

    const matchLength = tokenMatch[0].length;
    nextOffset = offset + matchLength;
    query = query.substring(matchLength);

    const skipLength = tokenMatch[1].length;

    const includeExclude = tokenMatch[2];
    if (includeExclude !== undefined) {
      // New clause
      endClause();
      currentClause = {
        range: { begin: offset + skipLength, end: -1 },
        include: includeExclude === "+",
        terms: [],
      };
      continue;
    }

    const propertyName = tokenMatch[3];
    if (currentClause === undefined) {
      currentClause = {
        range: { begin: offset + skipLength, end: -1 },
        include: true,
        terms: [],
      };
    } else {
      // Check that property is not already present in this clause.
      if (
        currentClause.terms.find((term) => term.property === propertyName) !==
        undefined
      ) {
        errors.push({
          range: {
            begin: offset + skipLength,
            end: offset + skipLength + propertyName.length,
          },
          message: `Property ${JSON.stringify(propertyName)} cannot be constrained by more than one term in a clause`,
        });
      }
    }

    let predicate: PropertyPredicate;

    const quoted = tokenMatch[4];
    if (quoted !== undefined) {
      predicate = { equals: JSON.parse(quoted) };
    } else {
      const unquoted = tokenMatch[5];
      if (unquoted !== undefined) {
        predicate = { equals: unquoted };
      } else {
        try {
          const regexp = new RegExp(tokenMatch[6], "i");
          predicate = { regexp };
        } catch (e) {
          errors.push({
            range: {
              begin: offset + skipLength + propertyName.length + 2,
              end: nextOffset - 1,
            },
            message: (e as SyntaxError).message,
          });
          predicate = { equals: "" };
        }
      }
    }

    currentClause.terms.push({
      range: { begin: offset + skipLength, end: nextOffset },
      property: propertyName,
      predicate,
    });
    continue;
  }

  endClause();

  // Skip whitespace before ending parsing.
  {
    const m = query.match(/^\s*/);
    if (m !== null) {
      offset += m[0].length;
    }
  }

  return { raw, query: parsedQuery, errors, endOffset: offset };
}

export function parseToolQuery(
  query: string,
): { query: Query } | { errors: ParseError[] } {
  const result = parsePartialToolQuery(query);
  if (result.endOffset !== query.length) {
    result.errors.push({
      range: { begin: result.endOffset, end: query.length },
      message: "Invalid clause/term",
    });
  }
  if (result.errors.length > 0) {
    return { errors: result.errors };
  }
  return { query: result.query };
}

export function matchPredicate(predicate: PropertyPredicate, value: string) {
  if ("equals" in predicate) {
    return predicate.equals === value;
  } else {
    return value.match(predicate.regexp) !== null;
  }
}

export function matchesTerms(toolJson: any, terms: QueryTerm[]) {
  for (const term of terms) {
    const value = toolJson[term.property];
    if (typeof value !== "string") return false;
    if (!matchPredicate(term.predicate, value)) return false;
  }
  return true;
}

export interface QueryCompletion {
  offset: number;
  prefix: string;
  property?: string;
  include: boolean;
  completionQuery: Query;
}

export function getCompletionOffset(query: PartialQuery): number {
  const { clauses } = query.query;
  if (query.endOffset === query.raw.length && clauses.length !== 0) {
    const { range, terms } = clauses[clauses.length - 1];
    if (range.end === query.endOffset && terms.length !== 0) {
      const lastTerm = terms[terms.length - 1];
      // Remove last term since it will be completed.
      terms.length = terms.length - 1;
      return lastTerm.range.begin;
    }
  }

  return query.endOffset;
}

const PARTIAL_TERM_PATTERN = /^([a-zA-Z]+):/;

export function getQueryTermToComplete(query: PartialQuery): QueryCompletion {
  const termOffset = getCompletionOffset(query);
  let prefix = query.raw.substring(termOffset);
  let property: string | undefined;
  const m = prefix.match(PARTIAL_TERM_PATTERN);

  const include =
    query.query.clauses.length == 0 ||
    query.query.clauses[query.query.clauses.length - 1].include;
  let offset: number;
  if (m === null) {
    offset = termOffset;
  } else {
    offset = termOffset + m[1].length + 1;
    property = m[1];
    prefix = prefix.substring(m[1].length + 1);
  }

  const completionQuery: Query = { clauses: [] };

  const { clauses } = query.query;
  const currentTerms: QueryTerm[] = [];
  if (clauses.length !== 0) {
    currentTerms.push(...clauses[clauses.length - 1].terms);
  }
  if (property !== undefined) {
    currentTerms.push({
      property,
      predicate: { regexp: new RegExp("^" + escapeRegExp(prefix)) },
      range: { begin: -1, end: -1 },
    });
  }

  if (include) {
    completionQuery.clauses.push({
      include: true,
      terms: currentTerms,
      range: { begin: -1, end: -1 },
    });

    // All other clauses are inverted
    for (let i = 0, numClauses = clauses.length - 1; i < numClauses; ++i) {
      const clause = clauses[i];
      completionQuery.clauses.push({
        include: !clause.include,
        terms: clause.terms,
        range: clause.range,
      });
    }
  } else {
    for (let i = 0, numClauses = clauses.length - 1; i < numClauses; ++i) {
      const clause = clauses[i];
      let terms = clause.terms;
      if (clause.include) {
        terms = [...terms, ...currentTerms];
      }
      completionQuery.clauses.push({
        include: clause.include,
        terms,
        range: clause.range,
      });
    }
  }
  return { offset, prefix, property, include, completionQuery };
}

function getSortedCompletions(values: Map<string, number>) {
  const result = Array.from(values);
  result.sort((a, b) => defaultStringCompare(a[0], b[0]));
  return result;
}

export function getPropertyNameCompletions(
  completionQuery: Query,
  matches: Map<string, any>,
  prefix: string,
) {
  const existingPropertyNames = new Set(
    Array.from(completionQuery.clauses[0].terms, (term) => term.property),
  );
  const properties = new Map<string, number>();
  for (const match of matches.values()) {
    for (const property in match) {
      if (!property.startsWith(prefix) || existingPropertyNames.has(property)) {
        continue;
      }
      const value = property + ":";
      const existing = properties.get(value) ?? 0;
      properties.set(value, existing + 1);
    }
  }
  return getSortedCompletions(properties);
}

export function getPropertyValueCompletions(
  matches: Map<string, any>,
  property: string,
) {
  const values = new Map<string, number>();
  for (const match of matches.values()) {
    const value = "" + match[property];
    const existing = values.get(value) ?? 0;
    values.set(value, existing + 1);
  }
  return getSortedCompletions(values);
}

export const INCLUDE_EVERYTHING_QUERY: Query = {
  clauses: [{ include: true, terms: [], range: { begin: -1, end: -1 } }],
};
