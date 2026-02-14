import { AGE_MENOPAUSE, SECONDS_PER_SEASON, CONCEPTION_CHANCE, BuildingEntity, NPCEntity, NPCRelation, NPCTraits, Scene, getLifeStage, isFertile } from './Game.types';
import { generateEntityId } from './Game.ids';
import { logger } from './Game.logger';

// --- Reproduction constants ---

export const MATING_DURATION = 3;                              // seconds (copulation)
export const GESTATION_DURATION = SECONDS_PER_SEASON;          // 1 season (pregnancy)
export const REPRODUCTION_COOLDOWN = SECONDS_PER_SEASON;       // 1 season after birth (no procreation)
export const PROPOSE_RANGE = 25;                               // distance to propose
export const DESIRE_RATE = 0.5;                                // desire increase per second (slow buildup)
export const DESIRE_THRESHOLD = 70;                            // desire level to start courting

// Palette for generated NPC colors
const NPC_COLOR_PALETTE = [
    '#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6',
    '#1abc9c', '#e67e22', '#e91e63', '#00bcd4', '#8bc34a',
    '#ff5722', '#607d8b', '#795548', '#673ab7', '#cddc39',
];

// --- Public ---

export function processReproduction(scene: Scene, dt: number) {
    const npcs = scene.entities.filter(
        (e): e is NPCEntity => e.type === 'npc'
    );

    for (const npc of npcs) {
        // Only adults build desire and reproduce
        if (getLifeStage(npc.age) !== 'adult') continue;

        if (npc.sex === 'male') {
            // Desire grows when needs are met and not actively courting/mating
            const isBusy = npc.action?.type === 'mating'
                || npc.ai.state === 'courting'
                || npc.ai.state === 'waiting_for_mate';
            if (
                npc.needs.hunger > 50 &&
                npc.needs.thirst > 50 &&
                npc.needs.energy > 50 &&
                !isBusy
            ) {
                npc.reproduction.desire = Math.min(100, npc.reproduction.desire + DESIRE_RATE * dt);
            }
        } else {
            // Advance fertility cycle
            npc.reproduction.fertilityCycle += dt;

            // Cooldown ticks down
            if (npc.reproduction.cooldown > 0) {
                npc.reproduction.cooldown = Math.max(0, npc.reproduction.cooldown - dt);
            }

            // Gestation ticks down
            if (npc.reproduction.gestation) {
                npc.reproduction.gestation.remaining -= dt;

                if (npc.reproduction.gestation.remaining <= 0) {
                    spawnBaby(scene, npc);
                    npc.reproduction.gestation = null;
                }
            }
        }
    }
}

// --- Internal ---

function spawnBaby(scene: Scene, mother: NPCEntity) {
    const fatherId = mother.reproduction.gestation?.partnerId;
    const father = fatherId
        ? scene.entities.find((e): e is NPCEntity => e.id === fatherId && e.type === 'npc')
        : null;

    const fatherTraits = father?.traits ?? mother.traits;
    const babyTraits = mixTraits(mother.traits, fatherTraits);

    const babySex = Math.random() < 0.5 ? 'male' : 'female';
    const babyId = generateEntityId();
    const babyColor = NPC_COLOR_PALETTE[Math.floor(Math.random() * NPC_COLOR_PALETTE.length)];
    const babyName = `NPC-${babyId}`;

    // Baby spawns near the mother
    const offset = { x: (Math.random() - 0.5) * 20, y: (Math.random() - 0.5) * 20 };
    const babyPosition = { x: mother.position.x + offset.x, y: mother.position.y + offset.y };

    const babyRelations: NPCRelation[] = [
        { targetId: mother.id, type: 'mother' },
    ];
    if (fatherId) {
        babyRelations.push({ targetId: fatherId, type: 'father' });
    }

    // Baby lives in the mother's home (no new cabin!)
    const homeId = mother.homeId;

    const baby: NPCEntity = {
        id: babyId,
        type: 'npc',
        name: babyName,
        sex: babySex,
        color: babyColor,
        isPlayer: false,
        age: 0,
        homeId,
        job: null,
        traits: babyTraits,
        needs: { health: 100, hunger: 100, thirst: 100, hungerReserve: 100, thirstReserve: 100, energy: 100, happiness: 50, starvationTimer: 0, dehydrationTimer: 0 },
        reproduction: { desire: 0, cooldown: 0, gestation: null, fertilityCycle: 0 },
        position: babyPosition,
        movement: null,
        action: null,
        inventory: [],
        messages: [],
        knowledge: {
            relations: babyRelations,
            // Inherit mother's terrain knowledge (as hearsay, reduced confidence)
            locations: mother.knowledge.locations.map((loc) => ({
                position: { x: loc.position.x, y: loc.position.y },
                resourceType: loc.resourceType,
                confidence: loc.confidence * 0.5,
                source: 'hearsay' as const,
            })),
            npcs: [],
        },
        ai: { state: 'idle', targetId: null, tickInterval: 0.1 + Math.random() * 0.05, tickAccumulator: 0, greetBubbleTimer: 0, restTimer: 0, tradeOffer: null, tradeWant: null, tradePhase: null, craftRecipeId: null, attackCooldown: 0 },
    };

    // Add baby to mother's cabin residents
    if (homeId) {
        const cabin = scene.entities.find(
            (e): e is BuildingEntity => e.type === 'building' && e.id === homeId
        );
        if (cabin) {
            cabin.residentIds.push(babyId);
        }
    }

    // Parents learn about their child
    mother.knowledge.relations.push({ targetId: babyId, type: 'child' });
    if (father) {
        father.knowledge.relations.push({ targetId: babyId, type: 'child' });
    }

    scene.entities.push(baby);

    // Post-partum cooldown: mother can't procreate for 1 season after birth
    mother.reproduction.cooldown = REPRODUCTION_COOLDOWN;

    logger.info('BIRTH', `${babyName} (${babySex}) born to ${mother.name}, age=0, home=${homeId}`);
}

function mixTraits(a: NPCTraits, b: NPCTraits): NPCTraits {
    function mix(va: number, vb: number): number {
        const avg = (va + vb) / 2;
        const mutation = avg * (Math.random() * 0.2 - 0.1); // +-10%
        return Math.max(0.1, avg + mutation);
    }

    function mixClamped(va: number, vb: number): number {
        return Math.max(0, Math.min(1, mix(va, vb)));
    }

    return {
        speed: mix(a.speed, b.speed),
        visionRange: mix(a.visionRange, b.visionRange),
        explorationRange: mix(a.explorationRange, b.explorationRange),
        carryCapacity: Math.round(mix(a.carryCapacity, b.carryCapacity)),
        gatherSpeed: mix(a.gatherSpeed, b.gatherSpeed),
        stamina: mix(a.stamina, b.stamina),
        hungerRate: mix(a.hungerRate, b.hungerRate),
        thirstRate: mix(a.thirstRate, b.thirstRate),
        charisma: mixClamped(a.charisma, b.charisma),
        aggressiveness: mixClamped(a.aggressiveness, b.aggressiveness),
        courage: mixClamped(a.courage, b.courage),
        intelligence: mixClamped(a.intelligence, b.intelligence),
    };
}
