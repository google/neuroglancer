import {Overlay} from 'neuroglancer/overlay';
import {Viewer} from 'neuroglancer/viewer';

export class Dialog extends Overlay {
  table = document.createElement('table');
  modal = document.createElement('div');
  constructor(public viewer: Viewer) {
    super();
    let {content, table} = this;
    let modal = this.modal;
    content.appendChild(modal);

    table.classList.add('ng-zebra-table');

    const clear = document.createElement('button');
    clear.innerText = 'Clear';
    clear.title = 'Remove all saved states.';
    clear.addEventListener('click', this.clearHandler.bind(this));

    modal.append(clear);
    modal.append(table);
    modal.onblur = () => this.dispose();
    modal.focus();
  }

  public tableEntry() {
    const row = document.createElement('tr');
    this.table.append(row);
    return row;
  }
  public clearHandler() {}
}
