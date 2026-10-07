import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

// The carved marble set in public/models: one OBJ mesh and one photo texture per
// piece. The two knights are different sculptures, one per side.
const MODEL_NAMES = { p: 'pawn', r: 'rook', b: 'bishop', q: 'queen', k: 'king' };
const KNIGHT_MODELS = { w: 'knight_light', b: 'knight_dark' };

// The models are in metres (king about 0.1 tall); this sizes them for a 1x1 square.
const MODEL_SCALE = 16;

const models = new Map(); // model name -> { geometry, texture }
const materials = new Map(); // `${name}:${color}` -> material

// Turns the marble photo into a greyscale pattern, so its veining and carved
// shading can tint the gold or silver rather than replace it.
function marblePattern(image) {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = pixels.data;

  // Stretch each texture to the same range: dark and light stones then give
  // equally bright metal, differing only in their pattern.
  let low = 255;
  let high = 0;
  for (let i = 0; i < data.length; i += 4) {
    const grey = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    data[i] = grey;
    if (grey < low) low = grey;
    if (grey > high) high = grey;
  }
  const range = Math.max(high - low, 1);
  for (let i = 0; i < data.length; i += 4) {
    const level = (data[i] - low) / range;
    data[i] = data[i + 1] = data[i + 2] = 255 * (0.35 + 0.65 * Math.sqrt(level));
    data[i + 3] = 255;
  }
  ctx.putImageData(pixels, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

async function loadModel(name) {
  const [object, image] = await Promise.all([
    new OBJLoader().loadAsync(`models/${name}.obj`),
    new THREE.ImageLoader().loadAsync(`models/${name}.png`),
  ]);
  let geometry;
  object.traverse((child) => {
    if (child.isMesh) geometry = child.geometry;
  });
  // The files carry no normals, so the loader makes every triangle flat.
  // Welding the vertices back together lets the surface shade smoothly.
  geometry.deleteAttribute('normal');
  geometry = mergeVertices(geometry);
  geometry.computeVertexNormals();
  geometry.scale(MODEL_SCALE, MODEL_SCALE, MODEL_SCALE);
  models.set(name, { geometry, texture: marblePattern(image) });
}

/** Loads every sculpted piece. Until this resolves, `createModelPiece` returns null. */
export async function loadPieceModels() {
  const names = [...Object.values(MODEL_NAMES), ...Object.values(KNIGHT_MODELS)];
  try {
    await Promise.all(names.map(loadModel));
  } catch (error) {
    // All or nothing: a half-loaded set would mix two styles of piece.
    models.clear();
    throw error;
  }
}

function materialFor(name, color, baseMaterial) {
  const key = `${name}:${color}`;
  if (!materials.has(key)) {
    const { texture } = models.get(name);
    const material = baseMaterial.clone();
    material.map = texture;
    material.bumpMap = texture;
    material.bumpScale = 1.5;
    material.roughness = 0.3;
    material.metalness = 0.9;
    materials.set(key, material);
  }
  return materials.get(key);
}

/**
 * Builds a sculpted piece in the side's metal (`baseMaterial` supplies the
 * colour), or returns null if the models are not loaded.
 */
export function createModelPiece(type, color, baseMaterial) {
  if (!models.size) return null;
  const name = type === 'n' ? KNIGHT_MODELS[color] : MODEL_NAMES[type];
  const mesh = new THREE.Mesh(models.get(name).geometry, materialFor(name, color, baseMaterial));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const piece = new THREE.Group();
  piece.add(mesh);
  // Knights face the opponent (white towards -Z, black towards +Z), turned
  // partly aside so their profile is readable from behind the board. The light
  // knight is sculpted facing +X and the dark one facing -X.
  if (type === 'n') piece.rotation.y = color === 'w' ? Math.PI / 2 - 0.7 : Math.PI / 2 + 0.7;
  return piece;
}
