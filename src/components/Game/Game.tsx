import { useCallback, useEffect, useRef, useState } from 'react';
import { useGameLoop } from '@/hooks/useGameLoop';

import classNameModule from '@anthonyjeamme/classname';
import styles from './Game.module.scss';
import { processWorld } from '../World/simulation';
import { processAI } from '../AI/brain';
import { AnimalEntity, BuildingEntity, Calendar, Camera, CorpseEntity, FertileZoneEntity, Highlight, KnownZone, NPCEntity, NPCTraits, PlantEntity, SECONDS_PER_DAY, SECONDS_PER_HOUR, WORLD_HALF, Scene, getCalendar, getLifeStage } from '../World/types';
import { getItemDef } from '../Shared/registry';
import { findCabinSlot, generateCabinPlot, refreshNearbyPlots } from '../World/terrain';
import { generateEntityId } from '../Shared/ids';
import { /* initFactions, */ updateFactionStats, checkFactionConflicts } from '../World/factions';
import { processEvents } from '../World/events';
import { createSoilGrid } from '../World/fertility';
import { createHeightMap, createBasinMap, createDepressionMap, generateLakes, getHeightAt, getWaterDepthAt, SEA_LEVEL } from '../World/heightmap';
import type { LakeMap } from '../World/heightmap';
import { createWeatherState, WEATHER_LABELS, WEATHER_ICONS, WEATHER_TYPES } from '../World/weather';
import type { WeatherType } from '../World/weather';
import { GameRenderer, createRenderer, getAvailableRenderers, SoilOverlay } from '../Render/GameRenderer';
import { SOIL_PROPERTIES, SoilProperty } from '../World/fertility';
import { AmbianceManager } from '../Audio/AmbianceManager';
import { MusicManager } from '../Audio/MusicManager';

const SOIL_LAYER_LABELS: Record<SoilProperty, string> = {
    humidity: 'Humidité',
    minerals: 'Minéraux',
    organicMatter: 'Mat. organique',
    sunExposure: 'Ensoleillement',
};

// --- Register available renderers (side-effect imports) ---
import '../Render/2DRender/Canvas2DRenderer';
import '../Render/3DRender/ThreeRenderer';

const className = classNameModule(styles);

const UI_UPDATE_INTERVAL = 0.2;

// --- Default trait presets ---

const DEFAULT_TRAITS: NPCTraits = {
    speed: 100,
    visionRange: 300,
    explorationRange: 700,
    carryCapacity: 5,
    gatherSpeed: 1.0,
    stamina: 1.0,
    hungerRate: 0.7,
    thirstRate: 0.7,
    charisma: 0.5,
    aggressiveness: 0.3,
    courage: 0.5,
    intelligence: 0.5,
};

// --- Procedural generation ---

const NPC_NAMES_MALE = [
    'Alaric', 'Bastien', 'Cédric', 'Dorian', 'Emeric',
    'Florian', 'Gaël', 'Hadrien', 'Isidore', 'Jules',
    'Kilian', 'Léandre', 'Marius', 'Noël', 'Octave',
];
const NPC_NAMES_FEMALE = [
    'Adèle', 'Bérénice', 'Céleste', 'Diane', 'Éloïse',
    'Flore', 'Garance', 'Héloïse', 'Iris', 'Joséphine',
    'Katell', 'Luce', 'Margaux', 'Ninon', 'Ondine',
];
const NPC_COLORS = [
    '#e74c3c', '#3498db', '#27ae60', '#9b59b6', '#e67e22',
    '#e91e63', '#1abc9c', '#f39c12', '#2980b9', '#c0392b',
    '#8e44ad', '#16a085', '#d35400', '#2c3e50', '#7f8c8d',
];

const VILLAGE_CENTERS = [
    { x: 0, y: 0 },
    { x: 800, y: -600 },
    { x: -700, y: 600 },
];

function randRange(min: number, max: number) {
    return min + Math.random() * (max - min);
}

function randomizeTraits(): NPCTraits {
    const vary = (base: number, pct = 0.2) => base * (1 - pct + Math.random() * pct * 2);
    return {
        speed: vary(DEFAULT_TRAITS.speed),
        visionRange: vary(DEFAULT_TRAITS.visionRange),
        explorationRange: vary(DEFAULT_TRAITS.explorationRange),
        carryCapacity: DEFAULT_TRAITS.carryCapacity,
        gatherSpeed: vary(DEFAULT_TRAITS.gatherSpeed),
        stamina: vary(DEFAULT_TRAITS.stamina),
        hungerRate: vary(DEFAULT_TRAITS.hungerRate),
        thirstRate: vary(DEFAULT_TRAITS.thirstRate),
        charisma: Math.min(1, Math.max(0.1, vary(DEFAULT_TRAITS.charisma))),
        aggressiveness: Math.min(1, Math.max(0, vary(DEFAULT_TRAITS.aggressiveness))),
        courage: Math.min(1, Math.max(0.1, vary(DEFAULT_TRAITS.courage))),
        intelligence: Math.min(1, Math.max(0.1, vary(DEFAULT_TRAITS.intelligence))),
    };
}

function generateVillage(
    center: { x: number; y: number },
    npcCount: number,
    villageIdx: number,
    allEntities: Scene['entities'],
) {
    const maleNames = [...NPC_NAMES_MALE].sort(() => Math.random() - 0.5);
    const femaleNames = [...NPC_NAMES_FEMALE].sort(() => Math.random() - 0.5);
    let maleIdx = villageIdx * 5; // offset to avoid name duplicates across villages
    let femaleIdx = villageIdx * 5;

    const villageNpcs: NPCEntity[] = [];
    const villageCabinIds = new Set<string>();

    // Job distribution per village: first NPCs get specialized jobs
    const VILLAGE_JOBS: (string | null)[] = ['farmer', 'farmer', 'woodcutter', 'hunter', null, null, null, null];

    for (let i = 0; i < npcCount; i++) {
        const sex: 'male' | 'female' = i % 2 === 0 ? 'male' : 'female';
        const name = sex === 'male'
            ? maleNames[maleIdx++ % maleNames.length]
            : femaleNames[femaleIdx++ % femaleNames.length];
        const color = NPC_COLORS[(villageIdx * 5 + i) % NPC_COLORS.length];
        const npcId = generateEntityId();
        const cabinId = `cabin-${npcId}`;

        // Spread NPCs around village center
        const angle = (i / npcCount) * Math.PI * 2 + Math.random() * 0.3;
        const dist = 30 + Math.random() * 60;
        const npcPos = {
            x: center.x + Math.cos(angle) * dist,
            y: center.y + Math.sin(angle) * dist,
        };

        const npc: NPCEntity = {
            id: npcId,
            type: 'npc',
            name,
            sex,
            color,
            isPlayer: false,
            age: 18 + Math.random() * 10,
            homeId: cabinId,
            job: VILLAGE_JOBS[i] ?? null,
            traits: randomizeTraits(),
            needs: {
                health: 100,
                hunger: 75 + Math.random() * 25,
                thirst: 75 + Math.random() * 25,
                hungerReserve: 100,
                thirstReserve: 100,
                energy: 80 + Math.random() * 20,
                happiness: 50,
                starvationTimer: 0,
                dehydrationTimer: 0,
            },
            reproduction: { desire: 0, cooldown: 0, gestation: null, fertilityCycle: Math.random() * 1200 },
            position: npcPos,
            movement: null,
            action: null,
            inventory: [],
            messages: [],
            knowledge: { relations: [], locations: [], npcs: [] },
            ai: { state: 'idle', targetId: null, tickInterval: 0.1 + Math.random() * 0.05, tickAccumulator: 0, greetBubbleTimer: 0, restTimer: 0, tradeOffer: null, tradeWant: null, tradePhase: null, craftRecipeId: null, attackCooldown: 0, sleepConsolidated: false },
            actionHistory: [],
        };
        allEntities.push(npc);
        villageNpcs.push(npc);

        // Place cabin organically — only cluster with same-village cabins
        const allCabins = allEntities.filter((e): e is BuildingEntity => e.type === 'building');
        const villageCabins = allCabins.filter((c) => villageCabinIds.has(c.id));
        const cabinAngle = angle + (Math.random() - 0.5) * 0.5;
        const cabinDist = 60 + Math.random() * 40;
        const desiredPos = {
            x: center.x + Math.cos(cabinAngle) * cabinDist,
            y: center.y + Math.sin(cabinAngle) * cabinDist,
        };
        const cabinPos = findCabinSlot(allCabins, villageCabins, desiredPos, center);

        const neighborPositions = allCabins.map((c) => c.position);
        const newCabin: BuildingEntity = {
            id: cabinId,
            type: 'building',
            buildingType: 'cabin',
            residentIds: [npcId],
            workerIds: [],
            position: cabinPos,
            color,
            polygon: generateCabinPlot(cabinPos, neighborPositions),
        };
        allEntities.push(newCabin);
        villageCabinIds.add(cabinId);

        const refreshCabins = allEntities.filter((e): e is BuildingEntity => e.type === 'building');
        refreshNearbyPlots(refreshCabins, newCabin);

        allEntities.push({
            id: `stock-${cabinId}`,
            type: 'stock',
            cabinId,
            position: { x: cabinPos.x + 20, y: cabinPos.y + 12 },
            color,
            items: [],
        });
    }

    // Give villagers initial mutual affinity so social cohesion exists
    for (let i = 0; i < villageNpcs.length; i++) {
        for (let j = i + 1; j < villageNpcs.length; j++) {
            const a = villageNpcs[i];
            const b = villageNpcs[j];
            a.knowledge.npcs.push({ id: b.id, affinity: 0.15 + Math.random() * 0.1, greetCooldown: 0 });
            b.knowledge.npcs.push({ id: a.id, affinity: 0.15 + Math.random() * 0.1, greetCooldown: 0 });
        }
    }
}

const ZONE_COLORS: Record<string, string> = { food: '#2ecc71', water: '#00bcd4', wood: '#8B6914' };

function generateResourceCluster(
    center: { x: number; y: number },
    villageIdx: number,
    allEntities: Scene['entities'],
) {
    // 2 food zones
    for (let i = 0; i < 2; i++) {
        const angle = Math.random() * Math.PI * 2;
        const dist = 150 + Math.random() * 100;
        const radius = randRange(100, 130);
        const capacity = Math.round(randRange(4, 6));
        const zoneId = generateEntityId();
        const zone: FertileZoneEntity = {
            id: `zone-f-${villageIdx}-${zoneId}`,
            type: 'fertile_zone',
            resourceType: 'food',
            position: { x: center.x + Math.cos(angle) * dist, y: center.y + Math.sin(angle) * dist },
            radius,
            capacity,
            spawnInterval: 3,
            spawnTimer: 0,
            color: ZONE_COLORS.food,
        };
        allEntities.push(zone);
    }

    // 1 water zone
    {
        const angle = Math.random() * Math.PI * 2;
        const dist = 120 + Math.random() * 80;
        const radius = randRange(80, 100);
        const capacity = Math.round(randRange(3, 4));
        const zoneId = generateEntityId();
        const zone: FertileZoneEntity = {
            id: `zone-w-${villageIdx}-${zoneId}`,
            type: 'fertile_zone',
            resourceType: 'water',
            position: { x: center.x + Math.cos(angle) * dist, y: center.y + Math.sin(angle) * dist },
            radius,
            capacity,
            spawnInterval: 3,
            spawnTimer: 0,
            color: ZONE_COLORS.water,
        };
        allEntities.push(zone);
    }

    // 1 wood zone
    {
        const angle = Math.random() * Math.PI * 2;
        const dist = 130 + Math.random() * 100;
        const radius = randRange(90, 110);
        const capacity = Math.round(randRange(4, 5));
        const zoneId = generateEntityId();
        const zone: FertileZoneEntity = {
            id: `zone-wd-${villageIdx}-${zoneId}`,
            type: 'fertile_zone',
            resourceType: 'wood',
            position: { x: center.x + Math.cos(angle) * dist, y: center.y + Math.sin(angle) * dist },
            radius,
            capacity,
            spawnInterval: 3,
            spawnTimer: 0,
            color: ZONE_COLORS.wood,
        };
        allEntities.push(zone);
    }
}

function generateTestPlants(entities: Scene['entities'], soilGrid: import('../World/fertility').SoilGrid, heightMap: import('../World/heightmap').HeightMap, lakeMap?: LakeMap) {
    const MARGIN = 100;

    // Species configs: id, count, preferred humidity range, growth range
    const speciesSetup: { id: string; count: number; humRange: [number, number]; growthRange: [number, number] }[] = [
        // Forest — dense initial forests
        { id: 'oak', count: 120, humRange: [0.30, 0.85], growthRange: [0.5, 1.0] },
        { id: 'pine', count: 100, humRange: [0.15, 0.65], growthRange: [0.5, 1.0] },
        { id: 'birch', count: 80, humRange: [0.25, 0.75], growthRange: [0.5, 1.0] },
        { id: 'mushroom', count: 40, humRange: [0.50, 0.85], growthRange: [0.3, 0.9] },
        // Meadow
        { id: 'wheat', count: 60, humRange: [0.30, 0.70], growthRange: [0.2, 0.9] },
        { id: 'wildflower', count: 50, humRange: [0.20, 0.75], growthRange: [0.2, 0.8] },
        { id: 'thyme', count: 30, humRange: [0.08, 0.45], growthRange: [0.3, 0.9] },
        { id: 'sage', count: 25, humRange: [0.10, 0.50], growthRange: [0.3, 0.9] },
        // Wetland
        { id: 'willow', count: 30, humRange: [0.60, 1.00], growthRange: [0.5, 1.0] },
        { id: 'reed', count: 50, humRange: [0.70, 1.00], growthRange: [0.3, 0.8] },
        // Fruit trees & bushes
        { id: 'raspberry', count: 50, humRange: [0.35, 0.80], growthRange: [0.4, 1.0] },
        { id: 'apple', count: 40, humRange: [0.35, 0.75], growthRange: [0.5, 1.0] },
        { id: 'cherry', count: 35, humRange: [0.30, 0.70], growthRange: [0.5, 1.0] },
    ];

    for (const setup of speciesSetup) {
        let placed = 0;
        let attempts = 0;
        const maxAttempts = setup.count * 30;

        while (placed < setup.count && attempts < maxAttempts) {
            attempts++;
            const x = (Math.random() * 2 - 1) * (WORLD_HALF - MARGIN);
            const y = (Math.random() * 2 - 1) * (WORLD_HALF - MARGIN);

            if (getHeightAt(heightMap, x, y) < SEA_LEVEL + 3) continue;
            if (lakeMap && getWaterDepthAt(lakeMap, heightMap, x, y, 5) > 0) continue;

            const col = Math.floor((x - soilGrid.originX) / soilGrid.cellSize);
            const row = Math.floor((y - soilGrid.originY) / soilGrid.cellSize);
            if (col < 0 || col >= soilGrid.cols || row < 0 || row >= soilGrid.rows) continue;
            const hum = soilGrid.layers.humidity[row * soilGrid.cols + col];
            if (hum < setup.humRange[0] || hum > setup.humRange[1]) continue;

            // Random initial growth — some already mature for immediate fruit production
            const [gMin, gMax] = setup.growthRange;
            const growth = gMin + Math.random() * (gMax - gMin);
            const stage = growth < 0.02 ? 'seed' as const
                : growth < 0.15 ? 'sprout' as const
                    : growth < 0.85 ? 'growing' as const
                        : 'mature' as const;

            const plant: PlantEntity = {
                id: `plant-${generateEntityId()}`,
                type: 'plant',
                speciesId: setup.id,
                position: { x, y },
                growth,
                health: 100,
                age: growth * SECONDS_PER_DAY * 5, // approximate age from growth
                stage,
                seedTimer: Math.random() * SECONDS_PER_DAY * 2,
                fruitTimer: Math.random() * SECONDS_PER_DAY * 2,
                dormancyTimer: 0, // already placed, no dormancy
            };
            entities.push(plant);
            placed++;
        }
    }
}

function generateDenseForests(entities: Scene['entities'], soilGrid: import('../World/fertility').SoilGrid, heightMap: import('../World/heightmap').HeightMap, lakeMap?: LakeMap) {
    const MARGIN = 150;

    const forestDefs: { species: string[]; count: number; radius: number; treesPerForest: number; humMin: number }[] = [
        { species: ['oak', 'birch'], count: 6, radius: 80, treesPerForest: 60, humMin: 0.30 },
        { species: ['pine'], count: 5, radius: 100, treesPerForest: 70, humMin: 0.15 },
        { species: ['oak', 'pine', 'birch'], count: 4, radius: 120, treesPerForest: 80, humMin: 0.25 },
        { species: ['willow'], count: 3, radius: 50, treesPerForest: 25, humMin: 0.55 },
        { species: ['apple', 'cherry'], count: 3, radius: 60, treesPerForest: 30, humMin: 0.30 },
    ];

    for (const def of forestDefs) {
        for (let f = 0; f < def.count; f++) {
            let centerX = 0, centerY = 0, valid = false;
            for (let attempt = 0; attempt < 50; attempt++) {
                centerX = (Math.random() * 2 - 1) * (WORLD_HALF - MARGIN);
                centerY = (Math.random() * 2 - 1) * (WORLD_HALF - MARGIN);
                if (getHeightAt(heightMap, centerX, centerY) < SEA_LEVEL + 5) continue;
                if (lakeMap && getWaterDepthAt(lakeMap, heightMap, centerX, centerY, 10) > 0) continue;
                const col = Math.floor((centerX - soilGrid.originX) / soilGrid.cellSize);
                const row = Math.floor((centerY - soilGrid.originY) / soilGrid.cellSize);
                if (col < 0 || col >= soilGrid.cols || row < 0 || row >= soilGrid.rows) continue;
                const hum = soilGrid.layers.humidity[row * soilGrid.cols + col];
                if (hum < def.humMin) continue;
                valid = true;
                break;
            }
            if (!valid) continue;

            for (let t = 0; t < def.treesPerForest; t++) {
                const angle = Math.random() * Math.PI * 2;
                const dist = Math.sqrt(Math.random()) * def.radius;
                const tx = centerX + Math.cos(angle) * dist;
                const ty = centerY + Math.sin(angle) * dist;

                if (tx < -WORLD_HALF + 50 || tx > WORLD_HALF - 50) continue;
                if (ty < -WORLD_HALF + 50 || ty > WORLD_HALF - 50) continue;
                if (getHeightAt(heightMap, tx, ty) < SEA_LEVEL + 3) continue;
                if (lakeMap && getWaterDepthAt(lakeMap, heightMap, tx, ty, 5) > 0) continue;

                const speciesId = def.species[Math.floor(Math.random() * def.species.length)];
                const growth = 0.7 + Math.random() * 0.3;

                const plant: PlantEntity = {
                    id: `plant-${generateEntityId()}`,
                    type: 'plant',
                    speciesId,
                    position: { x: tx, y: ty },
                    growth,
                    health: 100,
                    age: growth * SECONDS_PER_DAY * 8,
                    stage: growth >= 0.85 ? 'mature' : 'growing',
                    seedTimer: Math.random() * SECONDS_PER_DAY * 2,
                    fruitTimer: Math.random() * SECONDS_PER_DAY * 2,
                    dormancyTimer: 0,
                };
                entities.push(plant);
            }
        }
    }
}

function generateInitialAnimals(entities: Scene['entities'], heightMap: import('../World/heightmap').HeightMap) {
    const MARGIN = 100;
    const animalSetup: { id: 'rabbit' | 'deer' | 'fox' | 'wolf'; count: number }[] = [
        { id: 'rabbit', count: 40 },
        { id: 'deer', count: 20 },
        { id: 'fox', count: 8 },
        { id: 'wolf', count: 5 },
    ];

    for (const setup of animalSetup) {
        let placed = 0;
        let attempts = 0;
        const maxAttempts = setup.count * 30;

        while (placed < setup.count && attempts < maxAttempts) {
            attempts++;
            const x = (Math.random() * 2 - 1) * (WORLD_HALF - MARGIN);
            const y = (Math.random() * 2 - 1) * (WORLD_HALF - MARGIN);
            if (getHeightAt(heightMap, x, y) < SEA_LEVEL + 3) continue;

            const growth = 0.5 + Math.random() * 0.5;
            const animal: AnimalEntity = {
                id: `animal-${generateEntityId()}`,
                type: 'animal',
                speciesId: setup.id,
                position: { x, y },
                targetPos: null,
                heading: Math.random() * Math.PI * 2,
                speed: 0,
                health: 100,
                hunger: Math.random() * 0.3,
                age: growth * SECONDS_PER_DAY * 10,
                growth,
                reproTimer: SECONDS_PER_DAY * (2 + Math.random() * 5),
                idleTimer: SECONDS_PER_DAY * (0.5 + Math.random() * 2),
                mateTargetId: null,
                sex: Math.random() < 0.5 ? 'male' : 'female',
                state: 'idle',
                pendingSignals: [],
                alertLevel: 0,
            };
            entities.push(animal);
            placed++;
        }
    }
}

function createInitialScene(): Scene {
    const entities: Scene['entities'] = [];

    // --- NPC generation disabled for flora development ---
    // for (let v = 0; v < VILLAGE_CENTERS.length; v++) {
    //     const npcCount = 6 + Math.floor(Math.random() * 3);
    //     generateVillage(VILLAGE_CENTERS[v], npcCount, v, entities);
    //     generateResourceCluster(VILLAGE_CENTERS[v], v, entities);
    // }

    const HEIGHTMAP_CELL = 12;
    const SOIL_CELL = 32;
    const heightMap = createHeightMap(
        -WORLD_HALF, -WORLD_HALF,
        WORLD_HALF * 2, WORLD_HALF * 2,
        HEIGHTMAP_CELL,
        150,
        77,
    );
    const soilGrid = createSoilGrid(
        -WORLD_HALF, -WORLD_HALF,
        WORLD_HALF * 2, WORLD_HALF * 2,
        SOIL_CELL,
        42,
        heightMap,
    );
    const basinMap = createBasinMap(heightMap);
    const depressionMap = createDepressionMap(heightMap);
    const lakeMap = generateLakes(heightMap, depressionMap);

    // Scatter initial plants across the map
    generateTestPlants(entities, soilGrid, heightMap, lakeMap);

    // Dense forest clusters
    generateDenseForests(entities, soilGrid, heightMap, lakeMap);

    // Spawn raspberry bushes near player start (0,0) for testing
    for (let i = 0; i < 6; i++) {
        const angle = (i / 6) * Math.PI * 2;
        const dist = 15 + Math.random() * 20;
        const rx = Math.cos(angle) * dist;
        const ry = Math.sin(angle) * dist;
        entities.push({
            id: `plant-${generateEntityId()}`,
            type: 'plant',
            speciesId: 'raspberry',
            position: { x: rx, y: ry },
            growth: 1.0,
            health: 100,
            age: SECONDS_PER_DAY * 10,
            stage: 'mature',
            seedTimer: SECONDS_PER_DAY,
            fruitTimer: 0.1,
            dormancyTimer: 0,
        });
    }

    generateInitialAnimals(entities, heightMap);

    const weather = createWeatherState();
    const scene: Scene = { entities, time: 8 * SECONDS_PER_HOUR, soilGrid, heightMap, basinMap, depressionMap, lakeMap, weather, lakesEnabled: true, signals: [] };

    // initFactions(scene, VILLAGE_CENTERS); // disabled while testing flora

    return scene;
}

// UI snapshot — updated periodically from the game loop, consumed during render
type UISnapshot = {
    npcs: NPCEntity[];
    corpses: CorpseEntity[];
    calendar: Calendar;
    weatherType: import('../World/weather').WeatherType | null;
    rainIntensity: number;
};

const INITIAL_SCENE = createInitialScene();

export const Game = () => {
    const containerRef = useRef<HTMLDivElement>(null);
    const rendererRef = useRef<GameRenderer | null>(null);
    const ambianceRef = useRef<AmbianceManager | null>(null);
    const musicRef = useRef<MusicManager | null>(null);
    const sceneRef = useRef<Scene>(INITIAL_SCENE);
    const cameraRef = useRef<Camera>({ position: { x: 0, y: 0 } });
    const uiAccRef = useRef(0);
    const highlightRef = useRef<Highlight>(null);
    const factionAccRef = useRef(0);

    // State for UI (no refs read during render)
    const [speed, setSpeed] = useState(0.1);
    const speedRef = useRef(1);
    const [focusedNpcId, setFocusedNpcId] = useState<string | null>(null);
    const focusedNpcIdRef = useRef<string | null>(null);
    const [activeRendererId, setActiveRendererId] = useState('canvas2d');
    const [soilOverlay, setSoilOverlay] = useState<SoilOverlay>(null);
    const [weatherDropdown, setWeatherDropdown] = useState(false);
    const [weatherOverride, setWeatherOverride] = useState<WeatherType | null>(null);
    const [lakesEnabled, setLakesEnabled] = useState(true);
    const [thirdPerson, setThirdPerson] = useState(false);
    const [ui, setUi] = useState<UISnapshot>(() => ({
        npcs: INITIAL_SCENE.entities.filter((e): e is NPCEntity => e.type === 'npc'),
        corpses: [],
        calendar: getCalendar(INITIAL_SCENE.time),
        weatherType: INITIAL_SCENE.weather?.current ?? null,
        rainIntensity: 0,
    }));

    // Sync state → refs for game loop access (outside of render)
    useEffect(() => { speedRef.current = speed; }, [speed]);
    useEffect(() => { focusedNpcIdRef.current = focusedNpcId; }, [focusedNpcId]);

    // --- Renderer lifecycle ---
    const initRenderer = useCallback((rendererId: string) => {
        const container = containerRef.current;
        if (!container) return;

        // Destroy previous renderer
        if (rendererRef.current) {
            rendererRef.current.destroy();
            rendererRef.current = null;
        }

        // Create and init new renderer
        const renderer = createRenderer(rendererId);
        if (!renderer) {
            console.error(`Renderer "${rendererId}" not found. Available: ${getAvailableRenderers().join(', ')}`);
            return;
        }

        renderer.init(container);
        rendererRef.current = renderer;

        if (!ambianceRef.current) {
            ambianceRef.current = new AmbianceManager();
        }

        if (!musicRef.current) {
            musicRef.current = new MusicManager();
        }

        const startAmbiance = () => {
            ambianceRef.current?.start();
            document.removeEventListener('click', startAmbiance);
            document.removeEventListener('keydown', startAmbiance);
        };
        document.addEventListener('click', startAmbiance, { once: true });
        document.addEventListener('keydown', startAmbiance, { once: true });

        // Initial resize
        const rect = container.getBoundingClientRect();
        renderer.resize(rect.width, rect.height);
    }, []);

    // Init renderer on mount
    useEffect(() => {
        initRenderer(activeRendererId);
        return () => {
            rendererRef.current?.destroy();
            rendererRef.current = null;
            ambianceRef.current?.destroy();
            ambianceRef.current = null;
            musicRef.current?.destroy();
            musicRef.current = null;
        };
    }, []);

    // Switch renderer when activeRendererId changes
    useEffect(() => {
        if (rendererRef.current?.id !== activeRendererId) {
            initRenderer(activeRendererId);
        }

        if (musicRef.current) {
            musicRef.current.setEnabled(activeRendererId === 'three3d');
        }
    }, [activeRendererId, initRenderer]);

    // Handle container resize
    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const observer = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const { width, height } = entry.contentRect;
                rendererRef.current?.resize(width, height);
            }
        });
        observer.observe(container);
        return () => observer.disconnect();
    }, []);

    useGameLoop((dt) => {
        const simDt = dt * speedRef.current;

        processWorld(sceneRef.current, simDt);
        processAI(sceneRef.current, simDt);
        processEvents(sceneRef.current, simDt);

        // Update factions every ~30 sim-seconds
        factionAccRef.current += simDt;
        if (factionAccRef.current >= 30) {
            factionAccRef.current = 0;
            updateFactionStats(sceneRef.current);
            checkFactionConflicts(sceneRef.current);
        }

        // Follow focused NPC
        const fid = focusedNpcIdRef.current;
        if (fid) {
            const npc = sceneRef.current.entities.find(
                (e): e is NPCEntity => e.id === fid && e.type === 'npc'
            );
            if (npc) {
                cameraRef.current.position.x = -npc.position.x;
                cameraRef.current.position.y = -npc.position.y;
            }
        }

        uiAccRef.current += dt; // UI update stays real-time
        if (uiAccRef.current >= UI_UPDATE_INTERVAL) {
            uiAccRef.current = 0;
            const entities = sceneRef.current.entities;
            setUi({
                npcs: entities.filter((e): e is NPCEntity => e.type === 'npc'),
                corpses: entities.filter((e): e is CorpseEntity => e.type === 'corpse'),
                calendar: getCalendar(sceneRef.current.time),
                weatherType: sceneRef.current.weather?.current ?? null,
                rainIntensity: sceneRef.current.weather?.rainIntensity ?? 0,
            });
        }

        ambianceRef.current?.update(sceneRef.current, dt);
        musicRef.current?.update(dt);

        // Render via the pluggable renderer
        rendererRef.current?.render(sceneRef.current, cameraRef.current, highlightRef.current, soilOverlay);
    }, true);

    const { npcs, corpses, calendar, weatherType, rainIntensity } = ui;

    const focusedNpc = focusedNpcId
        ? npcs.find((n) => n.id === focusedNpcId) ?? null
        : null;

    const availableRenderers = getAvailableRenderers();

    return (
        <div {...className('Game')}>
            <div
                ref={containerRef}
                {...className('RendererContainer')}
                onContextMenu={(e) => e.preventDefault()}
                onPointerDown={(e) => {
                    // Only handle camera drag in 2D mode
                    if (activeRendererId === 'three3d') return;
                    if (e.button !== 1) return;
                    if (focusedNpcIdRef.current) return; // Disable drag when following NPC

                    e.preventDefault();
                    e.stopPropagation();

                    const initialCameraPosition = { ...cameraRef.current.position };
                    const startX = e.clientX;
                    const startY = e.clientY;

                    function handleMove(ev: PointerEvent) {
                        cameraRef.current.position.x = initialCameraPosition.x + (ev.clientX - startX);
                        cameraRef.current.position.y = initialCameraPosition.y + (ev.clientY - startY);
                    }
                    function handleEnd() {
                        window.removeEventListener('pointermove', handleMove);
                        window.removeEventListener('pointerup', handleEnd);
                        window.removeEventListener('pointercancel', handleEnd);
                    }

                    window.addEventListener('pointermove', handleMove);
                    window.addEventListener('pointerup', handleEnd);
                    window.addEventListener('pointercancel', handleEnd);
                }}
            />

            {/* Left panel: focused NPC details */}
            {focusedNpc && (
                <div {...className('FocusPanel')}>
                    <div {...className('FocusPanelHeader')}>
                        <span
                            {...className('InventoryDot')}
                            style={{ backgroundColor: focusedNpc.color }}
                        />
                        <span {...className('FocusPanelName')}>{focusedNpc.name}</span>
                        <span {...className('InventorySex')}>
                            {focusedNpc.sex === 'male' ? '\u2642' : '\u2640'}
                        </span>
                        <span {...className('InventoryAge')}>
                            {Math.floor(focusedNpc.age)}a ({getLifeStage(focusedNpc.age)})
                        </span>
                        <button
                            {...className('FocusPanelClose')}
                            onClick={() => setFocusedNpcId(null)}
                        >
                            X
                        </button>
                    </div>
                    <NpcDetailPanel npc={focusedNpc} allNpcs={npcs} onHighlight={(h) => { highlightRef.current = h; }} />
                </div>
            )}

            <div {...className('StatsBar')}>
                <span {...className('StatItem', 'CalendarInfo')}>
                    An {calendar.year} — {calendar.season}, Jour {calendar.dayOfSeason} — {calendar.hour}h ({calendar.timeLabel})
                </span>
                {weatherType && (
                    <div {...className('WeatherPicker')}>
                        <div
                            {...className('WeatherCurrent')}
                            onClick={() => setWeatherDropdown((v) => !v)}
                        >
                            <span {...className('WeatherIcon')}>{WEATHER_ICONS[weatherType]}</span>
                            {WEATHER_LABELS[weatherType]}
                            {weatherOverride !== null && <span {...className('RainBadge')}>forcé</span>}
                            {rainIntensity > 0 && <span {...className('RainBadge')}>{Math.round(rainIntensity * 100)}%</span>}
                            <span style={{ opacity: 0.4, fontSize: 9 }}>▼</span>
                        </div>
                        {weatherDropdown && (
                            <div {...className('WeatherDropdown')}>
                                <button
                                    {...className('WeatherOption', { active: weatherOverride === null })}
                                    onClick={() => {
                                        setWeatherOverride(null);
                                        if (sceneRef.current.weather) sceneRef.current.weather.override = null;
                                        setWeatherDropdown(false);
                                    }}
                                >
                                    🔄 Auto
                                </button>
                                {WEATHER_TYPES.map((w: WeatherType) => (
                                    <button
                                        key={w}
                                        {...className('WeatherOption', { active: weatherOverride === w })}
                                        onClick={() => {
                                            setWeatherOverride(w);
                                            if (sceneRef.current.weather) sceneRef.current.weather.override = w;
                                            setWeatherDropdown(false);
                                        }}
                                    >
                                        <span {...className('WeatherIcon')}>{WEATHER_ICONS[w]}</span>
                                        {WEATHER_LABELS[w]}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                )}
                <button
                    {...className('LakeToggle', { active: lakesEnabled })}
                    onClick={() => {
                        const next = !lakesEnabled;
                        setLakesEnabled(next);
                        sceneRef.current.lakesEnabled = next;
                    }}
                    title={lakesEnabled ? 'Désactiver les lacs' : 'Activer les lacs'}
                >
                    💧 Lacs {lakesEnabled ? 'ON' : 'OFF'}
                </button>
                <span {...className('StatItem')}>Vivants: {npcs.length}</span>
                <span {...className('StatItem')}>Morts: {corpses.length}</span>
                <div {...className('SpeedControls')}>
                    {[0.1, 0.25, 0.5, 1, 5, 10, 20, 50, 100].map((s) => (
                        <button
                            key={s}
                            {...className('SpeedBtn', { active: speed === s })}
                            onClick={() => setSpeed(s)}
                        >
                            x{s}
                        </button>
                    ))}
                </div>
            </div>

            {/* Renderer toggle button — bottom center */}
            {availableRenderers.length > 1 && (
                <div {...className('RendererToggle')}>
                    <button
                        {...className('RendererToggleBtn')}
                        onClick={() => {
                            const idx = availableRenderers.indexOf(activeRendererId);
                            const next = availableRenderers[(idx + 1) % availableRenderers.length];
                            setActiveRendererId(next);
                            setThirdPerson(false); // reset on renderer switch
                        }}
                    >
                        {activeRendererId === 'three3d' ? '🎮 3D' : '🗺️ 2D'}
                        <span {...className('RendererToggleHint')}>
                            → {activeRendererId === 'three3d' ? '2D' : '3D'}
                        </span>
                    </button>
                    {activeRendererId === 'three3d' && (
                        <button
                            {...className('RendererToggleBtn', { active: thirdPerson })}
                            onClick={() => {
                                const r = rendererRef.current;
                                if (r?.setThirdPerson) {
                                    const next = r.setThirdPerson(!thirdPerson);
                                    setThirdPerson(next);
                                }
                            }}
                        >
                            🏃 {thirdPerson ? '3P ON' : '3P OFF'}
                        </button>
                    )}
                </div>
            )}

            {/* Soil layer picker — bottom left */}
            <div {...className('SoilLayerPicker')}>
                <button
                    {...className('SoilLayerBtn', { active: soilOverlay === null })}
                    onClick={() => setSoilOverlay(null)}
                >
                    Aucun
                </button>
                {SOIL_PROPERTIES.map((prop) => (
                    <button
                        key={prop}
                        {...className('SoilLayerBtn', { active: soilOverlay === prop })}
                        onClick={() => setSoilOverlay(soilOverlay === prop ? null : prop)}
                    >
                        {SOIL_LAYER_LABELS[prop]}
                    </button>
                ))}
                <button
                    {...className('SoilLayerBtn', { active: soilOverlay === 'elevation' })}
                    onClick={() => setSoilOverlay(soilOverlay === 'elevation' ? null : 'elevation')}
                >
                    Élévation
                </button>
                <button
                    {...className('SoilLayerBtn', { active: soilOverlay === 'basin' })}
                    onClick={() => setSoilOverlay(soilOverlay === 'basin' ? null : 'basin')}
                >
                    Bassins
                </button>
                <button
                    {...className('SoilLayerBtn', { active: soilOverlay === 'water' })}
                    onClick={() => setSoilOverlay(soilOverlay === 'water' ? null : 'water')}
                >
                    Eau
                </button>
                <button
                    {...className('SoilLayerBtn', { active: soilOverlay === 'soilType' })}
                    onClick={() => setSoilOverlay(soilOverlay === 'soilType' ? null : 'soilType')}
                >
                    Geologie
                </button>
            </div>

            <div {...className('InventoryPanel')}>
                {npcs.map((npc) => {
                    const isFocused = focusedNpcId === npc.id;

                    return (
                        <div
                            key={npc.id}
                            {...className('InventoryCard', { focused: isFocused })}
                            onClick={() => setFocusedNpcId(isFocused ? null : npc.id)}
                        >
                            <div {...className('InventoryHeader')}>
                                <span
                                    {...className('InventoryDot')}
                                    style={{ backgroundColor: npc.color }}
                                />
                                <span>{npc.name}</span>
                                <span {...className('InventorySex')}>
                                    {npc.sex === 'male' ? '\u2642' : '\u2640'}
                                </span>
                                <span {...className('InventoryAge')}>
                                    {Math.floor(npc.age)}a ({getLifeStage(npc.age)})
                                </span>
                                {npc.job && (
                                    <span {...className('InventoryJob')}>{npc.job}</span>
                                )}
                                <span {...className('InventoryState')}>{npc.ai.state}</span>
                            </div>

                            <div {...className('NeedsSection')}>
                                <NeedBar label="HP" value={npc.needs.health} color="#e74c3c" />
                                <NeedBar label="Faim" value={npc.needs.hunger} color="#f39c12" />
                                <NeedBar label="Rés. F" value={npc.needs.hungerReserve} color="#e67e22" />
                                <NeedBar label="Soif" value={npc.needs.thirst} color="#00bcd4" />
                                <NeedBar label="Rés. S" value={npc.needs.thirstReserve} color="#0277bd" />
                                <NeedBar label="Energie" value={npc.needs.energy} color="#f1c40f" />
                                <NeedBar label="Bonheur" value={npc.needs.happiness} color="#e91e63" />
                            </div>

                            {npc.sex === 'male' && npc.reproduction.desire > 0 && (
                                <div {...className('ReproInfo')}>
                                    <span {...className('ReproLabel')}>Envie</span>
                                    <div {...className('NeedBarTrack')}>
                                        <div
                                            {...className('NeedBarFill')}
                                            style={{
                                                width: `${Math.min(100, npc.reproduction.desire)}%`,
                                                backgroundColor: '#ff69b4',
                                            }}
                                        />
                                    </div>
                                    <span {...className('NeedBarValue')}>{Math.round(npc.reproduction.desire)}</span>
                                </div>
                            )}

                            {npc.sex === 'female' && npc.reproduction.gestation && (
                                <div {...className('ReproInfo')}>
                                    <span {...className('ReproLabel')}>Enceinte</span>
                                    <span {...className('ReproValue')}>
                                        {Math.ceil(npc.reproduction.gestation.remaining)}s
                                    </span>
                                </div>
                            )}

                            {npc.sex === 'female' && npc.reproduction.cooldown > 0 && !npc.reproduction.gestation && (
                                <div {...className('ReproInfo')}>
                                    <span {...className('ReproLabel')}>Cooldown</span>
                                    <span {...className('ReproValue')}>
                                        {Math.ceil(npc.reproduction.cooldown)}s
                                    </span>
                                </div>
                            )}

                            <div {...className('InventorySection')}>
                                <span {...className('InventoryLabel')}>inventaire</span>
                                <div {...className('InventoryItems')}>
                                    {npc.inventory.length === 0 ? (
                                        <span {...className('InventoryEmpty')}>vide</span>
                                    ) : (
                                        npc.inventory.map((stack, idx) => {
                                            const def = getItemDef(stack.itemId);
                                            return (
                                                <span
                                                    key={`${stack.itemId}-${idx}`}
                                                    {...className('InventoryItemDot')}
                                                    style={{ backgroundColor: def?.color ?? '#888' }}
                                                    title={`${def?.displayName ?? stack.itemId} x${stack.quantity}`}
                                                />
                                            );
                                        })
                                    )}
                                </div>
                            </div>

                        </div>
                    );
                })}
            </div>
        </div>
    );
};

// --- UI Components ---

function NeedBar({ label, value, color }: { label: string; value: number; color: string }) {
    const className = classNameModule(styles);

    return (
        <div {...className('NeedBar')}>
            <span {...className('NeedBarLabel')}>{label}</span>
            <div {...className('NeedBarTrack')}>
                <div
                    {...className('NeedBarFill')}
                    style={{
                        width: `${Math.max(0, Math.min(100, value))}%`,
                        backgroundColor: color,
                    }}
                />
            </div>
            <span {...className('NeedBarValue')}>{Math.round(value)}</span>
        </div>
    );
}

function NpcDetailPanel({ npc, allNpcs, onHighlight }: {
    npc: NPCEntity;
    allNpcs: NPCEntity[];
    onHighlight: (h: Highlight) => void;
}) {
    const cn = classNameModule(styles);

    const knownNpcs = npc.knowledge.npcs
        .filter((k) => k.affinity > 0)
        .sort((a, b) => b.affinity - a.affinity);

    const knownZones = npc.knowledge.locations
        .filter((z) => z.confidence > 0)
        .sort((a, b) => b.confidence - a.confidence);

    const relations = npc.knowledge.relations;

    const zoneColor = (rt: string) => rt === 'food' ? '#2ecc71' : rt === 'wood' ? '#8B6914' : '#00bcd4';
    const hoverNpc = (id: string) => ({ onMouseEnter: () => onHighlight({ type: 'npc', id }), onMouseLeave: () => onHighlight(null) });
    const hoverZone = (zone: KnownZone) => ({
        onMouseEnter: () => onHighlight({ type: 'zone', position: zone.position, resourceType: zone.resourceType }),
        onMouseLeave: () => onHighlight(null),
    });

    return (
        <div {...cn('DetailPanel')}>
            {/* Traits */}
            <div {...cn('DetailSection')}>
                <div {...cn('DetailSectionTitle')}>Traits</div>
                <div {...cn('TraitGrid')}>
                    <TraitItem label="Vitesse" value={npc.traits.speed} />
                    <TraitItem label="Vision" value={npc.traits.visionRange} />
                    <TraitItem label="Exploration" value={npc.traits.explorationRange} />
                    <TraitItem label="Charisme" value={npc.traits.charisma} max={1} />
                    <TraitItem label="Intelligence" value={npc.traits.intelligence} max={1} />
                    <TraitItem label="Courage" value={npc.traits.courage} max={1} />
                    <TraitItem label="Agressivité" value={npc.traits.aggressiveness} max={1} />
                </div>
            </div>

            {/* Relations */}
            {relations.length > 0 && (
                <div {...cn('DetailSection')}>
                    <div {...cn('DetailSectionTitle')}>Relations ({relations.length})</div>
                    {relations.map((rel, i) => {
                        const target = allNpcs.find((n) => n.id === rel.targetId);
                        return (
                            <div key={i} {...cn('RelationRow', 'hoverable')} {...hoverNpc(rel.targetId)}>
                                <span {...cn('RelationIcon')} style={{ color: target?.color ?? '#888' }}>
                                    {target ? '\u25CF' : '\u25CB'}
                                </span>
                                <span {...cn('RelationName')}>{target?.name ?? '???'}</span>
                                <span {...cn('RelationType')}>{rel.type}</span>
                            </div>
                        );
                    })}
                </div>
            )}

            {/* Affinités (known NPCs) */}
            <div {...cn('DetailSection')}>
                <div {...cn('DetailSectionTitle')}>Affinités ({knownNpcs.length})</div>
                {knownNpcs.length === 0 ? (
                    <span {...cn('DetailEmpty')}>aucune</span>
                ) : (
                    knownNpcs.map((known) => {
                        const target = allNpcs.find((n) => n.id === known.id);
                        return (
                            <div key={known.id} {...cn('AffinityRow', 'hoverable')} {...hoverNpc(known.id)}>
                                <span {...cn('AffinityDot')} style={{ backgroundColor: target?.color ?? '#888' }} />
                                <span {...cn('AffinityName')}>{target?.name ?? `#${known.id}`}</span>
                                <div {...cn('AffinityBarTrack')}>
                                    <div
                                        {...cn('AffinityBarFill')}
                                        style={{ width: `${known.affinity * 100}%` }}
                                    />
                                </div>
                                <span {...cn('AffinityValue')}>{(known.affinity * 100).toFixed(0)}</span>
                            </div>
                        );
                    })
                )}
            </div>

            {/* Terrain knowledge (known zones) */}
            <div {...cn('DetailSection')}>
                <div {...cn('DetailSectionTitle')}>Zones connues ({knownZones.length})</div>
                {knownZones.length === 0 ? (
                    <span {...cn('DetailEmpty')}>aucune</span>
                ) : (
                    knownZones.map((zone, i) => (
                        <div key={i} {...cn('ZoneRow', 'hoverable')} {...hoverZone(zone)}>
                            <span
                                {...cn('ZoneDot')}
                                style={{ backgroundColor: zoneColor(zone.resourceType) }}
                            />
                            <span {...cn('ZoneType')}>{zone.resourceType}</span>
                            <span {...cn('ZoneSource')}>{zone.source === 'firsthand' ? '\uD83D\uDC41' : '\uD83D\uDDE3'}</span>
                            <div {...cn('AffinityBarTrack')}>
                                <div
                                    {...cn('AffinityBarFill')}
                                    style={{
                                        width: `${zone.confidence * 100}%`,
                                        backgroundColor: zoneColor(zone.resourceType),
                                    }}
                                />
                            </div>
                            <span {...cn('AffinityValue')}>{(zone.confidence * 100).toFixed(0)}</span>
                        </div>
                    ))
                )}
            </div>

            {/* Action history */}
            <div {...cn('DetailSection')}>
                <div {...cn('DetailSectionTitle')}>Historique ({npc.actionHistory.length})</div>
                {npc.actionHistory.length === 0 ? (
                    <span {...cn('DetailEmpty')}>aucune action</span>
                ) : (
                    <div {...cn('HistoryList')}>
                        {npc.actionHistory.map((entry, i) => (
                            <div key={i} {...cn('HistoryRow', { latest: i === 0 })}>
                                <span {...cn('HistoryIcon')}>{entry.icon}</span>
                                <span {...cn('HistoryText')}>{entry.action}</span>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

function TraitItem({ label, value, max }: { label: string; value: number; max?: number }) {
    const cn = classNameModule(styles);
    const display = max ? `${(value * 100).toFixed(0)}%` : Math.round(value).toString();

    return (
        <div {...cn('TraitItem')}>
            <span {...cn('TraitLabel')}>{label}</span>
            <span {...cn('TraitValue')}>{display}</span>
        </div>
    );
}
