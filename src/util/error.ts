/**
 * @license
 * Copyright 2019 Google Inc.
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

export type ValueOrError<T> = (T & { error?: undefined }) | { error: string };

export function makeValueOrError<T>(f: () => T): ValueOrError<T> {
  try {
    return f() as ValueOrError<T>;
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export function valueOrThrow<T>(x: ValueOrError<T>): T {
  if (x.error !== undefined) throw new Error(x.error);
  return x;
}

export function formatErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) {
    const { message, cause } = error;
    if (cause !== undefined) {
      return `${message}: ${formatErrorMessage(cause)}`;
    }
    return message;
  }
  try {
    return "" + error;
  } catch {
    return "Unknown error";
  }
}
