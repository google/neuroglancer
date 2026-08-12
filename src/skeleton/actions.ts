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

// Neuroglancer event action identifier strings for all skeleton UI.
// These are the "skeleton-*" prefixed action names used in EventActionMap bindings
// and registerActionListener calls throughout the skeleton tab and edit tool.
// Default key bindings live in src/ui/default_input_event_bindings.ts.

// --- Tab navigation ---
export const SKELETON_GO_ROOT = "skeleton-go-root";
export const SKELETON_GO_BRANCH_START = "skeleton-go-branch-start";
export const SKELETON_GO_BRANCH_END = "skeleton-go-branch-end";
export const SKELETON_GO_PARENT = "skeleton-go-parent";
export const SKELETON_GO_CHILD = "skeleton-go-child";
export const SKELETON_CYCLE_BRANCHES = "skeleton-cycle-branches";
export const SKELETON_GO_UNFINISHED = "skeleton-go-unfinished-branch";
export const SKELETON_UNDO = "skeleton-undo";
export const SKELETON_REDO = "skeleton-redo";

// --- Node mutations (tab list focus + edit tool viewer focus) ---
export const SKELETON_TOGGLE_TRUE_END = "skeleton-toggle-true-end";
export const SKELETON_REROOT = "skeleton-reroot";

// --- Edit tool spatial actions ---
export const SKELETON_ADD_NODE = "skeleton-add-node";
// Merge (m): enters merge mode; click the anchor node, then the target node.
export const SKELETON_ENTER_MERGE_MODE = "skeleton-enter-merge-mode";
// Split (s): enters split mode; click the node to split.
export const SKELETON_ENTER_SPLIT_MODE = "skeleton-enter-split-mode";
export const SKELETON_ENTER_CREATE = "skeleton-enter-create";
export const SKELETON_PIN_NODE = "skeleton-pin-node";
export const SKELETON_DELETE_NODE = "skeleton-delete-node";
export const SKELETON_CLEAR_SELECTION = "skeleton-clear-node-selection";
