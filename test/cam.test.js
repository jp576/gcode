const test = require('node:test');
const assert = require('node:assert/strict');
const Cam = require('../cam.js');

const rectangle = (x, y, w, h, layer) => `0\nLWPOLYLINE\n8\n${layer}\n90\n4\n70\n1\n10\n${x}\n20\n${y}\n10\n${x + w}\n20\n${y}\n10\n${x + w}\n20\n${y + h}\n10\n${x}\n20\n${y + h}\n`;
const dxf = `0\nSECTION\n2\nENTITIES\n${rectangle(0, 0, 100, 60, 'EXTERIOR')}${rectangle(20, 20, 20, 10, 'ENCAJE')}0\nCIRCLE\n8\nTALADRO\n10\n60\n20\n30\n40\n1.5\n0\nENDSEC\n0\nEOF\n`;
const settings = { units: 'mm', origin: 'lower', diameter: 3, depth: 6, stepdown: 2, safez: 5, feed: 800, plunge: 200, spindle: 18000, returnHome: false };

test('combines exterior, interior and drilling; finishes exterior last', () => {
  const shapes = Cam.parseDXF(dxf);
  assert.equal(shapes.length, 3);
  assert.deepEqual(shapes.map(s => s.layer), ['EXTERIOR', 'ENCAJE', 'TALADRO']);
  shapes[0].operation = 'outside';
  shapes[1].operation = 'inside';
  shapes[2].operation = 'drill';
  const result = Cam.plan(shapes, settings);
  assert.deepEqual(result.paths.map(p => p.operation), ['drill', 'inside', 'outside']);
  const inner = Cam.bounds([result.paths[1]]);
  const outer = Cam.bounds([result.paths[2]]);
  assert.ok(inner.minX > 20 && inner.maxX < 40);
  assert.ok(outer.minX < 0 && outer.maxX > 100);
  const output = Cam.gcode(result, settings);
  assert.equal(output.passes, 3);
  assert.ok(output.text.indexOf('(Entidad 3: drill)') < output.text.indexOf('(Entidad 2: inside)'));
  assert.ok(output.text.indexOf('(Entidad 2: inside)') < output.text.indexOf('(Entidad 1: outside)'));
  assert.match(output.text, /G0 X60 Y30\nG1 Z-2 F200/);
});

test('rejects center drilling when the tool would leave an undersized hole', () => {
  const shapes = Cam.parseDXF(dxf);
  shapes[2].operation = 'drill';
  assert.throws(() => Cam.plan(shapes, { ...settings, diameter: 2 }), /Entidad #3.*diámetro del círculo/);
});

test('POINT can be drilled and open lines cannot receive contour compensation', () => {
  const pointDXF = '0\nSECTION\n2\nENTITIES\n0\nPOINT\n10\n10\n20\n20\n0\nLINE\n10\n0\n20\n0\n11\n5\n21\n0\n0\nENDSEC\n0\nEOF\n';
  const shapes = Cam.parseDXF(pointDXF);
  assert.equal(shapes[0].operation, 'drill');
  shapes[1].operation = 'skip';
  assert.deepEqual(Cam.plan(shapes, settings).paths[0].points[0], { x: 10, y: 20 });
  shapes[1].operation = 'outside';
  assert.throws(() => Cam.plan(shapes, settings), /Entidad #2.*contorno cerrado/);
});
