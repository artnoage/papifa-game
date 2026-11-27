import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// One idle roster model on the title screen. Other pages use the small rendered poster.
export async function showPriest(host, signal) {
  const gltf = await new GLTFLoader().loadAsync('assets/models/ioannis.glb');
  const model = gltf.scene;
  const materials = new Set(), textures = new Set(), geometries = new Set();
  model.traverse(o => {
    if (!o.isMesh) return;
    geometries.add(o.geometry);
    materials.add(o.material);
    for (const item of Object.values(o.material)) if (item?.isTexture) textures.add(item);
  });
  let renderer, frame = 0, size;
  function dispose() {
    cancelAnimationFrame(frame);
    size?.disconnect();
    if (renderer?.domElement.isConnected) host.classList.remove('has-model');
    renderer?.domElement.remove();
    renderer?.dispose();
    renderer?.forceContextLoss();
    for (const resource of [...materials, ...textures, ...geometries]) resource.dispose();
  }
  if (signal.aborted) { dispose(); return; }
  try {
    const kit = await new THREE.TextureLoader().loadAsync('assets/textures/ioannis_home.webp');
    textures.add(kit);
    if (signal.aborted) { dispose(); return; }
    kit.colorSpace = THREE.SRGBColorSpace;
    kit.flipY = false;
    for (const mat of materials) if (mat.name === 'Mat_Body' || mat.name === 'Mat_VestmentPrimary') mat.map = kit;
    const scene = new THREE.Scene();
    scene.add(model, new THREE.HemisphereLight(0xfff5dd, 0x72876a, 1.5));
    const light = new THREE.DirectionalLight(0xffeed0, 2.5);
    light.position.set(-3, 4, 4); scene.add(light);
    const camera = new THREE.OrthographicCamera();
    camera.position.set(0, 1.15, 5);
    camera.lookAt(0, 1.04, 0);
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    renderer.setClearColor(0, 0);
    const mixer = new THREE.AnimationMixer(model);
    const idle = THREE.AnimationClip.findByName(gltf.animations, 'idle');
    if (idle) mixer.clipAction(idle).play();
    function resize() {
      const w = Math.max(1, host.clientWidth), h = Math.max(1, host.clientHeight);
      const half = Math.max(1.12, .76 * h / w);
      camera.top = half; camera.bottom = -half; camera.left = -half*w/h; camera.right = -camera.left;
      camera.near = .1; camera.far = 20; camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
    }
    resize();
    size = new ResizeObserver(resize); size.observe(host);
    host.append(renderer.domElement);
    signal.addEventListener('abort', dispose, { once: true });
    let last = 0, elapsed = 0;
    function draw(now) {
      if (signal.aborted) return;
      if (!last || now - last >= 1000 / 24) {
        const dt = last ? Math.min((now-last)/1000,.1) : 0;
        last = now; elapsed += dt;
        model.rotation.y = -.16 + .32 * Math.sin(elapsed * .25);
        mixer.update(dt);
        renderer.render(scene,camera);
        host.classList.add('has-model');
      }
      frame = requestAnimationFrame(draw);
    }
    draw(performance.now());
  } catch (error) { dispose(); throw error; }
}
