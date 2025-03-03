/**
 * @license
 * Copyright 2017 Google Inc.
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

import { registerEventListener } from "#src/util/disposable.js";
import type { HierarchicalMapInterface } from "#src/util/hierarchical_map.js";
import { HierarchicalMap } from "#src/util/hierarchical_map.js";

/**
 * @file Facilities for dispatching user-defined actions in response to input events.
 */

/**
 * Specifies a unique string representation of an input event, used for matching an input event to a
 * corresponding action with which it has been associated.
 *
 * The EventIdentifier combines several pieces of information using the following syntax:
 *
 *   NormalizedEventIdentifier ::= phase ':' ( modifier '+' )* base-event-identifier
 *
 *   - The event `phase` name, corresponding to the phase of DOM event processing at which the event was
 *     received, which may be 'at', 'bubble', or 'capture'.  (Currently, 'capture' is not supported.)
 *
 *   - The set of `modifier` keys ('control', 'alt', 'meta', and/or 'shift') active when the event occurred.
 *
 *   - The `base-event-identifier`, which in the case of keyboard events is the lowercase KeyboardEvent
 *     `code`, and in the case of mouse events is one of:
 *
 *       - 'mousedown' + n
 *       - 'mouseup' + n
 *       - 'click' + n
 *       - 'dblclick' + n
 *       - 'wheel'
 *
 *     where `n` is the index of the mouse button, starting from 0.
 *
 * In the normalized form used for matching events, the set of modifiers must be specified in
 * exactly the order: 'control', 'alt', 'meta', 'shift'.  Consequently, there is exactly one
 * NormalizedEventIdentifier representation for a given input event.
 */
export type NormalizedEventIdentifier = string;

/**
 * An EventIdentifier specifies a criteria for matching input events using a relaxed form of the
 * NormalizedEventIdentifier syntax.  Each EventIdentifier corresponds to one or more
 * NormalizedEventIdentifier values.
 *
 *   EventIdentifier ::= [ phase ':' ] ( modifier '+' )* base-event-identifier
 *
 * In addition to the phase being optional, the modifiers may be specified in any order.  If the
 * phase is not specified, then the EventIdentifier matches both the 'at' and 'bubble' phases.
 */
export type EventIdentifier = string;

/**
 * Identifies a user-defined action name.  Actions are dispatched as DOM events, using 'action:'
 * prepended to the ActionIdentifier as the event type.
 */
export type ActionIdentifier = string;

/**
 * Specifies how to handle an event.
 */
export interface EventAction {
  /**
   * Identifier of action to dispatch.
   */
  action: ActionIdentifier;

  /**
   * Whether to call `stopPropagation()` on the triggering event.  Defaults to true.
   */
  stopPropagation?: boolean;

  /**
   * Whether to call `preventDefault()` on the triggering event.  Defaults to true.  Additionally,
   * if `preventDefault()` is called on the dispatched ActionEvent, `preventDefault()` will also be
   * called on the triggering event regardless of the value of `preventDefault`.
   */
  preventDefault?: boolean;

  originalEventIdentifier?: string;
}

export type EventActionMapInterface = HierarchicalMapInterface<
  NormalizedEventIdentifier,
  EventAction
>;

export enum Modifiers {
  CONTROL = 1,
  ALT = 2,
  META = 4,
  SHIFT = 8,
}

export type ModifierMask = number;

export interface EventModifierKeyState {
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

export function getEventModifierMask(
  event: EventModifierKeyState,
): ModifierMask {
  return (
    (event.ctrlKey ? Modifiers.CONTROL : 0) |
    (event.altKey ? Modifiers.ALT : 0) |
    (event.metaKey ? Modifiers.META : 0) |
    (event.shiftKey ? Modifiers.SHIFT : 0)
  );
}

export function getStrokeIdentifier(keyName: string, modifiers: ModifierMask) {
  let identifier = "";
  if (modifiers & Modifiers.CONTROL) {
    identifier += "control+";
  }
  if (modifiers & Modifiers.ALT) {
    identifier += "alt+";
  }
  if (modifiers & Modifiers.META) {
    identifier += "meta+";
  }
  if (modifiers & Modifiers.SHIFT) {
    identifier += "shift+";
  }
  identifier += keyName;
  return identifier;
}

function getStrokeIdentifierWithOptionalModifiers(
  keyName: string,
  modifiers: ModifierMask,
  optionalModifiers: ModifierMask,
) {
  let identifier = "";
  if (modifiers & Modifiers.CONTROL) {
    identifier += "control+";
  }
  if (optionalModifiers & Modifiers.CONTROL) {
    identifier += "control?+";
  }
  if (modifiers & Modifiers.ALT) {
    identifier += "alt+";
  }
  if (optionalModifiers & Modifiers.ALT) {
    identifier += "alt?+";
  }
  if (modifiers & Modifiers.META) {
    identifier += "meta+";
  }
  if (optionalModifiers & Modifiers.META) {
    identifier += "meta?+";
  }
  if (modifiers & Modifiers.SHIFT) {
    identifier += "shift+";
  }
  if (optionalModifiers & Modifiers.SHIFT) {
    identifier += "shift?+";
  }
  identifier += keyName;
  return identifier;
}

interface ParsedEventIdentifier {
  phase: undefined | "at" | "bubble";
  keyName: string;
  modifiers: ModifierMask;
  optionalModifiers: ModifierMask;
}

function parseEventIdentifier(identifier: string): ParsedEventIdentifier {
  const firstColonOffset = identifier.indexOf(":");
  let phase: string | undefined;
  if (firstColonOffset !== -1) {
    phase = identifier.substring(0, firstColonOffset);
    // TODO(jbms): Support capture phase.
    if (phase !== "at" && phase !== "bubble") {
      throw new Error(`Invalid event phase: ${JSON.stringify(phase)}`);
    }
  }
  const parts = identifier.substring(firstColonOffset + 1).split("+");
  let keyName: string | undefined;
  let modifiers = 0;
  let optionalModifiers = 0;
  loop: for (const part of parts) {
    switch (part) {
      case "control":
        modifiers |= Modifiers.CONTROL;
        break;
      case "control?":
        optionalModifiers |= Modifiers.CONTROL;
        break;
      case "alt":
        modifiers |= Modifiers.ALT;
        break;
      case "alt?":
        optionalModifiers |= Modifiers.ALT;
        break;
      case "meta":
        modifiers |= Modifiers.META;
        break;
      case "meta?":
        optionalModifiers |= Modifiers.META;
        break;
      case "shift":
        modifiers |= Modifiers.SHIFT;
        break;
      case "shift?":
        optionalModifiers |= Modifiers.SHIFT;
        break;
      default:
        if (keyName === undefined) {
          keyName = part;
        } else {
          keyName = undefined;
          break loop;
        }
    }
  }
  if (keyName === undefined || modifiers & optionalModifiers) {
    throw new Error(`Invalid event identifier: ${JSON.stringify(identifier)}`);
  }
  return {
    phase: phase as ParsedEventIdentifier["phase"],
    keyName,
    modifiers,
    optionalModifiers,
  };
}

function* getNormalizedStrokeIdentifiers(
  keyName: string,
  modifiers: ModifierMask,
  optionalModifiers: ModifierMask,
): Iterable<string> {
  if (optionalModifiers === 0) {
    yield getStrokeIdentifier(keyName, modifiers);
  }
  for (let m = 0; m < 16; ++m) {
    if ((m & (modifiers | optionalModifiers)) !== m) continue;
    if ((m & modifiers) !== modifiers) continue;
    yield getStrokeIdentifier(keyName, m);
  }
}

/**
 * Normalizes a user-specified EventIdentifier into a list of one or more corresponding
 * NormalizedEventIdentifier strings.
 */
function* getNormalizedEventIdentifiers(
  parsed: ParsedEventIdentifier,
): Iterable<NormalizedEventIdentifier> {
  const { phase } = parsed;
  const strokeIdentifiers = getNormalizedStrokeIdentifiers(
    parsed.keyName,
    parsed.modifiers,
    parsed.optionalModifiers,
  );
  if (phase === undefined) {
    for (const suffix of strokeIdentifiers) {
      yield `at:${suffix}`;
      yield `bubble:${suffix}`;
    }
  } else {
    for (const suffix of strokeIdentifiers) {
      yield `${phase}:${suffix}`;
    }
  }
}

/**
 * Specifies either an EventAction or a bare ActionIdentifier.
 */
type ActionOrEventAction = EventAction | ActionIdentifier;

/**
 * Normalizes an ActionOrEventAction into an EventAction.
 */
export function normalizeEventAction(
  parsed: ParsedEventIdentifier,
  action: ActionOrEventAction,
): EventAction {
  const identifier = getStrokeIdentifierWithOptionalModifiers(
    parsed.keyName,
    parsed.modifiers,
    parsed.optionalModifiers,
  );
  if (typeof action === "string") {
    return { action: action, originalEventIdentifier: identifier };
  }
  return { ...action, originalEventIdentifier: identifier };
}

// Strips the phase and optional modifiers.
export function friendlyEventIdentifier(identifier: string): string {
  identifier = identifier.replace(
    /^(?:at|bubble|capture)|(?:(?:shift|control|alt|meta)\?\+)/g,
    "",
  );
  return identifier;
}

/**
 * Hierarchical map of `EventIdentifier` specifications to `EventAction` specifications.  These maps
 * are used by KeyboardEventBinder and MouseEventBinder to dispatch an ActionEvent in response to an
 * input event.
 */
export class EventActionMap
  extends HierarchicalMap<
    NormalizedEventIdentifier,
    EventAction,
    EventActionMap
  >
  implements EventActionMapInterface
{
  label: string | undefined;

  /**
   * Returns a new EventActionMap with the specified bindings.
   *
   * The keys of the `bindings` object specify unnormalized event identifiers to be mapped to their
   * corresponding `ActionOrEventAction` values.
   */
  static fromObject(
    bindings: { [key: string]: ActionOrEventAction },
    options: {
      label?: string;
      parents?: Iterable<[EventActionMap, number]>;
    } = {},
  ) {
    const map = new EventActionMap();
    map.label = options.label;
    if (options.parents !== undefined) {
      for (const [parent, priority] of options.parents) {
        map.addParent(parent, priority);
      }
    }
    for (const key of Object.keys(bindings)) {
      map.set(key, bindings[key]);
    }
    return map;
  }

  setFromObject(bindings: { [key: string]: ActionOrEventAction }) {
    for (const key of Object.keys(bindings)) {
      this.set(key, bindings[key]);
    }
  }

  /**
   * Maps the specified event `identifier` to the specified `action`.
   *
   * The `identifier` may be unnormalized; the actual mapping is created for each corresponding
   * normalized identifier.
   */
  set(identifier: EventIdentifier, action: ActionOrEventAction) {
    const parsedIdentifier = parseEventIdentifier(identifier);
    const normalizedAction = normalizeEventAction(parsedIdentifier, action);
    for (const normalizedIdentifier of getNormalizedEventIdentifiers(
      parsedIdentifier,
    )) {
      super.set(normalizedIdentifier, normalizedAction);
    }
  }

  /**
   * Deletes the mapping for the specified `identifier`.
   *
   * The `identifier` may be unnormalized; the mapping is deleted for each corresponding normalized
   * identifier.
   */
  delete(identifier: EventIdentifier) {
    for (const normalizedIdentifier of getNormalizedEventIdentifiers(
      parseEventIdentifier(identifier),
    )) {
      super.delete(normalizedIdentifier);
    }
  }

  describe(): string {
    const bindings = [];
    const uniqueBindings = new Map<string, string>();
    for (const [, value] of this.entries()) {
      uniqueBindings.set(value.originalEventIdentifier!, value.action);
    }
    const actionBindings = new Map<string, string[]>();
    for (const [eventIdentifier, action] of uniqueBindings) {
      let events = actionBindings.get(action);
      if (events === undefined) {
        events = [];
        actionBindings.set(action, events);
      }
      events.push(friendlyEventIdentifier(eventIdentifier));
    }
    for (const [action, events] of actionBindings) {
      const eventStr =
        events.length === 1 ? events[0] : `{${events.join(",")}}`;
      bindings.push(`${eventStr}→${action}`);
    }
    return bindings.join(", ");
  }
}

export function dispatchEventAction(
  originalEvent: Event,
  detail: any,
  eventAction: EventAction | undefined,
) {
  if (eventAction === undefined) {
    return;
  }
  if (eventAction.stopPropagation !== false) {
    originalEvent.stopPropagation();
  }
  const actionEvent = new CustomEvent("action:" + eventAction.action, {
    bubbles: true,
    detail: detail,
    cancelable: true,
  });
  const cancelled = !originalEvent.target!.dispatchEvent(actionEvent);
  if (eventAction.preventDefault !== false || cancelled) {
    originalEvent.preventDefault();
  }
}

export const eventPhaseNames: string[] = [];
eventPhaseNames[Event.AT_TARGET] = "at";
eventPhaseNames[Event.CAPTURING_PHASE] = "capture";
eventPhaseNames[Event.BUBBLING_PHASE] = "bubble";

export function dispatchEvent(
  baseIdentifier: EventIdentifier,
  originalEvent: Event,
  eventPhase: number,
  detail: any,
  eventMap: EventActionMapInterface,
) {
  const eventIdentifier = eventPhaseNames[eventPhase] + ":" + baseIdentifier;
  const eventAction = eventMap.get(eventIdentifier);
  dispatchEventAction(originalEvent, detail, eventAction);
}

export function dispatchEventWithModifiers(
  baseIdentifier: EventIdentifier,
  originalEvent: Event & EventModifierKeyState,
  detail: any,
  eventMap: EventActionMapInterface,
) {
  dispatchEvent(
    getStrokeIdentifier(baseIdentifier, getEventModifierMask(originalEvent)),
    originalEvent,
    originalEvent.eventPhase,
    detail,
    eventMap,
  );
}

/**
 * DOM Event type used for dispatching actions.
 *
 * Additional information relevant to the acction is specified as the `detail` property.
 */
export interface ActionEvent<Info> extends CustomEvent {
  detail: Info;
}

/**
 * Register an event listener for the specified `action`.
 *
 * There is no checking that the `TriggerEvent` type is suitable for use with the specified
 * `action`.
 *
 * @returns A nullary disposer function that unregisters the listener when called.
 */
export function registerActionListener<Info>(
  target: EventTarget,
  action: ActionIdentifier,
  listener: (event: ActionEvent<Info>) => void,
  options?: boolean | AddEventListenerOptions,
) {
  return registerEventListener(target, `action:${action}`, listener, options);
}
