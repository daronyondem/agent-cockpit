// Separate bloom bundle — just UnrealBloomPass + Three.js.
// Loaded independently from 3d-force-graph (which has its own bundled THREE).
// This matches the official 3d-force-graph bloom example pattern.
export { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
export { Vector2 } from 'three';
