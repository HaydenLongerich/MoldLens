import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export function createHouseModel(host: HTMLDivElement): { dispose: () => void } {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.setClearColor(0x000000, 0);
  renderer.domElement.setAttribute('aria-hidden', 'true');
  host.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
  const initialPosition = new THREE.Vector3(8.5, 6.5, 10.5);
  camera.position.copy(initialPosition);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1.9, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.enableZoom = false;
  controls.minPolarAngle = 0.35;
  controls.maxPolarAngle = Math.PI / 2.05;

  const materials: THREE.Material[] = [];
  const geometries: THREE.BufferGeometry[] = [];
  function material(color: number, roughness = 0.85) {
    const item = new THREE.MeshStandardMaterial({ color, roughness });
    materials.push(item);
    return item;
  }
  const palette = { orange: 0xf05924, sage: 0xa6b8a1, sand: 0xe6dfd2, cream: 0xfaf7f0, charcoal: 0x1f2b28 };
  const wall = material(palette.cream), wallEdge = material(palette.charcoal), floor = material(palette.sand);
  const dark = material(palette.charcoal), sage = material(0xa6b8a1), wood = material(palette.sand);
  const white = material(palette.cream), accent = material(palette.orange), metal = material(palette.charcoal, 0.4);
  const glass = material(0xb4c3be, 0.25), stone = material(palette.sand);
  function mesh(geometry: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = scene) {
    geometries.push(geometry);
    const item = new THREE.Mesh(geometry, mat);
    item.position.set(x, y, z);
    item.castShadow = true;
    item.receiveShadow = true;
    parent.add(item);
    return item;
  }
  function box(w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material, parent?: THREE.Object3D) {
    return mesh(new THREE.BoxGeometry(w, h, d), mat, x, y, z, parent);
  }
  function cylinder(top: number, bottom: number, height: number, x: number, y: number, z: number, mat: THREE.Material) {
    return mesh(new THREE.CylinderGeometry(top, bottom, height, 32), mat, x, y, z);
  }
  scene.add(new THREE.HemisphereLight(0xffffff, 0xb8b3a9, 1.8));
  const sun = new THREE.DirectionalLight(0xffffff, 2.7);
  sun.position.set(-4, 9, 7);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = sun.shadow.camera.bottom = -6;
  sun.shadow.camera.right = sun.shadow.camera.top = 6;
  sun.shadow.normalBias = 0.025;
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xffffff, 1.1);
  fill.position.set(6, 4, -5);
  scene.add(fill);
  cylinder(3.65, 3.75, 0.18, 0, -0.22, 0, material(palette.sand));
  box(5.35, 0.2, 3.95, 0, -0.03, 0, wallEdge);
  box(5, 0.1, 3.6, 0, 0.12, 0, stone);
  box(5, 0.16, 3.6, 0, 1.82, 0, floor);
  box(5, 3.45, 0.15, 0, 1.78, -1.78, wall);
  box(0.15, 3.45, 3.6, -2.48, 1.78, 0, wall);
  // Low side walls keep the interior visible as the house turns.
  box(0.15, 0.65, 3.6, 2.48, 0.48, 0, wall);
  box(0.15, 0.5, 3.6, 2.48, 2.13, 0, wall);
  box(0.12, 1.55, 3.6, 0.2, 2.68, 0, wall);
  box(0.12, 1.55, 3.6, 0.2, 0.96, 0, wallEdge);
  // Upper floor: a small lounge and a tiled bathroom.
  box(2.15, 0.025, 3.35, 1.32, 1.92, 0, material(palette.cream));
  for (let i = 0; i < 5; i++) box(0.012, 0.01, 3.35, 0.45 + i * 0.43, 1.94, 0, wallEdge);
  for (let i = 0; i < 7; i++) box(2.15, 0.01, 0.012, 1.32, 1.94, -1.45 + i * 0.48, wallEdge);
  box(1.3, 0.4, 0.7, 1.35, 2.14, -0.93, white);
  box(1.08, 0.06, 0.49, 1.35, 2.37, -0.93, glass);
  box(0.09, 0.35, 0.08, 1.85, 2.5, -1.21, metal);
  box(0.23, 0.06, 0.08, 1.76, 2.65, -1.21, metal);
  box(0.55, 0.6, 0.5, 1.85, 2.25, 0.8, wood);
  box(0.63, 0.08, 0.57, 1.85, 2.59, 0.8, white);
  const mirror = cylinder(0.25, 0.25, 0.025, 2.38, 2.9, 0.8, glass);
  mirror.rotation.z = Math.PI / 2;
  box(1.75, 0.025, 1.35, -1.2, 1.93, 0.6, material(palette.orange));
  box(1.5, 0.28, 0.65, -1.25, 2.13, -0.75, sage);
  box(1.55, 0.45, 0.18, -1.25, 2.45, -1.04, sage);
  box(0.18, 0.4, 0.7, -2.02, 2.3, -0.75, sage);
  box(0.18, 0.4, 0.7, -0.48, 2.3, -0.75, sage);
  cylinder(0.45, 0.45, 0.08, -1.25, 2.3, 0.6, wood);
  cylinder(0.06, 0.1, 0.3, -1.25, 2.12, 0.6, dark);
  // Window frame, sill, and a pair of simple curtains.
  box(1.05, 0.95, 0.09, -1.28, 2.85, -1.67, dark);
  box(0.87, 0.77, 0.04, -1.28, 2.85, -1.6, glass);
  box(0.04, 0.8, 0.06, -1.28, 2.85, -1.56, white);
  box(0.9, 0.04, 0.06, -1.28, 2.85, -1.56, white);
  box(1.22, 0.07, 0.28, -1.28, 2.35, -1.55, white);
  box(0.15, 1.1, 0.1, -1.92, 2.85, -1.54, sage);
  box(0.15, 1.1, 0.1, -0.64, 2.85, -1.54, sage);
  // Basement: shelving, storage, and exposed pipes.
  for (const x of [-2.13, -0.55]) for (const z of [-1.4, -0.85]) box(0.05, 1.25, 0.05, x, 0.84, z, dark);
  for (const y of [0.3, 0.84, 1.4]) box(1.75, 0.06, 0.68, -1.34, y, -1.12, wood);
  box(0.48, 0.4, 0.44, -1.75, 0.55, -1.1, material(palette.orange));
  box(0.65, 0.4, 0.44, -0.95, 1.07, -1.1, material(palette.cream));
  box(0.4, 0.3, 0.44, -1.75, 1.02, -1.1, accent);
  const pipe = cylinder(0.05, 0.05, 1.6, -2.25, 1, 0.6, metal);
  const elbow = mesh(new THREE.TorusGeometry(0.17, 0.05, 8, 20, Math.PI / 2), metal, -2.08, 1.63, 0.6);
  elbow.rotation.z = Math.PI / 2;
  pipe.castShadow = false;
  cylinder(0.33, 0.33, 1.15, 1.25, 0.76, -1.05, material(palette.cream));
  box(0.7, 0.6, 0.65, 1.25, 0.5, 0.7, sage);
  box(0.7, 0.11, 0.65, 1.25, 0.85, 0.7, white);
  // A plant outside adds scale without hiding the rooms.
  cylinder(0.2, 0.13, 0.33, -2.9, 0.06, 1.1, accent);
  cylinder(0.025, 0.025, 0.7, -2.9, 0.5, 1.1, dark);
  for (let i = 0; i < 5; i++) {
    const leaf = mesh(new THREE.SphereGeometry(0.2, 12, 8), sage, -2.9 + Math.sin(i * 2) * 0.16, 0.6 + i * 0.06, 1.1 + Math.cos(i * 2) * 0.13);
    leaf.scale.set(0.65, 1.5, 0.4);
    leaf.rotation.z = Math.sin(i) * 0.8;
  }
  const roof = new THREE.Group();
  scene.add(roof);
  const roofMaterial = material(palette.charcoal);
  const leftRoof = box(2.94, 0.14, 4.12, -1.3, 4.04, 0, roofMaterial, roof);
  leftRoof.rotation.z = Math.PI / 6;
  const rightRoof = box(2.94, 0.14, 4.12, 1.3, 4.04, 0, roofMaterial, roof);
  rightRoof.rotation.z = -Math.PI / 6;
  box(0.43, 0.95, 0.45, -1.65, 4.38, -0.9, roofMaterial, roof);
  // The exterior unfolds to expose the furnished cutaway.
  const shellMaterials = [material(palette.cream), material(palette.orange), material(0xb4c3be, 0.25), material(palette.orange)];
  const [shellWall, shellFrame, shellGlass, shellDoor] = shellMaterials;
  const leftFacade = new THREE.Group();
  const rightFacade = new THREE.Group();
  const sideFacade = new THREE.Group();
  leftFacade.position.set(-2.55, 0, 1.89);
  rightFacade.position.set(2.55, 0, 1.89);
  sideFacade.position.set(2.56, 0, 0);
  scene.add(leftFacade, rightFacade, sideFacade);
  box(2.55, 3.42, 0.13, 1.275, 1.81, 0, shellWall, leftFacade);
  box(2.55, 3.42, 0.13, -1.275, 1.81, 0, shellWall, rightFacade);
  box(0.13, 3.42, 3.7, 0, 1.81, 0, shellWall, sideFacade);
  for (const [parent, x] of [[leftFacade, 1.22], [rightFacade, -1.22]] as const) {
    box(1.03, 0.95, 0.09, x, 2.65, 0.1, shellFrame, parent);
    box(0.87, 0.79, 0.04, x, 2.65, 0.17, shellGlass, parent);
    box(0.045, 0.82, 0.06, x, 2.65, 0.2, shellWall, parent);
    box(0.89, 0.045, 0.06, x, 2.65, 0.2, shellWall, parent);
    box(1.15, 0.07, 0.22, x, 2.13, 0.15, shellWall, parent);
  }
  box(0.9, 1.48, 0.11, -1.23, 0.89, 0.12, shellDoor, rightFacade);
  box(0.07, 0.07, 0.08, -0.94, 0.91, 0.21, shellFrame, rightFacade);
  box(0.95, 0.8, 0.08, 1.22, 1.13, 0.1, shellFrame, leftFacade);
  box(0.8, 0.65, 0.04, 1.22, 1.13, 0.17, shellGlass, leftFacade);
  box(0.04, 0.67, 0.05, 1.22, 1.13, 0.2, shellWall, leftFacade);
  for (const y of [1.12, 2.65]) {
    box(0.08, 0.9, 1, 0.1, y, -0.2, shellFrame, sideFacade);
    box(0.04, 0.74, 0.84, 0.17, y, -0.2, shellGlass, sideFacade);
    box(0.06, 0.76, 0.04, 0.2, y, -0.2, shellWall, sideFacade);
    box(0.06, 0.04, 0.86, 0.2, y, -0.2, shellWall, sideFacade);
  }
  const gable = new THREE.Shape();
  gable.moveTo(-2.58, 3.35); gable.lineTo(0, 4.79); gable.lineTo(2.58, 3.35); gable.closePath();
  const gableMaterial = material(palette.sage);
  mesh(new THREE.ExtrudeGeometry(gable, { depth: 0.1, bevelEnabled: false }), gableMaterial, 0, 0, 1.9, roof);
  mesh(new THREE.ExtrudeGeometry(gable, { depth: 0.1, bevelEnabled: false }), gableMaterial, 0, 0, -2, roof);
  const revealMaterials = [...shellMaterials, roofMaterial, gableMaterial];
  revealMaterials.forEach(item => { item.transparent = true; });
  let open = false;
  let reveal = 0;
  let dragging = false;
  let hovered = false;
  let dirty = true;
  let visible = true;
  let frame = 0;
  let disposed = false;
  let lastTime = 0;
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const invalidate = () => { dirty = true; };
  controls.addEventListener('change', invalidate);
  const enter = (event: PointerEvent) => { if (event.pointerType === 'mouse') { hovered = true; open = true; } };
  const leave = () => { hovered = false; if (!dragging && document.activeElement !== host) open = false; };
  const down = () => { dragging = true; open = true; };
  const up = (event: PointerEvent) => {
    dragging = false;
    if (event.pointerType === 'mouse' && !hovered && document.activeElement !== host) open = false;
  };
  const cancel = () => { dragging = false; open = hovered; };
  const focus = () => { open = true; };
  const blur = () => { if (!hovered && !dragging) open = false; };
  function rotate(horizontal: number, vertical = 0) {
    const spherical = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target));
    spherical.theta += horizontal;
    spherical.phi = THREE.MathUtils.clamp(spherical.phi + vertical, controls.minPolarAngle, controls.maxPolarAngle);
    camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(spherical));
    controls.update(); dirty = true;
  }
  const keydown = (event: KeyboardEvent) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', ' ', 'Home', 'Escape'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Enter' || event.key === ' ') { open = !open; return; }
    if (event.key === 'Escape') { open = false; return; }
    if (event.key === 'Home') { camera.position.copy(initialPosition); controls.update(); open = false; dirty = true; return; }
    open = true;
    if (event.key === 'ArrowLeft') rotate(-Math.PI / 12);
    if (event.key === 'ArrowRight') rotate(Math.PI / 12);
    if (event.key === 'ArrowUp') rotate(0, -Math.PI / 20);
    if (event.key === 'ArrowDown') rotate(0, Math.PI / 20);
  };
  host.addEventListener('pointerenter', enter);
  host.addEventListener('pointerleave', leave);
  host.addEventListener('pointerdown', down);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
  host.addEventListener('focus', focus);
  host.addEventListener('blur', blur);
  host.addEventListener('keydown', keydown);
  function draw(time: number) {
    if (disposed) return;
    frame = requestAnimationFrame(draw);
    const delta = Math.min((time - lastTime) / 1000 || 0, 0.05);
    lastTime = time;
    if (!visible || document.hidden) return;
    const target = open ? 1 : 0;
    if (Math.abs(reveal - target) > 0.001) {
      reveal = motion.matches ? target : THREE.MathUtils.lerp(reveal, target, 1 - Math.exp(-delta * 5));
      dirty = true;
    } else if (reveal !== target) { reveal = target; dirty = true; }
    controls.update();
    if (!dirty) return;
    dirty = false;
    leftFacade.rotation.y = -reveal * Math.PI * 0.6;
    rightFacade.rotation.y = reveal * Math.PI * 0.6;
    sideFacade.position.x = 2.56 + reveal * 1.4;
    roof.position.y = reveal * 1.25;
    const opacity = 1 - THREE.MathUtils.smoothstep(reveal, 0.18, 0.88);
    revealMaterials.forEach(item => { item.opacity = opacity; });
    roof.visible = leftFacade.visible = rightFacade.visible = sideFacade.visible = opacity > 0.001;
    renderer.render(scene, camera);
  }
  const resize = new ResizeObserver(() => {
    if (!host.clientWidth || !host.clientHeight) return;
    renderer.setSize(host.clientWidth, host.clientHeight);
    camera.aspect = host.clientWidth / host.clientHeight;
    camera.updateProjectionMatrix(); dirty = true;
  });
  resize.observe(host);
  const observer = new IntersectionObserver(entries => { visible = entries[0]?.isIntersecting ?? true; if (visible) dirty = true; });
  observer.observe(host);
  frame = requestAnimationFrame(draw);
  return {
    dispose: () => {
      disposed = true; cancelAnimationFrame(frame);
      resize.disconnect(); observer.disconnect(); controls.dispose();
      controls.removeEventListener('change', invalidate);
      host.removeEventListener('pointerenter', enter);
      host.removeEventListener('pointerleave', leave);
      host.removeEventListener('pointerdown', down);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      host.removeEventListener('focus', focus);
      host.removeEventListener('blur', blur);
      host.removeEventListener('keydown', keydown);
      geometries.forEach(geometry => geometry.dispose());
      materials.forEach(item => item.dispose());
      renderer.dispose(); renderer.domElement.remove();
    },
  };
}