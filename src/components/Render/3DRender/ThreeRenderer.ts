// =============================================================
//  THREE.JS 3D RENDERER — Minecraft-style characters, orbital camera
// =============================================================

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GameRenderer, registerRenderer } from '../GameRenderer';
import {
    BuildingEntity, Camera, CorpseEntity, FertileZoneEntity, FruitEntity,
    Highlight, NPCEntity, PlantEntity, ResourceEntity, Scene, StockEntity,
    getCalendar, getLifeStage, LifeStage, WORLD_HALF,
} from '../../World/types';
import { getSpecies } from '../../World/flora';
import { Vector2D } from '../../Shared/vector';
import { SOIL_TYPE_DEFS, SOIL_TYPE_INDEX } from '../../World/fertility';
import type { SoilGrid, SoilProperty } from '../../World/fertility';
import { SEA_LEVEL } from '../../World/heightmap';
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
function animateWalk(group: THREE.Group, time: number, isMoving: boolean, sprint = false) {
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

    const freq = sprint ? 14 : 8;
    const amp = sprint ? 0.85 : 0.6;
    const swing = Math.sin(time * freq) * amp;
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
    private trunkTextures = new Map<string, THREE.Texture>();
    private foliageTextures = new Map<string, THREE.Texture>();
    private fruitGeo: THREE.SphereGeometry | null = null;
    private fruitMatCache = new Map<string, THREE.MeshLambertMaterial>();
    private fruitInstances = new Map<string, THREE.InstancedMesh>();
    private fruitRenderedPos = new Map<string, { x: number; y: number; z: number }>();
    private highlightMesh: THREE.Mesh | null = null;

    // Ground
    private ground: THREE.Mesh | null = null;
    private groundTextureApplied = false;
    private groundHeightApplied = false;
    private currentOverlay: SoilOverlay = undefined as unknown as SoilOverlay; // force first update
    private groundTexture: THREE.CanvasTexture | null = null;
    // Texture splatting (default view — no overlay)
    private groundSplatMat: THREE.MeshLambertMaterial | null = null;
    private groundOverlayMat: THREE.MeshLambertMaterial | null = null;
    private groundSplatShaderRef: { uniforms: Record<string, { value: unknown }> } | null = null;
    private splatCanvas: HTMLCanvasElement | null = null;
    private splatTexture: THREE.CanvasTexture | null = null;
    private grassDetailTex: THREE.Texture | null = null;
    private dirtDetailTex: THREE.Texture | null = null;
    // Ocean plane (infinite water around island)
    private oceanMesh: THREE.Mesh | null = null;
    // Water mesh for lakes
    private waterMesh: THREE.Mesh | null = null;
    private waterGeometry: THREE.PlaneGeometry | null = null;
    private waterTexture: THREE.CanvasTexture | null = null;
    private waterUpdateTimer = 0;
    private static readonly WATER_UPDATE_INTERVAL = 500; // ms between water mesh updates
    // Grass LOD chunk system
    private grassChunks = new Map<string, { instA: THREE.InstancedMesh; instB: THREE.InstancedMesh; instC: THREE.InstancedMesh; lod: number }>();
    private grassMat: THREE.MeshLambertMaterial | null = null;
    private grassPlaneGeo: THREE.PlaneGeometry | null = null;
    private grassShaderRef: THREE.WebGLProgramParametersWithUniforms | null = null;
    private grassLastCamX = Infinity;
    private grassLastCamZ = Infinity;
    private static readonly GRASS_CHUNK_SIZE = 80;
    private static readonly GRASS_RENDER_RADIUS = 550;
    private static readonly GRASS_LOD_BOUNDARY = 180;
    private static readonly GRASS_STEP_NEAR = 0.5;
    private static readonly GRASS_STEP_FAR = 2.5;
    private static readonly GRASS_SCALE_FAR = 1.6;
    // Sun light
    private sunLight: THREE.DirectionalLight | null = null;
    // Weather effects
    private rainMesh: THREE.LineSegments | null = null;
    private rainPositions: Float32Array | null = null;
    private static readonly RAIN_COUNT = 20000;
    private static readonly RAIN_AREA = 40;
    private static readonly RAIN_HEIGHT_RANGE = 15;
    private static readonly RAIN_SPEED = 25;
    private static readonly RAIN_STREAK = 0.35;
    private snowMesh: THREE.Points | null = null;
    private snowPositions: Float32Array | null = null;
    private static readonly SNOW_COUNT = 100000;
    private static readonly SNOW_AREA = 50;
    private static readonly SNOW_HEIGHT_RANGE = 30;
    private static readonly SNOW_SPEED = 2.3;
    private lightningTimer = 0;
    private lightningFlash = 0;
    private lastRenderTime = -1;

    // Third-person player
    private playerMesh: THREE.Group | null = null;
    private playerPos = { x: 0, y: 0 }; // 2D world position (game units)
    private playerAngle = 0;             // facing direction (radians, smoothed)
    private thirdPerson = false;
    private keysDown = new Set<string>();
    private keyHandler: ((e: KeyboardEvent) => void) | null = null;
    private keyUpHandler: ((e: KeyboardEvent) => void) | null = null;
    // Camera rig — over-the-shoulder TPS
    private cameraYaw = 0;               // horizontal angle (mouse-controlled)
    private cameraPitch = 0.12;          // vertical angle (radians, 0 = horizontal)
    private mouseMoveHandler: ((e: MouseEvent) => void) | null = null;
    private pointerLockHandler: (() => void) | null = null;
    private static readonly PLAYER_SPEED = 0.5;
    private static readonly PLAYER_SPRINT_MULT = 2.5; // shift = run
    private static readonly MOUSE_SENSITIVITY = 0.001;
    private static readonly FP_EYE_HEIGHT = 0.216;
    // Smoothing half-lives (seconds) — lower = snappier
    private static readonly HL_CAM_POS = 0.01;
    private static readonly HL_CAM_Y = 0.01;
    private static readonly HL_MESH_POS = 0.10;
    private static readonly HL_MESH_Y = 0.16;
    private static readonly HL_MESH_ROT = 0.08;
    private static readonly GAMEPAD_DEADZONE = 0.15;
    private static readonly GAMEPAD_CAM_SENSITIVITY = 2.5;
    // Smoothed camera state
    private smoothCamPos = new THREE.Vector3();
    private smoothTargetPos = new THREE.Vector3();
    // Smoothed mesh state (character follows pivot independently)
    private smoothMeshPos = new THREE.Vector3();
    private smoothMeshAngle = 0;
    private cameraInited = false;

    // Interaction system
    private static readonly INTERACT_RANGE = 6;
    private static readonly PICK_DURATION_FRUIT = 0.6;
    private static readonly PICK_DURATION_BUSH = 1.5;
    private static readonly PICK_DURATION_TREE = 4.0;
    private static readonly PICK_DURATION_HERB = 0.8;
    private static readonly TREE_IDS = new Set(['oak', 'pine', 'birch', 'willow', 'apple', 'cherry']);
    private static readonly BUSH_IDS = new Set(['raspberry', 'mushroom']);
    private static readonly HERB_IDS = new Set(['wheat', 'wildflower', 'thyme', 'sage', 'reed']);
    private interactTarget: { id: string; type: 'fruit' | 'plant'; pos3: THREE.Vector3; pickDuration: number; label: string } | null = null;
    private pickProgress = 0;
    private picking = false;
    private interactCanvas: HTMLCanvasElement | null = null;
    private eKeyWasDown = false;
    private interactOutline: THREE.Mesh | null = null;

    init(container: HTMLElement): void {
        this.container = container;

        // --- Renderer ---
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        this.renderer.setClearColor(0x87ceeb);
        this.renderer.domElement.style.display = 'block';
        this.renderer.domElement.style.width = '100%';
        this.renderer.domElement.style.height = '100%';
        container.appendChild(this.renderer.domElement);

        // --- Scene ---
        this.threeScene = new THREE.Scene();
        this.threeScene.fog = new THREE.Fog(0x87ceeb, 40, 120);

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
        this.controls.enabled = false;

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

        // --- Ground detail textures ---
        this.loadGroundDetailTextures();

        // --- Weather particle systems ---
        this.initRainParticles();
        this.initSnowParticles();

        // --- Ocean plane (static, large enough to never see edges) ---
        const oceanGeo = new THREE.PlaneGeometry(10000, 10000);
        const oceanLoader = new THREE.TextureLoader();
        const oceanTex = oceanLoader.load('/textures/ground/water.png');
        oceanTex.wrapS = oceanTex.wrapT = THREE.RepeatWrapping;
        oceanTex.repeat.set(4000, 4000);
        oceanTex.minFilter = THREE.LinearMipmapLinearFilter;
        oceanTex.magFilter = THREE.LinearFilter;
        const oceanMat = new THREE.MeshLambertMaterial({
            map: oceanTex,
            color: 0x3388bb,
            transparent: true,
            opacity: 0.88,
        });
        this.oceanMesh = new THREE.Mesh(oceanGeo, oceanMat);
        this.oceanMesh.rotation.x = -Math.PI / 2;
        this.oceanMesh.position.y = SEA_LEVEL * SCALE;
        this.oceanMesh.receiveShadow = false;
        this.threeScene.add(this.oceanMesh);

        // --- Ground ---
        const groundGeo = new THREE.PlaneGeometry(400, 400);
        const groundMat = new THREE.MeshLambertMaterial({ color: 0x3a7d44 });
        this.ground = new THREE.Mesh(groundGeo, groundMat);
        this.ground.rotation.x = -Math.PI / 2;
        this.ground.position.y = -0.5;
        this.ground.receiveShadow = true;
        this.threeScene.add(this.ground);

        // --- Highlight mesh (reusable) ---
        const hlGeo = new THREE.RingGeometry(0.6, 0.8, 32);
        const hlMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true, opacity: 0.7 });
        this.highlightMesh = new THREE.Mesh(hlGeo, hlMat);
        this.highlightMesh.rotation.x = -Math.PI / 2;
        this.highlightMesh.visible = false;
        this.threeScene.add(this.highlightMesh);

        // --- Interaction outline mesh ---
        const outGeo = new THREE.RingGeometry(0.12, 0.16, 32);
        const outMat = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.8,
        });
        this.interactOutline = new THREE.Mesh(outGeo, outMat);
        this.interactOutline.rotation.x = -Math.PI / 2;
        this.interactOutline.visible = false;
        this.threeScene.add(this.interactOutline);

        // --- Player mesh (third-person) ---
        this.playerMesh = createMinecraftCharacter('#e74c3c', 'adult');
        this.playerMesh.scale.setScalar(0.25);
        this.playerMesh.visible = false;
        this.threeScene.add(this.playerMesh);

        // --- Tree textures ---
        for (const name of ['oak', 'birch', 'pine'] as const) {
            const tLoader = new THREE.TextureLoader();
            const tex = tLoader.load(`/textures/${name}-trunk.png`);
            tex.wrapS = THREE.RepeatWrapping;
            tex.wrapT = THREE.RepeatWrapping;
            tex.repeat.set(1, 2);
            this.trunkTextures.set(name, tex);
        }
        for (const name of ['oak', 'pine'] as const) {
            const fLoader = new THREE.TextureLoader();
            const tex = fLoader.load(`/textures/${name}.png`);
            tex.wrapS = THREE.RepeatWrapping;
            tex.wrapT = THREE.RepeatWrapping;
            tex.repeat.set(5, 5);
            this.foliageTextures.set(name, tex);
        }

        // --- Keyboard handlers ---
        this.keyHandler = (e: KeyboardEvent) => {
            const k = e.key.toLowerCase();
            this.keysDown.add(k);
        };
        this.keyUpHandler = (e: KeyboardEvent) => this.keysDown.delete(e.key.toLowerCase());
        window.addEventListener('keydown', this.keyHandler);
        window.addEventListener('keyup', this.keyUpHandler);

        // --- Mouse look (pointer lock) ---
        this.mouseMoveHandler = (e: MouseEvent) => {
            if (document.pointerLockElement !== this.renderer!.domElement) return;
            this.cameraYaw -= e.movementX * ThreeRenderer.MOUSE_SENSITIVITY;
            this.cameraPitch += e.movementY * ThreeRenderer.MOUSE_SENSITIVITY;
            this.cameraPitch = Math.max(-1.4, Math.min(1.4, this.cameraPitch));
        };
        document.addEventListener('mousemove', this.mouseMoveHandler);

        // Request pointer lock on click when in third-person
        this.pointerLockHandler = () => {
            if (document.pointerLockElement !== this.renderer!.domElement) {
                this.renderer!.domElement.requestPointerLock();
            }
        };
        this.renderer.domElement.addEventListener('click', this.pointerLockHandler);

        // Interaction HUD canvas (overlays the 3D renderer)
        this.interactCanvas = document.createElement('canvas');
        this.interactCanvas.style.position = 'absolute';
        this.interactCanvas.style.top = '0';
        this.interactCanvas.style.left = '0';
        this.interactCanvas.style.pointerEvents = 'none';
        this.interactCanvas.style.zIndex = '10';
        container.style.position = 'relative';
        container.appendChild(this.interactCanvas);

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

        // --- Update grass wind shader ---
        if (this.grassShaderRef) {
            this.grassShaderRef.uniforms.uWindTime.value = elapsed;
        }

        // --- Update ground texture when overlay changes ---
        const overlay = soilOverlay ?? null;
        if (overlay !== this.currentOverlay || !this.groundTextureApplied) {
            this.currentOverlay = overlay;
            this.updateGroundTexture(scene);
            this.groundTextureApplied = true;
        }

        // --- Night/day cycle + weather ---
        const { nightFactor } = getCalendar(scene.time);
        this.updateLighting(nightFactor, scene.weather);

        const frameDt = this.lastRenderTime >= 0 ? Math.min(elapsed - this.lastRenderTime, 0.1) : 0;
        this.lastRenderTime = elapsed;
        this.updateWeatherEffects(scene, frameDt);

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
        this.renderer.render(this.threeScene, this.threeCamera);

        // --- Interaction HUD (drawn AFTER 3D render) ---
        this.updateInteraction(scene, frameDt);
    }

    resize(width: number, height: number): void {
        if (!this.renderer || !this.threeCamera) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = Math.floor(width);
        const h = Math.floor(height);
        this.renderer.setSize(w, h, false);
        this.renderer.setPixelRatio(dpr);
        this.renderer.domElement.style.width = '100%';
        this.renderer.domElement.style.height = '100%';
        this.threeCamera.aspect = w / h;
        this.threeCamera.updateProjectionMatrix();
        if (this.interactCanvas) {
            this.interactCanvas.width = w * dpr;
            this.interactCanvas.height = h * dpr;
            this.interactCanvas.style.width = '100%';
            this.interactCanvas.style.height = '100%';
        }
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

    /** Half-life smoothing: alpha = 1 - exp(-ln2 * dt / halfLife).
     *  Frame-rate independent, critically-damped feel. */
    private static hlAlpha(dt: number, halfLife: number): number {
        return 1 - Math.exp(-0.693147 * dt / halfLife);
    }

    private pollGamepad(): { leftX: number; leftY: number; rightX: number; rightY: number; sprint: boolean } {
        const gamepads = navigator.getGamepads();
        for (const gp of gamepads) {
            if (!gp) continue;
            const dz = ThreeRenderer.GAMEPAD_DEADZONE;
            const apply = (v: number) => {
                if (Math.abs(v) < dz) return 0;
                return (v - Math.sign(v) * dz) / (1 - dz);
            };
            return {
                leftX: apply(gp.axes[0] ?? 0),
                leftY: apply(gp.axes[1] ?? 0),
                rightX: apply(gp.axes[2] ?? 0),
                rightY: apply(gp.axes[3] ?? 0),
                sprint: gp.buttons[10]?.pressed ?? false,
            };
        }
        return { leftX: 0, leftY: 0, rightX: 0, rightY: 0, sprint: false };
    }

    private updatePlayer(_scene: Scene, _elapsed: number) {
        if (!this.threeCamera) return;

        if (this.playerMesh) this.playerMesh.visible = false;

        const dt = this.clock.getDelta() || 1 / 60;
        const gp = this.pollGamepad();
        const sprinting = this.keysDown.has('shift') || gp.sprint;
        const speed = ThreeRenderer.PLAYER_SPEED * (sprinting ? ThreeRenderer.PLAYER_SPRINT_MULT : 1);

        const sinYaw = Math.sin(this.cameraYaw);
        const cosYaw = Math.cos(this.cameraYaw);
        const fwdX = sinYaw;
        const fwdZ = cosYaw;
        const rightX = -cosYaw;
        const rightZ = sinYaw;

        let inputFwd = 0, inputRight = 0;
        const keys = this.keysDown;
        if (keys.has('z') || keys.has('w') || keys.has('arrowup')) inputFwd += 1;
        if (keys.has('s') || keys.has('arrowdown')) inputFwd -= 1;
        if (keys.has('q') || keys.has('a') || keys.has('arrowleft')) inputRight -= 1;
        if (keys.has('d') || keys.has('arrowright')) inputRight += 1;

        inputFwd -= gp.leftY;
        inputRight += gp.leftX;

        this.cameraYaw -= gp.rightX * ThreeRenderer.GAMEPAD_CAM_SENSITIVITY * dt;
        this.cameraPitch += gp.rightY * ThreeRenderer.GAMEPAD_CAM_SENSITIVITY * dt;
        this.cameraPitch = Math.max(-1.4, Math.min(1.4, this.cameraPitch));

        let moveX = fwdX * inputFwd + rightX * inputRight;
        let moveZ = fwdZ * inputFwd + rightZ * inputRight;

        if (moveX !== 0 || moveZ !== 0) {
            const len = Math.sqrt(moveX * moveX + moveZ * moveZ);
            moveX /= len;
            moveZ /= len;
            this.playerPos.x += (moveX / SCALE) * speed * dt;
            this.playerPos.y += (moveZ / SCALE) * speed * dt;
        }

        const pivotW = toWorld(this.playerPos);
        const eyeX = pivotW.x;
        const eyeY = pivotW.y + ThreeRenderer.FP_EYE_HEIGHT;
        const eyeZ = pivotW.z;

        this.threeCamera.position.set(eyeX, eyeY, eyeZ);

        const cosPitch = Math.cos(this.cameraPitch);
        const sinPitch = Math.sin(this.cameraPitch);
        this.threeCamera.lookAt(
            eyeX + sinYaw * cosPitch,
            eyeY - sinPitch,
            eyeZ + cosYaw * cosPitch,
        );
    }

    // =============================================================
    //  INTERACTION SYSTEM — [E] prompt + radial pick progress
    // =============================================================

    private updateInteraction(scene: Scene, dt: number) {
        if (!this.threeCamera || !this.interactCanvas) {
            if (this.interactCanvas) {
                const ctx2 = this.interactCanvas.getContext('2d');
                if (ctx2) ctx2.clearRect(0, 0, this.interactCanvas.width, this.interactCanvas.height);
            }
            this.interactTarget = null;
            this.pickProgress = 0;
            this.picking = false;
            return;
        }

        const MAX_RAY_DIST = ThreeRenderer.INTERACT_RANGE * SCALE;
        const MAX_CROSS_DIST = 0.15;

        const rayOrigin = this.threeCamera.position.clone();
        const rayDir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.threeCamera.quaternion).normalize();

        let bestScore = Infinity;
        let bestEntity: { id: string; type: 'fruit' | 'plant'; pos: { x: number; y: number }; pickDuration: number; label: string } | null = null;

        const _diff = new THREE.Vector3();
        const _cross = new THREE.Vector3();

        for (const e of scene.entities) {
            if (e.type !== 'fruit' && e.type !== 'plant') continue;
            if (e.type === 'plant' && e.growth < 0.3) continue;

            let ep: THREE.Vector3;
            if (e.type === 'fruit') {
                const rp = this.fruitRenderedPos.get(e.id);
                if (rp) {
                    ep = new THREE.Vector3(rp.x, rp.y, rp.z);
                } else {
                    const ew = toWorld(e.position);
                    ep = new THREE.Vector3(ew.x, ew.y, ew.z);
                }
            } else {
                const ew = toWorld(e.position);
                const sp = getSpecies(e.speciesId);
                const h = sp ? sp.maxSize * SCALE * 0.3 : 0.2;
                ep = new THREE.Vector3(ew.x, ew.y + h, ew.z);
            }

            _diff.subVectors(ep, rayOrigin);
            const along = _diff.dot(rayDir);
            if (along < 0 || along > MAX_RAY_DIST) continue;

            _cross.copy(_diff).addScaledVector(rayDir, -along);
            const crossDist = _cross.length();

            const hitRadius = e.type === 'fruit' ? MAX_CROSS_DIST * 0.6 : MAX_CROSS_DIST;
            if (crossDist > hitRadius) continue;

            const score = along + crossDist * 3;
            if (score < bestScore) {
                bestScore = score;
                let label: string;
                let pickDuration: number;
                if (e.type === 'fruit') {
                    label = (e as FruitEntity).fruitName;
                    pickDuration = ThreeRenderer.PICK_DURATION_FRUIT;
                } else {
                    const sp = getSpecies(e.speciesId);
                    label = sp ? sp.displayName : e.speciesId;
                    const sid = e.speciesId;
                    if (ThreeRenderer.TREE_IDS.has(sid)) {
                        pickDuration = ThreeRenderer.PICK_DURATION_TREE;
                    } else if (ThreeRenderer.BUSH_IDS.has(sid)) {
                        pickDuration = ThreeRenderer.PICK_DURATION_BUSH;
                    } else {
                        pickDuration = ThreeRenderer.PICK_DURATION_HERB;
                    }
                }
                bestEntity = {
                    id: e.id,
                    type: e.type as 'fruit' | 'plant',
                    pos: e.position,
                    pickDuration,
                    label,
                };
            }
        }

        if (!bestEntity) {
            this.interactTarget = null;
            this.pickProgress = 0;
            this.picking = false;
        } else {
            let targetPos: THREE.Vector3;
            if (bestEntity.type === 'fruit') {
                const rp = this.fruitRenderedPos.get(bestEntity.id);
                if (rp) {
                    targetPos = new THREE.Vector3(rp.x, rp.y + 0.04, rp.z);
                } else {
                    const w3 = toWorld(bestEntity.pos);
                    targetPos = new THREE.Vector3(w3.x, w3.y + 0.06, w3.z);
                }
            } else {
                const w3 = toWorld(bestEntity.pos);
                let plantH = 0.18;
                const pe = scene.entities.find(en => en.id === bestEntity!.id) as PlantEntity | undefined;
                if (pe && ThreeRenderer.TREE_IDS.has(pe.speciesId)) {
                    plantH = 0.4;
                }
                targetPos = new THREE.Vector3(w3.x, w3.y + plantH, w3.z);
            }

            if (!this.interactTarget || this.interactTarget.id !== bestEntity.id) {
                this.pickProgress = 0;
                this.picking = false;
            }
            this.interactTarget = {
                id: bestEntity.id,
                type: bestEntity.type,
                pos3: targetPos,
                pickDuration: bestEntity.pickDuration,
                label: bestEntity.label,
            };
        }

        const eDown = this.keysDown.has('e');
        if (this.interactTarget && eDown) {
            this.picking = true;
            this.pickProgress += dt / this.interactTarget.pickDuration;
            if (this.pickProgress >= 1) {
                const idx = scene.entities.findIndex(en => en.id === this.interactTarget!.id);
                if (idx >= 0) scene.entities.splice(idx, 1);
                this.interactTarget = null;
                this.pickProgress = 0;
                this.picking = false;
            }
        } else {
            if (!eDown && this.picking) {
                this.pickProgress = 0;
                this.picking = false;
            }
        }

        if (this.interactOutline) {
            if (this.interactTarget) {
                this.interactOutline.visible = true;
                const t = this.interactTarget;
                let outlineScale = 2.5;
                let yOff = 0.15;
                if (t.type === 'fruit') {
                    outlineScale = 0.6;
                    yOff = 0.04;
                } else {
                    const pe = scene.entities.find(en => en.id === t.id) as PlantEntity | undefined;
                    if (pe && ThreeRenderer.TREE_IDS.has(pe.speciesId)) {
                        outlineScale = 5.0;
                        yOff = 0.35;
                    } else if (pe && ThreeRenderer.HERB_IDS.has(pe.speciesId)) {
                        outlineScale = 1.5;
                        yOff = 0.08;
                    }
                }
                this.interactOutline.position.set(t.pos3.x, t.pos3.y - yOff, t.pos3.z);
                this.interactOutline.scale.setScalar(outlineScale);
                const pulse = 0.7 + 0.3 * Math.sin(performance.now() * 0.005);
                (this.interactOutline.material as THREE.MeshBasicMaterial).opacity = pulse * 0.8;
            } else {
                this.interactOutline.visible = false;
            }
        }

        this.drawInteractHUD();
    }

    private drawInteractHUD() {
        const canvas = this.interactCanvas;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        {
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            const cx = canvas.width / 2;
            const cy = canvas.height / 2;
            const armLen = 6 * dpr;
            const gap = 2 * dpr;
            const lw = 1.5 * dpr;

            ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
            ctx.lineWidth = lw;
            ctx.beginPath();
            ctx.moveTo(cx - gap - armLen, cy); ctx.lineTo(cx - gap, cy);
            ctx.moveTo(cx + gap, cy); ctx.lineTo(cx + gap + armLen, cy);
            ctx.moveTo(cx, cy - gap - armLen); ctx.lineTo(cx, cy - gap);
            ctx.moveTo(cx, cy + gap); ctx.lineTo(cx, cy + gap + armLen);
            ctx.stroke();

            ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)';
            ctx.lineWidth = lw + 1 * dpr;
            ctx.beginPath();
            ctx.moveTo(cx - gap - armLen, cy); ctx.lineTo(cx - gap, cy);
            ctx.moveTo(cx + gap, cy); ctx.lineTo(cx + gap + armLen, cy);
            ctx.moveTo(cx, cy - gap - armLen); ctx.lineTo(cx, cy - gap);
            ctx.moveTo(cx, cy + gap); ctx.lineTo(cx, cy + gap + armLen);
            ctx.stroke();

            ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
            ctx.lineWidth = lw;
            ctx.beginPath();
            ctx.moveTo(cx - gap - armLen, cy); ctx.lineTo(cx - gap, cy);
            ctx.moveTo(cx + gap, cy); ctx.lineTo(cx + gap + armLen, cy);
            ctx.moveTo(cx, cy - gap - armLen); ctx.lineTo(cx, cy - gap);
            ctx.moveTo(cx, cy + gap); ctx.lineTo(cx, cy + gap + armLen);
            ctx.stroke();
        }

        if (!this.interactTarget || !this.threeCamera) return;

        const projected = this.interactTarget.pos3.clone().project(this.threeCamera);
        if (projected.z > 1) return;

        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const cx = (projected.x * 0.5 + 0.5) * canvas.width / dpr;
        const cy = (-projected.y * 0.5 + 0.5) * canvas.height / dpr;

        const screenX = cx * dpr;
        const screenY = cy * dpr;
        const radius = 16 * dpr;
        const lineW = 2.5 * dpr;
        const fontSize = 13 * dpr;

        ctx.save();
        ctx.translate(screenX, screenY);

        ctx.beginPath();
        ctx.arc(0, 0, radius, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
        ctx.fill();

        ctx.font = `${fontSize}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#ffffff';
        ctx.fillText('E', 0, 0.5 * dpr);

        if (this.picking && this.pickProgress > 0) {
            const startAngle = -Math.PI / 2;
            const endAngle = startAngle + Math.PI * 2 * Math.min(this.pickProgress, 1);

            ctx.beginPath();
            ctx.arc(0, 0, radius + lineW * 0.5, startAngle, endAngle);
            ctx.strokeStyle = '#4cff4c';
            ctx.lineWidth = lineW;
            ctx.lineCap = 'round';
            ctx.stroke();
        } else {
            ctx.beginPath();
            ctx.arc(0, 0, radius + lineW * 0.5, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
            ctx.lineWidth = lineW * 0.4;
            ctx.stroke();
        }

        const label = this.interactTarget.label;
        ctx.font = `${fontSize * 0.8}px sans-serif`;
        ctx.fillStyle = '#ffffff';
        ctx.shadowColor = 'rgba(0,0,0,0.9)';
        ctx.shadowBlur = 3 * dpr;
        ctx.fillText(label, 0, radius + fontSize * 0.9);
        ctx.shadowBlur = 0;

        ctx.restore();
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

        // Dispose interaction canvas + outline
        if (this.interactCanvas) {
            this.interactCanvas.remove();
            this.interactCanvas = null;
        }
        if (this.interactOutline) {
            this.threeScene?.remove(this.interactOutline);
            this.interactOutline.geometry.dispose();
            (this.interactOutline.material as THREE.Material).dispose();
            this.interactOutline = null;
        }

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
        for (const tex of this.trunkTextures.values()) tex.dispose();
        this.trunkTextures.clear();
        for (const tex of this.foliageTextures.values()) tex.dispose();
        this.foliageTextures.clear();
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
            this.threeScene?.remove(chunk.instC);
            chunk.instA.dispose();
            chunk.instB.dispose();
            chunk.instC.dispose();
        }
        this.grassChunks.clear();
        if (this.grassPlaneGeo) { this.grassPlaneGeo.dispose(); this.grassPlaneGeo = null; }
        if (this.grassMat) { this.grassMat.dispose(); this.grassMat = null; }

        // Dispose rain mesh
        if (this.rainMesh) {
            this.threeScene?.remove(this.rainMesh);
            this.rainMesh.geometry.dispose();
            (this.rainMesh.material as THREE.LineBasicMaterial).dispose();
            this.rainMesh = null;
        }
        this.rainPositions = null;

        // Dispose snow mesh
        if (this.snowMesh) {
            this.threeScene?.remove(this.snowMesh);
            this.snowMesh.geometry.dispose();
            (this.snowMesh.material as THREE.PointsMaterial).dispose();
            this.snowMesh = null;
        }
        this.snowPositions = null;

        // Dispose splatmap resources
        if (this.groundSplatMat) { this.groundSplatMat.dispose(); this.groundSplatMat = null; }
        if (this.groundOverlayMat) { this.groundOverlayMat.dispose(); this.groundOverlayMat = null; }
        if (this.splatTexture) { this.splatTexture.dispose(); this.splatTexture = null; }
        if (this.grassDetailTex) { this.grassDetailTex.dispose(); this.grassDetailTex = null; }
        if (this.dirtDetailTex) { this.dirtDetailTex.dispose(); this.dirtDetailTex = null; }
        this.splatCanvas = null;
        this.groundSplatShaderRef = null;

        if (this.oceanMesh) this.disposeObject(this.oceanMesh);
        this.oceanMesh = null;

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
            alphaTest: 0.35,
            side: THREE.DoubleSide,
        });

        const fadeStart = ThreeRenderer.GRASS_RENDER_RADIUS * SCALE * 0.55;
        const fadeEnd = ThreeRenderer.GRASS_RENDER_RADIUS * SCALE * 0.92;

        this.grassMat.onBeforeCompile = (shader) => {
            this.grassShaderRef = shader;
            shader.uniforms.uFadeStart = { value: fadeStart };
            shader.uniforms.uFadeEnd = { value: fadeEnd };
            shader.uniforms.uWindTime = { value: 0.0 };

            shader.vertexShader = shader.vertexShader.replace(
                'void main() {',
                [
                    'varying float vGrassDist;',
                    'uniform float uWindTime;',
                    '',
                    'vec2 windDisplace(vec3 wp, float h, float t) {',
                    '    float mainWave = sin(wp.x * 0.4 + t * 1.8) * cos(wp.z * 0.3 + t * 1.2);',
                    '    float gust = sin(wp.x * 1.5 + wp.z * 0.9 + t * 4.5) * 0.3;',
                    '    float detail = sin(wp.x * 3.0 - t * 2.0) * sin(wp.z * 2.5 + t * 3.0) * 0.15;',
                    '    float strength = (mainWave + gust + detail) * h * h;',
                    '    float dx = strength * 0.08;',
                    '    float dz = strength * 0.05 + cos(wp.z * 0.6 + t * 1.5) * h * h * 0.03;',
                    '    return vec2(dx, dz);',
                    '}',
                    '',
                    'void main() {',
                ].join('\n')
            );

            shader.vertexShader = shader.vertexShader.replace(
                '#include <begin_vertex>',
                [
                    '#include <begin_vertex>',
                    '{',
                    '    vec4 worldInst = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);',
                    '    float heightFrac = clamp(position.y / 0.8, 0.0, 1.0);',
                    '    vec2 wd = windDisplace(worldInst.xyz, heightFrac, uWindTime);',
                    '    transformed.x += wd.x;',
                    '    transformed.z += wd.y;',
                    '    transformed.y -= length(wd) * 0.3;',
                    '}',
                ].join('\n')
            );

            shader.vertexShader = shader.vertexShader.replace(
                '#include <fog_vertex>',
                '#include <fog_vertex>\nvGrassDist = -mvPosition.z;'
            );

            shader.fragmentShader = shader.fragmentShader.replace(
                'void main() {',
                'varying float vGrassDist;\nuniform float uFadeStart;\nuniform float uFadeEnd;\nvoid main() {'
            );
            shader.fragmentShader = shader.fragmentShader.replace(
                '#include <alphatest_fragment>',
                'diffuseColor.a *= smoothstep(uFadeEnd, uFadeStart, vGrassDist);\n#include <alphatest_fragment>'
            );
        };

        this.grassPlaneGeo = new THREE.PlaneGeometry(0.8, 0.8);
        this.grassPlaneGeo.translate(0, 0.4, 0);
    }

    private buildGrassChunk(
        cx: number, cz: number,
        soilGrid: SoilGrid, heightMap: HeightMap,
        lod: number,
        basinMap?: BasinMap | null,
    ): { instA: THREE.InstancedMesh; instB: THREE.InstancedMesh; instC: THREE.InstancedMesh; lod: number } | null {
        const CS = ThreeRenderer.GRASS_CHUNK_SIZE;
        const STEP = lod === 0 ? ThreeRenderer.GRASS_STEP_NEAR : ThreeRenderer.GRASS_STEP_FAR;
        const SCALE_MULT = lod === 0 ? 1.0 : ThreeRenderer.GRASS_SCALE_FAR;

        const worldX0 = cx * CS;
        const worldZ0 = cz * CS;

        const seed = (cx * 73856093) ^ (cz * 19349663);
        let rng = (seed & 0x7fffffff) || 1;
        const rand = () => { rng = (rng * 16807) % 2147483647; return (rng & 0x7fffffff) / 0x7fffffff; };

        const cols = soilGrid.cols, sRows = soilGrid.rows, csz = soilGrid.cellSize;
        const ox = soilGrid.originX, oy = soilGrid.originY;
        const sampleBilinear = (layer: Float32Array, wx: number, wz: number): number => {
            const fx = (wx - ox) / csz;
            const fz = (wz - oy) / csz;
            const x0 = Math.max(0, Math.min(cols - 1, Math.floor(fx)));
            const z0 = Math.max(0, Math.min(sRows - 1, Math.floor(fz)));
            const x1 = Math.min(x0 + 1, cols - 1);
            const z1 = Math.min(z0 + 1, sRows - 1);
            const tx = Math.max(0, Math.min(1, fx - x0));
            const tz = Math.max(0, Math.min(1, fz - z0));
            return (layer[z0 * cols + x0] * (1 - tx) + layer[z0 * cols + x1] * tx) * (1 - tz)
                + (layer[z1 * cols + x0] * (1 - tx) + layer[z1 * cols + x1] * tx) * tz;
        };

        const sampleBasin = basinMap ? (wx: number, wz: number): number => {
            const bfx = (wx - basinMap.originX) / basinMap.cellSize;
            const bfz = (wz - basinMap.originY) / basinMap.cellSize;
            const bx0 = Math.max(0, Math.min(basinMap.cols - 1, Math.floor(bfx)));
            const bz0 = Math.max(0, Math.min(basinMap.rows - 1, Math.floor(bfz)));
            const bx1 = Math.min(bx0 + 1, basinMap.cols - 1);
            const bz1 = Math.min(bz0 + 1, basinMap.rows - 1);
            const btx = Math.max(0, Math.min(1, bfx - bx0));
            const btz = Math.max(0, Math.min(1, bfz - bz0));
            return (basinMap.data[bz0 * basinMap.cols + bx0] * (1 - btx) + basinMap.data[bz0 * basinMap.cols + bx1] * btx) * (1 - btz)
                + (basinMap.data[bz1 * basinMap.cols + bx0] * (1 - btx) + basinMap.data[bz1 * basinMap.cols + bx1] * btx) * btz;
        } : null;

        type GrassEntry = { x: number; y: number; z: number; scale: number; rot: number; dark: number };
        const entries: GrassEntry[] = [];

        for (let lx = 0; lx < CS; lx += STEP) {
            for (let lz = 0; lz < CS; lz += STEP) {
                const wx = worldX0 + lx + (rand() - 0.5) * STEP * 1.8;
                const wz = worldZ0 + lz + (rand() - 0.5) * STEP * 1.8;

                if (wx < -WORLD_HALF || wx > WORLD_HALF || wz < -WORLD_HALF || wz > WORLD_HALF) continue;

                const hum = sampleBilinear(soilGrid.layers.humidity, wx, wz);
                const waterLvl = sampleBilinear(soilGrid.waterLevel, wx, wz);
                if (waterLvl > 0.08) continue;
                if (hum < 0.08) continue;

                const humFactor = Math.min(1, Math.max(0, (hum - 0.08) / 0.40));
                if (rand() > humFactor * humFactor) continue;
                if (lod === 1 && rand() < 0.12) continue;

                const rawH = getHeightAt(heightMap, wx, wz);
                if (rawH < SEA_LEVEL + 2) continue;
                const h = rawH * HEIGHT_SCALE;
                const humScale = 0.5 + humFactor * 0.5;
                const scale = (0.12 + rand() * 0.18) * humScale * SCALE_MULT;
                if (scale < 0.05) continue;
                const rot = rand() * Math.PI;

                const basin = sampleBasin ? sampleBasin(wx, wz) : 0;
                const dark = 1.0 - basin * 0.75;
                entries.push({ x: wx * SCALE, y: h, z: wz * SCALE, scale, rot, dark });
            }
        }

        if (entries.length === 0) return null;

        this.ensureGrassMaterial();
        const count = entries.length;

        const instA = new THREE.InstancedMesh(this.grassPlaneGeo!, this.grassMat!, count);
        const instB = new THREE.InstancedMesh(this.grassPlaneGeo!, this.grassMat!, count);
        const instC = new THREE.InstancedMesh(this.grassPlaneGeo!, this.grassMat!, count);
        instA.frustumCulled = false;
        instB.frustumCulled = false;
        instC.frustumCulled = false;

        const rA = new THREE.Quaternion();
        const rB = new THREE.Quaternion();
        const rC = new THREE.Quaternion();
        const yAxis = new THREE.Vector3(0, 1, 0);
        const THIRD = Math.PI / 3;
        const _col = new THREE.Color();

        for (let i = 0; i < count; i++) {
            const e = entries[i];
            _pos3.set(e.x, e.y, e.z);
            _scl3.set(e.scale, e.scale, e.scale);

            rA.setFromAxisAngle(yAxis, e.rot);
            _mat4.compose(_pos3, rA, _scl3);
            instA.setMatrixAt(i, _mat4);

            rB.setFromAxisAngle(yAxis, e.rot + THIRD);
            _mat4.compose(_pos3, rB, _scl3);
            instB.setMatrixAt(i, _mat4);

            rC.setFromAxisAngle(yAxis, e.rot + THIRD * 2);
            _mat4.compose(_pos3, rC, _scl3);
            instC.setMatrixAt(i, _mat4);

            _col.setScalar(e.dark);
            instA.setColorAt(i, _col);
            instB.setColorAt(i, _col);
            instC.setColorAt(i, _col);
        }

        instA.instanceMatrix.needsUpdate = true;
        instB.instanceMatrix.needsUpdate = true;
        instC.instanceMatrix.needsUpdate = true;
        instA.instanceColor!.needsUpdate = true;
        instB.instanceColor!.needsUpdate = true;
        instC.instanceColor!.needsUpdate = true;
        return { instA, instB, instC, lod };
    }

    /** Called each frame — add/remove grass chunks around camera */
    private updateGrassChunks(scene: Scene) {
        const soilGrid = scene.soilGrid!;
        const heightMap = scene.heightMap!;

        let camWX: number, camWZ: number;
        if (this.thirdPerson) {
            camWX = this.playerPos.x;
            camWZ = this.playerPos.y;
        } else {
            camWX = this.threeCamera!.position.x / SCALE;
            camWZ = this.threeCamera!.position.z / SCALE;
        }

        const dx = camWX - this.grassLastCamX;
        const dz = camWZ - this.grassLastCamZ;
        if (dx * dx + dz * dz < (ThreeRenderer.GRASS_CHUNK_SIZE * 0.5) ** 2) return;
        this.grassLastCamX = camWX;
        this.grassLastCamZ = camWZ;

        const CS = ThreeRenderer.GRASS_CHUNK_SIZE;
        const RADIUS = ThreeRenderer.GRASS_RENDER_RADIUS;
        const LOD_BOUNDARY = ThreeRenderer.GRASS_LOD_BOUNDARY;

        const chunkRadius = Math.ceil(RADIUS / CS);
        const camCX = Math.floor(camWX / CS);
        const camCZ = Math.floor(camWZ / CS);
        const neededChunks = new Map<string, number>();

        for (let dcx = -chunkRadius; dcx <= chunkRadius; dcx++) {
            for (let dcz = -chunkRadius; dcz <= chunkRadius; dcz++) {
                const cx = camCX + dcx;
                const cz = camCZ + dcz;
                const chunkCenterX = (cx + 0.5) * CS;
                const chunkCenterZ = (cz + 0.5) * CS;
                const dist = Math.sqrt((chunkCenterX - camWX) ** 2 + (chunkCenterZ - camWZ) ** 2);
                if (dist > RADIUS + CS) continue;
                const lod = dist < LOD_BOUNDARY ? 0 : 1;
                neededChunks.set(`${cx},${cz}`, lod);
            }
        }

        for (const [key, chunk] of this.grassChunks) {
            if (!neededChunks.has(key)) {
                this.threeScene!.remove(chunk.instA);
                this.threeScene!.remove(chunk.instB);
                this.threeScene!.remove(chunk.instC);
                chunk.instA.dispose();
                chunk.instB.dispose();
                chunk.instC.dispose();
                this.grassChunks.delete(key);
            }
        }

        for (const [key, desiredLod] of neededChunks) {
            const existing = this.grassChunks.get(key);
            if (existing && existing.lod === desiredLod) continue;
            if (existing) {
                this.threeScene!.remove(existing.instA);
                this.threeScene!.remove(existing.instB);
                this.threeScene!.remove(existing.instC);
                existing.instA.dispose();
                existing.instB.dispose();
                existing.instC.dispose();
                this.grassChunks.delete(key);
            }
            const [cx, cz] = key.split(',').map(Number);
            const chunk = this.buildGrassChunk(cx, cz, soilGrid, heightMap, desiredLod, scene.basinMap);
            if (chunk) {
                this.threeScene!.add(chunk.instA);
                this.threeScene!.add(chunk.instB);
                this.threeScene!.add(chunk.instC);
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
        } else if (speciesId === 'oak') {
            const trunkH = sz * 0.8;
            const trunkR = sz * 0.08;
            const oakTrunk = this.trunkTextures.get('oak');
            parts.push({
                geo: new THREE.CylinderGeometry(trunkR * 0.7, trunkR, trunkH, 8),
                mat: oakTrunk
                    ? new THREE.MeshLambertMaterial({ map: oakTrunk })
                    : new THREE.MeshLambertMaterial({ color: 0x6B4226 }),
                offsetY: trunkH / 2,
            });
            const crownR = sz * 0.55;
            const oakLeaf = this.foliageTextures.get('oak');
            parts.push({
                geo: new THREE.SphereGeometry(crownR, 8, 6),
                mat: oakLeaf
                    ? new THREE.MeshLambertMaterial({ map: oakLeaf, color: c })
                    : new THREE.MeshLambertMaterial({ color: c }),
                offsetY: trunkH + crownR * 0.3,
            });
        } else if (speciesId === 'pine') {
            const trunkH = sz * 0.8;
            const trunkR = sz * 0.08;
            const pineTrunk = this.trunkTextures.get('pine');
            parts.push({
                geo: new THREE.CylinderGeometry(trunkR * 0.7, trunkR, trunkH, 8),
                mat: pineTrunk
                    ? new THREE.MeshLambertMaterial({ map: pineTrunk })
                    : new THREE.MeshLambertMaterial({ color: 0x6B4226 }),
                offsetY: trunkH / 2,
            });
            const crownH = sz * 1.2;
            const crownR = sz * 0.45;
            const pineLeaf = this.foliageTextures.get('pine');
            parts.push({
                geo: new THREE.ConeGeometry(crownR, crownH, 8),
                mat: pineLeaf
                    ? new THREE.MeshLambertMaterial({ map: pineLeaf, color: c })
                    : new THREE.MeshLambertMaterial({ color: c }),
                offsetY: trunkH + crownH * 0.35,
            });
        } else if (speciesId === 'birch') {
            const trunkH = sz * 0.85;
            const trunkR = sz * 0.04;
            const birchTrunk = this.trunkTextures.get('birch');
            parts.push({
                geo: new THREE.CylinderGeometry(trunkR * 0.6, trunkR, trunkH, 8),
                mat: birchTrunk
                    ? new THREE.MeshLambertMaterial({ map: birchTrunk })
                    : new THREE.MeshLambertMaterial({ color: 0xE8DCC8 }),
                offsetY: trunkH / 2,
            });
            const crownR = sz * 0.4;
            const crownGeo = new THREE.SphereGeometry(crownR, 8, 6);
            crownGeo.scale(0.8, 1.1, 0.8);
            parts.push({
                geo: crownGeo,
                mat: new THREE.MeshLambertMaterial({ color: c }),
                offsetY: trunkH + crownR * 0.2,
            });
        } else if (speciesId === 'willow') {
            // Willow: thick trunk + drooping "umbrella" crown (squashed sphere + hanging cones)
            const trunkH = sz * 0.7;
            const trunkR = sz * 0.07;
            parts.push({
                geo: new THREE.CylinderGeometry(trunkR * 0.7, trunkR, trunkH, 6),
                mat: new THREE.MeshLambertMaterial({ color: 0x5A4A3A }),
                offsetY: trunkH / 2,
            });
            // Wide, flat canopy
            const canopyR = sz * 0.6;
            const canopyGeo = new THREE.SphereGeometry(canopyR, 10, 8);
            canopyGeo.scale(1.2, 0.5, 1.2);
            parts.push({
                geo: canopyGeo,
                mat: new THREE.MeshLambertMaterial({ color: c }),
                offsetY: trunkH + canopyR * 0.15,
            });
            // Hanging branches (inverted cone below canopy)
            const hangH = sz * 0.5;
            parts.push({
                geo: new THREE.ConeGeometry(canopyR * 0.9, hangH, 8),
                mat: new THREE.MeshLambertMaterial({ color: c, transparent: true, opacity: 0.6 }),
                offsetY: trunkH - hangH * 0.1,
            });
        } else if (speciesId === 'mushroom') {
            // Mushroom: small cylinder stem + flat half-sphere cap
            const stemH = sz * 0.4;
            const stemR = sz * 0.12;
            parts.push({
                geo: new THREE.CylinderGeometry(stemR, stemR * 0.8, stemH, 6),
                mat: new THREE.MeshLambertMaterial({ color: 0xE8DCC0 }),
                offsetY: stemH / 2,
            });
            const capR = sz * 0.5;
            const capGeo = new THREE.SphereGeometry(capR, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2);
            parts.push({
                geo: capGeo,
                mat: new THREE.MeshLambertMaterial({ color: c }),
                offsetY: stemH,
            });
        } else if (speciesId === 'reed') {
            // Reed: very thin tall cylinder + tiny tuft on top
            const stalkH = sz * 0.9;
            parts.push({
                geo: new THREE.CylinderGeometry(0.008, 0.015, stalkH, 4),
                mat: new THREE.MeshLambertMaterial({ color: c }),
                offsetY: stalkH / 2,
            });
            const tuftGeo = new THREE.SphereGeometry(sz * 0.08, 5, 4);
            tuftGeo.scale(0.5, 1.5, 0.5);
            parts.push({
                geo: tuftGeo,
                mat: new THREE.MeshLambertMaterial({ color: 0xB8A880 }),
                offsetY: stalkH,
            });
        } else if (speciesId === 'apple' || speciesId === 'cherry') {
            // Fruit tree: sturdy trunk + big round crown
            const trunkH = sz * 0.7;
            const trunkR = sz * 0.07;
            parts.push({
                geo: new THREE.CylinderGeometry(trunkR * 0.7, trunkR, trunkH, 6),
                mat: new THREE.MeshLambertMaterial({ color: 0x7B5B3A }),
                offsetY: trunkH / 2,
            });
            const crownR = sz * 0.55;
            parts.push({
                geo: new THREE.SphereGeometry(crownR, 10, 8),
                mat: new THREE.MeshLambertMaterial({ color: c }),
                offsetY: trunkH + crownR * 0.25,
            });
        } else if (speciesId === 'raspberry') {
            // Raspberry: bushy sphere, flattened
            const bushR = sz * 0.4;
            const bushGeo = new THREE.SphereGeometry(bushR, 8, 6);
            bushGeo.scale(1, 0.6, 1);
            parts.push({
                geo: bushGeo,
                mat: new THREE.MeshLambertMaterial({ color: c }),
                offsetY: sz * 0.3,
            });
        } else if (speciesId === 'thyme' || speciesId === 'sage') {
            // Low bush herbs: small flattened sphere
            const bushR = sz * 0.4;
            const bushGeo = new THREE.SphereGeometry(bushR, 8, 6);
            bushGeo.scale(1.2, 0.5, 1.2);
            parts.push({
                geo: bushGeo,
                mat: new THREE.MeshLambertMaterial({ color: c }),
                offsetY: sz * 0.15,
            });
        } else if (speciesId === 'wheat') {
            // Wheat: thin stalk + elongated head
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
            // Wildflower / default: thin stem + colorful sphere
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
        const activeFruitIds = new Set(fruits.map(f => f.id));
        for (const id of this.fruitRenderedPos.keys()) {
            if (!activeFruitIds.has(id)) this.fruitRenderedPos.delete(id);
        }

        if (!this.fruitGeo) {
            this.fruitGeo = new THREE.SphereGeometry(0.025, 6, 4);
        }

        const plantMap = new Map<string, PlantEntity>();
        for (const e of scene.entities) {
            if (e.type === 'plant') plantMap.set(e.id, e as PlantEntity);
        }

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

            if (!this.fruitMatCache.has(speciesId)) {
                this.fruitMatCache.set(speciesId, new THREE.MeshLambertMaterial({
                    color: 0xffffff,
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
            const species = getSpecies(speciesId);
            const maxSz = species ? species.maxSize : 7;

            for (let i = 0; i < count; i++) {
                const fruit = group[i];
                const pos = toWorld(fruit.position);

                const bushSpecies = new Set(['raspberry', 'mushroom', 'thyme', 'sage']);
                const parent = fruit.parentPlantId ? plantMap.get(fruit.parentPlantId) : undefined;

                if (parent && bushSpecies.has(speciesId)) {
                    const parentPos = toWorld(parent.position);
                    const s = Math.max(0.15, parent.growth) * 0.5;
                    const bushH = maxSz * SCALE * 0.3 * s;
                    const bushR = maxSz * SCALE * 0.4 * s;
                    const bushRy = bushR * 0.6;

                    let h = 0;
                    for (let ci = 0; ci < fruit.id.length; ci++) {
                        h = ((h << 5) - h + fruit.id.charCodeAt(ci)) | 0;
                    }
                    const hNorm = ((h >>> 0) % 10000) / 10000;
                    const hNorm2 = (((h >>> 0) * 2654435761) % 10000) / 10000;
                    const theta = hNorm * Math.PI * 2;
                    const phi = Math.acos(1 - 2 * hNorm2);
                    const nx = Math.sin(phi) * Math.cos(theta);
                    const ny = Math.abs(Math.sin(phi) * Math.sin(theta)) * 0.5 + 0.5;
                    const nz = Math.cos(phi);
                    const surfaceR = bushR * 1.05;
                    const surfaceRy = bushRy * 1.05;

                    _pos3.set(
                        parentPos.x + nx * surfaceR,
                        parentPos.y + bushH + ny * surfaceRy,
                        parentPos.z + nz * surfaceR,
                    );
                } else {
                    _pos3.set(pos.x, pos.y + 0.03, pos.z);
                }
                this.fruitRenderedPos.set(fruit.id, { x: _pos3.x, y: _pos3.y, z: _pos3.z });
                _scl3.set(1, 1, 1);
                _mat4.compose(_pos3, _quat, _scl3);
                inst.setMatrixAt(i, _mat4);

                const lifeRatio = 1 - fruit.age / fruit.maxAge;
                const brightness = lifeRatio < 0.3 ? lifeRatio / 0.3 : 1;
                _col3.copy(baseColor).multiplyScalar(brightness);
                inst.setColorAt(i, _col3);
            }
            inst.instanceMatrix.needsUpdate = true;
            if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
        }

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

    private updateLighting(nightFactor: number, weather?: { current: string; rainIntensity: number }) {
        if (!this.sunLight || !this.renderer || !this.threeScene) return;

        const weatherType = weather?.current ?? 'sunny';

        const dayColor = new THREE.Color(0x87ceeb);
        const nightColor = new THREE.Color(0x020208);
        const duskColor = new THREE.Color(0xff7b4f);

        let skyColor: THREE.Color;
        if (nightFactor <= 0) {
            skyColor = dayColor;
        } else if (nightFactor >= 1) {
            skyColor = nightColor;
        } else {
            skyColor = dayColor.clone().lerp(duskColor, Math.min(1, nightFactor * 3));
            if (nightFactor > 0.3) {
                skyColor.lerp(nightColor, (nightFactor - 0.3) / 0.7);
            }
        }

        if (weatherType !== 'sunny') {
            let overcastGrey: THREE.Color;
            let strength: number;
            if (weatherType === 'foggy') {
                overcastGrey = new THREE.Color(0xc8cdd2);
                strength = 0.92;
            } else if (weatherType === 'snowy') {
                overcastGrey = new THREE.Color(0x9aa5b4);
                strength = 0.55;
            } else if (weatherType === 'stormy') {
                overcastGrey = new THREE.Color(0x3a3f4a);
                strength = 0.75;
            } else if (weatherType === 'rainy') {
                overcastGrey = new THREE.Color(0x6a7585);
                strength = 0.55;
            } else {
                overcastGrey = new THREE.Color(0x8899aa);
                strength = 0.3;
            }
            const nightDim = Math.max(0, 1 - nightFactor * 0.95);
            overcastGrey.lerp(new THREE.Color(0x080a10), nightFactor * 0.9);
            skyColor.lerp(overcastGrey, strength * nightDim);
        }

        if (this.lightningFlash > 0) {
            skyColor.lerp(new THREE.Color(0xeeeeff), this.lightningFlash * 0.7);
        }

        this.renderer.setClearColor(skyColor);

        if (this.threeScene.fog instanceof THREE.Fog) {
            const fogColor = skyColor.clone();
            if (nightFactor > 0) {
                const nightDark = new THREE.Color(0x020208);
                fogColor.lerp(nightDark, nightFactor * 0.95);
            }
            this.threeScene.fog.color.copy(fogColor);
            let fogNear = 40, fogFar = 120;
            if (weatherType === 'foggy') { fogNear = 1; fogFar = 12; }
            else if (weatherType === 'stormy') { fogNear = 15; fogFar = 60; }
            else if (weatherType === 'snowy') { fogNear = 20; fogFar = 80; }
            else if (weatherType === 'rainy') { fogNear = 30; fogFar = 100; }
            else if (weatherType === 'cloudy') { fogNear = 60; fogFar = 160; }
            this.threeScene.fog.near += (fogNear - this.threeScene.fog.near) * 0.03;
            this.threeScene.fog.far += (fogFar - this.threeScene.fog.far) * 0.03;
        }

        let sunMult = 1.0;
        if (weatherType === 'foggy') sunMult = 0.18;
        else if (weatherType === 'snowy') sunMult = 0.5;
        else if (weatherType === 'cloudy') sunMult = 0.6;
        else if (weatherType === 'rainy') sunMult = 0.35;
        else if (weatherType === 'stormy') sunMult = 0.2;

        this.sunLight.intensity = Math.max(0.01, 1.2 * (1 - nightFactor) * sunMult);
        if (this.lightningFlash > 0) {
            this.sunLight.intensity += this.lightningFlash * 3.5;
        }

        const sunDayColor = new THREE.Color(0xfff5e0);
        const sunDuskColor = new THREE.Color(0xff6622);
        if (nightFactor > 0 && nightFactor < 1) {
            this.sunLight.color.copy(sunDayColor).lerp(sunDuskColor, nightFactor);
        } else {
            this.sunLight.color.copy(sunDayColor);
        }

        const ambient = this.threeScene.children.find((c) => c instanceof THREE.AmbientLight) as THREE.AmbientLight | undefined;
        if (ambient) {
            let ambientBase = 0.15 + 0.45 * (1 - nightFactor);
            ambientBase *= (sunMult * 0.6 + 0.4);
            ambientBase = Math.max(0.02, ambientBase);
            if (this.lightningFlash > 0) {
                ambientBase += this.lightningFlash * 2.5;
            }
            ambient.intensity = ambientBase;
        }
    }

    // =============================================================
    //  WEATHER EFFECTS — rain particles, lightning
    // =============================================================

    private initRainParticles() {
        if (!this.threeScene) return;
        const COUNT = ThreeRenderer.RAIN_COUNT;
        const positions = new Float32Array(COUNT * 2 * 3);
        for (let i = 0; i < COUNT; i++) {
            const x = (Math.random() - 0.5) * ThreeRenderer.RAIN_AREA;
            const y = Math.random() * ThreeRenderer.RAIN_HEIGHT_RANGE;
            const z = (Math.random() - 0.5) * ThreeRenderer.RAIN_AREA;
            positions[i * 6 + 0] = x;
            positions[i * 6 + 1] = y + ThreeRenderer.RAIN_STREAK;
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
        this.threeScene.add(this.rainMesh);
    }

    private initSnowParticles() {
        if (!this.threeScene) return;
        const COUNT = ThreeRenderer.SNOW_COUNT;
        const positions = new Float32Array(COUNT * 3);
        for (let i = 0; i < COUNT; i++) {
            positions[i * 3 + 0] = (Math.random() - 0.5) * ThreeRenderer.SNOW_AREA;
            positions[i * 3 + 1] = Math.random() * ThreeRenderer.SNOW_HEIGHT_RANGE;
            positions[i * 3 + 2] = (Math.random() - 0.5) * ThreeRenderer.SNOW_AREA;
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
        this.threeScene.add(this.snowMesh);
    }

    private updateWeatherEffects(scene: Scene, dt: number) {
        const weather = scene.weather;
        const weatherType = weather?.current ?? 'sunny';
        const intensity = weather?.rainIntensity ?? 0;
        const isStormy = weatherType === 'stormy';
        const isSnowy = weatherType === 'snowy';
        const isRaining = weatherType === 'rainy' || isStormy;
        const elapsed = this.clock.getElapsedTime();

        if (this.rainMesh && this.rainPositions) {
            if (!isRaining || intensity <= 0.01) {
                this.rainMesh.visible = false;
            } else {
                this.rainMesh.visible = true;
                const cam = this.threeCamera!;
                this.rainMesh.position.set(cam.position.x, 0, cam.position.z);

                const speed = ThreeRenderer.RAIN_SPEED * (0.5 + intensity * 0.5) * (isStormy ? 1.4 : 1);
                const windX = isStormy
                    ? Math.sin(elapsed * 0.7) * 6 * dt
                    : intensity * 1.2 * dt;
                const activeCount = Math.floor(ThreeRenderer.RAIN_COUNT * intensity);

                for (let i = 0; i < ThreeRenderer.RAIN_COUNT; i++) {
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
                        const x = (Math.random() - 0.5) * ThreeRenderer.RAIN_AREA;
                        const y = ThreeRenderer.RAIN_HEIGHT_RANGE + Math.random() * 3;
                        const z = (Math.random() - 0.5) * ThreeRenderer.RAIN_AREA;
                        this.rainPositions[base + 0] = x;
                        this.rainPositions[base + 1] = y + ThreeRenderer.RAIN_STREAK;
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
                const cam = this.threeCamera!;
                this.snowMesh.position.set(cam.position.x, cam.position.y - ThreeRenderer.SNOW_HEIGHT_RANGE * 0.4, cam.position.z);

                const activeCount = Math.floor(ThreeRenderer.SNOW_COUNT * snowIntensity);
                for (let i = 0; i < ThreeRenderer.SNOW_COUNT; i++) {
                    const base = i * 3;
                    if (i >= activeCount) {
                        this.snowPositions[base + 1] = -100;
                        continue;
                    }
                    this.snowPositions[base + 1] -= ThreeRenderer.SNOW_SPEED * dt;
                    const phase = i * 0.1 + elapsed * 0.5;
                    this.snowPositions[base + 0] += Math.sin(phase) * 0.8 * dt;
                    this.snowPositions[base + 2] += Math.cos(phase * 0.7) * 0.6 * dt;

                    if (this.snowPositions[base + 1] < -1) {
                        this.snowPositions[base + 0] = (Math.random() - 0.5) * ThreeRenderer.SNOW_AREA;
                        this.snowPositions[base + 1] = ThreeRenderer.SNOW_HEIGHT_RANGE + Math.random() * 2;
                        this.snowPositions[base + 2] = (Math.random() - 0.5) * ThreeRenderer.SNOW_AREA;
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

    // =============================================================
    //  TEXTURE SPLATTING — blends grass/dirt based on terrain data
    // =============================================================

    private loadGroundDetailTextures() {
        const loader = new THREE.TextureLoader();
        this.grassDetailTex = loader.load('/textures/ground/ground-grass.png');
        this.grassDetailTex.wrapS = this.grassDetailTex.wrapT = THREE.RepeatWrapping;
        this.grassDetailTex.minFilter = THREE.LinearMipmapLinearFilter;
        this.grassDetailTex.magFilter = THREE.LinearFilter;
        this.dirtDetailTex = loader.load('/textures/ground/ground-dirt.png');
        this.dirtDetailTex.wrapS = this.dirtDetailTex.wrapT = THREE.RepeatWrapping;
        this.dirtDetailTex.minFilter = THREE.LinearMipmapLinearFilter;
        this.dirtDetailTex.magFilter = THREE.LinearFilter;
    }

    private ensureSplatMaterial(scene: Scene) {
        if (this.groundSplatMat) return;
        if (!this.grassDetailTex || !this.dirtDetailTex) return;
        const sg = scene.soilGrid;
        const hm = scene.heightMap;
        if (!sg || !hm) return;

        this.buildSplatMap(scene);
        if (!this.splatTexture) return;

        const worldW = (sg.cols - 1) * sg.cellSize * SCALE;
        const texRepeat = worldW / 0.25;

        const whitePx = new Uint8Array([255, 255, 255, 255]);
        const whiteTex = new THREE.DataTexture(whitePx, 1, 1);
        whiteTex.needsUpdate = true;

        const splatRef = this.splatTexture;
        const grassRef = this.grassDetailTex;
        const dirtRef = this.dirtDetailTex;

        this.groundSplatMat = new THREE.MeshLambertMaterial({ map: whiteTex });
        this.groundSplatMat.onBeforeCompile = (shader) => {
            this.groundSplatShaderRef = shader;
            shader.uniforms.uGrass = { value: grassRef };
            shader.uniforms.uDirt = { value: dirtRef };
            shader.uniforms.uSplat = { value: splatRef };
            shader.uniforms.uTexRepeat = { value: texRepeat };

            shader.fragmentShader = shader.fragmentShader.replace(
                'void main() {',
                [
                    'uniform sampler2D uGrass;',
                    'uniform sampler2D uDirt;',
                    'uniform sampler2D uSplat;',
                    'uniform float uTexRepeat;',
                    'void main() {',
                ].join('\n')
            );

            shader.fragmentShader = shader.fragmentShader.replace(
                '#include <map_fragment>',
                [
                    '{',
                    '    vec2 tUV = vMapUv * uTexRepeat;',
                    '    vec4 grassC = texture2D(uGrass, tUV);',
                    '    vec4 dirtC = texture2D(uDirt, tUV);',
                    '    vec4 splatSample = texture2D(uSplat, vMapUv);',
                    '    float blend = smoothstep(0.05, 0.95, splatSample.r);',
                    '    float basin = splatSample.g;',
                    '    float relief = 1.0 - basin * 0.75;',
                    '    diffuseColor *= mix(dirtC, grassC, blend) * 0.7 * relief;',
                    '}',
                ].join('\n')
            );
        };
    }

    private buildSplatMap(scene: Scene) {
        const sg = scene.soilGrid;
        const hm = scene.heightMap;
        const bm = scene.basinMap;
        if (!sg || !hm) return;
        const cols = sg.cols, rows = sg.rows;
        const range = hm.maxHeight - hm.minHeight || 1;

        if (!this.splatCanvas) {
            this.splatCanvas = document.createElement('canvas');
            this.splatCanvas.width = cols;
            this.splatCanvas.height = rows;
        }
        const ctx = this.splatCanvas.getContext('2d')!;
        const imageData = ctx.createImageData(cols, rows);

        for (let i = 0; i < cols * rows; i++) {
            const humidity = sg.layers.humidity[i];
            const elev = (hm.data[i] - hm.minHeight) / range;
            const rockFactor = Math.min(1, Math.max(0, elev - 0.45) * 2.5);
            const grassFactor = humidity * (1 - rockFactor);
            let blend = Math.max(0, Math.min(1, grassFactor * 2.2));

            const st = sg.soilType[i];
            if (st === 1) blend *= 0.15;
            else if (st === 3) blend *= 0.05;
            else if (st === 4) blend = Math.min(1, blend * 1.3);

            const basin = bm ? bm.data[i] : 0;
            const px = i * 4;
            imageData.data[px + 0] = Math.round(blend * 255);
            imageData.data[px + 1] = Math.round(basin * 255);
            imageData.data[px + 2] = st;
            imageData.data[px + 3] = 255;
        }
        ctx.putImageData(imageData, 0, 0);

        if (this.splatTexture) {
            this.splatTexture.needsUpdate = true;
        } else {
            this.splatTexture = new THREE.CanvasTexture(this.splatCanvas);
            this.splatTexture.minFilter = THREE.LinearFilter;
            this.splatTexture.magFilter = THREE.LinearFilter;
        }
    }

    // --- Ground texture (dynamic, changes with overlay) ---

    private updateGroundTexture(scene: Scene) {
        if (!this.ground) return;

        const overlay = this.currentOverlay;

        // ===== TEXTURE SPLATTING MODE (no overlay — "Aucun") =====
        if (!overlay && scene.soilGrid && scene.heightMap) {
            this.ensureSplatMaterial(scene);
            if (this.groundSplatMat) {
                this.buildSplatMap(scene);
                if (this.ground.material !== this.groundSplatMat) {
                    this.ground.material = this.groundSplatMat;
                }
                return;
            }
        }

        // ===== COLORED OVERLAY MODE =====
        const hm = scene.heightMap;
        const sg = scene.soilGrid;
        const bm = scene.basinMap;
        const cols = hm?.cols ?? sg?.cols ?? 0;
        const rows = hm?.rows ?? sg?.rows ?? 0;
        if (cols === 0 || rows === 0) return;

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
            } else if (overlay === 'soilType' && sg) {
                const stId = SOIL_TYPE_INDEX[sg.soilType[i]];
                const c = SOIL_TYPE_DEFS[stId].color;
                r = (c >> 16) & 0xff;
                g = (c >> 8) & 0xff;
                b = c & 0xff;
            } else if (overlay && overlay !== 'elevation' && overlay !== 'basin' && overlay !== 'water' && overlay !== 'soilType' && sg) {
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

                    // Base dry color (warm tan)
                    let br = 140, bg = 130, bb = 85;

                    // Aggressive blend towards very dark olive — matches grass texture shadow
                    // Uses squared humidity for faster transition into dark
                    const gf = greenFactor * greenFactor; // 0.5 hum → 0.25, 0.7 → 0.49, 1.0 → 1.0
                    const darkGf = Math.min(1, greenFactor * 1.8); // saturates earlier
                    const blendF = Math.max(gf, darkGf * 0.7); // fast ramp
                    // Target: ~#1E2515 (30, 37, 21) — near-black olive
                    br += Math.round((-110 * 0.7) * blendF);   // 140 → 30
                    bg += Math.round((-93 * 0.7) * blendF);    // 130 → 37
                    bb += Math.round((-64 * 0.7) * blendF);    // 85 → 21

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
        }

        if (!this.groundOverlayMat) {
            this.groundOverlayMat = new THREE.MeshLambertMaterial({ map: this.groundTexture });
        }
        if (this.ground.material !== this.groundOverlayMat) {
            this.ground.material = this.groundOverlayMat;
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
