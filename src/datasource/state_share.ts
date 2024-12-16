import { defaultCredentialsManager } from "#src/credentials_provider/default_manager.js";
import { StatusMessage } from "#src/status.js";
import { RefCounted } from "#src/util/disposable.js";
import {
  fetchSpecialOk,
  parseSpecialUrl,
} from "#src/util/special_protocol_request.js";
import type { Viewer } from "#src/viewer.js";
import { makeIcon } from "#src/widget/icon.js";

type StateServer = {
  url: string;
  default?: boolean;
};

type StateServers = {
  [name: string]: StateServer;
};

declare const STATE_SERVERS: StateServers | undefined;

export const stateShareEnabled =
  typeof STATE_SERVERS !== "undefined" && Object.keys(STATE_SERVERS).length > 0;

export class StateShare extends RefCounted {
  // call it a widget? no because it doesn't pop out?
  element = document.createElement("div");
  button = makeIcon({ text: "Share", title: "Share State" });
  selectStateServerElement?: HTMLSelectElement;

  constructor(viewer: Viewer) {
    super();

    if (typeof STATE_SERVERS === "undefined") {
      throw new Error(
        "Cannot construct StateSare without defining STATE_SERVERS",
      );
    }

    // if more than one state server, add UI so users can select the state server to use
    if (Object.keys(STATE_SERVERS).length > 1) {
      const selectEl = document.createElement("select");
      selectEl.style.marginRight = "5px";

      this.registerDisposer(
        viewer.selectedStateServer.changed.add(() => {
          const valueFromState = viewer.selectedStateServer.value;
          if (
            Object.values(STATE_SERVERS)
              .map((s) => s.url)
              .includes(valueFromState)
          ) {
            selectEl.value = valueFromState;
          }
        }),
      );

      this.registerEventListener(selectEl, "change", () => {
        viewer.selectedStateServer.value = selectEl.value;
      });

      for (const [name, stateServer] of Object.entries(STATE_SERVERS)) {
        const option = document.createElement("option");
        option.textContent = name;
        option.value = stateServer.url;
        option.selected = !!stateServer.default;
        selectEl.appendChild(option);
      }

      this.element.appendChild(selectEl);
      this.selectStateServerElement = selectEl;
    }

    this.element.appendChild(this.button);

    this.registerEventListener(this.button, "click", () => {
      const selectedStateServer = this.selectStateServerElement
        ? this.selectStateServerElement.value
        : Object.values(STATE_SERVERS)[0].url;
      const protocol = new URL(selectedStateServer).protocol;
      const { url: parsedUrl, credentialsProvider } = parseSpecialUrl(
        selectedStateServer,
        defaultCredentialsManager,
      );

      StatusMessage.forPromise(
        fetchSpecialOk(credentialsProvider, parsedUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(viewer.state.toJSON()),
        })
          .then((response) => response.json())
          .then((res) => {
            const stateUrlProtcol = new URL(res).protocol;
            const stateUrlWithoutProtocol = res.substring(
              stateUrlProtcol.length,
            );
            const link = `${window.location.origin}/#!${protocol}${stateUrlWithoutProtocol}`;
            navigator.clipboard.writeText(link).then(() => {
              StatusMessage.showTemporaryMessage(
                "Share link copied to clipboard",
              );
            });
          })
          .catch(() => {
            StatusMessage.showTemporaryMessage(
              "Could not access state server.",
              4000,
            );
          }),
        {
          initialMessage: `Posting state to ${selectedStateServer}.`,
          delay: true,
          errorPrefix: "",
        },
      );
    });
  }

  disposed() {
    this.element.remove();
    super.disposed();
  }
}
