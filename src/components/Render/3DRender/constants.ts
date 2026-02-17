import type { LifeStage } from '../../World/types';
import type { SoilProperty } from '../../World/fertility';

export const SCALE = 0.1;
export const HEIGHT_SCALE = SCALE;

export const SOIL_OVERLAY_COLORS: Record<SoilProperty, { r0: number; g0: number; b0: number; r1: number; g1: number; b1: number }> = {
    humidity: { r0: 200, g0: 184, b0: 122, r1: 26, g1: 122, b1: 180 },
    minerals: { r0: 180, g0: 170, b0: 150, r1: 160, g1: 100, b1: 30 },
    organicMatter: { r0: 200, g0: 190, b0: 170, r1: 40, g1: 30, b1: 10 },
    sunExposure: { r0: 60, g0: 60, b0: 80, r1: 255, g1: 240, b1: 140 },
};

export const NPC_HEIGHT: Record<LifeStage, number> = { baby: 0.4, child: 0.7, adolescent: 1.0, adult: 1.2 };
export const NPC_WIDTH: Record<LifeStage, number> = { baby: 0.25, child: 0.35, adolescent: 0.4, adult: 0.45 };

export const PLAYER_SPEED = 0.5;
export const PLAYER_SPRINT_MULT = 2.5;
export const PLAYER_CROUCH_MULT = 0.35;
export const PLAYER_SWIM_MULT = 0.4;
export const SWIM_EYE_OFFSET = -0.06;
export const MOUSE_SENSITIVITY = 0.001;
export const FP_EYE_HEIGHT = 0.216;
export const FP_CROUCH_HEIGHT = 0.13;

export const STAMINA_MAX = 100;
export const STAMINA_DRAIN = 10;
export const STAMINA_REGEN = 40;
export const STAMINA_REGEN_DELAY = 1.5;
export const STAMINA_EXHAUST_THRESHOLD = 5;

export const HL_CAM_POS = 0.01;
export const HL_CAM_Y = 0.01;
export const HL_MESH_POS = 0.10;
export const HL_MESH_Y = 0.16;
export const HL_MESH_ROT = 0.08;
export const GAMEPAD_DEADZONE = 0.15;
export const GAMEPAD_CAM_SENSITIVITY = 2.5;

export const INTERACT_RANGE = 6;
export const PICK_DURATION_FRUIT = 0.6;
export const PICK_DURATION_BUSH = 1.5;
export const PICK_DURATION_TREE = 4.0;
export const PICK_DURATION_HERB = 0.8;
export const TREE_IDS = new Set(['oak', 'pine', 'birch', 'willow', 'apple', 'cherry']);
export const BUSH_IDS = new Set(['raspberry', 'mushroom']);
export const HERB_IDS = new Set(['wheat', 'wildflower', 'thyme', 'sage', 'reed']);

export const GRASS_CHUNK_SIZE = 80;
export const GRASS_RENDER_RADIUS = 550;
export const GRASS_LOD_BOUNDARY = 180;
export const GRASS_STEP_NEAR = 0.5;
export const GRASS_STEP_FAR = 2.5;
export const GRASS_SCALE_FAR = 1.6;
export const DEBUG_HIDE_GRASS = false;
export const DEBUG_WIREFRAME = false;

export const RAIN_COUNT = 20000;
export const RAIN_AREA = 40;
export const RAIN_HEIGHT_RANGE = 15;
export const RAIN_SPEED = 25;
export const RAIN_STREAK = 0.35;
export const SNOW_COUNT = 100000;
export const SNOW_AREA = 50;
export const SNOW_HEIGHT_RANGE = 30;
export const SNOW_SPEED = 2.3;
