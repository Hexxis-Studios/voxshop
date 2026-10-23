export const DEFAULT_SCENE_LIGHTING = {
  hemisphere: { skyColor: 0xc5e3ff, groundColor: 0x334025, intensity: 2 },
  directional: {
    color: 0xffe8ce,
    intensity: 3,
    position: [12, 24, 8] as [number, number, number],
    castShadow: true,
  },
};
