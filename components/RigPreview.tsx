import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Asset } from '../services/projectDocument';
import { createAssetVisual, type AssetVisual } from '../runtime/assetMesh';

function disposeVisual(visual: AssetVisual) {
  visual.group.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) material.dispose();
  });
}

export function RigPreview({ asset }: { asset: Asset }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneRef = useRef<THREE.Scene | undefined>(undefined);
  const cameraRef = useRef<THREE.PerspectiveCamera | undefined>(undefined);
  const controlsRef = useRef<OrbitControls | undefined>(undefined);
  const visualRef = useRef<AssetVisual | undefined>(undefined);
  const previewDiameterRef = useRef<number | undefined>(undefined);
  const clipRef = useRef(asset.rig?.clips[0]?.name ?? '');
  const durationRef = useRef(asset.rig?.clips[0]?.duration ?? 0);
  const loopRef = useRef(asset.rig?.clips[0]?.loop ?? false);
  const playingRef = useRef(false);
  const speedRef = useRef(1);
  const offsetRef = useRef(0);
  const startedAtRef = useRef(0);
  const [clipName, setClipName] = useState(clipRef.current);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [time, setTime] = useState(0);
  const [error, setError] = useState('');
  const clip = asset.rig?.clips.find((entry) => entry.name === clipName);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    } catch {
      setError('A WebGL preview is unavailable in this window.');
      return;
    }
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#171c25');
    const camera = new THREE.PerspectiveCamera(36, 1, 0.01, 100_000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 0.05;
    scene.add(new THREE.HemisphereLight(0xe0ecff, 0x3e4350, 2.2));
    const keyLight = new THREE.DirectionalLight(0xffffff, 3.4);
    keyLight.position.set(4, 7, 5);
    scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight(0x9fc5ff, 1.4);
    fillLight.position.set(-5, 2, -4);
    scene.add(fillLight);
    const grid = new THREE.GridHelper(4, 16, 0x63738b, 0x303846);
    grid.position.y = -0.01;
    scene.add(grid);
    sceneRef.current = scene;
    cameraRef.current = camera;
    controlsRef.current = controls;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor('#171c25');
    renderer.shadowMap.enabled = true;
    keyLight.castShadow = true;

    const resize = () => {
      const width = Math.max(1, canvas.clientWidth);
      const height = Math.max(1, canvas.clientHeight);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    resize();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(resize);
    observer?.observe(canvas);
    if (!observer) window.addEventListener('resize', resize);
    const onContextLost = (event: Event) => {
      event.preventDefault();
      setError('The WebGL preview context was lost. Reload the rig preview to continue.');
    };
    canvas.addEventListener('webglcontextlost', onContextLost);
    let lastUiUpdate = 0;
    let frame = 0;
    const render = (now: number) => {
      frame = requestAnimationFrame(render);
      const duration = durationRef.current;
      let current = offsetRef.current;
      if (playingRef.current) current += (Math.max(0, now - startedAtRef.current) * speedRef.current) / 1000;
      let shownTime = current;
      if (duration > 0) {
        if (loopRef.current && playingRef.current) shownTime = current % duration;
        else if (current >= duration) {
          current = duration;
          shownTime = duration;
          offsetRef.current = duration;
          playingRef.current = false;
          setPlaying(false);
        }
      }
      // A paused scrub to the last key must show that pose, rather than wrapping a looping clip to zero.
      const sampleTime =
        !playingRef.current && loopRef.current && current === duration && duration > 0
          ? Math.max(0, duration - 1e-6)
          : current;
      visualRef.current?.animate(clipRef.current, sampleTime);
      controls.update();
      renderer.render(scene, camera);
      if (now - lastUiUpdate >= 200) {
        if (playingRef.current) {
          offsetRef.current = current;
          startedAtRef.current = now;
        }
        setTime(shownTime);
        lastUiUpdate = now;
      }
    };
    frame = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(frame);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      observer?.disconnect();
      if (!observer) window.removeEventListener('resize', resize);
      controls.dispose();
      renderer.dispose();
      sceneRef.current = undefined;
      cameraRef.current = undefined;
      controlsRef.current = undefined;
    };
  }, []);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    if (visualRef.current) {
      scene.remove(visualRef.current.group);
      disposeVisual(visualRef.current);
      visualRef.current = undefined;
    }
    try {
      const visual = createAssetVisual(asset);
      const bounds =
        (visual.group.userData.assetBounds as THREE.Box3 | undefined)?.clone() ??
        new THREE.Box3().setFromObject(visual.group);
      const size = bounds.isEmpty() ? new THREE.Vector3(1, 1, 1) : bounds.getSize(new THREE.Vector3());
      const center = bounds.isEmpty() ? new THREE.Vector3() : bounds.getCenter(new THREE.Vector3());
      const diameter = Math.max(size.x, size.y, size.z, 0.1);
      scene.add(visual.group);
      visual.group.updateWorldMatrix(true, true);
      visualRef.current = visual;
      const camera = cameraRef.current;
      const controls = controlsRef.current;
      if (camera && controls) {
        const previousDiameter = previewDiameterRef.current;
        if (previousDiameter === undefined) {
          controls.target.copy(center);
          camera.position.set(
            center.x + diameter * 0.3,
            center.y + diameter * 0.2,
            center.z - diameter * 2.3,
          );
        } else {
          const ratio = diameter / previousDiameter;
          const offset = camera.position.clone().sub(controls.target),
            distance = offset.length() * ratio;
          if (offset.lengthSq() === 0) offset.set(0, diameter * 0.2, diameter * 2.3);
          controls.target.copy(center);
          camera.position.copy(center).addScaledVector(offset.normalize(), distance || diameter * 2.3);
        }
        camera.near = Math.max(0.001, diameter / 1000);
        camera.far = Math.max(100, diameter * 100);
        camera.updateProjectionMatrix();
        controls.minDistance = diameter * 0.25;
        controls.maxDistance = diameter * 12;
        controls.update();
      }
      previewDiameterRef.current = diameter;
      const grid = scene.children.find((child) => child.type === 'GridHelper') as
        THREE.GridHelper | undefined;
      if (grid) {
        grid.position.y = bounds.min.y - diameter * 0.03;
        grid.scale.setScalar(diameter / 4);
      }
      setError('');
    } catch (cause) {
      setError(`Preview could not build this asset: ${(cause as Error).message}`);
    }
    return () => {
      if (visualRef.current) {
        scene.remove(visualRef.current.group);
        disposeVisual(visualRef.current);
        visualRef.current = undefined;
      }
    };
  }, [asset]);

  useEffect(() => {
    durationRef.current = clip?.duration ?? 0;
    loopRef.current = clip?.loop ?? false;
  }, [clip?.duration, clip?.loop]);

  useEffect(() => {
    clipRef.current = clipName;
    offsetRef.current = 0;
    startedAtRef.current = performance.now();
    setTime(0);
  }, [asset.id, clipName]);

  useEffect(() => {
    playingRef.current = playing;
    startedAtRef.current = performance.now();
  }, [playing]);
  useEffect(() => {
    speedRef.current = speed;
  }, [speed]);
  useEffect(() => {
    const clip = asset.rig?.clips.find((entry) => entry.name === clipName);
    if (!clip && asset.rig?.clips[0]) setClipName(asset.rig.clips[0].name);
    if (clipName && !clip && !asset.rig?.clips.length) setClipName('');
  }, [asset, clipName]);

  const seek = (value: number) => {
    offsetRef.current = value;
    startedAtRef.current = performance.now();
    setTime(value);
  };
  const setView = (view: string) => {
    const camera = cameraRef.current,
      controls = controlsRef.current,
      diameter = previewDiameterRef.current;
    if (!camera || !controls || !diameter) return;
    const direction = new THREE.Vector3(
      view === 'left' ? -1 : view === 'right' ? 1 : view === 'isometric' ? 0.7 : 0,
      view === 'isometric' ? 0.45 : 0.05,
      view === 'back' ? 1 : view === 'front' || view === 'isometric' ? -1 : 0,
    ).normalize();
    camera.position.copy(controls.target).addScaledVector(direction, diameter * 2.3);
    controls.update();
  };
  return (
    <section className="studio-rig-preview" aria-label="Live rig preview">
      <div className="studio-rig-preview-heading">
        <strong>Live pose preview</strong>
        <small>Drag to orbit · wheel to zoom</small>
      </div>
      <canvas ref={canvasRef} aria-label="Interactive animated asset preview" />
      {error && (
        <small className="studio-rig-preview-error" role="status">
          {error}
        </small>
      )}
      <div className="studio-rig-preview-controls">
        <label className="studio-field">
          View
          <select
            aria-label="Preview camera view"
            defaultValue="front"
            onChange={(event) => setView(event.target.value)}
          >
            <option value="front">Front</option>
            <option value="left">Left</option>
            <option value="right">Right</option>
            <option value="back">Back</option>
            <option value="isometric">Isometric</option>
          </select>
        </label>
        <label className="studio-field">
          Preview clip
          <select
            aria-label="Preview animation clip"
            value={clipName}
            disabled={!asset.rig?.clips.length}
            onChange={(event) => {
              playingRef.current = false;
              setPlaying(false);
              setClipName(event.target.value);
            }}
          >
            {(asset.rig?.clips ?? []).map((entry) => (
              <option key={entry.name} value={entry.name}>
                {entry.name}
              </option>
            ))}
          </select>
        </label>
        <label className="studio-field">
          Playback speed
          <select
            aria-label="Preview playback speed"
            value={speed}
            onChange={(event) => setSpeed(Number(event.target.value))}
          >
            <option value={0.25}>0.25×</option>
            <option value={0.5}>0.5×</option>
            <option value={1}>1×</option>
            <option value={1.5}>1.5×</option>
            <option value={2}>2×</option>
          </select>
        </label>
        <button
          type="button"
          disabled={!clip}
          onClick={() => {
            if (time >= (clip?.duration ?? 0)) seek(0);
            else if (playingRef.current) {
              const now = performance.now();
              let current = offsetRef.current + ((now - startedAtRef.current) * speedRef.current) / 1000;
              if (!loopRef.current) current = Math.min(current, durationRef.current);
              else if (durationRef.current > 0) current %= durationRef.current;
              seek(current);
            }
            setPlaying((value) => !value);
          }}
        >
          {playing ? 'Pause preview' : 'Play preview'}
        </button>
        <label className="studio-rig-preview-scrub">
          <span>Time</span>
          <input
            aria-label="Preview animation time"
            type="range"
            min={0}
            max={clip?.duration ?? 1}
            step={0.01}
            value={Math.min(time, clip?.duration ?? 0)}
            disabled={!clip}
            onChange={(event) => seek(Number(event.target.value))}
          />
          <output>{time.toFixed(2)} s</output>
        </label>
      </div>
    </section>
  );
}
