// =============================================================
//  EVENT SYSTEM — Epidemics, famines, fires, raids, weather
//  EventBus pattern: systems publish events, others react.
// =============================================================

import {
    BuildingEntity, NPCEntity, Scene, StockEntity, countItem, removeItem, addItem,
    getCalendar, SECONDS_PER_DAY, SECONDS_PER_SEASON,
} from './types';
import { distance, Vector2D } from '../Shared/vector';
import { logger } from '../Shared/logger';
import { getAllFactions, getRelation, setRelation, getFactionOf, Faction } from './factions';

// =============================================================
//  EVENT BUS
// =============================================================

export type GameEvent =
    | { type: 'epidemic_start'; targetFactionId: string; diseaseName: string }
    | { type: 'epidemic_end'; targetFactionId: string }
    | { type: 'famine_start'; targetFactionId: string }
    | { type: 'famine_end'; targetFactionId: string }
    | { type: 'fire'; buildingId: string; position: Vector2D }
    | { type: 'raid'; attackerFactionId: string; defenderFactionId: string }
    | { type: 'weather_change'; weatherType: WeatherType };

export type EventListener = (event: GameEvent, scene: Scene) => void;

const listeners: EventListener[] = [];
const eventQueue: GameEvent[] = [];

export function onEvent(listener: EventListener) {
    listeners.push(listener);
}

export function emitEvent(event: GameEvent) {
    eventQueue.push(event);
}

export function processEventQueue(scene: Scene) {
    while (eventQueue.length > 0) {
        const event = eventQueue.shift()!;
        for (const listener of listeners) {
            listener(event, scene);
        }
    }
}

// =============================================================
//  WEATHER SYSTEM
// =============================================================

export type WeatherType = 'clear' | 'rain' | 'storm' | 'snow' | 'drought';

let currentWeather: WeatherType = 'clear';
let weatherTimer = 0;

export function getCurrentWeather(): WeatherType {
    return currentWeather;
}

/** Weather changes based on season and randomness */
export function processWeather(scene: Scene, dt: number) {
    weatherTimer -= dt;
    if (weatherTimer > 0) return;

    // New weather every 2-5 game days
    weatherTimer = SECONDS_PER_DAY * (2 + Math.random() * 3);

    const cal = getCalendar(scene.time);
    const roll = Math.random();

    switch (cal.season) {
        case 'Printemps':
            currentWeather = roll < 0.5 ? 'clear' : roll < 0.8 ? 'rain' : 'storm';
            break;
        case 'Été':
            currentWeather = roll < 0.6 ? 'clear' : roll < 0.8 ? 'rain' : 'drought';
            break;
        case 'Automne':
            currentWeather = roll < 0.3 ? 'clear' : roll < 0.7 ? 'rain' : 'storm';
            break;
        case 'Hiver':
            currentWeather = roll < 0.3 ? 'clear' : roll < 0.6 ? 'snow' : 'storm';
            break;
    }

    emitEvent({ type: 'weather_change', weatherType: currentWeather });
    logger.info('WEATHER', `Weather changed to: ${currentWeather}`);
}

/** Apply weather effects to NPCs (movement speed, mood, needs) */
export function applyWeatherEffects(scene: Scene, dt: number) {
    const weather = getCurrentWeather();
    if (weather === 'clear') return;

    const npcs = scene.entities.filter(
        (e): e is NPCEntity => e.type === 'npc'
    );

    for (const npc of npcs) {
        switch (weather) {
            case 'rain':
                // Slightly faster thirst drain, lower happiness
                npc.needs.happiness = Math.max(0, npc.needs.happiness - 0.5 * dt);
                break;
            case 'storm':
                // Faster energy drain, much lower happiness
                npc.needs.energy = Math.max(0, npc.needs.energy - 0.3 * dt);
                npc.needs.happiness = Math.max(0, npc.needs.happiness - 1.0 * dt);
                break;
            case 'snow':
                // Faster hunger and energy drain, slightly lower health
                npc.needs.hunger = Math.max(0, npc.needs.hunger - 0.2 * dt);
                npc.needs.energy = Math.max(0, npc.needs.energy - 0.2 * dt);
                break;
            case 'drought':
                // Much faster thirst drain
                npc.needs.thirst = Math.max(0, npc.needs.thirst - 0.4 * dt);
                break;
        }
    }
}

// =============================================================
//  EPIDEMIC SYSTEM
// =============================================================

type ActiveEpidemic = {
    factionId: string;
    diseaseName: string;
    infectedIds: Set<string>;
    mortalityRate: number;   // damage per second to infected NPCs
    spreadChance: number;    // chance to spread per nearby NPC per tick
    duration: number;        // remaining sim-seconds
};

const activeEpidemics: ActiveEpidemic[] = [];

const DISEASE_NAMES = ['Peste', 'Grippe', 'Fièvre', 'Dysenterie', 'Variole'];
const EPIDEMIC_CHECK_INTERVAL = SECONDS_PER_SEASON; // check every season
let epidemicTimer = EPIDEMIC_CHECK_INTERVAL;
const EPIDEMIC_CHANCE = 0.15;  // 15% chance per season per faction
const CONTACT_SPREAD_RANGE = 30; // px

export function processEpidemics(scene: Scene, dt: number) {
    // Check for new epidemics
    epidemicTimer -= dt;
    if (epidemicTimer <= 0) {
        epidemicTimer = EPIDEMIC_CHECK_INTERVAL;

        for (const faction of getAllFactions()) {
            if (faction.memberIds.length < 3) continue;
            if (activeEpidemics.some((e) => e.factionId === faction.id)) continue;

            if (Math.random() < EPIDEMIC_CHANCE) {
                startEpidemic(scene, faction);
            }
        }
    }

    // Process active epidemics
    for (let i = activeEpidemics.length - 1; i >= 0; i--) {
        const epidemic = activeEpidemics[i];
        epidemic.duration -= dt;

        if (epidemic.duration <= 0 || epidemic.infectedIds.size === 0) {
            logger.info('EVENT', `Epidemic "${epidemic.diseaseName}" ended in faction ${epidemic.factionId}`);
            emitEvent({ type: 'epidemic_end', targetFactionId: epidemic.factionId });
            activeEpidemics.splice(i, 1);
            continue;
        }

        // Apply damage to infected
        for (const infectedId of epidemic.infectedIds) {
            const npc = scene.entities.find(
                (e): e is NPCEntity => e.id === infectedId && e.type === 'npc'
            );
            if (!npc) {
                epidemic.infectedIds.delete(infectedId);
                continue;
            }

            npc.needs.health = Math.max(0, npc.needs.health - epidemic.mortalityRate * dt);
            npc.needs.happiness = Math.max(0, npc.needs.happiness - 2 * dt);

            // Spread to nearby NPCs
            if (Math.random() < epidemic.spreadChance * dt) {
                for (const other of scene.entities) {
                    if (other.type !== 'npc') continue;
                    if (other.id === npc.id) continue;
                    if (epidemic.infectedIds.has(other.id)) continue;

                    const dist = distance(npc.position, (other as NPCEntity).position);
                    if (dist < CONTACT_SPREAD_RANGE) {
                        epidemic.infectedIds.add(other.id);
                        logger.info('EVENT', `${(other as NPCEntity).name} infected with ${epidemic.diseaseName}`);
                    }
                }
            }
        }
    }
}

function startEpidemic(scene: Scene, faction: Faction) {
    const diseaseName = DISEASE_NAMES[Math.floor(Math.random() * DISEASE_NAMES.length)];

    // Pick patient zero
    const patientZeroId = faction.memberIds[Math.floor(Math.random() * faction.memberIds.length)];

    const epidemic: ActiveEpidemic = {
        factionId: faction.id,
        diseaseName,
        infectedIds: new Set([patientZeroId]),
        mortalityRate: 0.5 + Math.random() * 1.5, // 0.5-2.0 HP/sec
        spreadChance: 0.02 + Math.random() * 0.03, // 2-5% per second per nearby NPC
        duration: SECONDS_PER_SEASON * (0.5 + Math.random()), // 0.5-1.5 seasons
    };

    activeEpidemics.push(epidemic);
    emitEvent({ type: 'epidemic_start', targetFactionId: faction.id, diseaseName });
    logger.info('EVENT', `Epidemic "${diseaseName}" started in ${faction.name}! Patient zero: ${patientZeroId}`);
}

// =============================================================
//  FAMINE DETECTION
// =============================================================

let famineCheckTimer = SECONDS_PER_DAY * 5; // check every 5 days
const activeFamines = new Set<string>(); // faction IDs

export function processFamines(scene: Scene, dt: number) {
    famineCheckTimer -= dt;
    if (famineCheckTimer > 0) return;
    famineCheckTimer = SECONDS_PER_DAY * 5;

    for (const faction of getAllFactions()) {
        let totalFood = 0;
        for (const buildingId of faction.buildingIds) {
            const stock = scene.entities.find(
                (e): e is StockEntity => e.type === 'stock' && e.cabinId === buildingId
            );
            if (stock) {
                totalFood += countItem(stock.items, 'food');
                totalFood += countItem(stock.items, 'bread');
                totalFood += countItem(stock.items, 'meat');
            }
        }

        const foodPerPerson = faction.memberIds.length > 0 ? totalFood / faction.memberIds.length : 0;
        const isFamine = foodPerPerson < 1;

        if (isFamine && !activeFamines.has(faction.id)) {
            activeFamines.add(faction.id);
            emitEvent({ type: 'famine_start', targetFactionId: faction.id });
            logger.info('EVENT', `Famine in ${faction.name}! Food per person: ${foodPerPerson.toFixed(1)}`);
        } else if (!isFamine && activeFamines.has(faction.id)) {
            activeFamines.delete(faction.id);
            emitEvent({ type: 'famine_end', targetFactionId: faction.id });
            logger.info('EVENT', `Famine ended in ${faction.name}`);
        }
    }
}

// =============================================================
//  FIRE SYSTEM
// =============================================================

let fireCheckTimer = SECONDS_PER_DAY * 10; // check every 10 days
const FIRE_CHANCE_BASE = 0.03; // 3% per building per check
const FIRE_DROUGHT_MULT = 3;   // 3x more likely during drought

export function processFires(scene: Scene, dt: number) {
    fireCheckTimer -= dt;
    if (fireCheckTimer > 0) return;
    fireCheckTimer = SECONDS_PER_DAY * 10;

    const fireChance = getCurrentWeather() === 'drought'
        ? FIRE_CHANCE_BASE * FIRE_DROUGHT_MULT
        : FIRE_CHANCE_BASE;

    const buildings = scene.entities.filter(
        (e): e is BuildingEntity => e.type === 'building'
    );

    for (const building of buildings) {
        if (Math.random() >= fireChance) continue;

        logger.info('EVENT', `Fire at ${building.buildingType} (${building.id})!`);
        emitEvent({ type: 'fire', buildingId: building.id, position: building.position });

        // Destroy the building and its stock
        const buildingIdx = scene.entities.findIndex((e) => e.id === building.id);
        if (buildingIdx !== -1) scene.entities.splice(buildingIdx, 1);

        const stockIdx = scene.entities.findIndex(
            (e) => e.type === 'stock' && (e as StockEntity).cabinId === building.id
        );
        if (stockIdx !== -1) scene.entities.splice(stockIdx, 1);

        // Evict residents
        for (const resId of building.residentIds) {
            const npc = scene.entities.find(
                (e): e is NPCEntity => e.id === resId && e.type === 'npc'
            );
            if (npc) {
                npc.homeId = null;
                npc.needs.happiness = Math.max(0, npc.needs.happiness - 30);
            }
        }

        break; // only one fire per check
    }
}

// =============================================================
//  RAID SYSTEM
// =============================================================

let raidCheckTimer = SECONDS_PER_SEASON; // check every season

export function processRaids(scene: Scene, dt: number) {
    raidCheckTimer -= dt;
    if (raidCheckTimer > 0) return;
    raidCheckTimer = SECONDS_PER_SEASON;

    const factions = getAllFactions();

    for (const attacker of factions) {
        for (const defender of factions) {
            if (attacker.id === defender.id) continue;
            if (getRelation(attacker.id, defender.id) !== 'hostile') continue;

            // Only raid if attacker has military advantage
            if (attacker.militaryPower <= defender.militaryPower * 1.2) continue;

            // 30% chance to raid when hostile
            if (Math.random() > 0.3) continue;

            logger.info('EVENT', `${attacker.name} raids ${defender.name}!`);
            emitEvent({ type: 'raid', attackerFactionId: attacker.id, defenderFactionId: defender.id });

            // Raid effect: steal resources from defender stocks
            for (const buildingId of defender.buildingIds) {
                const stock = scene.entities.find(
                    (e): e is StockEntity => e.type === 'stock' && e.cabinId === buildingId
                );
                if (!stock) continue;

                // Steal up to half of each resource
                for (const stack of [...stock.items]) {
                    const stolen = Math.floor(stack.quantity * 0.3);
                    if (stolen > 0) {
                        removeItem(stock.items, stack.itemId, stolen);
                        // Try to deposit in attacker's first building stock
                        if (attacker.buildingIds.length > 0) {
                            const attackerStock = scene.entities.find(
                                (e): e is StockEntity =>
                                    e.type === 'stock' && e.cabinId === attacker.buildingIds[0]
                            );
                            if (attackerStock) {
                                addItem(attackerStock.items, stack.itemId, stolen);
                            }
                        }
                    }
                }
            }

            // Damage to defenders
            for (const defId of defender.memberIds) {
                const npc = scene.entities.find(
                    (e): e is NPCEntity => e.id === defId && e.type === 'npc'
                );
                if (npc) {
                    npc.needs.happiness = Math.max(0, npc.needs.happiness - 20);
                    // 10% chance of injury during raid
                    if (Math.random() < 0.1) {
                        npc.needs.health = Math.max(0, npc.needs.health - 15 - Math.random() * 20);
                    }
                }
            }

            break; // max one raid per check
        }
    }
}

// =============================================================
//  MASTER EVENT PROCESSOR
// =============================================================

export function processEvents(scene: Scene, dt: number) {
    processWeather(scene, dt);
    applyWeatherEffects(scene, dt);
    processEpidemics(scene, dt);
    processFamines(scene, dt);
    processFires(scene, dt);
    processRaids(scene, dt);
    processEventQueue(scene);
}
