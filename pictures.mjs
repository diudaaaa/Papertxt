export function findPictureRegions(imageData, lines, pageWidth, pageHeight) {
  const { data, width, height } = imageData;
  const cell = Math.max(10, Math.ceil(Math.max(width, height) / 100));
  const columns = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const masked = new Uint8Array(columns * rows);
  for (const line of lines) {
    const left = Math.max(0, Math.floor(((line.x / pageWidth) * width - 5) / cell));
    const right = Math.min(columns - 1, Math.ceil(((line.right / pageWidth) * width + 5) / cell));
    const top = Math.max(0, Math.floor(((line.y / pageHeight) * height - 5) / cell));
    const bottom = Math.min(rows - 1, Math.ceil(((line.bottom / pageHeight) * height + 5) / cell));
    for (let y = top; y <= bottom; y += 1) {
      for (let x = left; x <= right; x += 1) masked[y * columns + x] = 1;
    }
  }
  const active = new Uint8Array(columns * rows);
  for (let row = 1; row < rows - 1; row += 1) {
    for (let column = 1; column < columns - 1; column += 1) {
      const index = row * columns + column;
      if (masked[index]) continue;
      let dark = 0;
      let count = 0;
      for (let y = row * cell; y < Math.min((row + 1) * cell, height); y += 2) {
        for (let x = column * cell; x < Math.min((column + 1) * cell, width); x += 2) {
          const offset = (y * width + x) * 4;
          const gray = data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114;
          if (gray < 210) dark += 1;
          count += 1;
        }
      }
      if (dark / count > 0.12) active[index] = 1;
    }
  }

  const seen = new Uint8Array(active.length);
  const regions = [];
  for (let start = 0; start < active.length; start += 1) {
    if (!active[start] || seen[start]) continue;
    const stack = [start];
    seen[start] = 1;
    let minX = columns;
    let minY = rows;
    let maxX = 0;
    let maxY = 0;
    let cells = 0;
    while (stack.length) {
      const index = stack.pop();
      const row = Math.floor(index / columns);
      const column = index % columns;
      minX = Math.min(minX, column);
      maxX = Math.max(maxX, column);
      minY = Math.min(minY, row);
      maxY = Math.max(maxY, row);
      cells += 1;
      for (const neighbor of [index - 1, index + 1, index - columns, index + columns]) {
        if (neighbor < 0 || neighbor >= active.length || seen[neighbor] || !active[neighbor]) continue;
        if (Math.abs(neighbor % columns - column) + Math.abs(Math.floor(neighbor / columns) - row) !== 1) continue;
        seen[neighbor] = 1;
        stack.push(neighbor);
      }
    }
    const regionWidth = (maxX - minX + 1) * cell;
    const regionHeight = (maxY - minY + 1) * cell;
    if (regionWidth < width * 0.26 || regionHeight < height * 0.1 ||
        regionWidth * regionHeight < width * height * 0.042 || cells < 14) continue;
    const left = Math.max(0, minX * cell - cell);
    const top = Math.max(0, minY * cell - cell);
    regions.push({
      x: left,
      y: top,
      width: Math.min(width - left, regionWidth + 2 * cell),
      height: Math.min(height - top, regionHeight + 2 * cell)
    });
  }
  return regions.slice(0, 4).sort((a, b) => a.y - b.y);
}
