import './voxel_size_selection_widget.css';

import {TrackableMIPLevelConstraints} from 'neuroglancer/trackable_mip_level_constraints';
import {TrackableValue} from 'neuroglancer/trackable_value';
import {RefCounted} from 'neuroglancer/util/disposable';
import {removeFromParent} from 'neuroglancer/util/dom';
import {vec3} from 'neuroglancer/util/geom';
import {verifyInt} from 'neuroglancer/util/json';
import {StatusMessage} from 'neuroglancer/status';

export class VoxelSizeSelectionWidget extends RefCounted {
  element = document.createElement('div');
  private minVoxelSizeElement = document.createElement('div');
  private maxVoxelSizeElement = document.createElement('div');
  private activeLevelsTextbox = document.createElement('textarea');
  private waitingToSetup = true;
  private voxelDropdownOptions: string[] = [];
  private activeMinMIPLevel?: TrackableValue<number|undefined>;

  constructor(private mipLevelConstraints: TrackableMIPLevelConstraints) {
    super();
    const header = document.createElement('div');
    header.textContent = 'Voxel size limits (nm) desired';
    header.id = 'voxelLimitsHeader';
    this.element.appendChild(header);
  }

  public setup(voxelSizePerMIPLevel: vec3[], activeMinMIPLevel: TrackableValue<number|undefined>) {
    if (this.waitingToSetup) {
      this.waitingToSetup = false;
      this.activeMinMIPLevel = activeMinMIPLevel;

      const createVoxelDropdownOptions = () => {
        voxelSizePerMIPLevel.forEach(voxelSize => {
          let i: number;
          let voxelString = '';
          for (i = 0; i < 3; i++) {
            if (i > 0) {
              voxelString += ' x ';
            }
            voxelString += voxelSize[i];
          }
          this.voxelDropdownOptions.push(voxelString);
        });
      };

      createVoxelDropdownOptions();
      this.setupUIElements();
      this.registerDisposer(activeMinMIPLevel.changed.add(this.updateActiveMinMIPLevelTextbox));
      this.registerDisposer(this.mipLevelConstraints.changed.add(this.updateActiveMinMIPLevelTextbox));
    } else {
      throw new Error('Attempt to setup voxel widget more than once');
    }
  }

  private setupUIElements() {
    const {
      element,
      minVoxelSizeElement,
      maxVoxelSizeElement,
      createVoxelSizeDropdown,
      mipLevelConstraints,
      activeLevelsTextbox,
      mipLevelConstraints: {minMIPLevel, maxMIPLevel}
    } = this;
    element.className = 'minmax-voxel-size-selection';
    minVoxelSizeElement.className = 'voxel-size-selection';
    maxVoxelSizeElement.className = 'voxel-size-selection';
    const minVoxelSizeDropdown = createVoxelSizeDropdown(true);
    const maxVoxelSizeDropdown = createVoxelSizeDropdown(false);
    const minVoxelSizeLabel = document.createElement('span');
    minVoxelSizeLabel.textContent = 'Min voxel size: ';
    minVoxelSizeLabel.className = 'voxel-size-label';
    minVoxelSizeLabel.id = 'minVoxelSizeLabel';
    const maxVoxelSizeLabel = document.createElement('span');
    maxVoxelSizeLabel.textContent = 'Max voxel size: ';
    maxVoxelSizeLabel.className = 'voxel-size-label';
    minVoxelSizeElement.appendChild(minVoxelSizeLabel);
    minVoxelSizeElement.appendChild(minVoxelSizeDropdown);
    maxVoxelSizeElement.appendChild(maxVoxelSizeLabel);
    maxVoxelSizeElement.appendChild(maxVoxelSizeDropdown);
    element.appendChild(minVoxelSizeElement);
    element.appendChild(maxVoxelSizeElement);
    const activeLevelsHeader = document.createElement('div');
    activeLevelsHeader.textContent = 'Voxel sizes loaded (nm)';
    activeLevelsHeader.id = 'activeLevelsHeader';
    const activeLevelsTextboxElement = document.createElement('div');
    element.appendChild(activeLevelsHeader);
    activeLevelsTextbox.readOnly = true;
    activeLevelsTextbox.id = 'activeLevelsTextbox';
    activeLevelsTextboxElement.appendChild(activeLevelsTextbox);
    element.appendChild(activeLevelsTextboxElement);
    this.registerDisposer(minMIPLevel.changed.add(() => {
      VoxelSizeSelectionWidget.setDropdownIndex(
          minVoxelSizeDropdown, mipLevelConstraints.getDeFactoMinMIPLevel());
    }));
    this.registerDisposer(maxMIPLevel.changed.add(() => {
      VoxelSizeSelectionWidget.setDropdownIndex(
          maxVoxelSizeDropdown, mipLevelConstraints.getDeFactoMaxMIPLevel());
    }));
  }

  private createVoxelSizeDropdown = (isMinLevelDropdown: boolean):
      HTMLSelectElement => {
        const {voxelDropdownOptions, mipLevelConstraints} = this;
        const getMIPValue = (isMinLevelDropdown) ? mipLevelConstraints.getDeFactoMinMIPLevel :
                                                   mipLevelConstraints.getDeFactoMaxMIPLevel;
        const mipLevel = (isMinLevelDropdown) ? mipLevelConstraints.minMIPLevel :
                                                mipLevelConstraints.maxMIPLevel;
        const voxelSizeDropdown = document.createElement('select');
        voxelSizeDropdown.className = 'voxel-selection-dropdown';
        voxelDropdownOptions.forEach((voxelSizeString, index) => {
          if (index === getMIPValue()) {
            voxelSizeDropdown.add(new Option(voxelSizeString, index.toString(), false, true));
          } else {
            voxelSizeDropdown.add(new Option(voxelSizeString, index.toString(), false, false));
          }
        });
        voxelSizeDropdown.addEventListener('change', () => {
          if (getMIPValue() !== voxelSizeDropdown.selectedIndex) {
            mipLevel.value = voxelSizeDropdown.selectedIndex;
          }
        });
        return voxelSizeDropdown;
      }

  private static setDropdownIndex(dropdown: HTMLSelectElement, newIndex: number) {
    if (dropdown.selectedIndex !== newIndex) {
      dropdown.selectedIndex = newIndex;
    }
  }

  private static getActiveLevelsTextboxText(
      minLevelLoaded: number, maxLevelLoaded: number, voxelDropdownOptions: string[]) {
    const minString = `Min voxel size: ${voxelDropdownOptions[minLevelLoaded]}`;
    const maxString = `Max voxel size: ${voxelDropdownOptions[maxLevelLoaded]}`;
    return minString + '\n' + maxString;
  }

  private updateActiveMinMIPLevelTextbox =
      () => {
        const {activeMinMIPLevel, mipLevelConstraints, voxelDropdownOptions} = this;
        if (activeMinMIPLevel === undefined) {
          throw new Error('Attempt to update active mip level textbox before voxel widget setup');
        }
        verifyInt(activeMinMIPLevel.value);
        const maxMIPLevelValue = mipLevelConstraints.getDeFactoMaxMIPLevel();
        if (maxMIPLevelValue < activeMinMIPLevel.value!) {
          this.activeLevelsTextbox.value = VoxelSizeSelectionWidget.getActiveLevelsTextboxText(
              activeMinMIPLevel.value!, activeMinMIPLevel.value!, voxelDropdownOptions);
          StatusMessage.showTemporaryMessage(
              `Desired voxel limits not visible, showing highest visible resolution, which is ${
                  voxelDropdownOptions[activeMinMIPLevel.value!]}`,
              9000);
        } else {
          this.activeLevelsTextbox.value = VoxelSizeSelectionWidget.getActiveLevelsTextboxText(
              activeMinMIPLevel.value!, maxMIPLevelValue, voxelDropdownOptions);
        }
      }

  disposed() {
    removeFromParent(this.element);
    super.disposed();
  }
}
