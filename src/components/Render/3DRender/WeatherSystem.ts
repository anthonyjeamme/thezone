import * as THREE from 'three';
import type { Scene } from '../../World/types';
import { RAIN_COUNT, RAIN_AREA, RAIN_HEIGHT_RANGE, RAIN_STREAK, RAIN_SPEED, SNOW_COUNT, SNOW_AREA, SNOW_HEIGHT_RANGE, SNOW_SPEED } from './constants';

export class WeatherSystem {
    private rainMesh: THREE.LineSegments | null = null;
    private rainPositions: Float32Array | null = null;
    private snowMesh: THREE.Points | null = null;
    private snowPositions: Float32Array | null = null;
    private lightningTimer = 0;
    private lightningFlash = 0;

    constructor(private scene: THREE.Scene) {
        this.initRainParticles();
        this.initSnowParticles();
    }

    private initRainParticles(): void {
        const COUNT = RAIN_COUNT;
        const positions = new Float32Array(COUNT * 2 * 3);
        for (let i = 0; i < COUNT; i++) {
            const x = (Math.random() - 0.5) * RAIN_AREA;
            const y = Math.random() * RAIN_HEIGHT_RANGE;
            const z = (Math.random() - 0.5) * RAIN_AREA;
            positions[i * 6 + 0] = x;
            positions[i * 6 + 1] = y + RAIN_STREAK;
            positions[i * 6 + 2] = z;
            positions[i * 6 + 3] = x;
            positions[i * 6 + 4] = y;
            positions[i * 6 + 5] = z;
        }
        this.rainPositions = positions;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        const mat = new THREE.LineBasicMaterial({
            color: 0xaaccff,
            transparent: true,
            opacity: 0.3,
        });
        this.rainMesh = new THREE.LineSegments(geo, mat);
        this.rainMesh.frustumCulled = false;
        this.rainMesh.visible = false;
        this.scene.add(this.rainMesh);
    }

    private initSnowParticles(): void {
        const COUNT = SNOW_COUNT;
        const positions = new Float32Array(COUNT * 3);
        for (let i = 0; i < COUNT; i++) {
            positions[i * 3 + 0] = (Math.random() - 0.5) * SNOW_AREA;
            positions[i * 3 + 1] = Math.random() * SNOW_HEIGHT_RANGE;
            positions[i * 3 + 2] = (Math.random() - 0.5) * SNOW_AREA;
        }
        this.snowPositions = positions;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        const mat = new THREE.PointsMaterial({
            color: 0xffffff,
            size: 3,
            sizeAttenuation: false,
            transparent: true,
            opacity: 0.85,
            depthWrite: false,
        });
        this.snowMesh = new THREE.Points(geo, mat);
        this.snowMesh.frustumCulled = false;
        this.snowMesh.visible = false;
        this.scene.add(this.snowMesh);
    }

    update(gameScene: Scene, dt: number, camera: THREE.Camera, elapsed: number): void {
        const weather = gameScene.weather;
        const weatherType = weather?.current ?? 'sunny';
        const intensity = weather?.rainIntensity ?? 0;
        const isStormy = weatherType === 'stormy';
        const isSnowy = weatherType === 'snowy';
        const isRaining = weatherType === 'rainy' || isStormy;

        if (this.rainMesh && this.rainPositions) {
            if (!isRaining || intensity <= 0.01) {
                this.rainMesh.visible = false;
            } else {
                this.rainMesh.visible = true;
                const cam = camera as THREE.PerspectiveCamera;
                this.rainMesh.position.set(cam.position.x, 0, cam.position.z);

                const speed = RAIN_SPEED * (0.5 + intensity * 0.5) * (isStormy ? 1.4 : 1);
                const windX = isStormy
                    ? Math.sin(elapsed * 0.7) * 6 * dt
                    : intensity * 1.2 * dt;
                const activeCount = Math.floor(RAIN_COUNT * intensity);

                for (let i = 0; i < RAIN_COUNT; i++) {
                    const base = i * 6;
                    if (i >= activeCount) {
                        this.rainPositions[base + 1] = -100;
                        this.rainPositions[base + 4] = -100;
                        continue;
                    }
                    const fall = speed * dt;
                    this.rainPositions[base + 1] -= fall;
                    this.rainPositions[base + 4] -= fall;
                    this.rainPositions[base + 0] += windX;
                    this.rainPositions[base + 3] += windX;

                    if (this.rainPositions[base + 4] < -1) {
                        const x = (Math.random() - 0.5) * RAIN_AREA;
                        const y = RAIN_HEIGHT_RANGE + Math.random() * 3;
                        const z = (Math.random() - 0.5) * RAIN_AREA;
                        this.rainPositions[base + 0] = x;
                        this.rainPositions[base + 1] = y + RAIN_STREAK;
                        this.rainPositions[base + 2] = z;
                        this.rainPositions[base + 3] = x;
                        this.rainPositions[base + 4] = y;
                        this.rainPositions[base + 5] = z;
                    }
                }

                const posAttr = this.rainMesh.geometry.getAttribute('position') as THREE.BufferAttribute;
                posAttr.needsUpdate = true;
                const rMat = this.rainMesh.material as THREE.LineBasicMaterial;
                rMat.opacity = 0.15 + intensity * 0.4;
            }
        }

        if (this.snowMesh && this.snowPositions) {
            const snowIntensity = isSnowy ? intensity : 0;
            if (snowIntensity <= 0.01) {
                this.snowMesh.visible = false;
            } else {
                this.snowMesh.visible = true;
                const cam = camera as THREE.PerspectiveCamera;
                this.snowMesh.position.set(cam.position.x, cam.position.y - SNOW_HEIGHT_RANGE * 0.4, cam.position.z);

                const activeCount = Math.floor(SNOW_COUNT * snowIntensity);
                for (let i = 0; i < SNOW_COUNT; i++) {
                    const base = i * 3;
                    if (i >= activeCount) {
                        this.snowPositions[base + 1] = -100;
                        continue;
                    }
                    this.snowPositions[base + 1] -= SNOW_SPEED * dt;
                    const phase = i * 0.1 + elapsed * 0.5;
                    this.snowPositions[base + 0] += Math.sin(phase) * 0.8 * dt;
                    this.snowPositions[base + 2] += Math.cos(phase * 0.7) * 0.6 * dt;

                    if (this.snowPositions[base + 1] < -1) {
                        this.snowPositions[base + 0] = (Math.random() - 0.5) * SNOW_AREA;
                        this.snowPositions[base + 1] = SNOW_HEIGHT_RANGE + Math.random() * 2;
                        this.snowPositions[base + 2] = (Math.random() - 0.5) * SNOW_AREA;
                    }
                }
                const posAttr = this.snowMesh.geometry.getAttribute('position') as THREE.BufferAttribute;
                posAttr.needsUpdate = true;
                const sMat = this.snowMesh.material as THREE.PointsMaterial;
                sMat.opacity = 0.5 + snowIntensity * 0.4;
            }
        }

        if (isStormy && intensity > 0.3) {
            this.lightningTimer -= dt;
            if (this.lightningTimer <= 0) {
                this.lightningFlash = 0.8 + Math.random() * 0.2;
                this.lightningTimer = 2 + Math.random() * 7;
            }
        }
        if (this.lightningFlash > 0) {
            this.lightningFlash -= dt * 5;
            if (this.lightningFlash < 0) this.lightningFlash = 0;
        }
    }

    getLightningFlash(): number {
        return this.lightningFlash;
    }

    destroy(): void {
        if (this.rainMesh) {
            this.scene.remove(this.rainMesh);
            this.rainMesh.geometry.dispose();
            (this.rainMesh.material as THREE.Material).dispose();
            this.rainMesh = null;
        }
        if (this.snowMesh) {
            this.scene.remove(this.snowMesh);
            this.snowMesh.geometry.dispose();
            (this.snowMesh.material as THREE.Material).dispose();
            this.snowMesh = null;
        }
    }
}
