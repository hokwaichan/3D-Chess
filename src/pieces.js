import * as THREE from 'three';

// White plays silver, black plays gold. Both are mirror-polished metal, so they
// rely on the scene's environment map for their reflections.
const MATERIALS = {
  w: new THREE.MeshStandardMaterial({ color: 0xdfe3ec, roughness: 0.18, metalness: 1 }),
  b: new THREE.MeshStandardMaterial({ color: 0xe0a82a, roughness: 0.22, metalness: 1 }),
  // Eyes, nostrils and the bishop's slit.
  accent: new THREE.MeshStandardMaterial({ color: 0x0b0b10, roughness: 0.15, metalness: 0.3 }),
};

const DEG = Math.PI / 180;
const v = (x, y) => new THREE.Vector2(x, y);

// Points along a circular (or elliptical, via rx) arc of a lathe profile.
function arc(cy, ry, fromDeg, toDeg, rx = ry, steps = 12) {
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const a = (fromDeg + ((toDeg - fromDeg) * i) / steps) * DEG;
    points.push([Math.max(rx * Math.cos(a), 0), cy + ry * Math.sin(a)]);
  }
  return points;
}

// Revolves a [radius, height] profile (listed bottom to top) around the Y axis.
function lathe(profile) {
  return new THREE.LatheGeometry(profile.map(([r, y]) => v(r, y)), 64);
}

// Shared foot: two stacked discs, then a flared plinth curving into a ringed
// collar, ending at y = 0.22. `s` scales the radii for smaller pieces.
function foot(s) {
  return [
    [0, 0], [0.37, 0], [0.38, 0.015], [0.38, 0.04], [0.35, 0.05], [0.35, 0.065],
    [0.37, 0.075], [0.36, 0.09], [0.32, 0.11], [0.27, 0.14], [0.22, 0.165],
    [0.2, 0.18], [0.25, 0.18], [0.26, 0.195], [0.24, 0.21], [0.19, 0.22],
  ].map(([r, y]) => [r * s, y]);
}

// Stacked rings at `y`, as under the king's and queen's crowns.
function collar(y, r) {
  return [
    [r, y], [r + 0.03, y + 0.015], [r + 0.03, y + 0.045], [r - 0.02, y + 0.065],
    [r + 0.005, y + 0.075], [r + 0.005, y + 0.105], [r - 0.05, y + 0.125],
    [r - 0.02, y + 0.135], [r - 0.02, y + 0.16], [r - 0.07, y + 0.18],
  ];
}

// Copies `build()` around the Y axis `count` times.
function around(count, build) {
  return Array.from({ length: count }, (_, i) => build().rotateY((i / count) * 2 * Math.PI));
}

// Cross with flared arm ends, like the one on the reference king.
function crossGeometry(y) {
  const L = 0.17; // half-height
  const H = 0.12; // half-width
  const w = 0.03; // half-thickness of the arms
  const e = 0.058; // half-thickness at the flared ends
  const f = 0.05; // length of each flare
  const outline = [
    [-e, L], [e, L], [w, L - f], [w, w], [H - f, w], [H, e], [H, -e], [H - f, -w],
    [w, -w], [w, -L + f], [e, -L], [-e, -L], [-w, -L + f], [-w, -w], [-H + f, -w],
    [-H, -e], [-H, e], [-H + f, w], [-w, w], [-w, L - f],
  ];
  const depth = 0.06;
  return new THREE.ExtrudeGeometry(new THREE.Shape(outline.map(([x, z]) => v(x, z))), {
    depth,
    bevelEnabled: true,
    bevelSize: 0.012,
    bevelThickness: 0.012,
    bevelSegments: 2,
  }).translate(0, y, -depth / 2);
}

// A smooth tube along a curve in the XY plane whose cross-section is an ellipse
// that changes along the way. `sections` are [x, y, a, b]: the spine point,
// the half-size across the spine (in the XY plane) and the half-thickness in Z.
function spineOf(sections) {
  const points = new THREE.CatmullRomCurve3(sections.map(([x, y]) => new THREE.Vector3(x, y, 0)));
  const sizes = new THREE.CatmullRomCurve3(sections.map(([, , a, b]) => new THREE.Vector3(a, b, 0)));
  return (t) => {
    const p = points.getPoint(t);
    const tangent = points.getTangent(t);
    const size = sizes.getPoint(t);
    // `normal` is the tangent turned a quarter-turn anticlockwise.
    return { p, tangent, normal: v(-tangent.y, tangent.x), a: size.x, b: size.y };
  };
}

function loft(sections, radial = 28, steps = 56) {
  const at = spineOf(sections);
  const positions = [];
  const indices = [];
  for (let i = 0; i <= steps; i++) {
    const { p, normal, a, b } = at(i / steps);
    for (let j = 0; j < radial; j++) {
      const angle = (j / radial) * 2 * Math.PI;
      const across = Math.cos(angle) * a;
      positions.push(p.x + normal.x * across, p.y + normal.y * across, Math.sin(angle) * b);
    }
  }
  for (let i = 0; i < steps; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * radial + j;
      const b = i * radial + ((j + 1) % radial);
      const c = a + radial;
      const d = b + radial;
      indices.push(a, b, c, b, d, c);
    }
  }
  // Flat caps at both ends; these end up buried inside neighbouring parts.
  const startCentre = positions.length / 3;
  positions.push(...at(0).p.toArray());
  const endCentre = startCentre + 1;
  positions.push(...at(1).p.toArray());
  for (let j = 0; j < radial; j++) {
    const next = (j + 1) % radial;
    indices.push(startCentre, next, j);
    indices.push(endCentre, steps * radial + j, steps * radial + next);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

// A flattened spike with its base at the origin, pointing along `direction`
// (an angle in the XY plane, measured from +X).
function blade(radius, length, direction, flatten = 0.45) {
  return new THREE.ConeGeometry(radius, length, 6)
    .translate(0, length / 2, 0)
    .scale(1, 1, flatten)
    .rotateZ(direction - Math.PI / 2);
}

// Sculpted horse: arched neck, long head, ears, and a comb-like mane. It faces
// +X and stands on the knight's pedestal.
function knightHorse() {
  const NECK = [
    [0.0, 0.27, 0.2, 0.18],
    [0.02, 0.36, 0.2, 0.17],
    [0.01, 0.48, 0.19, 0.15],
    [-0.04, 0.62, 0.165, 0.13],
    [-0.06, 0.75, 0.15, 0.12],
    [-0.03, 0.87, 0.125, 0.108],
    [0.02, 0.93, 0.07, 0.07],
  ];
  const HEAD = [
    [-0.08, 0.9, 0.07, 0.08],
    [0.01, 0.85, 0.13, 0.11],
    [0.09, 0.77, 0.13, 0.105],
    [0.165, 0.68, 0.11, 0.088],
    [0.225, 0.6, 0.092, 0.076],
    [0.27, 0.54, 0.085, 0.072],
    [0.3, 0.5, 0.05, 0.05],
  ];

  const parts = [loft(NECK), loft(HEAD)];

  // Cheek and jaw bulge.
  parts.push(new THREE.SphereGeometry(0.115, 24, 16).scale(1, 1.05, 0.95).translate(0.03, 0.75, 0));
  // Rounded muzzle tip and chin.
  parts.push(new THREE.SphereGeometry(0.078, 18, 14).scale(1, 1, 0.92).translate(0.278, 0.528, 0));

  for (const side of [1, -1]) {
    // Ears, leaning forward and slightly apart.
    parts.push(
      new THREE.ConeGeometry(0.055, 0.14, 12)
        .translate(0, 0.07, 0)
        .scale(1, 1, 0.55)
        .rotateX(side * 0.3)
        .rotateZ(-0.25)
        .translate(-0.04, 0.925, side * 0.06),
    );
    // Brow ridge over each eye.
    parts.push(new THREE.SphereGeometry(0.04, 12, 10).scale(1.3, 0.7, 0.6).rotateZ(-0.7).translate(0.06, 0.85, side * 0.088));
    parts.push({ accent: true, g: new THREE.SphereGeometry(0.024, 14, 12).translate(0.078, 0.812, side * 0.098) });
    // Nostrils.
    parts.push({ accent: true, g: new THREE.SphereGeometry(0.017, 10, 8).scale(1.2, 0.8, 1).translate(0.318, 0.555, side * 0.048) });
  }

  // Mouth: a dark line along the lower muzzle.
  parts.push({
    accent: true,
    g: new THREE.BoxGeometry(0.08, 0.01, 0.124).rotateZ(-0.93).translate(0.232, 0.528, 0),
  });

  // Mane: overlapping blades swept back and down the crest of the neck.
  const neck = spineOf(NECK);
  const count = 13;
  for (let i = 0; i < count; i++) {
    const t = 0.1 + (0.86 * i) / (count - 1);
    const { p, normal, tangent, a } = neck(t);
    const sweep = 40 * DEG;
    const dx = normal.x * Math.cos(sweep) - tangent.x * Math.sin(sweep);
    const dy = normal.y * Math.cos(sweep) - tangent.y * Math.sin(sweep);
    const length = 0.13 + 0.06 * Math.sin(Math.PI * (i / (count - 1)));
    parts.push(
      blade(0.075, length, Math.atan2(dy, dx), 0.55).translate(
        p.x + normal.x * (a - 0.035),
        p.y + normal.y * (a - 0.035),
        0,
      ),
    );
  }
  // Forelock falling between the ears onto the forehead.
  parts.push(blade(0.04, 0.11, -55 * DEG, 0.9).translate(-0.02, 0.95, 0));
  parts.push(blade(0.035, 0.09, -70 * DEG, 0.9).translate(0.015, 0.94, 0));

  return parts;
}

// Each piece is a list of geometries (or `{ g, accent }` for dark details)
// standing on y = 0, sized for a 1x1 square.
const BUILDERS = {
  p: () => [
    lathe([
      ...foot(0.78),
      [0.11, 0.3], [0.09, 0.38], [0.17, 0.42], [0.18, 0.45], [0.16, 0.48], [0.08, 0.51],
      ...arc(0.64, 0.15, -65, 90),
    ]),
  ],
  r: () => [
    lathe([
      ...foot(0.92),
      [0.15, 0.32], [0.14, 0.52], [0.2, 0.55], [0.25, 0.6], [0.25, 0.64], [0.21, 0.67],
      [0.2, 0.78], [0.25, 0.83], [0.27, 0.86], [0.27, 0.92], [0.2, 0.92], [0, 0.92],
    ]),
    // Battlements.
    ...around(8, () => new THREE.BoxGeometry(0.1, 0.13, 0.085).translate(0.225, 0.985, 0)),
  ],
  n: () => [
    lathe([...foot(0.92), [0.23, 0.22], [0.24, 0.245], [0.22, 0.27], [0, 0.28]]),
    ...knightHorse(),
  ],
  b: () => [
    lathe([
      ...foot(0.95),
      [0.13, 0.32], [0.09, 0.5], [0.16, 0.55], [0.18, 0.58], [0.17, 0.62], [0.08, 0.66],
      ...arc(0.88, 0.22, -65, 82, 0.16),
      [0.04, 1.1],
      ...arc(1.16, 0.05, -60, 90),
    ]),
    // The mitre's diagonal slit: a tilted dark disc, offset forward so that only
    // its front rim breaks the surface.
    {
      accent: true,
      g: new THREE.CylinderGeometry(1, 1, 0.018, 40)
        .scale(0.127, 1, 0.13)
        .translate(0.03, 0, 0)
        .rotateZ(38 * DEG)
        .translate(0, 0.93, 0),
    },
  ],
  q: () => [
    lathe([
      ...foot(1),
      [0.14, 0.3], [0.1, 0.55], [0.1, 0.76],
      ...collar(0.8, 0.2),
      [0.15, 1.0], [0.24, 1.1], [0.27, 1.17], [0.24, 1.19], [0.08, 1.17],
      ...arc(1.25, 0.08, -60, 90),
    ]),
    // Coronet: nine spikes tipped with pearls.
    ...around(9, () => new THREE.ConeGeometry(0.045, 0.16, 10).translate(0, 0.08, 0).rotateZ(-0.25 * 1).translate(0.245, 1.14, 0)),
    ...around(9, () => new THREE.SphereGeometry(0.035, 12, 8).translate(0.285, 1.295, 0)),
  ],
  k: () => [
    lathe([
      ...foot(1),
      [0.14, 0.3], [0.11, 0.5], [0.1, 0.7], [0.11, 0.8],
      ...collar(0.84, 0.2),
      [0.19, 1.04], [0.21, 1.12], [0.24, 1.2], [0.23, 1.3], [0.2, 1.34], [0.13, 1.37],
      [0.09, 1.39], [0.1, 1.41], [0.08, 1.44], [0, 1.44],
    ]),
    crossGeometry(1.62),
  ],
};

const geometryCache = {};

/** Builds a piece (`type` is p/n/b/r/q/k, `color` is w/b) standing at the origin. */
export function createPiece(type, color) {
  const geometries = (geometryCache[type] ??= BUILDERS[type]());
  const piece = new THREE.Group();
  for (const entry of geometries) {
    const geometry = entry.g ?? entry;
    const mesh = new THREE.Mesh(geometry, MATERIALS[entry.accent ? 'accent' : color]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    piece.add(mesh);
  }
  // Knights and bishops face the opponent (white towards -Z, black towards +Z),
  // turned partly aside so their profile is readable from behind the board.
  if (type === 'n' || type === 'b') piece.rotation.y = (color === 'w' ? 1 : -1) * (Math.PI / 2 - 0.7);
  return piece;
}
