import { AGE_BABY, CABIN_WOOD_COST, KnownNPC, KnownZone, NPCEntity, ResourceType, SECONDS_PER_HOUR, Scene, StockEntity, WorldAPI, getLifeStage, getPartnerId, hasPartner, countItem, addItem, removeItem } from './Game.types';
import { getJobDef, getRecipesForJob, hasAllItems } from './Game.registry';
import type { RecipeDef } from './Game.registry';
import { resolveAttack, shouldFlee, ATTACK_RANGE, ATTACK_COOLDOWN, AGGRO_RANGE } from './Game.combat';
import { areFactionsHostile } from './Game.factions';
import { distance } from './Game.vector';
import { assessSelf, perceive } from './Game.perception';
import { createWorldAPI } from './Game.world';
import { DESIRE_THRESHOLD } from './Game.reproduction';
import { logger } from './Game.logger';

// --- AI Constants ---

const HUNGER_THRESHOLD = 60;         // go home to eat when below this
const ENERGY_CRITICAL = 40;          // go to sleep when energy below this
const CHILD_HOME_RANGE = 40;         // px — max distance before child walks home
const PARENTAL_STOCK_MIN = 5;        // stock count below which parents urgently gather
const PARENTAL_STOCK_MIN_BABY = 6;   // higher threshold when there's a baby
const WOOD_STOCKPILE_CAP = 5;        // max wood to stockpile at home
const SURVIVAL_HUNGER_MIN = 30;      // won't gather wood if hunger below this
const PROPOSE_DISTANCE = 25;         // px — close enough to propose
const STOCK_TARGET_FOOD = 8;         // stop gathering food when stock >= this
const STOCK_TARGET_WATER = 8;        // stop gathering water when stock >= this

// --- Resting constants ---

const REST_CHANCE = 0.4;             // probability of resting when all needs OK
const REST_MIN_HUNGER = 70;          // needs must be above this to rest
const REST_MIN_THIRST = 70;
const REST_MIN_ENERGY = 60;
const REST_MIN_DURATION = 1 * SECONDS_PER_HOUR;   // min rest: 1 game hour
const REST_MAX_DURATION = 3 * SECONDS_PER_HOUR;    // max rest: 3 game hours
const REST_WANDER_RANGE = 60;        // px — how far to wander while resting

// --- Social constants ---

const GREETING_RANGE = 100;          // px — communication range (larger than touch)
const GREETING_COOLDOWN = 15;        // seconds before can greet same NPC again
const AFFINITY_BOOST_BASE = 0.02;    // base affinity gain per greeting (slow buildup)
const GREET_BUBBLE_DURATION = 1.5;   // seconds to show greeting bubble
const KNOWLEDGE_SHARE_CONFIDENCE = 0.4; // confidence of shared zone info (hearsay)
const KNOWLEDGE_MERGE_RADIUS = 120;  // px — zones closer than this are merged

// --- Trade constants ---

const TRADE_SURPLUS_THRESHOLD = 5;   // stock above this is considered surplus
const TRADE_DEFICIT_THRESHOLD = 2;   // stock below this is a deficit worth trading for
const TRADE_RANGE = 150;             // px — range to detect potential trade partners
const TRADE_MIN_AFFINITY = 0.1;      // minimum affinity to trade with someone

// --- Exploration constants ---

const PREGNANT_RANGE_MULT = 0.3;     // exploration range multiplier when pregnant
const LOW_HEALTH_RANGE_MULT = 0.5;   // exploration range multiplier when low health
const LOW_HEALTH_THRESHOLD = 50;     // health below which exploration range shrinks

// --- Contextual modifiers ---

/**
 * Effective exploration range based on NPC's current state.
 * Acts as an implicit "feeling of security" — cautious when vulnerable.
 */
function getEffectiveExplorationRange(entity: NPCEntity): number {
    let range = entity.traits.explorationRange;

    // Pregnant → stay very close to home
    if (entity.reproduction.gestation !== null) {
        range *= PREGNANT_RANGE_MULT;
    }

    // Low health → stay closer
    if (entity.needs.health < LOW_HEALTH_THRESHOLD) {
        range *= LOW_HEALTH_RANGE_MULT;
    }

    return range;
}

// --- Main entry point ---

export function processAI(scene: Scene, dt: number) {
    const npcs = scene.entities.filter(
        (e): e is NPCEntity => e.type === 'npc'
    );

    for (const entity of npcs) {
        // Skip AI for the player — they are input-driven
        if (entity.isPlayer) continue;

        // Decrement attack cooldown
        if (entity.ai.attackCooldown > 0) {
            entity.ai.attackCooldown = Math.max(0, entity.ai.attackCooldown - dt);
        }

        entity.ai.tickAccumulator += dt;

        if (entity.ai.tickAccumulator >= entity.ai.tickInterval) {
            entity.ai.tickAccumulator -= entity.ai.tickInterval;
            const api = createWorldAPI(scene, entity);
            tickNpcAI(entity, api, scene);
        }
    }
}

// --- Tick: orchestrator ---

function tickNpcAI(entity: NPCEntity, api: WorldAPI, scene: Scene) {
    const stage = getLifeStage(entity.age);

    // Tick down visual greeting bubble
    if (entity.ai.greetBubbleTimer > 0) {
        entity.ai.greetBubbleTimer -= entity.ai.tickInterval;
    }

    // Babies: no AI, stay at home
    if (stage === 'baby') {
        stayAtHome(entity, api);
        return;
    }

    // Children: wander near home, no gathering
    if (stage === 'child') {
        stayAtHome(entity, api);
        tickGreetCooldowns(entity);
        trySocialGreeting(entity, api);
        return;
    }

    // Adolescents & Adults: full AI (with some gates)
    processMessages(entity, api, scene);
    tickGreetCooldowns(entity);
    trySocialGreeting(entity, api);

    if (entity.ai.state === 'idle') {
        decideNextAction(entity, api, scene);
    } else {
        handleActiveState(entity, api, scene);
    }
}

/** Keep baby/child positioned at home */
function stayAtHome(entity: NPCEntity, api: WorldAPI) {
    if (entity.movement) return; // already heading somewhere

    const cabin = api.getMyCabin();
    if (!cabin) return;

    // If too far from home, walk back
    if (cabin.distance > CHILD_HOME_RANGE) {
        api.moveTo(cabin.position);
    }
}

// (eating now only happens at home — see going_to_eat state)

// =======================================================
//  IDLE: priority-based decision
// =======================================================

function decideNextAction(entity: NPCEntity, api: WorldAPI, scene: Scene) {
    if (decideFight(entity, api, scene)) return;
    if (decideSurvival(entity, api)) return;
    if (decideMaternalCare(entity, api, scene)) return;
    if (decideParentalCare(entity, api, scene)) return;
    if (decideBuildHome(entity, api)) return;
    if (decideInventory(entity, api)) return;
    if (decideMate(entity, api)) return;
    if (decideCourt(entity, api)) return;
    if (decideTrade(entity, api, scene)) return;
    if (decideCraft(entity, api, scene)) return;
    if (decideRest(entity, api)) return;
    if (decideGather(entity, api)) return;
    if (decideGatherWood(entity, api)) return;
    decideExplore(entity, api);
}

/** Priority 1.5 — Parental care: if dependents at home and stock is low, gather urgently */
function decideParentalCare(entity: NPCEntity, api: WorldAPI, scene: Scene): boolean {
    if (getLifeStage(entity.age) !== 'adult') return false;

    // Do I have children (via knowledge relations)?
    const childIds = entity.knowledge.relations
        .filter((r) => r.type === 'child')
        .map((r) => r.targetId);

    if (childIds.length === 0) return false;

    // Higher threshold if there's a baby at home
    const hasLivingBaby = childIds.some((cid) => {
        const child = scene.entities.find(
            (e): e is NPCEntity => e.id === cid && e.type === 'npc'
        );
        return child && child.age < AGE_BABY;
    });
    const stockMin = hasLivingBaby ? PARENTAL_STOCK_MIN_BABY : PARENTAL_STOCK_MIN;

    // Check if home stock is critically low
    const foodCount = api.getStockCount('food');
    const waterCount = api.getStockCount('water');

    if (foodCount >= stockMin && waterCount >= stockMin) return false; // stock is fine

    // Urgent: go gather the most needed resource
    const resourceType = foodCount <= waterCount ? 'food' : 'water';
    const target = api.getNearest(resourceType);
    if (target) {
        entity.ai.targetId = target.id;
        api.moveTo(target.position);
        entity.ai.state = 'moving';
        logger.debug('AI', `${entity.name} parental care: gathering ${resourceType}`);
        return true;
    }

    // No visible resource → search known zones
    const knownZone = getBestKnownZone(entity, resourceType);
    if (knownZone) {
        api.moveTo(knownZone.position);
        entity.ai.state = 'searching';
        return true;
    }

    return false;
}

/** Priority 2 — Build home: homeless adult gathers wood, then builds cabin */
function decideBuildHome(entity: NPCEntity, api: WorldAPI): boolean {
    if (getLifeStage(entity.age) !== 'adult') return false;
    if (entity.homeId) return false; // already has a home

    // Don't gather wood if critically hungry or thirsty — survive first
    if (entity.needs.hunger < SURVIVAL_HUNGER_MIN || entity.needs.thirst < SURVIVAL_HUNGER_MIN) return false;

    // Count wood in inventory
    const woodCount = countItem(entity.inventory, 'wood');

    // Enough wood → build!
    if (woodCount >= CABIN_WOOD_COST) {
        api.stop();
        const built = api.buildCabin();
        if (built) {
            entity.ai.state = 'idle';
            return true;
        }
    }

    // Need more wood → go find some
    const target = api.getNearest('wood');
    if (target) {
        entity.ai.targetId = target.id;
        api.moveTo(target.position);
        entity.ai.state = 'moving';
        logger.debug('AI', `${entity.name} gathering wood for home (${woodCount}/${CABIN_WOOD_COST})`);
        return true;
    }

    // No visible wood → search known wood zones
    const knownZone = getBestKnownZone(entity, 'wood');
    if (knownZone) {
        api.moveTo(knownZone.position);
        entity.ai.state = 'searching';
        return true;
    }

    // No wood found anywhere → explore to find some
    return false;
}

/** Priority 0 — Combat: check for hostile NPCs nearby */
function decideFight(entity: NPCEntity, api: WorldAPI, scene: Scene): boolean {
    if (getLifeStage(entity.age) !== 'adult') return false;
    if (entity.ai.attackCooldown > 0) return false;

    // Check for hostile NPCs in aggro range
    const nearbyNpcs = api.getNearbyNPCs(AGGRO_RANGE);

    for (const other of nearbyNpcs) {
        const otherNpc = scene.entities.find(
            (e): e is NPCEntity => e.id === other.id && e.type === 'npc'
        );
        if (!otherNpc) continue;
        if (getLifeStage(otherNpc.age) !== 'adult') continue;

        // Check faction hostility
        if (!areFactionsHostile(entity, otherNpc)) continue;

        // Decide fight or flee
        if (shouldFlee(entity, otherNpc)) {
            // Flee: move away from enemy
            const dx = entity.position.x - otherNpc.position.x;
            const dy = entity.position.y - otherNpc.position.y;
            const len = Math.sqrt(dx * dx + dy * dy) || 1;
            const fleeTarget = {
                x: entity.position.x + (dx / len) * 200,
                y: entity.position.y + (dy / len) * 200,
            };
            api.moveTo(fleeTarget);
            entity.ai.state = 'fleeing';
            entity.ai.targetId = other.id;
            logger.info('AI', `${entity.name} flees from ${otherNpc.name}!`);
            return true;
        }

        // Fight: engage
        entity.ai.targetId = other.id;
        entity.ai.state = 'fighting';
        api.moveTo(otherNpc.position);
        logger.info('AI', `${entity.name} engages ${otherNpc.name} in combat!`);
        return true;
    }

    return false;
}

/** Priority 1 — Survival: energy critical → sleep, hungry/thirsty → go home to eat */
function decideSurvival(entity: NPCEntity, api: WorldAPI): boolean {
    // Energy critical → go sleep
    if (entity.needs.energy < ENERGY_CRITICAL) {
        const cabin = api.getMyCabin();
        if (cabin) {
            api.moveTo(cabin.position);
            entity.ai.state = 'going_to_cabin';
            return true;
        }
    }

    // Hungry or thirsty → go home to eat from stock
    const hungry = entity.needs.hunger < HUNGER_THRESHOLD;
    const thirsty = entity.needs.thirst < HUNGER_THRESHOLD;

    if (hungry || thirsty) {
        const cabin = api.getMyCabin();
        if (cabin) {
            api.moveTo(cabin.position);
            entity.ai.state = 'going_to_eat';
            logger.debug('AI', `${entity.name} hungry/thirsty → going home to eat`);
            return true;
        }
    }

    return false;
}

/** Priority 2 — Inventory full → return to stock to deposit */
function decideInventory(entity: NPCEntity, api: WorldAPI): boolean {
    if (entity.inventory.length < entity.traits.carryCapacity) return false;

    const stock = api.getMyStock();
    if (!stock) return false;

    api.moveTo(stock.position);
    entity.ai.state = 'returning';
    return true;
}

/** Priority 2.5 — Mate: partnered adult with high desire → go home to mate */
function decideMate(entity: NPCEntity, api: WorldAPI): boolean {
    if (entity.sex !== 'male') return false;
    if (getLifeStage(entity.age) !== 'adult') return false;
    if (!hasPartner(entity)) return false;
    if (entity.reproduction.desire < DESIRE_THRESHOLD) return false;

    const cabin = api.getMyCabin();
    if (!cabin) return false;

    // Head home for mating
    logger.info('AI', `${entity.name} desire=${Math.round(entity.reproduction.desire)} → going home to mate`);
    api.moveTo(cabin.position);
    entity.ai.state = 'going_to_mate';
    return true;
}

/** Priority 3 — Court: single male adult with high desire → court a female to form couple */
function decideCourt(entity: NPCEntity, api: WorldAPI): boolean {
    if (entity.sex !== 'male') return false;
    if (getLifeStage(entity.age) !== 'adult') return false;
    if (hasPartner(entity)) return false; // already in a couple → use decideMate
    if (entity.reproduction.desire < DESIRE_THRESHOLD) return false;

    const mate = api.getNearestMate();
    if (!mate) {
        logger.debug('AI', `${entity.name} desire=${Math.round(entity.reproduction.desire)} but no female in range`);
        return false;
    }

    logger.info('AI', `${entity.name} desire=${Math.round(entity.reproduction.desire)} → courting (dist=${Math.round(mate.distance)})`);
    api.sendMessage(mate.id, { type: 'court_request', fromId: entity.id });
    entity.ai.targetId = mate.id;
    api.moveTo(mate.position);
    entity.ai.state = 'courting';
    return true;
}

/** Priority 1.2 — Maternal care: mother stays home with baby (age < AGE_BABY) */
function decideMaternalCare(entity: NPCEntity, api: WorldAPI, scene: Scene): boolean {
    if (entity.sex !== 'female') return false;
    if (getLifeStage(entity.age) !== 'adult') return false;

    // Check if I have a living baby (age < AGE_BABY)
    const childIds = entity.knowledge.relations
        .filter((r) => r.type === 'child')
        .map((r) => r.targetId);

    if (childIds.length === 0) return false;

    const hasLivingBaby = childIds.some((cid) => {
        const child = scene.entities.find(
            (e): e is NPCEntity => e.id === cid && e.type === 'npc'
        );
        return child && child.age < AGE_BABY;
    });

    if (!hasLivingBaby) return false;

    const cabin = api.getMyCabin();
    if (!cabin) return false;

    // Stay near home
    if (cabin.distance > CHILD_HOME_RANGE) {
        api.moveTo(cabin.position);
        entity.ai.state = 'returning';
        return true;
    }

    // Rest near the baby
    entity.ai.state = 'resting';
    entity.ai.restTimer = REST_MIN_DURATION;
    return true;
}

/** Priority 3.5 — Rest: chill near home when all needs and stocks are OK */
function decideRest(entity: NPCEntity, api: WorldAPI): boolean {
    if (!entity.homeId) return false;

    // All needs must be comfortable
    if (entity.needs.hunger < REST_MIN_HUNGER) return false;
    if (entity.needs.thirst < REST_MIN_THIRST) return false;
    if (entity.needs.energy < REST_MIN_ENERGY) return false;

    // Stock must be sufficient
    const foodCount = api.getStockCount('food');
    const waterCount = api.getStockCount('water');
    if (foodCount < STOCK_TARGET_FOOD || waterCount < STOCK_TARGET_WATER) return false;

    // Random chance to rest
    if (Math.random() > REST_CHANCE) return false;

    const duration = REST_MIN_DURATION + Math.random() * (REST_MAX_DURATION - REST_MIN_DURATION);
    entity.ai.restTimer = duration;
    entity.ai.state = 'resting';
    logger.debug('AI', `${entity.name} decides to rest for ${Math.round(duration / SECONDS_PER_HOUR)}h`);
    return true;
}

// =======================================================
//  CRAFTING: use recipes when resources are available
// =======================================================

const CRAFT_CHECK_CHANCE = 0.3;  // 30% chance per AI tick to check crafting

/** Priority 3.3 — Craft: if NPC has a job and the right resources in stock, start crafting */
function decideCraft(entity: NPCEntity, api: WorldAPI, scene: Scene): boolean {
    if (!entity.job) return false;
    if (getLifeStage(entity.age) !== 'adult') return false;
    if (!entity.homeId) return false;

    // Don't always check — save CPU
    if (Math.random() > CRAFT_CHECK_CHANCE) return false;

    // Must be near home
    const cabin = api.getMyCabin();
    if (!cabin || cabin.distance > 50) return false;

    // Get recipes this job can do
    const recipes = getRecipesForJob(entity.job);
    if (recipes.length === 0) return false;

    // Check stock for required inputs
    const stock = scene.entities.find(
        (e): e is StockEntity => e.type === 'stock' && e.cabinId === entity.homeId
    );
    if (!stock) return false;

    // Check building requirement
    const nearbyBuildings = api.getNearbyBuildings(100);

    for (const recipe of recipes) {
        // Check building
        if (recipe.requiredBuilding) {
            const hasBuilding = nearbyBuildings.some((b) => b.buildingType === recipe.requiredBuilding);
            if (!hasBuilding) continue;
        }

        // Check inputs
        if (!hasAllItems(stock.items, recipe.inputs)) continue;

        // Start crafting!
        logger.info('CRAFT', `${entity.name} starts crafting ${recipe.displayName}`);
        entity.ai.state = 'crafting';

        // Move to stock if not already there
        const myStock = api.getMyStock();
        if (myStock && myStock.distance > 20) {
            api.moveTo(myStock.position);
        }

        // Start the craft action via API
        api.craft(recipe.id);
        return true;
    }

    return false;
}

// =======================================================
//  TRADE: barter surplus for deficit
// =======================================================

type StockBalance = {
    food: number;
    water: number;
    wood: number;
    surplus: string[];   // item IDs we have too much of
    deficit: string[];   // item IDs we need
};

function evaluateStock(api: WorldAPI): StockBalance {
    const food = api.getStockCount('food');
    const water = api.getStockCount('water');
    const wood = api.getStockCount('wood');

    const surplus: string[] = [];
    const deficit: string[] = [];

    if (food > TRADE_SURPLUS_THRESHOLD) surplus.push('food');
    if (water > TRADE_SURPLUS_THRESHOLD) surplus.push('water');
    if (wood > TRADE_SURPLUS_THRESHOLD) surplus.push('wood');

    if (food < TRADE_DEFICIT_THRESHOLD) deficit.push('food');
    if (water < TRADE_DEFICIT_THRESHOLD) deficit.push('water');
    // wood is less critical, only trade if really low
    if (wood < 1) deficit.push('wood');

    return { food, water, wood, surplus, deficit };
}

function evaluateOtherStock(scene: Scene, npcId: string): StockBalance | null {
    const npc = scene.entities.find(
        (e): e is NPCEntity => e.id === npcId && e.type === 'npc'
    );
    if (!npc || !npc.homeId) return null;

    const stock = scene.entities.find(
        (e): e is StockEntity => e.type === 'stock' && e.cabinId === npc.homeId
    );
    if (!stock) return null;

    const food = countItem(stock.items, 'food');
    const water = countItem(stock.items, 'water');
    const wood = countItem(stock.items, 'wood');

    const surplus: string[] = [];
    const deficit: string[] = [];

    if (food > TRADE_SURPLUS_THRESHOLD) surplus.push('food');
    if (water > TRADE_SURPLUS_THRESHOLD) surplus.push('water');
    if (wood > TRADE_SURPLUS_THRESHOLD) surplus.push('wood');

    if (food < TRADE_DEFICIT_THRESHOLD) deficit.push('food');
    if (water < TRADE_DEFICIT_THRESHOLD) deficit.push('water');
    if (wood < 1) deficit.push('wood');

    return { food, water, wood, surplus, deficit };
}

/**
 * Priority 3.5 — Trade: if I have a surplus and a deficit, find a neighbor
 * who has the opposite and initiate barter.
 *
 * Flow:
 *  1. Go home to pick up surplus item
 *  2. Go to trade partner
 *  3. Give surplus, receive deficit via trade_offer message
 */
function decideTrade(entity: NPCEntity, api: WorldAPI, scene: Scene): boolean {
    if (!entity.homeId) return false;
    if (getLifeStage(entity.age) !== 'adult') return false;

    const myBalance = evaluateStock(api);
    if (myBalance.surplus.length === 0 || myBalance.deficit.length === 0) return false;

    // Find a nearby NPC who has what I need and needs what I have
    const nearbyNpcs = api.getNearbyNPCs(TRADE_RANGE);

    for (const other of nearbyNpcs) {
        // Must have some affinity
        const known = entity.knowledge.npcs.find((n) => n.id === other.id);
        if (!known || known.affinity < TRADE_MIN_AFFINITY) continue;

        const otherBalance = evaluateOtherStock(scene, other.id);
        if (!otherBalance) continue;

        // Find a matching trade: my surplus → their deficit, their surplus → my deficit
        for (const offer of myBalance.surplus) {
            if (!otherBalance.deficit.includes(offer)) continue;

            for (const want of myBalance.deficit) {
                if (!otherBalance.surplus.includes(want)) continue;

                // Match found! Go home to pick up the surplus
                logger.info('TRADE', `${entity.name} wants to trade ${offer} for ${want} with NPC ${other.id}`);

                // Store trade info in AI state
                entity.ai.targetId = other.id;
                entity.ai.tradeOffer = offer;
                entity.ai.tradeWant = want;

                // Go home first to pick up the surplus item
                const cabin = api.getMyCabin();
                if (cabin && cabin.distance > 30) {
                    api.moveTo(cabin.position);
                } // else already at home
                entity.ai.state = 'trading';
                entity.ai.tradePhase = 'going_home';
                return true;
            }
        }
    }

    return false;
}

/** Priority 4 — Gather: find visible resource, or go to a known zone */
function decideGather(entity: NPCEntity, api: WorldAPI): boolean {
    // Don't gather if stocks are already at target
    const foodCount = api.getStockCount('food');
    const waterCount = api.getStockCount('water');
    if (foodCount >= STOCK_TARGET_FOOD && waterCount >= STOCK_TARGET_WATER) return false;

    const resourceType = chooseResourceType(entity, api);

    // Explorer-type NPCs sometimes prefer scouting a known zone even if a resource is visible
    // This creates natural specialization: scouts explore while gatherers pick up nearby resources
    const isExplorer = prefersExploration(entity);

    if (!isExplorer) {
        // Gatherer: grab nearest visible resource first
        const target = api.getNearest(resourceType);
        if (target) {
            entity.ai.targetId = target.id;
            api.moveTo(target.position);
            entity.ai.state = 'moving';
            return true;
        }
    }

    // Go to best known zone for this resource (scan while moving)
    const knownZone = getBestKnownZone(entity, resourceType);
    if (knownZone) {
        api.moveTo(knownZone.position);
        entity.ai.state = 'searching';
        return true;
    }

    // Explorer fallback or no known zones: try direct grab
    if (isExplorer) {
        const target = api.getNearest(resourceType);
        if (target) {
            entity.ai.targetId = target.id;
            api.moveTo(target.position);
            entity.ai.state = 'moving';
            return true;
        }
    }

    return false;
}

/** Priority 5 — Gather wood: when food/water stock is stable, gather wood as secondary resource */
function decideGatherWood(entity: NPCEntity, api: WorldAPI): boolean {
    if (getLifeStage(entity.age) !== 'adult' && getLifeStage(entity.age) !== 'adolescent') return false;
    if (!entity.homeId) return false; // homeless → decideBuildHome handles this

    // Only gather wood when food/water stock is ok
    const foodCount = api.getStockCount('food');
    const waterCount = api.getStockCount('water');
    if (foodCount < PARENTAL_STOCK_MIN || waterCount < PARENTAL_STOCK_MIN) return false;

    // Already have enough wood? skip
    const woodInStock = api.getStockCount('wood');
    if (woodInStock >= WOOD_STOCKPILE_CAP) return false;

    const target = api.getNearest('wood');
    if (target) {
        entity.ai.targetId = target.id;
        api.moveTo(target.position);
        entity.ai.state = 'moving';
        return true;
    }

    const knownZone = getBestKnownZone(entity, 'wood');
    if (knownZone) {
        api.moveTo(knownZone.position);
        entity.ai.state = 'searching';
        return true;
    }

    return false;
}

/** Fallback — Explore: nothing visible, wander randomly around home */
function decideExplore(entity: NPCEntity, api: WorldAPI) {
    // Anchor exploration around the NPC's cabin (home)
    const cabin = api.getMyCabin();
    const homeX = cabin ? cabin.position.x : 0;
    const homeY = cabin ? cabin.position.y : 0;

    const angle = Math.random() * Math.PI * 2;
    const exploreDist = entity.traits.visionRange * (0.5 + Math.random() * 0.5);
    let targetX = entity.position.x + Math.cos(angle) * exploreDist;
    let targetY = entity.position.y + Math.sin(angle) * exploreDist;

    // Soft pull towards home — explorationRange limits how far they wander
    const dx = targetX - homeX;
    const dy = targetY - homeY;
    const distFromHome = Math.sqrt(dx * dx + dy * dy);

    const maxRoam = getEffectiveExplorationRange(entity);

    if (distFromHome > maxRoam) {
        const scale = maxRoam / distFromHome;
        targetX = homeX + dx * scale;
        targetY = homeY + dy * scale;
    }

    api.moveTo({ x: targetX, y: targetY });
    entity.ai.state = 'searching';
}

// =======================================================
//  ACTIVE STATE HANDLERS
// =======================================================

function handleActiveState(entity: NPCEntity, api: WorldAPI, scene: Scene) {
    switch (entity.ai.state) {
        case 'moving': return handleMoving(entity, api);
        case 'taking': return handleTaking(entity, api);
        case 'searching': return handleSearching(entity, api);
        case 'going_to_cabin': return handleGoingToCabin(entity, api);
        case 'going_to_eat': return handleGoingToEat(entity, api);
        case 'sleeping': return handleSleeping(entity, api);
        case 'resting': return handleResting(entity, api);
        case 'trading': return handleTrading(entity, api, scene);
        case 'returning': return handleReturning(entity, api);
        case 'courting': return handleCourting(entity, api);
        case 'going_to_mate': return handleGoingToMate(entity, api, scene);
        case 'mating': return handleMating(entity);
        case 'waiting_for_mate': return handleWaitingForMate(entity, api);
        case 'crafting': return handleCrafting(entity);
        case 'fighting': return handleFighting(entity, api, scene);
        case 'fleeing': return handleFleeing(entity, api);
    }
}

/** Moving towards a resource target; when arrived, try to take it */
function handleMoving(entity: NPCEntity, api: WorldAPI) {
    const target = entity.ai.targetId ? api.getEntity(entity.ai.targetId) : null;

    if (!target) {
        api.stop();
        entity.ai.targetId = null;
        entity.ai.state = 'idle';
        return;
    }

    // Arrived → take
    if (!entity.movement) {
        const started = api.take(target.id);
        if (started) {
            entity.ai.state = 'taking';
        } else {
            entity.ai.targetId = null;
            entity.ai.state = 'idle';
        }
    }
}

/** Waiting for take action to complete */
function handleTaking(entity: NPCEntity, api: WorldAPI) {
    if (entity.action) return;

    entity.ai.targetId = null;

    // Inventory full after take? → return to stock
    if (entity.inventory.length >= entity.traits.carryCapacity) {
        const stock = api.getMyStock();
        if (stock) {
            api.moveTo(stock.position);
            entity.ai.state = 'returning';
            return;
        }
    }

    entity.ai.state = 'idle';
}

/** Exploring / heading to known zone; actively scan for resources each tick */
function handleSearching(entity: NPCEntity, api: WorldAPI) {
    const resourceType = chooseResourceType(entity, api);
    const spotted = api.getNearest(resourceType);

    if (spotted) {
        api.stop();
        entity.ai.targetId = spotted.id;
        api.moveTo(spotted.position);
        entity.ai.state = 'moving';
        return;
    }

    // Reached destination without finding anything
    if (!entity.movement) {
        // Degrade confidence of nearby known zones (the spot was empty)
        degradeNearbyZones(entity, resourceType);
        entity.ai.state = 'idle';
    }
}

/** Heading to cabin; when arrived, start sleeping */
function handleGoingToCabin(entity: NPCEntity, api: WorldAPI) {
    if (entity.movement) return;

    // Deposit inventory before sleeping
    api.deposit();
    const started = api.sleep();
    entity.ai.state = started ? 'sleeping' : 'idle';
}

/** Going home to eat; when arrived, deposit inventory then consume from stock */
function handleGoingToEat(entity: NPCEntity, api: WorldAPI) {
    if (entity.movement) return;

    // Deposit anything we're carrying
    api.deposit();

    // Eat/drink from stock
    if (entity.needs.hunger < HUNGER_THRESHOLD) api.consume('food');
    if (entity.needs.thirst < HUNGER_THRESHOLD) api.consume('water');

    entity.ai.state = 'idle';
}

/** Sleeping; wake up when energy is well restored */
function handleSleeping(entity: NPCEntity, api: WorldAPI) {
    if (entity.needs.energy >= 95) {
        api.wakeUp();
        entity.ai.state = 'idle';
    }
}

/** Resting: wander gently near home, interrupt if a need drops */
function handleResting(entity: NPCEntity, api: WorldAPI) {
    entity.ai.restTimer -= entity.ai.tickInterval;

    // Interrupt if a need is getting low
    if (entity.needs.hunger < HUNGER_THRESHOLD || entity.needs.thirst < HUNGER_THRESHOLD || entity.needs.energy < ENERGY_CRITICAL) {
        entity.ai.state = 'idle';
        entity.ai.restTimer = 0;
        return;
    }

    // Timer expired
    if (entity.ai.restTimer <= 0) {
        entity.ai.state = 'idle';
        return;
    }

    // Wander gently near home
    if (!entity.movement) {
        const cabin = api.getMyCabin();
        if (cabin) {
            const angle = Math.random() * Math.PI * 2;
            const dist = Math.random() * REST_WANDER_RANGE;
            api.moveTo({
                x: cabin.position.x + Math.cos(angle) * dist,
                y: cabin.position.y + Math.sin(angle) * dist,
            });
        }
    }
}

/** Trading: multi-phase barter flow */
function handleTrading(entity: NPCEntity, api: WorldAPI, scene: Scene) {
    const { tradeOffer, tradeWant, tradePhase } = entity.ai;
    if (!tradeOffer || !tradeWant || !tradePhase) {
        cancelTrade(entity);
        return;
    }

    const partnerId = entity.ai.targetId;
    if (!partnerId) { cancelTrade(entity); return; }

    // Check partner still exists
    const partner = scene.entities.find(
        (e): e is NPCEntity => e.id === partnerId && e.type === 'npc'
    );
    if (!partner) { cancelTrade(entity); return; }

    switch (tradePhase) {
        case 'going_home': {
            if (entity.movement) return; // still walking

            // At home — withdraw the surplus item from stock
            const withdrawn = api.withdrawFromStock(tradeOffer);
            if (!withdrawn) {
                logger.debug('TRADE', `${entity.name}: can't withdraw ${tradeOffer}, cancelling trade`);
                cancelTrade(entity);
                return;
            }

            // Now go to the trade partner
            api.moveTo(partner.position);
            entity.ai.tradePhase = 'going_to_partner';
            return;
        }

        case 'going_to_partner': {
            // Track live position of partner
            const partnerInfo = api.getEntity(partnerId);
            if (!partnerInfo) { cancelTrade(entity); return; }

            if (partnerInfo.distance > 30) {
                api.moveTo(partnerInfo.position);
                return;
            }

            // Arrived near partner — send trade offer
            api.sendMessage(partnerId, {
                type: 'trade_offer',
                fromId: entity.id,
                offer: tradeOffer,
                want: tradeWant,
            });

            entity.ai.tradePhase = 'exchanging';
            return;
        }

        case 'exchanging': {
            // Give my item to partner
            const gave = api.giveItem(partnerId, tradeOffer);
            if (!gave) {
                logger.debug('TRADE', `${entity.name}: can't give ${tradeOffer}, aborting`);
                cancelTrade(entity);
                return;
            }

            // Check if partner has the item I want in their inventory (they picked it up from the message handler)
            const hasWanted = countItem(partner.inventory, tradeWant) > 0;
            if (hasWanted) {
                // Partner gives me the item
                removeItem(partner.inventory, tradeWant, 1);
                addItem(entity.inventory, tradeWant, 1);
                logger.info('TRADE', `${entity.name} traded ${tradeOffer} for ${tradeWant} with ${partner.name}`);

                // Boost affinity for both
                const myKnown = entity.knowledge.npcs.find((n) => n.id === partnerId);
                if (myKnown) myKnown.affinity = Math.min(1, myKnown.affinity + 0.05);
                const theirKnown = partner.knowledge.npcs.find((n) => n.id === entity.id);
                if (theirKnown) theirKnown.affinity = Math.min(1, theirKnown.affinity + 0.05);
            } else {
                logger.debug('TRADE', `${entity.name}: partner didn't have ${tradeWant}, one-way gift`);
            }

            // Done — go home to deposit
            cancelTrade(entity);
            const cabin = api.getMyCabin();
            if (cabin) {
                api.moveTo(cabin.position);
                entity.ai.state = 'returning';
            }
            return;
        }
    }
}

function cancelTrade(entity: NPCEntity) {
    entity.ai.state = 'idle';
    entity.ai.targetId = null;
    entity.ai.tradeOffer = null;
    entity.ai.tradeWant = null;
    entity.ai.tradePhase = null;
}

/** Returning to stock; deposit when arrived */
function handleReturning(entity: NPCEntity, api: WorldAPI) {
    if (entity.movement) return;

    api.deposit();
    entity.ai.state = 'idle';
}

/** Male actively pursuing a female to form a couple; propose when close enough */
function handleCourting(entity: NPCEntity, api: WorldAPI) {
    const target = entity.ai.targetId ? api.getEntity(entity.ai.targetId) : null;

    if (!target) {
        logger.debug('AI', `${entity.name} courting: target disappeared`);
        api.stop();
        entity.ai.targetId = null;
        entity.ai.state = 'idle';
        return;
    }

    // Active pursuit: track live position
    api.moveTo(target.position);

    // Close enough → propose to form a couple (not mate immediately)
    if (target.distance <= PROPOSE_DISTANCE) {
        api.stop();
        const accepted = api.propose(target.id);

        if (accepted) {
            // Couple formed! Go back to idle — mating will happen later at home
            logger.info('AI', `${entity.name} → couple formed with ${target.id}!`);
            entity.reproduction.desire *= 0.3; // desire partially satisfied by forming couple
            entity.ai.targetId = null;
            entity.ai.state = 'idle';
        } else {
            logger.info('AI', `${entity.name} → rejected, desire halved`);
            entity.reproduction.desire *= 0.5;
            entity.ai.targetId = null;
            entity.ai.state = 'idle';
        }
    }
}

/** Male going home to mate with partner; when arrived, propose mating */
function handleGoingToMate(entity: NPCEntity, api: WorldAPI, scene: Scene) {
    if (entity.movement) return; // still walking

    // We're home — find partner
    const partnerId = getPartnerId(entity);
    if (!partnerId) {
        entity.ai.state = 'idle';
        return;
    }

    const partner = scene.entities.find(
        (e): e is NPCEntity => e.id === partnerId && e.type === 'npc'
    );
    if (!partner) {
        entity.ai.state = 'idle';
        return;
    }

    // Partner must be nearby (at home too)
    const dist = api.getEntity(partnerId);
    if (!dist || dist.distance > PROPOSE_DISTANCE * 2) {
        // Partner is not home — wait a bit then give up
        logger.debug('AI', `${entity.name}: partner not home, going idle`);
        entity.ai.state = 'idle';
        return;
    }

    // Partner must not be busy
    if (partner.action !== null) {
        entity.ai.state = 'idle';
        return;
    }

    // Propose mating
    const accepted = api.propose(partnerId);
    if (accepted) {
        logger.info('AI', `${entity.name} → mating at home!`);
        entity.ai.state = 'mating';
    } else {
        entity.reproduction.desire *= 0.7;
        entity.ai.state = 'idle';
    }
}

/** Waiting for mating action to complete */
function handleMating(entity: NPCEntity) {
    if (!entity.action) {
        entity.ai.targetId = null;
        entity.ai.state = 'idle';
    }
}

/** Fighting: move towards enemy and attack when in range */
function handleFighting(entity: NPCEntity, api: WorldAPI, scene: Scene) {
    const target = entity.ai.targetId ? scene.entities.find(
        (e): e is NPCEntity => e.id === entity.ai.targetId && e.type === 'npc'
    ) : null;

    // Target gone or dead
    if (!target || target.needs.health <= 0) {
        entity.ai.targetId = null;
        entity.ai.state = 'idle';
        return;
    }

    // Should we flee now?
    if (shouldFlee(entity, target)) {
        const dx = entity.position.x - target.position.x;
        const dy = entity.position.y - target.position.y;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        api.moveTo({
            x: entity.position.x + (dx / len) * 200,
            y: entity.position.y + (dy / len) * 200,
        });
        entity.ai.state = 'fleeing';
        return;
    }

    const dist = Math.sqrt(
        (entity.position.x - target.position.x) ** 2 +
        (entity.position.y - target.position.y) ** 2
    );

    if (dist > ATTACK_RANGE) {
        // Move closer
        api.moveTo(target.position);
    } else {
        // In range — attack
        api.stop();
        if (entity.ai.attackCooldown <= 0) {
            resolveAttack(entity, target);
            entity.ai.attackCooldown = ATTACK_COOLDOWN;
        }
    }
}

/** Fleeing: run away, return to idle when far enough */
function handleFleeing(entity: NPCEntity, api: WorldAPI) {
    if (!entity.movement) {
        // Arrived at flee destination, go idle
        entity.ai.targetId = null;
        entity.ai.state = 'idle';
    }
}

/** Crafting: just wait for the action to complete */
function handleCrafting(entity: NPCEntity) {
    if (!entity.action) {
        // Action completed (completeCraftAction already handled outputs)
        entity.ai.craftRecipeId = null;
        entity.ai.state = 'idle';
    }
}

/** Female waiting for a male to arrive (after accepting court_request) */
function handleWaitingForMate(entity: NPCEntity, api: WorldAPI) {
    const mate = entity.ai.targetId ? api.getEntity(entity.ai.targetId) : null;

    if (!mate) {
        logger.debug('AI', `${entity.name} waiting_for_mate: male disappeared`);
        entity.ai.targetId = null;
        entity.ai.state = 'idle';
    }
}

// =======================================================
//  SOCIAL: GREETINGS & AFFINITY
// =======================================================

/** Tick down greeting cooldowns for all known NPCs */
function tickGreetCooldowns(entity: NPCEntity) {
    for (const known of entity.knowledge.npcs) {
        if (known.greetCooldown > 0) {
            known.greetCooldown -= entity.ai.tickInterval;
            if (known.greetCooldown < 0) known.greetCooldown = 0;
        }
    }
}

/** Proactively greet a nearby NPC (if not busy with critical tasks) */
function trySocialGreeting(entity: NPCEntity, api: WorldAPI) {
    // Don't greet while sleeping, going to sleep, or mating
    if (entity.action?.type === 'sleep' || entity.action?.type === 'mating') return;
    if (entity.ai.state === 'sleeping' || entity.ai.state === 'going_to_cabin') return;

    const nearby = api.getNearbyNPCs(GREETING_RANGE);
    if (nearby.length === 0) return;

    // Sociability factor: charisma makes NPCs greet more readily
    // Low charisma NPCs have a chance to skip greeting this tick
    if (Math.random() > 0.3 + entity.traits.charisma * 0.7) return;

    for (const other of nearby) {
        const known = getOrCreateKnownNPC(entity, other.id);
        if (known.greetCooldown > 0) continue;

        // Greet! Charisma of the greeter increases the affinity boost
        const boost = AFFINITY_BOOST_BASE * (1 + entity.traits.charisma * 0.5);
        known.affinity = Math.min(1, known.affinity + boost);
        known.greetCooldown = GREETING_COOLDOWN;

        // Show greeting bubble on the greeter
        entity.ai.greetBubbleTimer = GREET_BUBBLE_DURATION;

        // Send greeting message to the other NPC
        api.sendMessage(other.id, { type: 'greeting', fromId: entity.id });

        logger.debug('SOCIAL', `${entity.name} greets ${other.id} (affinity→${known.affinity.toFixed(2)})`);
        break; // Only greet one NPC per tick
    }
}

/** Get or create a KnownNPC entry for a given target */
function getOrCreateKnownNPC(entity: NPCEntity, targetId: string): KnownNPC {
    let known = entity.knowledge.npcs.find((n) => n.id === targetId);
    if (!known) {
        known = { id: targetId, affinity: 0, greetCooldown: 0 };
        entity.knowledge.npcs.push(known);
    }
    return known;
}

/** Handle receiving a greeting: boost affinity for the sender + share knowledge */
function handleGreeting(entity: NPCEntity, fromId: string, scene: Scene) {
    const known = getOrCreateKnownNPC(entity, fromId);

    // Receiver's charisma influences how warmly they respond
    const boost = AFFINITY_BOOST_BASE * (1 + entity.traits.charisma * 0.3);
    known.affinity = Math.min(1, known.affinity + boost);

    // Show greeting bubble on receiver too
    entity.ai.greetBubbleTimer = GREET_BUBBLE_DURATION;

    // Knowledge sharing: the sender shares their best zones with the receiver
    const sender = scene.entities.find(
        (e): e is NPCEntity => e.id === fromId && e.type === 'npc'
    );
    if (sender) {
        shareKnowledge(sender, entity);
    }

    logger.debug('SOCIAL', `${entity.name} greeted by ${fromId} (affinity→${known.affinity.toFixed(2)})`);
}

/** Share known zone locations from sender to receiver (as hearsay) */
function shareKnowledge(sender: NPCEntity, receiver: NPCEntity) {
    for (const zone of sender.knowledge.locations) {
        if (zone.confidence < 0.3) continue; // don't share low-confidence info

        // Check if receiver already knows a zone nearby
        const existing = receiver.knowledge.locations.find(
            (z) => z.resourceType === zone.resourceType
                && distance(z.position, zone.position) <= KNOWLEDGE_MERGE_RADIUS
        );

        if (existing) {
            // Merge: boost confidence slightly if sender knows better
            if (zone.confidence > existing.confidence) {
                existing.confidence = Math.min(1, existing.confidence + 0.1);
                if (zone.source === 'firsthand' && existing.source === 'hearsay') {
                    // Upgrade position accuracy towards sender's firsthand knowledge
                    existing.position.x = (existing.position.x + zone.position.x) / 2;
                    existing.position.y = (existing.position.y + zone.position.y) / 2;
                }
            }
        } else {
            // New zone info — add as hearsay
            receiver.knowledge.locations.push({
                position: { x: zone.position.x, y: zone.position.y },
                resourceType: zone.resourceType as ResourceType,
                confidence: Math.min(zone.confidence, KNOWLEDGE_SHARE_CONFIDENCE),
                source: 'hearsay',
            });
        }
    }
}

// =======================================================
//  MESSAGE PROCESSING
// =======================================================

function processMessages(entity: NPCEntity, api: WorldAPI, scene: Scene) {
    if (entity.messages.length === 0) return;

    for (const msg of entity.messages) {
        if (msg.type === 'court_request') {
            handleCourtRequest(entity, api, msg.fromId, scene);
        } else if (msg.type === 'greeting') {
            handleGreeting(entity, msg.fromId, scene);
        } else if (msg.type === 'trade_offer') {
            handleTradeOffer(entity, api, msg, scene);
        }
    }

    entity.messages = [];
}

/** Handle a trade_offer: prepare the requested item in inventory for exchange */
function handleTradeOffer(entity: NPCEntity, api: WorldAPI, msg: { fromId: string; offer: string; want: string }, scene: Scene) {
    // They are offering msg.offer and want msg.want from me
    // Check if I have a surplus of what they want
    const myStock = evaluateOtherStock(scene, entity.id);
    if (!myStock) return;

    const count = msg.want === 'food' ? myStock.food : msg.want === 'water' ? myStock.water : myStock.wood;
    if (count <= TRADE_DEFICIT_THRESHOLD) {
        logger.debug('TRADE', `${entity.name} rejects trade: not enough ${msg.want} (${count})`);
        return;
    }

    // Check affinity with trader
    const known = entity.knowledge.npcs.find((n) => n.id === msg.fromId);
    if (!known || known.affinity < TRADE_MIN_AFFINITY) return;

    // Withdraw the wanted item from our stock into inventory (so the trader can take it)
    const withdrawn = api.withdrawFromStock(msg.want);
    if (!withdrawn) {
        logger.debug('TRADE', `${entity.name}: can't withdraw ${msg.want} for trade`);
        return;
    }

    logger.info('TRADE', `${entity.name} accepts trade: giving ${msg.want} for ${msg.offer} from ${msg.fromId}`);
}

function handleCourtRequest(entity: NPCEntity, api: WorldAPI, maleId: string, scene: Scene) {
    if (entity.sex === 'male') return;
    if (getLifeStage(entity.age) !== 'adult') return;
    if (hasPartner(entity)) {
        logger.debug('MSG', `${entity.name} ignores court: already has a partner`);
        return;
    }

    // Already busy with mating/waiting
    if (entity.ai.state === 'mating' || entity.ai.state === 'waiting_for_mate') {
        logger.debug('MSG', `${entity.name} ignores court: already ${entity.ai.state}`);
        return;
    }

    // Reproductive state checks
    if (entity.reproduction.cooldown > 0) {
        logger.debug('MSG', `${entity.name} ignores court: cooldown`);
        return;
    }
    if (entity.reproduction.gestation !== null) {
        logger.debug('MSG', `${entity.name} ignores court: pregnant`);
        return;
    }

    // Self-assessment
    const self = assessSelf(entity);
    if (!self.feelsGoodEnough) {
        logger.debug('MSG', `${entity.name} ignores court: doesn't feel good enough`);
        return;
    }

    // Perception of the male
    const male = scene.entities.find(
        (e): e is NPCEntity => e.id === maleId && e.type === 'npc'
    );
    if (male) {
        const perception = perceive(entity, male);
        if (!perception.looksHealthy) {
            logger.debug('MSG', `${entity.name} ignores court: male unhealthy`);
            return;
        }
        if (perception.isKnownRelative) {
            logger.debug('MSG', `${entity.name} ignores court: known relative`);
            return;
        }
    }

    // Accept: stop and wait
    logger.info('MSG', `${entity.name} accepts court from ${maleId}`);
    api.stop();
    entity.ai.state = 'waiting_for_mate';
    entity.ai.targetId = maleId;
}

// =======================================================
//  DECISION HELPERS
// =======================================================

function chooseResourceType(entity: NPCEntity, api: WorldAPI): string {
    // If NPC has a job, prefer gathering job-priority items when stocks are low
    if (entity.job) {
        const jobDef = getJobDef(entity.job);
        if (jobDef && jobDef.priorityItems.length > 0) {
            // Check if any priority item is below stock target
            for (const itemId of jobDef.priorityItems) {
                const stock = api.getStockCount(itemId);
                if (stock < STOCK_TARGET_FOOD) {
                    // But only if personal needs aren't critical
                    if (entity.needs.hunger > 30 && entity.needs.thirst > 30) {
                        return itemId;
                    }
                }
            }
        }
    }

    // Fallback: prioritize based on needs urgency
    const hungerUrgency = 100 - entity.needs.hunger;
    const thirstUrgency = 100 - entity.needs.thirst;

    if (hungerUrgency > thirstUrgency + 15) return 'food';
    if (thirstUrgency > hungerUrgency + 15) return 'water';

    // Similar needs → balance stock
    const foodTotal = api.getStockCount('food') + countItem(entity.inventory, 'food');
    const waterTotal = api.getStockCount('water') + countItem(entity.inventory, 'water');

    return foodTotal <= waterTotal ? 'food' : 'water';
}

/**
 * Natural specialization: NPCs with high gatherSpeed prefer gathering,
 * NPCs with high explorationRange/visionRange prefer scouting for new zones.
 * Returns true if this NPC should prefer exploring over gathering nearby.
 */
function prefersExploration(entity: NPCEntity): boolean {
    // Compare exploration aptitude vs gathering aptitude
    const exploreScore = (entity.traits.explorationRange / 1000) + (entity.traits.visionRange / 400);
    const gatherScore = entity.traits.gatherSpeed + (entity.traits.stamina * 0.5);

    // If exploration traits dominate, prefer scouting new areas
    return exploreScore > gatherScore * 1.2;
}

// =======================================================
//  TERRAIN KNOWLEDGE HELPERS
// =======================================================

const ZONE_DEGRADE_RADIUS = 150;
const ZONE_DEGRADE_AMOUNT = 0.3;

/** Find the best known zone for a resource type, balancing confidence and distance */
function getBestKnownZone(entity: NPCEntity, resourceType: string): KnownZone | null {
    const maxRange = getEffectiveExplorationRange(entity);
    const zones = entity.knowledge.locations.filter(
        (z) => z.resourceType === resourceType && z.confidence > 0
    );

    if (zones.length === 0) return null;

    let best: KnownZone | null = null;
    let bestScore = -1;

    for (const zone of zones) {
        const dist = distance(entity.position, zone.position);
        if (dist > maxRange) continue; // too far for current state

        // Score balances confidence and proximity
        const score = zone.confidence / (1 + dist / 500);
        if (score > bestScore) {
            bestScore = score;
            best = zone;
        }
    }

    return best;
}

/** Degrade confidence of known zones near the NPC's current position (nothing found here) */
function degradeNearbyZones(entity: NPCEntity, resourceType: string) {
    for (const zone of entity.knowledge.locations) {
        if (zone.resourceType !== resourceType) continue;
        if (distance(zone.position, entity.position) <= ZONE_DEGRADE_RADIUS) {
            zone.confidence -= ZONE_DEGRADE_AMOUNT;
        }
    }

    // Forget zones with no confidence left
    entity.knowledge.locations = entity.knowledge.locations.filter((z) => z.confidence > 0);
}
