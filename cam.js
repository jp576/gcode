/* DXF geometry and GRBL toolpath generation. No DOM or network dependencies. */
(function (root, factory) {
  const clipper = typeof module === 'object' && module.exports ? require('./vendor/clipper.js') : root.ClipperLib;
  const core = factory(clipper);
  if (typeof module === 'object' && module.exports) module.exports = core;
  else root.CamCore = core;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (ClipperLib) {
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


  function spline(data, resolution) {
    const degree = val(data, 71, NaN), flags = val(data, 70);
    const knots = data.filter(([code]) => code === 40).map(([, value]) => Number(value));
    const controls = [];
    let current = null;
    for (const [code, value] of data) {
      if (code === 10) { current = { x: Number(value), y: NaN, weight: 1 }; controls.push(current); }
      else if (current && code === 20) current.y = Number(value);
      else if (current && code === 41) current.weight = Number(value);
    }
    const n = controls.length;
    if (!Number.isInteger(degree) || degree < 1 || degree > 5 || n < degree + 1 ||
        knots.length !== n + degree + 1 || knots.some((k, i) => !finite(k) || i > 0 && k < knots[i - 1]) ||
        controls.some(p => !finite(p.x) || !finite(p.y) || !(p.weight > 0))) {
      throw Error('SPLINE con nudos, controles o pesos no compatibles.');
    }
    const low = knots[degree], high = knots[n];
    if (!(high > low)) throw Error('SPLINE sin dominio paramétrico válido.');
    function evaluate(u) {
      let span;
      if (u >= high) span = n - 1;
      else {
        let left = degree, right = n;
        while (left + 1 < right) {
          const mid = Math.floor((left + right) / 2);
          if (knots[mid] <= u) left = mid; else right = mid;
        }
        span = left;
      }
      const d = [];
      for (let j = 0; j <= degree; j++) {
        const p = controls[span - degree + j];
        d.push([p.x * p.weight, p.y * p.weight, p.weight]);
      }
      for (let r = 1; r <= degree; r++) for (let j = degree; j >= r; j--) {
        const i = span - degree + j;
        const divisor = knots[i + degree - r + 1] - knots[i];
        const alpha = divisor ? (u - knots[i]) / divisor : 0;
        d[j] = d[j].map((value, axis) => (1 - alpha) * d[j - 1][axis] + alpha * value);
      }
      return { x: d[degree][0] / d[degree][2], y: d[degree][1] / d[degree][2] };
    }
    const points = [evaluate(low)];
    const tolerance = Math.max(resolution, 0.05) / 4;
    function sample(a, pa, b, pb, depth) {
      const middle = (a + b) / 2, pm = evaluate(middle);
      const deviation = Math.hypot(pm.x - (pa.x + pb.x) / 2, pm.y - (pa.y + pb.y) / 2);
      if (deviation > tolerance && depth < 14) {
        sample(a, pa, middle, pm, depth + 1);
        sample(middle, pm, b, pb, depth + 1);
      } else points.push(pb);
      if (points.length > 50000) throw Error('SPLINE demasiado compleja para la resolución elegida.');
    }
    for (let i = degree; i < n; i++) {
      if (knots[i + 1] > knots[i]) sample(knots[i], evaluate(knots[i]), knots[i + 1], evaluate(knots[i + 1]), 0);
    }
    const closed = (flags & 1) !== 0 || near(points[0], points.at(-1));
    if (closed && near(points[0], points.at(-1))) points.pop();
    return { points, closed, degree };
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
      } else if (type === 'SPLINE') {
        add(spline(data, resolution), type, layer);
      }
    }
    const clean = shapes.filter(shape => shape.points.length >= (shape.type === 'POINT' ? 1 : shape.closed ? 3 : 2)
      && shape.points.every(point => finite(point.x) && finite(point.y)));
    if (!clean.length) throw Error('No encontré entidades 2D compatibles: LINE, polilíneas, CIRCLE, ARC, SPLINE o POINT.');
    function headerCoordinate(name, code) {
      const start = input.findIndex(([key, value]) => key === 9 && value === name);
      if (start < 0) return NaN;
      for (let i = start + 1; i < input.length && input[i][0] !== 9; i++) {
        if (input[i][0] === code) return Number(input[i][1]);
      }
      return NaN;
    }
    const sheet = {
      minX: headerCoordinate('$EXTMIN', 10), minY: headerCoordinate('$EXTMIN', 20),
      maxX: headerCoordinate('$EXTMAX', 10), maxY: headerCoordinate('$EXTMAX', 20)
    };
    return clean.map((shape, index) => {
      const box = bounds([shape]);
      const reference = clean.length > 1 && shape.type === 'SPLINE' && shape.degree === 1 &&
        shape.closed && shape.points.length === 4 &&
        Object.keys(sheet).every(key => finite(sheet[key]) && Math.abs(box[key] - sheet[key]) < 0.01);
      return { ...shape, id: index + 1, reference, operation: shape.type === 'POINT' ? 'drill' : reference ? 'skip' : 'center' };
    });
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

  function offset(shape, distance, resolution = 0.5) {
    if (!ClipperLib) throw Error('el motor de compensación de trayectorias no está disponible');
    const scale = 10000;
    const input = [];
    for (const point of shape.points) {
      if (Math.abs(point.x) > 1e8 || Math.abs(point.y) > 1e8) throw Error('coordenadas fuera del rango admitido');
      const rounded = { X: Math.round(point.x * scale), Y: Math.round(point.y * scale) };
      if (!input.length || input.at(-1).X !== rounded.X || input.at(-1).Y !== rounded.Y) input.push(rounded);
    }
    if (input.length > 1 && input[0].X === input.at(-1).X && input[0].Y === input.at(-1).Y) input.pop();
    if (input.length < 3 || Math.abs(ClipperLib.Clipper.Area(input)) < 1) throw Error('el contorno no tiene área válida');
    if (ClipperLib.Clipper.Area(input) < 0) input.reverse();
    const engine = new ClipperLib.ClipperOffset(2, Math.max(0.02, resolution / 4) * scale);
    engine.AddPath(input, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
    const output = new ClipperLib.Paths();
    engine.Execute(output, distance * scale);
    if (!output.length) throw Error('la fresa no cabe en este contorno con el desplazamiento elegido');
    return output.map(path => ({
      points: path.map(point => ({ x: point.X / scale, y: point.Y / scale })),
      closed: true
    })).filter(path => path.points.length >= 3);
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
          for (const contour of offset(shape, (operation === 'outside' ? 1 : -1) * settings.diameter / 2, settings.resolution)) {
            paths.push({ ...contour, id: shape.id, operation });
          }
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
    const byId = new Map(geometry.map(shape => [shape.id, shape]));
    for (const path of paths) {
      const source = byId.get(path.id);
      path.depth = source.depth;
      path.stepdown = source.stepdown;
    }
    return { geometry, paths };
  }

  function gcode(planResult, settings) {
    const { paths } = planResult;
    if (!paths.length) throw Error('Selecciona al menos una trayectoria para generar G-code.');
    let maxPasses = 0;
    const output = [
      '(DXF CNC - verificar en simulador y hacer prueba en vacio)',
      '(SIN PESTANAS NI RAMPAS; verificar sujecion de cortes exteriores)',
      'G21', 'G90', 'G17', 'G94', `G0 Z${fmt(settings.safez)}`, `M3 S${Math.round(settings.spindle)}`
    ];
    for (const path of paths) {
      const depth = path.depth == null ? settings.depth : path.depth;
      const stepdown = path.stepdown == null ? settings.stepdown : path.stepdown;
      if (!(depth > 0) || !(stepdown > 0)) throw Error('Entidad #' + path.id + ': profundidad y paso Z deben ser mayores que cero.');
      const passes = Math.ceil(depth / stepdown);
      if (passes > 250) throw Error('Entidad #' + path.id + ': demasiadas pasadas Z.');
      maxPasses = Math.max(maxPasses, passes);
      output.push(`(Entidad ${path.id}: ${path.operation})`);
      for (let pass = 1; pass <= passes; pass++) {
        const z = -Math.min(pass * stepdown, depth);
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
    return { text: output.join('\n') + '\n', lineCount: output.length, passes: maxPasses };
  }

  return { parseDXF, bounds, plan, gcode, fmt };
});
