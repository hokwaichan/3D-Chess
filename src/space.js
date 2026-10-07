import * as THREE from 'three';

// Everything here is generated at load time: no image files are used.

const SKY_RADIUS = 300;

// Star tints with their relative frequency: white, blue-white, gold, orange.
const STAR_TINTS = [
  [0xffffff, 5],
  [0xb9ceff, 3],
  [0xffd79c, 2],
  [0xff9566, 1],
];
const TINT_TOTAL = STAR_TINTS.reduce((sum, [, weight]) => sum + weight, 0);

function randomTint(target) {
  let roll = Math.random() * TINT_TOTAL;
  for (const [hex, weight] of STAR_TINTS) {
    roll -= weight;
    if (roll <= 0) return target.setHex(hex);
  }
  return target.setHex(0xffffff);
}

// Gaussian-ish random number centred on 0.
const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;

// Soft round glow; with `spikes`, adds the cross-shaped diffraction spikes that
// bright stars show in telescope photographs.
function glowTexture(spikes) {
  const size = 128;
  const half = size / 2;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');

  const glow = ctx.createRadialGradient(half, half, 0, half, half, half);
  glow.addColorStop(0, 'rgba(255,255,255,1)');
  glow.addColorStop(spikes ? 0.06 : 0.2, 'rgba(255,255,255,0.85)');
  glow.addColorStop(spikes ? 0.22 : 0.5, 'rgba(255,255,255,0.16)');
  glow.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, size, size);

  if (spikes) {
    ctx.globalCompositeOperation = 'lighter';
    for (const vertical of [false, true]) {
      const streak = vertical
        ? ctx.createLinearGradient(0, 0, 0, size)
        : ctx.createLinearGradient(0, 0, size, 0);
      streak.addColorStop(0, 'rgba(255,255,255,0)');
      streak.addColorStop(0.5, 'rgba(255,255,255,0.9)');
      streak.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = streak;
      if (vertical) ctx.fillRect(half - 1, 0, 2, size);
      else ctx.fillRect(0, half - 1, size, 2);
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// Sky dome painted by a shader: layered, warped noise gives blue reflection
// clouds, rust-coloured filaments and dark dust lanes, with empty sky between.
function createNebula() {
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    vertexShader: /* glsl */ `
      varying vec3 vDirection;
      void main() {
        vDirection = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vDirection;

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

      float fbm(vec3 p) {
        float sum = 0.0;
        float amplitude = 0.5;
        for (int i = 0; i < 6; i++) {
          sum += amplitude * noise(p);
          p = p * 2.02 + vec3(1.7, 9.2, 3.1);
          amplitude *= 0.5;
        }
        return sum;
      }

      void main() {
        vec3 d = normalize(vDirection);
        vec3 q = d * 2.2;

        // Warping the lookup by more noise turns blobs into wispy filaments.
        vec3 warp = vec3(fbm(q + 1.3), fbm(q + vec3(5.2, 1.3, 2.8)), fbm(q + vec3(9.1, 3.7, 7.4)));
        float blue = smoothstep(0.42, 0.74, fbm(q + 1.8 * warp));
        float rust = smoothstep(0.48, 0.76, fbm(q * 1.7 + 2.5 * warp + 11.0));
        float dust = smoothstep(0.45, 0.7, fbm(q * 3.1 + 3.0 * warp + 4.0));
        float teal = smoothstep(0.5, 0.8, fbm(q * 1.3 - 2.0 * warp + 31.0));

        vec3 color = vec3(0.10, 0.22, 0.55) * blue * blue * 1.1;
        color += vec3(0.35, 0.55, 0.80) * pow(blue, 4.0) * 0.55;
        color += vec3(0.95, 0.34, 0.11) * rust * (0.3 + 0.7 * blue);
        color += vec3(0.10, 0.34, 0.32) * teal * 0.35;
        color *= mix(1.0, 0.25, dust * rust);

        // Leave large stretches of plain dark sky between the clouds.
        float coverage = smoothstep(0.38, 0.62, fbm(d * 1.1 + 20.0));
        color = mix(vec3(0.006, 0.008, 0.02), color + vec3(0.006, 0.008, 0.02), coverage);

        gl_FragColor = vec4(color, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(SKY_RADIUS, 48, 32), material);
  dome.renderOrder = -1;
  return dome;
}

// A shell of point stars, all drawn at the same on-screen size.
function createStarLayer(count, pixelSize, map) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const p = new THREE.Vector3();
  const c = new THREE.Color();
  for (let i = 0; i < count; i++) {
    p.randomDirection().multiplyScalar(150 + Math.random() * 100);
    p.toArray(positions, i * 3);
    randomTint(c).multiplyScalar(0.55 + Math.random() * 0.45);
    c.toArray(colors, i * 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
      size: pixelSize,
      sizeAttenuation: false,
      vertexColors: true,
      map,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
}

// A handful of bright foreground stars with diffraction spikes.
function createBrightStars(count, map) {
  const group = new THREE.Group();
  const color = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map,
        color: randomTint(color).clone(),
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    sprite.position.randomDirection().multiplyScalar(200);
    // Mostly modest, with a few showpieces.
    sprite.scale.setScalar(5 + Math.pow(Math.random(), 3) * 20);
    group.add(sprite);
  }
  return group;
}

// Spiral galaxy made of points: a warm bulge, two blue-white arms winding out
// of it, and a soft core glow. Returns the tilted group and the part that spins.
function createGalaxy({ radius, stars, coreColor, armColor, glowMap, dotMap }) {
  const positions = new Float32Array(stars * 3);
  const colors = new Float32Array(stars * 3);
  const core = new THREE.Color(coreColor);
  const arm = new THREE.Color(armColor);
  const pink = new THREE.Color(0xff7fa8);
  const c = new THREE.Color();

  for (let i = 0; i < stars; i++) {
    let x, y, z, mix;
    let onArmBoost = 1;
    if (i % 5 === 0) {
      // Central bulge.
      const r = Math.abs(gauss()) * radius * 0.16;
      const dir = new THREE.Vector3().randomDirection();
      x = dir.x * r;
      y = dir.y * r * 0.7;
      z = dir.z * r;
      mix = 0;
    } else {
      const r = Math.pow(Math.random(), 1.4) * radius;
      const t = r / radius;
      // Two arms; some of the disc stars ignore them and fill the gaps.
      const onArm = i % 5 > 2;
      const angle = onArm
        ? (i % 2) * Math.PI + t * 5.2 + gauss() * (0.7 - 0.3 * t)
        : Math.random() * 2 * Math.PI;
      x = Math.cos(angle) * r;
      z = Math.sin(angle) * r;
      y = gauss() * radius * 0.025 * (1.4 - t);
      mix = Math.min(1, t * 1.6);
      // Stars between the arms are dimmer, so the spiral still stands out.
      if (!onArm) onArmBoost = 0.45;
    }
    positions.set([x, y, z], i * 3);
    c.copy(core).lerp(arm, mix);
    // Sprinkle pink star-forming regions along the arms.
    if (mix > 0.4 && Math.random() < 0.04) c.copy(pink);
    c.multiplyScalar(onArmBoost * (0.3 + Math.random() * 0.5));
    c.toArray(colors, i * 3);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const disc = new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
      size: 2.2,
      sizeAttenuation: false,
      vertexColors: true,
      map: dotMap,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );

  const glow = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowMap,
      color: coreColor,
      transparent: true,
      opacity: 0.6,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  glow.scale.setScalar(radius * 0.5);

  const group = new THREE.Group();
  group.add(disc, glow);
  return { group, disc };
}

/**
 * Adds the space backdrop to `scene`.
 * Returns an `update(seconds)` function to call every frame.
 */
export function createSpace(scene) {
  const dot = glowTexture(false);
  const spiked = glowTexture(true);

  const sky = new THREE.Group();
  sky.add(createNebula());
  sky.add(createStarLayer(9000, 2.4, dot));
  sky.add(createStarLayer(1800, 3.8, dot));
  sky.add(createStarLayer(320, 6, dot));
  sky.add(createBrightStars(70, spiked));

  // The camera looks down on the board, so what a player sees behind it is sky
  // below the horizon. The showpiece galaxy sits there, in the upper right of
  // the silver player's view, tilted like Andromeda; a smaller face-on spiral
  // does the same job for the gold player.
  const andromeda = createGalaxy({
    radius: 34,
    stars: 16000,
    coreColor: 0xffe2b0,
    armColor: 0x9db8ff,
    glowMap: dot,
    dotMap: dot,
  });
  andromeda.group.position.set(60, -78, -140);
  andromeda.group.rotation.z = 0.5;

  const companion = createGalaxy({
    radius: 22,
    stars: 7000,
    coreColor: 0xffc978,
    armColor: 0xffe9c4,
    glowMap: dot,
    dotMap: dot,
  });
  companion.group.position.set(-62, -80, 140);
  // Turn its face towards the board, then tip it a little.
  companion.group.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    companion.group.position.clone().negate().normalize(),
  );
  companion.group.rotateX(0.45);

  scene.add(sky, andromeda.group, companion.group);

  // Two fuzzy satellite galaxies beside the big one.
  for (const [x, y, z, size] of [
    [30, -66, -140, 7],
    [84, -98, -140, 10],
  ]) {
    const satellite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: dot,
        color: 0xfff0d8,
        transparent: true,
        opacity: 0.7,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    satellite.position.set(x, y, z);
    satellite.scale.set(size, size * 0.6, 1);
    scene.add(satellite);
  }

  return (seconds) => {
    // The nebula and stars drift very slowly behind the galaxies, which stay
    // put and turn on their own axes.
    sky.rotation.y = seconds * 0.002;
    andromeda.disc.rotation.y = -seconds * 0.01;
    companion.disc.rotation.y = seconds * 0.015;
  };
}
