import { AGE_MENOPAUSE, NPCEntity } from './Game.types';

// --- Perception of another NPC ---

export type NPCPerception = {
    looksHealthy: boolean;      // Does the target appear to be in good health?
    looksStrong: boolean;       // Does the target appear physically capable?
    looksWellFed: boolean;      // Does the target appear well-nourished?
    looksEnergetic: boolean;    // Does the target appear rested?
    attractiveness: number;     // 0-1, how attractive the target appears (charisma + condition)
    isKnownRelative: boolean;   // Do I recognize this NPC as a relative?
};

/**
 * How an observer NPC perceives another NPC.
 *
 * Observer's intelligence affects perception accuracy:
 * - High intelligence → thresholds are more precise (closer to reality)
 * - Low intelligence → easily fooled (lower thresholds, less discerning)
 *
 * Target's charisma affects how attractive they appear.
 */
export function perceive(observer: NPCEntity, target: NPCEntity): NPCPerception {
    const intel = observer.traits.intelligence; // 0-1

    // Intelligence shifts the threshold: smart NPC needs health > 65, dumb NPC accepts > 40
    const healthThreshold = 40 + intel * 25;    // range: 40-65
    const fedThreshold = 25 + intel * 20;       // range: 25-45
    const energyThreshold = 15 + intel * 20;    // range: 15-35

    const isRelative = observer.knowledge.relations.some(
        (r) => r.targetId === target.id && (r.type === 'mother' || r.type === 'father' || r.type === 'child')
    );

    // Attractiveness: base from charisma, boosted by good condition
    const conditionBonus = (
        (target.needs.health / 100) * 0.3 +
        (target.needs.hunger / 100) * 0.1 +
        (target.needs.thirst / 100) * 0.1 +
        (target.needs.energy / 100) * 0.1
    ); // 0 to 0.6
    const attractiveness = Math.min(1, target.traits.charisma * 0.6 + conditionBonus);

    return {
        looksHealthy: target.needs.health > healthThreshold,
        looksStrong: target.traits.speed >= observer.traits.speed * (0.6 + intel * 0.3),
        looksWellFed: target.needs.hunger > fedThreshold && target.needs.thirst > fedThreshold,
        looksEnergetic: target.needs.energy > energyThreshold,
        attractiveness,
        isKnownRelative: isRelative,
    };
}

// --- Self-assessment ---

export type SelfAssessment = {
    feelsGoodEnough: boolean;   // Am I in decent overall shape?
    feelsHungry: boolean;       // Am I hungry?
    feelsThirsty: boolean;      // Am I thirsty?
    feelsTired: boolean;        // Am I exhausted?
};

/**
 * How an NPC assesses its own condition.
 * Intelligence makes self-awareness more accurate.
 * Courageous NPCs feel "good enough" more readily.
 */
export function assessSelf(entity: NPCEntity): SelfAssessment {
    const courageOffset = entity.traits.courage * 10; // brave NPCs tolerate lower needs

    return {
        feelsGoodEnough:
            entity.needs.health > (50 - courageOffset) &&
            entity.needs.hunger > (30 - courageOffset) &&
            entity.needs.thirst > (30 - courageOffset) &&
            entity.needs.energy > (30 - courageOffset),
        feelsHungry: entity.needs.hunger < 40,
        feelsThirsty: entity.needs.thirst < 40,
        feelsTired: entity.needs.energy < 30,
    };
}

// --- Mate evaluation (combines perception + self-assessment) ---

export type MateEvaluation = {
    acceptable: boolean;        // Would I mate with this NPC?
    reason?: string;            // Why not? (for logging)
};

/**
 * A female evaluates whether a male is an acceptable mate.
 *
 * Decision factors:
 * - Perception of the male (health, attractiveness)
 * - Self-assessment (do I feel good enough?)
 * - Relative check (no incest)
 * - Attractiveness threshold: less charismatic females are less picky,
 *   more charismatic females demand higher attractiveness from males
 */
export function evaluateMate(self: NPCEntity, male: NPCEntity): MateEvaluation {
    const perception = perceive(self, male);
    const selfState = assessSelf(self);

    // Don't mate with known relatives (parent/child)
    if (perception.isKnownRelative) {
        return { acceptable: false, reason: 'known relative' };
    }

    // Don't mate with siblings (share a parent)
    if (areSiblings(self, male)) {
        return { acceptable: false, reason: 'sibling' };
    }

    // I need to feel good enough myself
    if (!selfState.feelsGoodEnough) {
        return { acceptable: false, reason: 'does not feel good enough' };
    }

    // The male must look healthy
    if (!perception.looksHealthy) {
        return { acceptable: false, reason: 'male does not look healthy' };
    }

    // The male must look well-fed (not starving)
    if (!perception.looksWellFed) {
        return { acceptable: false, reason: 'male does not look well-fed' };
    }

    // Fertility check: female past menopause
    if (self.age >= AGE_MENOPAUSE) {
        return { acceptable: false, reason: 'too old to conceive' };
    }

    // Age gap check: large age differences are penalized
    // Acceptable gap grows slightly with age (young adults are pickier)
    const ageDiff = Math.abs(self.age - male.age);
    const maxAcceptableGap = 5 + self.age * 0.2; // e.g. at 20 → 9 years, at 30 → 11 years
    if (ageDiff > maxAcceptableGap) {
        return { acceptable: false, reason: `age gap too large (${Math.round(ageDiff)}y > ${Math.round(maxAcceptableGap)}y)` };
    }

    // Affinity check: must know and like the male enough (requires many greetings)
    const AFFINITY_THRESHOLD = 0.75;
    const knownMale = self.knowledge.npcs.find((n) => n.id === male.id);
    const affinity = knownMale?.affinity ?? 0;
    if (affinity < AFFINITY_THRESHOLD) {
        return { acceptable: false, reason: `not enough affinity (${(affinity * 100).toFixed(0)}% < ${AFFINITY_THRESHOLD * 100}%)` };
    }

    // Attractiveness check: pickiness scales with female's own charisma
    // High charisma female → demands attractiveness > 0.5
    // Low charisma female → accepts attractiveness > 0.2
    const pickinessThreshold = 0.2 + self.traits.charisma * 0.35; // range: 0.2-0.55
    if (perception.attractiveness < pickinessThreshold) {
        return { acceptable: false, reason: `not attractive enough (${perception.attractiveness.toFixed(2)} < ${pickinessThreshold.toFixed(2)})` };
    }

    return { acceptable: true };
}

/** Check if two NPCs share a parent (siblings or half-siblings) */
function areSiblings(a: NPCEntity, b: NPCEntity): boolean {
    const aParents = a.knowledge.relations
        .filter((r) => r.type === 'mother' || r.type === 'father')
        .map((r) => r.targetId);
    const bParents = b.knowledge.relations
        .filter((r) => r.type === 'mother' || r.type === 'father')
        .map((r) => r.targetId);

    return aParents.some((id) => bParents.includes(id));
}
