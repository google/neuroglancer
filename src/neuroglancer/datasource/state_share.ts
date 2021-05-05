import { RefCounted } from "neuroglancer/util/disposable";
import { defaultCredentialsManager } from "neuroglancer/credentials_provider/default_manager";
import { StatusMessage } from "neuroglancer/status";
import { responseJson } from "neuroglancer/util/http_request";
import { cancellableFetchSpecialOk, parseSpecialUrl } from "neuroglancer/util/special_protocol_request";
import { Viewer } from "neuroglancer/viewer";
import { makeIcon } from "neuroglancer/widget/icon";

type StateServer = {
  url: string, default?: boolean
}

type StateServers = {
  [name: string]: StateServer
};
  
declare const STATE_SERVERS: StateServers|undefined;

export const stateShareEnabled = typeof STATE_SERVERS !== 'undefined' && Object.keys(STATE_SERVERS).length > 0;

export class StateShare extends RefCounted { // call it a widget? no because it doesn't pop out?
  element = document.createElement('div');
  button = makeIcon({text: 'Share', title: 'Share State'});
  selectStateServerElement?: HTMLSelectElement;
  
  constructor(viewer: Viewer) {
    super();

    if (typeof STATE_SERVERS === 'undefined') {
      throw new Error("Cannot construct StateSare without defining STATE_SERVERS");
    }

    // if more than one state server, add UI so users can select the state server to use
    if (Object.keys(STATE_SERVERS).length > 1) {
      const selectEl = document.createElement('select');
      selectEl.style.marginRight = '5px';

      this.registerDisposer(viewer.selectedStateServer.changed.add(() => {
        const valueFromState = viewer.selectedStateServer.value;
        if (Object.values(STATE_SERVERS).map((s) => s.url).includes(valueFromState)) {
          selectEl.value = valueFromState;
        }
      }));

      this.registerEventListener(selectEl, 'change', () => {
        viewer.selectedStateServer.value = selectEl.value;
      });

      for (let [name, stateServer] of Object.entries(STATE_SERVERS)) {
        const option = document.createElement('option');
        option.textContent = name;
        option.value = stateServer.url;
        option.selected = !!stateServer.default;
        selectEl.appendChild(option);
      }

      this.element.appendChild(selectEl);
      this.selectStateServerElement = selectEl;
    }

    this.element.appendChild(this.button);

    this.registerEventListener(this.button, 'click', () => {
      const selectedStateServer = this.selectStateServerElement ? this.selectStateServerElement.value : Object.values(STATE_SERVERS)[0].url;
      const protocol = new URL(selectedStateServer).protocol;
      const {url: parsedUrl, credentialsProvider} = parseSpecialUrl(selectedStateServer, defaultCredentialsManager);

      StatusMessage.forPromise(
        cancellableFetchSpecialOk(credentialsProvider, parsedUrl, {
              method: 'POST',
              headers: {'Content-Type': 'application/json'},
              body: JSON.stringify(viewer.state.toJSON())
            }, responseJson)
          .then((res) => {
            const stateUrl = new URL(res);
            stateUrl.protocol = protocol; // copy protocol in case it contains authentication type
            const link = `${window.location.origin}/#!${stateUrl}`;
            navigator.clipboard.writeText(link).then(() => {
              StatusMessage.showTemporaryMessage('Share link copied to clipboard');
            });
          })
          .catch(() => {
            StatusMessage.showTemporaryMessage(`Could not access state server.`, 4000);
          }),
        {
          initialMessage: `Posting state to ${selectedStateServer}.`,
          delay: true,
          errorPrefix: ''
        });
      });
  }

  disposed() {
    this.element.remove();
    super.disposed();
  }
}
