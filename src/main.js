import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Chess } from 'chess.js';
import { createPiece } from './pieces.js';
import { loadPieceModels } from './models.js';
import { createSpace } from './space.js';

const MIN_THINK_MS = 500;
const CLICK_SLOP_PX = 6;

const HIGHLIGHT = {
  none: 0x000000,
  lastMove: 0xa07c00,
  selected: 0x18a86c,
  check: 0xd01414,
};

// ---------------------------------------------------------------- scene setup

const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05060d);

// Metal pieces need something to reflect; a studio-style environment gives the
// polished highlights seen on real gold and silver.
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.8;

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 500);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.enablePan = false;
controls.minDistance = 6;
controls.maxDistance = 30;
controls.maxPolarAngle = Math.PI * 0.6;

scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x1a1a2a, 0.5));

const sun = new THREE.DirectionalLight(0xffffff, 2.4);
sun.position.set(6, 12, 8);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = sun.shadow.camera.bottom = -7;
sun.shadow.camera.right = sun.shadow.camera.top = 7;
sun.shadow.camera.far = 40;
sun.shadow.bias = -0.0005;
scene.add(sun);

const updateSpace = createSpace(scene);

// ---------------------------------------------------------------------- board

// Everything that floats together. Board surface is y = 0, a1 is at (-3.5, 3.5).
const boardGroup = new THREE.Group();
scene.add(boardGroup);

const piecesGroup = new THREE.Group();
const markersGroup = new THREE.Group();
boardGroup.add(piecesGroup, markersGroup);

const squareMeshes = new Map(); // 'e4' -> Mesh

function squareName(file, rank) {
  return 'abcdefgh'[file] + (rank + 1);
}

function squareToPosition(square) {
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]) - 1;
  return new THREE.Vector3(file - 3.5, 0, 3.5 - rank);
}

// A glass board: tiles of real refracting glass, lightly frosted for the light
// squares and smoky black for the dark ones, resting on a clear slab.
function createBoard() {
  // Bevel-like gap between tiles: their edges catch the light, which is what
  // separates one square from the next.
  const tile = new THREE.BoxGeometry(0.97, 0.08, 0.97);
  for (let file = 0; file < 8; file++) {
    for (let rank = 0; rank < 8; rank++) {
      const dark = (file + rank) % 2 === 0;
      const mesh = new THREE.Mesh(
        tile,
        new THREE.MeshPhysicalMaterial({
          // Transmitted light is multiplied by the colour, so a mid grey gives
          // smoky black glass that still lets the sky through.
          color: dark ? 0x7c7c86 : 0xffffff,
          transmission: dark ? 0.95 : 0.98,
          roughness: dark ? 0.03 : 0.1,
          thickness: 0.2,
          ior: 1.2,
          // Kept low: strong reflections turn the board grey at shallow angles.
          specularIntensity: 0.5,
          envMapIntensity: 0.15,
        }),
      );
      const square = squareName(file, rank);
      mesh.position.copy(squareToPosition(square)).setY(-0.04);
      mesh.receiveShadow = true;
      mesh.userData.square = square;
      squareMeshes.set(square, mesh);
      boardGroup.add(mesh);
    }
  }

  // Clear slab the tiles sit on, a little larger than the playing area.
  const slab = new THREE.Mesh(
    new THREE.BoxGeometry(8.8, 0.2, 8.8),
    new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      transmission: 1,
      roughness: 0.03,
      thickness: 0.3,
      ior: 1.2,
      specularIntensity: 0.5,
      envMapIntensity: 0.15,
    }),
  );
  slab.position.y = -0.19;
  boardGroup.add(slab);

  const glow = new THREE.PointLight(0xffffff, 25, 20);
  glow.position.y = -4.5;
  boardGroup.add(glow);
}
createBoard();

// ------------------------------------------------------------------ animation

const tweens = [];

// Runs `update(k)` every frame with eased k going 0 -> 1 over `seconds`.
function tween(seconds, update) {
  return new Promise((resolve) => tweens.push({ elapsed: 0, seconds, update, resolve }));
}

function stepTweens(dt) {
  for (let i = tweens.length - 1; i >= 0; i--) {
    const t = tweens[i];
    t.elapsed += dt;
    const k = Math.min(t.elapsed / t.seconds, 1);
    t.update(k * k * (3 - 2 * k));
    if (k === 1) {
      tweens.splice(i, 1);
      t.resolve();
    }
  }
}

function slidePiece(piece, square, lift) {
  const from = piece.position.clone();
  const to = squareToPosition(square);
  return tween(0.4, (k) => {
    piece.position.lerpVectors(from, to, k);
    piece.position.y += Math.sin(Math.PI * k) * lift;
  });
}

function shrinkAway(piece) {
  return tween(0.3, (k) => piece.scale.setScalar(1 - k)).then(() => piecesGroup.remove(piece));
}

// ----------------------------------------------------------------- game state

const statusEl = document.getElementById('status');
const levelEl = document.getElementById('level');
const sideEl = document.getElementById('side');
const promotionEl = document.getElementById('promotion');
const modeEl = document.getElementById('mode');
const roomFormEl = document.getElementById('room-form');
const roomEl = document.getElementById('room');
const undoEl = document.getElementById('undo');

const chess = new Chess();
const pieceAt = new Map(); // 'e4' -> piece Group

const SIDE_NAME = { w: 'Silver', b: 'Gold' };

let mode = 'ai'; // 'ai' | 'local' | 'online'
let playerColor = 'w';
// Online session; `note` is shown instead of the turn when there is no game yet.
let socket = null;
let opponentPresent = false;
let onlineNote = 'Enter a room code to play online.';
let selected = null;
let targets = new Map(); // destination square -> legal moves landing there
let lastMove = null;
let animating = false;
let thinking = false;
let worker = null;
let searchId = 0;

function spawnPiece(type, color, square) {
  const piece = createPiece(type, color);
  piece.position.copy(squareToPosition(square));
  piece.userData.square = square;
  piecesGroup.add(piece);
  pieceAt.set(square, piece);
  return piece;
}

function rebuildPieces() {
  piecesGroup.clear();
  pieceAt.clear();
  for (const row of chess.board()) {
    for (const cell of row) {
      if (cell) spawnPiece(cell.type, cell.color, cell.square);
    }
  }
}

function relocate(from, to) {
  const piece = pieceAt.get(from);
  pieceAt.delete(from);
  pieceAt.set(to, piece);
  piece.userData.square = to;
  return piece;
}

// Mirrors a move already made on `chess` (a verbose chess.js move) in the scene.
async function animateMove(move) {
  animating = true;

  if (move.captured) {
    // En passant captures the pawn beside the mover, not on the target square.
    const capturedSquare = move.flags.includes('e') ? move.to[0] + move.from[1] : move.to;
    shrinkAway(pieceAt.get(capturedSquare));
    pieceAt.delete(capturedSquare);
  }

  const rank = move.from[1];
  if (move.flags.includes('k')) slidePiece(relocate('h' + rank, 'f' + rank), 'f' + rank, 0.2);
  if (move.flags.includes('q')) slidePiece(relocate('a' + rank, 'd' + rank), 'd' + rank, 0.2);

  const piece = relocate(move.from, move.to);
  await slidePiece(piece, move.to, move.piece === 'n' ? 1.1 : 0.3);

  if (move.promotion) {
    piecesGroup.remove(piece);
    spawnPiece(move.promotion, move.color, move.to);
  }

  animating = false;
}

function kingSquare(color) {
  for (const row of chess.board()) {
    for (const cell of row) {
      if (cell && cell.type === 'k' && cell.color === color) return cell.square;
    }
  }
  return null;
}

const quietMarker = new THREE.CylinderGeometry(0.15, 0.15, 0.02, 24);
const captureMarker = new THREE.TorusGeometry(0.4, 0.045, 8, 32).rotateX(Math.PI / 2);
const markerMaterial = new THREE.MeshBasicMaterial({
  color: 0x39e58c,
  transparent: true,
  opacity: 0.8,
});

function refreshHighlights() {
  for (const mesh of squareMeshes.values()) mesh.material.emissive.setHex(HIGHLIGHT.none);
  const tint = (square, hex) => squareMeshes.get(square).material.emissive.setHex(hex);

  if (lastMove) {
    tint(lastMove.from, HIGHLIGHT.lastMove);
    tint(lastMove.to, HIGHLIGHT.lastMove);
  }
  if (chess.isCheck()) tint(kingSquare(chess.turn()), HIGHLIGHT.check);
  if (selected) tint(selected, HIGHLIGHT.selected);

  markersGroup.clear();
  for (const [square, moves] of targets) {
    const marker = new THREE.Mesh(moves[0].captured ? captureMarker : quietMarker, markerMaterial);
    marker.position.copy(squareToPosition(square)).setY(0.02);
    marker.userData.square = square;
    marker.renderOrder = 2;
    markersGroup.add(marker);
  }
}

// Whether the person at this screen may move right now.
function isHumanTurn() {
  if (chess.isGameOver()) return false;
  if (mode === 'local') return true;
  if (mode === 'online' && !opponentPresent) return false;
  return chess.turn() === playerColor;
}

function refreshStatus() {
  let text;
  if (mode === 'online' && !opponentPresent) {
    text = onlineNote;
  } else if (chess.isCheckmate()) {
    const winner = chess.turn() === 'w' ? 'b' : 'w';
    if (mode === 'local') text = `Checkmate — ${SIDE_NAME[winner]} wins!`;
    else if (winner === playerColor) text = 'Checkmate — you win!';
    else text = mode === 'ai' ? 'Checkmate — the computer wins.' : 'Checkmate — you lose.';
  } else if (chess.isStalemate()) {
    text = 'Draw by stalemate.';
  } else if (chess.isGameOver()) {
    text = 'Draw.';
  } else {
    if (mode === 'local') text = `${SIDE_NAME[chess.turn()]} to move`;
    else if (chess.turn() === playerColor) text = 'Your move';
    else text = mode === 'ai' ? 'Computer is thinking…' : "Opponent's move";
    if (chess.isCheck()) text = `Check! ${text}`;
  }
  statusEl.textContent = text;
}

function select(square) {
  selected = square;
  targets = new Map();
  if (square) {
    for (const move of chess.moves({ square, verbose: true })) {
      if (!targets.has(move.to)) targets.set(move.to, []);
      targets.get(move.to).push(move);
    }
  }
  refreshHighlights();
}

function askPromotion() {
  promotionEl.hidden = false;
  return new Promise((resolve) => {
    promotionEl.onclick = (event) => {
      const choice = event.target.dataset.piece;
      if (!choice) return;
      promotionEl.hidden = true;
      resolve(choice);
    };
  });
}

async function playMove(spec) {
  const move = chess.move(spec);
  lastMove = move;
  select(null);
  refreshStatus();
  await animateMove(move);
}

async function onSquareClicked(square) {
  if (animating || thinking || !isHumanTurn()) return;
  if (!promotionEl.hidden) return;

  const moves = targets.get(square);
  if (moves) {
    const from = selected;
    const promotion = moves[0].promotion ? await askPromotion() : undefined;
    const spec = { from, to: square, promotion };
    if (mode === 'online') socket.send(JSON.stringify({ type: 'move', move: spec }));
    await playMove(spec);
    if (mode === 'ai' && !chess.isGameOver()) requestComputerMove();
    return;
  }

  // Whoever's turn it is owns the selectable pieces (both sides in local play).
  const piece = chess.get(square);
  select(piece && piece.color === chess.turn() && square !== selected ? square : null);
}

// ------------------------------------------------------------------- computer

function startWorker() {
  worker?.terminate();
  worker = new Worker(new URL('./ai.worker.js', import.meta.url), { type: 'module' });
}

function requestComputerMove() {
  const id = ++searchId;
  const startedAt = performance.now();
  thinking = true;
  refreshStatus();

  worker.onmessage = async ({ data }) => {
    if (data.id !== id || !data.move) return;
    // Keep a beat between the player's move and the reply so it can be followed.
    const wait = MIN_THINK_MS - (performance.now() - startedAt);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    if (id !== searchId) return;
    thinking = false;
    await playMove(data.move);
  };
  worker.postMessage({ id, fen: chess.fen(), level: levelEl.value });
}

// Drops any search in flight; its result would be for a position we have left.
function cancelComputerMove() {
  searchId++;
  thinking = false;
  startWorker();
}

function resetView() {
  // An undamped update flushes any leftover spin from the last drag, which
  // would otherwise keep turning the camera after it has been placed.
  controls.enableDamping = false;
  controls.update();
  controls.enableDamping = true;
  camera.position.set(0, 9, playerColor === 'w' ? 10 : -10);
  controls.target.set(0, 0, 0);
  controls.update();
}

// Resets the board. Online, the colour is assigned by the server and kept.
function newGame() {
  cancelComputerMove();
  tweens.length = 0;
  animating = false;
  promotionEl.hidden = true;
  if (mode === 'ai') playerColor = sideEl.value;
  else if (mode === 'local') playerColor = 'w';
  chess.reset();
  lastMove = null;
  rebuildPieces();
  select(null);
  refreshStatus();
  resetView();
  if (mode === 'ai' && chess.turn() !== playerColor) requestComputerMove();
}

// Against the computer, takes back your last move with its reply; in local play,
// just the last move. Not available online.
function undo() {
  if (mode === 'online' || animating || !promotionEl.hidden) return;
  cancelComputerMove();
  if (mode === 'local' || chess.turn() === playerColor) chess.undo();
  if (mode === 'ai') chess.undo();
  lastMove = chess.history({ verbose: true }).at(-1) ?? null;
  rebuildPieces();
  select(null);
  refreshStatus();
  if (mode === 'ai' && chess.turn() !== playerColor) requestComputerMove();
}

// ---------------------------------------------------------------------- online

function leaveRoom() {
  if (socket) {
    socket.onclose = null;
    socket.close();
  }
  socket = null;
  opponentPresent = false;
  onlineNote = 'Enter a room code to play online.';
}

function joinRoom(room) {
  leaveRoom();
  onlineNote = 'Connecting…';
  refreshStatus();

  // The relay (`npm run server`) runs on the same host as the page.
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${scheme}://${location.hostname}:8787`);
  socket = ws;

  ws.onopen = () => ws.send(JSON.stringify({ type: 'join', room }));
  ws.onclose = () => {
    opponentPresent = false;
    onlineNote = 'Could not reach the game server. Is `npm run server` running?';
    refreshStatus();
  };
  ws.onmessage = async ({ data }) => {
    const message = JSON.parse(data);
    switch (message.type) {
      case 'joined':
        playerColor = message.color;
        opponentPresent = message.opponent;
        onlineNote = `Room “${room}” — waiting for an opponent…`;
        newGame();
        break;
      case 'opponent-joined':
        opponentPresent = true;
        newGame();
        break;
      case 'opponent-left':
        opponentPresent = false;
        onlineNote = 'Your opponent left. Waiting for a new one…';
        refreshStatus();
        break;
      case 'reset':
        newGame();
        break;
      case 'full':
        onlineNote = 'That room is full.';
        leaveRoom();
        refreshStatus();
        break;
      case 'move':
        while (animating) await new Promise((resolve) => setTimeout(resolve, 50));
        try {
          await playMove(message.move);
        } catch {
          // An illegal move can only come from a broken or modified client.
        }
        break;
    }
  };
}

function applyMode() {
  mode = modeEl.value;
  leaveRoom();
  for (const el of document.querySelectorAll('[data-modes]')) {
    el.hidden = el.dataset.modes !== mode;
  }
  undoEl.disabled = mode === 'online';
  newGame();
}

document.getElementById('new-game').addEventListener('click', () => {
  if (mode === 'online' && socket?.readyState === WebSocket.OPEN && opponentPresent) {
    socket.send(JSON.stringify({ type: 'reset' }));
  }
  newGame();
});
undoEl.addEventListener('click', undo);
sideEl.addEventListener('change', newGame);
modeEl.addEventListener('change', applyMode);
roomFormEl.addEventListener('submit', (event) => {
  event.preventDefault();
  const room = roomEl.value.trim();
  if (room) joinRoom(room);
});

// ---------------------------------------------------------------------- input

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const pickables = [piecesGroup, markersGroup, ...squareMeshes.values()];

function pickSquare(event) {
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);

  const hit = raycaster.intersectObjects(pickables, true)[0];
  for (let object = hit?.object; object; object = object.parent) {
    if (object.userData.square) return object.userData.square;
  }
  return null;
}

// A press only counts as a click if the pointer barely moved; otherwise it was
// an orbit drag.
let pressed = null;
canvas.addEventListener('pointerdown', (event) => {
  pressed = event.button === 0 ? { x: event.clientX, y: event.clientY } : null;
});
canvas.addEventListener('pointerup', (event) => {
  if (!pressed) return;
  const moved = Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y);
  pressed = null;
  if (moved > CLICK_SLOP_PX) return;
  const square = pickSquare(event);
  if (square) onSquareClicked(square);
  else select(null);
});

// ----------------------------------------------------------------------- loop

function resize() {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

let previousMs = performance.now();
renderer.setAnimationLoop((nowMs) => {
  const dt = Math.min(Math.max(nowMs - previousMs, 0) / 1000, 0.1);
  previousMs = nowMs;
  const t = nowMs / 1000;

  // Gentle bob and sway so the board feels like it is floating.
  boardGroup.position.y = Math.sin(t * 0.8) * 0.12;
  boardGroup.rotation.x = Math.sin(t * 0.5) * 0.012;
  boardGroup.rotation.z = Math.cos(t * 0.4) * 0.012;

  updateSpace(t);
  stepTweens(dt);
  controls.update();
  renderer.render(scene, camera);
});

statusEl.textContent = 'Loading pieces…';
loadPieceModels()
  .catch((error) => console.warn('Sculpted pieces failed to load; using built-in shapes.', error))
  .then(applyMode);
