import { Vector2D } from '../Shared/vector';
import { ItemStack, getItemDef, addItem, removeItem, countItem, hasItems } from '../Shared/registry';

// Re-export for convenience
export type { ItemStack } from '../Shared/registry';
export { getItemDef, addItem, removeItem, countItem, hasItems } from '../Shared/registry';

// --- Camera ---

export type Camera = {
    position: Vector2D;
};

// --- Inventory ---

/** @deprecated Use ItemStack[] instead. Kept for backward compat during migration. */
export type InventoryItem = ItemStack;

// --- Resources ---

/** Legacy resource type — maps to item IDs in the registry */
export type ResourceType = 'food' | 'water' | 'wood';

export const CABIN_WOOD_COST = 3;   // wood items needed to build a cabin

// --- World bounds ---

export const WORLD_HALF = 1200;    // world extends from -WORLD_HALF to +WORLD_HALF on each axis

/** Returns true if the position is inside the playable world area */
export function isInWorldBounds(x: number, y: number): boolean {
    return x >= -WORLD_HALF && x <= WORLD_HALF && y >= -WORLD_HALF && y <= WORLD_HALF;
}

// --- Calendar ---

export const SECONDS_PER_HOUR = 10;                          // 1 game hour = 10 real seconds at x1
export const SECONDS_PER_DAY = SECONDS_PER_HOUR * 24;        // 240s = 4 min
export const DAYS_PER_SEASON = 15;
export const SEASONS_PER_YEAR = 4;
export const DAYS_PER_YEAR = DAYS_PER_SEASON * SEASONS_PER_YEAR; // 60
export const SECONDS_PER_SEASON = DAYS_PER_SEASON * SECONDS_PER_DAY; // 3600s = 1h
export const SECONDS_PER_YEAR = SECONDS_PER_DAY * DAYS_PER_YEAR; // 14400s = 4h

export const SEASON_NAMES = ['Printemps', 'Été', 'Automne', 'Hiver'] as const;
export type SeasonName = typeof SEASON_NAMES[number];

export type Calendar = {
    year: number;          // 1-based
    season: SeasonName;
    seasonIndex: number;   // 0-3
    dayOfSeason: number;   // 1-15
    dayOfYear: number;     // 0-59
    hour: number;          // 0-23
    timeLabel: string;     // "Matin", "Après-midi", "Soir", "Nuit"
    nightFactor: number;   // 0 = full day, 1 = deepest night (smooth transitions)
};

export function getCalendar(sceneTime: number): Calendar {
    const totalDays = sceneTime / SECONDS_PER_DAY;

    const year = Math.floor(totalDays / DAYS_PER_YEAR) + 1;
    const dayOfYear = totalDays % DAYS_PER_YEAR;
    const seasonIndex = Math.floor(dayOfYear / DAYS_PER_SEASON);
    const dayOfSeason = Math.floor(dayOfYear % DAYS_PER_SEASON) + 1;

    // Time of day from fractional part of totalDays
    const frac = totalDays - Math.floor(totalDays); // 0..1
    const hour = Math.floor(frac * 24);

    let timeLabel: string;
    if (hour >= 6 && hour < 12) timeLabel = 'Matin';
    else if (hour >= 12 && hour < 18) timeLabel = 'Après-midi';
    else if (hour >= 18 && hour < 22) timeLabel = 'Soir';
    else timeLabel = 'Nuit';

    // Night factor: smooth 0→1→0 cycle
    // 0 = full day (noon), 1 = deepest night (midnight)
    // Transitions: dawn 5-7h, dusk 19-21h
    const hourF = frac * 24; // fractional hour (0.0 - 24.0)
    let nightFactor: number;
    if (hourF >= 7 && hourF <= 19) {
        nightFactor = 0; // full daylight
    } else if (hourF >= 21 || hourF <= 5) {
        nightFactor = 1; // full night
    } else if (hourF > 5 && hourF < 7) {
        nightFactor = 1 - (hourF - 5) / 2; // dawn transition
    } else {
        nightFactor = (hourF - 19) / 2; // dusk transition
    }

    return {
        year,
        season: SEASON_NAMES[Math.min(seasonIndex, 3)],
        seasonIndex: Math.min(seasonIndex, 3),
        dayOfSeason,
        dayOfYear: Math.floor(dayOfYear),
        hour,
        timeLabel,
        nightFactor,
    };
}

// --- Age & Life Stages ---

export const AGE_RATE = 1 / SECONDS_PER_YEAR;   // 1 calendar year = +1 year of age
export const AGE_BABY = 3;
export const AGE_CHILD = 10;
export const AGE_ADULT = 16;
export const AGE_MENOPAUSE = 45;   // females can no longer conceive after this age
export const AGE_OLD = 60;         // debuffs start (old age)
export const AGE_MAX = 80;         // max natural lifespan — increasing death chance above AGE_OLD

export type LifeStage = 'baby' | 'child' | 'adolescent' | 'adult';

export function getLifeStage(age: number): LifeStage {
    if (age < AGE_BABY) return 'baby';
    if (age < AGE_CHILD) return 'child';
    if (age < AGE_ADULT) return 'adolescent';
    return 'adult';
}

// --- NPC: Traits (fixed characteristics used by AI and world) ---

export type NPCTraits = {
    // Physical
    speed: number;              // Movement speed (px/sec)
    visionRange: number;        // How far the NPC can see (px)
    explorationRange: number;   // Max distance from home when exploring (px)
    carryCapacity: number;      // Max inventory size
    gatherSpeed: number;        // Gather multiplier (higher = faster, duration = base / gatherSpeed)
    stamina: number;            // Energy efficiency (higher = less energy decay)
    hungerRate: number;         // Hunger decay multiplier (higher = gets hungry faster)
    thirstRate: number;         // Thirst decay multiplier (higher = gets thirsty faster)
    // Personality (0-1 scale)
    charisma: number;           // Social appeal, attractiveness to potential mates
    aggressiveness: number;     // Tendency to conflict (future: combat, territory)
    courage: number;            // Willingness to take risks (future: exploration, defense)
    intelligence: number;       // Perception accuracy, decision quality
};

// --- NPC: Needs (current condition, evolves over time) ---

export type NPCNeeds = {
    health: number;           // 0-100, dies at 0
    hunger: number;           // 0-100, satiation gauge
    thirst: number;           // 0-100, hydration gauge
    hungerReserve: number;    // 0-100, body reserves (consumed when hunger=0)
    thirstReserve: number;    // 0-100, body reserves (consumed when thirst=0)
    energy: number;           // 0-100, triggers sleep when critical
    happiness: number;        // 0-100, affected by family, resources, social
    starvationTimer: number;  // sim-seconds spent at hunger=0 AND hungerReserve=0
    dehydrationTimer: number; // sim-seconds spent at thirst=0 AND thirstReserve=0
};

// --- Survival thresholds (in game days) ---

/** Days at hunger=0 before health damage starts */
export const STARVATION_DAYS = 7;
/** Days at thirst=0 before health damage starts */
export const DEHYDRATION_DAYS = 2;
/** Sim-seconds at hunger=0 AND reserve=0 before health damage */
export const STARVATION_LETHAL_TIME = STARVATION_DAYS * SECONDS_PER_DAY;
/** Sim-seconds at thirst=0 AND reserve=0 before health damage */
export const DEHYDRATION_LETHAL_TIME = DEHYDRATION_DAYS * SECONDS_PER_DAY;

// --- Reserve decay / regen rates ---

/** Reserve hunger drain per second when hunger = 0 */
export const RESERVE_HUNGER_DECAY = 0.3;
/** Reserve thirst drain per second when thirst = 0 */
export const RESERVE_THIRST_DECAY = 0.5;
/** Reserve regen per second when main gauge > 50 */
export const RESERVE_REGEN_RATE = 0.1;

// --- Capability debuff from needs ---

/**
 * Returns a capability multiplier [0.3 .. 1.0] based on hunger, thirst, energy.
 * 1.0 = fully capable, lower = debuffed.
 * Affects movement speed, gather speed, etc.
 */
export function getNeedsDebuff(needs: NPCNeeds): number {
    // For hunger/thirst: take the worse of the main gauge and reserve
    const hungerMod = Math.min(gaugeToModifier(needs.hunger), gaugeToModifier(needs.hungerReserve));
    const thirstMod = Math.min(gaugeToModifier(needs.thirst), gaugeToModifier(needs.thirstReserve));
    const energyMod = gaugeToModifier(needs.energy);
    return Math.min(hungerMod, thirstMod, energyMod);
}

/**
 * Returns an age-based capability modifier [0.3 .. 1.0].
 * No debuff below AGE_OLD. Linear decline to MIN_DEBUFF at AGE_MAX.
 */
export function getAgeDebuff(age: number): number {
    if (age <= AGE_OLD) return 1;
    if (age >= AGE_MAX) return MIN_DEBUFF;
    return 1 - (1 - MIN_DEBUFF) * ((age - AGE_OLD) / (AGE_MAX - AGE_OLD));
}

/**
 * Maps a gauge value (0-100) to a capability modifier (MIN_DEBUFF .. 1.0).
 * Above DEBUFF_THRESHOLD: no debuff (1.0).
 * Below: linear interpolation down to MIN_DEBUFF at 0.
 */
const DEBUFF_THRESHOLD = 50;   // gauge above this → no debuff
const MIN_DEBUFF = 0.3;        // worst possible modifier at gauge=0

function gaugeToModifier(value: number): number {
    if (value >= DEBUFF_THRESHOLD) return 1;
    return MIN_DEBUFF + (1 - MIN_DEBUFF) * (value / DEBUFF_THRESHOLD);
    // 0 → 0.3, 25 → 0.65, 50 → 1.0
}

// --- NPC: Reproduction ---

export type NPCReproduction = {
    desire: number;        // 0-100, males: increases over time when needs are ok
    cooldown: number;      // seconds remaining, females: time before can mate again
    gestation: {           // females only, null if not pregnant
        remaining: number; // seconds until birth
        partnerId: string; // father ID for trait inheritance
    } | null;
    fertilityCycle: number; // sim-seconds accumulator for menstrual cycle (females only)
};

// --- Fertility cycle constants ---

/** Duration of a full fertility cycle in sim-seconds (roughly 1 season / 3 ≈ 1 month) */
export const FERTILITY_CYCLE_LENGTH = SECONDS_PER_SEASON / 3;
/** Fraction of cycle that is the fertile window (e.g. 0.2 = 20% of cycle) */
export const FERTILITY_WINDOW_FRACTION = 0.2;
/** Probability of conception per mating during fertile window */
export const CONCEPTION_CHANCE = 0.3;

// --- NPC: Messages (inter-NPC communication) ---

/** Shared zone info carried inside a greeting message */
export type SharedZoneInfo = {
    position: Vector2D;
    resourceType: ResourceType;
    confidence: number;
    source: 'firsthand' | 'hearsay';
};

export type NPCMessage =
    | { type: 'court_request'; fromId: string }
    | { type: 'greeting'; fromId: string; sharedZones?: SharedZoneInfo[] }
    | { type: 'trade_offer'; fromId: string; offer: string; want: string };

// --- NPC: Actions ---

export type NPCAction = {
    type: 'take' | 'sleep' | 'mating' | 'crafting' | 'attacking';
    targetId?: string;
    recipeId?: string;   // for crafting actions
    duration: number;
    remaining: number;
};

// --- NPC: Knowledge (relational memory + terrain) ---

export type NPCRelationType = 'mother' | 'father' | 'child' | 'mate' | 'partner';

export type NPCRelation = {
    targetId: string;
    type: NPCRelationType;
};

export type KnownZone = {
    position: Vector2D;
    resourceType: ResourceType;
    confidence: number;                  // 0-1, decays when visiting empty zone
    source: 'firsthand' | 'hearsay';    // seen personally vs told by someone
};

export type KnownNPC = {
    id: string;
    affinity: number;        // 0-1, grows with social interactions
    greetCooldown: number;   // seconds until can greet again
};

export type NPCKnowledge = {
    relations: NPCRelation[];
    locations: KnownZone[];
    npcs: KnownNPC[];
};

// --- NPC: AI Runtime State ---

export type NPCAIState = {
    state: 'idle' | 'moving' | 'taking' | 'returning' | 'searching' | 'going_to_cabin' | 'going_to_eat' | 'sleeping' | 'resting' | 'courting' | 'going_to_mate' | 'mating' | 'waiting_for_mate' | 'trading' | 'crafting' | 'fighting' | 'fleeing';
    targetId: string | null;
    tickInterval: number;
    tickAccumulator: number;
    greetBubbleTimer: number;  // > 0 → render a greeting bubble above NPC
    restTimer: number;         // > 0 → resting, counts down
    // Trade state
    tradeOffer: string | null;   // item ID I'm offering
    tradeWant: string | null;    // item ID I want in return
    tradePhase: 'going_home' | 'going_to_partner' | 'exchanging' | null;
    // Craft state
    craftRecipeId: string | null;  // recipe being crafted
    // Combat state
    attackCooldown: number;       // seconds until next attack
    // Sleep consolidation
    sleepConsolidated: boolean;   // true once knowledge is consolidated during this sleep
};

// --- NPC: Movement ---

export type NPCMovement = {
    target: Vector2D;
    direction: Vector2D;
} | null;

// --- NPC Entity ---

export type NPCSex = 'male' | 'female';

export type NPCEntity = {
    // Identity
    id: string;
    type: 'npc';
    name: string;
    sex: NPCSex;
    color: string;
    isPlayer: boolean;         // true = controlled by player input, false = AI

    // Age, housing & job
    age: number;               // in sim years
    homeId: string | null;     // cabin/building ID where this NPC lives
    job: string | null;        // job ID from registry (null = no specialization)

    // Fixed characteristics
    traits: NPCTraits;

    // Current condition
    needs: NPCNeeds;

    // Reproduction
    reproduction: NPCReproduction;

    // Physical state
    position: Vector2D;
    movement: NPCMovement;
    action: NPCAction | null;

    // Inventory
    inventory: ItemStack[];

    // Communication
    messages: NPCMessage[];

    // Knowledge (memory)
    knowledge: NPCKnowledge;

    // AI runtime
    ai: NPCAIState;

    // Action history (recent first, capped)
    actionHistory: NPCActionLog[];
};

// --- Action log entry ---

export type NPCActionLog = {
    time: number;       // scene time when this happened
    action: string;     // human-readable label, e.g. "gathering wood", "trading with Alaric"
    icon: string;       // emoji/symbol for the UI
};

const MAX_ACTION_HISTORY = 20;

/** Push an entry to the NPC action log (most recent first, capped). Skips consecutive duplicates. */
export function logAction(npc: NPCEntity, sceneTime: number, action: string, icon: string) {
    if (npc.actionHistory.length > 0 && npc.actionHistory[0].action === action) return;
    npc.actionHistory.unshift({ time: sceneTime, action, icon });
    if (npc.actionHistory.length > MAX_ACTION_HISTORY) {
        npc.actionHistory.length = MAX_ACTION_HISTORY;
    }
}

// --- Helper: partnership check ---

export function hasPartner(entity: NPCEntity): boolean {
    return entity.knowledge.relations.some((r) => r.type === 'partner');
}

export function getPartnerId(entity: NPCEntity): string | null {
    const rel = entity.knowledge.relations.find((r) => r.type === 'partner');
    return rel?.targetId ?? null;
}

/** Check if a female NPC is currently in her fertile window */
export function isFertile(entity: NPCEntity): boolean {
    if (entity.sex !== 'female') return false;
    if (entity.age >= AGE_MENOPAUSE) return false;
    const cyclePos = entity.reproduction.fertilityCycle % FERTILITY_CYCLE_LENGTH;
    const fertileStart = FERTILITY_CYCLE_LENGTH * (1 - FERTILITY_WINDOW_FRACTION);
    return cyclePos >= fertileStart;
}

// --- Other Entities ---

export type ResourceEntity = {
    id: string;
    type: 'resource';
    resourceType: ResourceType;  // legacy — maps to item registry ID
    itemId: string;              // item registry ID (preferred)
    position: Vector2D;
    color: string;
    lockedBy: string | null;
};

export type StockEntity = {
    id: string;
    type: 'stock';
    cabinId: string;         // linked to a cabin/building
    position: Vector2D;
    color: string;
    items: ItemStack[];
};

/** Generic building entity — replaces the old CabinEntity */
export type BuildingEntity = {
    id: string;
    type: 'building';
    buildingType: string;    // references BuildingDef.id ('cabin', 'farm', 'smithy', etc.)
    residentIds: string[];   // NPCs living here (residential buildings only)
    workerIds: string[];     // NPCs working here (job buildings)
    position: Vector2D;
    color: string;
    polygon: Vector2D[];     // organic terrain plot vertices
};

/** @deprecated Use BuildingEntity instead. Kept as alias during migration. */
export type CabinEntity = BuildingEntity;

export type CorpseEntity = {
    id: string;
    type: 'corpse';
    name: string;
    sex: NPCSex;
    color: string;
    position: Vector2D;
};

export type FertileZoneEntity = {
    id: string;
    type: 'fertile_zone';
    resourceType: ResourceType;
    position: Vector2D;
    radius: number;         // zone size (px)
    capacity: number;       // max resources this zone can hold
    spawnInterval: number;  // seconds between spawn attempts
    spawnTimer: number;     // current countdown
    color: string;
};

// --- Plant Entity ---

export type PlantGrowthStage = 'seed' | 'sprout' | 'growing' | 'mature' | 'dead';

export type PlantEntity = {
    id: string;
    type: 'plant';
    speciesId: string;        // references a PlantSpecies.id
    position: Vector2D;
    growth: number;           // 0..1 — progression toward maturity
    health: number;           // 0..100
    age: number;              // sim-seconds alive
    stage: PlantGrowthStage;
    seedTimer: number;        // sim-seconds until next seed dispersal
    fruitTimer: number;       // sim-seconds until next fruit production
    dormancyTimer: number;    // sim-seconds remaining for seed dormancy (0 = not dormant)
    owner?: string;           // null/undefined = wild, string = player/NPC who planted it
};

// --- Fruit Entity ---

export type FruitEntity = {
    id: string;
    type: 'fruit';
    speciesId: string;
    fruitName: string;
    position: Vector2D;
    nutritionValue: number;
    age: number;
    maxAge: number;
    color: string;
    parentPlantId?: string;
};

// --- Animal Entity ---

export type AnimalSpeciesId = 'rabbit' | 'deer' | 'wolf' | 'fox';

export type AnimalEntity = {
    id: string;
    type: 'animal';
    speciesId: AnimalSpeciesId;
    position: Vector2D;
    targetPos: Vector2D | null;
    heading: number;
    speed: number;
    health: number;
    hunger: number;
    age: number;
    growth: number;
    reproTimer: number;
    idleTimer: number;
    sex: 'male' | 'female';
    mateTargetId: string | null;
    state: 'idle' | 'wandering' | 'eating' | 'grazing' | 'fleeing' | 'sleeping' | 'calling' | 'mating' | 'dead';
    pendingSignals: import('./signals').PendingSignal[];
    alertLevel: number;
};

// --- Scene ---

export type SceneEntity = NPCEntity | ResourceEntity | StockEntity | BuildingEntity | CorpseEntity | FertileZoneEntity | PlantEntity | FruitEntity | AnimalEntity;

export type Scene = {
    entities: SceneEntity[];
    time: number;   // elapsed sim-seconds (used for calendar)
    soilGrid?: import('./fertility').SoilGrid;     // multi-property soil map
    heightMap?: import('./heightmap').HeightMap;    // terrain elevation
    basinMap?: import('./heightmap').BasinMap;     // flow accumulation (derived from heightmap)
    depressionMap?: import('./heightmap').DepressionMap; // topographic depressions for lake sim
    weather?: import('./weather').WeatherState;    // current weather conditions
    lakesEnabled: boolean;                          // toggle lakes feature on/off
    signals?: import('./signals').Signal[];          // active world signals
    playerPos?: Vector2D;                            // player world position (set by renderer)
    playerMoving?: boolean;                          // is the player currently moving
    playerSprinting?: boolean;                       // is the player sprinting
    playerCrouching?: boolean;                       // is the player crouching
};

// --- World API ---

export type EntityInfo = {
    id: string;
    position: Vector2D;
    distance: number;
};

/** Observable NPC info — physical observations, not raw stats */
export type NPCInfo = EntityInfo & {
    name: string;
    sex: NPCSex;
    age: number;
    stage: LifeStage;
    color: string;
    visibleState: NPCAIState['state'];  // what they appear to be doing
    isAlive: boolean;
    homeId: string | null;
    job: string | null;
    inventoryCount: number;             // how many items they're carrying (observable)
    hasPartner: boolean;
    isPregnant: boolean;
};

// --- Render: Highlight (hover from UI) ---

export type Highlight =
    | { type: 'npc'; id: string }
    | { type: 'zone'; position: Vector2D; resourceType: ResourceType }
    | null;

// --- World API ---

export type WorldAPI = {
    getNearest: (itemId: string) => EntityInfo | null;
    getNearestMate: () => EntityInfo | null;
    getEntity: (id: string) => EntityInfo | null;
    getMyStock: () => EntityInfo | null;
    getMyCabin: () => EntityInfo | null;
    getStockCount: (itemId: string) => number;
    moveTo: (target: Vector2D) => void;
    stop: () => void;
    take: (targetId: string) => boolean;
    deposit: () => boolean;
    consume: (itemId: string) => boolean;
    sleep: () => boolean;
    wakeUp: () => void;
    /**
     * Start mating with an existing partner (physical mechanics only).
     * Returns result: 'ok' | 'too_far' | 'busy' | 'cooldown' | 'pregnant' | 'not_found'.
     * Does NOT mutate AI state — the AI caller handles state transitions.
     */
    startMating: (targetId: string) => { success: boolean; reason: string };
    /**
     * Form a couple bond between this NPC and a target (physical relation only).
     * Returns false if target is not found or too far.
     */
    formCouple: (targetId: string) => boolean;
    sendMessage: (targetId: string, message: NPCMessage) => boolean;
    getNearbyNPCs: (range: number) => EntityInfo[];
    buildCabin: () => boolean;
    /** Pick up a specific item from home stock into inventory */
    withdrawFromStock: (itemId: string) => boolean;
    /** Give an item from own inventory to a nearby NPC's inventory */
    giveItem: (targetId: string, itemId: string) => boolean;
    /** Start crafting a recipe — consumes inputs from stock, returns true if started */
    craft: (recipeId: string) => boolean;
    /** Get buildings near the NPC within a range */
    getNearbyBuildings: (range: number) => Array<EntityInfo & { buildingType: string }>;
    /** Get observable info about a specific NPC by ID */
    getNPCInfo: (id: string) => NPCInfo | null;
    /** Get observable info about all nearby NPCs (enriched version of getNearbyNPCs) */
    getNearbyNPCInfos: (range: number) => NPCInfo[];
    /** Get this NPC's known children (from knowledge.relations) */
    getChildInfos: () => NPCInfo[];
    /** Get the stock item counts for another NPC's home (observable — the NPC must be nearby) */
    getStockCountOf: (npcId: string, itemId: string) => number;
    /** Take an item from trade partner's inventory (world-mediated exchange) */
    takeItemFrom: (targetId: string, itemId: string) => boolean;
    /** Attack a target NPC — resolves damage via combat system, returns damage dealt */
    attack: (targetId: string) => number;
};
