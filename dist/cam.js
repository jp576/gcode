/* DXF geometry and GRBL toolpath generation. No DOM or network dependencies. */
(function (root, factory) {
  const core = factory();
  if (typeof module === 'object' && module.exports) module.exports = core;
  else root.CamCore = core;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const finite = Number.isFinite;
  const near = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) < 1e-6;
  const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
  const cross = (a, b) => a.x * b.y - a.y * b.x;
  const fmt = n => (Math.abs(n) < 0.00005 ? 0 : n).toFixed(4).replace(/\.?0+$/, '');

  function pairs(text) {
    const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
    const result = [];
    for (let i = 0; i + 1 < lines.length; i += 2) {
      const code = Number(lines[i].trim());
      if (Number.isInteger(code)) result.push([code, lines[i + 1].trim()]);
    }
    return result;
  }

  function val(data, code, fallback = 0) {
    const item = data.find(pair => pair[0] === code);
    return item ? Number(item[1]) : fallback;
  }

  function bulgePoints(a, b, bulge, resolution) {
    if (Math.abs(bulge) < 1e-10) return [b];
    const chord = Math.hypot(b.x - a.x, b.y - a.y);
    const sweep = 4 * Math.atan(bulge);
    const radius = Math.abs(chord / (2 * Math.sin(sweep / 2)));
    if (!finite(radius) || radius > 1e9 || chord < 1e-9) return [b];
    const h = chord / (2 * Math.tan(sweep / 2));
    const cx = (a.x + b.x) / 2 - (b.y - a.y) / chord * h;
    const cy = (a.y + b.y) / 2 + (b.x - a.x) / chord * h;
    const start = Math.atan2(a.y - cy, a.x - cx);
    const count = Math.min(1440, Math.max(2, Math.ceil(Math.abs(sweep) * radius / resolution)));
    return Array.from({ length: count }, (_, i) => ({
      x: cx + radius * Math.cos(start + sweep * (i + 1) / count),
      y: cy + radius * Math.sin(start + sweep * (i + 1) / count)
    }));
  }

  function poly(vertices, closed, resolution) {
    if (vertices.length < 2) return null;
    const points = [vertices[0]];
    for (let i = 0; i < vertices.length - (closed ? 0 : 1); i++) {
      points.push(...bulgePoints(vertices[i], vertices[(i + 1) % vertices.length], vertices[i].bulge || 0, resolution));
    }
    if (closed && near(points[0], points.at(-1))) points.pop();
    return { points, closed };
  }

  function parseDXF(text, resolution = 0.5) {
    const input = pairs(text);
    if (!input.some(([code, value]) => code === 0 && value === 'SECTION')) {
      throw Error('No parece un DXF ASCII válido. Los DXF binarios no son compatibles.');
    }
    const records = [];
    let inEntities = false;
    let pendingSection = false;
    let current = null;
    for (const [code, value] of input) {
      if (code === 0 && value === 'SECTION') {
        pendingSection = true;
        inEntities = false;
        current = null;
      } else if (pendingSection && code === 2) {
        inEntities = value === 'ENTITIES';
        pendingSection = false;
      } else if (code === 0 && value === 'ENDSEC') {
        inEntities = false;
        current = null;
      } else if (inEntities && code === 0) {
        current = { type: value, data: [] };
        records.push(current);
      } else if (inEntities && current) {
        current.data.push([code, value]);
      }
    }

    const shapes = [];
    let legacy = null;
    const add = (shape, type, layer) => {
      if (!shape) return;
      shape.type = type;
      shape.layer = layer || '0';
      shapes.push(shape);
    };
    for (const record of records) {
      const { type, data } = record;
      const layer = data.find(([code]) => code === 8)?.[1] || '0';
      if (type === 'POLYLINE') {
        legacy = { vertices: [], closed: (val(data, 70) & 1) !== 0, layer };
      } else if (type === 'VERTEX' && legacy) {
        legacy.vertices.push({ x: val(data, 10, NaN), y: val(data, 20, NaN), bulge: val(data, 42) });
      } else if (type === 'SEQEND' && legacy) {
        add(poly(legacy.vertices, legacy.closed, resolution), 'POLYLINE', legacy.layer);
        legacy = null;
      } else if (type === 'LINE') {
        add({ points: [
          { x: val(data, 10, NaN), y: val(data, 20, NaN) },
          { x: val(data, 11, NaN), y: val(data, 21, NaN) }
        ], closed: false }, type, layer);
      } else if (type === 'LWPOLYLINE') {
        const vertices = [];
        let vertex = null;
        for (const [code, value] of data) {
          if (code === 10) {
            vertex = { x: Number(value), y: NaN, bulge: 0 };
            vertices.push(vertex);
          } else if (vertex && code === 20) vertex.y = Number(value);
          else if (vertex && code === 42) vertex.bulge = Number(value);
        }
        add(poly(vertices, (val(data, 70) & 1) !== 0, resolution), type, layer);
      } else if (type === 'CIRCLE' || type === 'ARC') {
        const cx = val(data, 10, NaN), cy = val(data, 20, NaN), radius = val(data, 40, NaN);
        if (!(radius > 0)) continue;
        const start = type === 'CIRCLE' ? 0 : val(data, 50) * Math.PI / 180;
        let end = type === 'CIRCLE' ? 2 * Math.PI : val(data, 51) * Math.PI / 180;
        if (type === 'ARC') while (end <= start) end += 2 * Math.PI;
        const sweep = end - start;
        const n = Math.min(1440, Math.max(16, Math.ceil(sweep * radius / resolution)));
        const length = type === 'CIRCLE' ? n : n + 1;
        add({
          points: Array.from({ length }, (_, i) => ({ x: cx + radius * Math.cos(start + sweep * i / n), y: cy + radius * Math.sin(start + sweep * i / n) })),
          closed: type === 'CIRCLE', center: { x: cx, y: cy }, radius
        }, type, layer);
      } else if (type === 'POINT') {
        add({ points: [{ x: val(data, 10, NaN), y: val(data, 20, NaN) }], closed: false }, type, layer);
      }
    }
    const clean = shapes.filter(shape => shape.points.length >= (shape.type === 'POINT' ? 1 : shape.closed ? 3 : 2)
      && shape.points.every(point => finite(point.x) && finite(point.y)));
    if (!clean.length) throw Error('No encontré entidades 2D compatibles: LINE, polilíneas, CIRCLE, ARC o POINT.');
    return clean.map((shape, index) => ({ ...shape, id: index + 1, operation: shape.type === 'POINT' ? 'drill' : 'center' }));
  }

  function bounds(shapes) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const shape of shapes) for (const point of shape.points) {
      minX = Math.min(minX, point.x); minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y);
    }
    return { minX, minY, maxX, maxY };
  }

  function intersect(a, b, c, d) {
    const r = sub(b, a), s = sub(d, c), divisor = cross(r, s);
    if (Math.abs(divisor) < 1e-9) return null;
    const t = cross(sub(c, a), s) / divisor;
    const u = cross(sub(c, a), r) / divisor;
    return { x: a.x + t * r.x, y: a.y + t * r.y, t, u };
  }

  function selfIntersects(points) {
    for (let i = 0; i < points.length; i++) for (let j = i + 2; j < points.length; j++) {
      if (i === 0 && j === points.length - 1) continue;
      const hit = intersect(points[i], points[(i + 1) % points.length], points[j], points[(j + 1) % points.length]);
      if (hit && hit.t > 1e-7 && hit.t < 1 - 1e-7 && hit.u > 1e-7 && hit.u < 1 - 1e-7) return true;
    }
    return false;
  }

  function area(points) {
    let result = 0;
    for (let i = 0; i < points.length; i++) result += cross(points[i], points[(i + 1) % points.length]);
    return result / 2;
  }

  function offset(shape, distance) {
    const points = shape.points;
    if (selfIntersects(points)) throw Error('el contorno tiene auto-intersecciones');
    const signed = distance * (area(points) >= 0 ? -1 : 1);
    const segments = points.map((a, i) => {
      const b = points[(i + 1) % points.length], dx = b.x - a.x, dy = b.y - a.y;
      const length = Math.hypot(dx, dy);
      if (length < 1e-8) throw Error('el contorno tiene segmentos de longitud cero');
      const nx = -dy / length * signed, ny = dx / length * signed;
      return [{ x: a.x + nx, y: a.y + ny }, { x: b.x + nx, y: b.y + ny }];
    });
    const result = points.map((point, i) => {
      const before = segments[(i + points.length - 1) % points.length], after = segments[i];
      const hit = intersect(before[0], before[1], after[0], after[1]);
      if (!hit || Math.hypot(hit.x - point.x, hit.y - point.y) > Math.abs(distance) * 8) {
        throw Error('la compensación falla en una esquina aguda');
      }
      return { x: hit.x, y: hit.y };
    });
    if (selfIntersects(result) || Math.sign(area(result)) !== Math.sign(area(points))) {
      throw Error('la compensación genera una trayectoria inválida');
    }
    return { points: result, closed: true };
  }

  function plan(shapes, settings) {
    const unit = settings.units === 'in' ? 25.4 : 1;
    const scaled = shapes.map(shape => ({
      ...shape,
      points: shape.points.map(point => ({ x: point.x * unit, y: point.y * unit })),
      center: shape.center && { x: shape.center.x * unit, y: shape.center.y * unit },
      radius: shape.radius && shape.radius * unit
    }));
    const box = bounds(scaled);
    const ox = settings.origin === 'lower' ? box.minX : settings.origin === 'center' ? (box.minX + box.maxX) / 2 : 0;
    const oy = settings.origin === 'lower' ? box.minY : settings.origin === 'center' ? (box.minY + box.maxY) / 2 : 0;
    const geometry = scaled.map(shape => ({
      ...shape,
      points: shape.points.map(point => ({ x: point.x - ox, y: point.y - oy })),
      center: shape.center && { x: shape.center.x - ox, y: shape.center.y - oy }
    }));
    const paths = [];
    for (const shape of geometry) {
      const operation = shape.operation;
      if (operation === 'skip') continue;
      try {
        if (operation === 'drill') {
          if (shape.type !== 'CIRCLE' && shape.type !== 'POINT') throw Error('perforar solo admite CIRCLE o POINT');
          if (shape.type === 'CIRCLE' && Math.abs(shape.radius * 2 - settings.diameter) > 0.2) {
            throw Error('para perforar al centro, el diámetro del círculo debe coincidir con la fresa (±0,2 mm); usa «Interior» para un agujero mayor');
          }
          paths.push({ id: shape.id, operation, points: [shape.center || shape.points[0]], closed: false });
        } else if (operation === 'inside' || operation === 'outside') {
          if (!shape.closed) throw Error('la compensación interior/exterior requiere un contorno cerrado');
          if (operation === 'inside' && shape.type === 'CIRCLE' && shape.radius * 2 <= settings.diameter) {
            throw Error('la fresa no cabe dentro del círculo; usa «Perforar» si coincide su diámetro');
          }
          paths.push({ ...offset(shape, (operation === 'outside' ? 1 : -1) * settings.diameter / 2), id: shape.id, operation });
        } else if (operation === 'center') {
          if (shape.type === 'POINT') throw Error('un POINT solo admite «Perforar»');
          paths.push({ id: shape.id, operation, points: shape.points, closed: shape.closed });
        } else {
          throw Error('operación desconocida');
        }
      } catch (error) {
        throw Error(`Entidad #${shape.id}: ${error.message}.`);
      }
    }
    const rank = { drill: 0, inside: 1, center: 2, outside: 3 };
    paths.sort((a, b) => rank[a.operation] - rank[b.operation] || a.id - b.id);
    return { geometry, paths };
  }

  function gcode(planResult, settings) {
    const { paths } = planResult;
    if (!paths.length) throw Error('Selecciona al menos una trayectoria para generar G-code.');
    const passes = Math.ceil(settings.depth / settings.stepdown);
    const output = [
      '(DXF CNC - verificar en simulador y hacer prueba en vacio)',
      'G21', 'G90', 'G17', 'G94', `G0 Z${fmt(settings.safez)}`, `M3 S${Math.round(settings.spindle)}`
    ];
    for (const path of paths) {
      output.push(`(Entidad ${path.id}: ${path.operation})`);
      for (let pass = 1; pass <= passes; pass++) {
        const z = -Math.min(pass * settings.stepdown, settings.depth);
        const start = path.points[0];
        output.push(`(Pasada ${pass}/${passes} Z${fmt(z)})`);
        output.push(`G0 Z${fmt(settings.safez)}`);
        output.push(`G0 X${fmt(start.x)} Y${fmt(start.y)}`);
        output.push(`G1 Z${fmt(z)} F${fmt(settings.plunge)}`);
        if (path.operation !== 'drill') {
          for (const point of path.points.slice(1)) {
            output.push(`G1 X${fmt(point.x)} Y${fmt(point.y)} F${fmt(settings.feed)}`);
          }
          if (path.closed) output.push(`G1 X${fmt(start.x)} Y${fmt(start.y)} F${fmt(settings.feed)}`);
        }
        output.push(`G0 Z${fmt(settings.safez)}`);
      }
    }
    output.push('M5');
    if (settings.returnHome) output.push('G0 X0 Y0');
    output.push('M2');
    return { text: output.join('\n') + '\n', lineCount: output.length, passes };
  }

  return { parseDXF, bounds, plan, gcode, fmt };
});
