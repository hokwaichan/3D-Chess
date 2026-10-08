import * as THREE from 'three';

// The computer's avatar: a pale, bald giant who looms behind its side of the
// board and moves its pieces by hand. Only the waist up exists; the rest is
// lost in a bank of mist. It is built from primitives at load time and drawn
// as a translucent pencil sketch.

const { damp, smoothstep } = THREE.MathUtils;

const UPPER = 4.0; // shoulder to elbow
const FOREARM = 3.9; // elbow to wrist
// Body space has its origin at the waist; the figure faces +Z.
const WAIST = new THREE.Vector3(0, -0.2, -6.6);
const SHOULDER = new THREE.Vector3(2.4, 4.75, 0);
const NECK_Y = 5.95;
const HEAD_Y = 1.45; // head centre above the neck pivot

// Finger curls from index to little finger, then the thumb.
const POSES = {
  rest: [0.25, 0.3, 0.35, 0.4, 0.2],
  open: [0.3, 0.3, 0.35, 0.4, 0.1],
  grip: [0.75, 0.8, 0.9, 1.0, 0.6],
  point: [0, 1.5, 1.5, 1.5, 0.9],
};
// Where a pinched piece sits, measured from the wrist along the fingers and
// out of the palm.
const GRIP_ALONG = 1.25;
const GRIP_OUT = 0.5;

// The figure is drawn rather than lit, like a pencil sketch on white paper: ink
// gathers along the outline and in the shadows, with a grain to it, and the
// paper in between lets the sky show through.
const skin = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  uniforms: {
    uLight: { value: new THREE.Vector3() },
    uOpacity: { value: 0.8 },
  },
  vertexShader: /* glsl */ `
    varying vec3 vNormal;
    varying vec3 vWorld;
    varying vec3 vLocal;
    void main() {
      vLocal = position;
      vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
      vNormal = normalize(mat3(modelMatrix) * normal);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform vec3 uLight;
    uniform float uOpacity;
    varying vec3 vNormal;
    varying vec3 vWorld;
    varying vec3 vLocal;

    float hash(vec3 p) {
      p = fract(p * 0.3183099 + 0.1);
      p *= 17.0;
      return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
    }

    float noise(vec3 x) {
      vec3 i = floor(x);
      vec3 f = fract(x);
      f = f * f * (3.0 - 2.0 * f);
      return mix(
        mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x),
            mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
        mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x),
            mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y),
        f.z);
    }

    void main() {
      vec3 n = normalize(vNormal);
      float facing = abs(dot(n, normalize(cameraPosition - vWorld)));

      float grain = noise(vLocal * 26.0);
      // Long diagonal streaks, like the strokes of a pencil laid on its side.
      float hatch = noise(vec3((vLocal.x + vLocal.y) * 30.0, (vLocal.x - vLocal.y) * 2.5, vLocal.z * 6.0));

      float outline = smoothstep(0.55, 0.18, facing) * (0.6 + 0.4 * grain);
      float lit = dot(n, uLight) * 0.5 + 0.5;
      float shadow = smoothstep(0.5, 0.12, lit) * (0.25 + 0.45 * hatch);
      float inked = clamp(max(outline, shadow), 0.0, 1.0);

      vec3 paper = vec3(0.97, 0.97, 1.0) * (0.95 + 0.05 * grain);
      vec3 color = mix(paper, vec3(0.1, 0.1, 0.15), inked);
      gl_FragColor = vec4(color, mix(uOpacity, 0.95, inked));
      #include <colorspace_fragment>
    }
  `,
});
// Drawn first, into the depth buffer only, so that the see-through body shows
// what lies behind the figure and never its own far side or insides.
const depthOnly = new THREE.MeshBasicMaterial({
  colorWrite: false,
  transparent: true,
  // A hair further away, so the surface drawn over it always passes the depth test.
  polygonOffset: true,
  polygonOffsetUnits: 2,
});

// Details are drawn on top of the skin in layers.
const drawn = (color, opacity) =>
  new THREE.MeshBasicMaterial({
    color,
    opacity,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
const ink = drawn(0x3b3d4f, 0.85);
const smudge = drawn(0x3b3d4f, 0.22);
const blank = drawn(0xffffff, 0.96);
const maw = drawn(0x2a2b3a, 0.92);

// A smooth tube along Y with an elliptical cross-section that changes on the
// way up. `sections` are [y, radiusX, radiusZ], listed bottom to top.
function column(sections, radial = 32, steps = 48) {
  const sizes = new THREE.CatmullRomCurve3(sections.map(([y, rx, rz]) => new THREE.Vector3(rx, y, rz)));
  const positions = [];
  const indices = [];
  for (let i = 0; i <= steps; i++) {
    const { x: rx, y, z: rz } = sizes.getPoint(i / steps);
    for (let j = 0; j < radial; j++) {
      const a = (j / radial) * 2 * Math.PI;
      positions.push(Math.cos(a) * rx, y, Math.sin(a) * rz);
    }
  }
  for (let i = 0; i < steps; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * radial + j;
      const b = i * radial + ((j + 1) % radial);
      indices.push(a, a + radial, b, b, a + radial, b + radial);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

const blob = (rx, ry, rz, x, y, z) => new THREE.SphereGeometry(1, 32, 24).scale(rx, ry, rz).translate(x, y, z);

function part(geometry) {
  const mesh = new THREE.Mesh(geometry, depthOnly);
  mesh.renderOrder = 10;
  mesh.castShadow = true;
  const surface = new THREE.Mesh(geometry, skin);
  surface.renderOrder = 11;
  mesh.add(surface);
  return mesh;
}

// -------------------------------------------------------------------- drawing

// Flat [x, y] outlines are wrapped onto a body part: `surface(x, y)` gives the
// depth of its front at that point. Higher layers sit on top of lower ones.
function wrap(surface, flat, indices, layer, material) {
  const positions = [];
  for (let i = 0; i < flat.length; i += 2) {
    positions.push(flat[i], flat[i + 1], surface(flat[i], flat[i + 1]) + 0.012 * (layer + 1));
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 12 + layer;
  return mesh;
}

// A pencil line through `points`, thinning towards both ends.
function stroke(surface, points, width = 0.03, layer = 3, material = ink) {
  const curve = new THREE.SplineCurve(points.map(([x, y]) => new THREE.Vector2(x, y)));
  const steps = points.length * 6;
  const flat = [];
  const indices = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const p = curve.getPoint(t);
    const tangent = curve.getTangent(t);
    const half = (width / 2) * (0.2 + 0.8 * Math.sin(Math.PI * t) ** 0.6);
    flat.push(p.x - tangent.y * half, p.y + tangent.x * half, p.x + tangent.y * half, p.y - tangent.x * half);
    if (i < steps) indices.push(2 * i, 2 * i + 1, 2 * i + 2, 2 * i + 1, 2 * i + 3, 2 * i + 2);
  }
  return wrap(surface, flat, indices, layer, material);
}

// ----------------------------------------------------------------------- face

// Front surface of the head (cranium, jaw and nose) at a point on the face, in
// head space.
function faceDepth(x, y) {
  const cranium = 1 - (x / 1.05) ** 2 - (y / 1.3) ** 2;
  const jaw = 1 - (x / 0.82) ** 2 - ((y + 0.75) / 0.85) ** 2;
  const nose = 1 - (x / 0.14) ** 2 - ((y + 0.42) / 0.32) ** 2;
  return Math.max(
    cranium > 0 ? 1.2 * Math.sqrt(cranium) : 0,
    jaw > 0 ? 0.15 + 0.95 * Math.sqrt(jaw) : 0,
    nose > 0 ? 1.08 + 0.22 * Math.sqrt(nose) : 0,
  );
}

// A lens- or crescent-shaped patch on the face, `w` to either side of its
// centre, bulging to `top` and `bottom` in the middle.
function mark(material, w, top, bottom, cx, cy, tilt = 0, layer = 1) {
  const cols = 20;
  const rows = 4;
  const cos = Math.cos(tilt);
  const sin = Math.sin(tilt);
  const flat = [];
  const indices = [];
  for (let i = 0; i <= cols; i++) {
    const u = (i / cols) * 2 - 1;
    for (let j = 0; j <= rows; j++) {
      const lx = u * w;
      const ly = (bottom + ((top - bottom) * j) / rows) * (1 - u * u);
      flat.push(cx + lx * cos - ly * sin, cy + lx * sin + ly * cos);
    }
  }
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const a = i * (rows + 1) + j;
      const b = a + rows + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return wrap(faceDepth, flat, indices, layer, material);
}

const line = (points, width, layer) => stroke(faceDepth, points, width, layer);

// Points along one edge of a `mark` with the same placement, for outlining it.
// `reach` > 1 carries the line past the corners.
function edge(w, bulge, cx, cy, tilt = 0, reach = 1) {
  const cos = Math.cos(tilt);
  const sin = Math.sin(tilt);
  return [-1, -0.5, 0, 0.5, 1].map((u) => {
    const lx = u * w * reach;
    const ly = bulge * (1 - u * u);
    return [cx + lx * cos - ly * sin, cy + lx * sin + ly * cos];
  });
}

// A blank white eye under a heavy upper lid.
function eye(s, cy, tilt, w, top, bottom) {
  const cx = s * 0.43;
  return [
    mark(blank, w, top, bottom, cx, cy, tilt),
    line(edge(w, top, cx, cy, tilt, 1.1), 0.055),
    line(edge(w, bottom, cx, cy, tilt), 0.02),
  ];
}

const brow = (s, cy, tilt, arch, width) => line(edge(0.34, arch, s * 0.44, cy, tilt), width);

// An open mouth: the dark inside, outlined by the lips.
function mouth(w, top, bottom, cy) {
  return [
    mark(maw, w, top, bottom, 0, cy),
    line(edge(w, top, 0, cy, 0, 1.04), 0.04),
    line(edge(w, bottom, 0, cy, 0, 1.04), 0.035),
  ];
}

// A row of teeth filling the given patch, with the gaps between them drawn in.
function teeth(w, top, bottom, cy, count) {
  const gaps = [];
  for (let i = 1; i < count; i++) {
    const u = (i / count) * 2 - 1;
    const arch = 1 - u * u;
    gaps.push(line([[u * w, cy + top * arch], [u * w, cy + bottom * arch]], 0.016, 4));
  }
  return [mark(blank, w, top, bottom, 0, cy, 0, 2), ...gaps];
}

const sides = (build) => [1, -1].flatMap(build);

// What every expression shares: the nose, drawn with its shadow to one side.
const FEATURES = () => [
  line([[0.09, -0.12], [0.13, -0.42], [0.17, -0.64]], 0.025),
  line([[-0.17, -0.66], [-0.07, -0.76], [0.06, -0.76], [0.18, -0.66]], 0.03),
  mark(smudge, 0.3, 0.1, -0.06, -0.23, -0.5, 1.25, 0),
  // Hollow under the lower lip.
  mark(smudge, 0.2, 0.02, -0.07, 0, -1.3, 0, 0),
];

// The expressions. `s` is +1 / -1 for the two sides of the face.
const FACES = {
  // Sly, closed-mouth smile: the resting face.
  smirk: () => [
    ...sides((s) => [
      ...eye(s, -0.08, s * 0.15, 0.27, 0.08, -0.05),
      brow(s, 0.2, s * 0.2, 0.05, 0.05),
      line([[s * 0.2, -0.62], [s * 0.4, -0.8], [s * 0.5, -0.98]], 0.018),
    ]),
    line([[-0.48, -0.92], [-0.2, -1.03], [0.15, -1.04], [0.45, -0.9], [0.54, -0.82]], 0.04),
    line([[-0.15, -1.15], [0, -1.18], [0.15, -1.15]], 0.02),
  ],
  // Wide, staring, ear-to-ear grin.
  grin: () => [
    ...sides((s) => [
      mark(smudge, 0.38, 0.27, -0.22, s * 0.43, -0.06, 0, 0),
      ...eye(s, -0.06, s * 0.05, 0.27, 0.17, -0.14),
      mark(ink, 0.065, 0.065, -0.065, s * 0.41, -0.05, 0, 2),
      mark(blank, 0.035, 0.035, -0.035, s * 0.41, -0.05, 0, 3),
      brow(s, 0.34, s * 0.12, 0.03, 0.05),
      line([[s * 0.7, -0.58], [s * 0.76, -0.72], [s * 0.7, -0.86]], 0.025),
      line([[s * 0.2, -0.6], [s * 0.45, -0.66], [s * 0.64, -0.6]], 0.018),
    ]),
    ...mouth(0.68, -0.18, -0.62, -0.72),
    ...teeth(0.62, -0.19, -0.34, -0.72, 10),
  ],
  // Head-back cackle with every tooth showing.
  laugh: () => [
    ...sides((s) => [
      ...eye(s, -0.1, -s * 0.1, 0.26, 0.05, -0.03),
      brow(s, 0.3, -s * 0.12, 0.09, 0.045),
      line([[s * 0.2, -0.6], [s * 0.5, -0.72], [s * 0.7, -0.95]], 0.022),
      line([[s * 0.2, -0.22], [s * 0.45, -0.27], [s * 0.66, -0.2]], 0.015),
    ]),
    ...mouth(0.6, -0.03, -0.6, -0.78),
    ...teeth(0.54, -0.05, -0.2, -0.78, 8),
    ...teeth(0.38, -0.46, -0.56, -0.78, 6),
  ],
  // Scowl with bared teeth and a knotted brow.
  angry: () => [
    ...sides((s) => [
      ...eye(s, -0.1, s * 0.22, 0.3, 0.07, -0.06),
      brow(s, 0.1, s * 0.42, 0.05, 0.075),
      // Creases fanning up from the bridge of the nose.
      line([[s * 0.05, 0.04], [s * 0.09, 0.3]], 0.03),
      line([[s * 0.14, 0.1], [s * 0.25, 0.36]], 0.025),
      line([[s * 0.22, -0.26], [s * 0.45, -0.32], [s * 0.66, -0.24]], 0.016),
      line([[s * 0.2, -0.62], [s * 0.36, -0.78], [s * 0.4, -0.94]], 0.02),
      line([[s * 0.44, -1.1], [s * 0.5, -1.26]], 0.025),
    ]),
    line([[-0.12, -0.02], [0, -0.06], [0.12, -0.02]], 0.025),
    line([[-0.1, -0.12], [0, -0.15], [0.1, -0.12]], 0.02),
    ...mouth(0.42, 0.16, -0.03, -1.12),
    ...teeth(0.34, 0.12, 0.0, -1.12, 7),
    line([[-0.12, -1.32], [0, -1.35], [0.12, -1.32]], 0.03),
  ],
};

function createHead() {
  const neck = new THREE.Group(); // pivots at the top of the neck
  const head = new THREE.Group();
  head.position.y = HEAD_Y;
  neck.add(head);

  head.add(part(blob(1.05, 1.3, 1.2, 0, 0, 0)));
  head.add(part(blob(0.82, 0.85, 0.95, 0, -0.75, 0.15)));
  head.add(part(blob(0.14, 0.32, 0.22, 0, -0.42, 1.08)));
  for (const s of [1, -1]) head.add(part(blob(0.12, 0.33, 0.22, s * 1.04, -0.2, 0)));
  head.add(...FEATURES());

  const faces = {};
  for (const [name, build] of Object.entries(FACES)) {
    faces[name] = new THREE.Group().add(...build());
    head.add(faces[name]);
  }
  return { neck, faces };
}

// ---------------------------------------------------------------------- torso

// [y, radiusX, radiusZ] from the tapered-off waist up to the neck.
const TORSO = [
  [-3.0, 0.001, 0.001], [-2.8, 0.7, 0.5], [-1.6, 1.4, 0.95], [0, 1.5, 1.0], [1.3, 1.6, 1.05],
  [2.5, 2.0, 1.2], [3.5, 2.4, 1.35], [4.3, 2.45, 1.25], [4.9, 2.0, 1.0], [5.3, 1.1, 0.75],
  [5.7, 0.62, 0.62], [6.4, 0.56, 0.6],
];

function createTorso() {
  // Front surface of the torso, for drawing the anatomy onto it.
  const sizes = new THREE.CatmullRomCurve3(TORSO.map(([y, rx, rz]) => new THREE.Vector3(rx, y, rz))).getPoints(240);
  const torsoDepth = (x, y) => {
    const size = sizes.find((p) => p.y >= y) ?? sizes.at(-1);
    const k = 1 - (x / size.x) ** 2;
    return k > 0 ? size.z * Math.sqrt(k) : 0;
  };
  const draw = (points, width) => stroke(torsoDepth, points, width);

  return [
    part(column(TORSO)),
    ...sides((s) => [
      // Neck tendons, collarbone, chest, then the stomach muscles.
      draw([[s * 0.42, 5.9], [s * 0.27, 5.3], [s * 0.1, 4.8]], 0.035),
      draw([[s * 0.14, 4.74], [s * 0.8, 4.68], [s * 1.7, 4.84]], 0.045),
      draw([[s * 0.1, 3.2], [s * 0.9, 3.05], [s * 1.7, 3.3], [s * 2.1, 3.9]], 0.045),
      draw([[s * 0.75, 2.8], [s * 0.82, 1.8], [s * 0.7, 0.7]], 0.02),
      draw([[s * 0.08, 2.3], [s * 0.72, 2.36]], 0.02),
      draw([[s * 0.08, 1.55], [s * 0.74, 1.6]], 0.02),
    ]),
    draw([[0, 4.55], [0, 3.2]], 0.025),
    draw([[0, 2.95], [0, 0.6]], 0.025),
  ];
}

// ----------------------------------------------------------------------- arms

function createHand(side) {
  const hand = new THREE.Group(); // origin at the wrist, fingers along -Y, palm facing +Z
  hand.add(part(blob(0.36, 0.3, 0.3, 0, 0, 0)));
  hand.add(part(blob(0.48, 0.55, 0.2, 0, -0.55, 0)));

  const digit = (radius, length) => {
    const base = new THREE.Group();
    const tip = new THREE.Group();
    tip.position.y = -length;
    base.add(part(new THREE.CapsuleGeometry(radius, length, 4, 10).translate(0, -length / 2, 0)), tip);
    tip.add(part(new THREE.CapsuleGeometry(radius * 0.92, length * 0.85, 4, 10).translate(0, -length * 0.425, 0)));
    hand.add(base);
    return { base, tip };
  };

  // Index finger first: it is the one next to the thumb.
  const digits = [0.52, 0.58, 0.52, 0.42].map((length, k) => {
    const finger = digit(0.105, length);
    finger.base.position.set(side * (0.33 - 0.22 * k), -1.0, 0);
    return finger;
  });
  const thumb = digit(0.12, 0.4);
  thumb.base.position.set(side * 0.42, -0.4, 0.1);
  thumb.base.rotation.z = side * 0.7;
  digits.push(thumb);

  return { hand, digits };
}

function createArm(side) {
  const upper = part(
    column([
      [-UPPER, 0.5, 0.5], [-3.2, 0.62, 0.6], [-2.0, 0.85, 0.8], [-0.9, 0.82, 0.85],
      [-0.2, 0.86, 0.92], [0.4, 0.55, 0.65], [0.66, 0.001, 0.001],
    ]),
  );
  const forearm = new THREE.Group();
  forearm.add(
    part(
      column([
        [-FOREARM, 0.36, 0.3], [-3.0, 0.42, 0.36], [-1.6, 0.66, 0.6], [-0.6, 0.68, 0.62],
        [0, 0.5, 0.5],
      ]),
    ),
    part(new THREE.SphereGeometry(0.54, 24, 16)), // elbow
  );
  const { hand, digits } = createHand(side);

  // Hands rest on thin air at the near corners of the board.
  const rest = {
    wrist: new THREE.Vector3(side * 3.1, 0.5, -6.2),
    fingers: new THREE.Vector3(0, -0.15, 1).normalize(),
    palm: new THREE.Vector3(0, -1, 0),
    pose: POSES.rest,
  };
  return {
    side,
    upper,
    forearm,
    hand,
    digits,
    rest,
    wrist: rest.wrist.clone(),
    curls: [...POSES.rest],
    piece: null, // the piece being reached for or carried
    holding: false,
    gripHeight: 0,
    onArrive: null,
  };
}

// ----------------------------------------------------------------------- mist

function mistTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const glow = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  glow.addColorStop(0, 'rgba(255,255,255,0.9)');
  glow.addColorStop(0.4, 'rgba(255,255,255,0.3)');
  glow.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, 128, 128);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function createMist() {
  const mist = new THREE.Group();
  const map = mistTexture();
  for (let i = 0; i < 9; i++) {
    const puff = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map,
        color: 0xcfd8ff,
        transparent: true,
        opacity: 0.3,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    const angle = (i / 9) * 2 * Math.PI;
    puff.position.set(Math.cos(angle) * 2.6, -2.6 + (i % 3) * 0.5, WAIST.z + Math.sin(angle) * 1.8);
    puff.scale.setScalar(5 + (i % 4));
    puff.userData.phase = i * 1.7;
    mist.add(puff);
  }
  return mist;
}

// ------------------------------------------------------------------- opponent

/**
 * Adds the computer's avatar to `scene`, hidden until `setSide` is called.
 */
export function createOpponent(scene) {
  // Root space: the figure sits at -Z looking towards +Z. Turning the root
  // half-way round seats it on the other side of the board.
  const root = new THREE.Group();
  root.visible = false;
  scene.add(root);

  const body = new THREE.Group();
  body.add(...createTorso());

  const { neck, faces } = createHead();
  neck.position.y = NECK_Y;
  body.add(neck);

  const arms = [createArm(1), createArm(-1)];
  const mist = createMist();
  root.add(body, mist);
  for (const arm of arms) root.add(arm.upper, arm.forearm, arm.hand);

  let mood = 'smirk';
  let moodUntil = 0;
  let now = 0;
  let thinking = false;
  // Smoothed pose: forward lean, sideways sway, twist, and the head's nod and tilt.
  const pose = { lean: 0, sway: 0, twist: 0, tilt: 0, nod: 0.25, cock: 0 };

  function showFace(name) {
    mood = name;
    for (const [key, group] of Object.entries(faces)) group.visible = key === name;
  }
  showFace('smirk');

  const DOWN = new THREE.Vector3(0, -1, 0);
  const shoulder = new THREE.Vector3();
  const elbow = new THREE.Vector3();
  const reach = new THREE.Vector3();
  const pole = new THREE.Vector3();
  const goal = new THREE.Vector3();
  const fingers = new THREE.Vector3();
  const palm = new THREE.Vector3();
  const across = new THREE.Vector3();
  const basis = new THREE.Matrix4();
  const turn = new THREE.Quaternion();

  // Where this arm's wrist wants to be, with the hand's direction and pose.
  function aim(arm, t) {
    let handPose = arm.rest.pose;
    if (arm.piece) {
      // Pinch the piece from above and behind, palm down.
      fingers.set(0, -0.75, 0.65).normalize();
      palm.set(0, -0.65, -0.75).normalize();
      goal.set(0, arm.gripHeight, 0);
      root.worldToLocal(arm.piece.localToWorld(goal));
      goal.addScaledVector(fingers, -GRIP_ALONG).addScaledVector(palm, -GRIP_OUT);
      handPose = arm.holding ? POSES.grip : POSES.open;
    } else if (thinking && arm.side === -1) {
      // Raised index finger, wagging while it considers.
      goal.set(-2.9, 5.6, -5.2);
      fingers.set(Math.sin(t * 5) * 0.16, 1, 0).normalize();
      palm.set(0, 0, -1);
      handPose = POSES.point;
    } else {
      goal.copy(arm.rest.wrist);
      fingers.copy(arm.rest.fingers);
      palm.copy(arm.rest.palm);
    }
    return handPose;
  }

  function moveArm(arm, t, dt) {
    const handPose = aim(arm, t);
    if (arm.holding) arm.wrist.copy(goal);
    else arm.wrist.lerp(goal, 1 - Math.exp(-7 * dt));

    if (arm.piece && !arm.holding && arm.wrist.distanceTo(goal) < 0.08) {
      arm.holding = true;
      const arrived = arm.onArrive;
      arm.onArrive = null;
      arrived?.();
    }

    // Two-bone reach: the elbow lies off the shoulder-wrist line, swung
    // outwards and back.
    shoulder.set(arm.side * SHOULDER.x, SHOULDER.y, SHOULDER.z).applyMatrix4(body.matrix);
    reach.subVectors(arm.wrist, shoulder);
    const distance = THREE.MathUtils.clamp(reach.length(), 0.4, UPPER + FOREARM - 0.05);
    reach.normalize();
    const along = (UPPER * UPPER - FOREARM * FOREARM + distance * distance) / (2 * distance);
    const out = Math.sqrt(Math.max(UPPER * UPPER - along * along, 0));
    // A raised hand lets the elbow hang instead of sticking out sideways.
    pole.set(arm.side * 0.5, -0.3 - Math.max(arm.wrist.y - 3, 0) * 0.7, -1);
    pole.addScaledVector(reach, -pole.dot(reach)).normalize();
    elbow.copy(shoulder).addScaledVector(reach, along).addScaledVector(pole, out);

    arm.upper.position.copy(shoulder);
    arm.upper.quaternion.setFromUnitVectors(DOWN, pole.subVectors(elbow, shoulder).normalize());
    // The wrist may fall short of where it was asked to be if that is out of reach.
    arm.hand.position.copy(shoulder).addScaledVector(reach, distance);
    arm.forearm.position.copy(elbow);
    arm.forearm.quaternion.setFromUnitVectors(DOWN, pole.subVectors(arm.hand.position, elbow).normalize());

    palm.addScaledVector(fingers, -palm.dot(fingers)).normalize();
    fingers.negate();
    across.crossVectors(fingers, palm);
    turn.setFromRotationMatrix(basis.makeBasis(across, fingers, palm));
    arm.hand.quaternion.slerp(turn, 1 - Math.exp(-8 * dt));

    arm.digits.forEach(({ base, tip }, k) => {
      arm.curls[k] = damp(arm.curls[k], handPose[k], 14, dt);
      base.rotation.x = -arm.curls[k];
      tip.rotation.x = -arm.curls[k] * 1.1;
    });
  }

  function reset() {
    for (const arm of arms) {
      arm.piece = null;
      arm.holding = false;
      // A reach still in flight belongs to a move that no longer exists.
      arm.onArrive = null;
    }
    thinking = false;
    moodUntil = 0;
    showFace('smirk');
  }

  const box = new THREE.Box3();
  const from = new THREE.Vector3();

  return {
    /** Seats the figure behind `color`'s pieces (w/b), or hides it for null. */
    setSide(color) {
      root.visible = Boolean(color);
      root.rotation.y = color === 'w' ? Math.PI : 0;
      // The sketch is always shaded from the figure's own upper left.
      skin.uniforms.uLight.value.set(-0.45, 0.6, 0.65).normalize().applyEuler(root.rotation);
      root.updateMatrixWorld();
      reset();
    },

    reset,

    setThinking(value) {
      thinking = value;
    },

    /** Shows 'grin', 'laugh' or 'angry' for `seconds`, then goes back to the smirk. */
    setMood(name, seconds) {
      showFace(name);
      moodUntil = now + seconds;
    },

    /**
     * Reaches for `piece`; resolves once the hand has closed on it. The hand
     * then follows the piece wherever it is moved, until `release`.
     * `destination` (world space) helps choose which arm to use.
     */
    grab(piece, destination) {
      root.worldToLocal(piece.getWorldPosition(from));
      const to = root.worldToLocal(destination.clone());
      const arm = arms[from.x + to.x >= 0 ? 0 : 1];
      box.setFromObject(piece);
      arm.piece = piece;
      arm.holding = false;
      arm.gripHeight = (box.max.y - box.min.y) * 0.8;
      return new Promise((resolve) => {
        arm.onArrive = resolve;
      });
    },

    release() {
      for (const arm of arms) {
        arm.piece = null;
        arm.holding = false;
      }
    },

    update(t, dt) {
      now = t;
      if (!root.visible) return;
      if (mood !== 'smirk' && t > moodUntil) showFace('smirk');

      // Lean, sway and twist towards whatever the busy hand is reaching for.
      const busy = arms.find((arm) => arm.piece);
      let lean = 0;
      let sway = 0;
      if (busy) {
        aim(busy, t);
        lean = smoothstep(goal.z, -4.5, 3);
        sway = goal.x * 0.3;
      }
      const rate = busy?.holding ? 12 : 5;
      pose.lean = damp(pose.lean, lean, rate, dt);
      pose.sway = damp(pose.sway, sway, rate, dt);
      pose.twist = damp(pose.twist, busy ? -busy.side * 0.45 * lean : 0, rate, dt);

      const laughing = mood === 'laugh';
      const angry = mood === 'angry';
      const shake = laughing ? Math.sin(t * 16) : angry ? Math.sin(t * 40) * 0.25 : 0;
      pose.tilt = damp(pose.tilt, laughing ? -0.1 : angry ? 0.07 : 0, 6, dt);
      pose.nod = damp(pose.nod, laughing ? -0.35 : angry ? 0.3 : thinking ? 0.05 : 0.25, 6, dt);
      pose.cock = damp(pose.cock, thinking && !busy ? -0.16 : 0, 6, dt);

      body.position.set(
        pose.sway,
        WAIST.y + 0.6 * pose.lean + Math.sin(t * 1.3) * 0.05 + shake * 0.05,
        WAIST.z + 1.1 * pose.lean,
      );
      body.rotation.set(0.46 * pose.lean + pose.tilt, pose.twist, Math.sin(t * 0.7) * 0.01);
      neck.rotation.set(
        pose.nod + shake * 0.04,
        -pose.twist * 0.8 + (busy ? goal.x * 0.06 : Math.sin(t * 0.4) * 0.08),
        pose.cock,
      );
      body.updateMatrix();

      for (const arm of arms) moveArm(arm, t, dt);

      for (const puff of mist.children) {
        puff.material.rotation = t * 0.05 + puff.userData.phase;
        puff.material.opacity = 0.24 + 0.08 * Math.sin(t * 0.6 + puff.userData.phase);
      }
    },
  };
}
