import {bindDefaultCopyHandler, bindDefaultPasteHandler} from 'neuroglancer/ui/default_clipboard_handling';
import {setDefaultInputEventBindings} from 'neuroglancer/ui/default_input_event_bindings';
import {makeMinimalViewer} from 'neuroglancer/ui/minimal_viewer';
// import {UrlHashBinding} from 'neuroglancer/ui/url_hash_binding';

import 'neuroglancer/datasource/dvid/register_credentials_provider';
import 'neuroglancer/datasource/dvid/register_default';
import 'neuroglancer/datasource/brainmaps/register_default';
import 'neuroglancer/datasource/precomputed/register_default';
import 'neuroglancer/segmentation_user_layer';
import 'neuroglancer/image_user_layer';

import {defaultCredentialsManager} from 'neuroglancer/credentials_provider/default_manager';
import {credentialsKey} from 'neuroglancer/datasource/brainmaps/api';
import {BrainmapsCredentialsProvider} from 'neuroglancer/datasource/brainmaps/credentials_provider';


/**
 * Sets up the default neuroglancer viewer.
 */
// TODO: options here could enable or disable datasources.

// TODO: need to check for webGL2 support
// const gl = document.createElement('canvas').getContext('webgl2');
// if (!gl) {
//   console.log('your browser/OS/drivers do not support WebGL2');
// } else {
//   console.log('webgl2 works!');
// }

export function setupDefaultViewer(options: {
  brainMapsClientId: string | undefined,
  target: HTMLElement | undefined,
  bundleRoot: string | undefined
}) {
  // register_brainmaps
  if (options.brainMapsClientId) {
    const clientId: string = options.brainMapsClientId;
    defaultCredentialsManager.register(credentialsKey, () => new BrainmapsCredentialsProvider(clientId));
  }

  let viewer = makeMinimalViewer({ bundleRoot: options.bundleRoot }, options.target);
  setDefaultInputEventBindings(viewer.inputEventBindings);

  /* const hashBinding = viewer.registerDisposer(new UrlHashBinding(viewer.state));
  viewer.registerDisposer(hashBinding.parseError.changed.add(() => {
    const {value} = hashBinding.parseError;
    if (value !== undefined) {
      const status = new StatusMessage();
      status.setErrorMessage(`Error parsing state: ${value.message}`);
      console.log('Error parsing state', value);
    }
    hashBinding.parseError;
  }));
  hashBinding.updateFromUrlHash(); */

  bindDefaultCopyHandler(viewer);
  bindDefaultPasteHandler(viewer);

  return viewer;
}

export default class Neuroglancer {
  version() {
    return '0.0.1';
  }
}
