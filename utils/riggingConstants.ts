export type PivotType = 'center' | 'top' | 'bottom' | 'left' | 'right' | 'front' | 'back';

export interface BoneDef {
    name: string;
    parent: string | null;
    pivotType: PivotType;
    color: string;
    /** Optional local rest transform for imported rigs, measured in model voxels. */
    bindPosition?: [number, number, number];
    bindRotation?: [number, number, number];
}

export interface AnimKeyframe {
    time: number;
    rot?: [number, number, number];
    pos?: [number, number, number];
    interpolation?: 'linear' | 'smooth' | 'step';
}

export interface AnimationDef {
    name: string;
    duration: number;
    tracks: Record<string, AnimKeyframe[]>;
}

export interface SkeletonDef {
    id: string;
    name: string;
    bones: BoneDef[];
    animations: AnimationDef[];
}

export const HUMANOID_SKELETON: SkeletonDef = {
    id: 'humanoid',
    name: 'Humanoid',
    bones: [
        { name: 'Torso', parent: null, pivotType: 'center', color: '#3b82f6' },
        { name: 'ArmL', parent: 'Torso', pivotType: 'top', color: '#10b981' },
        { name: 'ArmR', parent: 'Torso', pivotType: 'top', color: '#8b5cf6' },
        { name: 'LegL', parent: 'Torso', pivotType: 'top', color: '#f59e0b' },
        { name: 'LegR', parent: 'Torso', pivotType: 'top', color: '#ec4899' },
    ],
    animations: [
        {
            name: 'Idle',
            duration: 2.0,
            tracks: {
                'Torso': [
                    { time: 0, pos: [0, 0, 0] },
                    { time: 1, pos: [0, 0, 0] },
                    { time: 2, pos: [0, 0, 0] }
                ],
                'ArmL': [
                    { time: 0, rot: [0, 0, 0.1] },
                    { time: 1, rot: [0, 0, 0.15] },
                    { time: 2, rot: [0, 0, 0.1] }
                ],
                'ArmR': [
                    { time: 0, rot: [0, 0, -0.1] },
                    { time: 1, rot: [0, 0, -0.15] },
                    { time: 2, rot: [0, 0, -0.1] }
                ]
            }
        },
        {
            name: 'Walk',
            duration: 1.0,
            tracks: {
                'Torso': [
                    { time: 0, pos: [0, 0, 0], rot: [0, 0.1, 0] },
                    { time: 0.25, pos: [0, 0, 0], rot: [0, 0, 0] },
                    { time: 0.5, pos: [0, 0, 0], rot: [0, -0.1, 0] },
                    { time: 0.75, pos: [0, 0, 0], rot: [0, 0, 0] },
                    { time: 1.0, pos: [0, 0, 0], rot: [0, 0.1, 0] }
                ],
                'ArmL': [
                    { time: 0, rot: [0.5, 0, 0.1] },
                    { time: 0.5, rot: [-0.5, 0, 0.1] },
                    { time: 1.0, rot: [0.5, 0, 0.1] }
                ],
                'ArmR': [
                    { time: 0, rot: [-0.5, 0, -0.1] },
                    { time: 0.5, rot: [0.5, 0, -0.1] },
                    { time: 1.0, rot: [-0.5, 0, -0.1] }
                ],
                'LegL': [
                    { time: 0, rot: [-0.5, 0, 0] },
                    { time: 0.25, rot: [0, 0, 0], pos: [0, 1, 0] },
                    { time: 0.5, rot: [0.5, 0, 0] },
                    { time: 0.75, rot: [0, 0, 0] },
                    { time: 1.0, rot: [-0.5, 0, 0] }
                ],
                'LegR': [
                    { time: 0, rot: [0.5, 0, 0] },
                    { time: 0.25, rot: [0, 0, 0] },
                    { time: 0.5, rot: [-0.5, 0, 0] },
                    { time: 0.75, rot: [0, 0, 0], pos: [0, 1, 0] },
                    { time: 1.0, rot: [0.5, 0, 0] }
                ]
            }
        },
        {
            name: 'Run',
            duration: 0.8,
            tracks: {
                'Torso': [
                    { time: 0, pos: [0, 0, 0], rot: [0.2, 0, 0] },
                    { time: 0.4, pos: [0, 0, 0], rot: [0.2, 0, 0] },
                    { time: 0.8, pos: [0, 0, 0], rot: [0.2, 0, 0] }
                ],
                'ArmL': [
                    { time: 0, rot: [1.0, 0, 0.1] },
                    { time: 0.4, rot: [-1.0, 0, 0.1] },
                    { time: 0.8, rot: [1.0, 0, 0.1] }
                ],
                'ArmR': [
                    { time: 0, rot: [-1.0, 0, -0.1] },
                    { time: 0.4, rot: [1.0, 0, -0.1] },
                    { time: 0.8, rot: [-1.0, 0, -0.1] }
                ],
                'LegL': [
                    { time: 0, rot: [-1.0, 0, 0] },
                    { time: 0.4, rot: [1.0, 0, 0] },
                    { time: 0.8, rot: [-1.0, 0, 0] }
                ],
                'LegR': [
                    { time: 0, rot: [1.0, 0, 0] },
                    { time: 0.4, rot: [-1.0, 0, 0] },
                    { time: 0.8, rot: [1.0, 0, 0] }
                ]
            }
        },
        {
            name: 'Jump',
            duration: 1.0,
            tracks: {
                'Torso': [
                    { time: 0, pos: [0, -1, 0] },
                    { time: 0.2, pos: [0, 0, 0] },
                    { time: 0.5, pos: [0, 4, 0] },
                    { time: 0.8, pos: [0, 0, 0] },
                    { time: 1.0, pos: [0, -1, 0] }
                ],
                'ArmL': [
                    { time: 0, rot: [0, 0, 0.5] },
                    { time: 0.5, rot: [0, 0, 2.0] },
                    { time: 1.0, rot: [0, 0, 0.5] }
                ],
                'ArmR': [
                    { time: 0, rot: [0, 0, -0.5] },
                    { time: 0.5, rot: [0, 0, -2.0] },
                    { time: 1.0, rot: [0, 0, -0.5] }
                ],
                'LegL': [
                    { time: 0, rot: [-0.5, 0, 0] },
                    { time: 0.5, rot: [0.5, 0, 0] },
                    { time: 1.0, rot: [-0.5, 0, 0] }
                ],
                'LegR': [
                    { time: 0, rot: [-0.5, 0, 0] },
                    { time: 0.5, rot: [0.5, 0, 0] },
                    { time: 1.0, rot: [-0.5, 0, 0] }
                ]
            }
        },
        {
            name: 'Hurt',
            duration: 0.4,
            tracks: {
                'Torso': [
                    { time: 0, pos: [0, 0, 0], rot: [0, 0, 0] },
                    { time: 0.1, pos: [0, 0.5, -2], rot: [-0.2, 0, 0] },
                    { time: 0.4, pos: [0, 0, 0], rot: [0, 0, 0] }
                ],
                'LegL': [
                    { time: 0, rot: [0, 0, 0] },
                    { time: 0.1, rot: [0.5, 0, 0] },
                    { time: 0.2, rot: [-0.5, 0, 0] },
                    { time: 0.3, rot: [0.5, 0, 0] },
                    { time: 0.4, rot: [0, 0, 0] }
                ],
                'LegR': [
                    { time: 0, rot: [0, 0, 0] },
                    { time: 0.1, rot: [-0.5, 0, 0] },
                    { time: 0.2, rot: [0.5, 0, 0] },
                    { time: 0.3, rot: [-0.5, 0, 0] },
                    { time: 0.4, rot: [0, 0, 0] }
                ]
            }
        },
        {
            name: 'Attack',
            duration: 0.5,
            tracks: {
                'Torso': [
                    { time: 0, pos: [0, 0, 0], rot: [0, 0, 0] },
                    { time: 0.2, pos: [0, 0, 3], rot: [0.2, 0, 0] },
                    { time: 0.5, pos: [0, 0, 0], rot: [0, 0, 0] }
                ],
                'ArmL': [
                    { time: 0, rot: [0, 0, 0] },
                    { time: 0.2, rot: [-1.5, 0, 0] },
                    { time: 0.5, rot: [0, 0, 0] }
                ],
                'ArmR': [
                    { time: 0, rot: [0, 0, 0] },
                    { time: 0.2, rot: [-1.5, 0, 0] },
                    { time: 0.5, rot: [0, 0, 0] }
                ]
            }
        },
        {
            name: 'Death',
            duration: 1.0,
            tracks: {
                'Torso': [
                    { time: 0, pos: [0, 0, 0], rot: [0, 0, 0] },
                    { time: 0.5, pos: [0, -2, -2], rot: [-Math.PI / 2, 0, 0] },
                    { time: 1.0, pos: [0, -2, -2], rot: [-Math.PI / 2, 0, 0] }
                ]
            }
        }
    ]
};

export const QUADRUPED_SKELETON: SkeletonDef = {
    id: 'quadruped',
    name: 'Quadruped (Dog/Cat)',
    bones: [
        { name: 'Torso', parent: null, pivotType: 'center', color: '#3b82f6' },
        { name: 'LegFL', parent: 'Torso', pivotType: 'top', color: '#10b981' },
        { name: 'LegFR', parent: 'Torso', pivotType: 'top', color: '#8b5cf6' },
        { name: 'LegBL', parent: 'Torso', pivotType: 'top', color: '#f59e0b' },
        { name: 'LegBR', parent: 'Torso', pivotType: 'top', color: '#ec4899' },
    ],
    animations: [
        {
            name: 'Idle',
            duration: 2.0,
            tracks: {
                'Torso': [
                    { time: 0, pos: [0, 0, 0] },
                    { time: 1, pos: [0, 0, 0] },
                    { time: 2, pos: [0, 0, 0] }
                ]
            }
        },
        {
            name: 'Walk',
            duration: 1.0,
            tracks: {
                'Torso': [
                    { time: 0, pos: [0, 0, 0] },
                    { time: 0.25, pos: [0, 0, 0] },
                    { time: 0.5, pos: [0, 0, 0] },
                    { time: 0.75, pos: [0, 0, 0] },
                    { time: 1.0, pos: [0, 0, 0] }
                ],
                'LegFL': [
                    { time: 0, rot: [0.3, 0, 0] },
                    { time: 0.5, rot: [-0.3, 0, 0] },
                    { time: 1.0, rot: [0.3, 0, 0] }
                ],
                'LegBR': [
                    { time: 0, rot: [0.3, 0, 0] },
                    { time: 0.5, rot: [-0.3, 0, 0] },
                    { time: 1.0, rot: [0.3, 0, 0] }
                ],
                'LegFR': [
                    { time: 0, rot: [-0.3, 0, 0] },
                    { time: 0.5, rot: [0.3, 0, 0] },
                    { time: 1.0, rot: [-0.3, 0, 0] }
                ],
                'LegBL': [
                    { time: 0, rot: [-0.3, 0, 0] },
                    { time: 0.5, rot: [0.3, 0, 0] },
                    { time: 1.0, rot: [-0.3, 0, 0] }
                ]
            }
        },
        {
            name: 'Run',
            duration: 0.6,
            tracks: {
                'Torso': [
                    { time: 0, pos: [0, 0, 0], rot: [0.05, 0, 0] },
                    { time: 0.3, pos: [0, 0, 0], rot: [0.05, 0, 0] },
                    { time: 0.6, pos: [0, 0, 0], rot: [0.05, 0, 0] }
                ],
                'LegFL': [
                    { time: 0, rot: [0.5, 0, 0] },
                    { time: 0.3, rot: [-0.5, 0, 0] },
                    { time: 0.6, rot: [0.5, 0, 0] }
                ],
                'LegBR': [
                    { time: 0, rot: [0.5, 0, 0] },
                    { time: 0.3, rot: [-0.5, 0, 0] },
                    { time: 0.6, rot: [0.5, 0, 0] }
                ],
                'LegFR': [
                    { time: 0, rot: [-0.5, 0, 0] },
                    { time: 0.3, rot: [0.5, 0, 0] },
                    { time: 0.6, rot: [-0.5, 0, 0] }
                ],
                'LegBL': [
                    { time: 0, rot: [-0.5, 0, 0] },
                    { time: 0.3, rot: [0.5, 0, 0] },
                    { time: 0.6, rot: [-0.5, 0, 0] }
                ],
                'Tail': [
                    { time: 0, rot: [0.1, 0, 0] },
                    { time: 0.3, rot: [-0.1, 0, 0] },
                    { time: 0.6, rot: [0.1, 0, 0] }
                ]
            }
        },
        {
            name: 'Jump',
            duration: 1.0,
            tracks: {
                'Torso': [
                    { time: 0, pos: [0, -0.2, 0], rot: [0.1, 0, 0] },
                    { time: 0.2, pos: [0, 0, 0], rot: [-0.1, 0, 0] },
                    { time: 0.5, pos: [0, 1.5, 0], rot: [-0.2, 0, 0] },
                    { time: 0.8, pos: [0, 0, 0], rot: [0.1, 0, 0] },
                    { time: 1.0, pos: [0, -0.2, 0], rot: [0.1, 0, 0] }
                ],
                'LegFL': [
                    { time: 0, rot: [0.3, 0, 0] },
                    { time: 0.5, rot: [-0.3, 0, 0] },
                    { time: 1.0, rot: [0.3, 0, 0] }
                ],
                'LegFR': [
                    { time: 0, rot: [0.3, 0, 0] },
                    { time: 0.5, rot: [-0.3, 0, 0] },
                    { time: 1.0, rot: [0.3, 0, 0] }
                ],
                'LegBL': [
                    { time: 0, rot: [-0.3, 0, 0] },
                    { time: 0.5, rot: [0.3, 0, 0] },
                    { time: 1.0, rot: [-0.3, 0, 0] }
                ],
                'LegBR': [
                    { time: 0, rot: [-0.3, 0, 0] },
                    { time: 0.5, rot: [0.3, 0, 0] },
                    { time: 1.0, rot: [-0.3, 0, 0] }
                ]
            }
        },
        {
            name: 'Hurt',
            duration: 0.4,
            tracks: {
                'Torso': [
                    { time: 0, pos: [0, 0, 0], rot: [0, 0, 0] },
                    { time: 0.1, pos: [0, 0.2, -0.8], rot: [-0.05, 0, 0] },
                    { time: 0.4, pos: [0, 0, 0], rot: [0, 0, 0] }
                ],
                'LegFL': [
                    { time: 0, rot: [0, 0, 0] },
                    { time: 0.1, rot: [0.3, 0, 0] },
                    { time: 0.2, rot: [-0.3, 0, 0] },
                    { time: 0.3, rot: [0.3, 0, 0] },
                    { time: 0.4, rot: [0, 0, 0] }
                ],
                'LegFR': [
                    { time: 0, rot: [0, 0, 0] },
                    { time: 0.1, rot: [-0.3, 0, 0] },
                    { time: 0.2, rot: [0.3, 0, 0] },
                    { time: 0.3, rot: [-0.3, 0, 0] },
                    { time: 0.4, rot: [0, 0, 0] }
                ],
                'LegBL': [
                    { time: 0, rot: [0, 0, 0] },
                    { time: 0.1, rot: [-0.3, 0, 0] },
                    { time: 0.2, rot: [0.3, 0, 0] },
                    { time: 0.3, rot: [-0.3, 0, 0] },
                    { time: 0.4, rot: [0, 0, 0] }
                ],
                'LegBR': [
                    { time: 0, rot: [0, 0, 0] },
                    { time: 0.1, rot: [0.3, 0, 0] },
                    { time: 0.2, rot: [-0.3, 0, 0] },
                    { time: 0.3, rot: [0.3, 0, 0] },
                    { time: 0.4, rot: [0, 0, 0] }
                ]
            }
        },
        {
            name: 'Attack',
            duration: 0.5,
            tracks: {
                'Torso': [
                    { time: 0, pos: [0, 0, 0], rot: [0, 0, 0] },
                    { time: 0.2, pos: [0, 0.3, 1.2], rot: [0.05, 0, 0] },
                    { time: 0.5, pos: [0, 0, 0], rot: [0, 0, 0] }
                ]
            }
        },
        {
            name: 'Death',
            duration: 1.0,
            tracks: {
                'Torso': [
                    { time: 0, pos: [0, 0, 0], rot: [0, 0, 0] },
                    { time: 0.5, pos: [0, -2, 0], rot: [0, 0, Math.PI / 2] },
                    { time: 1.0, pos: [0, -2, 0], rot: [0, 0, Math.PI / 2] }
                ]
            }
        }
    ]
};

export const BIRD_SKELETON: SkeletonDef = {
    id: 'bird',
    name: 'Bird / Flying',
    bones: [
        { name: 'Torso', parent: null, pivotType: 'center', color: '#3b82f6' },
        { name: 'WingL', parent: 'Torso', pivotType: 'right', color: '#10b981' },
        { name: 'WingR', parent: 'Torso', pivotType: 'left', color: '#8b5cf6' },
    ],
    animations: [
        {
            name: 'Fly',
            duration: 0.6,
            tracks: {
                'Torso': [
                    { time: 0, pos: [0, 0, 0] },
                    { time: 0.3, pos: [0, 2, 0] },
                    { time: 0.6, pos: [0, 0, 0] }
                ],
                'WingL': [
                    { time: 0, rot: [0, 0, -0.5] },
                    { time: 0.3, rot: [0, 0, 1.0] },
                    { time: 0.6, rot: [0, 0, -0.5] }
                ],
                'WingR': [
                    { time: 0, rot: [0, 0, 0.5] },
                    { time: 0.3, rot: [0, 0, -1.0] },
                    { time: 0.6, rot: [0, 0, 0.5] }
                ]
            }
        },
        {
            name: 'Idle',
            duration: 2.0,
            tracks: {
                'Torso': [
                    { time: 0, pos: [0, 0, 0] },
                    { time: 1, pos: [0, 0, 0] },
                    { time: 2, pos: [0, 0, 0] }
                ],
                'WingL': [
                    { time: 0, rot: [0, 0, 0] },
                    { time: 1, rot: [0, 0, 0.1] },
                    { time: 2, rot: [0, 0, 0] }
                ],
                'WingR': [
                    { time: 0, rot: [0, 0, 0] },
                    { time: 1, rot: [0, 0, -0.1] },
                    { time: 2, rot: [0, 0, 0] }
                ]
            }
        },
        {
            name: 'Hurt',
            duration: 0.4,
            tracks: {
                'Torso': [
                    { time: 0, pos: [0, 0, 0], rot: [0, 0, 0] },
                    { time: 0.1, pos: [0, 0.5, -2], rot: [-0.2, 0, 0] },
                    { time: 0.4, pos: [0, 0, 0], rot: [0, 0, 0] }
                ],
                'WingL': [
                    { time: 0, rot: [0, 0, 0] },
                    { time: 0.1, rot: [0, 0, 1.0] },
                    { time: 0.2, rot: [0, 0, -1.0] },
                    { time: 0.3, rot: [0, 0, 1.0] },
                    { time: 0.4, rot: [0, 0, 0] }
                ],
                'WingR': [
                    { time: 0, rot: [0, 0, 0] },
                    { time: 0.1, rot: [0, 0, -1.0] },
                    { time: 0.2, rot: [0, 0, 1.0] },
                    { time: 0.3, rot: [0, 0, -1.0] },
                    { time: 0.4, rot: [0, 0, 0] }
                ]
            }
        },
        {
            name: 'Attack',
            duration: 0.5,
            tracks: {
                'Torso': [
                    { time: 0, pos: [0, 0, 0], rot: [0, 0, 0] },
                    { time: 0.2, pos: [0, -1, 3], rot: [0.3, 0, 0] },
                    { time: 0.5, pos: [0, 0, 0], rot: [0, 0, 0] }
                ]
            }
        },
        {
            name: 'Death',
            duration: 1.0,
            tracks: {
                'Torso': [
                    { time: 0, pos: [0, 0, 0], rot: [0, 0, 0] },
                    { time: 0.5, pos: [0, -4, 0], rot: [-Math.PI / 2, 0, 0] },
                    { time: 1.0, pos: [0, -4, 0], rot: [-Math.PI / 2, 0, 0] }
                ]
            }
        }
    ]
};

export const FISH_SKELETON: SkeletonDef = {
    id: 'fish',
    name: 'Fish / Sea Creature',
    bones: [
        { name: 'Torso', parent: null, pivotType: 'center', color: '#3b82f6' },
        { name: 'Tail', parent: 'Torso', pivotType: 'front', color: '#10b981' },
        { name: 'FinL', parent: 'Torso', pivotType: 'right', color: '#f59e0b' },
        { name: 'FinR', parent: 'Torso', pivotType: 'left', color: '#ec4899' },
    ],
    animations: [
        {
            name: 'Swim',
            duration: 1.0,
            tracks: {
                'Torso': [
                    { time: 0, pos: [0, 0, 0], rot: [0, 0.1, 0] },
                    { time: 0.5, pos: [0, 0, 0], rot: [0, -0.1, 0] },
                    { time: 1.0, pos: [0, 0, 0], rot: [0, 0.1, 0] }
                ],
                'Tail': [
                    { time: 0, rot: [0, 0.5, 0] },
                    { time: 0.5, rot: [0, -0.5, 0] },
                    { time: 1.0, rot: [0, 0.5, 0] }
                ]
            }
        },
        {
            name: 'Death',
            duration: 1.0,
            tracks: {
                'Torso': [
                    { time: 0, pos: [0, 0, 0], rot: [0, 0, 0] },
                    { time: 0.5, pos: [0, 2, 0], rot: [Math.PI, 0, 0] },
                    { time: 1.0, pos: [0, 2, 0], rot: [Math.PI, 0, 0] }
                ]
            }
        }
    ]
};

export const INSECT_SKELETON: SkeletonDef = {
    id: 'insect',
    name: 'Insect / Spider',
    bones: [
        { name: 'Torso', parent: null, pivotType: 'center', color: '#3b82f6' },
        { name: 'Leg1L', parent: 'Torso', pivotType: 'right', color: '#10b981' },
        { name: 'Leg1R', parent: 'Torso', pivotType: 'left', color: '#10b981' },
        { name: 'Leg2L', parent: 'Torso', pivotType: 'right', color: '#f59e0b' },
        { name: 'Leg2R', parent: 'Torso', pivotType: 'left', color: '#f59e0b' },
        { name: 'Leg3L', parent: 'Torso', pivotType: 'right', color: '#ec4899' },
        { name: 'Leg3R', parent: 'Torso', pivotType: 'left', color: '#ec4899' },
    ],
    animations: [
        {
            name: 'Scuttle',
            duration: 0.4,
            tracks: {
                'Leg1L': [{ time: 0, rot: [0, 0.2, 0] }, { time: 0.2, rot: [0, -0.2, 0] }, { time: 0.4, rot: [0, 0.2, 0] }],
                'Leg1R': [{ time: 0, rot: [0, -0.2, 0] }, { time: 0.2, rot: [0, 0.2, 0] }, { time: 0.4, rot: [0, -0.2, 0] }],
                'Leg2L': [{ time: 0, rot: [0, -0.2, 0] }, { time: 0.2, rot: [0, 0.2, 0] }, { time: 0.4, rot: [0, -0.2, 0] }],
                'Leg2R': [{ time: 0, rot: [0, 0.2, 0] }, { time: 0.2, rot: [0, -0.2, 0] }, { time: 0.4, rot: [0, 0.2, 0] }],
                'Leg3L': [{ time: 0, rot: [0, 0.2, 0] }, { time: 0.2, rot: [0, -0.2, 0] }, { time: 0.4, rot: [0, 0.2, 0] }],
                'Leg3R': [{ time: 0, rot: [0, -0.2, 0] }, { time: 0.2, rot: [0, 0.2, 0] }, { time: 0.4, rot: [0, -0.2, 0] }],
            }
        },
        {
            name: 'Death',
            duration: 1.0,
            tracks: {
                'Torso': [
                    { time: 0, pos: [0, 0, 0], rot: [0, 0, 0] },
                    { time: 0.5, pos: [0, -1, 0], rot: [0, 0, Math.PI] },
                    { time: 1.0, pos: [0, -1, 0], rot: [0, 0, Math.PI] }
                ]
            }
        }
    ]
};

export const CUBE_MONSTER_SKELETON: SkeletonDef = {
    id: 'cube_monster',
    name: 'Cube Monster (Slime)',
    bones: [
        { name: 'Base', parent: null, pivotType: 'bottom', color: '#3b82f6' },
        { name: 'Body', parent: 'Base', pivotType: 'bottom', color: '#10b981' },
    ],
    animations: [
        {
            name: 'Idle',
            duration: 2.0,
            tracks: {
                'Body': [
                    { time: 0, pos: [0, 0, 0] },
                    { time: 1, pos: [0, -0.5, 0] },
                    { time: 2, pos: [0, 0, 0] }
                ]
            }
        },
        {
            name: 'Jump',
            duration: 1.0,
            tracks: {
                'Body': [
                    { time: 0, pos: [0, 0, 0] },
                    { time: 0.2, pos: [0, -1.5, 0] },
                    { time: 0.5, pos: [0, 3, 0] },
                    { time: 0.8, pos: [0, 0, 0] },
                    { time: 1.0, pos: [0, 0, 0] }
                ]
            }
        },
        {
            name: 'Death',
            duration: 1.0,
            tracks: {
                'Body': [
                    { time: 0, pos: [0, 0, 0] },
                    { time: 0.5, pos: [0, -2.5, 0] },
                    { time: 1.0, pos: [0, -2.5, 0] }
                ]
            }
        }
    ]
};

export const CUSTOM_SKELETON: SkeletonDef = {
    id: 'custom',
    name: 'Custom Skeleton',
    bones: [
        { name: 'Root', parent: null, pivotType: 'center', color: '#ffffff' },
    ],
    animations: [
        {
            name: 'Death',
            duration: 1.0,
            tracks: {
                'Root': [
                    { time: 0, pos: [0, 0, 0], rot: [0, 0, 0] },
                    { time: 0.5, pos: [0, -2, 0], rot: [-Math.PI / 2, 0, 0] },
                    { time: 1.0, pos: [0, -2, 0], rot: [-Math.PI / 2, 0, 0] }
                ]
            }
        }
    ]
};

export const SKELETONS = [
    HUMANOID_SKELETON, 
    QUADRUPED_SKELETON, 
    BIRD_SKELETON, 
    FISH_SKELETON, 
    INSECT_SKELETON, 
    CUBE_MONSTER_SKELETON,
    CUSTOM_SKELETON
];
