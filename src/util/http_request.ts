/**
 * @license
 * Copyright 2016 Google Inc.
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

import type { ProgressListener } from "#src/util/progress_listener.js";

export class HttpError extends Error {
  url: string;
  status: number;
  statusText: string;
  response?: Response;

  constructor(
    url: string,
    status: number,
    statusText: string,
    response?: Response,
    options?: { cause: any },
  ) {
    let message = `Fetching ${JSON.stringify(
      url,
    )} resulted in HTTP error ${status}`;
    if (statusText) {
      message += `: ${statusText}`;
    }
    message += ".";
    super(message, options);
    this.name = "HttpError";
    this.message = message;
    this.url = url;
    this.status = status;
    this.statusText = statusText;
    if (response) {
      this.response = response;
    }
  }

  static fromResponse(response: Response) {
    return new HttpError(
      response.url,
      response.status,
      response.statusText,
      response,
    );
  }

  static fromRequestError(input: RequestInfo, error: unknown) {
    if (error instanceof TypeError) {
      let url: string;
      if (typeof input === "string") {
        url = input;
      } else {
        url = input.url;
      }
      return new HttpError(url, 0, "Network or CORS error", undefined, {
        cause: error,
      });
    }
    return error;
  }
}

const maxAttempts = 32;
const minDelayMilliseconds = 500;
const maxDelayMilliseconds = 10000;

export function pickDelay(attemptNumber: number): number {
  // If `attemptNumber == 0`, delay is a random number of milliseconds between
  // `[minDelayMilliseconds, minDelayMilliseconds*2]`.  The lower and upper bounds of the interval
  // double with each successive attempt, up to the limit of
  // `[maxDelayMilliseconds/2,maxDelayMilliseconds]`.
  return (
    Math.min(
      2 ** attemptNumber * minDelayMilliseconds,
      maxDelayMilliseconds / 2,
    ) *
    (1 + Math.random())
  );
}

/**
 * Issues a `fetch` request.
 *
 * If the request fails due to an HTTP status outside `[200, 300)`, throws an `HttpError`.  If the
 * request fails due to a network or CORS restriction, throws an `HttpError` with a `status` of `0`.
 *
 * If the request fails due to a transient error (429, 503, 504), retry.
 */
export async function fetchOk(
  input: RequestInfo,
  init?: RequestInitWithProgress,
): Promise<Response> {
  for (let requestAttempt = 0; ; ) {
    init?.signal?.throwIfAborted();
    let response: Response;
    try {
      response = await fetch(input, init);
    } catch (error) {
      throw HttpError.fromRequestError(input, error);
    }
    if (!response.ok) {
      const { status } = response;
      if (status === 429 || status === 503 || status === 504) {
        // 429: Too Many Requests.  Retry.
        // 503: Service unavailable.  Retry.
        // 504: Gateway timeout.  Can occur if the server takes too long to reply.  Retry.
        if (++requestAttempt !== maxAttempts) {
          await new Promise((resolve) =>
            setTimeout(resolve, pickDelay(requestAttempt - 1)),
          );
          continue;
        }
      }
      throw HttpError.fromResponse(response);
    }
    return response;
  }
}

export interface RequestInitWithProgress extends RequestInit {
  progressListener?: ProgressListener;
}

export type FetchOk = (
  input: RequestInfo,
  init?: RequestInitWithProgress,
) => Promise<Response>;

export function isNotFoundError(e: any) {
  if (!(e instanceof HttpError)) return false;
  // Treat CORS errors (0) or 403 as not found.  S3 returns 403 if the file does not exist because
  // permissions are per-file.
  return e.status === 0 || e.status === 403 || e.status === 404;
}
