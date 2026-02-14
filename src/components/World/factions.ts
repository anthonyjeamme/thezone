// =============================================================
//  FACTIONS — Village-based factions, relations, wars
// =============================================================

import { BuildingEntity, NPCEntity, Scene, StockEntity, countItem } from './types';
import { Vector2D, distance } from '../Shared/vector';
import { logger } from '../Shared/logger';

// --- Faction types ---

export type FactionRelation = 'allied' | 'neutral' | 'hostile';

export type Faction = {
    id: string;
    name: string;
    villageCenter: Vector2D;
    memberIds: string[];         // NPC IDs
    buildingIds: string[];       // Building IDs
    relations: Map<string, FactionRelation>; // factionId → relation
    wealth: number;              // total coins across all stocks
    militaryPower: number;       // combat score of all members
};

// --- Faction management ---

const factions = new Map<string, Faction>();

export function getFaction(id: string): Faction | undefined {
    return factions.get(id);
}

export function getAllFactions(): Faction[] {
    return Array.from(factions.values());
}

export function getFactionOf(npcId: string): Faction | undefined {
    for (const faction of factions.values()) {
        if (faction.memberIds.includes(npcId)) return faction;
    }
    return undefined;
}

export function getRelation(factionA: string, factionB: string): FactionRelation {
    if (factionA === factionB) return 'allied';
    const a = factions.get(factionA);
    return a?.relations.get(factionB) ?? 'neutral';
}

export function setRelation(factionA: string, factionB: string, relation: FactionRelation) {
    const a = factions.get(factionA);
    const b = factions.get(factionB);
    if (a) a.relations.set(factionB, relation);
    if (b) b.relations.set(factionA, relation);
    logger.info('FACTION', `${factionA} → ${factionB}: ${relation}`);
}

// --- Faction initialization ---

/**
 * Create factions based on village centers in the scene.
 * Called once at scene creation.
 */
export function initFactions(scene: Scene, villageCenters: Vector2D[]) {
    factions.clear();

    for (let i = 0; i < villageCenters.length; i++) {
        const center = villageCenters[i];
        const factionId = `faction-${i}`;
        const faction: Faction = {
            id: factionId,
            name: `Village ${i + 1}`,
            villageCenter: center,
            memberIds: [],
            buildingIds: [],
            relations: new Map(),
            wealth: 0,
            militaryPower: 0,
        };

        // Assign NPCs and buildings near this center
        const VILLAGE_RADIUS = 300;

        for (const e of scene.entities) {
            if (e.type === 'npc') {
                const npc = e as NPCEntity;
                if (distance(npc.position, center) <= VILLAGE_RADIUS) {
                    faction.memberIds.push(npc.id);
                }
            }
            if (e.type === 'building') {
                const building = e as BuildingEntity;
                if (distance(building.position, center) <= VILLAGE_RADIUS) {
                    faction.buildingIds.push(building.id);
                }
            }
        }

        // Default relations: neutral to all others
        for (let j = 0; j < villageCenters.length; j++) {
            if (j !== i) {
                faction.relations.set(`faction-${j}`, 'neutral');
            }
        }

        factions.set(factionId, faction);
    }
}

// --- Faction updates ---

/**
 * Update faction stats (wealth, military power) periodically.
 * Call this every few game days.
 */
export function updateFactionStats(scene: Scene) {
    for (const faction of factions.values()) {
        // Recalculate wealth
        let totalWealth = 0;
        for (const buildingId of faction.buildingIds) {
            const stock = scene.entities.find(
                (e): e is StockEntity => e.type === 'stock' && e.cabinId === buildingId
            );
            if (stock) {
                totalWealth += countItem(stock.items, 'coin');
            }
        }
        faction.wealth = totalWealth;

        // Recalculate military power
        let military = 0;
        for (const memberId of faction.memberIds) {
            const npc = scene.entities.find(
                (e): e is NPCEntity => e.id === memberId && e.type === 'npc'
            );
            if (npc) {
                military += npc.traits.aggressiveness * 5 + npc.traits.courage * 5;
                // Bonus for weapons
                for (const stack of npc.inventory) {
                    if (stack.itemId === 'sword') military += 10;
                    if (stack.itemId === 'spear') military += 8;
                    if (stack.itemId === 'bow') military += 6;
                }
            }
        }
        faction.militaryPower = military;

        // Clean up dead members
        faction.memberIds = faction.memberIds.filter((id) =>
            scene.entities.some((e) => e.id === id && e.type === 'npc')
        );
    }
}

// --- Conflict triggers ---

/**
 * Check if any factions should go to war based on resource scarcity.
 * When a faction is starving and another is wealthy, tensions rise.
 */
export function checkFactionConflicts(scene: Scene) {
    const allFac = getAllFactions();

    for (const faction of allFac) {
        // Calculate average hunger of members
        let totalHunger = 0;
        let memberCount = 0;

        for (const memberId of faction.memberIds) {
            const npc = scene.entities.find(
                (e): e is NPCEntity => e.id === memberId && e.type === 'npc'
            );
            if (npc) {
                totalHunger += npc.needs.hunger;
                memberCount++;
            }
        }

        if (memberCount === 0) continue;
        const avgHunger = totalHunger / memberCount;

        // If faction is starving (average hunger < 30), tensions with wealthy factions
        if (avgHunger < 30) {
            for (const other of allFac) {
                if (other.id === faction.id) continue;
                if (getRelation(faction.id, other.id) === 'allied') continue;

                // If other faction is wealthy, declare hostility
                if (other.wealth > faction.wealth * 2) {
                    const currentRelation = getRelation(faction.id, other.id);
                    if (currentRelation === 'neutral') {
                        setRelation(faction.id, other.id, 'hostile');
                        logger.info('FACTION', `${faction.name} declares hostility towards ${other.name} due to resource scarcity!`);
                    }
                }
            }
        }

        // Peace resolution: if both factions are doing well, tensions decrease
        if (avgHunger > 60) {
            for (const other of allFac) {
                if (other.id === faction.id) continue;
                if (getRelation(faction.id, other.id) === 'hostile') {
                    // Check if other is also doing well
                    let otherHunger = 0;
                    let otherCount = 0;
                    for (const mId of other.memberIds) {
                        const npc = scene.entities.find(
                            (e): e is NPCEntity => e.id === mId && e.type === 'npc'
                        );
                        if (npc) { otherHunger += npc.needs.hunger; otherCount++; }
                    }
                    if (otherCount > 0 && otherHunger / otherCount > 60) {
                        // Both doing well → back to neutral (10% chance per check)
                        if (Math.random() < 0.1) {
                            setRelation(faction.id, other.id, 'neutral');
                            logger.info('FACTION', `${faction.name} and ${other.name} return to neutral relations`);
                        }
                    }
                }
            }
        }
    }
}

// --- NPC faction helper ---

/**
 * Check if two NPCs belong to hostile factions.
 * Accepts either NPCEntity objects or raw NPC IDs.
 */
export function areFactionsHostile(npcA: NPCEntity | string, npcB: NPCEntity | string): boolean {
    const idA = typeof npcA === 'string' ? npcA : npcA.id;
    const idB = typeof npcB === 'string' ? npcB : npcB.id;
    const facA = getFactionOf(idA);
    const facB = getFactionOf(idB);
    if (!facA || !facB) return false;
    return getRelation(facA.id, facB.id) === 'hostile';
}
