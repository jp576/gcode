(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const colors = { center: '#e9c46a', inside: '#63d9bd', outside: '#64a9ff', drill: '#ec85b5', skip: '#788da7' };
  const names = { center: 'Sobre línea', inside: 'Interior', outside: 'Exterior', drill: 'Perforar al centro', skip: 'No mecanizar' };
  const controls = ['units', 'origin', 'diameter', 'depth', 'stepdown', 'safez', 'feed', 'plunge', 'spindle', 'segments', 'return'];
  let shapes = [];
  let rawDXF = '';
  let filename = '';
  let planResult = null;
  let gcodeText = '';
  let selectedId = null;
  let canvasView = null;

  function status(message, error = false) {
    $('status').textContent = message;
    $('status').className = error ? 'status error' : 'status';
  }

  function number(id) { return Number($(id).value); }

  function settings() {
    const result = {
      units: $('units').value,
      origin: $('origin').value,
      diameter: number('diameter'),
      depth: number('depth'),
      stepdown: number('stepdown'),
      safez: number('safez'),
      feed: number('feed'),
      plunge: number('plunge'),
      spindle: number('spindle'),
      resolution: number('segments'),
      returnHome: $('return').checked
    };
    for (const key of ['diameter', 'depth', 'stepdown', 'safez', 'feed', 'plunge', 'spindle', 'resolution']) {
      if (!Number.isFinite(result[key]) || result[key] <= 0) {
        throw Error(`«${$(key === 'resolution' ? 'segments' : key).previousElementSibling.textContent}» debe ser mayor que cero.`);
      }
    }
    if (result.depth > 1000 || result.stepdown > 1000 || result.diameter > 1000) {
      throw Error('Revisa diámetro y profundidades: el valor supera 1000 mm.');
    }
    if (Math.ceil(result.depth / result.stepdown) > 250) {
      throw Error('Demasiadas pasadas Z. Aumenta la profundidad por pasada.');
    }
    return result;
  }

  function invalidate(message = 'Parámetros modificados. Genera de nuevo para actualizar el G-code.') {
    planResult = null;
    gcodeText = '';
    $('download').disabled = true;
    $('passes').textContent = '0';
    $('lines').textContent = '0';
    $('code').textContent = '; Parámetros modificados. Vuelve a generar.';
    if (shapes.length) status(message);
    draw();
  }

  function optionsFor(shape) {
    if (shape.type === 'POINT') return ['drill', 'skip'];
    if (!shape.closed) return ['center', 'skip'];
    if (shape.type === 'CIRCLE') return ['center', 'inside', 'outside', 'drill', 'skip'];
    return ['center', 'inside', 'outside', 'skip'];
  }

  function shapeSummary(shape) {
    const factor = $('units').value === 'in' ? 25.4 : 1;
    const box = CamCore.bounds([shape]);
    const size = shape.type === 'POINT' ? 'punto' : shape.type === 'CIRCLE'
      ? `Ø ${CamCore.fmt(shape.radius * 2 * factor)} mm`
      : `${CamCore.fmt((box.maxX - box.minX) * factor)} × ${CamCore.fmt((box.maxY - box.minY) * factor)} mm`;
    return `${shape.reference ? "Marco de plancha · " : ""}${shape.type} · ${size} · capa ${shape.layer}`;
  }

  function renderEntities() {
    const list = $('entity-list');
    list.replaceChildren();
    if (!shapes.length) {
      const empty = document.createElement('div');
      empty.className = 'entity-empty';
      empty.textContent = 'Las entidades del DXF aparecerán aquí.';
      list.append(empty);
      return;
    }
    for (const shape of shapes) {
      const row = document.createElement('div');
      row.className = 'entity-row' + (selectedId === shape.id ? ' active' : '');
      row.dataset.id = String(shape.id);
      row.tabIndex = 0;
      const head = document.createElement('div');
      head.className = 'entity-head';
      const title = document.createElement('strong');
      const dot = document.createElement('i');
      dot.className = 'op-dot';
      dot.style.background = colors[shape.operation];
      title.append(dot, document.createTextNode(`#${shape.id}`));
      const detail = document.createElement('small');
      detail.textContent = shapeSummary(shape);
      detail.title = detail.textContent;
      head.append(title, detail);
      const select = document.createElement('select');
      select.setAttribute('aria-label', `Operación de entidad ${shape.id}`);
      for (const operation of optionsFor(shape)) {
        const option = document.createElement('option');
        option.value = operation;
        option.textContent = names[operation];
        select.append(option);
      }
      select.value = shape.operation;
      select.addEventListener('change', () => {
        shape.operation = select.value;
        selectedId = shape.id;
        renderEntities();
        invalidate(`Entidad #${shape.id}: ${names[shape.operation]}. Genera de nuevo para actualizar el G-code.`);
      });
      row.addEventListener('click', event => { if (event.target !== select) selectShape(shape.id); });
      row.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectShape(shape.id); }
      });
      const parameters = document.createElement('div');
      parameters.className = 'entity-params';
      for (const [key, label] of [['depth', 'Prof. final (mm)'], ['stepdown', 'Paso Z (mm)']]) {
        const wrapper = document.createElement('label');
        wrapper.textContent = label;
        const input = document.createElement('input');
        input.type = 'number';
        input.min = '0.01';
        input.step = '0.1';
        input.placeholder = String(number(key));
        input.value = shape[key] ?? '';
        input.setAttribute('aria-label', label + ' de entidad ' + shape.id);
        input.addEventListener('change', () => {
          shape[key] = input.value.trim() === '' ? null : Number(input.value);
          selectedId = shape.id;
          invalidate('Entidad #' + shape.id + ': profundidad modificada. Genera de nuevo.');
        });
        wrapper.append(input);
        parameters.append(wrapper);
      }
      row.append(head, select, parameters);
      list.append(row);
    }
  }

  function selectShape(id) {
    selectedId = id;
    renderEntities();
    const row = [...$('entity-list').children].find(node => Number(node.dataset.id) === id);
    row?.scrollIntoView?.({ block: 'nearest' });
    draw();
  }

  function updateDimensions() {
    if (!shapes.length) { $('dimensions').textContent = '—'; return; }
    const factor = $('units').value === 'in' ? 25.4 : 1;
    const box = CamCore.bounds(shapes);
    $('dimensions').textContent = `${CamCore.fmt((box.maxX - box.minX) * factor)} × ${CamCore.fmt((box.maxY - box.minY) * factor)} mm`;
  }

  function load(text, name, preserveOperations = false) {
    try {
      const old = preserveOperations ? new Map(shapes.map(shape => [shape.id, shape.operation])) : new Map();
      const next = CamCore.parseDXF(text, Math.max(number('segments') || 0.5, 0.05));
      for (const shape of next) if (old.has(shape.id)) shape.operation = old.get(shape.id);
      shapes = next;
      rawDXF = text;
      filename = name;
      selectedId = null;
      $('filename').textContent = name;
      $('empty').hidden = true;
      $('contours').textContent = String(shapes.length);
      $('generate').disabled = false;
      renderEntities();
      updateDimensions();
      invalidate(`${shapes.length} entidades cargadas. Asigna una operación a cada una y revisa las unidades del DXF.`);
    } catch (error) {
      shapes = [];
      rawDXF = '';
      selectedId = null;
      $('generate').disabled = true;
      $('download').disabled = true;
      $('empty').hidden = false;
      $('contours').textContent = '0';
      renderEntities();
      status(error.message, true);
      draw();
    }
  }

  function generate() {
    try {
      const config = settings();
      const prepared = CamCore.plan(shapes, config);
      const result = CamCore.gcode(prepared, config);
      planResult = prepared;
      gcodeText = result.text;
      $('code').textContent = gcodeText;
      $('download').disabled = false;
      $('passes').textContent = String(result.passes);
      $('lines').textContent = String(result.lineCount);
      status(`${prepared.paths.length} trayectorias generadas. Interiores primero y exteriores al final. Los exteriores no tienen pestañas: asegura las piezas y verifica el G-code antes de cortar.`);
      draw();
    } catch (error) {
      planResult = null;
      gcodeText = '';
      $('download').disabled = true;
      $('code').textContent = '; No se generó G-code. Corrige la operación indicada.';
      status(error.message, true);
      draw();
    }
  }

  function previewGeometry() {
    if (planResult) return planResult.geometry;
    if (!shapes.length) return [];
    const unit = $('units').value === 'in' ? 25.4 : 1;
    const scaled = shapes.map(shape => ({ ...shape, points: shape.points.map(point => ({ x: point.x * unit, y: point.y * unit })) }));
    const box = CamCore.bounds(scaled);
    const ox = $('origin').value === 'lower' ? box.minX : $('origin').value === 'center' ? (box.minX + box.maxX) / 2 : 0;
    const oy = $('origin').value === 'lower' ? box.minY : $('origin').value === 'center' ? (box.minY + box.maxY) / 2 : 0;
    return scaled.map(shape => ({ ...shape, points: shape.points.map(point => ({ x: point.x - ox, y: point.y - oy })) }));
  }

  function draw() {
    const canvas = $('canvas');
    const rectangle = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rectangle.width * dpr));
    canvas.height = Math.max(1, Math.round(rectangle.height * dpr));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    const geometry = previewGeometry();
    const paths = planResult?.paths || [];
    canvasView = null;
    if (!geometry.length) return;
    const box = CamCore.bounds([...geometry, ...paths]);
    const width = rectangle.width, height = rectangle.height, pad = 40;
    const scale = Math.min((width - pad * 2) / Math.max(box.maxX - box.minX, 1), (height - pad * 2) / Math.max(box.maxY - box.minY, 1));
    const cx = (box.minX + box.maxX) / 2, cy = (box.minY + box.maxY) / 2;
    const project = point => ({ x: width / 2 + (point.x - cx) * scale, y: height / 2 - (point.y - cy) * scale });
    canvasView = { geometry, project };
    const origin = project({ x: 0, y: 0 });
    ctx.strokeStyle = '#f6ba6f';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(origin.x - 9, origin.y); ctx.lineTo(origin.x + 9, origin.y);
    ctx.moveTo(origin.x, origin.y - 9); ctx.lineTo(origin.x, origin.y + 9);
    ctx.stroke();
    for (const shape of geometry) {
      ctx.strokeStyle = shape.id === selectedId ? '#ffffff' : '#8da7c7';
      ctx.lineWidth = shape.id === selectedId ? 2.5 : 1.5;
      ctx.beginPath();
      shape.points.forEach((point, i) => {
        const p = project(point);
        if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
      });
      if (shape.closed) ctx.closePath();
      if (shape.type === 'POINT') {
        const p = project(shape.points[0]);
        ctx.moveTo(p.x - 4, p.y); ctx.lineTo(p.x + 4, p.y);
        ctx.moveTo(p.x, p.y - 4); ctx.lineTo(p.x, p.y + 4);
      }
      ctx.stroke();
      const label = project(shape.points[0]);
      ctx.fillStyle = '#dbe7f5';
      ctx.font = '12px system-ui';
      ctx.fillText?.(`#${shape.id}`, label.x + 5, label.y - 7);
    }
    for (const path of paths) {
      ctx.strokeStyle = colors[path.operation];
      ctx.lineWidth = path.id === selectedId ? 3.5 : 2.5;
      ctx.beginPath();
      if (path.operation === 'drill') {
        const p = project(path.points[0]);
        ctx.arc(p.x, p.y, 6, 0, 2 * Math.PI);
      } else {
        path.points.forEach((point, i) => {
          const p = project(point);
          if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
        });
        if (path.closed) ctx.closePath();
      }
      ctx.stroke();
    }
  }

  function distanceToSegment(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
  }

  $('canvas').addEventListener('click', event => {
    if (!canvasView) return;
    const rect = $('canvas').getBoundingClientRect();
    const click = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    let best = { id: null, distance: 14 };
    for (const shape of canvasView.geometry) {
      const points = shape.points.map(canvasView.project);
      let distance = shape.type === 'POINT' ? Math.hypot(click.x - points[0].x, click.y - points[0].y) : Infinity;
      for (let i = 0; i < points.length - 1; i++) distance = Math.min(distance, distanceToSegment(click, points[i], points[i + 1]));
      if (shape.closed) distance = Math.min(distance, distanceToSegment(click, points.at(-1), points[0]));
      if (distance < best.distance) best = { id: shape.id, distance };
    }
    if (best.id != null) selectShape(best.id);
  });

  $('file').addEventListener('change', async event => {
    const file = event.target.files?.[0];
    if (file) load(await file.text(), file.name);
  });
  const drop = $('drop');
  drop.addEventListener('dragover', event => { event.preventDefault(); drop.classList.add('drag'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
  drop.addEventListener('drop', async event => {
    event.preventDefault();
    drop.classList.remove('drag');
    const file = event.dataTransfer.files?.[0];
    if (file) load(await file.text(), file.name);
  });
  $('generate').addEventListener('click', generate);
  $('download').addEventListener('click', () => {
    if (!gcodeText) return;
    const url = URL.createObjectURL(new Blob([gcodeText], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = (filename.replace(/\.dxf$/i, '') || 'corte') + '.nc';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  for (const id of controls) $(id).addEventListener('change', () => {
    if (!shapes.length) return;
    if (id === 'segments' && rawDXF) {
      load(rawDXF, filename, true);
      return;
    }
    if (id === 'units') updateDimensions();
    if (id === 'units' || id === 'depth' || id === 'stepdown') renderEntities();
    invalidate();
  });
  window.addEventListener('resize', draw);
})();
