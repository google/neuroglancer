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

export const ANNOTATE_ENUM_PROPERTY_TOOL_ID = "annotateEnumProperty";

export interface AnnotationPropertyToolJson {
  type: string;
  property: string;
}

export function annotateEnumPropertyToolJson(
  propertyIdentifier: string,
): AnnotationPropertyToolJson {
  return {
    type: ANNOTATE_ENUM_PROPERTY_TOOL_ID,
    property: propertyIdentifier,
  };
}

export const TOGGLE_BOOL_PROPERTY_TOOL_ID = "toggleBoolProperty";

export function toggleBoolPropertyToolJson(
  propertyIdentifier: string,
): AnnotationPropertyToolJson {
  return {
    type: TOGGLE_BOOL_PROPERTY_TOOL_ID,
    property: propertyIdentifier,
  };
}

export const ANNOTATE_NUMBER_PROPERTY_TOOL_ID = "annotateNumberProperty";

export function annotateNumberPropertyToolJson(
  propertyIdentifier: string,
): AnnotationPropertyToolJson {
  return {
    type: ANNOTATE_NUMBER_PROPERTY_TOOL_ID,
    property: propertyIdentifier,
  };
}

export const SELECT_PREVIOUS_ANNOTATION_TOOL_ID = "selectPreviousAnnotation";
export const SELECT_NEXT_ANNOTATION_TOOL_ID = "selectNextAnnotation";
