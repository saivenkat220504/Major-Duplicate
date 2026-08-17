import React, { useRef, useState, useEffect, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Map, NavigationControl, LngLatBounds, Marker, Popup } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  ArrowLeft, Maximize2, Minimize2, Navigation as NavIcon,
  Search, Layers, X, MapPin, Info, ArrowUp, ArrowRight,
  ArrowUpRight, ArrowUpLeft, CheckCircle2, CornerUpLeft,
  CornerUpRight, Undo2, ShieldCheck, Luggage
} from 'lucide-react';
import { computeAStar, nearestNode, NavGraph } from '../utils/astar';
import { convertRouteToSteps, NavigationStep, GraphNode } from '../utils/route_to_steps';
import { calculateBearing } from '../utils/bearing';
import { CHECKPOINT_REGIONS, CHECKPOINT_DEFINITIONS, CheckpointDef } from '../data/mapData';

/* ─── Path P1 Definition ─────────────────────────────────────────────────── */
const PATH_P1 = {
  id: 'P1',
  startQuery: 'entrance 10',
  destQuery: 'gate a9',
  checkpoints: CHECKPOINT_DEFINITIONS,
};

/** Detect if a route qualifies as Path P1 */
function isPathP1(fromQuery: string, toQuery: string): boolean {
  const f = fromQuery.toLowerCase().trim();
  const t = toQuery.toLowerCase().trim();
  return (
    (f.includes('entrance 10') || f.includes('entrance10')) &&
    (t.includes('gate a9') || t.includes('a9'))
  );
}

/**
 * Inject checkpoint steps into the route steps for Path P1.
 * Guarantees:
 *  - Security North inserted after step index ~25% of route
 *  - At least 2 walking steps between Security North and Luggage Check
 *  - Luggage Check inserted around 55% of route
 *  - At least 2 walking steps between Luggage Check and Gate A9
 */
function injectCheckpointSteps(
  steps: NavigationStep[],
  checkpoints: CheckpointDef[]
): NavigationStep[] {
  if (!steps.length || !checkpoints.length) return steps;

  // Filter out the arrive step temporarily
  const arriveStep = steps.find(s => s.action === 'arrive');
  const walkSteps  = steps.filter(s => s.action !== 'arrive');

  const total = walkSteps.length;
  if (total < 6) {
    // Not enough steps — insert after step 1 and 3 minimally
    const result = [...walkSteps];
    const secCP = checkpoints.find(c => c.type === 'security');
    const lugCP = checkpoints.find(c => c.type === 'luggage');

    if (secCP) {
      result.splice(1, 0, makeCheckpointStep(secCP, result[0]));
    }
    if (lugCP) {
      const insertAt = Math.min(4, result.length - 1);
      result.splice(insertAt, 0, makeCheckpointStep(lugCP, result[insertAt - 1]));
    }
    return arriveStep ? [...result, arriveStep] : result;
  }

  // Normal case: plenty of walk steps
  // Security North: after ~20-25% of walk steps (min index 1)
  const secInsertAfter = Math.max(1, Math.floor(total * 0.22));
  // Luggage Check: at least 2 steps after Security North, around 55%
  const lugInsertAfter = Math.max(secInsertAfter + 3, Math.floor(total * 0.55));
  // Arrive: at least 2 walk steps remain after luggage check
  const lugMaxInsert = total - 3;

  const result: NavigationStep[] = [];
  let secInjected = false;
  let lugInjected = false;

  walkSteps.forEach((step, i) => {
    result.push(step);

    // Inject Security North after secInsertAfter index
    if (!secInjected && i >= secInsertAfter) {
      const secCP = checkpoints.find(c => c.type === 'security');
      if (secCP) {
        result.push(makeCheckpointStep(secCP, step));
        secInjected = true;
      }
    }

    // Inject Luggage Check — at least 2 regular steps after security checkpoint step
    const secIdx = result.findIndex(s => s.checkpoint?.type === 'security');
    const regularStepsSinceSec = secIdx >= 0
      ? result.slice(secIdx + 1).filter(s => !s.checkpoint).length
      : 0;

    if (
      !lugInjected && secInjected &&
      regularStepsSinceSec >= 2 &&
      i >= Math.min(lugInsertAfter, lugMaxInsert)
    ) {
      const lugCP = checkpoints.find(c => c.type === 'luggage');
      if (lugCP) {
        result.push(makeCheckpointStep(lugCP, step));
        lugInjected = true;
      }
    }
  });

  if (arriveStep) result.push(arriveStep);
  return result;
}

function makeCheckpointStep(cp: CheckpointDef, anchorStep: NavigationStep): NavigationStep {
  return {
    id: `checkpoint-${cp.id}`,
    action: 'arrive' as any,
    instruction: `${cp.type === 'security' ? 'Pass through' : 'Proceed through'} ${cp.name}`,
    distanceMeters: 0,
    startNodeIdx: anchorStep.endNodeIdx,
    endNodeIdx: anchorStep.endNodeIdx,
    level: anchorStep.level,
    coordinates: anchorStep.coordinates.slice(-1),
    checkpoint: {
      id: cp.id,
      name: cp.name,
      type: cp.type,
      color: cp.color,
    },
  };
}


/* ─── Constants ─────────────────────────────────────────────────────────── */
const CENTER: [number, number] = [-0.4614, 51.4775];
const ZOOM_INIT = 14;

const LAYER_DEFS = [
  { id: 'terminals', path: '/map-data/terminals.geojson',             color: '#2979ff', minzoom: 8,  label: 'Terminals' },
  { id: 'roads',     path: '/map-data/roads.geojson',                 color: '#e53935', minzoom: 10, label: 'Roads' },
  { id: 'walkways',  path: '/map-data/walkways.geojson',              color: '#ffd740', minzoom: 12, label: 'Walkways' },
  { id: 'indoor',    path: '/map-data/indoors/merged_indoor.geojson', color: '#00e5ff', minzoom: 14, label: 'Indoor' },
  { id: 'security',  path: '/map-data/indoors/security.geojson',      color: '#ff5252', minzoom: 13, label: 'Security' },
  { id: 'lounges',   path: '/map-data/indoors/lounges.geojson',       color: '#ffea00', minzoom: 13, label: 'Lounges' },
  { id: 'amenities', path: '/map-data/amenities.geojson',             color: '#00e676', minzoom: 13, label: 'Amenities' },
  { id: 'entrances', path: '/map-data/entrances.geojson',             color: '#ff6d00', minzoom: 14, label: 'Entrances' },
  { id: 'gates',     path: '/map-data/gates.geojson',                 color: '#aa00ff', minzoom: 13, label: 'Gates' },
];

const INDOOR_CAT_COLORS = [
  'gate', '#aa00ff', 'security', '#ff5252', 'lounge', '#ffea00',
  'food', '#00e676', 'shop', '#ff9100', 'toilet', '#64b5f6',
  'elevator', '#ffd740', 'corridor', '#1a3060', 'area', '#131f3a',
];

const CAT_ICONS: Record<string, string> = {
  gate: '🚪', security: '🛡️', lounge: '🛋️', food: '🍽️',
  shop: '🛍️', toilet: '🚻', elevator: '🛗', escalator: '⬆️',
  atm: '🏧', information: 'ℹ️', baggage_claim: '🧳', check_in: '✅',
  concourse: '🛣️', corridor: '🚶', room: '🚪', area: '📍',
};

/* ─── Direction icon ─────────────────────────────────────────────────────── */
function ActionIcon({ action, size = 20 }: { action: string; size?: number }) {
  switch (action) {
    case 'straight':    return <ArrowUp size={size} />;
    case 'slight right': return <ArrowUpRight size={size} />;
    case 'right':       return <CornerUpRight size={size} />;
    case 'sharp right': return <ArrowRight size={size} />;
    case 'slight left': return <ArrowUpLeft size={size} />;
    case 'left':        return <CornerUpLeft size={size} />;
    case 'sharp left':  return <ArrowLeft size={size} />;
    case 'u-turn':      return <Undo2 size={size} />;
    case 'arrive':      return <MapPin size={size} color="#00e676" />;
    default:            return <ArrowUp size={size} />;
  }
}

/* ─── Types ─────────────────────────────────────────────────────────────── */
interface TooltipData {
  x: number; y: number;
  title: string; category?: string; terminal?: string;
  ref?: string; level?: string; operator?: string; hours?: string;
}

/* ─── Helpers ────────────────────────────────────────────────────────────── */
function featureCentroid(f: any): [number, number] | null {
  const g = f.geometry;
  if (!g) return null;
  if (g.type === 'Point') return [g.coordinates[0], g.coordinates[1]];
  if (g.type === 'LineString' && g.coordinates?.length) {
    const m = g.coordinates[Math.floor(g.coordinates.length / 2)];
    return [m[0], m[1]];
  }
  if ((g.type === 'Polygon' || g.type === 'MultiPolygon') && g.coordinates?.[0]?.length) {
    // Average the ring
    const ring: number[][] = g.type === 'Polygon' ? g.coordinates[0] : g.coordinates[0][0];
    const lng = ring.reduce((s: number, c: number[]) => s + c[0], 0) / ring.length;
    const lat = ring.reduce((s: number, c: number[]) => s + c[1], 0) / ring.length;
    return [lng, lat];
  }
  return null;
}

/* ═══════════════════════════════════════════════════════════════════════════
   HeathrowMapPage
═══════════════════════════════════════════════════════════════════════════ */
export default function HeathrowMapPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef       = useRef<Map | null>(null);
  const navGraphRef  = useRef<NavGraph | null>(null);
  const allFeaturesRef = useRef<any[]>([]);

  /* ── Loading ── */
  const [loading, setLoading]   = useState(true);
  const [loadMsg, setLoadMsg]   = useState('Connecting to basemap…');
  const [fullscreen, setFullscreen] = useState(false);

  /* ── Tooltip ── */
  const [tooltip, setTooltip] = useState<TooltipData | null>(null);
  const [tooltipVisible, setTooltipVisible] = useState(false);
  const tooltipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);


  /* ── Checkpoint hover tooltip ── */
  const checkpointPopupRef = useRef<Popup | null>(null);

  /* ── Route planner ── */
  const [fromQuery, setFromQuery]       = useState('');
  const [toQuery, setToQuery]           = useState('');
  const [showFromRecs, setShowFromRecs] = useState(false);
  const [showToRecs, setShowToRecs]     = useState(false);

  /* ── Navigation state ── */
  const [navMode, setNavMode]       = useState(false);
  const [steps, setSteps]           = useState<NavigationStep[]>([]);
  const [activeStep, setActiveStep] = useState(0);
  const [dist, setDist]             = useState(0);
  const [eta, setEta]               = useState(0);
  const [routeError, setRouteError] = useState('');

  /* ── Refs for imperative nav ── */
  const userMarkerRef = useRef<Marker | null>(null);
  const stepsRef      = useRef<NavigationStep[]>([]);
  const activeStepRef = useRef(0);

  /* ── Route Planner Markers ── */
  const sourceMarkerRef = useRef<Marker | null>(null);
  const destMarkerRef = useRef<Marker | null>(null);

  /* ── Mentor navigation notification state & duplicate protection ── */
  const notifiedCheckpointsRef = useRef<Set<string>>(new Set());
  const [notificationStatus, setNotificationStatus] = useState<string | null>(null);

  /* ─── Search Recommender Helpers (2-way Case-Insensitive) ──────────── */
  const getAllLocations = useCallback((): string[] => {
    const set = new Set<string>();
    const defaults = [
      'Terminal T1', 'Terminal T2', 'Terminal T3', 'Terminal T4', 'Terminal T5', 'Terminal T6',
      'BA Galleries Club Lounge', 'Galleries First Lounge', 'Concorde Room',
      'Main Entrance 01', 'Main Entrance 02', 'Entrance 86', 'Entrance 01', 'Entrance 02',
      'Gate A1', 'Gate A6', 'Gate A10', 'Gate A12', 'Gate B36', 'Gate C54',
      'Security Checkpoint 1', 'Security Checkpoint 2', 'Passport Control',
      'Baggage Claim Hall', 'Duty Free Shop', 'Starbucks Coffee', 'Costa Coffee'
    ];
    defaults.forEach(d => set.add(d));

    if (allFeaturesRef.current) {
      allFeaturesRef.current.forEach(f => {
        const p = f.properties || {};
        const lbl = p._label || p.name || p.ref;
        if (lbl && typeof lbl === 'string' && lbl.trim().length > 1) {
          set.add(lbl.trim());
        }
      });
    }
    return Array.from(set);
  }, []);

  const getRecommendations = (query: string): string[] => {
    if (!query || !query.trim()) return [];
    const qLower = query.toLowerCase().trim();
    const locs = getAllLocations();

    // 2-way lowercase comparison
    const matched = locs.filter(loc => {
      const locLower = loc.toLowerCase();
      return locLower.includes(qLower) || qLower.includes(locLower);
    });

    matched.sort((a, b) => {
      const aLower = a.toLowerCase();
      const bLower = b.toLowerCase();
      const aStart = aLower.startsWith(qLower);
      const bStart = bLower.startsWith(qLower);
      if (aStart && !bStart) return -1;
      if (!aStart && bStart) return 1;
      return a.localeCompare(b);
    });

    return matched.slice(0, 8);
  };

  /* ─── Tooltip helpers ─────────────────────────────────────────────── */
  const showTooltip = useCallback((data: TooltipData) => {
    if (tooltipTimer.current) clearTimeout(tooltipTimer.current);
    setTooltipVisible(false);
    setTimeout(() => { setTooltip(data); setTooltipVisible(true); }, 30);
  }, []);

  const hideTooltip = useCallback(() => {
    setTooltipVisible(false);
    tooltipTimer.current = setTimeout(() => setTooltip(null), 300);
  }, []);

  /* ─── Fullscreen ─────────────────────────────────────────────────── */
  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.();
      setFullscreen(true);
    } else {
      document.exitFullscreen?.();
      setFullscreen(false);
    }
  };

  /* ─── Map initialisation ──────────────────────────────────────────── */
  useEffect(() => {
    if (!mapContainer.current || mapRef.current) return;

    const map = new Map({
      container: mapContainer.current,
      style: 'https://tiles.openfreemap.org/styles/dark',
      center: CENTER,
      zoom: ZOOM_INIT,
      pitch: 0,
      bearing: 0,
      antialias: true,
    });
    mapRef.current = map;
    map.addControl(new NavigationControl(), 'bottom-right');
    map.on('error', (e) => console.warn('[MapLibre]', e.error?.message));
    map.on('dragstart', hideTooltip);
    map.on('click', (e) => {
      const layers = LAYER_DEFS.flatMap(d => [`${d.id}-circle`, `${d.id}-fill`, `${d.id}-line`])
        .filter(l => { try { return !!map.getLayer(l); } catch { return false; } });
      const hits = map.queryRenderedFeatures(e.point, { layers });
      if (!hits.length) hideTooltip();
    });

    map.on('load', async () => {
      /* Load navigation graph */
      setLoadMsg('Loading navigation graph…');
      try {
        const r = await fetch('/map-data/navigation_graph.json');
        if (r.ok) navGraphRef.current = await r.json();
      } catch (e) { console.warn('Nav graph failed', e); }

      const allFeats: any[] = [];

      for (const def of LAYER_DEFS) {
        setLoadMsg(`Loading ${def.label}…`);
        try {
          const r = await fetch(def.path);
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const data = await r.json();
          const feats: any[] = data.features || [];
          allFeats.push(...feats.map(f => ({ ...f, _sourceId: def.id })));

          if (!map.getSource(def.id)) {
            map.addSource(def.id, { type: 'geojson', data, generateId: true });
          }

          const hasPolygon = feats.some(f => ['Polygon', 'MultiPolygon'].includes(f.geometry?.type));
          const hasLine    = feats.some(f => ['LineString', 'MultiLineString'].includes(f.geometry?.type));
          const hasPoint   = feats.some(f => f.geometry?.type === 'Point');

          /* Polygon fill */
          if (hasPolygon) {
            const fillColor: any = def.id === 'indoor'
              ? ['match', ['get', '_category'], ...INDOOR_CAT_COLORS, '#131f3a']
              : def.color;
            map.addLayer({
              id: `${def.id}-fill`, type: 'fill', source: def.id, minzoom: def.minzoom,
              filter: ['in', ['geometry-type'], ['literal', ['Polygon', 'MultiPolygon']]],
              paint: {
                'fill-color': fillColor,
                'fill-opacity': ['interpolate', ['linear'], ['zoom'],
                  def.minzoom, 0, def.minzoom + 1,
                  def.id === 'terminals' ? 0.12 : def.id === 'indoor' ? 0.4 : 0.18],
              },
            });
          }

          /* Line stroke */
          if (hasPolygon || hasLine) {
            map.addLayer({
              id: `${def.id}-line`, type: 'line', source: def.id, minzoom: def.minzoom,
              paint: {
                'line-color': def.color,
                'line-width': ['interpolate', ['linear'], ['zoom'], def.minzoom, 0.5, 18, def.id === 'terminals' ? 3 : 2],
                'line-opacity': ['interpolate', ['linear'], ['zoom'], def.minzoom, 0, def.minzoom + 0.5, 0.9],
              },
            });
          }

          /* Point circles */
          if (hasPoint) {
            map.addLayer({
              id: `${def.id}-circle`, type: 'circle', source: def.id, minzoom: def.minzoom,
              filter: ['==', ['geometry-type'], 'Point'],
              paint: {
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 4, 16, 8, 19, 12],
                'circle-color': def.color,
                'circle-stroke-color': '#fff',
                'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 13, 1, 17, 2],
                'circle-opacity': ['interpolate', ['linear'], ['zoom'], def.minzoom, 0, def.minzoom + 0.5, 1],
              },
            });
          }

          /* ── Labels ── */
          if (def.id === 'gates') {
            map.addLayer({
              id: 'gates-label', type: 'symbol', source: 'gates', minzoom: 13,
              layout: {
                'text-field': ['coalesce', ['get', '_label'], ['get', 'ref'], ['get', 'name'], 'Gate'],
                'text-size': ['interpolate', ['linear'], ['zoom'], 13, 8, 17, 13],
                'text-offset': [0, 1.2], 'text-anchor': 'top', 'text-allow-overlap': false,
              },
              paint: {
                'text-color': '#fff', 'text-halo-color': '#6200ea', 'text-halo-width': 1.5,
                'text-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0, 13.5, 1],
              },
            });
          }
          if (def.id === 'terminals') {
            map.addLayer({
              id: 'terminals-label', type: 'symbol', source: 'terminals', minzoom: 12,
              layout: {
                'text-field': ['coalesce', ['get', '_label'], ['get', 'name'], ['get', 'loc_name'], 'Terminal'],
                'text-size': ['interpolate', ['linear'], ['zoom'], 12, 11, 16, 16],
                'text-anchor': 'center', 'text-allow-overlap': false,
              },
              paint: {
                'text-color': '#64b0ff', 'text-halo-color': '#050a15', 'text-halo-width': 2.5,
                'text-opacity': ['interpolate', ['linear'], ['zoom'], 12, 0, 13, 1],
              },
            });
          }
          if (def.id === 'amenities' || def.id === 'indoor' || def.id === 'entrances') {
            map.addLayer({
              id: `${def.id}-label`, type: 'symbol', source: def.id, minzoom: 15,
              layout: {
                'text-field': ['coalesce', ['get', '_label'], ['get', 'name'], ['get', 'ref'], 'Feature'],
                'text-size': ['interpolate', ['linear'], ['zoom'], 15, 9, 19, 13],
                'text-anchor': 'center', 'text-allow-overlap': false, 'text-max-width': 8,
              },
              paint: {
                'text-color': '#dce8ff', 'text-halo-color': '#050a15', 'text-halo-width': 1.5,
                'text-opacity': ['interpolate', ['linear'], ['zoom'], 15, 0, 15.8, 1],
              },
            });
          }
          if (def.id === 'security') {
            map.addLayer({
              id: 'security-label', type: 'symbol', source: 'security', minzoom: 14,
              layout: {
                'text-field': ['coalesce', ['get', '_label'], ['get', 'name'], 'Security'],
                'text-size': 11, 'text-anchor': 'center', 'text-allow-overlap': false,
              },
              paint: {
                'text-color': '#ff8a80', 'text-halo-color': '#050a15', 'text-halo-width': 1.5,
                'text-opacity': ['interpolate', ['linear'], ['zoom'], 14, 0, 14.5, 1],
              },
            });
          }
          if (def.id === 'lounges') {
            map.addLayer({
              id: 'lounges-label', type: 'symbol', source: 'lounges', minzoom: 14,
              layout: {
                'text-field': ['coalesce', ['get', '_label'], ['get', 'name'], 'Lounge'],
                'text-size': 11, 'text-anchor': 'center', 'text-allow-overlap': false,
              },
              paint: {
                'text-color': '#ffe082', 'text-halo-color': '#050a15', 'text-halo-width': 1.5,
                'text-opacity': ['interpolate', ['linear'], ['zoom'], 14, 0, 14.5, 1],
              },
            });
          }

          /* Click handlers */
          const clickLayers = [`${def.id}-circle`, `${def.id}-fill`]
            .filter(l => { try { return !!map.getLayer(l); } catch { return false; } });

          clickLayers.forEach(layerId => {
            map.on('click', layerId, (e) => {
              e.originalEvent.stopPropagation();
              const f = e.features?.[0];
              if (!f) return;
              const p = f.properties || {};
              const title = p._label || p.name || p.ref || p._category || p.aeroway || p.amenity || p.highway || 'Feature';
              const pt = map.project(e.lngLat);
              showTooltip({
                x: pt.x, y: pt.y, title,
                category: p._category || p.aeroway || p.amenity || p.highway || '',
                terminal: p.terminal || '',
                ref: p.ref || '',
                level: p.level ?? p._level ?? '',
                operator: p.operator || '',
                hours: p.opening_hours || '',
              });
            });
            map.on('mouseenter', layerId, () => { map.getCanvas().style.cursor = 'pointer'; });
            map.on('mouseleave', layerId, () => { map.getCanvas().style.cursor = ''; });
          });

        } catch (e) { console.warn(`[${def.id} failed]`, e); }
      }

      allFeaturesRef.current = allFeats;

      /* ── Add Checkpoint Regions (Security North & Luggage Check) ── */
      try {
        if (!map.getSource('checkpoint-regions')) {
          map.addSource('checkpoint-regions', {
            type: 'geojson',
            data: CHECKPOINT_REGIONS as any,
          });
        }

        /* Fill layer */
        if (!map.getLayer('checkpoint-fill')) {
          map.addLayer({
            id: 'checkpoint-fill',
            type: 'fill',
            source: 'checkpoint-regions',
            paint: {
              'fill-color': ['get', 'fillColor'],
              'fill-opacity': 0.35,
            },
          });
        }

        /* Outline layer */
        if (!map.getLayer('checkpoint-outline')) {
          map.addLayer({
            id: 'checkpoint-outline',
            type: 'line',
            source: 'checkpoint-regions',
            paint: {
              'line-color': ['get', 'strokeColor'],
              'line-width': 2.5,
              'line-opacity': 0.85,
            },
          });
        }

        /* Label layer */
        if (!map.getLayer('checkpoint-label')) {
          map.addLayer({
            id: 'checkpoint-label',
            type: 'symbol',
            source: 'checkpoint-regions',
            layout: {
              'text-field': ['get', '_label'],
              'text-size': 12,
              'text-anchor': 'center',
              'text-allow-overlap': true,
              'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
            },
            paint: {
              'text-color': '#ffffff',
              'text-halo-color': '#000000',
              'text-halo-width': 2,
            },
          });
        }

        /* Hover interaction using MapLibre Popup */
        map.on('mouseenter', 'checkpoint-fill', (e) => {
          map.getCanvas().style.cursor = 'pointer';
          const feature = e.features?.[0];
          if (!feature) return;
          const name = (feature.properties as any)?._label || (feature.properties as any)?.name || 'Checkpoint';
          const type = (feature.properties as any)?.type || 'security';
          const bgColor = type === 'security' ? '#7f1d1d' : '#713f12';
          const borderColor = type === 'security' ? '#ff3344' : '#ffea00';
          const icon = type === 'security' ? '🛡️' : '🧳';

          checkpointPopupRef.current?.remove();
          checkpointPopupRef.current = new Popup({
            closeButton: false,
            closeOnClick: false,
            className: 'checkpoint-popup',
            offset: 8,
          })
            .setLngLat(e.lngLat)
            .setHTML(`
              <div style="
                background:${bgColor};
                border:1.5px solid ${borderColor};
                border-radius:10px;
                padding:6px 12px;
                color:#fff;
                font-size:12px;
                font-weight:700;
                font-family:Inter,system-ui,sans-serif;
                display:flex;
                align-items:center;
                gap:6px;
                box-shadow:0 4px 20px rgba(0,0,0,0.6);
              ">
                <span>${icon}</span>
                <span>${name}</span>
              </div>
            `)
            .addTo(map);
        });

        map.on('mouseleave', 'checkpoint-fill', () => {
          map.getCanvas().style.cursor = '';
          checkpointPopupRef.current?.remove();
          checkpointPopupRef.current = null;
        });

        map.on('mousemove', 'checkpoint-fill', (e) => {
          checkpointPopupRef.current?.setLngLat(e.lngLat);
        });

      } catch (cpErr) { console.warn('[Checkpoint regions failed]', cpErr); }

      setLoadMsg('Ready');
      setLoading(false);
    });

    return () => {
      if (tooltipTimer.current) clearTimeout(tooltipTimer.current);
      userMarkerRef.current?.remove();
      checkpointPopupRef.current?.remove();
      sourceMarkerRef.current?.remove();
      destMarkerRef.current?.remove();
      map.remove();
      mapRef.current = null;
    };
  }, [showTooltip, hideTooltip]);

  /* ─── Route Finding with 2-way Case-Insensitive Matching ───────────── */
  const findFeatureByQuery = (q: string): { coords: [number, number]; level: number } | null => {
    if (!q || !q.trim()) return null;
    const qClean = q.toLowerCase().trim();

    // 1. Exact case-insensitive match
    let feat = allFeaturesRef.current.find(f => {
      const p = f.properties || {};
      const lbl = (p._label || p.name || p.ref || '').toLowerCase().trim();
      return lbl === qClean;
    });

    // 2. 2-way case-insensitive comparison
    if (!feat) {
      feat = allFeaturesRef.current.find(f => {
        const p = f.properties || {};
        const hay = [p._label, p.name, p.ref, p._category, p.aeroway, p.amenity, p.highway]
          .filter(Boolean).join(' ').toLowerCase();
        return hay.includes(qClean) || qClean.includes(hay);
      });
    }

    // 3. Token match
    if (!feat) {
      const tokens = qClean.split(/\s+/);
      feat = allFeaturesRef.current.find(f => {
        const p = f.properties || {};
        const hay = [p._label, p.name, p.ref, p._category, p.aeroway, p.amenity, p.highway]
          .filter(Boolean).join(' ').toLowerCase();
        return tokens.every(tok => hay.includes(tok));
      });
    }

    if (!feat) return null;
    const coords = featureCentroid(feat);
    if (!coords) return null;
    const p = feat.properties || {};
    const level = Number(p.level ?? p._level ?? 0);
    return { coords, level };
  };

  const handleRoute = useCallback(() => {
    const graph = navGraphRef.current;
    const map = mapRef.current;
    setRouteError('');
    if (!graph || !map) { setRouteError('Navigation graph not ready yet.'); return; }
    if (!fromQuery.trim() || !toQuery.trim()) { setRouteError('Please enter both From and To locations.'); return; }

    const fromLoc = findFeatureByQuery(fromQuery);
    const toLoc   = findFeatureByQuery(toQuery);

    if (!fromLoc) { setRouteError(`Location not found: "${fromQuery}". Try a gate like "Gate A10" or "T5 Entrance"`); return; }
    if (!toLoc)   { setRouteError(`Location not found: "${toQuery}". Try a gate, lounge, or terminal name.`); return; }

    const startNode = nearestNode(fromLoc.coords[0], fromLoc.coords[1], graph.nodes, fromLoc.level);
    const goalNode  = nearestNode(toLoc.coords[0], toLoc.coords[1], graph.nodes, toLoc.level);

    if (!startNode) { setRouteError('No navigation nodes near start location.'); return; }
    if (!goalNode)  { setRouteError('No navigation nodes near destination.'); return; }
    if (startNode === goalNode) { setRouteError('Start and destination are the same point.'); return; }

    const path = computeAStar(graph, startNode, goalNode);
    if (!path || path.length < 2) {
      setRouteError(`No route found between "${fromQuery}" and "${toQuery}". They may be in disconnected areas.`);
      return;
    }

    const pathNodes = path.map(k => graph.nodes[k]);
    let genSteps = convertRouteToSteps(pathNodes);

    /* ── Path P1: inject Security North & Luggage Check checkpoints ── */
    if (isPathP1(fromQuery, toQuery)) {
      genSteps = injectCheckpointSteps(genSteps, PATH_P1.checkpoints);

      /* Dynamically update checkpoint polygon positions to match the actual route */
      try {
        const cpSteps = genSteps.filter(s => s.checkpoint);
        if (cpSteps.length > 0) {
          const dynamicFeatures = cpSteps.map(step => {
            const cp = step.checkpoint!;
            // Use the last coordinate of the anchor step (where the user is at that point)
            const coord = step.coordinates[step.coordinates.length - 1] ||
                          step.coordinates[0];
            const lng = coord[0];
            const lat = coord[1];
            // Create a box ~25m wide centred on the route node
            const d = 0.00022;
            return {
              type: 'Feature' as const,
              id: cp.id,
              properties: {
                id: cp.id,
                name: cp.name,
                _label: cp.name,
                type: cp.type,
                color: cp.color,
                fillColor: cp.color,
                strokeColor: cp.color,
              },
              geometry: {
                type: 'Polygon' as const,
                coordinates: [[
                  [lng - d, lat - d],
                  [lng + d, lat - d],
                  [lng + d, lat + d],
                  [lng - d, lat + d],
                  [lng - d, lat - d],
                ]],
              },
            };
          });

          const src = map.getSource('checkpoint-regions') as any;
          if (src?.setData) {
            src.setData({ type: 'FeatureCollection', features: dynamicFeatures });
          }
        }
      } catch (cpErr) { console.warn('[Checkpoint dynamic update failed]', cpErr); }
    }

    const totalD = genSteps.reduce((s, st) => s + st.distanceMeters, 0);

    setSteps(genSteps);
    stepsRef.current = genSteps;
    setDist(totalD);
    setEta(Math.round(totalD / 1.4));
    setActiveStep(0);
    activeStepRef.current = 0;
    setRouteError('');

    /* Draw route line */
    const coords = pathNodes.map(n => [n.lon, n.lat]);
    if (map.getLayer('route-line')) map.removeLayer('route-line');
    if (map.getSource('route-line')) map.removeSource('route-line');
    map.addSource('route-line', {
      type: 'geojson',
      data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } as any },
    });
    map.addLayer({
      id: 'route-line', type: 'line', source: 'route-line',
      paint: {
        'line-color': '#4a148c',
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, 6, 18, 10],
        'line-opacity': 0.95,
        'line-blur': 0.5,
      },
    });

    /* Fit map to route */
    const bounds = coords.reduce(
      (b, c) => b.extend(c as [number, number]),
      new LngLatBounds(coords[0] as [number, number], coords[0] as [number, number])
    );
    map.fitBounds(bounds, { padding: 80, duration: 900, maxZoom: 18 });
  }, [fromQuery, toQuery]);

  /* ─── Auto-route trigger on load / route params ────────────────────── */
  useEffect(() => {
    if (loading) return;

    const params  = new URLSearchParams(location.search);
    const state   = location.state as any;
    const fromVal = params.get('from') || state?.from;
    const toVal   = params.get('to')   || state?.to || state?.autoSelectPoiId;

    if (fromVal) setFromQuery(fromVal);
    if (toVal)   setToQuery(toVal);

    if (fromVal && toVal) {
      const timer = setTimeout(() => {
        handleRoute();
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [location.search, location.state, loading, handleRoute]);

  /* ─── Fly map to a named location ─────────────────────────────────── */
  const flyToLocation = useCallback((query: string, type: 'source' | 'destination') => {
    const map = mapRef.current;
    if (!map || !query.trim()) return;
    const loc = findFeatureByQuery(query);
    if (!loc) return;
    map.flyTo({
      center: loc.coords,
      zoom: 18,
      pitch: 30,
      bearing: 0,
      duration: 1000,
      essential: true,
    });
    
    const markerRef = type === 'source' ? sourceMarkerRef : destMarkerRef;
    if (markerRef.current) {
      markerRef.current.remove();
    }
    
    const el = document.createElement('div');
    el.className = 'route-pinpoint-marker';
    const bgColor = type === 'source' ? '#2979ff' : '#aa00ff';
    const labelPrefix = type === 'source' ? 'Source' : 'Destination';
    el.innerHTML = `
      <div style="display: flex; flex-direction: column; align-items: center; pointer-events: none;">
        <div style="background: ${bgColor}; color: white; padding: 4px 8px; border-radius: 6px; font-size: 12px; font-weight: bold; white-space: nowrap; box-shadow: 0 2px 6px rgba(0,0,0,0.4); margin-bottom: 4px; border: 2px solid white;">
          ${labelPrefix}: ${query}
        </div>
        <div style="width: 16px; height: 16px; background: ${bgColor}; border: 3px solid white; border-radius: 50%; box-shadow: 0 2px 4px rgba(0,0,0,0.4);"></div>
      </div>
    `;
    
    markerRef.current = new Marker({ element: el, anchor: 'bottom' })
      .setLngLat(loc.coords)
      .addTo(map);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allFeaturesRef]);

  /* ─── Camera helper ───────────────────────────────────────────────── */
  const cameraToStep = useCallback((stepIdx: number, instant = false) => {
    const map = mapRef.current;
    const currentSteps = stepsRef.current;
    if (!map || !currentSteps.length || stepIdx >= currentSteps.length) return;

    const step = currentSteps[stepIdx];
    const coord = step.coordinates[0];
    const nextCoord = step.coordinates[1] || step.coordinates[0];
    const bearing = calculateBearing(coord[1], coord[0], nextCoord[1], nextCoord[0]);

    map.easeTo({
      center: coord,
      zoom: 18,
      pitch: 55,
      bearing,
      duration: instant ? 500 : 900,
      padding: { top: 80, bottom: 220, left: 280, right: 20 },
    });
  }, []);

  /* ─── Start navigation ────────────────────────────────────────────── */
  const startNavigation = useCallback(() => {
    const map = mapRef.current;
    if (!stepsRef.current.length || !map) return;
    setNavMode(true);
    setActiveStep(0);
    activeStepRef.current = 0;
    notifiedCheckpointsRef.current.clear();
    setNotificationStatus(null);
    hideTooltip();

    /* Place user marker at step 0 */
    userMarkerRef.current?.remove();
    const el = document.createElement('div');
    el.style.cssText = `
      width:24px;height:24px;border-radius:50%;
      background:#2979ff;border:3px solid #fff;
      box-shadow:0 0 18px rgba(41,121,255,0.9),0 0 40px rgba(41,121,255,0.4);
      display:flex;align-items:center;justify-content:center;
    `;
    const pulse = document.createElement('div');
    pulse.style.cssText = 'width:8px;height:8px;border-radius:50%;background:#fff;';
    el.appendChild(pulse);

    const step0 = stepsRef.current[0];
    userMarkerRef.current = new Marker({ element: el })
      .setLngLat(step0.coordinates[0])
      .addTo(map);

    /* Hide POI dots and labels during navigation */
    LAYER_DEFS.forEach(def => {
      ['circle', 'label'].forEach(suffix => {
        const layerId = `${def.id}-${suffix}`;
        if (map.getLayer(layerId)) {
          map.setLayoutProperty(layerId, 'visibility', 'none');
        }
      });
    });

    cameraToStep(0, true);
  }, [cameraToStep, hideTooltip]);

  /* ─── Stop navigation ─────────────────────────────────────────────── */
  const stopNavigation = useCallback(() => {
    const map = mapRef.current;
    userMarkerRef.current?.remove();
    userMarkerRef.current = null;
    setNavMode(false);
    setActiveStep(0);
    activeStepRef.current = 0;
    notifiedCheckpointsRef.current.clear();
    setNotificationStatus(null);
    map?.easeTo({ pitch: 0, bearing: 0, zoom: 15, duration: 700 });

    /* Show POI dots and labels after navigation */
    if (map) {
      LAYER_DEFS.forEach(def => {
        ['circle', 'label'].forEach(suffix => {
          const layerId = `${def.id}-${suffix}`;
          if (map.getLayer(layerId)) {
            map.setLayoutProperty(layerId, 'visibility', 'visible');
          }
        });
      });
    }
  }, []);

  /* ─── Manual step navigation ──────────────────────────────────────── */
  const gotoStep = useCallback((newIdx: number) => {
    const currentSteps = stepsRef.current;
    if (newIdx < 0 || newIdx >= currentSteps.length) return;
    activeStepRef.current = newIdx;
    setActiveStep(newIdx);

    const step = currentSteps[newIdx];
    const coord = step.coordinates[0];

    /* Move user marker */
    userMarkerRef.current?.setLngLat(coord);

    /* Recalculate remaining distance & ETA */
    let remaining = 0;
    for (let i = newIdx; i < currentSteps.length; i++) remaining += currentSteps[i].distanceMeters;
    setDist(remaining);
    setEta(Math.round(remaining / 1.4));

    /* Move camera to this step */
    cameraToStep(newIdx);
  }, [cameraToStep]);

  const handleNextStep = useCallback(() => {
    const currentIdx = activeStepRef.current;
    
    // Check both current step and next step for notifications if we are skipping by 2
    const stepsToCheck = [stepsRef.current[currentIdx], stepsRef.current[currentIdx + 1]].filter(Boolean);
    
    stepsToCheck.forEach(currentStep => {
      if (currentStep) {
        const instrLower = (currentStep.instruction || '').toLowerCase();
        const titleLower = (currentStep.title || '').toLowerCase();
        const cpNameLower = (currentStep.checkpoint?.name || '').toLowerCase();

        const isSecurity = currentStep.checkpoint?.type === 'security' ||
                           instrLower.includes('security') ||
                           titleLower.includes('security') ||
                           cpNameLower.includes('security');

        const isLuggage  = currentStep.checkpoint?.type === 'luggage' ||
                           instrLower.includes('luggage') ||
                           instrLower.includes('baggage') ||
                           titleLower.includes('luggage') ||
                           titleLower.includes('baggage') ||
                           cpNameLower.includes('luggage') ||
                           cpNameLower.includes('baggage');

        const token = localStorage.getItem('token');
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }

        if (isSecurity && !notifiedCheckpointsRef.current.has('security')) {
          notifiedCheckpointsRef.current.add('security');
          fetch('/api/guardian/navigation/security-complete', {
            method: 'POST',
            headers,
          })
            .then(res => res.json())
            .then(data => {
              if (data.success && data.guardianNotified) {
                setNotificationStatus('✓ Personal Guardian notified via email');
                setTimeout(() => setNotificationStatus(null), 4000);
              } else if (data.success && !data.guardianNotified) {
                console.log('[Navigation] No verified guardian found to notify.');
              }
            })
            .catch(err => {
              console.error('Failed to notify guardian for security complete:', err);
              setNotificationStatus('⚠ Guardian notification could not be sent.');
              setTimeout(() => setNotificationStatus(null), 4000);
            });
        } else if (isLuggage && !notifiedCheckpointsRef.current.has('luggage')) {
          notifiedCheckpointsRef.current.add('luggage');
          fetch('/api/guardian/navigation/luggage-complete', {
            method: 'POST',
            headers,
          })
            .then(res => res.json())
            .then(data => {
              if (data.success && data.guardianNotified) {
                setNotificationStatus('✓ Personal Guardian notified via email');
                setTimeout(() => setNotificationStatus(null), 4000);
              } else if (data.success && !data.guardianNotified) {
                console.log('[Navigation] No verified guardian found to notify.');
              }
            })
            .catch(err => {
              console.error('Failed to notify guardian for luggage complete:', err);
              setNotificationStatus('⚠ Guardian notification could not be sent.');
              setTimeout(() => setNotificationStatus(null), 4000);
            });
        }
      }
    });

    // Advance to next step immediately by 2
    gotoStep(Math.min(currentIdx + 2, stepsRef.current.length - 1));
  }, [gotoStep]);


  const handlePrevStep = useCallback(() => gotoStep(Math.max(activeStepRef.current - 2, 0)), [gotoStep]);

  /* ─── Tooltip safe position ───────────────────────────────────────── */
  const getTooltipStyle = () => {
    if (!tooltip) return {};
    const W = window.innerWidth, H = window.innerHeight;
    const TW = 240, TH = 200;
    let left = tooltip.x + 16;
    let top  = tooltip.y - TH / 2;
    if (left + TW > W - 10) left = tooltip.x - TW - 16;
    if (top < 10) top = 10;
    if (top + TH > H - 10) top = H - TH - 10;
    return { left, top };
  };

  const mins = Math.ceil(eta / 60);
  const currentStep = steps[activeStep];

  const fromRecs = getRecommendations(fromQuery);
  const toRecs   = getRecommendations(toQuery);

  /* ═══════════════════════════════════════════════════════════════════
     Render
  ═══════════════════════════════════════════════════════════════════ */
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[#0a0e1a]">

      {/* ── Top bar ─────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-4 py-3 border-b shrink-0 bg-[#0e1426] border-white/10 relative z-50">
        <button onClick={() => navigate(-1)} className="flex items-center justify-center w-9 h-9 rounded-xl bg-white/5 hover:bg-white/10 transition-all">
          <ArrowLeft size={18} color="#e8ecf4" />
        </button>
        <div className="flex items-center gap-2 flex-1">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center text-base bg-gradient-to-br from-blue-500 to-cyan-400">✈</div>
          <div>
            <div className="text-sm font-bold text-transparent bg-clip-text bg-gradient-to-r from-blue-500 to-cyan-400">
              Heathrow Navigation
            </div>
            <div className="text-[10px] text-gray-400">Interactive Indoor Map</div>
          </div>
        </div>
        <button onClick={toggleFullscreen} className="flex items-center justify-center w-9 h-9 rounded-xl bg-white/5 hover:bg-white/10 transition-all">
          {fullscreen ? <Minimize2 size={17} color="#e8ecf4" /> : <Maximize2 size={17} color="#e8ecf4" />}
        </button>
      </div>

      <div className="relative flex-1 min-h-0">

        {/* ── Loading overlay ──────────────────────────────────── */}
        {loading && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 bg-[#0a0e1a]">
            <div className="w-14 h-14 rounded-full border-[3px] animate-spin"
              style={{ borderColor: 'rgba(41,121,255,0.2)', borderTopColor: '#2979ff' }} />
            <div className="text-sm font-medium text-gray-400">{loadMsg}</div>
          </div>
        )}

        {/* ── MapLibre canvas ───────────────────────────────────── */}
        <div ref={mapContainer} className="absolute inset-0 w-full h-full" />

        {/* ── Interactive Tooltip ───────────────────────────────── */}
        {tooltip && (
          <div className="absolute z-30 pointer-events-none" style={{ ...getTooltipStyle(), transition: 'none' }}>
            <div
              className="pointer-events-auto"
              style={{
                opacity: tooltipVisible ? 1 : 0,
                transform: tooltipVisible ? 'translateY(0) scale(1)' : 'translateY(6px) scale(0.97)',
                transition: 'opacity 0.2s ease, transform 0.2s ease',
                width: 230,
              }}
            >
              <div className="bg-[#0d1628]/95 backdrop-blur-xl border border-white/12 rounded-2xl shadow-2xl overflow-hidden"
                style={{ boxShadow: '0 8px 40px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.06)' }}>
                <div className="px-4 pt-3 pb-2 border-b border-white/8"
                  style={{ background: 'linear-gradient(135deg, rgba(41,121,255,0.12), rgba(0,229,255,0.06))' }}>
                  <div className="flex items-start gap-2">
                    <span className="text-lg leading-none mt-0.5 flex-shrink-0">
                      {CAT_ICONS[tooltip.category ?? ''] || '📍'}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-bold text-white leading-tight break-words">{tooltip.title}</div>
                      {tooltip.category && <div className="text-[10px] text-cyan-400/80 mt-0.5 capitalize">{tooltip.category}</div>}
                    </div>
                    <button className="pointer-events-auto flex-shrink-0 text-white/30 hover:text-white/70 transition-colors" onClick={hideTooltip}>
                      <X size={13} />
                    </button>
                  </div>
                </div>
                <div className="px-4 py-2.5 space-y-1.5 text-[11px]">
                  {tooltip.terminal && (
                    <div className="flex items-center gap-2 text-gray-300">
                      <MapPin size={10} className="text-blue-400 flex-shrink-0" />
                      <span className="text-gray-500">Terminal</span>
                      <span className="ml-auto font-semibold text-blue-300">{tooltip.terminal}</span>
                    </div>
                  )}
                  {tooltip.ref && (
                    <div className="flex items-center gap-2 text-gray-300">
                      <Info size={10} className="text-purple-400 flex-shrink-0" />
                      <span className="text-gray-500">Ref</span>
                      <span className="ml-auto font-semibold text-purple-300">{tooltip.ref}</span>
                    </div>
                  )}
                  {(tooltip.level !== undefined && tooltip.level !== '') && (
                    <div className="flex items-center gap-2 text-gray-300">
                      <span className="text-[9px] text-gray-500">LEVEL</span>
                      <span className="ml-auto font-semibold text-yellow-300">{tooltip.level}</span>
                    </div>
                  )}
                  {tooltip.operator && (
                    <div className="flex items-center gap-2 text-gray-300">
                      <span className="text-[9px] text-gray-500">OPERATOR</span>
                      <span className="ml-auto text-gray-300 truncate max-w-[110px]">{tooltip.operator}</span>
                    </div>
                  )}
                  {tooltip.hours && (
                    <div className="flex items-center gap-2 text-gray-300">
                      <span className="text-[9px] text-gray-500">HOURS</span>
                      <span className="ml-auto text-gray-300 text-[10px]">{tooltip.hours}</span>
                    </div>
                  )}
                </div>
                <div className="px-3 pb-3 flex gap-2">
                  <button
                    className="pointer-events-auto flex-1 text-center text-[10px] font-semibold py-1.5 rounded-lg transition-colors"
                    style={{ background: 'rgba(41,121,255,0.15)', color: '#64b0ff' }}
                    onClick={() => { setFromQuery(tooltip.title); hideTooltip(); flyToLocation(tooltip.title, 'source'); }}
                  >Set as From</button>
                  <button
                    className="pointer-events-auto flex-1 text-center text-[10px] font-semibold py-1.5 rounded-lg transition-colors"
                    style={{ background: 'rgba(170,0,255,0.15)', color: '#ce93d8' }}
                    onClick={() => { setToQuery(tooltip.title); hideTooltip(); flyToLocation(tooltip.title, 'destination'); }}
                  >Set as To</button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── Route Planner panel ───────────────────────────────── */}
        {!navMode && !loading && (
          <div className="absolute top-4 left-4 w-80 bg-[#0a1020]/95 backdrop-blur-xl border border-white/10 rounded-2xl p-4 shadow-2xl z-30">
            <h3 className="text-white text-sm font-bold mb-3 flex items-center gap-2">
              <NavIcon size={15} className="text-blue-400" />
              Route Planner
            </h3>
            <div className="space-y-3">

              {/* From Input + Autocomplete Recommender */}
              <div className="relative">
                <Search size={13} className="absolute left-3 top-3 text-gray-400 z-10" />
                <input
                  type="text"
                  className="w-full bg-white/5 border border-white/10 rounded-xl pl-8 pr-3 py-2 text-xs text-white placeholder-gray-400 outline-none focus:border-blue-500 transition-colors"
                  placeholder="From (e.g. BA Galleries Lounge, Entrance 86)"
                  value={fromQuery}
                  onFocus={() => { setShowFromRecs(true); setShowToRecs(false); }}
                  onChange={e => { setFromQuery(e.target.value); setShowFromRecs(true); }}
                  onKeyDown={e => e.key === 'Enter' && handleRoute()}
                />
                {showFromRecs && fromRecs.length > 0 && (
                  <div className="absolute top-full left-0 right-0 mt-1 bg-[#0b1324] border border-blue-500/40 rounded-xl shadow-2xl z-50 max-h-48 overflow-y-auto divide-y divide-white/5">
                    <div className="px-3 py-1.5 text-[10px] font-bold uppercase text-blue-400 bg-blue-500/20">
                      Matching Locations ({fromRecs.length})
                    </div>
                    {fromRecs.map((loc, idx) => (
                      <button
                        key={idx}
                        className="w-full text-left px-3 py-2 text-xs text-gray-200 hover:bg-blue-600/40 hover:text-white transition-colors flex items-center gap-2"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          setFromQuery(loc);
                          setShowFromRecs(false);
                          flyToLocation(loc, 'source');
                        }}
                      >
                        <MapPin size={11} className="text-blue-400 shrink-0" />
                        <span className="truncate">{loc}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* To Input + Autocomplete Recommender */}
              <div className="relative">
                <Search size={13} className="absolute left-3 top-3 text-gray-400 z-10" />
                <input
                  type="text"
                  className="w-full bg-white/5 border border-white/10 rounded-xl pl-8 pr-3 py-2 text-xs text-white placeholder-gray-400 outline-none focus:border-purple-500 transition-colors"
                  placeholder="To (e.g. Entrance 86, Gate A12, Terminal T6)"
                  value={toQuery}
                  onFocus={() => { setShowToRecs(true); setShowFromRecs(false); }}
                  onChange={e => { setToQuery(e.target.value); setShowToRecs(true); }}
                  onKeyDown={e => e.key === 'Enter' && handleRoute()}
                />
                {showToRecs && toRecs.length > 0 && (
                  <div className="absolute top-full left-0 right-0 mt-1 bg-[#0b1324] border border-purple-500/40 rounded-xl shadow-2xl z-50 max-h-48 overflow-y-auto divide-y divide-white/5">
                    <div className="px-3 py-1.5 text-[10px] font-bold uppercase text-purple-400 bg-purple-500/20">
                      Matching Locations ({toRecs.length})
                    </div>
                    {toRecs.map((loc, idx) => (
                      <button
                        key={idx}
                        className="w-full text-left px-3 py-2 text-xs text-gray-200 hover:bg-purple-600/40 hover:text-white transition-colors flex items-center gap-2"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          setToQuery(loc);
                          setShowToRecs(false);
                          flyToLocation(loc, 'destination');
                        }}
                      >
                        <MapPin size={11} className="text-purple-400 shrink-0" />
                        <span className="truncate">{loc}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {routeError && (
                <div className="text-xs text-red-400 bg-red-400/10 rounded-lg px-3 py-2">{routeError}</div>
              )}

              <div className="flex gap-2 pt-1">
                <button
                  onClick={() => { setShowFromRecs(false); setShowToRecs(false); handleRoute(); }}
                  className="flex-1 bg-white/10 hover:bg-white/20 text-white rounded-xl py-2.5 text-xs font-bold transition-colors"
                >
                  Find Route
                </button>
                <button
                  onClick={startNavigation}
                  disabled={steps.length === 0}
                  className="flex-1 bg-gradient-to-r from-blue-600 to-cyan-500 hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-xl py-2.5 text-xs font-bold transition-all shadow-md"
                >
                  Start Nav
                </button>
              </div>

              {steps.length > 0 && (
                <div className="text-xs text-green-400 text-center pt-1 font-medium bg-green-500/10 py-1.5 rounded-lg border border-green-500/20">
                  ✓ {steps.length} steps · {Math.round(dist)}m · ~{mins} min
                </div>
              )}
            </div>

            {/* Layer legend */}
            <div className="mt-3 pt-3 border-t border-white/8">
              <div className="text-[10px] text-gray-500 font-semibold uppercase tracking-wider mb-2 flex items-center gap-1">
                <Layers size={10} /> Layers
              </div>
              <div className="grid grid-cols-2 gap-1">
                {LAYER_DEFS.map(d => (
                  <div key={d.id} className="flex items-center gap-1.5">
                    <div className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: d.color }} />
                    <span className="text-[10px] text-gray-400">{d.label}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── Navigation Panel ──────────────────────────────────── */}
        {navMode && (
          <div className="absolute bottom-0 left-0 right-0 md:w-[350px] md:top-auto md:bottom-4 md:left-4 z-20 flex flex-col shadow-2xl rounded-t-3xl md:rounded-2xl"
            style={{
              background: 'rgba(10,16,32,0.97)',
              backdropFilter: 'blur(24px)',
              border: '1px solid rgba(255,255,255,0.08)',
            }}>

            {/* Header */}
            <div className="p-4 border-b shrink-0" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
              <div className="flex justify-between items-center mb-3">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center">
                    <CheckCircle2 size={18} color="#fff" />
                  </div>
                  <div>
                    <h2 className="text-white font-bold text-base leading-tight">Navigation</h2>
                    <div className="text-[10px] text-gray-500">Step-by-step directions</div>
                  </div>
                </div>
                <button onClick={stopNavigation} className="text-gray-400 hover:text-white transition-colors text-lg">✕</button>
              </div>
              <div className="flex gap-4 text-sm">
                <div className="flex-1 bg-blue-600/15 rounded-lg p-2 text-center">
                  <div className="text-green-400 font-bold text-base">{mins} min</div>
                  <div className="text-gray-500 text-[10px]">remaining</div>
                </div>
                <div className="flex-1 bg-white/5 rounded-lg p-2 text-center">
                  <div className="text-white font-bold text-base">{Math.round(dist)}m</div>
                  <div className="text-gray-500 text-[10px]">distance</div>
                </div>
                <div className="flex-1 bg-white/5 rounded-lg p-2 text-center">
                  <div className="text-cyan-400 font-bold text-base">{activeStep + 1}/{steps.length}</div>
                  <div className="text-gray-500 text-[10px]">steps</div>
                </div>
              </div>

              {/* Notification Status Banner */}
              {notificationStatus && (
                <div className={`mt-2.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-center transition-all ${
                  notificationStatus.startsWith('✓')
                    ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300'
                    : 'bg-amber-500/15 border border-amber-500/30 text-amber-300'
                }`}>
                  {notificationStatus}
                </div>
              )}
            </div>

            {/* 2 steps list */}
            <div className="py-2 px-2 flex-none">
              {steps.slice(activeStep, activeStep + 2).map((step, mappedIdx) => {
                const idx = activeStep + mappedIdx;
                const isActive = idx === activeStep;
                const isPast = false;
                const cp = step.checkpoint;

                /* ── Checkpoint Step Card ── */
                if (cp) {
                  const isSecurity = cp.type === 'security';
                  const bgActive   = isSecurity ? 'rgba(239,68,68,0.18)' : 'rgba(234,179,8,0.15)';
                  const bgNormal   = isSecurity ? 'rgba(239,68,68,0.07)' : 'rgba(234,179,8,0.06)';
                  const borderClr  = isSecurity ? 'rgba(239,68,68,0.45)' : 'rgba(234,179,8,0.4)';
                  const textClr    = isSecurity ? '#fca5a5' : '#fde68a';
                  const iconBg     = isSecurity ? '#7f1d1d' : '#713f12';
                  return (
                    <button key={idx}
                      onClick={() => gotoStep(idx)}
                      className="w-full text-left mb-2 rounded-xl transition-all"
                      style={{
                        background: isActive ? bgActive : isPast ? 'rgba(255,255,255,0.02)' : bgNormal,
                        border: `1.5px solid ${isActive ? cp.color : isPast ? 'rgba(255,255,255,0.05)' : borderClr}`,
                        opacity: isPast ? 0.45 : 1,
                      }}
                    >
                      <div className="flex items-center gap-3 px-3 py-2.5">
                        <div className="w-8 h-8 rounded-full flex items-center justify-center text-base shrink-0"
                          style={{ background: iconBg, border: `1.5px solid ${cp.color}` }}>
                          {isSecurity ? '🛡️' : '🧳'}
                        </div>
                        <div className="flex-1">
                          <div className="text-[11px] font-bold" style={{ color: textClr }}>
                            {isSecurity ? 'Pass through' : 'Proceed through'} {cp.name}
                          </div>
                          <div className="text-[9px] mt-0.5" style={{ color: isSecurity ? '#ef4444' : '#eab308', opacity: 0.7 }}>
                            {isSecurity ? '🔴 Security Checkpoint' : '🟡 Luggage Check Zone'}
                          </div>
                        </div>
                        {isActive && (
                          <div className="text-[9px] font-bold px-1.5 py-0.5 rounded-full"
                            style={{ background: cp.color, color: isSecurity ? '#1a0000' : '#1a1000' }}>
                            NOW
                          </div>
                        )}
                      </div>
                    </button>
                  );
                }

                /* ── Regular Step Card ── */
                return (
                  <button key={idx}
                    onClick={() => gotoStep(idx)}
                    className={`w-full flex items-start gap-3 p-3 rounded-xl transition-all mb-1 text-left ${
                      isActive ? 'bg-blue-600/20 border border-blue-500/30' :
                      isPast   ? 'opacity-35' : 'hover:bg-white/5'
                    }`}>
                    <div className={`mt-0.5 flex items-center justify-center w-7 h-7 rounded-full shrink-0 ${
                      isActive ? 'bg-blue-600 text-white' : isPast ? 'bg-gray-700 text-gray-500' : 'bg-gray-800 text-gray-400'
                    }`}>
                      <ActionIcon action={step.action} size={14} />
                    </div>
                    <div className="flex-1">
                      <div className={`text-xs font-medium ${isActive ? 'text-white' : 'text-gray-400'}`}>
                        {step.instruction}
                      </div>
                      {step.distanceMeters > 0 && (
                        <div className="text-[10px] text-gray-600 mt-0.5">{step.distanceMeters}m</div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Controls footer */}
            <div className="p-3 border-t shrink-0" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
              <div className="grid grid-cols-2 gap-2">
                <button onClick={handlePrevStep}
                  disabled={activeStep === 0}
                  className="bg-white/10 hover:bg-white/20 disabled:opacity-30 text-white rounded-xl py-3 text-sm font-semibold transition-colors flex items-center justify-center gap-2">
                  ← Prev
                </button>
                <button onClick={handleNextStep}
                  disabled={activeStep >= steps.length - 1}
                  className="bg-blue-600 hover:bg-blue-700 disabled:opacity-30 text-white rounded-xl py-3 text-sm font-semibold transition-colors flex items-center justify-center gap-2">
                  Next →
                </button>
              </div>
              <div className="mt-2 text-center text-[10px] text-gray-600">
                Click any step above or use Prev/Next to navigate
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
