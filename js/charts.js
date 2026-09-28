// ===== Noise & Recall Lab — hand-made SVG charts =====
// No libraries needed, so the site works offline. Colours come from the CSS variables,
// so charts match light and dark mode. Every chart has hover tooltips and a PNG export.

const Charts = {
  svgByContainer: new WeakMap(),

  colors() {
    const style = getComputedStyle(document.documentElement);
    const v = name => style.getPropertyValue(name).trim();
    return {
      surface: v('--surface-1'),
      text: v('--text-primary'),
      text2: v('--text-secondary'),
      muted: v('--text-muted'),
      grid: v('--grid'),
      axis: v('--axis'),
      quiet: v('--series-quiet'),
      talking: v('--series-talking'),
      white: v('--series-white'),
      construction: v('--series-construction'),
      rampStart: v('--ramp-start'),
      rampEnd: v('--ramp-end'),
      accent: v('--accent'),
    };
  },

  escape(text) {
    return String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  },

  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',

  // Pushes end-of-line labels apart so they never overlap.
  spreadLabels(labels, minGap, top, bottom) {
    const sorted = labels.slice().sort((a, b) => a.y - b.y);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].y - sorted[i - 1].y < minGap) sorted[i].y = sorted[i - 1].y + minGap;
    }
    const overflow = sorted.length ? sorted[sorted.length - 1].y - bottom : 0;
    if (overflow > 0) sorted.forEach(label => { label.y = Math.max(top, label.y - overflow); });
    return sorted;
  },

  // spec: { series: [{name, color, points: [{x, y, se, n}]}], xDomain, xTicks: [{value, label}],
  //         yDomain, yLabel, xLabel, trend: {slope, intercept}, reference: {y, label}, height, valueSuffix }
  line(container, spec) {
    const c = this.colors();
    const width = Math.max(300, container.clientWidth || 600);
    const height = spec.height || 320;
    const showEndLabels = spec.series.length > 1 && spec.series.length <= 4 && width > 420;
    const margin = { top: 18, right: showEndLabels ? 104 : 24, bottom: 58, left: 56 };
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;
    const [x0, x1] = spec.xDomain;
    const [y0, y1] = spec.yDomain;
    const sx = x => margin.left + ((x - x0) / (x1 - x0)) * innerW;
    const sy = y => margin.top + (1 - (Math.max(y0, Math.min(y1, y)) - y0) / (y1 - y0)) * innerH;
    const suffix = spec.valueSuffix ?? '%';
    const parts = [];

    // Grid and y-axis labels
    const yTicks = spec.yTicks || [0, 25, 50, 75, 100];
    for (const tick of yTicks) {
      parts.push(`<line x1="${margin.left}" x2="${width - margin.right}" y1="${sy(tick)}" y2="${sy(tick)}" stroke="${tick === y0 ? c.axis : c.grid}" stroke-width="1"/>`);
      parts.push(`<text x="${margin.left - 8}" y="${sy(tick) + 4}" text-anchor="end" font-size="12" fill="${c.muted}">${tick}${suffix}</text>`);
    }
    // x-axis labels (may be two lines, split by \n)
    for (const tick of spec.xTicks) {
      const lines = String(tick.label).split('\n');
      const tspans = lines.map((line, i) => `<tspan x="${sx(tick.value)}" dy="${i === 0 ? 0 : 14}">${this.escape(line)}</tspan>`).join('');
      parts.push(`<text x="${sx(tick.value)}" y="${margin.top + innerH + 20}" text-anchor="middle" font-size="12" fill="${c.text2}">${tspans}</text>`);
    }
    if (spec.xLabel) parts.push(`<text x="${margin.left + innerW / 2}" y="${height - 6}" text-anchor="middle" font-size="12" fill="${c.muted}">${this.escape(spec.xLabel)}</text>`);
    if (spec.yLabel) parts.push(`<text transform="translate(14 ${margin.top + innerH / 2}) rotate(-90)" text-anchor="middle" font-size="12" fill="${c.muted}">${this.escape(spec.yLabel)}</text>`);

    if (spec.reference && Number.isFinite(spec.reference.y)) {
      const y = sy(spec.reference.y);
      parts.push(`<line x1="${margin.left}" x2="${width - margin.right}" y1="${y}" y2="${y}" stroke="${c.quiet}" stroke-width="1.5" stroke-dasharray="5 4"/>`);
      parts.push(`<text x="${margin.left + 6}" y="${y - 6}" font-size="11" fill="${c.text2}">${this.escape(spec.reference.label)}</text>`);
    }

    if (spec.trend) {
      const { slope, intercept } = spec.trend;
      const tx0 = spec.trend.from ?? x0, tx1 = spec.trend.to ?? x1;
      parts.push(`<line x1="${sx(tx0)}" y1="${sy(slope * tx0 + intercept)}" x2="${sx(tx1)}" y2="${sy(slope * tx1 + intercept)}" stroke="${c.text2}" stroke-width="1.5" stroke-dasharray="2 4" opacity="0.8"/>`);
    }

    // Series: error bars, line, markers
    const endLabels = [];
    for (const series of spec.series) {
      const points = series.points.filter(p => Number.isFinite(p.y));
      if (!points.length) continue;
      for (const p of points) {
        if (Number.isFinite(p.se) && p.se > 0) {
          const top = sy(p.y + p.se), bottom = sy(p.y - p.se), x = sx(p.x);
          parts.push(`<line x1="${x}" x2="${x}" y1="${top}" y2="${bottom}" stroke="${series.color}" stroke-width="1.5" opacity="0.7"/>`);
          parts.push(`<line x1="${x - 4}" x2="${x + 4}" y1="${top}" y2="${top}" stroke="${series.color}" stroke-width="1.5" opacity="0.7"/>`);
          parts.push(`<line x1="${x - 4}" x2="${x + 4}" y1="${bottom}" y2="${bottom}" stroke="${series.color}" stroke-width="1.5" opacity="0.7"/>`);
        }
      }
      if (points.length > 1) {
        const d = points.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ');
        parts.push(`<path d="${d}" fill="none" stroke="${series.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" ${series.dash ? `stroke-dasharray="${series.dash}"` : ''}/>`);
      }
      for (const p of points) {
        parts.push(`<circle cx="${sx(p.x)}" cy="${sy(p.y)}" r="4.5" fill="${series.color}" stroke="${c.surface}" stroke-width="2" data-series="${this.escape(series.name)}" data-x="${p.x}"/>`);
      }
      const last = points[points.length - 1];
      endLabels.push({ name: series.name, color: series.color, x: sx(last.x), y: sy(last.y) });
    }
    if (showEndLabels) {
      const placed = this.spreadLabels(endLabels, 15, margin.top, margin.top + innerH);
      for (const label of placed) {
        parts.push(`<text x="${width - margin.right + 12}" y="${label.y + 4}" font-size="12" fill="${c.text}">${this.escape(label.name)}</text>`);
      }
    }

    // Hover crosshair (hidden until pointer is over a column)
    parts.push(`<line class="crosshair" x1="0" x2="0" y1="${margin.top}" y2="${margin.top + innerH}" stroke="${c.axis}" stroke-width="1" visibility="hidden"/>`);
    const xs = [...new Set(spec.series.flatMap(s => s.points.filter(p => Number.isFinite(p.y)).map(p => p.x)))].sort((a, b) => a - b);
    xs.forEach((x, i) => {
      const left = i === 0 ? margin.left : (sx(xs[i - 1]) + sx(x)) / 2;
      const right = i === xs.length - 1 ? width - margin.right : (sx(x) + sx(xs[i + 1])) / 2;
      parts.push(`<rect class="hit" data-x="${x}" x="${left}" y="${margin.top}" width="${Math.max(1, right - left)}" height="${innerH}" fill="transparent"/>`);
    });

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family='${this.fontFamily}' role="img" aria-label="${this.escape(spec.ariaLabel || 'Line chart')}">${parts.join('')}</svg>`;
    this.mount(container, svg, spec, (x) => {
      const tick = spec.xTicks.find(t => t.value === x);
      const rows = spec.series.map(series => {
        const p = series.points.find(point => point.x === x && Number.isFinite(point.y));
        if (!p) return '';
        const se = Number.isFinite(p.se) ? ` ±${p.se.toFixed(1)}` : '';
        const n = p.n ? ` <span class="tt-muted">n=${p.n}</span>` : '';
        return `<div class="tt-row"><span class="tt-key" style="background:${series.color}"></span>${this.escape(series.name)}<b>${p.y.toFixed(1)}${suffix}${se}</b>${n}</div>`;
      }).join('');
      return { title: tick ? tick.label.replace('\n', ' ') : String(x), rows, px: sx(x) };
    });
  },

  // spec: { bars: [{label, value, se, n}], color, yDomain, yLabel, height }
  bar(container, spec) {
    const c = this.colors();
    const width = Math.max(280, container.clientWidth || 500);
    const height = spec.height || 260;
    const margin = { top: 24, right: 16, bottom: 40, left: 56 };
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;
    const [y0, y1] = spec.yDomain;
    const sy = y => margin.top + (1 - (Math.max(y0, Math.min(y1, y)) - y0) / (y1 - y0)) * innerH;
    const band = innerW / Math.max(1, spec.bars.length);
    const barW = Math.min(64, band * 0.6);
    const parts = [];
    for (const tick of [0, 25, 50, 75, 100]) {
      parts.push(`<line x1="${margin.left}" x2="${width - margin.right}" y1="${sy(tick)}" y2="${sy(tick)}" stroke="${tick === 0 ? c.axis : c.grid}"/>`);
      parts.push(`<text x="${margin.left - 8}" y="${sy(tick) + 4}" text-anchor="end" font-size="12" fill="${c.muted}">${tick}%</text>`);
    }
    if (spec.yLabel) parts.push(`<text transform="translate(14 ${margin.top + innerH / 2}) rotate(-90)" text-anchor="middle" font-size="12" fill="${c.muted}">${this.escape(spec.yLabel)}</text>`);
    spec.bars.forEach((bar, i) => {
      const cx = margin.left + band * i + band / 2;
      const x = cx - barW / 2;
      const top = sy(bar.value), base = sy(0);
      const r = Math.min(4, barW / 2, Math.max(0, base - top));
      // Rounded top corners only; the bar stays anchored flat on the baseline.
      parts.push(`<path d="M${x},${base} L${x},${top + r} Q${x},${top} ${x + r},${top} L${x + barW - r},${top} Q${x + barW},${top} ${x + barW},${top + r} L${x + barW},${base} Z" fill="${spec.color}"/>`);
      if (Number.isFinite(bar.se) && bar.se > 0) {
        const eTop = sy(bar.value + bar.se), eBottom = sy(bar.value - bar.se);
        parts.push(`<line x1="${cx}" x2="${cx}" y1="${eTop}" y2="${eBottom}" stroke="${c.text2}" stroke-width="1.5"/>`);
        parts.push(`<line x1="${cx - 4}" x2="${cx + 4}" y1="${eTop}" y2="${eTop}" stroke="${c.text2}" stroke-width="1.5"/>`);
      }
      const labelY = Math.min(sy(bar.value + (bar.se || 0)), top) - 6;
      parts.push(`<text x="${cx}" y="${labelY}" text-anchor="middle" font-size="12" fill="${c.text}">${bar.value.toFixed(0)}%</text>`);
      parts.push(`<text x="${cx}" y="${margin.top + innerH + 20}" text-anchor="middle" font-size="12" fill="${c.text2}">${this.escape(bar.label)}</text>`);
      parts.push(`<rect class="hit" data-x="${i}" x="${margin.left + band * i}" y="${margin.top}" width="${band}" height="${innerH}" fill="transparent"/>`);
    });
    parts.push(`<line class="crosshair" visibility="hidden"/>`);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family='${this.fontFamily}' role="img" aria-label="${this.escape(spec.ariaLabel || 'Bar chart')}">${parts.join('')}</svg>`;
    this.mount(container, svg, spec, (index) => {
      const bar = spec.bars[index];
      return {
        title: bar.label,
        rows: `<div class="tt-row"><span class="tt-key" style="background:${spec.color}"></span>Mean<b>${bar.value.toFixed(1)}% ±${(bar.se || 0).toFixed(1)}</b> <span class="tt-muted">n=${bar.n}</span></div>`,
        px: margin.left + band * index + band / 2,
      };
    });
  },

  // Puts the SVG in the page and wires up the tooltip.
  mount(container, svgText, spec, describe) {
    container.innerHTML = svgText + '<div class="tooltip" hidden></div>';
    this.svgByContainer.set(container, { svgText, title: spec.title || '' });
    const svg = container.querySelector('svg');
    const tooltip = container.querySelector('.tooltip');
    const crosshair = svg.querySelector('.crosshair');
    const hide = () => { tooltip.hidden = true; crosshair.setAttribute('visibility', 'hidden'); };
    svg.querySelectorAll('.hit').forEach(hit => {
      const show = event => {
        const x = Number(hit.dataset.x);
        const info = describe(x);
        if (!info.rows) return hide();
        tooltip.innerHTML = `<div class="tt-title">${this.escape(info.title)}</div>${info.rows}`;
        tooltip.hidden = false;
        if (crosshair.hasAttribute('y1')) {
          crosshair.setAttribute('x1', info.px);
          crosshair.setAttribute('x2', info.px);
          crosshair.setAttribute('visibility', 'visible');
        }
        const box = container.getBoundingClientRect();
        const tipW = tooltip.offsetWidth, tipH = tooltip.offsetHeight;
        let left = info.px + 14;
        if (left + tipW > box.width) left = info.px - tipW - 14;
        let top = (event.clientY - box.top) - tipH / 2;
        top = Math.max(0, Math.min(box.height - tipH, top));
        tooltip.style.left = Math.max(0, left) + 'px';
        tooltip.style.top = top + 'px';
      };
      hit.addEventListener('pointermove', show);
      hit.addEventListener('pointerdown', show);
    });
    svg.addEventListener('pointerleave', hide);
  },

  // Saves a chart as a PNG (with its title on top) — good for the brochure.
  downloadPng(container, filename) {
    const saved = this.svgByContainer.get(container);
    if (!saved) return;
    const c = this.colors();
    const svgEl = container.querySelector('svg');
    const width = Number(svgEl.getAttribute('width'));
    const height = Number(svgEl.getAttribute('height'));
    const titleSpace = saved.title ? 40 : 0;
    const scale = 2;
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = width * scale;
      canvas.height = (height + titleSpace + 16) * scale;
      const ctx = canvas.getContext('2d');
      ctx.scale(scale, scale);
      ctx.fillStyle = c.surface;
      ctx.fillRect(0, 0, width, height + titleSpace + 16);
      if (saved.title) {
        ctx.fillStyle = c.text;
        ctx.font = `600 16px ${this.fontFamily}`;
        ctx.fillText(saved.title, 16, 28);
      }
      ctx.drawImage(image, 0, titleSpace + 8, width, height);
      canvas.toBlob(blob => downloadFile(filename, blob));
    };
    image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(saved.svgText);
  },
};
