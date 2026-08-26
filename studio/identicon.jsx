// identicon.jsx — deterministic generative identicons with lineage (mutation).
// window.Identicon = { root, mutate, err, url }
(function () {
  const GRID = 5, COLS = 3; // 5x5, left-symmetric (cols 0,1,2 then mirror)

  function fnv(str) {
    let h = 2166136261 >>> 0;
    str = "" + str;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // descriptor: { grid: bool[5][3] (left half incl. centre col), hue, key, error }
  function root(seed) {
    const key = "r:" + seed;
    const rng = mulberry32(fnv(key));
    const grid = [];
    for (let r = 0; r < GRID; r++) {
      const row = [];
      for (let c = 0; c < COLS; c++) row.push(rng() > 0.45);
      grid.push(row);
    }
    // guarantee not-too-empty
    let on = 0; grid.forEach(r => r.forEach(c => { if (c) on++; }));
    if (on < 4) grid[Math.floor(rng() * GRID)][1] = true;
    const hue = Math.floor(rng() * 360);
    return { grid, hue, key, error: false };
  }

  // offspring keep the parent's EXACT pattern — only the colour changes, so a child
  // reads as "the same request, recoloured" rather than a different shape.
  function mutate(parent, salt) {
    const key = parent.key + ">" + salt;
    const rng = mulberry32(fnv(key));
    const grid = parent.grid.map(r => r.slice()); // identical shape to the parent
    const hue = (parent.hue + 70 + Math.floor(rng() * 220)) % 360; // distinct, well-separated hue
    return { grid, hue, key, error: false };
  }

  function err(desc) { return { grid: desc.grid, hue: desc.hue, key: desc.key + "!", error: true }; }

  // ---- render to dataURL (cached by key) — SOLID colour tile, no pattern ----
  const cache = {};
  function url(desc, px) {
    px = px || 48;
    const k = desc.key + "@" + px;
    if (cache[k]) return cache[k];
    const cv = document.createElement("canvas");
    cv.width = px; cv.height = px;
    const ctx = cv.getContext("2d");
    const inset = Math.round(px * 0.12);
    const area = px - inset * 2;
    const cs = area / GRID;
    // pixels only — symmetric on/off grid, single colour, transparent background
    ctx.fillStyle = `hsl(${desc.hue},66%,62%)`;
    for (let r = 0; r < GRID; r++) {
      for (let c = 0; c < COLS; c++) {
        if (!desc.grid[r][c]) continue;
        drawCell(ctx, inset + c * cs, inset + r * cs, cs);
        if (c < 2) { const mc = GRID - 1 - c; drawCell(ctx, inset + mc * cs, inset + r * cs, cs); }
      }
    }
    const u = cv.toDataURL();
    cache[k] = u; return u;
  }
  function drawCell(ctx, x, y, cs) { ctx.fillRect(Math.round(x), Math.round(y), Math.ceil(cs) + 0.6, Math.ceil(cs) + 0.6); }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  window.Identicon = { root, mutate, err, url };
})();
