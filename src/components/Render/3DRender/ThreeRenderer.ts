import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { CSM } from 'three/examples/jsm/csm/CSM.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { GameRenderer, registerRenderer } from '../GameRenderer';
import {
    AnimalEntity, BuildingEntity, Camera, CorpseEntity, FruitEntity,
    Highlight, NPCEntity, PlantEntity, ResourceEntity, Scene, StockEntity,
    getCalendar, getLifeStage, LifeStage, WORLD_HALF,
} from '../../World/types';
import { getSpecies } from '../../World/flora';
import { getAnimalSpecies } from '../../World/fauna';
import { SOIL_TYPE_DEFS, SOIL_TYPE_INDEX, getSoilPropertyAt } from '../../World/fertility';
import type { SoilGrid, SoilProperty } from '../../World/fertility';
import { SEA_LEVEL, getLakeAt, getWaterDepthAt } from '../../World/heightmap';
import type { HeightMap, BasinMap, LakeMap, Lake } from '../../World/heightmap';
import { getHeightAt } from '../../World/heightmap';
import type { SoilOverlay } from '../GameRenderer';

import {
    SCALE, HEIGHT_SCALE, SOIL_OVERLAY_COLORS, NPC_HEIGHT,
    PLAYER_SPEED, PLAYER_SPRINT_MULT, PLAYER_CROUCH_MULT, PLAYER_SWIM_MULT,
    SWIM_EYE_OFFSET, MOUSE_SENSITIVITY, FP_EYE_HEIGHT, FP_CROUCH_HEIGHT,
    STAMINA_MAX, STAMINA_DRAIN, STAMINA_REGEN, STAMINA_REGEN_DELAY, STAMINA_EXHAUST_THRESHOLD,
    GAMEPAD_DEADZONE, GAMEPAD_CAM_SENSITIVITY,
    INTERACT_RANGE, PICK_DURATION_FRUIT, PICK_DURATION_BUSH, PICK_DURATION_TREE, PICK_DURATION_HERB,
    TREE_IDS, BUSH_IDS, HERB_IDS,
    GRASS_CHUNK_SIZE, GRASS_RENDER_RADIUS, GRASS_LOD_BOUNDARY, GRASS_STEP_NEAR, GRASS_STEP_FAR, GRASS_SCALE_FAR,
    TREE_LOD0_DIST, TREE_LOD1_DIST, TREE_CULL_DIST, PLANT_CULL_DIST,
    DEBUG_HIDE_GRASS, DEBUG_WIREFRAME,
} from './constants';
import { toWorld, setActiveHeightMap, tempMatrix as _mat4, tempPosition as _pos3, tempQuaternion as _quat, tempScale as _scl3, tempColor as _col3 } from './utils';
import { Vector2D } from '../../Shared/vector';
import type { PlantPartDef, InteractTarget } from './types';
import { createMinecraftCharacter, animateWalk } from './CharacterBuilder';
import { createCabinMesh, createResourceMesh, createCorpseMesh } from './EntityBuilders';
import { buildAnimalModel } from './AnimalModels';
import { createTextSprite, updateSpriteText } from './TextSprite';
import { WeatherSystem } from './WeatherSystem';

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
    private animalMeshes = new Map<string, THREE.Group>();
    private npcMeshes = new Map<string, THREE.Group>();
    private buildingMeshes = new Map<string, THREE.Group>();
    private resourceMeshes = new Map<string, THREE.Object3D>();
    private corpseMeshes = new Map<string, THREE.Mesh>();
    private zoneMeshes = new Map<string, THREE.Mesh>();
    private stockLabels = new Map<string, THREE.Sprite>();
    // Instanced rendering pools
    private plantPartCache = new Map<string, PlantPartDef[]>();
    private plantInstances = new Map<string, THREE.InstancedMesh>();
    private treeInstancedMeshes: { geo: THREE.BufferGeometry; mat: THREE.Material; instance: THREE.InstancedMesh | null }[] = [];
    private treeLod1Meshes: { geo: THREE.BufferGeometry; mat: THREE.Material; instance: THREE.InstancedMesh | null }[] = [];
    private treeLod2Meshes: { geo: THREE.BufferGeometry; mat: THREE.Material; instance: THREE.InstancedMesh | null }[] = [];
    private trunkTextures = new Map<string, THREE.Texture>();
    private foliageTextures = new Map<string, THREE.Texture>();
    private fruitGeo: THREE.SphereGeometry | null = null;
    private fruitMatCache = new Map<string, THREE.MeshLambertMaterial>();
    private fruitInstances = new Map<string, THREE.InstancedMesh>();
    private fruitRenderedPos = new Map<string, { x: number; y: number; z: number }>();
    private highlightMesh: THREE.Mesh | null = null;

    // Rocks (GLB models)
    private rockTemplates: (THREE.Group | null)[] = [null, null, null, null];
    private rockMeshes: THREE.Group[] = [];
    private rocksBuilt = false;
    private pineTreeModel: THREE.Group | null = null;

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
    // Lake meshes (static, one per lake)
    private lakeMeshes: THREE.Mesh[] = [];
    private lakesBuilt = false;
    private lakeWaterMat: THREE.ShaderMaterial | null = null;
    private refractionRT: THREE.WebGLRenderTarget | null = null;
    // Grass LOD chunk system
    private grassChunks = new Map<string, { instA: THREE.InstancedMesh; instB: THREE.InstancedMesh; instC: THREE.InstancedMesh; lod: number }>();
    private grassMat: THREE.MeshLambertMaterial | null = null;
    private grassPlaneGeo: THREE.PlaneGeometry | null = null;
    private grassShaderRef: THREE.WebGLProgramParametersWithUniforms | null = null;
    private grassLastCamX = Infinity;
    private grassLastCamZ = Infinity;
    // Cascaded Shadow Maps
    private csm: CSM | null = null;
    // Post-processing (AO)
    private composer: EffectComposer | null = null;
    private gtaoPass: GTAOPass | null = null;
    // Weather effects
    private weatherSystem: WeatherSystem | null = null;
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
    private cameraYaw = 0;
    private cameraPitch = 0.12;
    private mouseMoveHandler: ((e: MouseEvent) => void) | null = null;
    private pointerLockHandler: (() => void) | null = null;
    private crouching = false;
    private swimming = false;
    private currentEyeHeight = FP_EYE_HEIGHT;
    private stamina = STAMINA_MAX;
    private canopyDarkness = 0;
    private staminaRegenCooldown = 0;
    private staminaExhausted = false;
    // Smoothed camera state
    private smoothCamPos = new THREE.Vector3();
    private smoothTargetPos = new THREE.Vector3();
    // Smoothed mesh state (character follows pivot independently)
    private smoothMeshPos = new THREE.Vector3();
    private smoothMeshAngle = 0;
    private cameraInited = false;

    // Interaction system
    private interactTarget: InteractTarget | null = null;
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
        this.renderer.shadowMap.type = THREE.VSMShadowMap;
        this.renderer.sortObjects = true;
        this.renderer.setClearColor(0x87ceeb);
        this.renderer.domElement.style.display = 'block';
        this.renderer.domElement.style.width = '100%';
        this.renderer.domElement.style.height = '100%';
        container.appendChild(this.renderer.domElement);

        // --- Scene ---
        this.threeScene = new THREE.Scene();
        this.threeScene.fog = new THREE.Fog(0x87ceeb, 80, 240);

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

        this.csm = new CSM({
            camera: this.threeCamera,
            parent: this.threeScene,
            cascades: 4,
            maxFar: 80,
            mode: 'practical',
            shadowMapSize: 2048,
            shadowBias: 0.00015,
            lightDirection: new THREE.Vector3(-30, -50, -20).normalize(),
            lightIntensity: 1.2,
            lightNear: 0.5,
            lightFar: 300,
            lightMargin: 50,
        });
        this.csm.fade = true;
        for (const light of this.csm.lights) {
            light.shadow.radius = 4;
            light.shadow.blurSamples = 16;
            light.shadow.normalBias = 0.5;
        }

        // --- Ground detail textures ---
        this.loadGroundDetailTextures();

        // --- Weather system ---
        this.weatherSystem = new WeatherSystem(this.threeScene);

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
        this.csm.setupMaterial(groundMat);
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

        // --- Load rock GLB models ---
        const gltfLoader = new GLTFLoader();
        for (let i = 1; i <= 4; i++) {
            const index = i - 1;
            gltfLoader.load(`/models/rock${i}.glb`, (gltf) => {
                this.rockTemplates[index] = gltf.scene;
                this.rockTemplates[index]!.traverse((child) => {
                    if ((child as THREE.Mesh).isMesh) {
                        const mesh = child as THREE.Mesh;
                        mesh.castShadow = true;
                        mesh.receiveShadow = true;

                        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
                        for (const mat of mats) {
                            if ((mat as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
                                const stdMat = mat as THREE.MeshStandardMaterial;
                                if (stdMat.color) {
                                    stdMat.color.multiplyScalar(2.0);
                                }
                                stdMat.envMapIntensity = 1.5;
                                stdMat.needsUpdate = true;
                            }
                            if (this.csm) {
                                this.csm.setupMaterial(mat);
                            }
                        }
                    }
                });
            });
        }

        gltfLoader.load('/models/Pine.glb', (gltf) => {
            this.pineTreeModel = gltf.scene;
            this.pineTreeModel.traverse((child) => {
                if ((child as THREE.Mesh).isMesh) {
                    const mesh = child as THREE.Mesh;
                    mesh.castShadow = true;
                    mesh.receiveShadow = true;
                    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
                    for (const mat of mats) {
                        mat.side = THREE.DoubleSide;
                        mat.transparent = false;
                        mat.depthWrite = true;
                        mat.depthTest = true;
                        mat.alphaTest = 0.5;
                        mat.needsUpdate = true;
                        if (this.csm) {
                            this.csm.setupMaterial(mat);
                        }
                        this.treeInstancedMeshes.push({
                            geo: mesh.geometry,
                            mat: mat,
                            instance: null
                        });
                    }
                }
            });
        });

        this.initTreeLod();

        // --- Post-processing (GTAO Ambient Occlusion) ---
        this.composer = new EffectComposer(this.renderer);
        this.composer.addPass(new RenderPass(this.threeScene, this.threeCamera));

        this.gtaoPass = new GTAOPass(this.threeScene, this.threeCamera);
        this.gtaoPass.output = GTAOPass.OUTPUT.Default;
        this.gtaoPass.blendIntensity = 0.7;
        this.gtaoPass.updateGtaoMaterial({
            radius: 0.4,
            distanceExponent: 2,
            thickness: 5,
            scale: 0.8,
            samples: 16,
        });
        this.gtaoPass.updatePdMaterial({
            lumaPhi: 10,
            depthPhi: 2,
            normalPhi: 3,
            radius: 16,
            rings: 4,
            samples: 24,
        });
        const gtaoAny = this.gtaoPass as unknown as { _overrideVisibility: () => void; _visibilityCache: THREE.Object3D[] };
        const origOverride = gtaoAny._overrideVisibility.bind(this.gtaoPass);
        this.gtaoPass.overrideVisibility = () => {
            origOverride();
            const aoCache = gtaoAny._visibilityCache as THREE.Object3D[];
            this.threeScene!.traverse((obj: THREE.Object3D) => {
                if (obj.userData.excludeFromAO && obj.visible) {
                    obj.visible = false;
                    aoCache.push(obj);
                }
            });
        };
        gtaoAny._overrideVisibility = this.gtaoPass.overrideVisibility;
        this.composer.addPass(this.gtaoPass);
        this.composer.addPass(new OutputPass());

        // --- Keyboard handlers ---
        this.keyHandler = (e: KeyboardEvent) => {
            const k = e.key.toLowerCase();
            this.keysDown.add(k);
            if (k === 'c') this.crouching = !this.crouching;
        };
        this.keyUpHandler = (e: KeyboardEvent) => this.keysDown.delete(e.key.toLowerCase());
        window.addEventListener('keydown', this.keyHandler);
        window.addEventListener('keyup', this.keyUpHandler);

        // --- Mouse look (pointer lock) ---
        this.mouseMoveHandler = (e: MouseEvent) => {
            if (document.pointerLockElement !== this.renderer!.domElement) return;
            this.cameraYaw -= e.movementX * MOUSE_SENSITIVITY;
            this.cameraPitch += e.movementY * MOUSE_SENSITIVITY;
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

        setActiveHeightMap(scene.heightMap ?? null);

        const elapsed = this.clock.getElapsedTime();

        // --- Apply heightmap geometry (once) ---
        if (!this.groundHeightApplied && scene.heightMap && this.ground) {
            this.applyHeightGeometry(scene.heightMap);
            this.groundHeightApplied = true;
        }

        // --- Stream grass chunks around camera ---
        if (!DEBUG_HIDE_GRASS && this.groundHeightApplied && scene.soilGrid && scene.heightMap) {
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

        // --- Night/day cycle + weather + canopy darkness ---
        const { nightFactor } = getCalendar(scene.time);

        let targetCanopyDarkness = 0;
        if (scene.soilGrid) {
            const camWX = this.thirdPerson ? this.playerPos.x : this.threeCamera!.position.x / SCALE;
            const camWZ = this.thirdPerson ? this.playerPos.y : this.threeCamera!.position.z / SCALE;
            const sunHere = getSoilPropertyAt(scene.soilGrid, camWX, camWZ, 'sunExposure');
            targetCanopyDarkness = Math.max(0, 1 - sunHere);
        }
        const lerpSpeed = 0.08;
        this.canopyDarkness += (targetCanopyDarkness - this.canopyDarkness) * lerpSpeed;

        if (Math.random() < 0.005) {
            console.log(`[Canopy] darkness=${this.canopyDarkness.toFixed(3)} target=${targetCanopyDarkness.toFixed(3)}`);
        }

        this.updateLighting(nightFactor, scene.weather, this.canopyDarkness);

        const frameDt = this.lastRenderTime >= 0 ? Math.min(elapsed - this.lastRenderTime, 0.1) : 0;
        this.lastRenderTime = elapsed;
        if (this.weatherSystem) {
            this.weatherSystem.update(scene, frameDt, this.threeCamera, elapsed);
        }

        // --- Sync entities ---
        this.syncPlants(scene);
        this.syncFruits(scene);
        this.syncAnimals(scene, elapsed);
        this.syncNPCs(scene, elapsed, highlight);
        this.syncBuildings(scene);
        this.syncResources(scene);
        this.syncCorpses(scene);
        this.syncZones(scene);
        this.syncStockLabels(scene);
        this.syncHighlight(highlight);

        // --- Build static lake meshes (once) ---
        this.buildLakes(scene);
        this.updateLakeUniforms();

        // --- Build rock decorations (once, after heightmap ready) ---
        this.buildRocks(scene);

        // --- First-person player ---
        this.updatePlayer(scene, frameDt);

        if (this.csm) this.csm.update();

        // --- Render (two-pass for water refraction) ---
        if (this.lakeMeshes.length > 0) {
            if (!this.refractionRT || this.refractionRT.width !== this.renderer.domElement.width || this.refractionRT.height !== this.renderer.domElement.height) {
                if (this.refractionRT) this.refractionRT.dispose();
                this.refractionRT = new THREE.WebGLRenderTarget(
                    this.renderer.domElement.width,
                    this.renderer.domElement.height,
                    { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter },
                );
            }
            for (const lm of this.lakeMeshes) lm.visible = false;
            this.renderer.setRenderTarget(this.refractionRT);
            this.renderer.render(this.threeScene, this.threeCamera);
            this.renderer.setRenderTarget(null);
            for (const lm of this.lakeMeshes) lm.visible = true;

            if (this.lakeWaterMat) {
                this.lakeWaterMat.uniforms.uRefraction.value = this.refractionRT.texture;
                this.lakeWaterMat.uniforms.uScreenSize.value.set(this.renderer.domElement.width, this.renderer.domElement.height);
            }
        }
        if (this.composer) {
            this.composer.render();
        } else {
            this.renderer.render(this.threeScene, this.threeCamera);
        }

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
        if (this.composer) {
            this.composer.setPixelRatio(dpr);
            this.composer.setSize(w, h);
        }
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
            const dz = GAMEPAD_DEADZONE;
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

    private updatePlayer(_scene: Scene, frameDt: number) {
        if (!this.threeCamera) return;

        if (this.playerMesh) this.playerMesh.visible = false;

        const dt = frameDt > 0 ? frameDt : 1 / 60;
        const gp = this.pollGamepad();
        const wantsSprint = !this.crouching && (this.keysDown.has('shift') || gp.sprint);

        if (this.staminaExhausted && this.stamina > STAMINA_EXHAUST_THRESHOLD * 4) {
            this.staminaExhausted = false;
        }
        const sprinting = wantsSprint && !this.staminaExhausted;

        if (sprinting) {
            this.stamina = Math.max(0, this.stamina - STAMINA_DRAIN * dt);
            this.staminaRegenCooldown = STAMINA_REGEN_DELAY;
            if (this.stamina <= STAMINA_EXHAUST_THRESHOLD) {
                this.staminaExhausted = true;
            }
        } else {
            this.staminaRegenCooldown = Math.max(0, this.staminaRegenCooldown - dt);
            if (this.staminaRegenCooldown <= 0) {
                this.stamina = Math.min(STAMINA_MAX, this.stamina + STAMINA_REGEN * dt);
            }
        }

        const lake = _scene.lakeMap ? getLakeAt(_scene.lakeMap, this.playerPos.x, this.playerPos.y) : null;
        const terrainAtPlayer = _scene.heightMap ? getHeightAt(_scene.heightMap, this.playerPos.x, this.playerPos.y) : 0;
        this.swimming = lake !== null && terrainAtPlayer < lake.waterElevation;

        let speedMult = 1;
        if (this.swimming) speedMult = PLAYER_SWIM_MULT;
        else if (sprinting) speedMult = PLAYER_SPRINT_MULT;
        else if (this.crouching) speedMult = PLAYER_CROUCH_MULT;
        const speed = PLAYER_SPEED * speedMult;

        let targetEye: number;
        if (this.swimming) targetEye = FP_EYE_HEIGHT;
        else if (this.crouching) targetEye = FP_CROUCH_HEIGHT;
        else targetEye = FP_EYE_HEIGHT;
        this.currentEyeHeight += (targetEye - this.currentEyeHeight) * Math.min(1, 12 * dt);

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

        this.cameraYaw -= gp.rightX * GAMEPAD_CAM_SENSITIVITY * dt;
        this.cameraPitch += gp.rightY * GAMEPAD_CAM_SENSITIVITY * dt;
        this.cameraPitch = Math.max(-1.4, Math.min(1.4, this.cameraPitch));

        let moveX = fwdX * inputFwd + rightX * inputRight;
        let moveZ = fwdZ * inputFwd + rightZ * inputRight;

        const isMoving = moveX !== 0 || moveZ !== 0;
        if (isMoving) {
            const len = Math.sqrt(moveX * moveX + moveZ * moveZ);
            moveX /= len;
            moveZ /= len;
            this.playerPos.x += (moveX / SCALE) * speed * dt;
            this.playerPos.y += (moveZ / SCALE) * speed * dt;
        }

        _scene.playerPos = { x: this.playerPos.x, y: this.playerPos.y };
        _scene.playerMoving = isMoving;
        _scene.playerSprinting = sprinting && isMoving;
        _scene.playerCrouching = this.crouching;

        const pivotW = toWorld(this.playerPos);
        let groundY = pivotW.y;
        if (this.swimming && lake) {
            const waterY = lake.waterElevation * HEIGHT_SCALE;
            groundY = waterY + SWIM_EYE_OFFSET;
        }
        const eyeX = pivotW.x;
        const eyeY = groundY + this.currentEyeHeight;
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

        const MAX_RAY_DIST = INTERACT_RANGE * SCALE;
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
                    pickDuration = PICK_DURATION_FRUIT;
                } else {
                    const sp = getSpecies(e.speciesId);
                    label = sp ? sp.displayName : e.speciesId;
                    const sid = e.speciesId;
                    if (TREE_IDS.has(sid)) {
                        pickDuration = PICK_DURATION_TREE;
                    } else if (BUSH_IDS.has(sid)) {
                        pickDuration = PICK_DURATION_BUSH;
                    } else {
                        pickDuration = PICK_DURATION_HERB;
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
                if (pe && TREE_IDS.has(pe.speciesId)) {
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
                    if (pe && TREE_IDS.has(pe.speciesId)) {
                        outlineScale = 5.0;
                        yOff = 0.35;
                    } else if (pe && HERB_IDS.has(pe.speciesId)) {
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

            const staminaPct = this.stamina / STAMINA_MAX;
            if (staminaPct < 0.8) {
                const barW = 120 * dpr;
                const barH = 6 * dpr;
                const barX = cx - barW / 2;
                const barY = canvas.height - 110 * dpr;
                const radius2 = barH / 2;

                ctx.globalAlpha = 0.6 + (1 - staminaPct) * 0.3;

                ctx.beginPath();
                ctx.roundRect(barX, barY, barW, barH, radius2);
                ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
                ctx.fill();

                const fillW = Math.max(0, barW * staminaPct);
                if (fillW > 0) {
                    ctx.beginPath();
                    ctx.roundRect(barX, barY, fillW, barH, radius2);
                    const lowStamina = staminaPct < 0.25;
                    ctx.fillStyle = lowStamina ? '#ff4444' : '#ffcc00';
                    ctx.fill();
                }

                ctx.globalAlpha = 1;
            }
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
        for (const meshData of this.treeInstancedMeshes) {
            if (meshData.instance) {
                this.threeScene?.remove(meshData.instance);
                meshData.instance.dispose();
                meshData.instance = null;
            }
        }
        this.treeInstancedMeshes = [];
        for (const meshData of this.treeLod1Meshes) {
            if (meshData.instance) {
                this.threeScene?.remove(meshData.instance);
                meshData.instance.dispose();
            }
            meshData.geo.dispose();
            meshData.mat.dispose();
        }
        this.treeLod1Meshes = [];
        for (const meshData of this.treeLod2Meshes) {
            if (meshData.instance) {
                this.threeScene?.remove(meshData.instance);
                meshData.instance.dispose();
            }
            meshData.geo.dispose();
            meshData.mat.dispose();
        }
        this.treeLod2Meshes = [];
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

        for (const mesh of this.animalMeshes.values()) {
            this.threeScene!.remove(mesh);
            this.disposeObject(mesh);
        }
        this.animalMeshes.clear();
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

        // Dispose weather system
        if (this.weatherSystem) {
            this.weatherSystem.destroy();
            this.weatherSystem = null;
        }

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

        for (const rock of this.rockMeshes) {
            this.threeScene?.remove(rock);
            this.disposeObject(rock);
        }
        this.rockMeshes = [];
        this.rocksBuilt = false;
        this.rockTemplates = [null, null, null, null];

        for (const lm of this.lakeMeshes) {
            this.threeScene?.remove(lm);
            this.disposeObject(lm);
        }
        this.lakeMeshes = [];
        this.lakesBuilt = false;
        if (this.lakeWaterMat) { this.lakeWaterMat.dispose(); this.lakeWaterMat = null; }
        if (this.refractionRT) { this.refractionRT.dispose(); this.refractionRT = null; }

        if (this.gtaoPass) { this.gtaoPass.dispose(); this.gtaoPass = null; }
        if (this.composer) { this.composer.dispose(); this.composer = null; }

        if (this.csm) {
            this.csm.dispose();
            this.csm.remove();
            this.csm = null;
        }

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

    screenToWorld(screenX: number, screenY: number, _camera: Camera): Vector2D {
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
            emissive: 0x3a5a2f,
            emissiveIntensity: 0.35,
        });

        const fadeStart = GRASS_RENDER_RADIUS * SCALE * 0.55;
        const fadeEnd = GRASS_RENDER_RADIUS * SCALE * 0.92;

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
        lakeMap?: LakeMap | null,
    ): { instA: THREE.InstancedMesh; instB: THREE.InstancedMesh; instC: THREE.InstancedMesh; lod: number } | null {
        const CS = GRASS_CHUNK_SIZE;
        const STEP = lod === 0 ? GRASS_STEP_NEAR : GRASS_STEP_FAR;
        const SCALE_MULT = lod === 0 ? 1.0 : GRASS_SCALE_FAR;

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

                if (lakeMap) {
                    const wd = getWaterDepthAt(lakeMap, heightMap, wx, wz, 0.5);
                    if (wd > 0) continue;
                }

                const hum = sampleBilinear(soilGrid.layers.humidity, wx, wz);
                const waterLvl = sampleBilinear(soilGrid.waterLevel, wx, wz);
                if (waterLvl > 0.08) continue;
                if (hum < 0.08) continue;

                let nearRock = false;
                for (const rp of ThreeRenderer.ROCK_POSITIONS) {
                    const dx = wx - rp.x;
                    const dz = wz - rp.y;
                    const r = rp.scale * 1.1;
                    if (dx * dx + dz * dz < r * r) { nearRock = true; break; }
                }
                if (nearRock) continue;

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
        instA.userData.excludeFromAO = true;
        instB.userData.excludeFromAO = true;
        instC.userData.excludeFromAO = true;

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
        if (dx * dx + dz * dz < (GRASS_CHUNK_SIZE * 0.5) ** 2) return;
        this.grassLastCamX = camWX;
        this.grassLastCamZ = camWZ;

        const CS = GRASS_CHUNK_SIZE;
        const RADIUS = GRASS_RENDER_RADIUS;
        const LOD_BOUNDARY = GRASS_LOD_BOUNDARY;

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
            const chunk = this.buildGrassChunk(cx, cz, soilGrid, heightMap, desiredLod, scene.basinMap, scene.lakeMap);
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

        if (this.csm) {
            for (const p of parts) this.csm.setupMaterial(p.mat);
        }

        this.plantPartCache.set(key, parts);
        return parts;
    }

    // =============================================================
    //  TREE LOD SYSTEM
    // =============================================================

    private createTreeCrossGeo(width: number, height: number): THREE.BufferGeometry {
        const hw = width / 2;
        const positions = new Float32Array([
            -hw, 0, 0,   hw, 0, 0,   hw, height, 0,
            -hw, 0, 0,   hw, height, 0,   -hw, height, 0,
            0, 0, -hw,   0, 0, hw,   0, height, hw,
            0, 0, -hw,   0, height, hw,   0, height, -hw,
        ]);
        const normals = new Float32Array([
            0, 0, 1,  0, 0, 1,  0, 0, 1,
            0, 0, 1,  0, 0, 1,  0, 0, 1,
            1, 0, 0,  1, 0, 0,  1, 0, 0,
            1, 0, 0,  1, 0, 0,  1, 0, 0,
        ]);
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
        geo.computeBoundingSphere();
        return geo;
    }

    private initTreeLod(): void {
        const trunkGeo = new THREE.CylinderGeometry(0.1, 0.15, 2.0, 5);
        trunkGeo.translate(0, 1.0, 0);
        const trunkMat = new THREE.MeshLambertMaterial({ color: 0x6B4226 });

        const crownGeo = new THREE.ConeGeometry(1.2, 4.0, 5);
        crownGeo.translate(0, 4.0, 0);
        const crownMat = new THREE.MeshLambertMaterial({ color: 0x2D5A27 });

        if (this.csm) {
            this.csm.setupMaterial(trunkMat);
            this.csm.setupMaterial(crownMat);
        }

        this.treeLod1Meshes = [
            { geo: trunkGeo, mat: trunkMat, instance: null },
            { geo: crownGeo, mat: crownMat, instance: null },
        ];

        const crossGeo = this.createTreeCrossGeo(2.0, 6.0);
        const crossMat = new THREE.MeshLambertMaterial({ color: 0x2D5A27, side: THREE.DoubleSide });
        if (this.csm) this.csm.setupMaterial(crossMat);

        this.treeLod2Meshes = [
            { geo: crossGeo, mat: crossMat, instance: null },
        ];
    }

    private updateTreeLodInstances(
        meshArray: { geo: THREE.BufferGeometry; mat: THREE.Material; instance: THREE.InstancedMesh | null }[],
        trees: PlantEntity[],
        shadows: boolean,
    ): void {
        if (trees.length > 0 && meshArray.length > 0) {
            for (let meshIdx = 0; meshIdx < meshArray.length; meshIdx++) {
                const meshData = meshArray[meshIdx];
                let inst = meshData.instance;
                const capacity = inst ? (inst as unknown as { _cap: number })._cap ?? 0 : 0;

                if (!inst || capacity < trees.length) {
                    if (inst) {
                        this.threeScene!.remove(inst);
                        inst.dispose();
                    }
                    const newCap = Math.max(trees.length * 2, 32);
                    inst = new THREE.InstancedMesh(meshData.geo, meshData.mat, newCap);
                    inst.castShadow = shadows;
                    inst.receiveShadow = shadows;
                    inst.frustumCulled = false;
                    (inst as unknown as { _cap: number })._cap = newCap;
                    this.threeScene!.add(inst);
                    meshData.instance = inst;
                }

                inst.count = trees.length;

                for (let i = 0; i < trees.length; i++) {
                    const tree = trees[i];
                    const s = Math.max(0.15, tree.growth) * 0.5;
                    const pos = toWorld(tree.position);
                    _pos3.set(pos.x, pos.y, pos.z);
                    _scl3.set(s, s, s);
                    const hash = Math.sin(tree.position.x * 12.9898 + tree.position.y * 78.233) * 43758.5453;
                    const angle = (hash - Math.floor(hash)) * Math.PI * 2;
                    _pos3.set(0, 1, 0);
                    _quat.setFromAxisAngle(_pos3, angle);
                    _pos3.set(pos.x, pos.y, pos.z);
                    _mat4.compose(_pos3, _quat, _scl3);
                    inst.setMatrixAt(i, _mat4);
                }
                inst.instanceMatrix.needsUpdate = true;
                inst.computeBoundingSphere();
            }
        } else {
            for (const meshData of meshArray) {
                if (meshData.instance) {
                    this.threeScene!.remove(meshData.instance);
                    meshData.instance.dispose();
                    meshData.instance = null;
                }
            }
        }
    }

    // =============================================================
    //  INSTANCED PLANT SYNC
    // =============================================================

    private syncPlants(scene: Scene) {
        const plants = scene.entities.filter((e): e is PlantEntity => e.type === 'plant');

        const camWX = this.thirdPerson ? this.playerPos.x : this.threeCamera!.position.x / SCALE;
        const camWZ = this.thirdPerson ? this.playerPos.y : this.threeCamera!.position.z / SCALE;
        const lod0Sq = TREE_LOD0_DIST * TREE_LOD0_DIST;
        const lod1Sq = TREE_LOD1_DIST * TREE_LOD1_DIST;
        const cullSq = TREE_CULL_DIST * TREE_CULL_DIST;
        const plantCullSq = PLANT_CULL_DIST * PLANT_CULL_DIST;

        const lod0Trees: PlantEntity[] = [];
        const lod1Trees: PlantEntity[] = [];
        const lod2Trees: PlantEntity[] = [];
        const nonTrees: PlantEntity[] = [];
        for (const plant of plants) {
            const dx = plant.position.x - camWX;
            const dz = plant.position.y - camWZ;
            const distSq = dx * dx + dz * dz;
            if (TREE_IDS.has(plant.speciesId)) {
                if (distSq < lod0Sq) {
                    lod0Trees.push(plant);
                } else if (distSq < lod1Sq) {
                    lod1Trees.push(plant);
                } else if (distSq < cullSq) {
                    lod2Trees.push(plant);
                }
            } else if (distSq < plantCullSq) {
                nonTrees.push(plant);
            }
        }

        this.updateTreeLodInstances(this.treeInstancedMeshes, lod0Trees, true);
        this.updateTreeLodInstances(this.treeLod1Meshes, lod1Trees, false);
        this.updateTreeLodInstances(this.treeLod2Meshes, lod2Trees, false);

        const groups = new Map<string, PlantEntity[]>();
        for (const plant of nonTrees) {
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

                if (!inst || capacity < count) {
                    if (inst) {
                        this.threeScene!.remove(inst);
                        inst.dispose();
                    }
                    const newCap = Math.max(count * 2, 32);
                    inst = new THREE.InstancedMesh(parts[pi].geo, parts[pi].mat, newCap);
                    inst.castShadow = true;
                    inst.receiveShadow = true;
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

    private syncAnimals(scene: Scene, elapsed: number) {
        const animals = scene.entities.filter((e): e is AnimalEntity => e.type === 'animal');
        const activeIds = new Set(animals.map((a) => a.id));

        for (const [id, mesh] of this.animalMeshes) {
            if (!activeIds.has(id)) {
                this.threeScene!.remove(mesh);
                this.disposeObject(mesh);
                this.animalMeshes.delete(id);
            }
        }

        for (const animal of animals) {
            const species = getAnimalSpecies(animal.speciesId);
            if (!species) continue;

            let group = this.animalMeshes.get(animal.id);
            if (!group) {
                group = buildAnimalModel(animal.speciesId, species.color);
                this.threeScene!.add(group);
                this.animalMeshes.set(animal.id, group);
            }

            const pos = toWorld(animal.position);
            group.position.set(pos.x, pos.y, pos.z);

            group.rotation.y = -animal.heading + Math.PI / 2;

            const scale = 0.4 + animal.growth * 0.6;
            group.scale.setScalar(scale);

            if (animal.state === 'dead') {
                group.rotation.z = Math.PI / 2;
                group.rotation.x = 0;
                group.position.y = pos.y + 0.02;
                const fade = Math.max(0.1, 1 - (animal.age / (5 * 240)));
                group.traverse((child) => {
                    if (child instanceof THREE.Mesh && child.material instanceof THREE.MeshLambertMaterial) {
                        child.material.transparent = true;
                        child.material.opacity = fade;
                    }
                });
            } else if (animal.state === 'sleeping') {
                group.rotation.z = Math.PI / 2;
                group.rotation.x = 0;
                group.position.y = pos.y + 0.01;
                const breathe = 1 + Math.sin(elapsed * 1.5 + animal.id.charCodeAt(0)) * 0.02;
                group.scale.setScalar(scale * breathe);
                group.traverse((child) => {
                    if (child instanceof THREE.Mesh && child.material instanceof THREE.MeshLambertMaterial) {
                        child.material.transparent = false;
                        child.material.opacity = 1;
                    }
                });
            } else {
                group.rotation.z = 0;

                if (animal.state === 'grazing') {
                    group.rotation.x = 0.25;
                    group.position.y = pos.y - 0.01;
                } else if (animal.state === 'calling') {
                    group.rotation.x = -0.2;
                    group.position.y = pos.y;
                } else {
                    group.rotation.x = 0;
                }

                if (animal.state === 'wandering' || animal.state === 'eating' || animal.state === 'fleeing' || animal.state === 'mating') {
                    const bobSpeed = animal.state === 'fleeing' ? 14 : 5;
                    const bobAmp = animal.speciesId === 'rabbit' ? 0.012 : 0.004;
                    group.position.y = pos.y + Math.abs(Math.sin(elapsed * bobSpeed + animal.id.charCodeAt(0))) * bobAmp;
                }

                group.traverse((child) => {
                    if (child instanceof THREE.Mesh && child.material instanceof THREE.MeshLambertMaterial) {
                        child.material.transparent = false;
                        child.material.opacity = 1;
                    }
                });
            }
        }
    }

    private syncNPCs(scene: Scene, elapsed: number, _highlight: Highlight) {
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

    private syncZones(__scene: Scene) {
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

    private updateLighting(nightFactor: number, weather?: { current: string; rainIntensity: number }, canopyDarkness = 0) {
        if (!this.csm || !this.renderer || !this.threeScene) return;

        const weatherType = weather?.current ?? 'sunny';

        const dayColor = new THREE.Color(0x87ceeb);
        const nightColor = new THREE.Color(0x020208);
        const duskColor = new THREE.Color(0xff7b4f);
        const canopySkyColor = new THREE.Color(0x3a5a3a);

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

        if (canopyDarkness > 0.01) {
            skyColor.lerp(canopySkyColor, canopyDarkness * 0.25);
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

        const lightningFlash = this.weatherSystem?.getLightningFlash() ?? 0;
        if (lightningFlash > 0) {
            skyColor.lerp(new THREE.Color(0xeeeeff), lightningFlash * 0.7);
        }

        this.renderer.setClearColor(skyColor);

        if (this.threeScene.fog instanceof THREE.Fog) {
            const fogColor = skyColor.clone();
            if (nightFactor > 0) {
                const nightDark = new THREE.Color(0x020208);
                fogColor.lerp(nightDark, nightFactor * 0.95);
            }
            this.threeScene.fog.color.copy(fogColor);
            let fogNear = 80, fogFar = 240;
            if (weatherType === 'foggy') { fogNear = 2; fogFar = 24; }
            else if (weatherType === 'stormy') { fogNear = 30; fogFar = 120; }
            else if (weatherType === 'snowy') { fogNear = 40; fogFar = 160; }
            else if (weatherType === 'rainy') { fogNear = 60; fogFar = 200; }
            else if (weatherType === 'cloudy') { fogNear = 120; fogFar = 320; }
            if (canopyDarkness > 0.05) {
                fogNear *= (1 - canopyDarkness * 0.3);
                fogFar *= (1 - canopyDarkness * 0.2);
            }
            this.threeScene.fog.near += (fogNear - this.threeScene.fog.near) * 0.03;
            this.threeScene.fog.far += (fogFar - this.threeScene.fog.far) * 0.03;
        }

        let sunMult = 1.0;
        if (weatherType === 'foggy') sunMult = 0.18;
        else if (weatherType === 'snowy') sunMult = 0.5;
        else if (weatherType === 'cloudy') sunMult = 0.6;
        else if (weatherType === 'rainy') sunMult = 0.35;
        else if (weatherType === 'stormy') sunMult = 0.2;

        const canopySunDim = 1 - canopyDarkness * 0.4;
        let sunIntensity = Math.max(0.01, 1.2 * (1 - nightFactor) * sunMult * canopySunDim);
        if (lightningFlash > 0) {
            sunIntensity += lightningFlash * 3.5;
        }

        const sunDayColor = new THREE.Color(0xfff5e0);
        const sunDuskColor = new THREE.Color(0xff6622);
        const sunColor = sunDayColor.clone();
        if (nightFactor > 0 && nightFactor < 1) {
            sunColor.lerp(sunDuskColor, nightFactor);
        }

        for (const light of this.csm.lights) {
            light.intensity = sunIntensity;
            light.color.copy(sunColor);
        }

        const ambient = this.threeScene.children.find((c) => c instanceof THREE.AmbientLight) as THREE.AmbientLight | undefined;
        if (ambient) {
            let ambientBase = 0.15 + 0.45 * (1 - nightFactor);
            ambientBase *= (sunMult * 0.6 + 0.4);
            ambientBase *= (1 - canopyDarkness * 0.35);
            ambientBase = Math.max(0.02, ambientBase);
            if (lightningFlash > 0) {
                ambientBase += lightningFlash * 2.5;
            }
            ambient.intensity = ambientBase;

            if (canopyDarkness > 0.01) {
                const dayAmbientColor = new THREE.Color(0xffffff);
                const forestAmbientColor = new THREE.Color(0x6a8a6a);
                const blended = dayAmbientColor.clone().lerp(forestAmbientColor, canopyDarkness * 0.3);
                ambient.color.copy(blended);
            } else {
                ambient.color.setHex(0xffffff);
            }
        }
    }

    // =============================================================
    //  WEATHER EFFECTS — rain particles, lightning
    // =============================================================


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

        if (DEBUG_WIREFRAME && this.threeScene) {
            const wireMat = new THREE.MeshBasicMaterial({ color: 0x00ff00, wireframe: true });
            const wireMesh = new THREE.Mesh(geo, wireMat);
            wireMesh.rotation.x = -Math.PI / 2;
            wireMesh.position.copy(this.ground.position);
            wireMesh.position.y += 0.02;
            this.threeScene.add(wireMesh);
        }
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
        if (this.csm) this.csm.setupMaterial(this.groundSplatMat);
        const csmSplatCallback = this.groundSplatMat.onBeforeCompile;
        this.groundSplatMat.onBeforeCompile = (shader, renderer) => {
            if (csmSplatCallback) csmSplatCallback.call(this.groundSplatMat, shader, renderer);

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
                    '    float relief = 1.0 - basin * 0.5;',
                    '    vec3 col = mix(dirtC.rgb, grassC.rgb, blend) * relief;',
                    '    float lum = dot(col, vec3(0.299, 0.587, 0.114));',
                    '    col = clamp(mix(vec3(lum), col, 1.5), 0.0, 1.0);',
                    '    col *= col;',
                    '    diffuseColor.rgb *= col * 1.5;',
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

        for (let row = 0; row < rows; row++) {
            for (let col = 0; col < cols; col++) {
                const i = row * cols + col;
                const wx = sg.originX + col * sg.cellSize + sg.cellSize * 0.5;
                const wy = sg.originY + row * sg.cellSize + sg.cellSize * 0.5;

                const hmCol = Math.min(hm.cols - 1, Math.max(0, Math.round((wx - hm.originX) / hm.cellSize)));
                const hmRow = Math.min(hm.rows - 1, Math.max(0, Math.round((wy - hm.originY) / hm.cellSize)));
                const hmIdx = hmRow * hm.cols + hmCol;

                const humidity = sg.layers.humidity[i];
                const elev = (hm.data[hmIdx] - hm.minHeight) / range;
                const rockFactor = Math.min(1, Math.max(0, elev - 0.45) * 2.5);
                const grassFactor = humidity * (1 - rockFactor);
                let blend = Math.max(0, Math.min(1, grassFactor * 2.2));

                const st = sg.soilType[i];
                if (st === 1) blend *= 0.15;
                else if (st === 3) blend *= 0.05;
                else if (st === 4) blend = Math.min(1, blend * 1.3);

                const basin = bm ? bm.data[hmIdx] : 0;
                const px = i * 4;
                imageData.data[px + 0] = Math.round(blend * 255);
                imageData.data[px + 1] = Math.round(basin * 255);
                imageData.data[px + 2] = st;
                imageData.data[px + 3] = 255;
            }
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
        const useHmGrid = overlay === 'elevation' || overlay === 'basin';
        const cols = useHmGrid ? (hm?.cols ?? 0) : (sg?.cols ?? hm?.cols ?? 0);
        const rows = useHmGrid ? (hm?.rows ?? 0) : (sg?.rows ?? hm?.rows ?? 0);
        if (cols === 0 || rows === 0) return;

        const gridOriginX = useHmGrid ? (hm?.originX ?? 0) : (sg?.originX ?? hm?.originX ?? 0);
        const gridOriginY = useHmGrid ? (hm?.originY ?? 0) : (sg?.originY ?? hm?.originY ?? 0);
        const gridCellSize = useHmGrid ? (hm?.cellSize ?? 1) : (sg?.cellSize ?? hm?.cellSize ?? 1);

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

        const sampleHm = (wx: number, wy: number): number => {
            if (!hm) return 0;
            const hc = Math.min(hm.cols - 1, Math.max(0, Math.round((wx - hm.originX) / hm.cellSize)));
            const hr = Math.min(hm.rows - 1, Math.max(0, Math.round((wy - hm.originY) / hm.cellSize)));
            return hm.data[hr * hm.cols + hc];
        };
        for (let row = 0; row < rows; row++) {
            for (let col = 0; col < cols; col++) {
                const i = row * cols + col;
                const wx = gridOriginX + col * gridCellSize + gridCellSize * 0.5;
                const wy = gridOriginY + row * gridCellSize + gridCellSize * 0.5;
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
                    if (sg && hm) {
                        const sgCol = Math.min(sg.cols - 1, Math.max(0, Math.round((wx - sg.originX) / sg.cellSize)));
                        const sgRow = Math.min(sg.rows - 1, Math.max(0, Math.round((wy - sg.originY) / sg.cellSize)));
                        const si = sgRow * sg.cols + sgCol;
                        const humidity = sg.layers.humidity[si];
                        const minerals = sg.layers.minerals[si];
                        const range = hm.maxHeight - hm.minHeight || 1;
                        const elev = (sampleHm(wx, wy) - hm.minHeight) / range;

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
                        const sgCol2 = Math.min(sg.cols - 1, Math.max(0, Math.round((wx - sg.originX) / sg.cellSize)));
                        const sgRow2 = Math.min(sg.rows - 1, Math.max(0, Math.round((wy - sg.originY) / sg.cellSize)));
                        const si2 = sgRow2 * sg.cols + sgCol2;
                        const h = sg.layers.humidity[si2];
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
            if (this.csm) this.csm.setupMaterial(this.groundOverlayMat);
        }
        if (this.ground.material !== this.groundOverlayMat) {
            this.ground.material = this.groundOverlayMat;
        }

        // If no heightmap applied yet, also resize geometry to match grid
        if (!this.groundHeightApplied && (sg || hm)) {
            const ref = hm ?? sg!;
            const worldW = (ref.cols - 1) * ref.cellSize * SCALE;
            const worldH = (ref.rows - 1) * ref.cellSize * SCALE;
            const centerX = (ref.originX + (ref.cols - 1) * ref.cellSize / 2) * SCALE;
            const centerZ = (ref.originY + (ref.rows - 1) * ref.cellSize / 2) * SCALE;
            this.ground.geometry.dispose();
            this.ground.geometry = new THREE.PlaneGeometry(worldW, worldH);
            this.ground.position.set(centerX, 0, centerZ);
        }
    }

    // --- Rock decorations (static, placed once on terrain) ---

    private static readonly ROCK_POSITIONS: { x: number; y: number; scale: number; rotY: number }[] = [
        { x: 0, y: 0, scale: 1.5, rotY: 0.0 },
        { x: 15, y: 10, scale: 1.2, rotY: 1.3 },
        { x: -20, y: 18, scale: 0.8, rotY: 2.7 },
        { x: 30, y: -15, scale: 1.8, rotY: 4.2 },
        { x: -25, y: -30, scale: 1.0, rotY: 5.5 },
        { x: 40, y: 35, scale: 1.4, rotY: 0.9 },
        { x: -40, y: 40, scale: 0.7, rotY: 3.1 },
        { x: 50, y: -25, scale: 1.6, rotY: 1.8 },
        { x: -35, y: -50, scale: 1.1, rotY: 4.7 },
        { x: 60, y: 20, scale: 0.9, rotY: 2.3 },
        { x: -55, y: 15, scale: 1.3, rotY: 5.9 },
        { x: 25, y: 60, scale: 1.7, rotY: 0.6 },
        { x: -45, y: -10, scale: 0.8, rotY: 3.8 },
        { x: 70, y: -40, scale: 1.5, rotY: 1.2 },
        { x: -60, y: 50, scale: 1.2, rotY: 4.4 },
        { x: 10, y: -60, scale: 1.0, rotY: 2.9 },
        { x: -70, y: -20, scale: 1.4, rotY: 5.3 },
        { x: 80, y: 45, scale: 0.9, rotY: 0.5 },
        { x: -15, y: 70, scale: 1.6, rotY: 3.5 },
        { x: 55, y: -55, scale: 1.1, rotY: 1.7 },
        { x: -80, y: 30, scale: 1.3, rotY: 4.9 },
        { x: 35, y: 80, scale: 0.8, rotY: 2.1 },
        { x: -50, y: -70, scale: 1.8, rotY: 5.7 },
        { x: 90, y: 10, scale: 1.2, rotY: 0.8 },
        { x: -90, y: -40, scale: 1.5, rotY: 3.2 },
        { x: 20, y: 90, scale: 0.7, rotY: 1.5 },
        { x: -30, y: -90, scale: 1.4, rotY: 4.6 },
        { x: 100, y: 60, scale: 1.0, rotY: 2.4 },
        { x: -100, y: 70, scale: 1.6, rotY: 5.1 },
        { x: 75, y: -80, scale: 1.3, rotY: 0.3 },
        { x: -600, y: -400, scale: 1.2, rotY: 0.0 },
        { x: -550, y: -380, scale: 0.6, rotY: 1.8 },
        { x: 400, y: -700, scale: 1.5, rotY: 0.5 },
        { x: 420, y: -720, scale: 0.7, rotY: 3.1 },
        { x: -800, y: 200, scale: 1.8, rotY: 2.2 },
        { x: -780, y: 220, scale: 0.5, rotY: 0.9 },
        { x: 700, y: 500, scale: 1.0, rotY: 4.0 },
        { x: 720, y: 480, scale: 0.8, rotY: 1.2 },
        { x: -200, y: 800, scale: 1.4, rotY: 5.5 },
        { x: -180, y: 820, scale: 0.6, rotY: 2.7 },
        { x: 100, y: -300, scale: 2.0, rotY: 3.8 },
        { x: 120, y: -280, scale: 0.9, rotY: 0.4 },
        { x: -900, y: -600, scale: 1.3, rotY: 1.5 },
        { x: -880, y: -620, scale: 0.7, rotY: 4.6 },
        { x: 600, y: 200, scale: 1.6, rotY: 2.9 },
        { x: 620, y: 180, scale: 0.5, rotY: 5.1 },
        { x: -400, y: -900, scale: 1.1, rotY: 0.7 },
        { x: -380, y: -880, scale: 0.8, rotY: 3.4 },
        { x: 300, y: 900, scale: 1.7, rotY: 1.0 },
        { x: 320, y: 880, scale: 0.6, rotY: 4.3 },
        { x: -100, y: -100, scale: 0.9, rotY: 2.0 },
        { x: 0, y: 600, scale: 1.3, rotY: 5.8 },
        { x: -700, y: 700, scale: 1.5, rotY: 0.3 },
        { x: -680, y: 720, scale: 0.7, rotY: 3.6 },
        { x: 800, y: -200, scale: 1.2, rotY: 1.7 },
        { x: 820, y: -220, scale: 0.5, rotY: 4.9 },
        { x: 500, y: -500, scale: 1.4, rotY: 2.5 },
        { x: 520, y: -480, scale: 0.8, rotY: 5.3 },
        { x: -500, y: 500, scale: 1.0, rotY: 0.6 },
        { x: -480, y: 520, scale: 0.6, rotY: 3.9 },
        { x: 900, y: 800, scale: 1.8, rotY: 1.3 },
        { x: 880, y: 780, scale: 0.7, rotY: 4.1 },
        { x: -300, y: 300, scale: 1.1, rotY: 2.4 },
        { x: -1000, y: -100, scale: 1.6, rotY: 5.0 },
        { x: -980, y: -80, scale: 0.5, rotY: 0.8 },
        { x: 200, y: 400, scale: 1.3, rotY: 3.2 },
        { x: 220, y: 420, scale: 0.9, rotY: 1.1 },
        { x: -600, y: 900, scale: 1.5, rotY: 4.7 },
        { x: -580, y: 920, scale: 0.6, rotY: 2.1 },
        { x: 950, y: -900, scale: 2.0, rotY: 0.2 },
    ];

    private buildRocks(scene: Scene) {
        if (!this.threeScene || !scene.heightMap) return;
        if (this.rockTemplates.some(t => t === null)) return;
        if (this.rocksBuilt) return;
        this.rocksBuilt = true;

        const hm = scene.heightMap;

        ThreeRenderer.ROCK_POSITIONS.forEach((def, index) => {
            const h = getHeightAt(hm, def.x, def.y) * HEIGHT_SCALE;
            if (h <= SEA_LEVEL * SCALE + 0.05) return;

            const templateIndex = index % 4;
            const rock = this.rockTemplates[templateIndex]!.clone();
            const s = def.scale * 0.15;
            rock.scale.set(s, s, s);
            rock.position.set(def.x * SCALE, h - 0.02, def.y * SCALE);
            rock.rotation.y = def.rotY;

            this.threeScene!.add(rock);
            this.rockMeshes.push(rock);
        });
    }

    // --- Lake meshes (static water bodies) ---

    private buildLakes(scene: Scene) {
        if (!this.threeScene || !scene.lakeMap || !scene.heightMap) return;
        if (this.lakesBuilt) return;
        this.lakesBuilt = true;

        const hm = scene.heightMap;
        const lm = scene.lakeMap;

        if (!this.lakeWaterMat) {
            const loader = new THREE.TextureLoader();
            const waterTex = loader.load('/textures/ground/water.png');
            waterTex.wrapS = waterTex.wrapT = THREE.RepeatWrapping;
            waterTex.minFilter = THREE.LinearMipmapLinearFilter;
            waterTex.magFilter = THREE.LinearFilter;

            this.lakeWaterMat = new THREE.ShaderMaterial({
                transparent: true,
                depthWrite: false,
                side: THREE.DoubleSide,
                uniforms: {
                    uTime: { value: 0 },
                    uWaterTex: { value: waterTex },
                    uRefraction: { value: null as THREE.Texture | null },
                    uScreenSize: { value: new THREE.Vector2(1, 1) },
                    uShallow: { value: new THREE.Color(0x4aadcf) },
                    uDeep: { value: new THREE.Color(0x1a5a80) },
                    uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.3).normalize() },
                },
                vertexShader: `
                    uniform float uTime;
                    varying vec3 vWorldPos;
                    varying vec3 vNormal;
                    varying vec2 vUv;
                    varying vec4 vScreenPos;

                    vec3 gerstnerWave(vec2 pos, vec2 dir, float steepness, float wl, float spd) {
                        float k = 6.28318 / wl;
                        float f = k * (dot(dir, pos) - spd / k * uTime);
                        float a = steepness / k;
                        return vec3(dir.x * a * cos(f), a * sin(f), dir.y * a * cos(f));
                    }

                    void main() {
                        vUv = uv;
                        vec4 wp = modelMatrix * vec4(position, 1.0);
                        vec2 p = wp.xz;

                        vec2 d1 = normalize(vec2(1.0, 0.3));
                        vec2 d2 = normalize(vec2(-0.4, 1.0));
                        vec2 d3 = normalize(vec2(0.7, -0.6));
                        vec2 d4 = normalize(vec2(-0.8, -0.3));

                        vec3 wave = gerstnerWave(p, d1, 0.12, 4.0, 1.2)
                                  + gerstnerWave(p, d2, 0.08, 2.5, 0.9)
                                  + gerstnerWave(p, d3, 0.05, 1.5, 1.5)
                                  + gerstnerWave(p, d4, 0.03, 0.8, 2.0);

                        wp.x += wave.x * 0.015;
                        wp.y += wave.y * 0.015;
                        wp.z += wave.z * 0.015;
                        vWorldPos = wp.xyz;

                        float eps = 0.05;
                        float s = 0.015;
                        vec3 wR = gerstnerWave(p + vec2(eps, 0.0), d1, 0.12, 4.0, 1.2)
                                + gerstnerWave(p + vec2(eps, 0.0), d2, 0.08, 2.5, 0.9);
                        vec3 wL = gerstnerWave(p - vec2(eps, 0.0), d1, 0.12, 4.0, 1.2)
                                + gerstnerWave(p - vec2(eps, 0.0), d2, 0.08, 2.5, 0.9);
                        vec3 wU = gerstnerWave(p + vec2(0.0, eps), d1, 0.12, 4.0, 1.2)
                                + gerstnerWave(p + vec2(0.0, eps), d2, 0.08, 2.5, 0.9);
                        vec3 wD = gerstnerWave(p - vec2(0.0, eps), d1, 0.12, 4.0, 1.2)
                                + gerstnerWave(p - vec2(0.0, eps), d2, 0.08, 2.5, 0.9);
                        vec3 T = normalize(vec3(2.0 * eps, (wR.y - wL.y) * s, 0.0));
                        vec3 B = normalize(vec3(0.0, (wU.y - wD.y) * s, 2.0 * eps));
                        vNormal = normalize(cross(B, T));

                        gl_Position = projectionMatrix * viewMatrix * wp;
                        vScreenPos = gl_Position;
                    }
                `,
                fragmentShader: `
                    uniform float uTime;
                    uniform sampler2D uWaterTex;
                    uniform sampler2D uRefraction;
                    uniform vec2 uScreenSize;
                    uniform vec3 uShallow;
                    uniform vec3 uDeep;
                    uniform vec3 uSunDir;
                    varying vec3 vWorldPos;
                    varying vec3 vNormal;
                    varying vec2 vUv;
                    varying vec4 vScreenPos;

                    void main() {
                        vec3 N = normalize(vNormal);
                        vec3 viewDir = normalize(cameraPosition - vWorldPos);

                        vec2 screenUV = (vScreenPos.xy / vScreenPos.w) * 0.5 + 0.5;

                        float refrStrength = 0.07;
                        vec2 refrOffset = N.xz * refrStrength;

                        float caustic1 = sin(vWorldPos.x * 12.0 + uTime * 1.5) * sin(vWorldPos.z * 10.0 + uTime * 1.2);
                        float caustic2 = sin(vWorldPos.x * 8.0 - uTime * 0.9) * sin(vWorldPos.z * 14.0 - uTime * 1.1);
                        refrOffset += vec2(caustic1, caustic2) * 0.025;

                        vec2 refrUV = clamp(screenUV + refrOffset, 0.001, 0.999);
                        vec3 bottomCol = texture2D(uRefraction, refrUV).rgb;

                        float texScale = 6.0;
                        vec2 distort = N.xz * 0.02;
                        vec2 uv1 = vWorldPos.xz * texScale + distort + vec2(uTime * 0.018, uTime * 0.012);
                        vec2 uv2 = vWorldPos.xz * texScale * 0.6 + distort * 1.5 + vec2(-uTime * 0.012, uTime * 0.02);
                        vec3 texCol = mix(texture2D(uWaterTex, uv1).rgb, texture2D(uWaterTex, uv2).rgb, 0.5);

                        float edge = min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y));
                        float depthFactor = smoothstep(0.0, 0.3, edge);

                        vec3 waterTint = mix(uShallow, uDeep, depthFactor);
                        vec3 surfaceCol = mix(waterTint, texCol * waterTint, 0.4);

                        float bottomMix = mix(0.75, 0.35, depthFactor);
                        vec3 col = mix(surfaceCol, bottomCol, bottomMix);

                        float fresnel = pow(1.0 - max(0.0, dot(viewDir, N)), 4.0);
                        vec3 skyCol = vec3(0.55, 0.72, 0.9);
                        col = mix(col, skyCol, fresnel * 0.35);

                        vec3 H = normalize(uSunDir + viewDir);
                        float spec = pow(max(0.0, dot(N, H)), 180.0);
                        col += vec3(1.0, 0.95, 0.85) * spec * 0.7;

                        float causticBright = max(0.0, caustic1 * 0.5 + 0.5) * max(0.0, caustic2 * 0.5 + 0.5);
                        col += vec3(0.8, 0.9, 1.0) * causticBright * 0.08 * (1.0 - depthFactor);

                        float foam = smoothstep(0.015, 0.0, edge) * 0.25;
                        col += vec3(foam);

                        float alpha = mix(0.35, 0.7, depthFactor);
                        gl_FragColor = vec4(col, alpha);
                    }
                `,
            });
        }

        for (const lake of lm.lakes) {
            const mesh = this.buildLakeMesh(lake, hm, lm);
            if (mesh) {
                this.threeScene.add(mesh);
                this.lakeMeshes.push(mesh);
            }
        }
    }

    private buildLakeMesh(lake: Lake, _hm: HeightMap, lm: LakeMap): THREE.Mesh | null {
        const { cellSize, originX, originY } = lm;
        const waterY = lake.waterElevation * HEIGHT_SCALE;

        const pad = 2;
        const w = (lake.maxCol - lake.minCol + 1 + pad * 2) * cellSize * SCALE;
        const h = (lake.maxRow - lake.minRow + 1 + pad * 2) * cellSize * SCALE;

        const segTarget = 0.8;
        const segsX = Math.max(2, Math.ceil(w / segTarget));
        const segsZ = Math.max(2, Math.ceil(h / segTarget));

        const geo = new THREE.PlaneGeometry(w, h, segsX, segsZ);
        geo.rotateX(-Math.PI / 2);

        const centerX = (originX + (lake.minCol + lake.maxCol) * 0.5 * cellSize) * SCALE;
        const centerZ = (originY + (lake.minRow + lake.maxRow) * 0.5 * cellSize) * SCALE;

        const mesh = new THREE.Mesh(geo, this.lakeWaterMat!);
        mesh.position.set(centerX, waterY, centerZ);
        mesh.renderOrder = 1;

        return mesh;
    }

    private updateLakeUniforms() {
        if (this.lakeWaterMat) {
            this.lakeWaterMat.uniforms.uTime.value = performance.now() / 1000;
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

// --- Register ---
registerRenderer('three3d', () => new ThreeRenderer());
