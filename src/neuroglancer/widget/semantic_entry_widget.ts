
import {RefCounted} from 'neuroglancer/util/disposable';
import {removeFromParent} from 'neuroglancer/util/dom';
import {Uint64} from 'neuroglancer/util/uint64';
import {Signal} from 'signals';
import {SegmentationDisplayState} from 'neuroglancer/segmentation_display_state/frontend';
import {StatusMessage} from 'neuroglancer/status';

require('neuroglancer/noselect.css');
require('./semantic_entry_widget.css');

type ItemElement = HTMLButtonElement;


export class SemanticEntryWidget extends RefCounted {

  get segmentColorHash() { return this.displayState.segmentColorHash; }

  element = document.createElement('div');
  semanticUpdated = new Signal();
  input: any;
  ul: any;
  private items = new Array<ItemElement>();
  private visible = new Array<number>();


  constructor(public displayState: SegmentationDisplayState) {
    super();
    let {element} = this;
    element.className = 'semantic-entry noselect';
    element.innerHTML = `
    <hr>
    Semantic classes
    <form>
      <label>
        + <input></input>
      </label>
    </form>
    <ul></ul>
    <hr>`;
    
    let form = element.querySelector('form');
    this.input = element.querySelector('input');
    this.ul = element.querySelector('ul');
    
    this.registerSignalBinding(
        displayState.segmentColorHash.changed.add(this.handleColorChanged, this));

    this.registerEventListener(form, 'submit', (event: Event) => {
      event.preventDefault();
      if (this.validateInput()) {
        this.input.classList.remove('valid-input', 'invalid-input');
        this.addElement(this.input.value);
        this.input.value = '';
      }
    });
    this.registerEventListener(form, 'input', () => {
      if (this.input.value === '') {
        this.input.classList.remove('valid-input', 'invalid-input');
        return;
      }
      if (this.validateInput()) {
        this.input.classList.remove('invalid-input');
      } else {
        this.input.classList.add('invalid-input');
      }
    });
  }

  addElement(name: string) {
    var li = document.createElement('li');
    li.innerHTML = `
    <div>
      <button class="visibility down" id=${this.items.length}>v</button>
      <button class="semantic" id=${this.items.length}>${name}</button>
    </div>
    `
    this.visible[this.items.length] = 1;
    let semanticButton : HTMLButtonElement = <HTMLButtonElement>li.querySelector(".semantic");
    let visibilityButton : HTMLButtonElement = <HTMLButtonElement>li.querySelector(".visibility");

    let self = this;
    semanticButton.addEventListener('click', function(this: ItemElement) {
      let id : number = parseInt(this.id);

      for (let segid of self.displayState.visibleSegments) {
        if (self.visible[id] == 0){
          self.displayState.visibleSegments.delete(segid);
        }
        self.displayState.semanticHashMap.setOrUpdate(segid, new Uint64(id, self.visible[id]));
      }
      StatusMessage.displayText(`Applied semantics to ${self.displayState.visibleSegments.size} segments`);
      self.semanticUpdated.dispatch();
    });

    visibilityButton.addEventListener('click', function(this: ItemElement) {
      let id : number = parseInt(this.id);
      if (visibilityButton.classList.contains("down")) { //Invisible
        for (let [key, value] of self.displayState.semanticHashMap) {
          if (value.low == id) {
            value.high = 0;
            self.displayState.semanticHashMap.setOrUpdate(key, value)
          }
        }
        self.visible[id] = 0;
      } else { //Visible
        for (let [key, value] of self.displayState.semanticHashMap) {
          if (value.low == id) {
            value.high = 1;
            self.displayState.semanticHashMap.setOrUpdate(key, value)
          }
        }
        self.visible[id] = 1;
      }
      visibilityButton.classList.toggle("down");
      self.semanticUpdated.dispatch();
    });

    this.setItemColor(this.items.length, semanticButton);

    this.ul.appendChild(li);
    this.items.push(semanticButton);
  }

  validateInput() { return true; }

  private setItemColor(idx:number, itemElement: ItemElement) {
    itemElement.style.backgroundColor = this.segmentColorHash.computeCssColor(new Uint64(idx));
  }

  private handleColorChanged() {
    for (var i = this.items.length - 1; i >= 0; i--) {
      this.setItemColor(i, this.items[i]);
    }
  }

  disposed() {
    removeFromParent(this.element);
    super.disposed();
  }
};
