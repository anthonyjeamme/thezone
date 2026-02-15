import {
    SECONDS_PER_DAY, WORLD_HALF, isInWorldBounds, getCalendar,
    type AnimalEntity, type AnimalSpeciesId, type PlantEntity, type Scene,
} from './types';
import { getHeightAt, SEA_LEVEL } from './heightmap';
import type { SoilGrid } from './fertility';
import { generateEntityId } from '../Shared/ids';

const DAYS = (d: number) => d * SECONDS_PER_DAY;

export type AnimalSpecies = {
    id: AnimalSpeciesId;
    displayName: string;
    color: string;
    size: number;
    speed: number;
    maxAge: number;
    growthDays: number;
    hungerRate: number;
    foodValue: number;
    diet: 'herbivore' | 'carnivore' | 'omnivore';
    reproInterval: number;
    litterSize: [number, number];
    fleeFrom: AnimalSpeciesId[];
    preyOn: AnimalSpeciesId[];
    wanderRadius: number;
    detectRadius: number;
    nocturnal: boolean;
    social: number;
    groupRadius: number;
};

const speciesRegistry = new Map<AnimalSpeciesId, AnimalSpecies>();

function registerAnimal(spec: AnimalSpecies) {
    speciesRegistry.set(spec.id, spec);
}

export function getAnimalSpecies(id: string): AnimalSpecies | undefined {
    return speciesRegistry.get(id as AnimalSpeciesId);
}

registerAnimal({
    id: 'rabbit',
    displayName: 'Lapin',
    color: '#a08060',
    size: 3,
    speed: 6,
    maxAge: DAYS(90),
    growthDays: 8,
    hungerRate: 0.15,
    foodValue: 0.35,
    diet: 'herbivore',
    reproInterval: DAYS(6),
    litterSize: [2, 4],
    fleeFrom: ['wolf', 'fox'],
    preyOn: [],
    wanderRadius: 30,
    detectRadius: 50,
    nocturnal: false,
    social: 0.2,
    groupRadius: 40,
});

registerAnimal({
    id: 'deer',
    displayName: 'Cerf',
    color: '#8b6c42',
    size: 10,
    speed: 5,
    maxAge: DAYS(300),
    growthDays: 25,
    hungerRate: 0.10,
    foodValue: 0.25,
    diet: 'herbivore',
    reproInterval: DAYS(20),
    litterSize: [1, 2],
    fleeFrom: ['wolf'],
    preyOn: [],
    wanderRadius: 50,
    detectRadius: 80,
    nocturnal: false,
    social: 0.8,
    groupRadius: 60,
});

registerAnimal({
    id: 'fox',
    displayName: 'Renard',
    color: '#c45a20',
    size: 5,
    speed: 7,
    maxAge: DAYS(180),
    growthDays: 15,
    hungerRate: 0.12,
    foodValue: 0.45,
    diet: 'omnivore',
    reproInterval: DAYS(15),
    litterSize: [1, 3],
    fleeFrom: ['wolf'],
    preyOn: ['rabbit'],
    wanderRadius: 40,
    detectRadius: 60,
    nocturnal: true,
    social: 0.1,
    groupRadius: 30,
});

registerAnimal({
    id: 'wolf',
    displayName: 'Loup',
    color: '#555566',
    size: 8,
    speed: 6,
    maxAge: DAYS(250),
    growthDays: 20,
    hungerRate: 0.08,
    foodValue: 0.50,
    diet: 'carnivore',
    reproInterval: DAYS(25),
    litterSize: [1, 3],
    fleeFrom: [],
    preyOn: ['rabbit', 'deer'],
    wanderRadius: 60,
    detectRadius: 90,
    nocturnal: false,
    social: 0.7,
    groupRadius: 50,
});

function clampToWorld(x: number, y: number): { x: number; y: number } {
    const margin = 50;
    return {
        x: Math.max(-WORLD_HALF + margin, Math.min(WORLD_HALF - margin, x)),
        y: Math.max(-WORLD_HALF + margin, Math.min(WORLD_HALF - margin, y)),
    };
}

function dist2(a: { x: number; y: number }, b: { x: number; y: number }): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return dx * dx + dy * dy;
}

function findNearestPlant(scene: Scene, pos: { x: number; y: number }, radius: number): PlantEntity | null {
    let best: PlantEntity | null = null;
    let bestD2 = radius * radius;
    for (const e of scene.entities) {
        if (e.type !== 'plant') continue;
        if (e.health <= 0 || e.growth < 0.2) continue;
        const d2 = dist2(pos, e.position);
        if (d2 < bestD2) {
            bestD2 = d2;
            best = e as PlantEntity;
        }
    }
    return best;
}

function findNearestPrey(scene: Scene, pos: { x: number; y: number }, radius: number, preyIds: AnimalSpeciesId[]): AnimalEntity | null {
    if (preyIds.length === 0) return null;
    let best: AnimalEntity | null = null;
    let bestD2 = radius * radius;
    for (const e of scene.entities) {
        if (e.type !== 'animal') continue;
        const a = e as AnimalEntity;
        if (a.state === 'dead' || a.health <= 0) continue;
        if (!preyIds.includes(a.speciesId)) continue;
        const d2 = dist2(pos, a.position);
        if (d2 < bestD2) {
            bestD2 = d2;
            best = a;
        }
    }
    return best;
}

function findMate(scene: Scene, animal: AnimalEntity, radius: number): AnimalEntity | null {
    let best: AnimalEntity | null = null;
    let bestD2 = radius * radius;
    for (const e of scene.entities) {
        if (e.type !== 'animal') continue;
        const a = e as AnimalEntity;
        if (a.id === animal.id) continue;
        if (a.speciesId !== animal.speciesId) continue;
        if (a.sex === animal.sex) continue;
        if (a.state === 'dead' || a.health <= 0) continue;
        if (a.growth < 0.8 || a.hunger > 0.6) continue;
        const d2 = dist2(animal.position, a.position);
        if (d2 < bestD2) {
            bestD2 = d2;
            best = a;
        }
    }
    return best;
}

function findThreat(scene: Scene, animal: AnimalEntity, species: AnimalSpecies): AnimalEntity | null {
    if (species.fleeFrom.length === 0) return null;
    let best: AnimalEntity | null = null;
    let bestD2 = species.detectRadius * species.detectRadius;
    for (const e of scene.entities) {
        if (e.type !== 'animal') continue;
        const a = e as AnimalEntity;
        if (a.state === 'dead' || a.health <= 0) continue;
        if (!species.fleeFrom.includes(a.speciesId)) continue;
        const d2 = dist2(animal.position, a.position);
        if (d2 < bestD2) {
            bestD2 = d2;
            best = a;
        }
    }
    return best;
}

function getHumidityAt(soilGrid: SoilGrid, x: number, y: number): number {
    const col = Math.floor((x - soilGrid.originX) / soilGrid.cellSize);
    const row = Math.floor((y - soilGrid.originY) / soilGrid.cellSize);
    if (col < 0 || col >= soilGrid.cols || row < 0 || row >= soilGrid.rows) return 0;
    return soilGrid.layers.humidity[row * soilGrid.cols + col];
}

function isGrassySpot(soilGrid: SoilGrid | undefined, x: number, y: number): boolean {
    if (!soilGrid) return true;
    return getHumidityAt(soilGrid, x, y) > 0.2;
}

function pickGrazeTarget(pos: { x: number; y: number }, radius: number, heightMap: NonNullable<Scene['heightMap']>, soilGrid?: SoilGrid): { x: number; y: number } | null {
    for (let i = 0; i < 15; i++) {
        const angle = Math.random() * Math.PI * 2;
        const d = (0.2 + Math.random() * 0.8) * radius;
        const tx = pos.x + Math.cos(angle) * d;
        const ty = pos.y + Math.sin(angle) * d;
        if (!isInWorldBounds(tx, ty)) continue;
        const h = getHeightAt(heightMap, tx, ty);
        if (h < SEA_LEVEL + 2) continue;
        if (soilGrid && !isGrassySpot(soilGrid, tx, ty)) continue;
        return clampToWorld(tx, ty);
    }
    return null;
}

function findGroupCenter(scene: Scene, animal: AnimalEntity, species: AnimalSpecies): { x: number; y: number; count: number } {
    let sx = 0, sy = 0, count = 0;
    const r2 = species.groupRadius * species.groupRadius;
    for (const e of scene.entities) {
        if (e.type !== 'animal') continue;
        const a = e as AnimalEntity;
        if (a.id === animal.id) continue;
        if (a.speciesId !== animal.speciesId) continue;
        if (a.state === 'dead') continue;
        const d2 = dist2(animal.position, a.position);
        if (d2 < r2) {
            sx += a.position.x;
            sy += a.position.y;
            count++;
        }
    }
    if (count === 0) return { x: animal.position.x, y: animal.position.y, count: 0 };
    return { x: sx / count, y: sy / count, count };
}

function pickWanderTarget(pos: { x: number; y: number }, radius: number, heightMap: NonNullable<Scene['heightMap']>): { x: number; y: number } {
    for (let i = 0; i < 10; i++) {
        const angle = Math.random() * Math.PI * 2;
        const dist = (0.3 + Math.random() * 0.7) * radius;
        const tx = pos.x + Math.cos(angle) * dist;
        const ty = pos.y + Math.sin(angle) * dist;
        if (!isInWorldBounds(tx, ty)) continue;
        const h = getHeightAt(heightMap, tx, ty);
        if (h < SEA_LEVEL + 2) continue;
        return clampToWorld(tx, ty);
    }
    return { ...pos };
}

function moveToward(animal: AnimalEntity, target: { x: number; y: number }, speed: number, dt: number): boolean {
    const dx = target.x - animal.position.x;
    const dy = target.y - animal.position.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < 2) return true;

    const step = speed * dt;
    if (step >= d) {
        animal.position.x = target.x;
        animal.position.y = target.y;
        animal.heading = Math.atan2(dy, dx);
        return true;
    }

    animal.position.x += (dx / d) * step;
    animal.position.y += (dy / d) * step;
    animal.heading = Math.atan2(dy, dx);
    return false;
}

function spawnBaby(parent: AnimalEntity, species: AnimalSpecies): AnimalEntity {
    const angle = Math.random() * Math.PI * 2;
    const offset = 3 + Math.random() * 5;
    const pos = clampToWorld(
        parent.position.x + Math.cos(angle) * offset,
        parent.position.y + Math.sin(angle) * offset,
    );
    return {
        id: `animal-${generateEntityId()}`,
        type: 'animal',
        speciesId: species.id,
        position: pos,
        targetPos: null,
        heading: Math.random() * Math.PI * 2,
        speed: 0,
        health: 100,
        hunger: 0.3,
        age: 0,
        growth: 0,
        reproTimer: DAYS(species.reproInterval / SECONDS_PER_DAY * 0.5),
        idleTimer: DAYS(0.5 + Math.random() * 1),
        mateTargetId: null,
        sex: Math.random() < 0.5 ? 'male' : 'female',
        state: 'idle',
    };
}

export function processFauna(scene: Scene, dt: number) {
    if (dt <= 0) return;

    const heightMap = scene.heightMap;
    const newEntities: AnimalEntity[] = [];
    const { nightFactor } = getCalendar(scene.time);
    const isNight = nightFactor > 0.5;

    for (let i = scene.entities.length - 1; i >= 0; i--) {
        const e = scene.entities[i];
        if (e.type !== 'animal') continue;
        const animal = e as AnimalEntity;
        const species = speciesRegistry.get(animal.speciesId);
        if (!species) continue;

        if (animal.state === 'dead') {
            animal.age += dt;
            if (animal.age > 5 * SECONDS_PER_DAY) {
                scene.entities.splice(i, 1);
            }
            continue;
        }

        animal.age += dt;
        const sleepingNow = animal.state === 'sleeping';
        const hungerMult = sleepingNow ? 0.3 : 1;
        animal.hunger = Math.min(1, animal.hunger + species.hungerRate * hungerMult * (dt / SECONDS_PER_DAY));

        const growthRate = 1 / DAYS(species.growthDays);
        animal.growth = Math.min(1, animal.growth + growthRate * dt);

        if (animal.hunger > 0.85) {
            animal.health = Math.max(0, animal.health - 8 * (dt / SECONDS_PER_DAY));
        } else if (animal.hunger < 0.4) {
            animal.health = Math.min(100, animal.health + 3 * (dt / SECONDS_PER_DAY));
        }

        if (animal.health <= 0 || animal.age > species.maxAge) {
            animal.state = 'dead';
            animal.speed = 0;
            animal.targetPos = null;
            animal.mateTargetId = null;
            animal.age = 0;
            continue;
        }

        animal.reproTimer = Math.max(0, animal.reproTimer - dt);

        const shouldSleep = species.nocturnal ? !isNight : isNight;
        if (shouldSleep && animal.state !== 'sleeping' && animal.state !== 'fleeing') {
            animal.state = 'sleeping';
            animal.speed = 0;
            animal.targetPos = null;
            animal.mateTargetId = null;
            continue;
        }
        if (animal.state === 'sleeping') {
            if (!shouldSleep) {
                animal.state = 'idle';
                animal.idleTimer = DAYS(0.1 + Math.random() * 0.3);
            }
            continue;
        }

        const threat = findThreat(scene, animal, species);
        if (threat) {
            const dx = animal.position.x - threat.position.x;
            const dy = animal.position.y - threat.position.y;
            const d = Math.sqrt(dx * dx + dy * dy) || 1;
            const fleeX = animal.position.x + (dx / d) * species.wanderRadius;
            const fleeY = animal.position.y + (dy / d) * species.wanderRadius;
            const clamped = clampToWorld(fleeX, fleeY);
            animal.targetPos = clamped;
            animal.mateTargetId = null;
            animal.state = 'fleeing';
            animal.speed = species.speed * 1.8;
            moveToward(animal, animal.targetPos, animal.speed, dt);
            continue;
        }

        if (animal.state === 'calling') {
            animal.idleTimer -= dt;
            animal.speed = 0;
            if (animal.idleTimer <= 0) {
                animal.state = 'idle';
                animal.idleTimer = DAYS(0.3);
                animal.mateTargetId = null;
            }
            continue;
        }

        if (animal.state === 'mating') {
            if (!animal.mateTargetId) {
                animal.state = 'idle';
                animal.idleTimer = DAYS(0.3);
                continue;
            }
            const caller = scene.entities.find(
                en => en.id === animal.mateTargetId && en.type === 'animal'
            ) as AnimalEntity | undefined;
            if (!caller || caller.state !== 'calling') {
                animal.state = 'idle';
                animal.idleTimer = DAYS(0.3);
                animal.mateTargetId = null;
                continue;
            }
            animal.targetPos = { ...caller.position };
            animal.speed = species.speed * 0.8;
            const arrived = moveToward(animal, animal.targetPos, animal.speed, dt);
            if (arrived) {
                const [minLitter, maxLitter] = species.litterSize;
                const count = minLitter + Math.floor(Math.random() * (maxLitter - minLitter + 1));
                for (let b = 0; b < count; b++) {
                    newEntities.push(spawnBaby(animal, species));
                }
                animal.reproTimer = species.reproInterval;
                caller.reproTimer = species.reproInterval;
                caller.state = 'idle';
                caller.idleTimer = DAYS(0.5);
                caller.mateTargetId = null;
                animal.state = 'idle';
                animal.idleTimer = DAYS(0.5);
                animal.mateTargetId = null;
                animal.targetPos = null;
            }
            continue;
        }

        if (animal.state === 'grazing') {
            animal.idleTimer -= dt;
            animal.hunger = Math.max(0, animal.hunger - 0.08 * (dt / SECONDS_PER_DAY));
            if (animal.idleTimer <= 0) {
                animal.state = 'idle';
                animal.idleTimer = DAYS(0.3 + Math.random() * 0.5);
            }
            continue;
        }

        if (animal.state === 'idle') {
            animal.idleTimer -= dt;
            animal.speed = 0;
            if (animal.idleTimer > 0) continue;

            if (animal.reproTimer <= 0 && animal.growth >= 0.8 && animal.hunger < 0.5 && animal.sex === 'male') {
                const mate = findMate(scene, animal, species.detectRadius);
                if (mate && mate.state !== 'mating' && mate.state !== 'calling' && mate.state !== 'sleeping') {
                    animal.state = 'calling';
                    animal.idleTimer = DAYS(1 + Math.random() * 1);
                    animal.mateTargetId = mate.id;
                    mate.state = 'mating';
                    mate.mateTargetId = animal.id;
                    mate.targetPos = { ...animal.position };
                    continue;
                }
            }

            if (animal.hunger > 0.4 && (species.diet === 'carnivore' || species.diet === 'omnivore')) {
                const prey = findNearestPrey(scene, animal.position, species.detectRadius, species.preyOn);
                if (prey) {
                    animal.targetPos = { ...prey.position };
                    animal.state = 'eating';
                    animal.speed = species.speed * 1.2;
                    continue;
                }
            }

            if (species.diet === 'herbivore' || species.diet === 'omnivore') {
                if (heightMap) {
                    const grazeSpot = pickGrazeTarget(animal.position, species.wanderRadius * 0.6, heightMap, scene.soilGrid);
                    if (grazeSpot) {
                        animal.targetPos = grazeSpot;
                        animal.state = 'wandering';
                        animal.speed = species.speed * 0.35;
                        continue;
                    }
                }
            }

            if (heightMap) {
                if (species.social > 0.3) {
                    const group = findGroupCenter(scene, animal, species);
                    if (group.count > 0 && Math.random() < species.social) {
                        const gx = group.x + (Math.random() - 0.5) * species.groupRadius * 0.5;
                        const gy = group.y + (Math.random() - 0.5) * species.groupRadius * 0.5;
                        const clamped = clampToWorld(gx, gy);
                        if (isInWorldBounds(clamped.x, clamped.y) && getHeightAt(heightMap, clamped.x, clamped.y) > SEA_LEVEL + 2) {
                            animal.targetPos = clamped;
                        } else {
                            animal.targetPos = pickWanderTarget(animal.position, species.wanderRadius, heightMap);
                        }
                    } else {
                        animal.targetPos = pickWanderTarget(animal.position, species.wanderRadius * 0.6, heightMap);
                    }
                } else {
                    animal.targetPos = pickWanderTarget(animal.position, species.wanderRadius, heightMap);
                }
            }
            animal.state = 'wandering';
            animal.speed = species.speed * 0.35;
            continue;
        }

        if (animal.state === 'eating' && animal.targetPos) {
            const arrived = moveToward(animal, animal.targetPos, animal.speed, dt);
            if (arrived) {
                const prey = findNearestPrey(scene, animal.position, 8, species.preyOn);
                if (prey) {
                    prey.health = Math.max(0, prey.health - 40);
                    animal.hunger = Math.max(0, animal.hunger - species.foodValue);
                    if (prey.health <= 0) {
                        prey.state = 'dead';
                        prey.speed = 0;
                        prey.age = 0;
                    }
                }
                animal.targetPos = null;
                animal.state = 'idle';
                animal.idleTimer = DAYS(0.5 + Math.random() * 1);
            }
            continue;
        }

        if (animal.state === 'wandering' && animal.targetPos) {
            const arrived = moveToward(animal, animal.targetPos, animal.speed, dt);
            if (arrived) {
                animal.targetPos = null;
                const onGrass = isGrassySpot(scene.soilGrid, animal.position.x, animal.position.y);
                if (onGrass && (species.diet === 'herbivore' || species.diet === 'omnivore')) {
                    animal.state = 'grazing';
                    animal.idleTimer = DAYS(0.5 + Math.random() * 1.5);
                    animal.speed = 0;
                } else {
                    animal.state = 'idle';
                    animal.idleTimer = DAYS(0.3 + Math.random() * 0.8);
                    animal.speed = 0;
                }
            }
            continue;
        }

        if (animal.state === 'fleeing' && animal.targetPos) {
            const arrived = moveToward(animal, animal.targetPos, animal.speed, dt);
            if (arrived) {
                animal.targetPos = null;
                animal.state = 'idle';
                animal.idleTimer = DAYS(0.2 + Math.random() * 0.3);
                animal.speed = 0;
            }
            continue;
        }

        animal.state = 'idle';
        animal.idleTimer = DAYS(0.2 + Math.random() * 0.5);
    }

    for (const baby of newEntities) {
        scene.entities.push(baby);
    }
}
