// =============================================================
//  THREE.JS 3D RENDERER — Minecraft-style characters, orbital camera
// =============================================================

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GameRenderer, registerRenderer } from '../GameRenderer';
import {
    BuildingEntity, Camera, CorpseEntity, FertileZoneEntity, FruitEntity,
    Highlight, NPCEntity, PlantEntity, ResourceEntity, Scene, StockEntity,
    getCalendar, getLifeStage, LifeStage,
} from '../../World/types';
import { getSpecies } from '../../World/flora';
import { Vector2D } from '../../Shared/vector';
import type { SoilGrid, SoilProperty } from '../../World/fertility';
import type { HeightMap, BasinMap } from '../../World/heightmap';
import { getHeightAt } from '../../World/heightmap';
import type { SoilOverlay } from '../GameRenderer';

// --- Scale: 1 game unit (px) = 0.1 three.js unit ---
const SCALE = 0.1;
const HEIGHT_SCALE = SCALE; // height uses same scale

/** Convert 2D world position to 3D, optionally using heightmap */
let _activeHeightMap: HeightMap | null = null;
const toWorld = (v: Vector2D) => {
    const y = _activeHeightMap ? getHeightAt(_activeHeightMap, v.x, v.y) * HEIGHT_SCALE : 0;
    return new THREE.Vector3(v.x * SCALE, y, v.y * SCALE);
};

// --- Soil overlay color palettes (same as Canvas2DRenderer) ---
const SOIL_OVERLAY_COLORS: Record<SoilProperty, { r0: number; g0: number; b0: number; r1: number; g1: number; b1: number }> = {
    humidity: { r0: 200, g0: 184, b0: 122, r1: 26, g1: 122, b1: 180 },
    minerals: { r0: 180, g0: 170, b0: 150, r1: 160, g1: 100, b1: 30 },
    organicMatter: { r0: 200, g0: 190, b0: 170, r1: 40, g1: 30, b1: 10 },
    sunExposure: { r0: 60, g0: 60, b0: 80, r1: 255, g1: 240, b1: 140 },
};

// --- NPC sizes by life stage ---
const NPC_HEIGHT: Record<LifeStage, number> = { baby: 0.4, child: 0.7, adolescent: 1.0, adult: 1.2 };
const NPC_WIDTH: Record<LifeStage, number> = { baby: 0.25, child: 0.35, adolescent: 0.4, adult: 0.45 };

// =============================================================
//  INSTANCED RENDERING — shared types & temp objects
// =============================================================

/** A single visual part of a plant template (e.g., trunk, crown) */
type PlantPartDef = {
    geo: THREE.BufferGeometry;
    mat: THREE.MeshLambertMaterial;
    offsetY: number; // local Y offset from plant base (before instance scale)
};

// Reusable temp objects to avoid GC pressure (never create these in a loop)
const _mat4 = new THREE.Matrix4();
const _pos3 = new THREE.Vector3();
const _quat = new THREE.Quaternion(); // identity
const _scl3 = new THREE.Vector3();
const _col3 = new THREE.Color();

// =============================================================
//  MINECRAFT-STYLE CHARACTER BUILDER
// =============================================================

function createMinecraftCharacter(color: string, stage: LifeStage): THREE.Group {
    const group = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({ color });
    const skinMat = new THREE.MeshLambertMaterial({ color: '#ffdbac' });
    const h = NPC_HEIGHT[stage];
    const w = NPC_WIDTH[stage];

    // --- Head ---
    const headSize = w * 0.8;
    const headGeo = new THREE.BoxGeometry(headSize, headSize, headSize);
    const head = new THREE.Mesh(headGeo, skinMat);
    head.position.y = h - headSize / 2;
    head.castShadow = true;
    group.add(head);

    // --- Eyes ---
    const eyeMat = new THREE.MeshBasicMaterial({ color: '#222' });
    const eyeSize = headSize * 0.12;
    const eyeGeo = new THREE.BoxGeometry(eyeSize, eyeSize * 0.6, eyeSize * 0.3);
    const leftEye = new THREE.Mesh(eyeGeo, eyeMat);
    leftEye.position.set(-headSize * 0.2, h - headSize * 0.45, headSize / 2 + 0.01);
    group.add(leftEye);
    const rightEye = new THREE.Mesh(eyeGeo, eyeMat);
    rightEye.position.set(headSize * 0.2, h - headSize * 0.45, headSize / 2 + 0.01);
    group.add(rightEye);

    // --- Body ---
    const bodyH = h * 0.35;
    const bodyW = w * 0.7;
    const bodyGeo = new THREE.BoxGeometry(bodyW, bodyH, bodyW * 0.6);
    const body = new THREE.Mesh(bodyGeo, mat);
    body.position.y = h - headSize - bodyH / 2;
    body.castShadow = true;
    group.add(body);

    // --- Arms (pivot at shoulder) ---
    const armH = bodyH * 0.9;
    const armW = bodyW * 0.25;
    const armGeo = new THREE.BoxGeometry(armW, armH, armW);
    const shoulderY = h - headSize; // top of body = shoulder height

    // Left arm: pivot at shoulder, mesh hangs down
    const leftArmPivot = new THREE.Group();
    leftArmPivot.position.set(-(bodyW / 2 + armW / 2), shoulderY, 0);
    leftArmPivot.name = 'leftArm';
    const leftArmMesh = new THREE.Mesh(armGeo, mat);
    leftArmMesh.position.y = -armH / 2; // hang down from shoulder
    leftArmMesh.castShadow = true;
    leftArmPivot.add(leftArmMesh);
    group.add(leftArmPivot);

    // Right arm: pivot at shoulder, mesh hangs down
    const rightArmPivot = new THREE.Group();
    rightArmPivot.position.set(bodyW / 2 + armW / 2, shoulderY, 0);
    rightArmPivot.name = 'rightArm';
    const rightArmMesh = new THREE.Mesh(armGeo, mat);
    rightArmMesh.position.y = -armH / 2;
    rightArmMesh.castShadow = true;
    rightArmPivot.add(rightArmMesh);
    group.add(rightArmPivot);

    // --- Legs (pivot at hip) ---
    const legH = h - headSize - bodyH;
    const legW = bodyW * 0.35;
    const legGeo = new THREE.BoxGeometry(legW, legH, legW);
    const legMat = new THREE.MeshLambertMaterial({ color: '#5a3a1a' });
    const hipY = h - headSize - bodyH; // bottom of body = hip height

    // Left leg: pivot at hip, mesh hangs down
    const leftLegPivot = new THREE.Group();
    leftLegPivot.position.set(-legW * 0.6, hipY, 0);
    leftLegPivot.name = 'leftLeg';
    const leftLegMesh = new THREE.Mesh(legGeo, legMat);
    leftLegMesh.position.y = -legH / 2; // hang down from hip
    leftLegMesh.castShadow = true;
    leftLegPivot.add(leftLegMesh);
    group.add(leftLegPivot);

    // Right leg: pivot at hip, mesh hangs down
    const rightLegPivot = new THREE.Group();
    rightLegPivot.position.set(legW * 0.6, hipY, 0);
    rightLegPivot.name = 'rightLeg';
    const rightLegMesh = new THREE.Mesh(legGeo, legMat);
    rightLegMesh.position.y = -legH / 2;
    rightLegMesh.castShadow = true;
    rightLegPivot.add(rightLegMesh);
    group.add(rightLegPivot);

    group.castShadow = true;
    return group;
}

// --- Walk animation ---
function animateWalk(group: THREE.Group, time: number, isMoving: boolean) {
    const leftArm = group.getObjectByName('leftArm');
    const rightArm = group.getObjectByName('rightArm');
    const leftLeg = group.getObjectByName('leftLeg');
    const rightLeg = group.getObjectByName('rightLeg');

    if (!isMoving) {
        // Idle pose
        if (leftArm) leftArm.rotation.x = 0;
        if (rightArm) rightArm.rotation.x = 0;
        if (leftLeg) leftLeg.rotation.x = 0;
        if (rightLeg) rightLeg.rotation.x = 0;
        return;
    }

    const swing = Math.sin(time * 8) * 0.6;
    if (leftArm) leftArm.rotation.x = swing;
    if (rightArm) rightArm.rotation.x = -swing;
    if (leftLeg) leftLeg.rotation.x = -swing;
    if (rightLeg) rightLeg.rotation.x = swing;
}

// =============================================================
//  BUILDING MESH BUILDERS
// =============================================================

function createCabinMesh(entity: BuildingEntity): THREE.Group {
    const group = new THREE.Group();
    const pos = toWorld(entity.position);

    // Walls
    const wallMat = new THREE.MeshLambertMaterial({ color: '#8B6914' });
    const wallGeo = new THREE.BoxGeometry(2, 1.5, 2);
    const walls = new THREE.Mesh(wallGeo, wallMat);
    walls.position.set(pos.x, 0.75, pos.z);
    walls.castShadow = true;
    walls.receiveShadow = true;
    group.add(walls);

    // Roof (pyramid)
    const roofGeo = new THREE.ConeGeometry(1.7, 1, 4);
    const roofMat = new THREE.MeshLambertMaterial({ color: '#5a3a1a' });
    const roof = new THREE.Mesh(roofGeo, roofMat);
    roof.position.set(pos.x, 2, pos.z);
    roof.rotation.y = Math.PI / 4;
    roof.castShadow = true;
    group.add(roof);

    // Door
    const doorMat = new THREE.MeshLambertMaterial({ color: '#3e2507' });
    const doorGeo = new THREE.BoxGeometry(0.4, 0.7, 0.05);
    const door = new THREE.Mesh(doorGeo, doorMat);
    door.position.set(pos.x, 0.35, pos.z + 1.01);
    group.add(door);

    return group;
}

function createResourceMesh(entity: ResourceEntity): THREE.Mesh {
    const pos = toWorld(entity.position);
    let mesh: THREE.Mesh;

    if (entity.resourceType === 'wood') {
        // Tree trunk + top
        const trunkGeo = new THREE.CylinderGeometry(0.1, 0.12, 0.8, 6);
        const trunkMat = new THREE.MeshLambertMaterial({ color: '#5a3a1a' });
        const trunk = new THREE.Mesh(trunkGeo, trunkMat);
        trunk.position.set(pos.x, 0.4, pos.z);
        trunk.castShadow = true;

        const leavesGeo = new THREE.SphereGeometry(0.35, 6, 6);
        const leavesMat = new THREE.MeshLambertMaterial({ color: '#2d8c3e' });
        const leaves = new THREE.Mesh(leavesGeo, leavesMat);
        leaves.position.set(pos.x, 0.9, pos.z);
        leaves.castShadow = true;

        // Return trunk as main mesh, attach leaves as child
        trunk.add(leaves);
        leaves.position.set(0, 0.5, 0);
        mesh = trunk;
    } else if (entity.resourceType === 'water') {
        const geo = new THREE.SphereGeometry(0.2, 8, 8);
        const mat = new THREE.MeshLambertMaterial({ color: '#00bcd4', transparent: true, opacity: 0.7 });
        mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(pos.x, 0.2, pos.z);
    } else {
        // Food: small bush/berry
        const geo = new THREE.SphereGeometry(0.15, 6, 6);
        const mat = new THREE.MeshLambertMaterial({ color: '#2ecc71' });
        mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(pos.x, 0.15, pos.z);
        mesh.castShadow = true;
    }

    return mesh;
}

function createCorpseMesh(entity: CorpseEntity): THREE.Mesh {
    const pos = toWorld(entity.position);
    const geo = new THREE.BoxGeometry(0.6, 0.1, 0.3);
    const mat = new THREE.MeshLambertMaterial({ color: entity.color, transparent: true, opacity: 0.4 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(pos.x, 0.05, pos.z);
    return mesh;
}

function createZoneMesh(entity: FertileZoneEntity): THREE.Mesh {
    const pos = toWorld(entity.position);
    const r = entity.radius * SCALE;
    const geo = new THREE.CircleGeometry(r, 32);
    const colorMap: Record<string, string> = { food: '#2ecc71', water: '#00bcd4', wood: '#8B6914' };
    const mat = new THREE.MeshBasicMaterial({
        color: colorMap[entity.resourceType] ?? '#888',
        transparent: true,
        opacity: 0.15,
        side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(pos.x, 0.02, pos.z);
    return mesh;
}

// =============================================================
//  THREE.JS RENDERER
// =============================================================

class ThreeRenderer implements GameRenderer {
    readonly id = 'three3d';
    readonly name = '3D (Three.js)';

    private renderer: THREE.WebGLRenderer | null = null;
    private threeScene: THREE.Scene | null = null;
    private threeCamera: THREE.PerspectiveCamera | null = null;
    private controls: OrbitControls | null = null;
    private container: HTMLElement | null = null;
    private clock = new THREE.Clock();

    // Entity mesh pools
    private npcMeshes = new Map<string, THREE.Group>();
    private buildingMeshes = new Map<string, THREE.Group>();
    private resourceMeshes = new Map<string, THREE.Object3D>();
    private corpseMeshes = new Map<string, THREE.Mesh>();
    private zoneMeshes = new Map<string, THREE.Mesh>();
    private stockLabels = new Map<string, THREE.Sprite>();
    // Instanced rendering pools
    private plantPartCache = new Map<string, PlantPartDef[]>();
    private plantInstances = new Map<string, THREE.InstancedMesh>();
    private fruitGeo: THREE.SphereGeometry | null = null;
    private fruitMatCache = new Map<string, THREE.MeshLambertMaterial>();
    private fruitInstances = new Map<string, THREE.InstancedMesh>();
    private highlightMesh: THREE.Mesh | null = null;

    // Ground
    private ground: THREE.Mesh | null = null;
    private groundTextureApplied = false;
    private groundHeightApplied = false;
    private currentOverlay: SoilOverlay = undefined as unknown as SoilOverlay; // force first update
    private groundTexture: THREE.CanvasTexture | null = null;
    // Water mesh for lakes
    private waterMesh: THREE.Mesh | null = null;
    private waterGeometry: THREE.PlaneGeometry | null = null;
    private waterTexture: THREE.CanvasTexture | null = null;
    private waterUpdateTimer = 0;
    private static readonly WATER_UPDATE_INTERVAL = 500; // ms between water mesh updates
    // Grass chunk system — streams grass around camera
    private grassChunks = new Map<string, { instA: THREE.InstancedMesh; instB: THREE.InstancedMesh }>();
    private grassMat: THREE.MeshLambertMaterial | null = null;
    private grassPlaneGeo: THREE.PlaneGeometry | null = null;
    private grassLastCamX = Infinity;
    private grassLastCamZ = Infinity;
    private static readonly GRASS_CHUNK_SIZE = 60;    // world units per chunk
    private static readonly GRASS_RENDER_RADIUS = 250; // world units — chunks within this radius
    private static readonly GRASS_STEP = 0.7;          // world units between patches
    private static readonly GRASS_FADE_START = 0.7;    // start fading at 70% of render radius
    // Sun light
    private sunLight: THREE.DirectionalLight | null = null;

    // Third-person player
    private playerMesh: THREE.Group | null = null;
    private playerPos = { x: 0, y: 0 }; // 2D world position (game units)
    private playerAngle = 0;             // facing direction (radians, smoothed)
    private thirdPerson = false;         // camera mode flag
    private keysDown = new Set<string>();
    private keyHandler: ((e: KeyboardEvent) => void) | null = null;
    private keyUpHandler: ((e: KeyboardEvent) => void) | null = null;
    // Camera orbit controlled by mouse
    private cameraYaw = 0;               // horizontal orbit angle (radians)
    private cameraPitch = 0.4;           // vertical angle (radians, 0 = horizontal)
    private cameraDistance = 1.8;        // distance from player
    private mouseMoveHandler: ((e: MouseEvent) => void) | null = null;
    private pointerLockHandler: (() => void) | null = null;
    private static readonly PLAYER_SPEED = 2; // game units per second
    private static readonly MOUSE_SENSITIVITY = 0.001;
    // Smoothed camera follow target — prevents bobbing & shift on direction changes
    private cameraFollowTarget = new THREE.Vector3();
    private cameraFollowInit = false;

    init(container: HTMLElement): void {
        this.container = container;

        // --- Renderer ---
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        this.renderer.setClearColor(0x87ceeb); // sky blue
        container.appendChild(this.renderer.domElement);

        // --- Scene ---
        this.threeScene = new THREE.Scene();
        this.threeScene.fog = new THREE.Fog(0x87ceeb, 80, 200);

        // --- Camera ---
        this.threeCamera = new THREE.PerspectiveCamera(60, 1, 0.1, 500);
        this.threeCamera.position.set(0, 20, 30);
        this.threeCamera.lookAt(0, 0, 0);

        // --- Orbit controls ---
        this.controls = new OrbitControls(this.threeCamera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.08;
        this.controls.maxPolarAngle = Math.PI / 2.1; // don't go below ground
        this.controls.minDistance = 5;
        this.controls.maxDistance = 150;
        this.controls.target.set(0, 0, 0);

        // --- Lights ---
        const ambient = new THREE.AmbientLight(0xffffff, 0.5);
        this.threeScene.add(ambient);

        this.sunLight = new THREE.DirectionalLight(0xfff5e0, 1.2);
        this.sunLight.position.set(30, 50, 20);
        this.sunLight.castShadow = true;
        this.sunLight.shadow.mapSize.width = 2048;
        this.sunLight.shadow.mapSize.height = 2048;
        this.sunLight.shadow.camera.near = 0.5;
        this.sunLight.shadow.camera.far = 200;
        this.sunLight.shadow.camera.left = -80;
        this.sunLight.shadow.camera.right = 80;
        this.sunLight.shadow.camera.top = 80;
        this.sunLight.shadow.camera.bottom = -80;
        this.threeScene.add(this.sunLight);

        // --- Ground ---
        const groundGeo = new THREE.PlaneGeometry(400, 400);
        const groundMat = new THREE.MeshLambertMaterial({ color: 0x3a7d44 });
        this.ground = new THREE.Mesh(groundGeo, groundMat);
        this.ground.rotation.x = -Math.PI / 2;
        this.ground.position.y = 0;
        this.ground.receiveShadow = true;
        this.threeScene.add(this.ground);

        // --- Highlight mesh (reusable) ---
        const hlGeo = new THREE.RingGeometry(0.6, 0.8, 32);
        const hlMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true, opacity: 0.7 });
        this.highlightMesh = new THREE.Mesh(hlGeo, hlMat);
        this.highlightMesh.rotation.x = -Math.PI / 2;
        this.highlightMesh.visible = false;
        this.threeScene.add(this.highlightMesh);

        // --- Player mesh (third-person) ---
        this.playerMesh = createMinecraftCharacter('#e74c3c', 'adult');
        this.playerMesh.scale.setScalar(0.25);
        this.playerMesh.visible = false;
        this.threeScene.add(this.playerMesh);

        // --- Keyboard handlers ---
        this.keyHandler = (e: KeyboardEvent) => this.keysDown.add(e.key.toLowerCase());
        this.keyUpHandler = (e: KeyboardEvent) => this.keysDown.delete(e.key.toLowerCase());
        window.addEventListener('keydown', this.keyHandler);
        window.addEventListener('keyup', this.keyUpHandler);

        // --- Mouse look (pointer lock) ---
        this.mouseMoveHandler = (e: MouseEvent) => {
            if (!this.thirdPerson) return;
            if (document.pointerLockElement !== this.renderer!.domElement) return;
            this.cameraYaw -= e.movementX * ThreeRenderer.MOUSE_SENSITIVITY;
            this.cameraPitch += e.movementY * ThreeRenderer.MOUSE_SENSITIVITY;
            // Clamp pitch to avoid flipping
            this.cameraPitch = Math.max(-0.2, Math.min(1.2, this.cameraPitch));
        };
        document.addEventListener('mousemove', this.mouseMoveHandler);

        // Request pointer lock on click when in third-person
        this.pointerLockHandler = () => {
            if (this.thirdPerson && document.pointerLockElement !== this.renderer!.domElement) {
                this.renderer!.domElement.requestPointerLock();
            }
        };
        this.renderer.domElement.addEventListener('click', this.pointerLockHandler);

        // Initial resize
        const rect = container.getBoundingClientRect();
        this.resize(rect.width, rect.height);
    }

    render(scene: Scene, camera: Camera, highlight: Highlight, soilOverlay?: SoilOverlay): void {
        if (!this.renderer || !this.threeScene || !this.threeCamera || !this.controls) return;

        // Set active heightmap so toWorld() uses it
        _activeHeightMap = scene.heightMap ?? null;

        const elapsed = this.clock.getElapsedTime();

        // --- Apply heightmap geometry (once) ---
        if (!this.groundHeightApplied && scene.heightMap && this.ground) {
            this.applyHeightGeometry(scene.heightMap);
            this.groundHeightApplied = true;
        }

        // --- Stream grass chunks around camera ---
        if (this.groundHeightApplied && scene.soilGrid && scene.heightMap) {
            this.updateGrassChunks(scene);
        }

        // --- Update ground texture when overlay changes ---
        const overlay = soilOverlay ?? null;
        if (overlay !== this.currentOverlay || !this.groundTextureApplied) {
            this.currentOverlay = overlay;
            this.updateGroundTexture(scene);
            this.groundTextureApplied = true;
        }

        // --- Night/day cycle ---
        const { nightFactor } = getCalendar(scene.time);
        this.updateLighting(nightFactor);

        // --- Sync entities ---
        this.syncPlants(scene);
        this.syncFruits(scene);
        this.syncNPCs(scene, elapsed, highlight);
        this.syncBuildings(scene);
        this.syncResources(scene);
        this.syncCorpses(scene);
        this.syncZones(scene);
        this.syncStockLabels(scene);
        this.syncHighlight(highlight);

        // --- Update water mesh (lakes) ---
        this.updateWaterMesh(scene);

        // --- Third-person player ---
        this.updatePlayer(scene, elapsed);

        // --- Render ---
        if (!this.thirdPerson) {
            this.controls.update();
        }
        this.renderer.render(this.threeScene, this.threeCamera);
    }

    resize(width: number, height: number): void {
        if (!this.renderer || !this.threeCamera) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        this.renderer.setSize(width, height);
        this.renderer.setPixelRatio(dpr);
        this.threeCamera.aspect = width / height;
        this.threeCamera.updateProjectionMatrix();
    }

    /** Toggle third-person mode on/off. Returns the new state. */
    setThirdPerson(enabled: boolean): boolean {
        this.thirdPerson = enabled;
        if (this.playerMesh) this.playerMesh.visible = enabled;
        if (this.controls) this.controls.enabled = !enabled;
        // Release pointer lock when leaving third-person
        if (!enabled && document.pointerLockElement === this.renderer?.domElement) {
            document.exitPointerLock();
        }
        return enabled;
    }

    isThirdPerson(): boolean {
        return this.thirdPerson;
    }

    private updatePlayer(_scene: Scene, elapsed: number) {
        if (!this.playerMesh || !this.threeCamera) return;

        if (!this.thirdPerson) {
            this.playerMesh.visible = false;
            return;
        }

        this.playerMesh.visible = true;

        const dt = this.clock.getDelta() || 1 / 60;
        const speed = ThreeRenderer.PLAYER_SPEED;

        // --- Forward / right derived from camera yaw (mouse-controlled) ---
        const fwdX = Math.sin(this.cameraYaw);
        const fwdZ = Math.cos(this.cameraYaw);
        const rightX = -Math.cos(this.cameraYaw);
        const rightZ = Math.sin(this.cameraYaw);

        // --- Keyboard input → movement relative to camera direction ---
        let moveX = 0, moveZ = 0;
        const keys = this.keysDown;
        if (keys.has('z') || keys.has('w') || keys.has('arrowup')) { moveX += fwdX; moveZ += fwdZ; }
        if (keys.has('s') || keys.has('arrowdown')) { moveX -= fwdX; moveZ -= fwdZ; }
        if (keys.has('q') || keys.has('a') || keys.has('arrowleft')) { moveX -= rightX; moveZ -= rightZ; }
        if (keys.has('d') || keys.has('arrowright')) { moveX += rightX; moveZ += rightZ; }

        const moving = moveX !== 0 || moveZ !== 0;

        if (moving) {
            const len = Math.sqrt(moveX * moveX + moveZ * moveZ);
            moveX /= len;
            moveZ /= len;

            // Update game-space position
            this.playerPos.x += (moveX / SCALE) * speed * dt;
            this.playerPos.y += (moveZ / SCALE) * speed * dt;
        }

        // --- Character always faces camera direction (smooth) ---
        const targetAngle = this.cameraYaw;
        let diff = targetAngle - this.playerAngle;
        if (diff > Math.PI) diff -= Math.PI * 2;
        if (diff < -Math.PI) diff += Math.PI * 2;
        const rotLerp = 1 - Math.pow(0.00001, dt); // very fast, frame-rate independent
        this.playerAngle += diff * rotLerp;

        // --- Position on terrain ---
        const pos = toWorld(this.playerPos);
        this.playerMesh.position.set(pos.x, pos.y, pos.z);
        this.playerMesh.rotation.y = this.playerAngle;

        // Walk animation
        animateWalk(this.playerMesh, elapsed, moving);

        // --- Smooth camera follow target ---
        // Separate lerp rates: XZ fast, Y very slow (prevents terrain bobbing)
        const headY = pos.y + 0.4;
        if (!this.cameraFollowInit) {
            this.cameraFollowTarget.set(pos.x, headY, pos.z);
            this.cameraFollowInit = true;
        } else {
            const lerpXZ = 1 - Math.pow(0.001, dt); // fast XZ follow (~0.93 at 60fps)
            const lerpY = 1 - Math.pow(0.05, dt);  // slow Y follow (~0.25 at 60fps) — kills bobbing
            this.cameraFollowTarget.x += (pos.x - this.cameraFollowTarget.x) * lerpXZ;
            this.cameraFollowTarget.z += (pos.z - this.cameraFollowTarget.z) * lerpXZ;
            this.cameraFollowTarget.y += (headY - this.cameraFollowTarget.y) * lerpY;
        }

        const pivot = this.cameraFollowTarget;

        // --- Camera orbits smoothed pivot via mouse yaw/pitch ---
        const dist = this.cameraDistance;
        const cosPitch = Math.cos(this.cameraPitch);
        const sinPitch = Math.sin(this.cameraPitch);
        const targetCamX = pivot.x - Math.sin(this.cameraYaw) * cosPitch * dist;
        const targetCamY = pivot.y + sinPitch * dist;
        const targetCamZ = pivot.z - Math.cos(this.cameraYaw) * cosPitch * dist;

        // Smooth camera position (frame-rate independent)
        const camLerp = 1 - Math.pow(0.0001, dt); // very responsive (~0.97 at 60fps)
        this.threeCamera.position.x += (targetCamX - this.threeCamera.position.x) * camLerp;
        this.threeCamera.position.y += (targetCamY - this.threeCamera.position.y) * camLerp;
        this.threeCamera.position.z += (targetCamZ - this.threeCamera.position.z) * camLerp;

        // Look at smoothed pivot (not raw player pos)
        this.threeCamera.lookAt(pivot);
    }

    destroy(): void {
        // Remove keyboard listeners
        if (this.keyHandler) window.removeEventListener('keydown', this.keyHandler);
        if (this.keyUpHandler) window.removeEventListener('keyup', this.keyUpHandler);

        // Remove mouse listeners
        if (this.mouseMoveHandler) document.removeEventListener('mousemove', this.mouseMoveHandler);
        if (this.pointerLockHandler && this.renderer) {
            this.renderer.domElement.removeEventListener('click', this.pointerLockHandler);
        }
        if (document.pointerLockElement === this.renderer?.domElement) {
            document.exitPointerLock();
        }

        // Dispose player mesh
        if (this.playerMesh) this.disposeObject(this.playerMesh);
        this.playerMesh = null;

        // Dispose all meshes
        this.npcMeshes.forEach((m) => this.disposeObject(m));
        this.buildingMeshes.forEach((m) => this.disposeObject(m));
        this.resourceMeshes.forEach((m) => this.disposeObject(m));
        this.corpseMeshes.forEach((m) => this.disposeObject(m));
        this.zoneMeshes.forEach((m) => this.disposeObject(m));
        this.stockLabels.forEach((m) => this.disposeObject(m));
        // Dispose instanced plant meshes
        for (const inst of this.plantInstances.values()) {
            this.threeScene?.remove(inst);
            inst.dispose();
        }
        this.plantInstances.clear();
        // Dispose cached plant part geometries & materials
        for (const parts of this.plantPartCache.values()) {
            for (const p of parts) { p.geo.dispose(); p.mat.dispose(); }
        }
        this.plantPartCache.clear();
        // Dispose instanced fruit meshes
        for (const inst of this.fruitInstances.values()) {
            this.threeScene?.remove(inst);
            inst.dispose();
        }
        this.fruitInstances.clear();
        if (this.fruitGeo) { this.fruitGeo.dispose(); this.fruitGeo = null; }
        for (const mat of this.fruitMatCache.values()) mat.dispose();
        this.fruitMatCache.clear();

        this.npcMeshes.clear();
        this.buildingMeshes.clear();
        this.resourceMeshes.clear();
        this.corpseMeshes.clear();
        this.zoneMeshes.clear();
        this.stockLabels.clear();

        // Dispose grass chunks
        for (const chunk of this.grassChunks.values()) {
            this.threeScene?.remove(chunk.instA);
            this.threeScene?.remove(chunk.instB);
            chunk.instA.dispose();
            chunk.instB.dispose();
        }
        this.grassChunks.clear();
        if (this.grassPlaneGeo) { this.grassPlaneGeo.dispose(); this.grassPlaneGeo = null; }
        if (this.grassMat) { this.grassMat.dispose(); this.grassMat = null; }

        // Dispose water mesh
        if (this.waterMesh) this.disposeObject(this.waterMesh);
        this.waterMesh = null;
        this.waterGeometry = null;
        if (this.waterTexture) this.waterTexture.dispose();
        this.waterTexture = null;

        this.controls?.dispose();
        this.renderer?.dispose();

        if (this.renderer && this.container) {
            this.container.removeChild(this.renderer.domElement);
        }

        this.renderer = null;
        this.threeScene = null;
        this.threeCamera = null;
        this.controls = null;
        this.container = null;
    }

    getElement(): HTMLElement | null {
        return this.renderer?.domElement ?? null;
    }

    screenToWorld(screenX: number, screenY: number, camera: Camera): Vector2D {
        if (!this.renderer || !this.threeCamera) return { x: 0, y: 0 };

        const rect = this.renderer.domElement.getBoundingClientRect();
        const mouse = new THREE.Vector2(
            ((screenX - rect.left) / rect.width) * 2 - 1,
            -((screenY - rect.top) / rect.height) * 2 + 1,
        );

        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(mouse, this.threeCamera);

        // Intersect ground plane (y=0)
        const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
        const target = new THREE.Vector3();
        raycaster.ray.intersectPlane(plane, target);

        return { x: target.x / SCALE, y: target.z / SCALE };
    }

    // =============================================================
    //  GRASS CHUNK SYSTEM — streams instanced grass around camera
    // =============================================================

    private ensureGrassMaterial() {
        if (this.grassMat) return;
        const loader = new THREE.TextureLoader();
        const grassTex = loader.load('/textures/grass.png');
        grassTex.magFilter = THREE.LinearFilter;
        grassTex.minFilter = THREE.LinearMipmapLinearFilter;
        this.grassMat = new THREE.MeshLambertMaterial({
            map: grassTex,
            transparent: true,
            alphaTest: 0.3,
            side: THREE.DoubleSide,
            depthWrite: false,
        });
        this.grassPlaneGeo = new THREE.PlaneGeometry(0.8, 0.8);
        this.grassPlaneGeo.translate(0, 0.4, 0);
    }

    /** Build a single grass chunk at chunk grid coords (cx, cz) */
    private buildGrassChunk(
        cx: number, cz: number,
        soilGrid: SoilGrid, heightMap: HeightMap,
        camWX: number, camWZ: number,
    ): { instA: THREE.InstancedMesh; instB: THREE.InstancedMesh } | null {
        const CS = ThreeRenderer.GRASS_CHUNK_SIZE;
        const STEP = ThreeRenderer.GRASS_STEP;
        const RADIUS = ThreeRenderer.GRASS_RENDER_RADIUS;
        const FADE = ThreeRenderer.GRASS_FADE_START;

        const worldX0 = cx * CS;
        const worldZ0 = cz * CS;

        // Deterministic seed per chunk for consistent randomness
        const seed = (cx * 73856093) ^ (cz * 19349663);
        let rng = (seed & 0x7fffffff) || 1;
        const rand = () => { rng = (rng * 16807) % 2147483647; return (rng & 0x7fffffff) / 0x7fffffff; };

        type GrassEntry = { x: number; y: number; z: number; scale: number; rot: number };
        const entries: GrassEntry[] = [];

        for (let lx = 0; lx < CS; lx += STEP) {
            for (let lz = 0; lz < CS; lz += STEP) {
                const wx = worldX0 + lx + (rand() - 0.5) * STEP * 1.4;
                const wz = worldZ0 + lz + (rand() - 0.5) * STEP * 1.4;

                // Soil check
                const col = Math.floor((wx - soilGrid.originX) / soilGrid.cellSize);
                const row = Math.floor((wz - soilGrid.originY) / soilGrid.cellSize);
                if (col < 0 || col >= soilGrid.cols || row < 0 || row >= soilGrid.rows) continue;
                const idx = row * soilGrid.cols + col;
                const hum = soilGrid.layers.humidity[idx];
                const waterLvl = soilGrid.waterLevel[idx];
                if (waterLvl > 0.1) continue;
                if (hum < 0.10) continue; // absolute minimum

                // Smooth humidity gradient: density + size taper off gradually
                const humFactor = Math.min(1, Math.max(0, (hum - 0.10) / 0.40)); // 0→1 over hum 0.10..0.50
                // Probabilistic density: less humid = fewer patches
                if (rand() > humFactor * humFactor) continue; // squared for sharper falloff in dry areas

                // Distance fade: shrink grass near edge of render radius
                const distToCam = Math.sqrt((wx - camWX) ** 2 + (wz - camWZ) ** 2);
                if (distToCam > RADIUS) continue;
                const fadeRatio = distToCam / RADIUS;
                const distFade = fadeRatio > FADE ? 1 - (fadeRatio - FADE) / (1 - FADE) : 1;

                const h = getHeightAt(heightMap, wx, wz) * HEIGHT_SCALE;
                // Size also scales with humidity — sparse thin grass in dry, lush in wet
                const humScale = 0.5 + humFactor * 0.5; // 50%–100% size
                const baseScale = (0.15 + rand() * 0.15) * humScale;
                const scale = baseScale * distFade;
                if (scale < 0.02) continue; // too small, skip
                const rot = rand() * Math.PI;

                entries.push({ x: wx * SCALE, y: h, z: wz * SCALE, scale, rot });
            }
        }

        if (entries.length === 0) return null;

        this.ensureGrassMaterial();
        const count = entries.length;

        const instA = new THREE.InstancedMesh(this.grassPlaneGeo!, this.grassMat!, count);
        const instB = new THREE.InstancedMesh(this.grassPlaneGeo!, this.grassMat!, count);
        instA.frustumCulled = false;
        instB.frustumCulled = false;

        const rA = new THREE.Quaternion();
        const rB = new THREE.Quaternion();
        const yAxis = new THREE.Vector3(0, 1, 0);

        for (let i = 0; i < count; i++) {
            const e = entries[i];
            rA.setFromAxisAngle(yAxis, e.rot);
            _pos3.set(e.x, e.y, e.z);
            _scl3.set(e.scale, e.scale, e.scale);
            _mat4.compose(_pos3, rA, _scl3);
            instA.setMatrixAt(i, _mat4);

            rB.setFromAxisAngle(yAxis, e.rot + Math.PI * 0.5);
            _mat4.compose(_pos3, rB, _scl3);
            instB.setMatrixAt(i, _mat4);
        }

        instA.instanceMatrix.needsUpdate = true;
        instB.instanceMatrix.needsUpdate = true;
        return { instA, instB };
    }

    /** Called each frame — add/remove grass chunks around camera */
    private updateGrassChunks(scene: Scene) {
        const soilGrid = scene.soilGrid!;
        const heightMap = scene.heightMap!;

        // Camera world position
        let camWX: number, camWZ: number;
        if (this.thirdPerson) {
            camWX = this.playerPos.x;
            camWZ = this.playerPos.y;
        } else {
            camWX = this.threeCamera!.position.x / SCALE;
            camWZ = this.threeCamera!.position.z / SCALE;
        }

        // Only rebuild when camera moved significantly (half a chunk)
        const dx = camWX - this.grassLastCamX;
        const dz = camWZ - this.grassLastCamZ;
        if (dx * dx + dz * dz < (ThreeRenderer.GRASS_CHUNK_SIZE * 0.5) ** 2) return;
        this.grassLastCamX = camWX;
        this.grassLastCamZ = camWZ;

        const CS = ThreeRenderer.GRASS_CHUNK_SIZE;
        const RADIUS = ThreeRenderer.GRASS_RENDER_RADIUS;

        // Determine which chunks should be visible
        const chunkRadius = Math.ceil(RADIUS / CS);
        const camCX = Math.floor(camWX / CS);
        const camCZ = Math.floor(camWZ / CS);
        const neededKeys = new Set<string>();

        for (let dcx = -chunkRadius; dcx <= chunkRadius; dcx++) {
            for (let dcz = -chunkRadius; dcz <= chunkRadius; dcz++) {
                const cx = camCX + dcx;
                const cz = camCZ + dcz;
                // Check chunk center distance
                const chunkCenterX = (cx + 0.5) * CS;
                const chunkCenterZ = (cz + 0.5) * CS;
                const dist = Math.sqrt((chunkCenterX - camWX) ** 2 + (chunkCenterZ - camWZ) ** 2);
                if (dist > RADIUS + CS) continue;
                neededKeys.add(`${cx},${cz}`);
            }
        }

        // Remove chunks no longer needed
        for (const [key, chunk] of this.grassChunks) {
            if (!neededKeys.has(key)) {
                this.threeScene!.remove(chunk.instA);
                this.threeScene!.remove(chunk.instB);
                chunk.instA.dispose();
                chunk.instB.dispose();
                this.grassChunks.delete(key);
            }
        }

        // Create missing chunks
        for (const key of neededKeys) {
            if (this.grassChunks.has(key)) continue;
            const [cx, cz] = key.split(',').map(Number);
            const chunk = this.buildGrassChunk(cx, cz, soilGrid, heightMap, camWX, camWZ);
            if (chunk) {
                this.threeScene!.add(chunk.instA);
                this.threeScene!.add(chunk.instB);
                this.grassChunks.set(key, chunk);
            }
        }
    }

    // =============================================================
    //  SYNC METHODS
    // =============================================================

    // =============================================================
    //  PLANT PART TEMPLATES (cached geometry + material per species+stage)
    // =============================================================

    private getPlantParts(speciesId: string, stage: string, maxSize: number, color: string, matureColor: string): PlantPartDef[] {
        const key = `${speciesId}-${stage}`;
        let parts = this.plantPartCache.get(key);
        if (parts) return parts;

        parts = [];
        const sz = maxSize * SCALE;
        // growing/mature → mature color, others → base color
        const useMature = stage === 'mature' || stage === 'growing';
        const c = new THREE.Color(useMature ? matureColor : color);

        if (stage === 'seed') {
            parts.push({
                geo: new THREE.SphereGeometry(0.03, 6, 6),
                mat: new THREE.MeshLambertMaterial({ color: 0x8B7355 }),
                offsetY: 0.02,
            });
        } else if (stage === 'dead') {
            // Simplified dead stump
            parts.push({
                geo: new THREE.CylinderGeometry(sz * 0.05, sz * 0.07, sz * 0.3, 5),
                mat: new THREE.MeshLambertMaterial({ color: 0x6B5B3A }),
                offsetY: sz * 0.15,
            });
        } else if (speciesId === 'oak' || speciesId === 'pine') {
            const trunkH = sz * 0.8;
            const trunkR = sz * 0.08;
            parts.push({
                geo: new THREE.CylinderGeometry(trunkR * 0.7, trunkR, trunkH, 6),
                mat: new THREE.MeshLambertMaterial({ color: 0x6B4226 }),
                offsetY: trunkH / 2,
            });
            if (speciesId === 'pine') {
                const crownH = sz * 1.2;
                const crownR = sz * 0.45;
                parts.push({
                    geo: new THREE.ConeGeometry(crownR, crownH, 8),
                    mat: new THREE.MeshLambertMaterial({ color: c }),
                    offsetY: trunkH + crownH * 0.35,
                });
            } else {
                const crownR = sz * 0.55;
                parts.push({
                    geo: new THREE.SphereGeometry(crownR, 8, 6),
                    mat: new THREE.MeshLambertMaterial({ color: c }),
                    offsetY: trunkH + crownR * 0.3,
                });
            }
        } else if (speciesId === 'raspberry') {
            const bushR = sz * 0.4;
            const bushGeo = new THREE.SphereGeometry(bushR, 8, 6);
            bushGeo.scale(1, 0.6, 1);
            parts.push({
                geo: bushGeo,
                mat: new THREE.MeshLambertMaterial({ color: c }),
                offsetY: sz * 0.3,
            });
        } else if (speciesId === 'wheat') {
            const stalkH = sz * 0.7;
            parts.push({
                geo: new THREE.CylinderGeometry(0.01, 0.015, stalkH, 4),
                mat: new THREE.MeshLambertMaterial({ color: 0x8B8B3A }),
                offsetY: stalkH / 2,
            });
            const headGeo = new THREE.SphereGeometry(sz * 0.12, 6, 4);
            headGeo.scale(0.6, 1.2, 0.6);
            parts.push({
                geo: headGeo,
                mat: new THREE.MeshLambertMaterial({ color: c }),
                offsetY: stalkH,
            });
        } else {
            // Wildflower / default
            const stemH = sz * 0.4;
            parts.push({
                geo: new THREE.CylinderGeometry(0.01, 0.015, stemH, 4),
                mat: new THREE.MeshLambertMaterial({ color: 0x4a7a4a }),
                offsetY: stemH / 2,
            });
            parts.push({
                geo: new THREE.SphereGeometry(sz * 0.2, 8, 6),
                mat: new THREE.MeshLambertMaterial({ color: c }),
                offsetY: stemH + sz * 0.1,
            });
        }

        this.plantPartCache.set(key, parts);
        return parts;
    }

    // =============================================================
    //  INSTANCED PLANT SYNC
    // =============================================================

    private syncPlants(scene: Scene) {
        const plants = scene.entities.filter((e): e is PlantEntity => e.type === 'plant');

        // Group plants by speciesId-stage
        const groups = new Map<string, PlantEntity[]>();
        for (const plant of plants) {
            if (!getSpecies(plant.speciesId)) continue;
            const key = `${plant.speciesId}-${plant.stage}`;
            let arr = groups.get(key);
            if (!arr) { arr = []; groups.set(key, arr); }
            arr.push(plant);
        }

        const activeKeys = new Set<string>();

        for (const [groupKey, groupPlants] of groups) {
            const species = getSpecies(groupPlants[0].speciesId)!;
            const stage = groupPlants[0].stage;
            const parts = this.getPlantParts(species.id, stage, species.maxSize, species.color, species.matureColor);
            const count = groupPlants.length;

            for (let pi = 0; pi < parts.length; pi++) {
                const iKey = `${groupKey}-${pi}`;
                activeKeys.add(iKey);

                let inst = this.plantInstances.get(iKey);
                const capacity = inst ? (inst as unknown as { _cap: number })._cap ?? 0 : 0;

                // Allocate or grow InstancedMesh when needed
                if (!inst || capacity < count) {
                    if (inst) {
                        this.threeScene!.remove(inst);
                        inst.dispose();
                    }
                    const newCap = Math.max(count * 2, 32);
                    inst = new THREE.InstancedMesh(parts[pi].geo, parts[pi].mat, newCap);
                    inst.frustumCulled = false;
                    (inst as unknown as { _cap: number })._cap = newCap;
                    this.threeScene!.add(inst);
                    this.plantInstances.set(iKey, inst);
                }

                inst.count = count;
                const offsetY = parts[pi].offsetY;

                for (let i = 0; i < count; i++) {
                    const plant = groupPlants[i];
                    const s = Math.max(0.15, plant.growth) * 0.5;
                    const pos = toWorld(plant.position);
                    _pos3.set(pos.x, pos.y + offsetY * s, pos.z);
                    _scl3.set(s, s, s);
                    _mat4.compose(_pos3, _quat, _scl3);
                    inst.setMatrixAt(i, _mat4);
                }
                inst.instanceMatrix.needsUpdate = true;
            }
        }

        // Remove stale instanced meshes
        for (const [key, mesh] of this.plantInstances) {
            if (!activeKeys.has(key)) {
                this.threeScene!.remove(mesh);
                mesh.dispose();
                this.plantInstances.delete(key);
            }
        }
    }

    // =============================================================
    //  INSTANCED FRUIT SYNC
    // =============================================================

    private syncFruits(scene: Scene) {
        const fruits = scene.entities.filter((e): e is FruitEntity => e.type === 'fruit');

        if (!this.fruitGeo) {
            this.fruitGeo = new THREE.SphereGeometry(0.06, 6, 4);
        }

        // Group by speciesId (same color base)
        const groups = new Map<string, FruitEntity[]>();
        for (const fruit of fruits) {
            let arr = groups.get(fruit.speciesId);
            if (!arr) { arr = []; groups.set(fruit.speciesId, arr); }
            arr.push(fruit);
        }

        const activeKeys = new Set<string>();

        for (const [speciesId, group] of groups) {
            activeKeys.add(speciesId);
            const count = group.length;

            // Get or create material for this species
            if (!this.fruitMatCache.has(speciesId)) {
                this.fruitMatCache.set(speciesId, new THREE.MeshLambertMaterial({
                    color: 0xffffff, // white base — actual color set per-instance via setColorAt
                }));
            }
            const mat = this.fruitMatCache.get(speciesId)!;

            let inst = this.fruitInstances.get(speciesId);
            const capacity = inst ? (inst as unknown as { _cap: number })._cap ?? 0 : 0;

            if (!inst || capacity < count) {
                if (inst) {
                    this.threeScene!.remove(inst);
                    inst.dispose();
                }
                const newCap = Math.max(count * 2, 64);
                inst = new THREE.InstancedMesh(this.fruitGeo, mat, newCap);
                inst.frustumCulled = false;
                (inst as unknown as { _cap: number })._cap = newCap;
                this.threeScene!.add(inst);
                this.fruitInstances.set(speciesId, inst);
            }

            inst.count = count;
            const baseColor = new THREE.Color(group[0].color);

            for (let i = 0; i < count; i++) {
                const fruit = group[i];
                const pos = toWorld(fruit.position);
                _pos3.set(pos.x, pos.y + 0.03, pos.z);
                _scl3.set(1, 1, 1);
                _mat4.compose(_pos3, _quat, _scl3);
                inst.setMatrixAt(i, _mat4);

                // Darken color as fruit rots (last 30% of life)
                const lifeRatio = 1 - fruit.age / fruit.maxAge;
                const brightness = lifeRatio < 0.3 ? lifeRatio / 0.3 : 1;
                _col3.copy(baseColor).multiplyScalar(brightness);
                inst.setColorAt(i, _col3);
            }
            inst.instanceMatrix.needsUpdate = true;
            if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
        }

        // Remove stale
        for (const [key, mesh] of this.fruitInstances) {
            if (!activeKeys.has(key)) {
                this.threeScene!.remove(mesh);
                mesh.dispose();
                this.fruitInstances.delete(key);
            }
        }
    }

    private syncNPCs(scene: Scene, elapsed: number, highlight: Highlight) {
        const npcs = scene.entities.filter((e): e is NPCEntity => e.type === 'npc');
        const activeIds = new Set(npcs.map((n) => n.id));

        // Remove dead NPCs
        for (const [id, mesh] of this.npcMeshes) {
            if (!activeIds.has(id)) {
                this.threeScene!.remove(mesh);
                this.disposeObject(mesh);
                this.npcMeshes.delete(id);
            }
        }

        for (const npc of npcs) {
            const stage = getLifeStage(npc.age);
            let group = this.npcMeshes.get(npc.id);

            if (!group) {
                group = createMinecraftCharacter(npc.color, stage);
                group.userData.stage = stage;
                this.threeScene!.add(group);
                this.npcMeshes.set(npc.id, group);
            }

            // Rebuild if life stage changed
            if (group.userData.stage !== stage) {
                this.threeScene!.remove(group);
                this.disposeObject(group);
                group = createMinecraftCharacter(npc.color, stage);
                group.userData.stage = stage;
                this.threeScene!.add(group);
                this.npcMeshes.set(npc.id, group);
            }

            // Position (Y from heightmap)
            const pos = toWorld(npc.position);
            group.position.set(pos.x, pos.y, pos.z);

            // Face movement direction
            if (npc.movement) {
                const dir = npc.movement.direction;
                const angle = Math.atan2(dir.x, dir.y);
                group.rotation.y = angle;
            }

            // Walk animation
            const isMoving = npc.movement !== null;
            animateWalk(group, elapsed + npc.id.charCodeAt(0) * 0.1, isMoving);

            // Opacity based on health
            const alpha = 0.3 + (npc.needs.health / 100) * 0.7;
            group.traverse((child) => {
                if (child instanceof THREE.Mesh && child.material instanceof THREE.MeshLambertMaterial) {
                    child.material.transparent = alpha < 0.95;
                    child.material.opacity = alpha;
                }
            });

            // Sleeping: lay down
            if (npc.ai.state === 'sleeping') {
                group.rotation.z = Math.PI / 2;
                group.position.y = 0.3;
            } else {
                group.rotation.z = 0;
                group.position.y = 0;
            }

            // Name label above head
            if (!group.userData.label) {
                const label = createTextSprite(npc.name, npc.color);
                label.position.set(0, NPC_HEIGHT[stage] + 0.4, 0);
                group.add(label);
                group.userData.label = label;
            }

            // Health bar sprite
            this.updateHealthBar(group, npc, stage);
        }
    }

    private updateHealthBar(group: THREE.Group, npc: NPCEntity, stage: LifeStage) {
        const barName = '__healthBar';
        let bar = group.getObjectByName(barName) as THREE.Mesh | undefined;

        if (!bar) {
            const geo = new THREE.PlaneGeometry(0.8, 0.08);
            const mat = new THREE.MeshBasicMaterial({ color: 0x00ff00, side: THREE.DoubleSide });
            bar = new THREE.Mesh(geo, mat);
            bar.name = barName;
            bar.position.set(0, NPC_HEIGHT[stage] + 0.25, 0);
            group.add(bar);

            // Background bar
            const bgGeo = new THREE.PlaneGeometry(0.8, 0.08);
            const bgMat = new THREE.MeshBasicMaterial({ color: 0x333333, side: THREE.DoubleSide });
            const bg = new THREE.Mesh(bgGeo, bgMat);
            bg.name = '__healthBarBg';
            bg.position.set(0, NPC_HEIGHT[stage] + 0.25, -0.001);
            group.add(bg);
        }

        const ratio = npc.needs.health / 100;
        bar.scale.x = Math.max(0.01, ratio);
        bar.position.x = -(1 - ratio) * 0.4;

        const mat = bar.material as THREE.MeshBasicMaterial;
        if (ratio > 0.5) mat.color.setHex(0x00ff00);
        else if (ratio > 0.25) mat.color.setHex(0xffff00);
        else mat.color.setHex(0xff0000);

        // Billboard: face camera
        bar.lookAt(this.threeCamera!.position);
        const bg = group.getObjectByName('__healthBarBg') as THREE.Mesh | undefined;
        if (bg) bg.lookAt(this.threeCamera!.position);

        const label = group.userData.label as THREE.Sprite | undefined;
        if (label) label.lookAt(this.threeCamera!.position);
    }

    private syncBuildings(scene: Scene) {
        const buildings = scene.entities.filter((e): e is BuildingEntity => e.type === 'building');
        const activeIds = new Set(buildings.map((b) => b.id));

        for (const [id, mesh] of this.buildingMeshes) {
            if (!activeIds.has(id)) {
                this.threeScene!.remove(mesh);
                this.disposeObject(mesh);
                this.buildingMeshes.delete(id);
            }
        }

        for (const building of buildings) {
            if (this.buildingMeshes.has(building.id)) continue;
            const mesh = createCabinMesh(building);
            this.threeScene!.add(mesh);
            this.buildingMeshes.set(building.id, mesh);
        }
    }

    private syncResources(scene: Scene) {
        const resources = scene.entities.filter((e): e is ResourceEntity => e.type === 'resource');
        const activeIds = new Set(resources.map((r) => r.id));

        for (const [id, mesh] of this.resourceMeshes) {
            if (!activeIds.has(id)) {
                this.threeScene!.remove(mesh);
                this.disposeObject(mesh);
                this.resourceMeshes.delete(id);
            }
        }

        for (const resource of resources) {
            if (this.resourceMeshes.has(resource.id)) continue;
            const mesh = createResourceMesh(resource);
            this.threeScene!.add(mesh);
            this.resourceMeshes.set(resource.id, mesh);
        }
    }

    private syncCorpses(scene: Scene) {
        const corpses = scene.entities.filter((e): e is CorpseEntity => e.type === 'corpse');
        const activeIds = new Set(corpses.map((c) => c.id));

        for (const [id, mesh] of this.corpseMeshes) {
            if (!activeIds.has(id)) {
                this.threeScene!.remove(mesh);
                this.disposeObject(mesh);
                this.corpseMeshes.delete(id);
            }
        }

        for (const corpse of corpses) {
            if (this.corpseMeshes.has(corpse.id)) continue;
            const mesh = createCorpseMesh(corpse);
            this.threeScene!.add(mesh);
            this.corpseMeshes.set(corpse.id, mesh);
        }
    }

    private syncZones(_scene: Scene) {
        // Don't render fertile zones in 3D — they clutter the view
        // Clean up any existing zone meshes (e.g. from a previous implementation)
        for (const [id, mesh] of this.zoneMeshes) {
            this.threeScene!.remove(mesh);
            this.disposeObject(mesh);
            this.zoneMeshes.delete(id);
        }
    }

    private syncStockLabels(scene: Scene) {
        const stocks = scene.entities.filter((e): e is StockEntity => e.type === 'stock');
        const activeIds = new Set(stocks.map((s) => s.id));

        for (const [id, sprite] of this.stockLabels) {
            if (!activeIds.has(id)) {
                this.threeScene!.remove(sprite);
                this.disposeObject(sprite);
                this.stockLabels.delete(id);
            }
        }

        for (const stock of stocks) {
            const total = stock.items.reduce((sum, s) => sum + s.quantity, 0);
            if (total === 0) {
                const existing = this.stockLabels.get(stock.id);
                if (existing) existing.visible = false;
                continue;
            }

            let sprite = this.stockLabels.get(stock.id);
            if (!sprite) {
                sprite = createTextSprite(String(total), stock.color);
                const pos = toWorld(stock.position);
                sprite.position.set(pos.x, 1.8, pos.z);
                this.threeScene!.add(sprite);
                this.stockLabels.set(stock.id, sprite);
            } else {
                sprite.visible = true;
                // Update text if changed
                updateSpriteText(sprite, String(total), stock.color);
            }
        }
    }

    private syncHighlight(highlight: Highlight) {
        if (!this.highlightMesh) return;

        if (highlight?.type === 'npc') {
            const npcMesh = this.npcMeshes.get(highlight.id);
            if (npcMesh) {
                this.highlightMesh.visible = true;
                this.highlightMesh.position.set(npcMesh.position.x, 0.05, npcMesh.position.z);
            }
        } else if (highlight?.type === 'zone') {
            const pos = toWorld(highlight.position);
            this.highlightMesh.visible = true;
            this.highlightMesh.position.set(pos.x, 0.05, pos.z);
            this.highlightMesh.scale.set(3, 3, 3);
        } else {
            this.highlightMesh.visible = false;
            this.highlightMesh.scale.set(1, 1, 1);
        }
    }

    private updateLighting(nightFactor: number) {
        if (!this.sunLight || !this.renderer || !this.threeScene) return;

        // Sky color transitions
        const dayColor = new THREE.Color(0x87ceeb);
        const nightColor = new THREE.Color(0x0a0a2e);
        const duskColor = new THREE.Color(0xff7b4f);

        let skyColor: THREE.Color;
        if (nightFactor <= 0) {
            skyColor = dayColor;
        } else if (nightFactor >= 1) {
            skyColor = nightColor;
        } else {
            // Dawn/dusk golden hour
            skyColor = dayColor.clone().lerp(duskColor, Math.min(1, nightFactor * 3));
            if (nightFactor > 0.3) {
                skyColor.lerp(nightColor, (nightFactor - 0.3) / 0.7);
            }
        }

        this.renderer.setClearColor(skyColor);
        if (this.threeScene.fog instanceof THREE.Fog) {
            this.threeScene.fog.color.copy(skyColor);
        }

        // Sun intensity
        this.sunLight.intensity = Math.max(0.1, 1.2 * (1 - nightFactor));

        // Sun color: warm at dawn/dusk, white at noon
        const sunDayColor = new THREE.Color(0xfff5e0);
        const sunDuskColor = new THREE.Color(0xff6622);
        if (nightFactor > 0 && nightFactor < 1) {
            this.sunLight.color.copy(sunDayColor).lerp(sunDuskColor, nightFactor);
        } else {
            this.sunLight.color.copy(sunDayColor);
        }

        // Ambient light
        const ambient = this.threeScene.children.find((c) => c instanceof THREE.AmbientLight) as THREE.AmbientLight | undefined;
        if (ambient) {
            ambient.intensity = 0.2 + 0.4 * (1 - nightFactor);
        }
    }

    // --- Ground geometry (heightmap) ---

    private applyHeightGeometry(heightMap: HeightMap) {
        if (!this.ground || !this.threeScene) return;

        const { cols, rows, cellSize, originX, originY, data } = heightMap;
        // PlaneGeometry(width, height, segs, segs) with N-1 segments gives N vertices.
        // Vertex spacing = width / (N-1). We want spacing = cellSize * SCALE,
        // so width = (cols-1) * cellSize * SCALE to get cols vertices at exactly cellSize apart.
        const worldW = (cols - 1) * cellSize * SCALE;
        const worldH = (rows - 1) * cellSize * SCALE;
        // Center: first vertex at originX*SCALE, last at (originX + (cols-1)*cellSize)*SCALE
        const centerX = (originX + (cols - 1) * cellSize / 2) * SCALE;
        const centerZ = (originY + (rows - 1) * cellSize / 2) * SCALE;

        const geo = new THREE.PlaneGeometry(worldW, worldH, cols - 1, rows - 1);
        const posAttr = geo.getAttribute('position');

        for (let i = 0; i < posAttr.count; i++) {
            const row = Math.floor(i / cols);
            const col = i % cols;
            const h = data[row * cols + col] * HEIGHT_SCALE;
            posAttr.setZ(i, h);
        }

        posAttr.needsUpdate = true;
        geo.computeVertexNormals();

        this.ground.geometry.dispose();
        this.ground.geometry = geo;
        this.ground.position.set(centerX, 0, centerZ);
    }

    // --- Ground texture (dynamic, changes with overlay) ---

    private updateGroundTexture(scene: Scene) {
        if (!this.ground) return;

        // Determine grid dimensions from whichever source is available
        const hm = scene.heightMap;
        const sg = scene.soilGrid;
        const bm = scene.basinMap;
        const cols = hm?.cols ?? sg?.cols ?? 0;
        const rows = hm?.rows ?? sg?.rows ?? 0;
        if (cols === 0 || rows === 0) return;

        // Reuse or create canvas texture
        let canvas: HTMLCanvasElement;
        if (this.groundTexture) {
            canvas = this.groundTexture.image as HTMLCanvasElement;
            if (canvas.width !== cols || canvas.height !== rows) {
                canvas.width = cols;
                canvas.height = rows;
            }
        } else {
            canvas = document.createElement('canvas');
            canvas.width = cols;
            canvas.height = rows;
        }

        const ctx = canvas.getContext('2d')!;
        const imageData = ctx.createImageData(cols, rows);
        const overlay = this.currentOverlay;

        for (let i = 0; i < cols * rows; i++) {
            const px = i * 4;
            let r: number, g: number, b: number;

            if (overlay === 'elevation' && hm) {
                const range = hm.maxHeight - hm.minHeight || 1;
                const h = (hm.data[i] - hm.minHeight) / range;
                r = Math.round(40 + h * 200);
                g = Math.round(80 + h * 140);
                b = Math.round(40 + h * 80);
            } else if (overlay === 'basin' && bm) {
                const v = bm.data[i];
                r = Math.round(200 - v * 190);
                g = Math.round(184 - v * 126);
                b = Math.round(122 + v * 0);
            } else if (overlay === 'water' && sg) {
                const wl = sg.waterLevel[i];
                const depth = Math.min(1, wl);
                r = Math.round(200 * (1 - depth) + 10 * depth);
                g = Math.round(184 * (1 - depth) + 74 * depth);
                b = Math.round(122 * (1 - depth) + 160 * depth);
            } else if (overlay && overlay !== 'elevation' && overlay !== 'basin' && overlay !== 'water' && sg) {
                // Soil property overlay
                const v = sg.layers[overlay as SoilProperty][i];
                const c = SOIL_OVERLAY_COLORS[overlay as SoilProperty];
                r = Math.round(c.r0 + v * (c.r1 - c.r0));
                g = Math.round(c.g0 + v * (c.g1 - c.g0));
                b = Math.round(c.b0 + v * (c.b1 - c.b0));
            } else {
                // Default: realistic terrain color from soil + elevation
                // Blends humidity, minerals, and normalized elevation:
                //   Dry + high elevation → grey rock
                //   Humid + low elevation → lush green
                //   Mineral-rich → brownish earth
                //   Moderate → golden/tan grass
                if (sg && hm) {
                    const humidity = sg.layers.humidity[i];
                    const minerals = sg.layers.minerals[i];
                    const range = hm.maxHeight - hm.minHeight || 1;
                    const elev = (hm.data[i] - hm.minHeight) / range; // [0..1]

                    // Rocky mountain factor: high elevation + low humidity → grey rock
                    const rockFactor = Math.max(0, elev - 0.45) * 2; // starts at elev 0.45
                    // Lush green factor: high humidity
                    const greenFactor = humidity;
                    // Earth factor: minerals
                    const earthFactor = minerals * 0.6;

                    // Base grass color (golden tan)
                    let br = 145, bg = 140, bb = 90;

                    // Blend towards dark green (humid) — darker to match grass texture
                    br += Math.round((-110) * greenFactor);  // 145 → 35
                    bg += Math.round((0) * greenFactor);      // 140 → 140
                    bb += Math.round((-60) * greenFactor);    // 90 → 30

                    // Blend towards brown earth (minerals)
                    br += Math.round(15 * earthFactor);
                    bg += Math.round((-20) * earthFactor);
                    bb += Math.round((-15) * earthFactor);

                    // Blend towards grey rock (high elevation)
                    const rockR = 140, rockG = 135, rockB = 130;
                    const rf = Math.min(1, rockFactor);
                    br = Math.round(br * (1 - rf) + rockR * rf);
                    bg = Math.round(bg * (1 - rf) + rockG * rf);
                    bb = Math.round(bb * (1 - rf) + rockB * rf);

                    r = Math.max(0, Math.min(255, br));
                    g = Math.max(0, Math.min(255, bg));
                    b = Math.max(0, Math.min(255, bb));
                } else if (sg) {
                    const h = sg.layers.humidity[i];
                    r = Math.round(200 - h * 174);
                    g = Math.round(184 - h * 62);
                    b = Math.round(122 - h * 80);
                } else {
                    r = 58; g = 125; b = 68;
                }
            }

            imageData.data[px + 0] = r;
            imageData.data[px + 1] = g;
            imageData.data[px + 2] = b;
            imageData.data[px + 3] = 255;
        }

        ctx.putImageData(imageData, 0, 0);

        if (this.groundTexture) {
            this.groundTexture.needsUpdate = true;
        } else {
            this.groundTexture = new THREE.CanvasTexture(canvas);
            this.groundTexture.minFilter = THREE.LinearFilter;
            this.groundTexture.magFilter = THREE.LinearFilter;
            (this.ground.material as THREE.MeshLambertMaterial).dispose();
            this.ground.material = new THREE.MeshLambertMaterial({ map: this.groundTexture });
        }

        // If no heightmap applied yet, also resize geometry to match grid
        if (!this.groundHeightApplied && (sg || hm)) {
            const ref = sg ?? hm!;
            const worldW = (ref.cols - 1) * ref.cellSize * SCALE;
            const worldH = (ref.rows - 1) * ref.cellSize * SCALE;
            const centerX = (ref.originX + (ref.cols - 1) * ref.cellSize / 2) * SCALE;
            const centerZ = (ref.originY + (ref.rows - 1) * ref.cellSize / 2) * SCALE;
            this.ground.geometry.dispose();
            this.ground.geometry = new THREE.PlaneGeometry(worldW, worldH);
            this.ground.position.set(centerX, 0, centerZ);
        }
    }

    // --- Water mesh (lakes) ---

    private updateWaterMesh(scene: Scene) {
        if (!this.threeScene) return;

        // If lakes disabled or no soil grid, remove water mesh if present
        if (!scene.lakesEnabled || !scene.soilGrid || !scene.heightMap) {
            if (this.waterMesh) {
                this.threeScene.remove(this.waterMesh);
                this.disposeObject(this.waterMesh);
                this.waterMesh = null;
                this.waterGeometry = null;
                if (this.waterTexture) this.waterTexture.dispose();
                this.waterTexture = null;
            }
            return;
        }

        // Throttle updates (no need to recalc every frame)
        this.waterUpdateTimer += this.clock.getDelta() * 1000;
        if (this.waterMesh && this.waterUpdateTimer < ThreeRenderer.WATER_UPDATE_INTERVAL) return;
        this.waterUpdateTimer = 0;

        const sg = scene.soilGrid;
        const hm = scene.heightMap;
        const { cols, rows, cellSize, originX, originY, waterLevel } = sg;

        // Check if any water exists at all
        let hasWater = false;
        for (let i = 0; i < cols * rows; i++) {
            if (waterLevel[i] > 0.01) { hasWater = true; break; }
        }

        if (!hasWater) {
            if (this.waterMesh) {
                this.waterMesh.visible = false;
            }
            return;
        }

        // Create or reuse geometry — match ground grid: (cols-1) segments = cols vertices
        if (!this.waterGeometry) {
            this.waterGeometry = new THREE.PlaneGeometry(
                (cols - 1) * cellSize * SCALE,
                (rows - 1) * cellSize * SCALE,
                cols - 1, rows - 1,
            );
            this.waterGeometry.rotateX(-Math.PI / 2);
        }

        // Update vertex heights: where there's water, raise to terrain + small offset
        // Where there's no water, drop below terrain to hide
        const posAttr = this.waterGeometry.getAttribute('position');
        const WATER_OFFSET = 0.15; // small offset above terrain

        for (let iy = 0; iy < rows; iy++) {
            for (let ix = 0; ix < cols; ix++) {
                const vIdx = iy * cols + ix;

                // World position of this vertex (matches heightmap cell position)
                const wx = originX + ix * cellSize;
                const wy = originY + iy * cellSize;

                const cellIdx = iy * cols + ix;
                const wl = waterLevel[cellIdx];

                const terrainH = getHeightAt(hm, wx, wy) * HEIGHT_SCALE;

                if (wl > 0.01) {
                    posAttr.setY(vIdx, terrainH + WATER_OFFSET);
                } else {
                    // Hide this vertex below terrain
                    posAttr.setY(vIdx, terrainH - 2);
                }
            }
        }
        posAttr.needsUpdate = true;
        this.waterGeometry.computeVertexNormals();

        // Update alpha texture (per-cell alpha)
        let waterCanvas: HTMLCanvasElement;
        if (this.waterTexture) {
            waterCanvas = this.waterTexture.image as HTMLCanvasElement;
        } else {
            waterCanvas = document.createElement('canvas');
            waterCanvas.width = cols;
            waterCanvas.height = rows;
        }

        const ctx = waterCanvas.getContext('2d')!;
        const imageData = ctx.createImageData(cols, rows);

        for (let i = 0; i < cols * rows; i++) {
            const wl = waterLevel[i];
            const px = i * 4;
            const depth = Math.min(1, wl);
            // Water color: shallow = light blue, deep = darker blue
            imageData.data[px + 0] = Math.round(20 * (1 - depth) + 10 * depth);
            imageData.data[px + 1] = Math.round(140 * (1 - depth) + 60 * depth);
            imageData.data[px + 2] = Math.round(220 * (1 - depth) + 180 * depth);
            imageData.data[px + 3] = wl > 0.01 ? Math.round(Math.min(200, wl * 220)) : 0;
        }

        ctx.putImageData(imageData, 0, 0);

        if (this.waterTexture) {
            this.waterTexture.needsUpdate = true;
        } else {
            this.waterTexture = new THREE.CanvasTexture(waterCanvas);
            this.waterTexture.minFilter = THREE.LinearFilter;
            this.waterTexture.magFilter = THREE.LinearFilter;
        }

        // Create mesh if needed
        if (!this.waterMesh) {
            const waterMat = new THREE.MeshLambertMaterial({
                map: this.waterTexture,
                transparent: true,
                depthWrite: false,
                side: THREE.DoubleSide,
            });
            this.waterMesh = new THREE.Mesh(this.waterGeometry, waterMat);
            const centerX = (originX + (cols - 1) * cellSize / 2) * SCALE;
            const centerZ = (originY + (rows - 1) * cellSize / 2) * SCALE;
            this.waterMesh.position.set(centerX, 0, centerZ);
            this.threeScene.add(this.waterMesh);
        }

        this.waterMesh.visible = true;
    }

    // --- Utility ---

    private disposeObject(obj: THREE.Object3D) {
        obj.traverse((child) => {
            if (child instanceof THREE.Mesh) {
                child.geometry?.dispose();
                if (Array.isArray(child.material)) {
                    child.material.forEach((m) => m.dispose());
                } else {
                    child.material?.dispose();
                }
            }
            if (child instanceof THREE.Sprite) {
                child.material?.map?.dispose();
                child.material?.dispose();
            }
        });
    }
}

// =============================================================
//  TEXT SPRITE UTILITY
// =============================================================

function createTextSprite(text: string, color: string): THREE.Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d')!;

    drawTextToCanvas(ctx, text, color, canvas.width, canvas.height);

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(1.5, 0.375, 1);
    sprite.userData.text = text;
    return sprite;
}

function updateSpriteText(sprite: THREE.Sprite, text: string, color: string) {
    if (sprite.userData.text === text) return;
    sprite.userData.text = text;

    const mat = sprite.material as THREE.SpriteMaterial;
    const texture = mat.map;
    if (!texture || !(texture instanceof THREE.CanvasTexture)) return;

    const canvas = texture.image as HTMLCanvasElement;
    const ctx = canvas.getContext('2d')!;
    drawTextToCanvas(ctx, text, color, canvas.width, canvas.height);
    texture.needsUpdate = true;
}

function drawTextToCanvas(ctx: CanvasRenderingContext2D, text: string, color: string, w: number, h: number) {
    ctx.clearRect(0, 0, w, h);
    ctx.font = 'bold 28px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Shadow
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillText(text, w / 2 + 1, h / 2 + 1);

    // Text
    ctx.fillStyle = color;
    ctx.fillText(text, w / 2, h / 2);
}

// --- Register ---
registerRenderer('three3d', () => new ThreeRenderer());
