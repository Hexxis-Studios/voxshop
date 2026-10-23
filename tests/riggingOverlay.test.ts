import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RiggingOverlay } from '../components/RiggingOverlay';
import { SKELETONS } from '../utils/riggingConstants';

test('manual rig painting exposes a bounded, labeled joint-influence control', () => {
  const markup = renderToStaticMarkup(
    React.createElement(RiggingOverlay, {
      initialSkeleton: SKELETONS[0],
      hasRigData: true,
      selectedVoxel: {
        x: 2,
        y: 3,
        z: 4,
        color: 0,
        bone: 'Root',
        weights: [
          { bone: 'Root', weight: 0.6 },
          { bone: 'Hand', weight: 0.4 },
        ],
      },
      onClose() {},
      onEnablePaint() {},
      onDisablePaint() {},
      onSetSelectedWeight() {},
      onAutoRig() {},
      onBuildRig() {},
      onPlayAnimation() {},
      onStopAnimation() {},
      onExplodeRig() {},
    }),
  );
  assert.match(markup, /aria-label="Painted joint influence"/);
  assert.match(markup, /type="range" min="1" max="100" step="1" value="100"/);
  assert.match(markup, /Remaining weight is shared across the voxel’s current joint influences\./);
  assert.match(markup, /Selected voxel weights/);
  assert.match(markup, /aria-label="Apply influence to selected voxel"/);
  assert.match(markup, /disabled=""[^>]*>Apply to selected voxel/);
  assert.match(markup, /\(2, 3, 4\)/);
  assert.match(markup, /Root[\s\S]*60\.0%[\s\S]*Hand[\s\S]*40\.0%/);
});
