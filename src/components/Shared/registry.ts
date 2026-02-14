// =============================================================
//  DATA REGISTRIES — Item, Building, Recipe, Job definitions
//  All game content is data-driven through these registries.
// =============================================================

// --- Item System ---

export type ItemCategory = 'food' | 'drink' | 'material' | 'tool' | 'weapon' | 'armor' | 'currency';

export type ItemDef = {
    id: string;
    category: ItemCategory;
    displayName: string;
    nutrition?: number;     // hunger restored when consumed (food only)
    hydration?: number;     // thirst restored when consumed (drink only)
    damage?: number;        // weapon damage
    defense?: number;       // armor defense
    weight: number;         // affects carry capacity
    stackable: boolean;
    color: string;          // render color
    icon: 'circle' | 'square' | 'diamond' | 'drop' | 'coin';  // shape for rendering
};

export type ItemStack = {
    itemId: string;
    quantity: number;
};

// --- Building System ---

export type BuildingDef = {
    id: string;
    displayName: string;
    buildCost: ItemStack[];
    capacity: number;       // max residents or workers
    jobs: string[];         // jobs this building enables
    storage: number;        // max stock item stacks
    color: string;          // default render color
    isResidential: boolean; // can NPCs live here?
};

// --- Recipe System ---

export type RecipeDef = {
    id: string;
    displayName: string;
    inputs: ItemStack[];
    outputs: ItemStack[];
    duration: number;       // sim-seconds to craft
    requiredBuilding?: string;  // must be near this building type
    requiredJob?: string;       // NPC must have this job
};

// --- Job System ---

export type JobDef = {
    id: string;
    displayName: string;
    gatherBonus: Record<string, number>;  // itemId → speed multiplier for gathering
    craftBonus: Record<string, number>;   // recipeId → speed multiplier for crafting
    priorityItems: string[];              // item IDs this job prioritizes gathering
};

// =============================================================
//  ITEM REGISTRY
// =============================================================

const ITEMS: ItemDef[] = [
    // --- Food ---
    { id: 'food', category: 'food', displayName: 'Baies', nutrition: 35, weight: 1, stackable: true, color: '#2ecc71', icon: 'circle' },
    { id: 'wheat', category: 'material', displayName: 'Blé', weight: 1, stackable: true, color: '#f1c40f', icon: 'circle' },
    { id: 'bread', category: 'food', displayName: 'Pain', nutrition: 60, weight: 1, stackable: true, color: '#e67e22', icon: 'circle' },
    { id: 'meat', category: 'food', displayName: 'Viande', nutrition: 50, weight: 2, stackable: true, color: '#c0392b', icon: 'circle' },

    // --- Drink ---
    { id: 'water', category: 'drink', displayName: 'Eau', hydration: 30, weight: 1, stackable: true, color: '#00bcd4', icon: 'drop' },

    // --- Materials ---
    { id: 'wood', category: 'material', displayName: 'Bois', weight: 2, stackable: true, color: '#8B6914', icon: 'square' },
    { id: 'stone', category: 'material', displayName: 'Pierre', weight: 3, stackable: true, color: '#7f8c8d', icon: 'square' },
    { id: 'iron_ore', category: 'material', displayName: 'Minerai de fer', weight: 3, stackable: true, color: '#95a5a6', icon: 'square' },
    { id: 'iron_ingot', category: 'material', displayName: 'Lingot de fer', weight: 2, stackable: true, color: '#bdc3c7', icon: 'square' },
    { id: 'leather', category: 'material', displayName: 'Cuir', weight: 1, stackable: true, color: '#795548', icon: 'square' },

    // --- Tools ---
    { id: 'pickaxe', category: 'tool', displayName: 'Pioche', weight: 3, stackable: false, color: '#607d8b', icon: 'diamond' },
    { id: 'axe', category: 'tool', displayName: 'Hache', weight: 3, stackable: false, color: '#607d8b', icon: 'diamond' },

    // --- Weapons ---
    { id: 'sword', category: 'weapon', displayName: 'Épée', damage: 15, weight: 3, stackable: false, color: '#bdc3c7', icon: 'diamond' },
    { id: 'bow', category: 'weapon', displayName: 'Arc', damage: 10, weight: 2, stackable: false, color: '#8B6914', icon: 'diamond' },
    { id: 'spear', category: 'weapon', displayName: 'Lance', damage: 12, weight: 3, stackable: false, color: '#7f8c8d', icon: 'diamond' },

    // --- Armor ---
    { id: 'leather_armor', category: 'armor', displayName: 'Armure de cuir', defense: 5, weight: 4, stackable: false, color: '#795548', icon: 'diamond' },
    { id: 'iron_armor', category: 'armor', displayName: 'Armure de fer', defense: 12, weight: 8, stackable: false, color: '#bdc3c7', icon: 'diamond' },

    // --- Currency ---
    { id: 'coin', category: 'currency', displayName: 'Pièce', weight: 0.1, stackable: true, color: '#f1c40f', icon: 'coin' },
];

// =============================================================
//  BUILDING REGISTRY
// =============================================================

const BUILDINGS: BuildingDef[] = [
    {
        id: 'cabin', displayName: 'Cabane',
        buildCost: [{ itemId: 'wood', quantity: 3 }],
        capacity: 4, jobs: [], storage: 20,
        color: '#8B6914', isResidential: true,
    },
    {
        id: 'farm', displayName: 'Ferme',
        buildCost: [{ itemId: 'wood', quantity: 5 }, { itemId: 'stone', quantity: 2 }],
        capacity: 2, jobs: ['farmer'], storage: 30,
        color: '#f1c40f', isResidential: false,
    },
    {
        id: 'smithy', displayName: 'Forge',
        buildCost: [{ itemId: 'wood', quantity: 4 }, { itemId: 'stone', quantity: 5 }],
        capacity: 1, jobs: ['blacksmith'], storage: 15,
        color: '#e74c3c', isResidential: false,
    },
    {
        id: 'bakery', displayName: 'Boulangerie',
        buildCost: [{ itemId: 'wood', quantity: 4 }, { itemId: 'stone', quantity: 3 }],
        capacity: 1, jobs: ['baker'], storage: 20,
        color: '#e67e22', isResidential: false,
    },
    {
        id: 'market', displayName: 'Marché',
        buildCost: [{ itemId: 'wood', quantity: 8 }, { itemId: 'stone', quantity: 4 }],
        capacity: 0, jobs: ['merchant'], storage: 50,
        color: '#9b59b6', isResidential: false,
    },
    {
        id: 'barracks', displayName: 'Caserne',
        buildCost: [{ itemId: 'wood', quantity: 6 }, { itemId: 'stone', quantity: 6 }, { itemId: 'iron_ingot', quantity: 2 }],
        capacity: 6, jobs: ['soldier'], storage: 10,
        color: '#c0392b', isResidential: false,
    },
];

// =============================================================
//  RECIPE REGISTRY
// =============================================================

const RECIPES: RecipeDef[] = [
    {
        id: 'bake_bread', displayName: 'Cuire du pain',
        inputs: [{ itemId: 'wheat', quantity: 2 }],
        outputs: [{ itemId: 'bread', quantity: 1 }],
        duration: 30, requiredBuilding: 'bakery', requiredJob: 'baker',
    },
    {
        id: 'smelt_iron', displayName: 'Fondre du fer',
        inputs: [{ itemId: 'iron_ore', quantity: 2 }, { itemId: 'wood', quantity: 1 }],
        outputs: [{ itemId: 'iron_ingot', quantity: 1 }],
        duration: 60, requiredBuilding: 'smithy', requiredJob: 'blacksmith',
    },
    {
        id: 'forge_sword', displayName: 'Forger une épée',
        inputs: [{ itemId: 'iron_ingot', quantity: 2 }, { itemId: 'wood', quantity: 1 }],
        outputs: [{ itemId: 'sword', quantity: 1 }],
        duration: 90, requiredBuilding: 'smithy', requiredJob: 'blacksmith',
    },
    {
        id: 'forge_spear', displayName: 'Forger une lance',
        inputs: [{ itemId: 'iron_ingot', quantity: 1 }, { itemId: 'wood', quantity: 2 }],
        outputs: [{ itemId: 'spear', quantity: 1 }],
        duration: 60, requiredBuilding: 'smithy', requiredJob: 'blacksmith',
    },
    {
        id: 'forge_pickaxe', displayName: 'Forger une pioche',
        inputs: [{ itemId: 'iron_ingot', quantity: 1 }, { itemId: 'wood', quantity: 1 }],
        outputs: [{ itemId: 'pickaxe', quantity: 1 }],
        duration: 45, requiredBuilding: 'smithy', requiredJob: 'blacksmith',
    },
    {
        id: 'forge_axe', displayName: 'Forger une hache',
        inputs: [{ itemId: 'iron_ingot', quantity: 1 }, { itemId: 'wood', quantity: 1 }],
        outputs: [{ itemId: 'axe', quantity: 1 }],
        duration: 45, requiredBuilding: 'smithy', requiredJob: 'blacksmith',
    },
    {
        id: 'craft_leather_armor', displayName: 'Fabriquer armure de cuir',
        inputs: [{ itemId: 'leather', quantity: 4 }],
        outputs: [{ itemId: 'leather_armor', quantity: 1 }],
        duration: 60,
    },
    {
        id: 'forge_iron_armor', displayName: 'Forger armure de fer',
        inputs: [{ itemId: 'iron_ingot', quantity: 4 }, { itemId: 'leather', quantity: 2 }],
        outputs: [{ itemId: 'iron_armor', quantity: 1 }],
        duration: 120, requiredBuilding: 'smithy', requiredJob: 'blacksmith',
    },
    {
        id: 'craft_bow', displayName: 'Fabriquer un arc',
        inputs: [{ itemId: 'wood', quantity: 2 }, { itemId: 'leather', quantity: 1 }],
        outputs: [{ itemId: 'bow', quantity: 1 }],
        duration: 45,
    },
];

// =============================================================
//  JOB REGISTRY
// =============================================================

const JOBS: JobDef[] = [
    {
        id: 'farmer', displayName: 'Fermier',
        gatherBonus: { food: 1.5, wheat: 1.5 },
        craftBonus: {},
        priorityItems: ['food', 'wheat'],
    },
    {
        id: 'woodcutter', displayName: 'Bûcheron',
        gatherBonus: { wood: 1.8 },
        craftBonus: {},
        priorityItems: ['wood'],
    },
    {
        id: 'hunter', displayName: 'Chasseur',
        gatherBonus: { meat: 1.5, leather: 1.3 },
        craftBonus: { craft_bow: 1.3 },
        priorityItems: ['meat', 'leather'],
    },
    {
        id: 'baker', displayName: 'Boulanger',
        gatherBonus: {},
        craftBonus: { bake_bread: 1.5 },
        priorityItems: ['wheat', 'bread'],
    },
    {
        id: 'blacksmith', displayName: 'Forgeron',
        gatherBonus: { iron_ore: 1.3 },
        craftBonus: { smelt_iron: 1.3, forge_sword: 1.3, forge_spear: 1.3, forge_pickaxe: 1.3, forge_axe: 1.3, forge_iron_armor: 1.3 },
        priorityItems: ['iron_ore', 'iron_ingot'],
    },
    {
        id: 'merchant', displayName: 'Marchand',
        gatherBonus: {},
        craftBonus: {},
        priorityItems: ['coin'],
    },
    {
        id: 'soldier', displayName: 'Soldat',
        gatherBonus: {},
        craftBonus: {},
        priorityItems: ['sword', 'spear', 'bow'],
    },
];

// =============================================================
//  REGISTRY LOOKUP API
// =============================================================

const itemMap = new Map<string, ItemDef>();
const buildingMap = new Map<string, BuildingDef>();
const recipeMap = new Map<string, RecipeDef>();
const jobMap = new Map<string, JobDef>();

for (const item of ITEMS) itemMap.set(item.id, item);
for (const b of BUILDINGS) buildingMap.set(b.id, b);
for (const r of RECIPES) recipeMap.set(r.id, r);
for (const j of JOBS) jobMap.set(j.id, j);

export function getItemDef(id: string): ItemDef | undefined { return itemMap.get(id); }
export function getBuildingDef(id: string): BuildingDef | undefined { return buildingMap.get(id); }
export function getRecipeDef(id: string): RecipeDef | undefined { return recipeMap.get(id); }
export function getJobDef(id: string): JobDef | undefined { return jobMap.get(id); }

export function getAllItems(): ItemDef[] { return ITEMS; }
export function getAllBuildings(): BuildingDef[] { return BUILDINGS; }
export function getAllRecipes(): RecipeDef[] { return RECIPES; }
export function getAllJobs(): JobDef[] { return JOBS; }

/** Get all recipes that can be performed at a given building type */
export function getRecipesForBuilding(buildingId: string): RecipeDef[] {
    return RECIPES.filter((r) => r.requiredBuilding === buildingId);
}

/** Get all recipes that require a specific job */
export function getRecipesForJob(jobId: string): RecipeDef[] {
    return RECIPES.filter((r) => r.requiredJob === jobId);
}

/** Check if an item is edible (food or drink) */
export function isEdible(itemId: string): boolean {
    const def = getItemDef(itemId);
    return def?.category === 'food' || def?.category === 'drink';
}

/** Check if an item restores hunger */
export function isFood(itemId: string): boolean {
    const def = getItemDef(itemId);
    return (def?.nutrition ?? 0) > 0;
}

/** Check if an item restores thirst */
export function isDrink(itemId: string): boolean {
    const def = getItemDef(itemId);
    return (def?.hydration ?? 0) > 0;
}

// --- ItemStack helpers ---

/** Count total quantity of a specific item in a stack array */
export function countItem(stacks: ItemStack[], itemId: string): number {
    return stacks.filter((s) => s.itemId === itemId).reduce((sum, s) => sum + s.quantity, 0);
}

/** Add items to a stack array (merging if stackable) */
export function addItem(stacks: ItemStack[], itemId: string, quantity: number): void {
    const def = getItemDef(itemId);
    if (def?.stackable) {
        const existing = stacks.find((s) => s.itemId === itemId);
        if (existing) {
            existing.quantity += quantity;
            return;
        }
    }
    // Non-stackable items or new stacks: add one stack per item
    if (def?.stackable) {
        stacks.push({ itemId, quantity });
    } else {
        for (let i = 0; i < quantity; i++) {
            stacks.push({ itemId, quantity: 1 });
        }
    }
}

/** Remove items from a stack array. Returns true if enough items were removed. */
export function removeItem(stacks: ItemStack[], itemId: string, quantity: number): boolean {
    let remaining = quantity;
    for (let i = stacks.length - 1; i >= 0 && remaining > 0; i--) {
        if (stacks[i].itemId !== itemId) continue;
        const take = Math.min(stacks[i].quantity, remaining);
        stacks[i].quantity -= take;
        remaining -= take;
        if (stacks[i].quantity <= 0) stacks.splice(i, 1);
    }
    return remaining <= 0;
}

/** Check if enough items exist in a stack array */
export function hasItems(stacks: ItemStack[], itemId: string, quantity: number): boolean {
    return countItem(stacks, itemId) >= quantity;
}

/** Check if all required items exist */
export function hasAllItems(stacks: ItemStack[], requirements: ItemStack[]): boolean {
    return requirements.every((req) => hasItems(stacks, req.itemId, req.quantity));
}
