import { useEffect, useRef, useState } from 'preact/hooks';
import { LngLatBounds, Map as MlMap, NavigationControl, setWorkerUrl, type GeoJSONSource, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { STATUSES, statusIconImage, type ReviewStatus } from '../lib/status';

// The worker file is self-contained; tell MapLibre where Vite put it.
setWorkerUrl(workerUrl);

const SWEDEN_BOUNDS: [[number, number], [number, number]] = [[9.5, 54.8], [25.5, 69.8]];

export interface MapPoint {
  shelter_id: string;
  lon: number;
  lat: number;
  status: ReviewStatus;
}

/** The same six-layer monochrome basemap as the public map. */
async function buildStyle(): Promise<StyleSpecification> {
  try {
    const base = await (await fetch('https://tiles.openfreemap.org/styles/positron')).json();
    const sourceId = Object.keys(base.sources).find((k) => base.sources[k].type === 'vector') ?? Object.keys(base.sources)[0];
    return {
      version: 8,
      sources: base.sources,
      glyphs: base.glyphs,
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': '#000000' } },
        { id: 'water-outline', type: 'line', source: sourceId, 'source-layer': 'water', paint: { 'line-color': '#f7f7f5', 'line-width': 0.7, 'line-opacity': 0.5 } },
        {
          id: 'boundary', type: 'line', source: sourceId, 'source-layer': 'boundary',
          filter: ['<=', ['get', 'admin_level'], 7],
          paint: { 'line-color': '#4a4f57', 'line-width': 0.6, 'line-dasharray': [3, 2] },
        },
        {
          id: 'roads', type: 'line', source: sourceId, 'source-layer': 'transportation',
          paint: { 'line-color': '#f7f7f5', 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.2, 12, 0.8, 16, 2], 'line-opacity': 0.35 },
        },
        { id: 'buildings', type: 'line', source: sourceId, 'source-layer': 'building', minzoom: 13, paint: { 'line-color': '#f7f7f5', 'line-width': 0.5, 'line-opacity': 0.3 } },
        {
          id: 'places', type: 'symbol', source: sourceId, 'source-layer': 'place',
          layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': ['interpolate', ['linear'], ['zoom'], 6, 11, 10, 14], 'text-transform': 'uppercase', 'text-letter-spacing': 0.1 },
          paint: { 'text-color': '#c9ced6', 'text-halo-color': '#000000', 'text-halo-width': 1.6 },
        },
      ],
    };
  } catch {
    // Offline or blocked: shelters still show on a plain background.
    return { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#000000' } }] };
  }
}

function toGeoJSON(points: MapPoint[], selected: Set<string>): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: points
      .filter((p) => Number.isFinite(p.lon) && Number.isFinite(p.lat))
      .map((p) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
        properties: { id: p.shelter_id, status: p.status, selected: selected.has(p.shelter_id) },
      })),
  };
}

export function StatusMap(props: {
  points: MapPoint[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onSelectMany: (ids: string[]) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const handlers = useRef(props);
  const fitted = useRef(false);
  const [ready, setReady] = useState(false);
  handlers.current = props;

  useEffect(() => {
    let disposed = false;
    let map: MlMap | null = null;

    buildStyle().then((style) => {
      if (disposed || !container.current) return;
      map = new MlMap({
        container: container.current,
        style,
        bounds: SWEDEN_BOUNDS,
        maxBounds: SWEDEN_BOUNDS,
        dragRotate: false,
        touchPitch: false,
        attributionControl: { compact: true },
      });
      mapRef.current = map;
      map.touchZoomRotate.disableRotation();
      map.addControl(new NavigationControl({ showCompass: false }), 'top-right');

      map.on('load', () => {
        const ratio = window.devicePixelRatio || 1;
        for (const s of STATUSES) map!.addImage(`st-${s}`, statusIconImage(s, ratio), { pixelRatio: ratio });
        map!.addSource('shelters', { type: 'geojson', data: toGeoJSON([], new Set()) });
        map!.addLayer({
          id: 'selected-ring', type: 'circle', source: 'shelters', filter: ['==', ['get', 'selected'], true],
          paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 8, 12, 13], 'circle-color': 'rgba(255,255,255,0.12)', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 },
        });
        map!.addLayer({
          id: 'shelter-status', type: 'symbol', source: 'shelters',
          layout: {
            'icon-image': ['concat', 'st-', ['get', 'status']],
            'icon-allow-overlap': true,
            'icon-size': ['interpolate', ['linear'], ['zoom'], 6, 0.55, 10, 0.8, 13, 1],
            // Problems on top: overdue, deficiencies and site visits are drawn last.
            'symbol-sort-key': ['match', ['get', 'status'], 'platsbesok', 7, 'brister', 6, 'forsenad', 5, 'inskickad', 4, 'forelagd', 3, 'godkand', 2, 1],
          },
        });
        map!.on('click', 'shelter-status', (e) => {
          const id = e.features?.[0]?.properties?.id;
          if (id) handlers.current.onToggle(String(id));
        });
        map!.on('mouseenter', 'shelter-status', () => (map!.getCanvas().style.cursor = 'pointer'));
        map!.on('mouseleave', 'shelter-status', () => (map!.getCanvas().style.cursor = ''));
        enableBoxSelect(map!, (ids) => handlers.current.onSelectMany(ids));
        setReady(true);
      });
    });

    return () => {
      disposed = true;
      map?.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    (map.getSource('shelters') as GeoJSONSource).setData(toGeoJSON(props.points, props.selected));
    if (!fitted.current && props.points.length) {
      const bounds = new LngLatBounds();
      for (const p of props.points) bounds.extend([p.lon, p.lat]);
      map.fitBounds(bounds, { padding: 40, duration: 0, maxZoom: 12 });
      fitted.current = true;
    }
  }, [props.points, props.selected, ready]);

  return <div ref={container} class="status-map" aria-label="Karta" />;
}

/** Shift + drag draws a box and selects every shelter inside it. */
function enableBoxSelect(map: MlMap, onSelect: (ids: string[]) => void) {
  map.boxZoom.disable();
  const canvas = map.getCanvasContainer();
  let start: { x: number; y: number } | null = null;
  let box: HTMLDivElement | null = null;

  const pos = (e: MouseEvent) => {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left - canvas.clientLeft, y: e.clientY - rect.top - canvas.clientTop };
  };

  function onMove(e: MouseEvent) {
    if (!start) return;
    const cur = pos(e);
    if (!box) {
      box = document.createElement('div');
      box.className = 'map-select-box';
      canvas.appendChild(box);
    }
    box.style.left = `${Math.min(start.x, cur.x)}px`;
    box.style.top = `${Math.min(start.y, cur.y)}px`;
    box.style.width = `${Math.abs(cur.x - start.x)}px`;
    box.style.height = `${Math.abs(cur.y - start.y)}px`;
  }

  function onUp(e: MouseEvent) {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    map.dragPan.enable();
    if (start) {
      const end = pos(e);
      const features = map.queryRenderedFeatures([[Math.min(start.x, end.x), Math.min(start.y, end.y)], [Math.max(start.x, end.x), Math.max(start.y, end.y)]], {
        layers: ['shelter-status'],
      });
      const ids = [...new Set(features.map((f) => String(f.properties?.id)))];
      if (ids.length) onSelect(ids);
    }
    box?.remove();
    box = null;
    start = null;
  }

  canvas.addEventListener('mousedown', (e: MouseEvent) => {
    if (!(e.shiftKey && e.button === 0)) return;
    map.dragPan.disable();
    start = pos(e);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    e.preventDefault();
  });
}
