// Entry point for bundling 3d-force-graph + UnrealBloomPass with a shared THREE instance.
// This ensures both the graph and bloom post-processing use the same Three.js classes.
export { default as ForceGraph3D } from '3d-force-graph';
export { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
export { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
export { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
export { Vector2 } from 'three';
