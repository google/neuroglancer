import 'neuroglancer/differ/differ.css';

import {diff_match_patch} from 'diff-match-patch';
import {Dialog} from 'neuroglancer/dialog';
import {getCachedJson, Trackable} from 'neuroglancer/util/trackable';
import {Viewer} from 'neuroglancer/viewer';

const diff = new diff_match_patch();
export class Differ {
  saveRedo = false;
  applyRedo = false;
  max = 100;
  stack: StateChange[] = [];
  reverseStack: StateChange[] = [];

  constructor(public root: Trackable, public legacy?: Viewer) {}
  public record(oldState: any, newState: any) {
    // TODO: Differ does not work with legacy saving
    if (oldState === undefined || newState === undefined || this.legacy) {
      return true;
    }

    const oldSerial = this.legacy ? oldState : JSON.stringify(oldState);
    const newSerial = this.legacy ? newState : JSON.stringify(newState);
    const stateChange = oldSerial !== newSerial;

    if (stateChange) {
      const patch = diff.patch_toText(diff.patch_make(oldSerial, newSerial));
      const timestamp = (new Date()).valueOf();
      const change = 'Change';
      const entry = <StateChange>{patch, timestamp, change};
      if (this.reverseStack.length && !this.saveRedo && !this.applyRedo) {
        // do not clear reverse stack if applied redo or undo
        this.reverseStack = [];
      }
      if (this.saveRedo) {
        this.saveRedo = false;
        this.reverseStack.push(entry);
      } else {
        this.stack.push(entry);
      }
      if (this.applyRedo) {
        this.applyRedo = false;
      }
    }
    this.setRollStatus();
    return stateChange;
  }
  public rollback() {
    this.apply();
  }
  public rollforward() {
    this.apply(false);
  }
  public showChanges(viewer: Viewer) {
    new DiffDialog(viewer, this);
  }
  private setRollStatus() {
    const undo = document.getElementById('neuroglancer-undo-button');
    const redo = document.getElementById('neuroglancer-redo-button');
    this.modifyStatus(undo, this.stack.length, '⬅️', '⇦', 'undo');
    this.modifyStatus(redo, this.reverseStack.length, '➡️', '⇨', 'redo');
  }
  private modifyStatus(
      element: HTMLElement|null, status: number, enabled: string, disabled: string, name: string) {
    if (!element) {
      return;
    }
    element.classList.toggle('disabled', !status);
    element.innerText = status ? enabled : disabled;
    element.title =
        status ? `${status} ${name}${status > 1 ? 's' : ''} avaliable` : `Nothing to ${name}`;
  }
  private apply(rollback = true) {
    const target = rollback ? this.stack : this.reverseStack;
    const lastPatch = target.pop();
    // TODO: Differ does not work with legacy saving
    if (!lastPatch || this.legacy) {
      // Cancel apply if no patch to apply
      return;
    }
    if (rollback) {
      // Tell save diff that next state change is a rollback/undo
      // save it in the reverse stack
      this.saveRedo = true;
    } else {
      this.applyRedo = true;
    }
    let restoreFromPatch;
    if (!this.legacy) {
      const currentState = JSON.stringify(this.root.toJSON());
      const patchfromText = diff.patch_fromText(lastPatch.patch!);
      restoreFromPatch = diff.patch_apply(patchfromText, currentState);
      /* deactivate so that state change triggered by updating
      the state w/ a rollback doesn't affect state history*/
    } else {
      // If in Legacy mode update URL instead
      const cacheState = getCachedJson(this.root);

      const currentStateString = JSON.stringify(cacheState.value);
      const patchfromText = diff.patch_fromText(lastPatch.patch!);
      restoreFromPatch = diff.patch_apply(patchfromText, currentStateString);
    }
    this.root.restoreState(JSON.parse(restoreFromPatch[0]));
  }
}

class DiffDialog extends Dialog {
  constructor(public viewer: Viewer, public diffSrc: Differ) {
    super(viewer);
    let {modal, table} = this;
    let {stack, reverseStack} = diffSrc;
    let changeCount = diffSrc.stack.length + diffSrc.reverseStack.length;
    if (changeCount) {
      reverseStack.forEach(this.addTableEntry.bind(this));
      this.addTableEntry({patch: null, timestamp: (new Date()).valueOf(), change: 'Current'});
      stack.forEach(this.addTableEntry.bind(this));

      if (!table.children.length) {
        modal.append(document.createElement('br'), `There is nothing to undo/redo.`);
      }
    } else {
      this.dispose();
    }
  }

  private addTableEntry(entry: StateChange) {
    if (!entry) {
      return;
    }
    const row = this.tableEntry();
    const date = document.createElement('td');
    const link = document.createElement('td');
    const linkAnchor = document.createElement('a');

    date.innerText = (new Date(entry.timestamp)).toLocaleString();
    linkAnchor.innerText = `${entry.change}`;
    // linkAnchor.href = linkAnchor.innerText;
    linkAnchor.style.display = 'block';
    linkAnchor.onclick = () => {};
    link.append(linkAnchor);
    row.append(date, link);
    if (entry.patch === null) {
      row.classList.add('ng-differ-current');
    }
  }

  public clearHandler() {
    this.diffSrc.stack = [];
    this.diffSrc.reverseStack = [];
    this.dispose();
  }
}

interface StateChange {
  patch: string|null;
  change: string;
  timestamp: number;
}
