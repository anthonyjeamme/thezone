# 3D Renderer Architecture

This directory contains the Three.js 3D renderer implementation, organized into modular files for better maintainability.

## File Structure

### Core Files
- **ThreeRenderer.ts** - Main renderer class, orchestrates all systems
- **constants.ts** - Configuration constants and settings
- **utils.ts** - Utility functions (coordinate conversion, smoothing)
- **types.ts** - TypeScript type definitions

### Entity & Model Builders
- **CharacterBuilder.ts** - Minecraft-style character creation and animation
- **EntityBuilders.ts** - Buildings, resources, corpses, zones meshes
- **AnimalModels.ts** - 3D models for animals (rabbit, deer, fox, wolf)
- **TextSprite.ts** - Text sprite utilities for labels

### Systems
- **WeatherSystem.ts** - Rain, snow, and lightning effects

### Design Principles

1. **Separation of Concerns** - Each file has a single, well-defined responsibility
2. **Reusability** - Functions and classes can be tested independently
3. **Maintainability** - Smaller files are easier to understand and modify
4. **Type Safety** - Shared types ensure consistency across modules

## Module Dependencies

```
ThreeRenderer (main orchestrator)
├── constants
├── utils
├── types
├── CharacterBuilder
├── EntityBuilders
├── AnimalModels
├── TextSprite
└── WeatherSystem
```

## Usage

The main `ThreeRenderer` class imports and uses all these modules to render the 3D scene. Each subsystem can be developed and tested independently while maintaining a clean separation of concerns.
