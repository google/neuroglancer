import {bindDefaultCopyHandler, bindDefaultPasteHandler} from 'neuroglancer/ui/default_clipboard_handling';
import {setDefaultInputEventBindings} from 'neuroglancer/ui/default_input_event_bindings';
import {makeMinimalViewer} from 'neuroglancer/ui/minimal_viewer';
import {registerLayerType, registerVolumeLayerType} from 'neuroglancer/layer_specification';
import {VolumeType} from 'neuroglancer/sliceview/volume/base';

import {ImageUserLayer} from 'neuroglancer/image_user_layer';
import {SegmentationUserLayer} from 'neuroglancer/segmentation_user_layer';
// import {UrlHashBinding} from 'neuroglancer/ui/url_hash_binding';

import {DVIDDataSource} from 'neuroglancer/datasource/dvid/frontend';
import {BrainmapsDataSource, productionInstance} from 'neuroglancer/datasource/brainmaps/frontend';
import {registerProvider} from 'neuroglancer/datasource/default_provider';

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
  // image_register();
  registerLayerType('image', ImageUserLayer);
  registerVolumeLayerType(VolumeType.IMAGE, ImageUserLayer);

  // segmentation_register();
  registerLayerType('segmentation', SegmentationUserLayer);
  registerVolumeLayerType(VolumeType.SEGMENTATION, SegmentationUserLayer);

  registerProvider('dvid', () => new DVIDDataSource());

  // register_brainmaps
  if (options.brainMapsClientId) {
    const clientId: string = options.brainMapsClientId;
    defaultCredentialsManager.register(credentialsKey, () => new BrainmapsCredentialsProvider(clientId));
    registerProvider('brainmaps',
      options => new BrainmapsDataSource(
        productionInstance, options.credentialsManager.getCredentialsProvider(credentialsKey)
      )
    );
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
