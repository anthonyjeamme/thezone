import {
    AGE_MENOPAUSE, AGE_OLD, AGE_MAX, AGE_RATE, CABIN_WOOD_COST,
    SECONDS_PER_HOUR, SECONDS_PER_YEAR,
    STARVATION_LETHAL_TIME, DEHYDRATION_LETHAL_TIME,
    RESERVE_HUNGER_DECAY, RESERVE_THIRST_DECAY, RESERVE_REGEN_RATE,
    CONCEPTION_CHANCE,
    BuildingEntity, EntityInfo, FertileZoneEntity, NPCEntity, NPCInfo, NPCMessage,
    ResourceEntity, ResourceType, Scene, StockEntity, WorldAPI,
    getCalendar, getLifeStage, getAgeDebuff, getNeedsDebuff, hasPartner, getPartnerId, isFertile,
    addItem, removeItem, countItem,
} from './types';
import { getItemDef, getJobDef, getRecipeDef } from '../Shared/registry';
// evaluateMate has been moved to the AI layer (Phase 2 refactoring)
import { resolveAttack } from './combat';
import { Vector2D, distance, normalize, subtract } from '../Shared/vector';
import { generateEntityId } from '../Shared/ids';
import { logger } from '../Shared/logger';
import { findCabinSlot, generateCabinPlot, refreshNearbyPlots } from './terrain';
import { processFlora } from './flora';
import { processFauna } from './fauna';
import { processWeather } from './weather';
import { processSoilCycles } from './fertility';
import {
    processReproduction,
    MATING_DURATION, GESTATION_DURATION, PROPOSE_RANGE,
} from './reproduction';

// --- World constants ---

const ARRIVAL_THRESHOLD = 5;
const TAKE_RANGE = 25;
const DEPOSIT_RANGE = 30;
const CABIN_RANGE = 30;
const TRADE_RANGE = 30;          // px — distance to exchange items with another NPC

// --- Base rates (scaled by NPC traits) ---

const BASE_TAKE_DURATION = 1;        // seconds (divided by traits.gatherSpeed)
const BASE_HUNGER_DECAY = 0.65;      // per second — eats ~3 times/day (every ~4-5h)
const BASE_THIRST_DECAY = 0.85;      // per second — drinks ~4 times/day (every ~3-4h)
const BASE_ENERGY_DECAY = 0.45;      // per second (divided by traits.stamina) — ~13h day before critical
const ENERGY_RESTORE_RATE = 100 / (12 * SECONDS_PER_HOUR); // 0→100 in 12 game-hours
const HEALTH_DAMAGE_RATE = 5;        // base per second once lethal timer exceeded
const HEALTH_REGEN_RATE = 1;         // per second when well-fed and rested

// Consumption restore amounts
const FOOD_RESTORE = 35;
const WATER_RESTORE = 30;

// Child needs decay multiplier (children use less resources)
const CHILD_NEEDS_MULTIPLIER = 0.5;

// Night energy penalty: being awake at night drains energy much faster
const NIGHT_ENERGY_MULTIPLIER = 2.5;

// Health regen conditions — needs must be above these thresholds
const HEALTH_REGEN_HUNGER_MIN = 30;
const HEALTH_REGEN_THIRST_MIN = 30;
const HEALTH_REGEN_ENERGY_MIN = 20;

// Child auto-feeding threshold
const CHILD_FEED_THRESHOLD = 50;

const RESOURCE_COLORS: Record<string, string> = {
    food: '#2ecc71',
    water: '#00bcd4',
    wood: '#8B6914',
};

// --- Public ---

export function processWorld(scene: Scene, dt: number) {
    scene.time += dt;
    processMovement(scene, dt);
    processActions(scene, dt);
    processAging(scene, dt);
    processNeeds(scene, dt);
    processHappiness(scene, dt);
    processChildFeeding(scene);
    processReproduction(scene, dt);
    processFertileZones(scene, dt);
    processWeather(scene, dt);
    if (scene.soilGrid) processSoilCycles(scene.soilGrid, dt, scene.heightMap);
    processFlora(scene, dt);
    processFauna(scene, dt);
}

// --- World API (per-NPC interface) ---

export function createWorldAPI(scene: Scene, entity: NPCEntity): WorldAPI {
    return {
        // --- Perception ---

        getNearest(itemId: string) {
            let nearest: EntityInfo | null = null;

            for (const e of scene.entities) {
                if (e.type !== 'resource') continue;
                if (e.itemId !== itemId && e.resourceType !== itemId) continue;
                if (e.lockedBy !== null) continue;

                const dist = distance(entity.position, e.position);
                if (dist > entity.traits.visionRange) continue;

                if (!nearest || dist < nearest.distance) {
                    nearest = {
                        id: e.id,
                        position: { x: e.position.x, y: e.position.y },
                        distance: dist,
                    };
                }
            }

            return nearest;
        },

        getNearestMate() {
            const targetSex = entity.sex === 'male' ? 'female' : 'male';
            let nearest: EntityInfo | null = null;

            for (const e of scene.entities) {
                if (e.type !== 'npc') continue;
                if (e.sex !== targetSex) continue;
                if (e.id === entity.id) continue;
                if (e.action?.type === 'mating') continue;
                // Only adults can mate
                if (getLifeStage(e.age) !== 'adult') continue;
                // Females past menopause can't conceive
                if (e.sex === 'female' && e.age >= AGE_MENOPAUSE) continue;
                // Skip if already has a partner
                if (hasPartner(e)) continue;
                // Skip known relatives (parent/child)
                if (entity.knowledge.relations.some(
                    (r) => r.targetId === e.id && (r.type === 'mother' || r.type === 'father' || r.type === 'child')
                )) continue;
                // Skip siblings (share a parent)
                {
                    const myParents = entity.knowledge.relations
                        .filter((r) => r.type === 'mother' || r.type === 'father')
                        .map((r) => r.targetId);
                    const theirParents = e.knowledge.relations
                        .filter((r) => r.type === 'mother' || r.type === 'father')
                        .map((r) => r.targetId);
                    if (myParents.some((id) => theirParents.includes(id))) continue;
                }

                const dist = distance(entity.position, e.position);
                if (dist > entity.traits.visionRange) continue;

                if (!nearest || dist < nearest.distance) {
                    nearest = {
                        id: e.id,
                        position: { x: e.position.x, y: e.position.y },
                        distance: dist,
                    };
                }
            }

            return nearest;
        },

        getEntity(id: string) {
            const target = scene.entities.find((e) => e.id === id);
            if (!target) return null;

            return {
                id: target.id,
                position: { x: target.position.x, y: target.position.y },
                distance: distance(entity.position, target.position),
            };
        },

        getMyStock() {
            if (!entity.homeId) return null;
            const stock = scene.entities.find(
                (e): e is StockEntity => e.type === 'stock' && e.cabinId === entity.homeId
            );
            if (!stock) return null;

            return {
                id: stock.id,
                position: { x: stock.position.x, y: stock.position.y },
                distance: distance(entity.position, stock.position),
            };
        },

        getMyCabin() {
            if (!entity.homeId) return null;
            const cabin = scene.entities.find(
                (e): e is BuildingEntity => e.type === 'building' && e.id === entity.homeId
            );
            if (!cabin) return null;

            return {
                id: cabin.id,
                position: { x: cabin.position.x, y: cabin.position.y },
                distance: distance(entity.position, cabin.position),
            };
        },

        getStockCount(itemId: string) {
            if (!entity.homeId) return 0;
            const stock = scene.entities.find(
                (e): e is StockEntity => e.type === 'stock' && e.cabinId === entity.homeId
            );
            if (!stock) return 0;
            return countItem(stock.items, itemId);
        },

        // --- Actions ---

        moveTo(target: Vector2D) {
            const dist = distance(entity.position, target);
            if (dist === 0) return;

            entity.movement = {
                target: { x: target.x, y: target.y },
                direction: normalize(subtract(target, entity.position)),
            };
        },

        stop() {
            entity.movement = null;
        },

        take(targetId: string) {
            const target = scene.entities.find(
                (e): e is ResourceEntity => e.id === targetId && e.type === 'resource'
            );
            if (!target) return false;
            if (distance(entity.position, target.position) > TAKE_RANGE) return false;
            if (target.lockedBy !== null) return false;

            const debuff = getNeedsDebuff(entity.needs) * getAgeDebuff(entity.age);
            // Job bonus: if NPC has a job with a gather bonus for this item, apply it
            let jobBonus = 1;
            if (entity.job) {
                const jobDef = getJobDef(entity.job);
                const itemId = target.itemId || target.resourceType;
                if (jobDef && jobDef.gatherBonus[itemId]) {
                    jobBonus = jobDef.gatherBonus[itemId];
                }
            }
            const duration = BASE_TAKE_DURATION / (entity.traits.gatherSpeed * debuff * jobBonus);
            target.lockedBy = entity.id;
            entity.action = { type: 'take', targetId, duration, remaining: duration };
            return true;
        },

        deposit() {
            if (!entity.homeId) return false;
            const stock = scene.entities.find(
                (e): e is StockEntity => e.type === 'stock' && e.cabinId === entity.homeId
            );
            if (!stock) return false;
            if (distance(entity.position, stock.position) > DEPOSIT_RANGE) return false;

            for (const item of entity.inventory) {
                addItem(stock.items, item.itemId, item.quantity);
            }
            entity.inventory = [];
            return true;
        },

        consume(itemId: string) {
            // Must eat from home stock — NPC needs to be near their cabin
            if (!entity.homeId) return false;
            const stock = scene.entities.find(
                (e): e is StockEntity => e.type === 'stock' && e.cabinId === entity.homeId
            );
            if (!stock || distance(entity.position, stock.position) > DEPOSIT_RANGE) return false;

            if (!removeItem(stock.items, itemId, 1)) return false;
            applyConsumption(entity, itemId);
            return true;
        },

        sleep() {
            if (!entity.homeId) return false;
            const cabin = scene.entities.find(
                (e): e is BuildingEntity => e.type === 'building' && e.id === entity.homeId
            );
            if (!cabin) return false;
            if (distance(entity.position, cabin.position) > CABIN_RANGE) return false;

            entity.action = { type: 'sleep', duration: 0, remaining: 0 };
            return true;
        },

        wakeUp() {
            if (entity.action?.type === 'sleep') {
                entity.action = null;
            }
        },

        startMating(targetId: string) {
            // Pure world mechanics: check physical prerequisites and set up mating actions.
            // Does NOT mutate AI state — the AI handles that.
            const female = scene.entities.find(
                (e): e is NPCEntity => e.id === targetId && e.type === 'npc'
            );
            if (!female) return { success: false, reason: 'not_found' };

            const dist = distance(entity.position, female.position);
            if (dist > PROPOSE_RANGE * 2) return { success: false, reason: 'too_far' };
            if (female.action !== null) return { success: false, reason: 'busy' };
            if (female.reproduction.cooldown > 0) return { success: false, reason: 'cooldown' };
            if (female.reproduction.gestation !== null) return { success: false, reason: 'pregnant' };

            logger.info('REPRO', `${entity.name}: mating with ${female.name}`);

            // Both enter mating (physical actions only)
            entity.movement = null;
            female.movement = null;

            const matingAction = {
                type: 'mating' as const,
                targetId: undefined,
                duration: MATING_DURATION,
                remaining: MATING_DURATION,
            };
            entity.action = { ...matingAction, targetId: female.id };
            female.action = { ...matingAction, targetId: entity.id };

            return { success: true, reason: 'ok' };
        },

        formCouple(targetId: string) {
            // Pure world mechanics: form a couple bond between two NPCs.
            const target = scene.entities.find(
                (e): e is NPCEntity => e.id === targetId && e.type === 'npc'
            );
            if (!target) return false;

            const dist = distance(entity.position, target.position);
            if (dist > PROPOSE_RANGE) return false;

            logger.info('REPRO', `${entity.name}: forming couple with ${target.name}`);
            formCoupleRelation(scene, entity, target);
            return true;
        },

        sendMessage(targetId: string, message: NPCMessage) {
            const target = scene.entities.find(
                (e): e is NPCEntity => e.id === targetId && e.type === 'npc'
            );
            if (!target) return false;
            target.messages.push(message);
            return true;
        },

        getNearbyNPCs(range: number) {
            const results: EntityInfo[] = [];

            for (const e of scene.entities) {
                if (e.type !== 'npc') continue;
                if (e.id === entity.id) continue;

                const dist = distance(entity.position, e.position);
                if (dist <= range) {
                    results.push({
                        id: e.id,
                        position: { x: e.position.x, y: e.position.y },
                        distance: dist,
                    });
                }
            }

            results.sort((a, b) => a.distance - b.distance);
            return results;
        },

        buildCabin() {
            // Must be homeless
            if (entity.homeId) return false;

            // Check wood in inventory
            if (countItem(entity.inventory, 'wood') < CABIN_WOOD_COST) return false;

            // Consume wood
            removeItem(entity.inventory, 'wood', CABIN_WOOD_COST);

            // Find spot near current position (no village constraint at runtime)
            const existingCabins = scene.entities.filter((e): e is BuildingEntity => e.type === 'building');
            const cabinPos = findCabinSlot(existingCabins, existingCabins, entity.position);
            const cabinId = `cabin-${entity.id}`;

            const neighborPositions = existingCabins.map((c) => c.position);
            const newCabin: BuildingEntity = {
                id: cabinId,
                type: 'building',
                buildingType: 'cabin',
                residentIds: [entity.id],
                workerIds: [],
                position: cabinPos,
                color: entity.color,
                polygon: generateCabinPlot(cabinPos, neighborPositions),
            };
            scene.entities.push(newCabin);

            const allCabins = scene.entities.filter((e): e is BuildingEntity => e.type === 'building');
            refreshNearbyPlots(allCabins, newCabin);

            // Create stock
            scene.entities.push({
                id: `stock-${cabinId}`,
                type: 'stock',
                cabinId,
                position: { x: cabinPos.x + 20, y: cabinPos.y + 12 },
                color: entity.color,
                items: [],
            });

            entity.homeId = cabinId;
            logger.info('BUILD', `${entity.name} built a cabin! (used ${CABIN_WOOD_COST} wood)`);
            return true;
        },

        withdrawFromStock(itemId: string) {
            if (!entity.homeId) return false;
            const stock = scene.entities.find(
                (e): e is StockEntity => e.type === 'stock' && e.cabinId === entity.homeId
            );
            if (!stock || distance(entity.position, stock.position) > DEPOSIT_RANGE) return false;

            if (!removeItem(stock.items, itemId, 1)) return false;
            addItem(entity.inventory, itemId, 1);
            return true;
        },

        giveItem(targetId: string, itemId: string) {
            const target = scene.entities.find(
                (e): e is NPCEntity => e.id === targetId && e.type === 'npc'
            );
            if (!target) return false;
            if (distance(entity.position, target.position) > TRADE_RANGE) return false;

            if (!removeItem(entity.inventory, itemId, 1)) return false;
            addItem(target.inventory, itemId, 1);
            return true;
        },

        craft(recipeId: string) {
            const recipe = getRecipeDef(recipeId);
            if (!recipe) return false;

            // Must be near home stock
            if (!entity.homeId) return false;
            const stock = scene.entities.find(
                (e): e is StockEntity => e.type === 'stock' && e.cabinId === entity.homeId
            );
            if (!stock || distance(entity.position, stock.position) > DEPOSIT_RANGE) return false;

            // Check if building requirement is met
            if (recipe.requiredBuilding) {
                const nearBuilding = scene.entities.find(
                    (e): e is BuildingEntity =>
                        e.type === 'building' &&
                        e.buildingType === recipe.requiredBuilding &&
                        distance(entity.position, e.position) <= DEPOSIT_RANGE * 2
                );
                if (!nearBuilding) return false;
            }

            // Check job requirement
            if (recipe.requiredJob && entity.job !== recipe.requiredJob) return false;

            // Check inputs available in stock
            for (const input of recipe.inputs) {
                if (countItem(stock.items, input.itemId) < input.quantity) return false;
            }

            // Consume inputs from stock
            for (const input of recipe.inputs) {
                removeItem(stock.items, input.itemId, input.quantity);
            }

            // Calculate duration with job bonus
            let craftBonus = 1;
            if (entity.job) {
                const jDef = getJobDef(entity.job);
                if (jDef && jDef.craftBonus[recipeId]) {
                    craftBonus = jDef.craftBonus[recipeId];
                }
            }
            const debuff = getNeedsDebuff(entity.needs) * getAgeDebuff(entity.age);
            const duration = recipe.duration / (craftBonus * debuff);

            entity.action = { type: 'crafting', recipeId, duration, remaining: duration };
            return true;
        },

        getNearbyBuildings(range: number) {
            const results: Array<EntityInfo & { buildingType: string }> = [];
            for (const e of scene.entities) {
                if (e.type !== 'building') continue;
                const dist = distance(entity.position, e.position);
                if (dist > range) continue;
                results.push({
                    id: e.id,
                    position: { x: e.position.x, y: e.position.y },
                    distance: dist,
                    buildingType: e.buildingType,
                });
            }
            return results;
        },

        getNPCInfo(id: string): NPCInfo | null {
            const target = scene.entities.find(
                (e): e is NPCEntity => e.id === id && e.type === 'npc'
            );
            if (!target) return null;
            return npcToInfo(target, entity);
        },

        getNearbyNPCInfos(range: number): NPCInfo[] {
            const results: NPCInfo[] = [];
            for (const e of scene.entities) {
                if (e.type !== 'npc') continue;
                if (e.id === entity.id) continue;
                const dist = distance(entity.position, e.position);
                if (dist <= range) {
                    results.push(npcToInfo(e as NPCEntity, entity));
                }
            }
            results.sort((a, b) => a.distance - b.distance);
            return results;
        },

        getChildInfos(): NPCInfo[] {
            const childIds = entity.knowledge.relations
                .filter((r) => r.type === 'child')
                .map((r) => r.targetId);
            if (childIds.length === 0) return [];

            const results: NPCInfo[] = [];
            for (const cid of childIds) {
                const child = scene.entities.find(
                    (e): e is NPCEntity => e.id === cid && e.type === 'npc'
                );
                if (child) {
                    results.push(npcToInfo(child, entity));
                }
            }
            return results;
        },

        getStockCountOf(npcId: string, itemId: string): number {
            const npc = scene.entities.find(
                (e): e is NPCEntity => e.id === npcId && e.type === 'npc'
            );
            if (!npc || !npc.homeId) return 0;
            const stock = scene.entities.find(
                (e): e is StockEntity => e.type === 'stock' && e.cabinId === npc.homeId
            );
            if (!stock) return 0;
            return countItem(stock.items, itemId);
        },

        takeItemFrom(targetId: string, itemId: string): boolean {
            const target = scene.entities.find(
                (e): e is NPCEntity => e.id === targetId && e.type === 'npc'
            );
            if (!target) return false;
            if (distance(entity.position, target.position) > TRADE_RANGE) return false;
            if (!removeItem(target.inventory, itemId, 1)) return false;
            addItem(entity.inventory, itemId, 1);
            return true;
        },

        attack(targetId: string): number {
            const target = scene.entities.find(
                (e): e is NPCEntity => e.id === targetId && e.type === 'npc'
            );
            if (!target) return 0;
            return resolveAttack(entity, target);
        },
    };
}

/** Convert a raw NPCEntity into observable NPCInfo from the perspective of an observer */
function npcToInfo(target: NPCEntity, observer: NPCEntity): NPCInfo {
    return {
        id: target.id,
        position: { x: target.position.x, y: target.position.y },
        distance: distance(observer.position, target.position),
        name: target.name,
        sex: target.sex,
        age: target.age,
        stage: getLifeStage(target.age),
        color: target.color,
        visibleState: target.ai.state,
        isAlive: target.needs.health > 0,
        homeId: target.homeId,
        job: target.job,
        inventoryCount: target.inventory.length,
        hasPartner: hasPartner(target),
        isPregnant: target.reproduction.gestation !== null,
    };
}

// --- Internal: consumption ---

function applyConsumption(entity: NPCEntity, itemId: string) {
    const def = getItemDef(itemId);
    if (!def) return;

    if (def.nutrition && def.nutrition > 0) {
        entity.needs.hunger = Math.min(100, entity.needs.hunger + def.nutrition);
    }
    if (def.hydration && def.hydration > 0) {
        entity.needs.thirst = Math.min(100, entity.needs.thirst + def.hydration);
    }
}

// --- Internal: aging ---

function processAging(scene: Scene, dt: number) {
    const npcs = scene.entities.filter(
        (e): e is NPCEntity => e.type === 'npc'
    );

    for (const npc of npcs) {
        const prevStage = getLifeStage(npc.age);
        npc.age += AGE_RATE * dt;
        const newStage = getLifeStage(npc.age);

        // Transition: adolescent → adult → leave home, build own cabin
        if (prevStage !== 'adult' && newStage === 'adult') {
            handleAdultTransition(scene, npc);
        }

        // Old age: increasing chance of natural death each year past AGE_OLD
        if (npc.age > AGE_OLD) {
            // Probability per sim-second: scales from 0 at AGE_OLD to ~100% per year at AGE_MAX
            const ageFraction = Math.min(1, (npc.age - AGE_OLD) / (AGE_MAX - AGE_OLD));
            const deathChancePerYear = ageFraction * ageFraction; // quadratic — accelerates near AGE_MAX
            const deathChancePerSec = deathChancePerYear / SECONDS_PER_YEAR;
            if (Math.random() < deathChancePerSec * dt) {
                npc.needs.health = 0; // triggers death in processNeeds
                logger.info('AGE', `${npc.name} dies of old age at ${Math.floor(npc.age)}`);
            }
        }
    }
}

function handleAdultTransition(scene: Scene, npc: NPCEntity) {
    logger.info('AGE', `${npc.name} becomes an adult! Must gather ${CABIN_WOOD_COST} wood to build a home.`);

    // Leave parental home (but don't build yet — need wood first)
    if (npc.homeId) {
        const oldCabin = scene.entities.find(
            (e): e is BuildingEntity => e.type === 'building' && e.id === npc.homeId
        );
        if (oldCabin) {
            oldCabin.residentIds = oldCabin.residentIds.filter((id) => id !== npc.id);
        }
    }

    npc.homeId = null; // homeless until they gather enough wood to build
}

// --- Internal: child feeding ---

/** Babies and children auto-consume from home stock when hungry/thirsty */
function processChildFeeding(scene: Scene) {
    const npcs = scene.entities.filter(
        (e): e is NPCEntity => e.type === 'npc'
    );

    for (const npc of npcs) {
        const stage = getLifeStage(npc.age);
        if (stage !== 'baby' && stage !== 'child') continue;
        if (!npc.homeId) continue;

        const stock = scene.entities.find(
            (e): e is StockEntity => e.type === 'stock' && e.cabinId === npc.homeId
        );
        if (!stock) continue;

        // Auto-feed when hungry (try bread first, then food)
        if (npc.needs.hunger < CHILD_FEED_THRESHOLD) {
            if (removeItem(stock.items, 'bread', 1)) {
                applyConsumption(npc, 'bread');
            } else if (removeItem(stock.items, 'food', 1)) {
                applyConsumption(npc, 'food');
            } else if (removeItem(stock.items, 'meat', 1)) {
                applyConsumption(npc, 'meat');
            }
        }

        // Auto-drink when thirsty
        if (npc.needs.thirst < CHILD_FEED_THRESHOLD) {
            if (removeItem(stock.items, 'water', 1)) {
                applyConsumption(npc, 'water');
            }
        }
    }
}

// --- Internal: happiness ---

const HAPPINESS_SPEED = 3; // how fast happiness drifts towards target per second

function processHappiness(scene: Scene, dt: number) {
    const npcs = scene.entities.filter(
        (e): e is NPCEntity => e.type === 'npc'
    );

    for (const npc of npcs) {
        // Compute target happiness (0-100) from factors
        let target = 50; // baseline

        // --- Positive factors ---

        // Has a partner → +15
        if (hasPartner(npc)) {
            // Extra: partner is alive → +15, dead partner → -10
            const pid = getPartnerId(npc);
            const partnerAlive = pid ? npcs.some((n) => n.id === pid) : false;
            target += partnerAlive ? 15 : -10;
        }

        // Has living children → +5 per child (max +20)
        const childIds = npc.knowledge.relations
            .filter((r) => r.type === 'child')
            .map((r) => r.targetId);
        const livingChildren = childIds.filter((cid) => npcs.some((n) => n.id === cid)).length;
        target += Math.min(20, livingChildren * 5);

        // Has a home → +5
        if (npc.homeId) target += 5;

        // Good social connections (high average affinity) → up to +10
        const affinities = npc.knowledge.npcs.filter((k) => k.affinity > 0.3);
        if (affinities.length > 0) {
            const avgAffinity = affinities.reduce((s, k) => s + k.affinity, 0) / affinities.length;
            target += Math.round(avgAffinity * 10);
        }

        // --- Negative factors ---

        // Hungry → -15
        if (npc.needs.hunger < 30) target -= 15;
        // Thirsty → -15
        if (npc.needs.thirst < 30) target -= 15;
        // Low health → -20
        if (npc.needs.health < 50) target -= 20;
        // Exhausted → -10
        if (npc.needs.energy < 20) target -= 10;
        // Homeless adult → -15
        if (!npc.homeId && getLifeStage(npc.age) === 'adult') target -= 15;

        // Clamp target
        target = Math.max(0, Math.min(100, target));

        // Smooth drift towards target
        const diff = target - npc.needs.happiness;
        npc.needs.happiness += Math.sign(diff) * Math.min(Math.abs(diff), HAPPINESS_SPEED * dt);
        npc.needs.happiness = Math.max(0, Math.min(100, npc.needs.happiness));
    }
}

// --- Internal: world processes ---

function processMovement(scene: Scene, dt: number) {
    for (const entity of scene.entities) {
        if (entity.type !== 'npc' || !entity.movement) continue;

        const dist = distance(entity.position, entity.movement.target);
        const debuff = getNeedsDebuff(entity.needs) * getAgeDebuff(entity.age);
        const stepDist = entity.traits.speed * debuff * dt;

        // Snap to target if close enough or would overshoot
        if (dist < ARRIVAL_THRESHOLD || stepDist >= dist) {
            entity.position.x = entity.movement.target.x;
            entity.position.y = entity.movement.target.y;
            entity.movement = null;
            continue;
        }

        entity.position.x += entity.movement.direction.x * stepDist;
        entity.position.y += entity.movement.direction.y * stepDist;
    }
}

function processActions(scene: Scene, dt: number) {
    const npcs = scene.entities.filter(
        (e): e is NPCEntity => e.type === 'npc' && e.action !== null
    );

    for (const npc of npcs) {
        if (!npc.action) continue;
        npc.action.remaining -= dt;

        if (npc.action.type === 'take' && npc.action.remaining <= 0) {
            completeTakeAction(scene, npc);
        } else if (npc.action.type === 'mating' && npc.action.remaining <= 0) {
            completeMatingAction(scene, npc);
        } else if (npc.action.type === 'crafting' && npc.action.remaining <= 0) {
            completeCraftAction(scene, npc);
        }
    }
}

function completeTakeAction(scene: Scene, npc: NPCEntity) {
    if (!npc.action || npc.action.type !== 'take') return;

    const targetId = npc.action.targetId;
    const index = scene.entities.findIndex((e) => e.id === targetId);

    if (index !== -1) {
        const target = scene.entities[index] as ResourceEntity;
        const itemId = target.itemId || target.resourceType;
        addItem(npc.inventory, itemId, 1);

        memorizeResourceLocation(npc, target.position, target.resourceType);
        scene.entities.splice(index, 1);
    }

    npc.action = null;
}

function completeCraftAction(scene: Scene, npc: NPCEntity) {
    if (!npc.action || npc.action.type !== 'crafting') return;

    const recipeId = npc.action.recipeId;
    if (recipeId) {
        const recipe = getRecipeDef(recipeId);
        if (recipe) {
            // Deposit outputs into home stock
            const stock = scene.entities.find(
                (e): e is StockEntity => e.type === 'stock' && e.cabinId === npc.homeId
            );
            if (stock) {
                for (const output of recipe.outputs) {
                    addItem(stock.items, output.itemId, output.quantity);
                }
                logger.info('CRAFT', `${npc.name} crafted ${recipe.displayName}`);
            }
        }
    }

    npc.action = null;
    // AI state reset is handled by the AI layer (handleCrafting detects action completion)
}

function completeMatingAction(scene: Scene, npc: NPCEntity) {
    if (!npc.action || npc.action.type !== 'mating') return;

    const partnerId = npc.action.targetId;

    if (npc.sex === 'male') {
        npc.reproduction.desire = 0;
    } else {
        // Only conceive if fertile AND probability passes
        const fertile = isFertile(npc);
        const conceives = fertile && Math.random() < CONCEPTION_CHANCE;

        if (conceives) {
            npc.reproduction.gestation = { remaining: GESTATION_DURATION, partnerId: partnerId ?? '' };
            logger.info('REPRO', `${npc.name} conceives! (fertile=${fertile})`);
        } else {
            logger.debug('REPRO', `${npc.name} did not conceive (fertile=${fertile})`);
        }
    }

    // Add 'mate' relation (mating history)
    if (partnerId && !npc.knowledge.relations.some((r) => r.targetId === partnerId && r.type === 'mate')) {
        npc.knowledge.relations.push({ targetId: partnerId, type: 'mate' });
    }

    // Boost affinity between the two
    if (partnerId) {
        const known = npc.knowledge.npcs.find((n) => n.id === partnerId);
        if (known) known.affinity = Math.min(1, known.affinity + 0.1);
    }

    npc.action = null;
}

/** Form a committed couple: both get 'partner' relation, one moves into the other's home */
function formCoupleRelation(scene: Scene, a: NPCEntity, b: NPCEntity) {
    // Add partner relation
    a.knowledge.relations.push({ targetId: b.id, type: 'partner' });
    b.knowledge.relations.push({ targetId: a.id, type: 'partner' });

    // Decide who moves: the one without a home moves to the other's home.
    // If both have homes, male joins female. If neither, stay coupled homeless.
    const female = a.sex === 'female' ? a : b;
    const male = a.sex === 'male' ? a : b;

    // Determine which home to keep (prefer female's, then male's, then null)
    const keepHomeId = female.homeId ?? male.homeId;
    const moverId = keepHomeId === female.homeId ? male : female;
    const stayerId = keepHomeId === female.homeId ? female : male;

    if (keepHomeId && moverId.homeId !== keepHomeId) {
        // Remove mover from their old cabin (if any)
        if (moverId.homeId) {
            const oldCabin = scene.entities.find(
                (e): e is BuildingEntity => e.type === 'building' && e.id === moverId.homeId
            );
            if (oldCabin) {
                oldCabin.residentIds = oldCabin.residentIds.filter((id) => id !== moverId.id);
                if (oldCabin.residentIds.length === 0) {
                    scene.entities = scene.entities.filter(
                        (e) => e.id !== oldCabin.id && !(e.type === 'stock' && e.cabinId === oldCabin.id)
                    );
                }
            }
        }

        // Add mover to stayer's cabin
        const newCabin = scene.entities.find(
            (e): e is BuildingEntity => e.type === 'building' && e.id === keepHomeId
        );
        if (newCabin && !newCabin.residentIds.includes(moverId.id)) {
            newCabin.residentIds.push(moverId.id);
        }

        moverId.homeId = keepHomeId;
        logger.info('COUPLE', `${moverId.name} moves in with ${stayerId.name}`);
    }

    logger.info('COUPLE', `${a.name} & ${b.name} are now partners!`);
}

function processNeeds(scene: Scene, dt: number) {
    const npcs = scene.entities.filter(
        (e): e is NPCEntity => e.type === 'npc'
    );

    const { nightFactor } = getCalendar(scene.time);

    for (const npc of npcs) {
        const stage = getLifeStage(npc.age);
        const needsMult = (stage === 'baby' || stage === 'child') ? CHILD_NEEDS_MULTIPLIER : 1;

        // Decay needs (scaled by traits and age)
        npc.needs.hunger = Math.max(0, npc.needs.hunger - BASE_HUNGER_DECAY * npc.traits.hungerRate * needsMult * dt);
        npc.needs.thirst = Math.max(0, npc.needs.thirst - BASE_THIRST_DECAY * npc.traits.thirstRate * needsMult * dt);

        // Energy: restore while sleeping, decay faster at night when awake
        if (npc.action?.type === 'sleep') {
            npc.needs.energy = Math.min(100, npc.needs.energy + ENERGY_RESTORE_RATE * dt);
        } else {
            const nightPenalty = 1 + nightFactor * (NIGHT_ENERGY_MULTIPLIER - 1); // 1.0 (day) → 2.5 (night)
            npc.needs.energy = Math.max(0, npc.needs.energy - BASE_ENERGY_DECAY / npc.traits.stamina * needsMult * nightPenalty * dt);
        }

        // Reserve bars logic
        // When main gauge > 50, reserves slowly regenerate
        // When main gauge = 0, reserves are consumed instead of triggering starvation directly
        if (npc.needs.hunger <= 0) {
            // Consume reserve
            npc.needs.hungerReserve = Math.max(0, npc.needs.hungerReserve - RESERVE_HUNGER_DECAY * dt);
            // Only increment starvation timer when BOTH hunger and reserve are 0
            if (npc.needs.hungerReserve <= 0) {
                npc.needs.starvationTimer += dt;
            } else {
                npc.needs.starvationTimer = Math.max(0, npc.needs.starvationTimer - dt * 2);
            }
        } else {
            npc.needs.starvationTimer = Math.max(0, npc.needs.starvationTimer - dt * 2);
            // Regenerate reserve when hunger is comfortable
            if (npc.needs.hunger > 50) {
                npc.needs.hungerReserve = Math.min(100, npc.needs.hungerReserve + RESERVE_REGEN_RATE * dt);
            }
        }

        if (npc.needs.thirst <= 0) {
            npc.needs.thirstReserve = Math.max(0, npc.needs.thirstReserve - RESERVE_THIRST_DECAY * dt);
            if (npc.needs.thirstReserve <= 0) {
                npc.needs.dehydrationTimer += dt;
            } else {
                npc.needs.dehydrationTimer = Math.max(0, npc.needs.dehydrationTimer - dt * 2);
            }
        } else {
            npc.needs.dehydrationTimer = Math.max(0, npc.needs.dehydrationTimer - dt * 2);
            if (npc.needs.thirst > 50) {
                npc.needs.thirstReserve = Math.min(100, npc.needs.thirstReserve + RESERVE_REGEN_RATE * dt);
            }
        }

        // Health damage only after lethal timer threshold
        let damage = 0;
        if (npc.needs.starvationTimer > STARVATION_LETHAL_TIME) {
            // Damage accelerates the longer past threshold
            const overtime = npc.needs.starvationTimer - STARVATION_LETHAL_TIME;
            damage += HEALTH_DAMAGE_RATE * (1 + overtime / STARVATION_LETHAL_TIME);
        }
        if (npc.needs.dehydrationTimer > DEHYDRATION_LETHAL_TIME) {
            const overtime = npc.needs.dehydrationTimer - DEHYDRATION_LETHAL_TIME;
            damage += HEALTH_DAMAGE_RATE * (1 + overtime / DEHYDRATION_LETHAL_TIME);
        }

        if (damage > 0) {
            npc.needs.health = Math.max(0, npc.needs.health - damage * dt);
        } else if (npc.needs.hunger > HEALTH_REGEN_HUNGER_MIN && npc.needs.thirst > HEALTH_REGEN_THIRST_MIN && npc.needs.energy > HEALTH_REGEN_ENERGY_MIN) {
            npc.needs.health = Math.min(100, npc.needs.health + HEALTH_REGEN_RATE * dt);
        }
    }

    // Handle dead NPCs
    const dead = npcs.filter((npc) => npc.needs.health <= 0);

    for (const npc of dead) {
        // Create corpse
        scene.entities.push({
            id: `corpse-${npc.id}`,
            type: 'corpse',
            name: npc.name,
            sex: npc.sex,
            color: npc.color,
            position: { x: npc.position.x, y: npc.position.y },
        });

        // Release any locked resources
        for (const e of scene.entities) {
            if (e.type === 'resource' && e.lockedBy === npc.id) {
                e.lockedBy = null;
            }
        }

        // Remove from cabin residents
        if (npc.homeId) {
            const cabin = scene.entities.find(
                (e): e is BuildingEntity => e.type === 'building' && e.id === npc.homeId
            );
            if (cabin) {
                cabin.residentIds = cabin.residentIds.filter((id) => id !== npc.id);
            }
        }
    }

    // Remove dead NPCs
    scene.entities = scene.entities.filter((e) => {
        if (e.type === 'npc') return e.needs.health > 0;
        return true;
    });

    // Clean up empty cabins (no residents left) and their stocks
    const emptyCabinIds = new Set(
        scene.entities
            .filter((e): e is BuildingEntity => e.type === 'building' && e.residentIds.length === 0)
            .map((c) => c.id)
    );

    if (emptyCabinIds.size > 0) {
        scene.entities = scene.entities.filter((e) => {
            if (e.type === 'building' && emptyCabinIds.has(e.id)) return false;
            if (e.type === 'stock' && emptyCabinIds.has(e.cabinId)) return false;
            return true;
        });
    }
}

// Seasonal multipliers for resource spawn rates and capacity
// Index: 0=Printemps, 1=Été, 2=Automne, 3=Hiver
const SEASONAL_MULTIPLIERS: Record<ResourceType, [number, number, number, number]> = {
    food: [1.0, 1.3, 0.8, 0.3],  // abundant summer, scarce winter
    water: [1.0, 0.9, 1.0, 1.1],  // stable, slightly more in winter (rain/snow)
    wood: [1.0, 1.0, 1.0, 0.6],  // slightly less in winter
};

function processFertileZones(scene: Scene, dt: number) {
    const zones = scene.entities.filter(
        (e): e is FertileZoneEntity => e.type === 'fertile_zone'
    );

    const { seasonIndex } = getCalendar(scene.time);

    for (const zone of zones) {
        zone.spawnTimer -= dt;
        if (zone.spawnTimer > 0) continue;

        zone.spawnTimer = zone.spawnInterval;

        // Seasonal adjustment to capacity
        const seasonMult = SEASONAL_MULTIPLIERS[zone.resourceType]?.[seasonIndex] ?? 1;
        const effectiveCapacity = Math.max(1, Math.round(zone.capacity * seasonMult));

        const count = scene.entities.filter(
            (e) =>
                e.type === 'resource' &&
                e.resourceType === zone.resourceType &&
                distance(e.position, zone.position) <= zone.radius
        ).length;

        if (count >= effectiveCapacity) continue;

        const angle = Math.random() * Math.PI * 2;
        const dist = Math.random() * zone.radius;

        const itemDef = getItemDef(zone.resourceType);
        scene.entities.push({
            id: generateEntityId(),
            type: 'resource',
            resourceType: zone.resourceType,
            itemId: zone.resourceType,  // item registry ID matches resource type for legacy items
            position: {
                x: zone.position.x + Math.cos(angle) * dist,
                y: zone.position.y + Math.sin(angle) * dist,
            },
            color: itemDef?.color ?? RESOURCE_COLORS[zone.resourceType] ?? '#fff',
            lockedBy: null,
        });
    }
}

// --- Internal: terrain knowledge ---

const ZONE_MERGE_RADIUS = 120;

function memorizeResourceLocation(npc: NPCEntity, position: Vector2D, resourceType: ResourceType) {
    const existing = npc.knowledge.locations.find(
        (z) => z.resourceType === resourceType && distance(z.position, position) <= ZONE_MERGE_RADIUS
    );

    if (existing) {
        existing.position.x = (existing.position.x + position.x) / 2;
        existing.position.y = (existing.position.y + position.y) / 2;
        existing.confidence = Math.min(1, existing.confidence + 0.3);
        existing.source = 'firsthand';
    } else {
        npc.knowledge.locations.push({
            position: { x: position.x, y: position.y },
            resourceType,
            confidence: 1.0,
            source: 'firsthand',
        });
    }
}
