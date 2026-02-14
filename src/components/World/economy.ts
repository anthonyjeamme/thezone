// =============================================================
//  ECONOMY — Pricing, market, and monetary trade
// =============================================================

import { BuildingEntity, NPCEntity, Scene, StockEntity, WorldAPI, countItem, addItem, removeItem } from './types';
import { getItemDef, getAllItems, ItemDef } from '../Shared/registry';
import { distance } from '../Shared/vector';
import { logger } from '../Shared/logger';

// --- Price calculation ---

/** Base price for each item category */
const BASE_PRICES: Record<string, number> = {
    food: 2,
    drink: 2,
    material: 3,
    tool: 15,
    weapon: 25,
    armor: 30,
    currency: 1,
};

/** Price range limits */
const MIN_PRICE = 1;
const MAX_PRICE = 100;

/**
 * Calculate dynamic price for an item based on local supply/demand.
 * Higher supply → lower price. Higher demand → higher price.
 */
export function calculatePrice(itemId: string, scene: Scene, position: { x: number; y: number }, range = 300): number {
    const def = getItemDef(itemId);
    if (!def) return 10;
    if (def.category === 'currency') return 1;

    const basePrice = BASE_PRICES[def.category] ?? 5;

    // Count local supply (items in all stocks within range)
    let localSupply = 0;
    let localDemand = 0;
    let stockCount = 0;

    for (const e of scene.entities) {
        if (e.type === 'stock') {
            const stock = e as StockEntity;
            const dist = distance(position, stock.position);
            if (dist > range) continue;
            stockCount++;
            localSupply += countItem(stock.items, itemId);
        }
    }

    // Demand: count NPCs in range who need this item
    for (const e of scene.entities) {
        if (e.type !== 'npc') continue;
        const npc = e as NPCEntity;
        if (distance(position, npc.position) > range) continue;

        if (def.nutrition && def.nutrition > 0 && npc.needs.hunger < 50) localDemand++;
        if (def.hydration && def.hydration > 0 && npc.needs.thirst < 50) localDemand++;
        if (def.category === 'material') localDemand += 0.5; // always some demand for materials
    }

    // Price formula: base * (1 + demand_factor) / (1 + supply_factor)
    const supplyFactor = stockCount > 0 ? localSupply / (stockCount * 3) : 0; // normalized
    const demandFactor = localDemand / 5; // normalized

    const price = Math.round(basePrice * (1 + demandFactor) / (1 + supplyFactor));
    return Math.max(MIN_PRICE, Math.min(MAX_PRICE, price));
}

// --- Market info ---

export type MarketListing = {
    itemId: string;
    displayName: string;
    price: number;        // coins per unit
    available: number;    // units available in market stock
};

/**
 * Get the listing of items available at a market building.
 * A market aggregates items from all stocks within its range.
 */
export function getMarketListings(scene: Scene, marketId: string): MarketListing[] {
    const market = scene.entities.find(
        (e): e is BuildingEntity => e.type === 'building' && e.id === marketId
    );
    if (!market) return [];

    // Find the market's stock
    const marketStock = scene.entities.find(
        (e): e is StockEntity => e.type === 'stock' && e.cabinId === marketId
    );
    if (!marketStock) return [];

    const listings: MarketListing[] = [];

    // Gather all unique items in market stock
    const itemIds = new Set(marketStock.items.map((s) => s.itemId));

    for (const itemId of itemIds) {
        const def = getItemDef(itemId);
        if (!def || def.category === 'currency') continue;

        const available = countItem(marketStock.items, itemId);
        if (available <= 0) continue;

        const price = calculatePrice(itemId, scene, market.position);
        listings.push({
            itemId,
            displayName: def.displayName,
            price,
            available,
        });
    }

    return listings;
}

// --- NPC market interaction ---

/**
 * NPC buys an item from a market (removes coins from NPC stock, adds item to NPC stock).
 * The market must have the item, the NPC must have enough coins.
 */
export function buyFromMarket(
    scene: Scene,
    npc: NPCEntity,
    marketId: string,
    itemId: string,
    quantity: number,
): boolean {
    if (!npc.homeId) return false;

    const marketStock = scene.entities.find(
        (e): e is StockEntity => e.type === 'stock' && e.cabinId === marketId
    );
    if (!marketStock) return false;

    const npcStock = scene.entities.find(
        (e): e is StockEntity => e.type === 'stock' && e.cabinId === npc.homeId
    );
    if (!npcStock) return false;

    const market = scene.entities.find(
        (e): e is BuildingEntity => e.type === 'building' && e.id === marketId
    );
    if (!market) return false;

    // Check market has the item
    const available = countItem(marketStock.items, itemId);
    if (available < quantity) return false;

    // Calculate total cost
    const unitPrice = calculatePrice(itemId, scene, market.position);
    const totalCost = unitPrice * quantity;

    // Check NPC has coins (in personal stock)
    const coins = countItem(npcStock.items, 'coin');
    if (coins < totalCost) return false;

    // Transaction
    removeItem(npcStock.items, 'coin', totalCost);
    addItem(marketStock.items, 'coin', totalCost);
    removeItem(marketStock.items, itemId, quantity);
    addItem(npcStock.items, itemId, quantity);

    logger.info('ECONOMY', `${npc.name} bought ${quantity}x ${itemId} for ${totalCost} coins`);
    return true;
}

/**
 * NPC sells an item to a market (adds coins to NPC stock, adds item to market stock).
 */
export function sellToMarket(
    scene: Scene,
    npc: NPCEntity,
    marketId: string,
    itemId: string,
    quantity: number,
): boolean {
    if (!npc.homeId) return false;

    const marketStock = scene.entities.find(
        (e): e is StockEntity => e.type === 'stock' && e.cabinId === marketId
    );
    if (!marketStock) return false;

    const npcStock = scene.entities.find(
        (e): e is StockEntity => e.type === 'stock' && e.cabinId === npc.homeId
    );
    if (!npcStock) return false;

    const market = scene.entities.find(
        (e): e is BuildingEntity => e.type === 'building' && e.id === marketId
    );
    if (!market) return false;

    // Check NPC has the item
    const available = countItem(npcStock.items, itemId);
    if (available < quantity) return false;

    // Calculate sell price (70% of buy price — market margin)
    const unitPrice = Math.max(1, Math.floor(calculatePrice(itemId, scene, market.position) * 0.7));
    const totalRevenue = unitPrice * quantity;

    // Check market has enough coins
    const marketCoins = countItem(marketStock.items, 'coin');
    if (marketCoins < totalRevenue) return false;

    // Transaction
    removeItem(npcStock.items, itemId, quantity);
    addItem(marketStock.items, itemId, quantity);
    removeItem(marketStock.items, 'coin', totalRevenue);
    addItem(npcStock.items, 'coin', totalRevenue);

    logger.info('ECONOMY', `${npc.name} sold ${quantity}x ${itemId} for ${totalRevenue} coins`);
    return true;
}
