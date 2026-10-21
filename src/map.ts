// The footprint map's background (#563): MapLibre draws the points over map tiles kept on the host's own origin, so no
// outside domain sees where the trip went — unless a member taps a place's map link, which opens that place in a map service. Built apart from app.js as dist/public/map.js and imported only when the map is
// shown; the worker and the stylesheet are served beside it under fixed names. Values: docs/design/footprint-basemap.md.
import { AttributionControl, LngLatBounds, Map as MapLibre, Marker, addProtocol, setWorkerUrl, type LayerSpecification } from "maplibre-gl";
import { Protocol } from "pmtiles";
import { regionsOf } from "./mapdata";

export type MapData = { spots: { lat: number; lng: number; ids: string[] }[]; lines: { lat: number; lng: number }[][]; plans: { id: string; lat: number; lng: number; label: string }[] };
// Where the map looks: what a map drawn again on the same page keeps from the one before, once the member has moved it (#574).
export type MapCamera = { center: [number, number]; zoom: number };

// Fills and lines of the Protomaps basemap (OpenStreetMap). Every file listed in map/regions.json (#564) gets the same layers:
// the world to z8, each region to z15.
function mapLayers(source: string): LayerSpecification[] {
  const s = { source }, kinds = (...k: string[]) => ["in", ["get", "kind"], ["literal", k]];
  const label = { "text-color": "#333", "text-halo-color": "#fff", "text-halo-width": 1.5 };
  return [
    { id: `${source}-earth`, type: "fill", ...s, "source-layer": "earth", paint: { "fill-color": "#f4f1ea" } },
    { id: `${source}-landuse`, type: "fill", ...s, "source-layer": "landuse", filter: kinds("park", "forest", "wood", "grass", "nature_reserve", "cemetery", "golf_course"), paint: { "fill-color": "#dfe9d5" } },
    { id: `${source}-water`, type: "fill", ...s, "source-layer": "water", paint: { "fill-color": "#c7dbe8" } },
    { id: `${source}-boundaries`, type: "line", ...s, "source-layer": "boundaries", filter: ["<=", ["get", "kind_detail"], 4], paint: { "line-color": "#a99fb5", "line-width": 1, "line-dasharray": [3, 2] } },
    { id: `${source}-roads-minor`, type: "line", ...s, "source-layer": "roads", filter: kinds("minor_road", "path"), minzoom: 13, paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 13, 0.5, 15, 3] } },
    { id: `${source}-roads-major`, type: "line", ...s, "source-layer": "roads", filter: kinds("highway", "major_road"), paint: { "line-color": ["match", ["get", "kind"], "highway", "#f2c37c", "#fbe3a8"], "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.5, 15, 6] } },
    { id: `${source}-rail`, type: "line", ...s, "source-layer": "roads", filter: ["==", ["get", "kind"], "rail"], paint: { "line-color": "#9a9a9a", "line-width": 1 } },
    // No glyphs URL: MapLibre draws every label with the device's own sans-serif, so no font is fetched from anywhere.
    { id: `${source}-places`, type: "symbol", ...s, "source-layer": "places", layout: { "text-field": ["coalesce", ["get", "name:ja"], ["get", "name"]], "text-font": ["sans-serif"], "text-size": ["match", ["get", "kind"], "country", 14, "region", 12, "locality", 13, 11] }, paint: label },
    { id: `${source}-pois`, type: "symbol", ...s, "source-layer": "pois", minzoom: 14, layout: { "text-field": ["coalesce", ["get", "name:ja"], ["get", "name"]], "text-font": ["sans-serif"], "text-size": 10 }, paint: { ...label, "text-color": "#555" } },
    { id: `${source}-roadnames`, type: "symbol", ...s, "source-layer": "roads", minzoom: 14, layout: { "symbol-placement": "line", "text-field": ["coalesce", ["get", "ref"], ["get", "name"]], "text-font": ["sans-serif"], "text-size": 10 }, paint: { ...label, "text-color": "#555" } },
  ] as LayerSpecification[];
}

let ready = false;
// Draws the map into el and returns what removes it. The map files are the ones map/regions.json lists; without it (or with a
// record that does not read) the background stays plain, and the points and lines are drawn all the same. With a camera the map
// opens where it says instead of around the points; removing the map returns where it looked if the member moved it (or it
// was given one), so the next drawing can keep it.
export function showMap(el: HTMLElement, data: MapData, onSpot: (ids: string[]) => void, onPlan: (id: string) => void, camera?: MapCamera): () => MapCamera | undefined {
  if (!ready) {
    setWorkerUrl("/maplibre-worker.mjs"); addProtocol("pmtiles", new Protocol().tile);
    const link = document.createElement("link"); link.rel = "stylesheet"; link.href = "/map.css"; document.head.append(link);
    ready = true;
  }
  const files = fetch("/map/regions.json").then(r => r.ok ? r.json() : null).then(v => regionsOf(v).files).catch(() => []);
  let removed = false;
  const map = new MapLibre({
    container: el, maxZoom: 15, attributionControl: false, localIdeographFontFamily: "sans-serif",
    style: { version: 8, sources: {
      track: { type: "geojson", data: { type: "FeatureCollection", features: data.lines.map(line => ({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: line.map(p => [p.lng, p.lat]) } })) } },
    }, layers: [
      { id: "background", type: "background", paint: { "background-color": "#c7dbe8" } },
      { id: "track", type: "line", source: "track", paint: { "line-color": "#6b6b6b", "line-width": 1.5, "line-dasharray": [2, 2], "line-opacity": 0.8 } },
    ] },
  });
  // The record's order (the world first, then each region over it), then every label on top, so that no label is hidden under a
  // region's land; all of it under the track. Their ids are prefixed, so a region named like the track (or the background) is
  // its own source.
  map.once("load", async () => {
    const list = await files;
    if (removed) return;
    for (const f of list) map.addSource(`map:${f.name}`, { type: "vector", url: `pmtiles://${location.origin}/map/${f.name}.pmtiles` });
    const layers = list.flatMap(f => mapLayers(`map:${f.name}`));
    for (const layer of [...layers.filter(l => l.type !== "symbol"), ...layers.filter(l => l.type === "symbol")]) map.addLayer(layer, "track");
  });
  map.addControl(new AttributionControl({ compact: false, customAttribution: "© OpenStreetMap contributors" }));
  for (const spot of data.spots) {
    const button = document.createElement("button");
    button.type = "button"; button.className = "spot"; button.dataset.ids = spot.ids.join(" ");
    button.setAttribute("aria-label", `足あと ${spot.ids.length} 件`);
    button.addEventListener("click", event => { event.stopPropagation(); onSpot(spot.ids); });
    new Marker({ element: button }).setLngLat([spot.lng, spot.lat]).addTo(map);
  }
  // A plan's own mark (#646): a diamond held just above its position, so that a footprint left on the spot stays pressable under
  // it; one for each item, not gathered by place.
  for (const plan of data.plans) {
    const button = document.createElement("button");
    button.type = "button"; button.className = "plan"; button.dataset.plan = plan.id;
    button.setAttribute("aria-label", `予定 ${plan.label}`);
    button.addEventListener("click", event => { event.stopPropagation(); onPlan(plan.id); });
    new Marker({ element: button, anchor: "bottom", offset: [0, -8] }).setLngLat([plan.lng, plan.lat]).addTo(map);
  }
  // Moves the member made carry an originalEvent; fitBounds and jumpTo do not. The view is also written on el for verify:ui.
  let moved = false;
  map.on("moveend", e => {
    if (e.originalEvent) moved = true;
    const c = map.getCenter();
    el.dataset.center = `${c.lng.toFixed(5)},${c.lat.toFixed(5)}`; el.dataset.zoom = map.getZoom().toFixed(2);
  });
  if (camera) map.jumpTo({ center: camera.center, zoom: camera.zoom });
  else {
    const bounds = new LngLatBounds();
    for (const spot of data.spots) bounds.extend([spot.lng, spot.lat]);
    for (const plan of data.plans) bounds.extend([plan.lng, plan.lat]);
    if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 40, maxZoom: 15, duration: 0 });
  }
  return () => {
    const c = map.getCenter(), seen: MapCamera = { center: [c.lng, c.lat], zoom: map.getZoom() };
    removed = true; map.remove();
    return moved || camera ? seen : undefined;
  };
}
