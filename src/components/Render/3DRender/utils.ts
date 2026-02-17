import * as THREE from 'three';
import { Vector2D } from '../../Shared/vector';
import { getHeightAt } from '../../World/heightmap';
import type { HeightMap } from '../../World/heightmap';
import { SCALE, HEIGHT_SCALE } from './constants';

let _activeHeightMap: HeightMap | null = null;

export function setActiveHeightMap(heightMap: HeightMap | null): void {
    _activeHeightMap = heightMap;
}

export function toWorld(v: Vector2D): THREE.Vector3 {
    const y = _activeHeightMap ? getHeightAt(_activeHeightMap, v.x, v.y) * HEIGHT_SCALE : 0;
    return new THREE.Vector3(v.x * SCALE, y, v.y * SCALE);
}

export const tempMatrix = new THREE.Matrix4();
export const tempPosition = new THREE.Vector3();
export const tempQuaternion = new THREE.Quaternion();
export const tempScale = new THREE.Vector3();
export const tempColor = new THREE.Color();

export function hlAlpha(dt: number, halfLife: number): number {
    return 1 - Math.exp(-0.693147 * dt / halfLife);
}
