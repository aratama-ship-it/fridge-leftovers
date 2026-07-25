#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ATLAS_WIDTH = 1254;
const ATLAS_HEIGHT = 940;
const GRID_COLUMNS = 4;
const GRID_ROWS = 3;
const DEFAULT_OCCUPANCY = 0.68;
const ALPHA_BOUNDARY = 32;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");

function usage(message = "") {
  if (message) console.error(message);
  console.error(
    "使い方: node scripts/build-atlas.mjs <シート番号> <id1> ... <id12> "
      + "[--occupancy 0.68] [--source-dir <dir>] [--output <png>]"
  );
  process.exit(1);
}

function parseArguments(argv) {
  if (!argv.length) usage();
  const sheet = String(argv[0]).padStart(2, "0");
  const ids = [];
  let occupancy = DEFAULT_OCCUPANCY;
  let sourceDirectory;
  let output;

  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--occupancy") {
      occupancy = Number(argv[index += 1]);
    } else if (argument === "--source-dir") {
      sourceDirectory = argv[index += 1];
    } else if (argument === "--output") {
      output = argv[index += 1];
    } else if (argument.startsWith("--")) {
      usage(`不明なオプションです: ${argument}`);
    } else {
      ids.push(argument);
    }
  }

  if (ids.length !== GRID_COLUMNS * GRID_ROWS) {
    usage(`idはマス順に12件必要です（現在${ids.length}件）`);
  }
  if (!Number.isFinite(occupancy) || occupancy < 0.6 || occupancy > 0.75) {
    usage("--occupancy は 0.60〜0.75 の範囲で指定してください");
  }

  return {
    sheet,
    ids,
    occupancy,
    sourceDirectory: path.resolve(
      projectRoot,
      sourceDirectory || `assets/atlas-src/${sheet}`
    ),
    output: path.resolve(
      projectRoot,
      output || `assets/ingredient-atlas-${sheet}.png`
    )
  };
}

function paethPredictor(left, up, upperLeft) {
  const prediction = left + up - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const upDistance = Math.abs(prediction - up);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left;
  if (upDistance <= upperLeftDistance) return up;
  return upperLeft;
}

function decodePng(filePath) {
  const png = fs.readFileSync(filePath);
  if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error(`${filePath}: PNGではありません`);
  }

  let offset = 8;
  let width;
  let height;
  let bitDepth;
  let colorType;
  let interlace;
  const compressedParts = [];

  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      compressedParts.push(data);
    } else if (type === "IEND") {
      break;
    }
  }

  if (
    !width
    || !height
    || bitDepth !== 8
    || colorType !== 6
    || interlace !== 0
  ) {
    throw new Error(
      `${filePath}: 8-bit RGBA・非インターレースPNGだけを入力できます`
    );
  }

  const bytesPerPixel = 4;
  const rowBytes = width * bytesPerPixel;
  const inflated = zlib.inflateSync(Buffer.concat(compressedParts));
  const expectedLength = height * (rowBytes + 1);
  if (inflated.length !== expectedLength) {
    throw new Error(`${filePath}: PNGデータ長が不正です`);
  }

  const pixels = Buffer.alloc(width * height * bytesPerPixel);
  let sourceOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[sourceOffset];
    sourceOffset += 1;
    const rowOffset = y * rowBytes;
    for (let x = 0; x < rowBytes; x += 1) {
      const raw = inflated[sourceOffset + x];
      const left = x >= bytesPerPixel ? pixels[rowOffset + x - bytesPerPixel] : 0;
      const up = y > 0 ? pixels[rowOffset - rowBytes + x] : 0;
      const upperLeft = y > 0 && x >= bytesPerPixel
        ? pixels[rowOffset - rowBytes + x - bytesPerPixel]
        : 0;
      let value;
      if (filter === 0) value = raw;
      else if (filter === 1) value = raw + left;
      else if (filter === 2) value = raw + up;
      else if (filter === 3) value = raw + Math.floor((left + up) / 2);
      else if (filter === 4) value = raw + paethPredictor(left, up, upperLeft);
      else throw new Error(`${filePath}: 未対応のPNGフィルター ${filter}`);
      pixels[rowOffset + x] = value & 255;
    }
    sourceOffset += rowBytes;
  }

  return { width, height, pixels };
}

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  }
  return crc >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const value of buffer) {
    crc = crcTable[(crc ^ value) & 255] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return chunk;
}

function encodePng({ width, height, pixels }) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  const rowBytes = width * 4;
  const raw = Buffer.alloc(height * (rowBytes + 1));
  for (let y = 0; y < height; y += 1) {
    const rawRow = y * (rowBytes + 1);
    raw[rawRow] = 0;
    pixels.copy(raw, rawRow + 1, y * rowBytes, (y + 1) * rowBytes);
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function alphaBounds(image, threshold = ALPHA_BOUNDARY) {
  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const alpha = image.pixels[(y * image.width + x) * 4 + 3];
      if (alpha < threshold) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < minX || maxY < minY) return null;
  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1
  };
}

function samplePremultiplied(image, x, y) {
  const x0 = Math.max(0, Math.min(image.width - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(image.height - 1, Math.floor(y)));
  const x1 = Math.max(0, Math.min(image.width - 1, x0 + 1));
  const y1 = Math.max(0, Math.min(image.height - 1, y0 + 1));
  const tx = x - Math.floor(x);
  const ty = y - Math.floor(y);
  const samples = [
    [x0, y0, (1 - tx) * (1 - ty)],
    [x1, y0, tx * (1 - ty)],
    [x0, y1, (1 - tx) * ty],
    [x1, y1, tx * ty]
  ];
  let alpha = 0;
  let red = 0;
  let green = 0;
  let blue = 0;
  for (const [sampleX, sampleY, weight] of samples) {
    const index = (sampleY * image.width + sampleX) * 4;
    const sampleAlpha = image.pixels[index + 3] / 255;
    const weightedAlpha = sampleAlpha * weight;
    alpha += weightedAlpha;
    red += image.pixels[index] * weightedAlpha;
    green += image.pixels[index + 1] * weightedAlpha;
    blue += image.pixels[index + 2] * weightedAlpha;
  }
  if (alpha <= 0) return [0, 0, 0, 0];
  return [
    Math.round(red / alpha),
    Math.round(green / alpha),
    Math.round(blue / alpha),
    Math.round(alpha * 255)
  ];
}

function compositePixel(destination, offset, source) {
  const sourceAlpha = source[3] / 255;
  if (sourceAlpha <= 0) return;
  const destinationAlpha = destination[offset + 3] / 255;
  const outputAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
  if (outputAlpha <= 0) return;
  for (let channel = 0; channel < 3; channel += 1) {
    destination[offset + channel] = Math.round(
      (
        source[channel] * sourceAlpha
        + destination[offset + channel] * destinationAlpha * (1 - sourceAlpha)
      ) / outputAlpha
    );
  }
  destination[offset + 3] = Math.round(outputAlpha * 255);
}

function placeImage(atlas, source, bounds, cell, occupancy) {
  const cellWidth = cell.right - cell.left;
  const cellHeight = cell.bottom - cell.top;
  const targetMaximum = Math.min(cellWidth, cellHeight) * occupancy;
  const scale = targetMaximum / Math.max(bounds.width, bounds.height);
  const destinationWidth = Math.max(1, Math.round(bounds.width * scale));
  const destinationHeight = Math.max(1, Math.round(bounds.height * scale));
  const destinationX = Math.round((cell.left + cell.right - destinationWidth) / 2);
  const destinationY = Math.round((cell.top + cell.bottom - destinationHeight) / 2);

  for (let y = 0; y < destinationHeight; y += 1) {
    const sourceY = bounds.y + ((y + 0.5) / destinationHeight) * bounds.height - 0.5;
    for (let x = 0; x < destinationWidth; x += 1) {
      const sourceX = bounds.x + ((x + 0.5) / destinationWidth) * bounds.width - 0.5;
      const sampled = samplePremultiplied(source, sourceX, sourceY);
      const atlasX = destinationX + x;
      const atlasY = destinationY + y;
      const atlasOffset = (atlasY * atlas.width + atlasX) * 4;
      compositePixel(atlas.pixels, atlasOffset, sampled);
    }
  }

  return {
    x: destinationX,
    y: destinationY,
    width: destinationWidth,
    height: destinationHeight,
    occupancy: Math.max(destinationWidth / cellWidth, destinationHeight / cellHeight)
  };
}

function gridCell(index) {
  const column = index % GRID_COLUMNS;
  const row = Math.floor(index / GRID_COLUMNS);
  return {
    column,
    row,
    left: Math.round(column * ATLAS_WIDTH / GRID_COLUMNS),
    right: Math.round((column + 1) * ATLAS_WIDTH / GRID_COLUMNS),
    top: Math.round(row * ATLAS_HEIGHT / GRID_ROWS),
    bottom: Math.round((row + 1) * ATLAS_HEIGHT / GRID_ROWS)
  };
}

const options = parseArguments(process.argv.slice(2));
const atlas = {
  width: ATLAS_WIDTH,
  height: ATLAS_HEIGHT,
  pixels: Buffer.alloc(ATLAS_WIDTH * ATLAS_HEIGHT * 4)
};

const placements = options.ids.map((id, index) => {
  const input = path.join(options.sourceDirectory, `${id}.png`);
  if (!fs.existsSync(input)) throw new Error(`入力画像がありません: ${input}`);
  const image = decodePng(input);
  const bounds = alphaBounds(image);
  if (!bounds) throw new Error(`不透明な被写体がありません: ${input}`);
  const cell = gridCell(index);
  const placement = placeImage(atlas, image, bounds, cell, options.occupancy);
  return { id, ...cell, ...placement };
});

fs.mkdirSync(path.dirname(options.output), { recursive: true });
fs.writeFileSync(options.output, encodePng(atlas));

const decodedOutput = decodePng(options.output);
const corners = [
  3,
  (decodedOutput.width - 1) * 4 + 3,
  ((decodedOutput.height - 1) * decodedOutput.width) * 4 + 3,
  (decodedOutput.width * decodedOutput.height - 1) * 4 + 3
].map((offset) => decodedOutput.pixels[offset]);
if (corners.some((alpha) => alpha !== 0)) {
  throw new Error("出力画像の四隅が完全透過ではありません");
}

console.log(`${path.relative(projectRoot, options.output)} を作成しました`);
console.log(`${ATLAS_WIDTH}x${ATLAS_HEIGHT} RGBA / 四隅完全透過`);
placements.forEach((placement) => {
  console.log(
    `${placement.row},${placement.column} ${placement.id}: `
      + `${placement.width}x${placement.height}px / `
      + `占有率 ${(placement.occupancy * 100).toFixed(1)}%`
  );
});
