import "#src/datasource/state_share.css";
import { ReadableHttpKvStore } from "#src/kvstore/http/common.js";
import { joinBaseUrlAndPath } from "#src/kvstore/url.js";
import { StatusMessage } from "#src/status.js";
import { WatchableValue } from "#src/trackable_value.js";
import { encodeFragment } from "#src/ui/url_hash_binding.js";
import { RefCounted } from "#src/util/disposable.js";
import { removeFromParent } from "#src/util/dom.js";
import { positionRelativeDropdown } from "#src/util/dropdown.js";
import { bigintToStringJsonReplacer } from "#src/util/json.js";
import { getCachedJson } from "#src/util/trackable.js";
import type { Viewer } from "#src/viewer.js";
import { makeIcon } from "#src/widget/icon.js";

type StateServer = {
  url: string;
  default?: boolean;
};

type StateServers = {
  [name: string]: StateServer;
};

const STATE_SERVERS: StateServers | undefined = {
  cave: {
    url: "middleauth+https://global.daf-apis.com/nglstate/api/v1/post",
    default: true,
  },
  cave2: {
    url: "middleauth+https://global.daf-apis.com/nglstate/api/v1/post",
    default: true,
  },
};
export const stateShareEnabled =
  typeof STATE_SERVERS !== "undefined" && Object.keys(STATE_SERVERS).length > 0;

export class StateShare extends RefCounted {
  element = document.createElement("div");
  button = makeIcon({ text: "Share", title: "Share State" });

  stateServers: StateServers = STATE_SERVERS ?? ({} as StateServers);

  countElement = document.createElement("div");
  dropdownVisible = new WatchableValue<boolean>(false);
  dropdown: MultiStateShareDropdown | undefined;

  private defaultStateServer_: StateServer | undefined;

  get state() {
    return this.viewer.state;
  }

  get stateJSON() {
    return JSON.stringify(
      getCachedJson(this.state).value,
      bigintToStringJsonReplacer,
    );
  }

  get defaultStateServer(): StateServer | undefined {
    return this.defaultStateServer_;
  }

  set defaultStateServer(newDefault: StateServer) {
    this.defaultStateServer_ = newDefault;
    for (const stateServer of Object.values(this.stateServers)) {
      stateServer.default = stateServer === newDefault;
    }
  }

  shareStateServer(override?: StateServer) {
    const { viewer, stateJSON, defaultStateServer } = this;
    const stateServerUrl = (override ?? defaultStateServer)?.url;
    if (!stateServerUrl) return;
    const { store, path } =
      viewer.dataSourceProvider.sharedKvStoreContext.kvStoreContext.getKvStore(
        stateServerUrl,
      );
    if (!(store instanceof ReadableHttpKvStore)) {
      throw new Error(`Non-HTTP protocol not supported: ${stateServerUrl}`);
    }
    StatusMessage.forPromise(
      store
        .fetchOkImpl(joinBaseUrlAndPath(store.baseUrl, path), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: stateJSON,
        })
        .then((response) => response.json())
        .then((res) => {
          const stateUrlProtcol = new URL(res).protocol;
          const stateUrlWithoutProtocol = res.substring(stateUrlProtcol.length);
          const protocol = new URL(stateServerUrl).protocol;
          const link = `${window.location.origin}/#!${protocol}${stateUrlWithoutProtocol}`;
          history.replaceState(
            null,
            "",
            "#!" + `${protocol}${stateUrlWithoutProtocol}`,
          );
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
        initialMessage: `Posting state to ${stateServerUrl}.`,
        delay: true,
        errorPrefix: "",
      },
    );
  }

  shareUrl() {
    const { stateJSON } = this;
    const encodedStateString = encodeFragment(stateJSON);
    if (decodeURIComponent(encodedStateString) === "{}") {
      history.replaceState(null, "", "#");
    } else {
      history.replaceState(null, "", "#!" + encodedStateString);
    }
    navigator.clipboard.writeText(window.location.href).then(() => {
      StatusMessage.showTemporaryMessage("Share link copied to clipboard");
    });
  }

  constructor(private viewer: Viewer) {
    super();
    const { element, stateServers } = this;
    element.classList.add("neuroglancer-state-share-button");
    element.classList.add("neuroglancer-sticky-focus");
    this.button.classList.add("state-share");
    element.tabIndex = -1;
    // default to first state server marked as default
    for (const stateServer of Object.values(stateServers)) {
      if (!this.defaultStateServer && stateServer.default) {
        this.defaultStateServer = stateServer;
      } else {
        stateServer.default = false;
      }
    }
    // if no default state server, default to first
    if (stateServers.length && !this.defaultStateServer) {
      this.defaultStateServer = Object.values(stateServers)[0];
    }
    const serverCount = Object.keys(stateServers).length;
    element.appendChild(this.button);
    this.registerEventListener(this.button, "click", () => {
      if (serverCount > 0) {
        this.shareStateServer();
      } else {
        this.shareUrl();
      }
    });
    // if there are state servers, right click becomes share url
    if (serverCount > 0) {
      this.registerEventListener(this.button, "contextmenu", () => {
        this.dropdownVisible.value = !this.dropdownVisible.value;
      });
    }
    this.dropdownVisible.changed.add(() => {
      const visible = this.dropdownVisible.value;
      if (!visible) {
        this.dropdown?.dispose();
        this.dropdown = undefined;
      } else {
        if (this.dropdown === undefined) {
          this.dropdown = new MultiStateShareDropdown(this);
          element.appendChild(this.dropdown.element);
          positionRelativeDropdown(this.dropdown.element, this.element);
        }
      }
    });
    element.addEventListener("focusout", (event) => {
      const { relatedTarget } = event;
      if (relatedTarget instanceof Node && !element.contains(relatedTarget)) {
        this.dropdownVisible.value = false;
      }
    });
  }

  disposed() {
    this.element.remove();
    this.dropdown?.dispose();
    super.disposed();
  }
}

class StateServerListDropdownItem {
  element = document.createElement("li");
  constructor(name: string, stateServer: StateServer) {
    const { element } = this;
    element.classList.add("neuroglancer-state-share-dropdown-item");
    element.innerHTML = `<span>Upload to ${name}</span><span>[${stateServer.url}]</span>`;
    if (stateServer.default) {
      const defaultStatus = document.createElement("span");
      defaultStatus.innerHTML += "<span>(default)</span>";
      element.appendChild(defaultStatus);
    } else {
      const makeDefaultButton = document.createElement("button");
      makeDefaultButton.textContent = "make default";
      element.appendChild(makeDefaultButton);
      makeDefaultButton.addEventListener("click", (evt) => {
        evt.stopPropagation();
        element.dispatchEvent(new Event("setdefault"));
      });
    }
  }
}

export class MultiStateShareDropdown extends RefCounted {
  element = document.createElement("div");
  itemContainer = document.createElement("ul");
  cannedItemSeparator = document.createElement("li");
  constructor(private stateShare: StateShare) {
    super();
    const { element, itemContainer, cannedItemSeparator } = this;
    element.classList.add("neuroglancer-state-share-dropdown");
    element.appendChild(itemContainer);
    cannedItemSeparator.classList.add(
      "neuroglancer-state-share-dropdown-separator",
    );
    this.updateView();
  }

  updateView() {
    const { stateShare, cannedItemSeparator } = this;
    this.itemContainer.replaceChildren();
    const { stateServers } = stateShare;
    const shareToUrl = document.createElement("li");
    shareToUrl.addEventListener("click", stateShare.shareUrl);
    shareToUrl.classList.add("neuroglancer-state-share-dropdown-item");
    shareToUrl.textContent = "Copy as URL";
    this.itemContainer.appendChild(shareToUrl);
    this.itemContainer.appendChild(cannedItemSeparator);
    for (const [name, stateServer] of Object.entries(stateServers)) {
      const item = new StateServerListDropdownItem(name, stateServer);
      item.element.addEventListener("setdefault", () => {
        stateShare.defaultStateServer = stateServer;
        this.updateView();
        // TODO, make defaultStateServer a watchable value
      });
      this.itemContainer.appendChild(item.element);
      item.element.addEventListener("click", () => {
        stateShare.shareStateServer(stateServer);
      });
    }
  }

  disposed() {
    super.disposed();
    removeFromParent(this.element);
  }
}
