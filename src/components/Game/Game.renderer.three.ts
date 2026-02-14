// =============================================================
//  THREE.JS 3D RENDERER — Minecraft-style characters, orbital camera
// =============================================================

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GameRenderer, registerRenderer } from './Game.renderer';
import {
    BuildingEntity, Camera, CorpseEntity, FertileZoneEntity,
    Highlight, NPCEntity, ResourceEntity, Scene, StockEntity,
    getCalendar, getLifeStage, LifeStage,
} from './Game.types';
import { Vector2D } from './Game.vector';

// --- Scale: 1 game unit (px) = 0.1 three.js unit ---
const SCALE = 0.1;
const toWorld = (v: Vector2D) => new THREE.Vector3(v.x * SCALE, 0, v.y * SCALE);

// --- NPC sizes by life stage ---
const NPC_HEIGHT: Record<LifeStage, number> = { baby: 0.4, child: 0.7, adolescent: 1.0, adult: 1.2 };
const NPC_WIDTH: Record<LifeStage, number> = { baby: 0.25, child: 0.35, adolescent: 0.4, adult: 0.45 };

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
        const group = new THREE.Group();
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
    private highlightMesh: THREE.Mesh | null = null;

    // Ground plane
    private ground: THREE.Mesh | null = null;
    // Sun light
    private sunLight: THREE.DirectionalLight | null = null;

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

        // Initial resize
        const rect = container.getBoundingClientRect();
        this.resize(rect.width, rect.height);
    }

    render(scene: Scene, camera: Camera, highlight: Highlight): void {
        if (!this.renderer || !this.threeScene || !this.threeCamera || !this.controls) return;

        const elapsed = this.clock.getElapsedTime();

        // In 3D, OrbitControls owns the camera entirely — don't fight it.
        // Only sync to game camera when following a focused NPC.
        // (Game.tsx sets camera position to -npc.position when an NPC is focused)

        // --- Night/day cycle ---
        const { nightFactor } = getCalendar(scene.time);
        this.updateLighting(nightFactor);

        // --- Sync entities ---
        this.syncNPCs(scene, elapsed, highlight);
        this.syncBuildings(scene);
        this.syncResources(scene);
        this.syncCorpses(scene);
        this.syncZones(scene);
        this.syncStockLabels(scene);
        this.syncHighlight(highlight);

        // --- Render ---
        this.controls.update();
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

    destroy(): void {
        // Dispose all meshes
        this.npcMeshes.forEach((m) => this.disposeObject(m));
        this.buildingMeshes.forEach((m) => this.disposeObject(m));
        this.resourceMeshes.forEach((m) => this.disposeObject(m));
        this.corpseMeshes.forEach((m) => this.disposeObject(m));
        this.zoneMeshes.forEach((m) => this.disposeObject(m));
        this.stockLabels.forEach((m) => this.disposeObject(m));

        this.npcMeshes.clear();
        this.buildingMeshes.clear();
        this.resourceMeshes.clear();
        this.corpseMeshes.clear();
        this.zoneMeshes.clear();
        this.stockLabels.clear();

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
    //  SYNC METHODS
    // =============================================================

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

            // Position
            const pos = toWorld(npc.position);
            group.position.set(pos.x, 0, pos.z);

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
