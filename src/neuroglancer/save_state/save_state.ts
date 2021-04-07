import 'neuroglancer/save_state/save_state.css';

import {Overlay} from 'neuroglancer/overlay';
import {StatusMessage} from 'neuroglancer/status';
// import {RefCounted} from 'neuroglancer/util/disposable';
// import {getRandomHexString} from 'neuroglancer/util/random';
// import {Trackable} from 'neuroglancer/util/trackable';
import {Viewer} from 'neuroglancer/viewer';

/*form: HTMLElement, popupID?: string, content?:
string, textId?: string, disabled = false, fieldTitle = '', btnName?: string, btnTitle?: string,
btnAct?: EventListener, btnClass?: string, readonly = true, newLine = true */
type FieldConfig = {
  form: HTMLElement,
  content?: string,
  textId?: string,
  disabled?: boolean,
  fieldTitle?: string,
  btnName?: string,
  btnTitle?: string,
  btnAct?: EventListener,
  btnClass?: string,
  readonly?: boolean,
  newLine?: boolean,
  placeholder?: string,
};

export class SaveDialog extends Overlay {
  constructor(public viewer: Viewer, jsonString?: string) {
    super();

    let {content} = this;
    content.style.overflow = 'visible';

    content.classList.add('shareOverlay');

    const title = document.createElement('h2');
    title.innerText = 'Share';

    const viewSimple = document.createElement('div');
    viewSimple.classList.add('inputAndButton');

    const hasStateServer = viewer.jsonStateServer.value.length > 0;

    content.classList.toggle('hasStateServer', hasStateServer);

    if (hasStateServer) {
      const content = jsonString && `${window.location.origin}${window.location.pathname}#${jsonString}`;
      this.insertField({
        form: viewSimple,
        content,
        textId: 'neuroglancer-save-state-json',
        disabled: jsonString === undefined,
        fieldTitle:
            'This link points to a location where the state is saved with a server defined in "Advanced Options"',
        btnName: 'Copy',
        btnTitle: 'CTRL + SHIFT + J',
        btnClass: 'copy_button',
        placeholder: 'State Server Inaccessible'
      });
    }

    const viewAdvanc = document.createElement('div');
    {
      viewAdvanc.classList.toggle('ng-hidden', jsonString !== undefined);

      viewAdvanc.classList.add('inputAndButton');

      const stateServerActionName = hasStateServer ? 'Change State Server' : 'Set State Server';

      this.insertLabel(viewAdvanc, stateServerActionName, 'neuroglancer-save-state-linkshare');
      this.insertField({
        form: viewAdvanc,
        content: viewer.jsonStateServer.value,
        textId: 'neuroglancer-save-state-linkshare',
        fieldTitle: '',
        readonly: false,
        btnName: 'Update',
        btnTitle: 'Push to state server to get JSON URL.',
        btnAct: () => {
          const field =
              <HTMLInputElement>document.getElementById('neuroglancer-save-state-linkshare');
          const fieldBtn = <HTMLButtonElement>document.getElementById(
              'neuroglancer-save-state-linkshare-button');
          console.log('value', field ? field.value : '');
          viewer.jsonStateServer.value = field ? field.value : '';
          if (viewer.jsonStateServer.value && fieldBtn) {
            fieldBtn.disabled = true;
            viewer.postJsonState().then(() => {
              try {
                this.dispose();
              } catch {}
            });

          }
        },
        btnClass: 'shorten_button'
      });
    }

    content.append(title, viewSimple, viewAdvanc);
  }

  private insertField(config: FieldConfig) {
    const {form} = config;
    let {content, textId, fieldTitle, disabled} = config;
    let {btnName, btnTitle, btnAct, btnClass} = config;
    let {readonly} = config;
    let {placeholder} = config;

    let text = document.createElement('input');
    text.readOnly = readonly === undefined ? true : readonly;
    text.type = 'text';
    text.value = content || '';
    text.size = 45;
    text.disabled = !!disabled;
    text.title = fieldTitle || '';
    text.classList.add('rounded-input');
    text.classList.toggle('disabled', !!disabled);

    if (placeholder) {
      text.placeholder = placeholder;
    }

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = btnClass || '';
    btn.classList.toggle('disabled', !!disabled);
    btn.disabled = !!disabled;
    if (btnAct && !disabled) {
      btn.addEventListener('click', btnAct);
    }
    btn.innerText = btnName || '';
    btn.title = btnTitle || '';

    if (textId) {
      text.id = textId;
      btn.id = `${text.id}-button`;
    }

    if (btnName && !btnAct) {
      btn.addEventListener('click', () => {
        text.select();
        document.execCommand('copy');
        StatusMessage.showTemporaryMessage('Link copied to clipboard');
      });
    }
    form.append(text, btn);
  }

  private insertLabel(form: HTMLElement, label: string, targetId: string, newLine = true) {
    let labelElement = document.createElement('label');
    labelElement.innerText = label;
    labelElement.htmlFor = targetId;
    form.append(labelElement, newLine ? document.createElement('br') : '');
  }
}
