import {Overlay} from 'neuroglancer/overlay';
import {Viewer} from 'neuroglancer/viewer';

// TODO: css
// import 'neuroglancer/user_report/user_report.css';

interface LooseObject {
  [key: string]: any;
}
interface InputConfig {
  placeholder?: string;
  required?: boolean;
  onblur?: ((this: GlobalEventHandlers, ev: FocusEvent) => any)|null;
  type?: string;
}
interface ItemConfig {
  type?: string;
  id?: string;
  className?: string;
}

const br = () => document.createElement('br');
const simpleItem =
    (value: string, config: ItemConfig = {
      type: 'checkbox'
    },
     checked?: boolean) => {
      const chkbox = document.createElement('input');
      const {id, className, type} = config;

      if (id) {
        chkbox.id = id;
      }
      if (className) {
        chkbox.className += className;
      }
      chkbox.value = value;
      chkbox.type = type || 'checkbox';

      if (type === 'radio') {
        chkbox.name = className || id || '';
      }

      if (checked) {
        chkbox.checked = true;
      }

      return chkbox;
    };
const isVerifier = (s: string, reg: RegExp) => {
  let match = s.match(reg);

  if (match) {
    return match[0] === s;
  }
  return false;
};
const isAlphaWithSpace = (s: string) => isVerifier(s, /[a-zA-Z][a-zA-Z .']+/g);
const isAlphaNumWithSpace = (s: string) => isVerifier(s, /[a-zA-Z\d][a-zA-Z\d .'&]+/g);
const genRow = (elements: (HTMLElement|string)[]) => {
  let parent = document.createElement('tr');

  for (let element of elements) {
    let child = document.createElement('td');
    child.append(element);
    parent.appendChild(child);
  }
  return parent;
};
const simpleSelect = (id: string, options: [string, string][]) => {
  let select = document.createElement('select');
  select.id = id;

  for (let opt of options) {
    let option = document.createElement('option');
    option.value = opt[0];
    option.innerText = opt[1];
    select.appendChild(option);
  }
  return select;
};

export class UserReportDialog extends Overlay {
  constructor(public viewer: Viewer, img: string = '') {
    super();
    let {content} = this;
    this.image = img;

    const labelWrap = (label: string, element?: (HTMLElement|string)[]) => {
      const labelElement = document.createElement('label');

      labelElement.textContent = label;
      if (element) {
        element.map(e => labelElement.append(e));
      }
      modal.appendChild(labelElement);
      modal.appendChild(br());
      modal.appendChild(br());
    };

    const simpleInput = (label: string, id: string, config?: InputConfig) => {
      const textbox = document.createElement('input');
      let req = document.createElement('span');

      textbox.id = id;
      if (config) {
        textbox.placeholder = config.placeholder || '';
        if (config.required) {
          req.textContent = '*';
          req.style.color = ' red';
          textbox.setAttribute('required', '');
          this.complete[label] = false;
        }
        if (config.onblur) {
          textbox.onblur = config.onblur;
        }
      }
      textbox.onfocus = () => textbox.setAttribute('oldVal', textbox.value);
      textbox.setAttribute('sName', label);
      textbox.type = 'text';
      labelWrap(label, [req, ' ', textbox]);
    };
    const unDisable = () => {
      if (submit) {
        if (Object.values(this.complete).every(b => b)) {
          submit.disabled = false;
        } else {
          submit.disabled = true;
        }
      }
    };
    const genericBlur = (e: Event) => {
      let self: HTMLInputElement = <HTMLInputElement>e.target;
      let label = self.getAttribute('sName') || '';
      self.value = self.value.trim();
      let valid =
          (label === 'Title') ? isAlphaNumWithSpace(self.value) : isAlphaWithSpace(self.value);

      if (valid) {
        this.complete[label] = true;
      } else if (!self.value.length) {
        this.complete[label] = false;
      } else {
        self.value = self.getAttribute('oldVal') || '';
      }
      unDisable();
    };

    let modal = document.createElement('div');
    content.appendChild(modal);
    let header = document.createElement('h3');
    header.textContent = 'Send Feedback';
    modal.appendChild(header);
    let disclaimer = document.createElement('p');
    let warning = document.createElement('span');
    let reminder = document.createElement('span');
    warning.style.color = 'red';
    warning.innerText = `Do NOT post any sensitive information.\nThis report will be PUBLIC!`;
    disclaimer.appendChild(warning);

    let lastIssue = localStorage.getItem('lastIssue');
    if (lastIssue) {
      reminder.innerHTML =
          `Please do not post duplicate reports.<br>Your previous report is <a href='${
              lastIssue}'>here</a>.`;
      disclaimer.appendChild(br());
      disclaimer.appendChild(reminder);
    }
    modal.appendChild(disclaimer);

    simpleInput('Name', 'form_name', {required: true, onblur: genericBlur});

    let issueTypeConfig = {type: 'checkbox', className: 'form_type'};
    labelWrap('Issue Type', [
      br(), simpleItem('1', issueTypeConfig), ' Bug ', simpleItem('2', issueTypeConfig),
      ' Suggestion'
    ]);

    simpleInput('Title', 'form_title', {required: true, onblur: genericBlur});

    let description = document.createElement('textarea'), asterisk = document.createElement('span');
    description.id = 'form_des';
    description.placeholder = `Well, we're waiting...`;
    description.setAttribute('required', '');
    description.onblur = (e: Event) => {
      let self: HTMLInputElement = <HTMLInputElement>e.target;
      let valid = self.value.length;

      if (valid) {
        this.complete['description'] = true;
      } else {
        this.complete['description'] = false;
      }
      unDisable();
    };
    description.rows = 5;
    description.cols = 40;
    asterisk.textContent = '*';
    asterisk.style.color = ' red';
    this.complete.description = false;
    labelWrap('Description', [asterisk, br(), description]);

    // TODO: Auto detect environment, nice extra not really necessary
    let envTable = document.createElement('table');
    let osRow = genRow([
      'OS: ',
      simpleSelect(
          'form_os', [['Linux', 'Linux'], ['Mac OS X', 'Mac OS X'], ['Windows', 'Windows']])
    ]);
    let brwRow = genRow([
      'Browser: ',
      simpleSelect('form_brw', [['Chrome', 'Chrome'], ['Firefox', 'Firefox'], ['Safari', 'Safari']])
    ]);
    envTable.appendChild(osRow);
    envTable.appendChild(brwRow);
    labelWrap('Environment', [br(), envTable]);

    labelWrap('Extra Data', [
      br(), simpleItem('', {id: 'form_shot'}), ' Submit Screenshot', br(),
      simpleItem('', {id: 'form_surl'}), ' Submit Url Address', br()
    ]);
    if (!viewer.jsonStateServer.value) {
      (<HTMLInputElement>document.getElementById('form_surl')).disabled = true;
    }
    let submit = document.createElement('input');
    submit.id = 'complain';
    submit.type = 'submit';
    submit.disabled = true;
    submit.onclick = (e) => {
      if (!(<HTMLInputElement>e.target).disabled) {
        this.submit();
      }
    };
    modal.appendChild(submit);
  }

  image = '';
  complete: LooseObject = {};
  async submit() {
    let url =
            `https://script.google.com/macros/s/AKfycbzmPIJMb9z_o0_2vFdNeTIgrur_b_2tFO2A3pP9w9r7RVzub5E/exec`,
        img = <HTMLInputElement>document.querySelector('#form_shot'),
        image = (img && img.checked) ? this.image : '', headers = {
          'Content-Type': 'text/plain;charset=utf-8',
        },
        body = JSON.stringify({
          name: (<HTMLInputElement>document.querySelector('#form_name')).value,
          type: Array.from(document.querySelectorAll('.form_type'))
                    .map(
                        e => parseInt((<HTMLInputElement>e).value, 10) *
                            Number((<HTMLInputElement>e).checked))
                    .reduce((a, c) => a + c),

          des: encodeURIComponent((<HTMLInputElement>document.querySelector('#form_des')).value),
          title: (<HTMLInputElement>document.querySelector('#form_title')).value,
          image,
          os: (<HTMLInputElement>document.querySelector('#form_os')).value,
          brw: (<HTMLInputElement>document.querySelector('#form_brw')).value,
          surl: ((<HTMLInputElement>document.querySelector('#form_surl')).checked &&
                 this.viewer.jsonStateServer.value) ?
              window.location.href :
              0
        });

    this.dispose();

    try {
      let response = await fetch(url, {method: 'post', headers, body});
      let ghData = JSON.parse(await response.json());
      localStorage.setItem('lastIssue', ghData.html_url);
      alert(`Feedback received!\nYour report is posted here:\n${ghData.html_url}`);
    } catch (e) {
      alert('Ruh roh :(\n' + e);
      throw (e);
    }
  }
}
