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

import { afterEach, describe, expect, it, vi } from "vitest";
import { setClipboardFromPromise } from "#src/util/clipboard.js";

describe("setClipboardFromPromise", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts the clipboard write before the data promise resolves", async () => {
    let resolveData: (value: string) => void;
    const data = new Promise<string>((resolve) => {
      resolveData = resolve;
    });
    let clipboardData: Record<string, ClipboardItemData> | undefined;

    class MockClipboardItem {
      constructor(itemData: Record<string, ClipboardItemData>) {
        clipboardData = itemData;
      }
    }

    const write = vi.fn(async () => {
      await clipboardData!["text/plain"];
    });
    vi.stubGlobal("ClipboardItem", MockClipboardItem);
    vi.stubGlobal("navigator", { clipboard: { write } });

    const result = setClipboardFromPromise(data);

    expect(write).toHaveBeenCalledOnce();
    expect(clipboardData).toBeDefined();

    resolveData!("https://example.com/shared-state");
    const blob = await clipboardData!["text/plain"];
    await expect(result).resolves.toBeUndefined();
    expect(blob).toBeInstanceOf(Blob);
    if (!(blob instanceof Blob)) throw new Error("Expected clipboard Blob");
    expect(blob.type).toBe("text/plain");
    expect(blob.size).toBe(32);
  });

  it("propagates a data-generation failure", async () => {
    let clipboardData: Record<string, ClipboardItemData> | undefined;

    class MockClipboardItem {
      constructor(itemData: Record<string, ClipboardItemData>) {
        clipboardData = itemData;
      }
    }

    const write = vi.fn(async () => {
      await clipboardData!["text/plain"];
    });
    vi.stubGlobal("ClipboardItem", MockClipboardItem);
    vi.stubGlobal("navigator", { clipboard: { write } });

    const error = new Error("state server failed");
    await expect(setClipboardFromPromise(Promise.reject(error))).rejects.toBe(
      error,
    );
  });

  it("propagates a clipboard failure", async () => {
    class MockClipboardItem {}

    const error = new Error("clipboard denied");
    const write = vi.fn().mockRejectedValue(error);
    vi.stubGlobal("ClipboardItem", MockClipboardItem);
    vi.stubGlobal("navigator", { clipboard: { write } });

    await expect(
      setClipboardFromPromise(Promise.resolve("share link")),
    ).rejects.toBe(error);
  });
});
