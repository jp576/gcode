const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const CamCore = require('../cam.js');

class Element {
  constructor(id = '') {
    this.id = id;
    this.children = [];
    this.handlers = {};
    this.dataset = {};
    this.style = {};
    this.classList = { add() {}, remove() {} };
    this.previousElementSibling = { textContent: id };
    this.value = '';
    this.disabled = false;
    this.hidden = false;
    this.checked = false;
    this.textContent = '';
  }
  addEventListener(name, handler) { this.handlers[name] = handler; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute() {}
  scrollIntoView() {}
  getBoundingClientRect() { return { width: 800, height: 600, left: 0, top: 0 }; }
  getContext() {
    return { scale() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, stroke() {}, arc() {}, fillText() {} };
  }
}

const rectangle = (x, y, w, h) => `0\nLWPOLYLINE\n90\n4\n70\n1\n10\n${x}\n20\n${y}\n10\n${x + w}\n20\n${y}\n10\n${x + w}\n20\n${y + h}\n10\n${x}\n20\n${y + h}\n`;
const sample = `0\nSECTION\n2\nENTITIES\n${rectangle(0, 0, 100, 60)}${rectangle(20, 20, 20, 10)}0\nCIRCLE\n10\n60\n20\n30\n40\n1.5\n0\nENDSEC\n0\nEOF\n`;

test('UI assigns a different operation to each entity and downloads mixed G-code', async () => {
  const ids = ['drop','file','entity-list','units','origin','diameter','depth','stepdown','safez','feed','plunge','spindle','segments','return','generate','download','canvas','empty','filename','contours','passes','dimensions','lines','status','code'];
  const elements = Object.fromEntries(ids.map(id => [id, new Element(id)]));
  Object.assign(elements, { });
  const values = { units: 'mm', origin: 'lower', diameter: '3', depth: '6', stepdown: '2', safez: '5', feed: '800', plunge: '200', spindle: '18000', segments: '0.5' };
  for (const [id, value] of Object.entries(values)) elements[id].value = value;
  const document = {
    getElementById: id => elements[id],
    createElement: name => new Element(name),
    createTextNode: text => ({ textContent: text })
  };
  const context = { document, window: { devicePixelRatio: 1, addEventListener() {} }, CamCore, Blob, URL, setTimeout };
  vm.runInNewContext(fs.readFileSync(require.resolve('../app.js'), 'utf8'), context);
  elements.file.files = [{ name: 'mixed.dxf', text: async () => sample }];
  await elements.file.handlers.change({ target: elements.file });
  assert.equal(elements['entity-list'].children.length, 3);
  for (const [index, operation] of [[0, 'outside'], [1, 'inside'], [2, 'drill']]) {
    const select = elements['entity-list'].children[index].children[1];
    select.value = operation;
    select.handlers.change();
  }
  const outerDepth = elements['entity-list'].children[0].children[2].children[0].children[0];
  outerDepth.value = '18.5';
  outerDepth.handlers.change();
  const innerDepth = elements['entity-list'].children[1].children[2].children[0].children[0];
  innerDepth.value = '13';
  innerDepth.handlers.change();
  elements.generate.handlers.click();
  assert.equal(elements.download.disabled, false);
  assert.match(elements.code.textContent, /G1 Z-18\.5 F200/);
  assert.match(elements.code.textContent, /G1 Z-13 F200/);
  const text = elements.code.textContent;
  assert.ok(text.indexOf('(Entidad 3: drill)') < text.indexOf('(Entidad 2: inside)'));
  assert.ok(text.indexOf('(Entidad 2: inside)') < text.indexOf('(Entidad 1: outside)'));
});
