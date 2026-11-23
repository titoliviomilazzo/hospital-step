// Three.js arrow, loaded lazily. vendor/three.min.js is a classic script that defines
// window.THREE; it is injected only when the 3D arrow is first needed. At most one renderer and
// one canvas exist at a time; disposeArrow3d() releases them. The scene is drawn only when the
// angle changes (no idle animation). Browser only.
import { versioned } from './version.js';

const SRC = versioned('vendor/three.min.js');
let threePromise = null;
let current = null; // { renderer, canvas, geoms, mats }

function loadThree() {
  if (globalThis.THREE) return Promise.resolve(globalThis.THREE);
  if (!threePromise) {
    threePromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = SRC;
      s.onload = () => (globalThis.THREE ? resolve(globalThis.THREE) : reject(new Error('THREE missing')));
      s.onerror = () => { threePromise = null; reject(new Error('three.min.js failed to load')); };
      document.head.append(s);
    });
  }
  return threePromise;
}

export function disposeArrow3d() {
  const c = current;
  if (!c) return;
  current = null;
  try {
    c.geoms.forEach((g) => g.dispose());
    c.mats.forEach((m) => m.dispose());
    c.renderer.dispose();
    if (c.renderer.forceContextLoss) c.renderer.forceContextLoss();
    c.canvas.remove();
  } catch { /* ignore */ }
}

/**
 * Creates the 3D arrow inside `container`. Resolves to `{ setAngle(deg) }`, or null when Three.js
 * or WebGL is unavailable (the caller then shows the 2D arrow). Any earlier instance is disposed.
 */
export async function renderArrow3d(container, angle = 0) {
  disposeArrow3d();
  let THREE;
  try {
    THREE = await loadThree();
  } catch {
    return null;
  }
  // The caller may have re-rendered while the script loaded; a stale call must not dispose the
  // instance a newer call created.
  if (!container.isConnected) return null;
  disposeArrow3d();
  try {
    const size = 280;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
    renderer.setSize(size, size, false); // CSS scales the canvas (style.css .arrow-holder canvas)
    const canvas = renderer.domElement;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', '가야 할 방향을 가리키는 입체 화살표');
    container.prepend(canvas);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 50);
    camera.position.set(0, 6, 4.5);
    camera.lookAt(0, 0, 0);
    scene.add(new THREE.AmbientLight(0xffffff, 0.8));
    const sun = new THREE.DirectionalLight(0xffffff, 0.8);
    sun.position.set(2, 6, 3);
    scene.add(sun);

    const yellow = new THREE.MeshLambertMaterial({ color: 0xfacc15 });
    const red = new THREE.MeshLambertMaterial({ color: 0xef4444 });
    const blue = new THREE.MeshLambertMaterial({ color: 0x38bdf8 });
    const shaftGeo = new THREE.BoxGeometry(0.5, 0.3, 1.6);
    const headGeo = new THREE.ConeGeometry(0.7, 1.1, 4);
    const ringGeo = new THREE.TorusGeometry(2, 0.1, 8, 48);

    const pivot = new THREE.Group();
    const shaft = new THREE.Mesh(shaftGeo, yellow);
    shaft.position.set(0, 0, 0.5);
    const head = new THREE.Mesh(headGeo, red);
    head.rotation.x = -Math.PI / 2; // cone axis from +y to -z (forward)
    head.rotation.y = Math.PI / 4;
    head.position.set(0, 0, -1.0);
    pivot.add(shaft, head);
    scene.add(pivot);
    const ring = new THREE.Mesh(ringGeo, blue);
    ring.rotation.x = Math.PI / 2;
    scene.add(ring);

    const inst = { renderer, canvas, geoms: [shaftGeo, headGeo, ringGeo], mats: [yellow, red, blue] };
    current = inst;
    const setAngle = (deg) => {
      if (current !== inst) return;
      pivot.rotation.y = -deg * Math.PI / 180; // clockwise seen from above
      renderer.render(scene, camera);
    };
    setAngle(angle);
    return { setAngle };
  } catch {
    disposeArrow3d();
    return null;
  }
}
