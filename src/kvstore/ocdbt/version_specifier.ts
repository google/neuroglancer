/**
 * @license
 * Copyright 2025 Google Inc.
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

import type {
  CommitTime,
  GenerationNumber,
} from "#src/kvstore/ocdbt/version_tree.js";

export type VersionSpecifier =
  | { generationNumber: GenerationNumber }
  | { commitTime: CommitTime };

export function formatVersion(version: VersionSpecifier | undefined) {
  if (version === undefined) return "HEAD";
  if ("generationNumber" in version) {
    return `v${version.generationNumber}`;
  }
  const { commitTime } = version;
  return formatCommitTime(commitTime);
}

export function parseVersion(
  versionString: string | undefined,
): VersionSpecifier | undefined {
  if (versionString === undefined) return undefined;
  const m = versionString.match(
    /^(?:v([1-9]\d*)|(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d*)?Z))$/,
  );
  if (m === null) {
    throw new Error(
      `Invalid OCDBT version specifier: ${JSON.stringify(versionString)}`,
    );
  }
  const [, generationString] = m;
  if (generationString !== undefined) {
    const generationNumber = BigInt(generationString);
    if (generationNumber > 0xffffffffffffffffn) {
      throw new Error(`Invalid generation number: ${generationNumber}`);
    }
    return { generationNumber };
  }
  return { commitTime: parseCommitTime(versionString) };
}

function parseCommitTime(versionString: string): CommitTime {
  const m = versionString.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:(\.\d*))?Z$/,
  );
  if (m === null)
    throw new Error(
      `Invalid commit timestamp: ${JSON.stringify(versionString)}`,
    );
  const [, commitTimeString, commitTimeFractionalSeconds] = m;
  return commitTimeFromSecondsAndSubseconds(
    Date.parse(commitTimeString + "Z"),
    commitTimeFractionalSeconds,
  );
}

function commitTimeFromSecondsAndSubseconds(
  seconds: number,
  subseconds: string | undefined,
) {
  let commitTime = BigInt(seconds) * 1000000n;
  if (subseconds !== undefined && subseconds.length > 1) {
    const fraction = Number(subseconds);
    commitTime += BigInt(Math.min(999999999, Math.round(fraction * 1e9)));
  }
  return commitTime;
}

export function formatCommitTime(commitTime: CommitTime) {
  let fractionalSeconds = commitTime % 1000000000n;
  let seconds = commitTime / 1000000000n;
  if (fractionalSeconds < 0n) {
    fractionalSeconds += 1000000000n;
    seconds -= 1n;
  }
  let timestampString = new Date(Number(seconds) * 1000).toISOString();
  if (timestampString.length !== 24) {
    throw new Error(`Invalid commit time: ${commitTime} -> ${timestampString}`);
  }
  // Strip off .nnnZ portion.
  timestampString = timestampString.slice(0, 19);
  if (fractionalSeconds !== 0n) {
    timestampString +=
      "." + fractionalSeconds.toString().padStart(9, "0").replace(/0+$/, "");
  }
  timestampString += "Z";
  return timestampString;
}

const COMMIT_TIME_PREFIX_REGEXP = new RegExp(
  "^" +
    "(\\d{0,4})" + // year, always matches
    "(?:(?<=\\d{4})-" + // month separator, only allowed after 4-digit year
    "(\\d{0,2})" + // month
    "(?:(?<=\\d{2})-" + // day separator, only allowed after 2-digit month
    "(\\d{0,2})" + // day
    "(?:(?<=\\d{2})T" + // hour separator, only allowed after 2-digit day
    "(\\d{0,2})" + // hour
    "(?:(?<=\\d{2}):" + // minute separator, only allowed after 2-digit hour
    "(\\d{0,2})" + // minute
    "(?:(?<=\\d{2}):" + // second separator, only allowed after 2-digit minute
    "(\\d{0,2})" + // second
    "(?:(?<=\\d{2})" + // subseconds and Z only allowed after 2-digit second
    "(\\.\\d*)?" + // subseconds
    "(Z)?" + // Z suffix, indicates an exact timestamp rather than a prefix
    ")?" + // end of subsecond/Z group
    ")?" + // end of second group
    ")?" + // end of minute group
    ")?" + // end of hour group
    ")?" + // end of day group
    ")?" + // end of month group
    "$",
);

function getMinMaxDateComponent(
  componentName: string,
  prefix: string | undefined,
  digits: number,
  inclusiveMinBound: number,
  inclusiveMaxBound: number,
) {
  prefix = prefix ?? "";
  const min = parseInt(prefix.padEnd(digits, "0"), 10);
  const max = parseInt(prefix.padEnd(digits, "9"), 10);
  if (min > inclusiveMaxBound) {
    throw new Error(`Invalid ${componentName} prefix: ${prefix}`);
  }
  return [Math.max(inclusiveMinBound, min), Math.min(inclusiveMaxBound, max)];
}

function getDaysInMonth(year: number, month: number) {
  const d = new Date(0);
  d.setUTCFullYear(year);
  d.setUTCMonth(month);
  d.setUTCDate(0);
  return d.getUTCDate();
}

export function parseCommitTimePrefix(
  versionString: string,
): [CommitTime, CommitTime] {
  const m = versionString.match(COMMIT_TIME_PREFIX_REGEXP);
  if (m === null) {
    throw new Error(
      `Expected prefix of ISO-8601 "YYYY-MM-DDThh:mm:ss.sssssssssZ" format, but received: ${JSON.stringify(versionString)}`,
    );
  }
  const year = getMinMaxDateComponent("year", m[1], 4, 0, 9999);
  const month = getMinMaxDateComponent("month", m[2], 2, 1, 12);
  const daysInMaxMonth = getDaysInMonth(year[1], month[1]);
  const day = getMinMaxDateComponent("day", m[3], 2, 1, daysInMaxMonth);
  const hour = getMinMaxDateComponent("hour", m[4], 2, 0, 23);
  const minute = getMinMaxDateComponent("minute", m[5], 2, 0, 59);
  const second = getMinMaxDateComponent("second", m[6], 2, 0, 59);
  const subsecondString = m[7] ?? ".";
  const z = m[8];
  const minSubseconds = subsecondString.padEnd(10, "0");
  const maxSubseconds =
    z === undefined ? subsecondString.padEnd(10, "9") : minSubseconds;
  const subseconds = [minSubseconds, maxSubseconds];
  function getDate(i: number): CommitTime {
    const date = new Date(0);
    date.setUTCFullYear(year[i]);
    date.setUTCMonth(month[i] - 1);
    date.setUTCDate(day[i]);
    date.setUTCHours(hour[i]);
    date.setUTCMinutes(minute[i]);
    date.setUTCSeconds(second[i]);
    return commitTimeFromSecondsAndSubseconds(date.getTime(), subseconds[i]);
  }
  return [getDate(0), getDate(1)];
}
