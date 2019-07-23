import {Overlay} from 'neuroglancer/overlay';
import {Viewer} from 'neuroglancer/viewer';

require('./whats_new.css');

const generateWhatsNew = (GHCommits: string[] = []) => {
  let WNCommits = JSON.parse(localStorage.getItem('WNCommits') || '[]');
  let newCommits =
      (GHCommits.length) ? GHCommits.slice(0, GHCommits.length - WNCommits.length) : WNCommits;

  if (!newCommits.length) {
    newCommits.push('');
  }

  let currentDes = (require('../../../WHATS_NEW.md')) || '';
  let description: string = `<ul>${newCommits.reduce((acc: string, cur: any, i: number) => {
    return `${acc}\n<li><h4>${(cur.commit) ? cur.commit.message : ''}</h4>\n${
    !i ? `${currentDes}` :
         `<a target="_blank" href='https://github.com/seung-lab/neuroglancer/blob/${
             cur.sha}/whats_new.md'>More...</a>`}</li>`;
  }, '')}</ul>`;
  return description;
};

export const findWhatsNew = async (viewer: Viewer) => {
  let url =
          `https://script.google.com/macros/s/AKfycbzVt6TLlJonmfU0EKTZVthi9pbM9dY1TYfTIH985tLUc8TZ5BNG/exec`,
      WNCommits = JSON.parse(localStorage.getItem('WNCommits') || '[]'), headers = {
        'Content-Type': 'text/plain;charset=utf-8',
      },
      body = JSON.stringify({
        path: 'WHATS_NEW.md'
        // since: (WNCommits.length) ? WNCommits[0].commit.author.date : void(0)
      });

  let GHRes = await fetch(url, {method: 'post', headers, body});
  let GHCommits = JSON.parse(await GHRes.json());

  if (GHCommits.length < WNCommits.length) {
    // commits do not disappear, unless using the since parameter GHCommits should only be <=
    // WNCommits
    localStorage.removeItem('WNCommits');
  }

  if (GHCommits.length > WNCommits.length) {
    let description = generateWhatsNew(GHCommits);
    localStorage.setItem('WNCommits', JSON.stringify(GHCommits));
    return new WhatsNewDialog(viewer, description);
  }
  return false;
};

export class WhatsNewDialog extends Overlay {
  constructor(public viewer: Viewer, description: string = '') {
    super();
    let {content} = this;

    if (!description.length) {
      description = generateWhatsNew();
    }

    let modal = document.createElement('div');

    content.appendChild(modal);

    let header = document.createElement('h3');
    header.textContent = `What's New`;
    modal.appendChild(header);

    let body = document.createElement('p');
    body.innerHTML = description;
    modal.appendChild(body);

    let okBtn = document.createElement('button');
    okBtn.textContent = 'Ok';
    okBtn.onclick = () => this.dispose();

    modal.appendChild(okBtn);
    modal.onblur = () => this.dispose();
    modal.focus();
  }
}
