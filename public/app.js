import { matchingTrips, minutesLate, relevantAlerts } from "./core.mjs";

const DATA_URL = "./data/caltrain.json";
const ROUTE_KEY = "caltrain-watch-route-v1";
const SEEN_KEY = "caltrain-watch-seen-v1";
const state = { data: null, originId: "", destinationId: "" };

const $ = (selector) => document.querySelector(selector);
const els = {
  origin: $("#origin"), destination: $("#destination"), swap: $("#swap"),
  notify: $("#notify"), refresh: $("#refresh"), status: $("#status"),
  updated: $("#updated"), departures: $("#departures"), alerts: $("#alerts"),
  empty: $("#empty"), summary: $("#route-summary"), notice: $("#data-notice")
};

const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
})[char]);
const formatTime = (epoch) => epoch ? new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" }).format(new Date(epoch * 1000)) : "—";
const stopName = (id) => state.data?.stops.find((stop) => stop.id === id)?.name ?? id;

function loadSavedRoute() {
  try { return JSON.parse(localStorage.getItem(ROUTE_KEY) || "null"); } catch { return null; }
}
function saveRoute() {
  localStorage.setItem(ROUTE_KEY, JSON.stringify({ originId: state.originId, destinationId: state.destinationId }));
}
function fillStops() {
  const options = state.data.stops.map((stop) => `<option value="${escapeHtml(stop.id)}">${escapeHtml(stop.name)}</option>`).join("");
  els.origin.innerHTML = options;
  els.destination.innerHTML = options;
  const ids = new Set(state.data.stops.map((stop) => stop.id));
  const saved = loadSavedRoute();
  state.originId = ids.has(saved?.originId) ? saved.originId : (state.data.stops.find((stop) => /San Francisco/i.test(stop.name))?.id || state.data.stops[0]?.id || "");
  state.destinationId = ids.has(saved?.destinationId) ? saved.destinationId : (state.data.stops.find((stop) => /San Mateo|Hillsdale/i.test(stop.name))?.id || state.data.stops.at(-1)?.id || "");
  if (state.originId === state.destinationId && state.data.stops.length > 1) state.destinationId = state.data.stops.find((stop) => stop.id !== state.originId).id;
  els.origin.value = state.originId;
  els.destination.value = state.destinationId;
}
function renderDepartures(trips) {
  els.departures.innerHTML = trips.slice(0, 10).map((trip) => {
    const late = minutesLate(trip, state.originId);
    const origin = trip.stops.find((stop) => stop.id === state.originId);
    const scheduled = origin?.departureEpoch;
    const actual = origin?.realtimeDepartureEpoch ?? scheduled;
    const statusText = trip.cancelled ? "Cancelled" : late > 0 ? `${late} min late` : "On time";
    const pillClass = trip.cancelled ? "cancelled" : late >= 5 ? "delay" : "";
    return `<article class="departure ${trip.cancelled ? "cancelled" : ""}">
      <div class="departure-top"><div><div class="train-name">Train ${escapeHtml(trip.trainNumber || trip.routeShortName || trip.id)}</div><small>Toward ${escapeHtml(trip.headsign || stopName(state.destinationId))}</small></div><span class="pill ${pillClass}">${statusText}</span></div>
      <div class="departure-times"><div class="time-block"><strong>${formatTime(actual)}</strong><small>${escapeHtml(stopName(state.originId))}</small></div><div class="route-line"></div><div class="time-block"><strong>${formatTime(trip.destinationTime)}</strong><small>${escapeHtml(stopName(state.destinationId))}</small></div></div>
      <div class="departure-meta"><span>${actual !== scheduled ? `Scheduled ${formatTime(scheduled)}` : "Realtime status checked"}</span><span>${trip.cancelled ? "Do not board" : "Upcoming departure"}</span></div>
    </article>`;
  }).join("");
  els.empty.hidden = trips.length > 0;
}
function renderAlerts(alerts) {
  if (!alerts.length) {
    els.alerts.innerHTML = `<article class="alert-card"><h3>No relevant active alerts</h3><p>The current feed has no service alert matching your selected route.</p></article>`;
    return;
  }
  els.alerts.innerHTML = alerts.map((alert) => `<article class="alert-card"><h3>${escapeHtml(alert.header || "Caltrain service alert")}</h3><p>${escapeHtml(alert.description || alert.effect?.replaceAll("_", " ") || "See the official alert for details.")}</p>${alert.url ? `<a href="${escapeHtml(alert.url)}" target="_blank" rel="noreferrer">Open official alert</a>` : ""}</article>`).join("");
}
function notifyNew(trips, alerts, force = false) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  let seen = [];
  try { seen = JSON.parse(localStorage.getItem(SEEN_KEY) || "[]"); } catch { seen = []; }
  const events = [
    ...trips.filter((trip) => trip.cancelled).map((trip) => ({ id: `trip:${trip.id}`, title: "Caltrain cancellation", body: `Train ${trip.trainNumber || ""} affecting ${stopName(state.originId)} to ${stopName(state.destinationId)} is cancelled.` })),
    ...alerts.map((alert) => ({ id: `alert:${alert.id}`, title: alert.header || "Caltrain service alert", body: alert.description || "A relevant service alert was published." }))
  ];
  for (const event of events.filter((event) => force || !seen.includes(event.id))) new Notification(event.title, { body: event.body, icon: "./icon.svg", tag: event.id });
  localStorage.setItem(SEEN_KEY, JSON.stringify(events.map((event) => event.id)));
}
function render({ notify = true } = {}) {
  if (!state.data) return;
  const trips = matchingTrips(state.data, state.originId, state.destinationId);
  const alerts = relevantAlerts(state.data, state.originId, state.destinationId, trips);
  els.summary.textContent = `${stopName(state.originId)} → ${stopName(state.destinationId)}`;
  renderDepartures(trips);
  renderAlerts(alerts);
  saveRoute();
  if (notify) notifyNew(trips, alerts);
}
async function loadData({ initial = false } = {}) {
  els.refresh.disabled = true;
  try {
    const response = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const first = !state.data;
    state.data = await response.json();
    if (first || initial) fillStops();
    els.status.textContent = state.data.mode === "live" ? "Live feed" : "Demo data";
    els.status.className = `status-badge ${state.data.mode === "live" ? "live" : "demo"}`;
    els.updated.textContent = `Updated ${new Date(state.data.generatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
    els.notice.hidden = !state.data.notice;
    els.notice.textContent = state.data.notice || "";
    render();
  } catch (error) {
    els.status.textContent = "Data unavailable";
    els.updated.textContent = error.message;
  } finally { els.refresh.disabled = false; }
}

els.origin.addEventListener("change", () => { state.originId = els.origin.value; render({ notify: false }); });
els.destination.addEventListener("change", () => { state.destinationId = els.destination.value; render({ notify: false }); });
els.swap.addEventListener("click", () => { [state.originId, state.destinationId] = [state.destinationId, state.originId]; els.origin.value = state.originId; els.destination.value = state.destinationId; render({ notify: false }); });
els.refresh.addEventListener("click", () => loadData());
els.notify.addEventListener("click", async () => {
  if (!("Notification" in window)) { els.notify.textContent = "Notifications unsupported"; return; }
  const permission = await Notification.requestPermission();
  els.notify.textContent = permission === "granted" ? "Cancellation alerts enabled" : "Enable cancellation alerts";
  if (permission === "granted") {
    const trips = matchingTrips(state.data, state.originId, state.destinationId);
    notifyNew(trips, relevantAlerts(state.data, state.originId, state.destinationId, trips), true);
  }
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js");
loadData({ initial: true });
setInterval(loadData, 60_000);
