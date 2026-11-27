import * as THREE from 'three';

export function createPitchTarget(canvas, camera, scene, initialColor = 0xffc83d) {
  const ray = new THREE.Raycaster(), screen = new THREE.Vector2(), hit = new THREE.Vector3();
  const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(.40, .53, 32),
    new THREE.MeshBasicMaterial({ color: 0xfff2b8 }),
  );
  ring.name = 'Mouse aim';
  ring.rotation.x = -Math.PI / 2;
  ring.visible = false;
  scene.add(ring);

  function setColor(hex) {
    // Lift the team colour slightly toward white so the reticle reads crisply on both grass and snow.
    ring.material.color.setHex(hex).lerp(new THREE.Color(0xffffff), 0.38);
  }
  setColor(initialColor);

  function project() {
    camera.updateMatrixWorld();
    ray.setFromCamera(screen, camera);
    ring.visible = !!ray.ray.intersectPlane(ground, hit);
    if (ring.visible) ring.position.set(hit.x, .035, hit.z);
    return ring.visible ? hit : null;
  }
  return {
    canvas,
    at(x, y) {
      const box = canvas.getBoundingClientRect();
      if (!box.width || !box.height) return null;
      screen.set(2 * (x - box.left) / box.width - 1, 1 - 2 * (y - box.top) / box.height);
      return project();
    },
    // Draw at the same pixel after the broadcast camera moves this frame.
    redraw() { if (ring.visible) project(); },
    hide() { ring.visible = false; },
    setColor,
  };
}
