// =============================================================
//  COMBAT SYSTEM — Weapons, armor, attack resolution
// =============================================================

import { NPCEntity, Scene, countItem } from './types';
import { getItemDef, ItemDef } from '../Shared/registry';
import { distance } from '../Shared/vector';
import { logger } from '../Shared/logger';

// --- Combat constants ---

export const ATTACK_RANGE = 25;           // px — melee range
export const ATTACK_COOLDOWN = 2;         // seconds between attacks
export const BASE_DAMAGE = 3;             // unarmed damage
export const FLEE_SPEED_MULT = 1.3;       // speed bonus when fleeing
export const AGGRO_RANGE = 100;           // px — range at which hostile NPCs engage

// --- Equipment helpers ---

export type CombatStats = {
    damage: number;
    defense: number;
    weaponId: string | null;
    armorId: string | null;
};

/**
 * Get the combat stats for an NPC based on their inventory.
 * Picks the best weapon and armor available.
 */
export function getCombatStats(npc: NPCEntity): CombatStats {
    let bestWeapon: ItemDef | null = null;
    let bestArmor: ItemDef | null = null;

    for (const stack of npc.inventory) {
        const def = getItemDef(stack.itemId);
        if (!def) continue;

        if (def.category === 'weapon' && def.damage) {
            if (!bestWeapon || def.damage > (bestWeapon.damage ?? 0)) {
                bestWeapon = def;
            }
        }
        if (def.category === 'armor' && def.defense) {
            if (!bestArmor || def.defense > (bestArmor.defense ?? 0)) {
                bestArmor = def;
            }
        }
    }

    return {
        damage: BASE_DAMAGE + (bestWeapon?.damage ?? 0),
        defense: bestArmor?.defense ?? 0,
        weaponId: bestWeapon?.id ?? null,
        armorId: bestArmor?.id ?? null,
    };
}

// --- Attack resolution ---

/**
 * Resolve a single attack from attacker to defender.
 * Returns the actual damage dealt.
 */
export function resolveAttack(attacker: NPCEntity, defender: NPCEntity): number {
    const attackStats = getCombatStats(attacker);
    const defenseStats = getCombatStats(defender);

    // Damage = base damage * attacker traits - defender's defense
    const traitMult = 0.5 + attacker.traits.aggressiveness * 0.5 + attacker.traits.courage * 0.3;
    const rawDamage = attackStats.damage * traitMult;
    const mitigatedDamage = Math.max(1, rawDamage - defenseStats.defense * 0.5);

    // Randomize ±20%
    const variance = 0.8 + Math.random() * 0.4;
    const finalDamage = Math.round(mitigatedDamage * variance);

    defender.needs.health = Math.max(0, defender.needs.health - finalDamage);

    logger.info('COMBAT', `${attacker.name} attacks ${defender.name} for ${finalDamage} damage (HP: ${Math.round(defender.needs.health)})`);

    return finalDamage;
}

// --- Combat decision helpers ---

/**
 * Should this NPC fight or flee?
 * Based on courage, health, and relative combat power.
 */
export function shouldFlee(npc: NPCEntity, enemy: NPCEntity): boolean {
    const myStats = getCombatStats(npc);
    const enemyStats = getCombatStats(enemy);

    // Health factor: lower health → more likely to flee
    const healthFactor = npc.needs.health / 100;

    // Power comparison
    const myPower = myStats.damage + myStats.defense;
    const enemyPower = enemyStats.damage + enemyStats.defense;
    const powerRatio = myPower / Math.max(1, enemyPower);

    // Courage check: high courage = less likely to flee
    const fleeThreshold = 0.5 - npc.traits.courage * 0.4; // 0.1 (brave) to 0.5 (coward)

    const fleeFactor = (1 - healthFactor) * 0.5 + (1 - powerRatio) * 0.3;

    return fleeFactor > fleeThreshold + npc.traits.courage * 0.2;
}

/**
 * Check if an NPC is hostile towards another.
 * Currently based on faction relations + aggressiveness.
 */
export function isHostile(npc: NPCEntity, other: NPCEntity): boolean {
    // For now, hostile if aggressiveness is very high and affinity is very low
    const known = npc.knowledge.npcs.find((n) => n.id === other.id);
    if (known && known.affinity > 0.3) return false; // friends don't fight

    // High aggressiveness + unknown NPC = potential conflict
    return npc.traits.aggressiveness > 0.8 && (!known || known.affinity < 0.1);
}
