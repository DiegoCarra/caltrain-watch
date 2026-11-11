import {
  CALTRAIN_TIME_ZONE,
  matchingTrips,
  minutesLate,
  preferredTripForDeparture,
  relevantAlerts,
  routeTrips,
  snapshotForDisplay,
  snapshotHealth,
  weekdayCommutePreference
} from "./core.mjs";

const DATA_URL = "./data/caltrain.json";
const ROUTE_KEY = "caltrain-watch-route-v1";
const SEEN_KEY = "caltrain-watch-seen-v1";
const state = {
  data: null,
  originId: "",
  destinationId: "",
  autoCommute: false,
  commute: null
};

const $ = (selector) => document.querySelector(selector);
const els = {
  origin: $("#origin"), destination: $("#destination"), swap: $("#swap"),
  notify: $("#notify"), refresh: $("#refresh"), status: $("#status"),
  updated: $("#updated"), departures: $("#departures"), alerts: $("#alerts"),
  empty: $("#empty"), summary: $("#route-summary"), notice: $("#data-notice"),
  commuteMode: $("#commute-mode")
};

const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
})[char]);
const formatTime = (epoch) => epoch ? new Intl.DateTimeFormat([], {
  hour: "numeric",
  minute: "2-digit",
  timeZone: CALTRAIN_TIME_ZONE
}).format(new Date(epoch * 1000)) : "—";
const stopName = (id) => state.data?.stops.find((stop) => stop.id === id)?.name ?? id;

function loadSavedRoute() {
  try { return JSON.parse(localStorage.getItem(ROUTE_KEY) || "null"); } catch { return null; }
}

function saveRoute() {
  localStorage.setItem(ROUTE_KEY, JSON.stringify({ originId: state.originId, destinationId: state.destinationId }));
}

function stopIdByName(name) {
  return state.data?.stops.find((stop) => stop.name.trim().toLowerCase() === name.toLowerCase())?.id ?? null;
}

function resolveWeekdayCommute() {
  const preference = weekdayCommutePreference();
  if (!preference) return null;
  const originId = stopIdByName(preference.originName);
  const destinationId = stopIdByName(preference.destinationName);
  if (!originId || !destinationId) return null;
  return { ...preference, originId, destinationId };
}

function applyWeekdayCommute({ force = false } = {}) {
  const commute = resolveWeekdayCommute();
  if (!commute) {
    if (force) state.autoCommute = false;
    state.commute = null;
    return false;
  }
  if (!force && !state.autoCommute) return false;
  state.autoCommute = true;
  state.commute = commute;
  state.originId = commute.originId;
  state.destinationId = commute.destinationId;
  if (els.origin) els.origin.value = state.originId;
  if (els.destination) els.destination.value = state.destinationId;
  return true;
}

function updateCommuteMode(preferredTrip = null) {
  if (!els.commuteMode) return;
  if (!state.autoCommute || !state.commute) {
    els.commuteMode.hidden = true;
    return;
  }
  const train = preferredTrip?.trainNumber ? ` · Train ${preferredTrip.trainNumber}` : "";
  els.commuteMode.textContent = `Weekday auto-route · ${state.commute.targetLabel}${train}`;
  els.commuteMode.hidden = false;
}

function disableAutoCommute() {
  state.autoCommute = false;
  state.commute = null;
  updateCommuteMode();
}

function fillStops() {
  const options = state.data.stops.map((stop) => `<option value="${escapeHtml(stop.id)}">${escapeHtml(stop.name)}</option>`).join("");
  els.origin.innerHTML = options;
  els.destination.innerHTML = options;
  const ids = new Set(state.data.stops.map((stop) => stop.id));
  const saved = loadSavedRoute();

  if (!applyWeekdayCommute({ force: true })) {
    state.originId = ids.has(saved?.originId) ? saved.originId : (stopIdByName("Millbrae") || state.data.stops[0]?.id || "");
    state.destinationId = ids.has(saved?.destinationId) ? saved.destinationId : (stopIdByName("Hillsdale") || state.data.stops.at(-1)?.id || "");
  }
  if (state.originId === state.destinationId && state.data.stops.length > 1) {
    state.destinationId = state.data.stops.find((stop) => stop.id !== state.originId).id;
  }
  els.origin.value = state.originId;
  els.destination.value = state.destinationId;
  updateCommuteMode();
}

function renderDepartures(trips, preferredTrip = null) {
  const preferredId = preferredTrip?.id;
  els.departures.innerHTML = trips.slice(0, 10).map((trip) => {
    const late = minutesLate(trip, state.originId);
    const origin = trip.stops.find((stop) => stop.id === state.originId);
    const destination = trip.stops.find((stop) => stop.id === state.destinationId);
    const scheduledDeparture = origin?.departureEpoch;
    const actualDeparture = origin?.realtimeDepartureEpoch ?? scheduledDeparture;
    const scheduledArrival = destination?.arrivalEpoch;
    const actualArrival = destination?.realtimeArrivalEpoch ?? scheduledArrival;
    const departed = actualDeparture && actualDeparture < Date.now() / 1000 - 60;
    const selected = trip.id === preferredId;
    const statusText = trip.cancelled ? "Cancelled" : departed ? "Departed" : !snapshotHealth(state.data).realtime || origin?.realtimeDepartureEpoch == null ? "Scheduled" : late > 0 ? `${late} min late` : "On time";
    const pillClass = trip.cancelled ? "cancelled" : late >= 5 ? "delay" : "";
    const preferredLabel = selected ? `<span class="preferred-label">Selected commute · ${escapeHtml(state.commute?.targetLabel || formatTime(scheduledDeparture))}</span>` : "";
    return `<article class="departure ${trip.cancelled ? "cancelled" : ""} ${selected ? "preferred" : ""}" ${selected ? 'aria-current="true"' : ""}>
      ${preferredLabel}
      <div class="departure-top"><div><div class="train-name">Train ${escapeHtml(trip.trainNumber || trip.routeShortName || trip.id)}</div><small>Toward ${escapeHtml(trip.headsign || stopName(state.destinationId))}</small></div><span class="pill ${pillClass}">${statusText}</span></div>
      <div class="departure-times">
        <div class="time-block"><small class="time-role">Depart</small><strong>${formatTime(actualDeparture)}</strong><small>${escapeHtml(stopName(state.originId))}</small></div>
        <div class="route-line"></div>
        <div class="time-block"><small class="time-role">Arrive</small><strong>${formatTime(actualArrival)}</strong><small>${escapeHtml(stopName(state.destinationId))}</small></div>
      </div>
      <div class="departure-meta"><span>Scheduled ${formatTime(scheduledDeparture)} → ${formatTime(scheduledArrival)}</span><span>${trip.cancelled ? "Do not board" : selected ? "Your saved weekday train" : "Upcoming departure"}</span></div>
    </article>`;
  }).join("");
  els.empty.hidden = trips.length > 0;
}

function renderAlerts(alerts) {
  if (!snapshotHealth(state.data).realtime) {
    els.alerts.innerHTML = `<article class="alert-card"><h3>Live alerts unavailable</h3><p>Current delays and cancellations cannot be confirmed. <a href="https://www.caltrain.com/status" target="_blank" rel="noreferrer">Check Caltrain service status</a></p></article>`;
    return;
  }
  if (!alerts.length) {
    els.alerts.innerHTML = `<article class="alert-card"><h3>No relevant active alerts</h3><p>The current feed has no service alert matching your selected route.</p></article>`;
    return;
  }
  els.alerts.innerHTML = alerts.map((alert) => `<article class="alert-card"><h3>${escapeHtml(alert.header || "Caltrain service alert")}</h3><p>${escapeHtml(alert.description || alert.effect?.replaceAll("_", " ") || "See the official alert for details.")}</p>${alert.url ? `<a href="${escapeHtml(alert.url)}" target="_blank" rel="noreferrer">Open official alert</a>` : ""}</article>`).join("");
}

function notifyNew(trips, alerts, force = false) {
  if (!state.data || !snapshotHealth(state.data).realtime) return;
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
  const health = snapshotHealth(state.data);
  const data = snapshotForDisplay(state.data);
  els.status.textContent = health.label;
  els.status.className = `status-badge ${health.realtime ? "live" : "demo"}`;
  const generatedAt = new Date(state.data.generatedAt);
  els.updated.textContent = Number.isFinite(generatedAt.getTime())
    ? `Updated ${new Intl.DateTimeFormat([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: CALTRAIN_TIME_ZONE }).format(generatedAt)}`
    : "Update time unavailable";
  els.notice.hidden = !health.notice;
  els.notice.textContent = health.notice;
  els.empty.querySelector("h3").textContent = health.currentServiceDate
    ? "No more matching trains in this snapshot."
    : "Today's train schedule is unavailable.";
  els.empty.querySelector("p").textContent = health.currentServiceDate
    ? "Try swapping direction or refresh after the next data update."
    : "Updates have stopped. Use the official Caltrain schedule until they resume.";
  applyWeekdayCommute();
  const allTrips = routeTrips(data, state.originId, state.destinationId);
  const upcomingTrips = matchingTrips(data, state.originId, state.destinationId);
  const preferredTrip = state.commute
    ? preferredTripForDeparture(allTrips, state.originId, state.commute.targetMinutes)
    : null;
  const displayTrips = preferredTrip
    ? [preferredTrip, ...upcomingTrips.filter((trip) => trip.id !== preferredTrip.id)]
    : upcomingTrips;
  const alerts = relevantAlerts(data, state.originId, state.destinationId, allTrips);
  els.summary.textContent = `${stopName(state.originId)} → ${stopName(state.destinationId)}`;
  updateCommuteMode(preferredTrip);
  renderDepartures(displayTrips, preferredTrip);
  renderAlerts(alerts);
  saveRoute();
  if (notify) notifyNew(allTrips, alerts);
}

let loading = false;
async function loadData({ initial = false } = {}) {
  if (loading) return;
  loading = true;
  els.refresh.disabled = true;
  try {
    const response = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: "no-store", signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const first = !state.data;
    state.data = await response.json();
    if (first || initial) fillStops();
    render();
  } catch (error) {
    if (state.data) render({ notify: false });
    els.status.textContent = "Data unavailable";
    els.status.className = "status-badge demo";
    els.updated.textContent = error.message;
    els.notice.hidden = false;
    els.notice.textContent = "Could not fetch the latest snapshot. Check Caltrain for current service.";
  } finally { els.refresh.disabled = false; loading = false; }
}

els.origin.addEventListener("change", () => { disableAutoCommute(); state.originId = els.origin.value; render({ notify: false }); });
els.destination.addEventListener("change", () => { disableAutoCommute(); state.destinationId = els.destination.value; render({ notify: false }); });
els.swap.addEventListener("click", () => { disableAutoCommute(); [state.originId, state.destinationId] = [state.destinationId, state.originId]; els.origin.value = state.originId; els.destination.value = state.destinationId; render({ notify: false }); });
els.refresh.addEventListener("click", () => loadData());
els.notify.addEventListener("click", async () => {
  if (!("Notification" in window)) { els.notify.textContent = "Notifications unsupported"; return; }
  const permission = await Notification.requestPermission();
  els.notify.textContent = permission === "granted" ? "Cancellation alerts enabled" : "Enable cancellation alerts";
  if (permission === "granted") {
    if (!state.data) return;
    const trips = routeTrips(state.data, state.originId, state.destinationId);
    notifyNew(trips, relevantAlerts(state.data, state.originId, state.destinationId, trips), true);
  }
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js");
loadData({ initial: true });
setInterval(() => { if (!document.hidden) loadData(); }, 60_000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) loadData(); });
