const DATA_URL = '../data/caltrain.json';
const REPORTS_URL = './reports.json';
const REPORT_REPO = 'DiegoCarra/caltrain-watch';
const REPORT_MARKER = '<!-- why-caltrain-late-report:v1 -->';

const $ = (selector) => document.querySelector(selector);
const incidentTemplate = $('#incident-template');
const list = $('#incident-list');
const emptyState = $('#empty-state');
const notice = $('#data-notice');
let data = { stops: [], trips: [], alerts: [], generatedAt: null, mode: 'unknown' };
let reports = { incidents: [], reportCount: 0, generatedAt: null };

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function minutes(value) { return Number.isFinite(value) ? Math.round(value / 60) : null; }
function ageLabel(iso) {
  const time = Date.parse(iso || '');
  if (!Number.isFinite(time)) return 'unknown';
  const mins = Math.max(0, Math.round((Date.now() - time) / 60000));
  if (mins < 1) return '<1m';
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}
function formatClock(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return 'recently';
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(t);
}
function directionName(trip) {
  const first = trip?.stops?.[0]?.name || '';
  const last = trip?.stops?.at(-1)?.name || '';
  if (/san francisco/i.test(last)) return 'northbound';
  if (/san jose|tamien|gilroy/i.test(last)) return 'southbound';
  return first && last ? `toward ${last}` : 'unknown direction';
}
function officialDelay(trip) {
  if (!trip?.stops?.length) return 0;
  const now = Date.now() / 1000;
  const candidates = trip.stops.filter((stop) => stop.departureEpoch <= now + 3600 && stop.departureEpoch >= now - 10800);
  const stops = candidates.length ? candidates : trip.stops;
  const delays = [];
  for (const stop of stops) {
    const live = stop.realtimeDepartureEpoch ?? stop.realtimeArrivalEpoch;
    const scheduled = stop.realtimeDepartureEpoch != null ? stop.departureEpoch : stop.arrivalEpoch;
    if (live && scheduled) delays.push(live - scheduled);
  }
  return Math.max(0, minutes(Math.max(0, ...delays)) || 0);
}
function activeTrip(trip) {
  const now = Date.now() / 1000;
  const start = trip?.stops?.[0]?.departureEpoch ?? Infinity;
  const end = trip?.stops?.at(-1)?.arrivalEpoch ?? -Infinity;
  return now >= start - 3600 && now <= end + 7200;
}
function matchedIncident(trainNumber) {
  return reports.incidents?.find((item) => String(item.trainNumber) === String(trainNumber));
}
function officialAlertsFor(trip) {
  return (data.alerts || []).filter((alert) => {
    if (alert.tripIds?.includes(trip.id)) return true;
    if (alert.routeIds?.includes(trip.routeId)) return true;
    return false;
  });
}
function createViewModels() {
  const byTrain = new Map();
  for (const trip of data.trips || []) {
    if (!activeTrip(trip)) continue;
    const delay = officialDelay(trip);
    const crowd = matchedIncident(trip.trainNumber);
    const alerts = officialAlertsFor(trip);
    if (delay < 5 && !trip.cancelled && !crowd && alerts.length === 0) continue;
    byTrain.set(String(trip.trainNumber), {
      trainNumber: String(trip.trainNumber), trip, direction: directionName(trip), officialDelayMinutes: delay,
      crowdDelayMinutes: crowd?.crowdDelayMinutes ?? null, reason: crowd?.reason || (trip.cancelled ? 'Train cancelled' : alerts[0]?.header || 'Delayed — cause not yet confirmed'),
      summary: crowd?.summary || (alerts[0]?.description || 'Official real-time data shows a delay, but there is not enough evidence yet to explain the cause.'),
      confidence: crowd?.confidence ?? (alerts.length ? 0.55 : 0.2), reports: crowd?.reports || [], officialAlerts: crowd?.officialAlerts?.length ? crowd.officialAlerts : alerts.map(a => ({ header: a.header, description: a.description })),
      consensusCount: crowd?.consensusCount || 0, station: crowd?.station || null, category: crowd?.category || null,
    });
  }
  for (const crowd of reports.incidents || []) {
    const key = String(crowd.trainNumber);
    if (byTrain.has(key)) continue;
    byTrain.set(key, { trainNumber: key, trip: null, direction: crowd.direction || 'unknown direction', officialDelayMinutes: crowd.officialDelayMinutes ?? 0, crowdDelayMinutes: crowd.crowdDelayMinutes ?? null, reason: crowd.reason, summary: crowd.summary, confidence: crowd.confidence, reports: crowd.reports || [], officialAlerts: crowd.officialAlerts || [], consensusCount: crowd.consensusCount || 0, station: crowd.station || null, category: crowd.category || null });
  }
  return [...byTrain.values()].sort((a, b) => Math.max(b.crowdDelayMinutes || 0, b.officialDelayMinutes || 0) - Math.max(a.crowdDelayMinutes || 0, a.officialDelayMinutes || 0));
}
function confidenceText(score) {
  if (score >= .8) return `high confidence · ${Math.round(score * 100)}%`;
  if (score >= .5) return `medium confidence · ${Math.round(score * 100)}%`;
  return `low confidence · ${Math.round(score * 100)}%`;
}
function evidenceNode(label, text, time) {
  const row = document.createElement('div');
  row.className = 'evidence-item';
  const when = document.createElement('time');
  when.textContent = time || 'now';
  const body = document.createElement('p');
  const source = document.createElement('span');
  source.className = 'evidence-source';
  source.textContent = `${label}: `;
  body.append(source, document.createTextNode(text));
  row.append(when, body);
  return row;
}
function render() {
  const search = $('#train-search').value.trim().toLowerCase();
  const direction = $('#direction-filter').value;
  const items = createViewModels().filter((item) => {
    if (search && !item.trainNumber.toLowerCase().includes(search)) return false;
    if (direction !== 'all' && item.direction !== direction) return false;
    return true;
  });
  list.replaceChildren();
  emptyState.hidden = items.length > 0;
  for (const item of items) {
    const card = incidentTemplate.content.firstElementChild.cloneNode(true);
    card.querySelector('.train-number').textContent = `Train ${item.trainNumber}`;
    card.querySelector('.direction').textContent = item.direction;
    const bestDelay = item.crowdDelayMinutes ?? item.officialDelayMinutes;
    card.querySelector('.delay-chip').textContent = bestDelay ? `~${bestDelay} min late` : 'service disruption';
    card.querySelector('.reason').textContent = item.reason;
    card.querySelector('.summary').textContent = item.summary;
    const comparison = card.querySelector('.comparison');
    if (item.officialDelayMinutes != null) {
      const pill = document.createElement('span'); pill.className = 'fact-pill official'; pill.textContent = `Official feed: ${item.officialDelayMinutes} min`; comparison.append(pill);
    }
    if (item.crowdDelayMinutes != null) {
      const pill = document.createElement('span'); pill.className = 'fact-pill crowd'; pill.textContent = `Riders: ${item.crowdDelayMinutes} min`; comparison.append(pill);
    }
    if (item.station) {
      const pill = document.createElement('span'); pill.className = 'fact-pill'; pill.textContent = `Near ${item.station}`; comparison.append(pill);
    }
    if (item.consensusCount) {
      const pill = document.createElement('span'); pill.className = 'fact-pill crowd'; pill.textContent = `${item.consensusCount} agreeing report${item.consensusCount === 1 ? '' : 's'}`; comparison.append(pill);
    }
    const score = clamp(Number(item.confidence) || 0, 0, 1);
    card.querySelector('.confidence-label').textContent = confidenceText(score);
    card.querySelector('.confidence-fill').style.width = `${Math.round(score * 100)}%`;
    const evidence = card.querySelector('.evidence');
    for (const alert of item.officialAlerts || []) evidence.append(evidenceNode('Official', alert.header || alert.description || 'Service alert', 'feed'));
    for (const report of item.reports || []) {
      const source = (report.sourceLabel || 'Rider').replace(/\s+/g, ' ');
      const text = report.details || `${report.categoryLabel || 'Delay'} reported at ${report.station || 'an unknown location'}`;
      evidence.append(evidenceNode(source, text, formatClock(report.observedAt || report.createdAt)));
    }
    if (!evidence.childElementCount) evidence.append(evidenceNode('Status', 'No cause evidence yet. This is only a timing signal.', 'feed'));
    const toggle = card.querySelector('.evidence-toggle');
    toggle.addEventListener('click', () => {
      const opening = evidence.hidden;
      evidence.hidden = !opening;
      toggle.setAttribute('aria-expanded', String(opening));
      toggle.textContent = opening ? 'Hide evidence' : 'Show evidence';
    });
    list.append(card);
  }
  $('#active-count').textContent = String(items.length);
  $('#report-count').textContent = String(reports.reportCount || 0);
  $('#last-updated').textContent = ageLabel(data.generatedAt);
  $('#feed-freshness').textContent = `official feed ${ageLabel(data.generatedAt)} old`;
}
function populateStations() {
  const datalist = $('#station-options');
  datalist.replaceChildren(...(data.stops || []).map((stop) => {
    const option = document.createElement('option'); option.value = stop.name; return option;
  }));
}
function cleanMultiline(value) { return String(value || '').replace(/\r/g, '').trim().slice(0, 500); }
function issueUrl(form) {
  const train = form.get('train').trim();
  const station = form.get('station').trim();
  const category = form.get('category');
  const source = form.get('source');
  const rawDelay = form.get('delay');
  const delay = rawDelay === '' ? '' : String(clamp(Number(rawDelay), 0, 360));
  const details = cleanMultiline(form.get('details'));
  const observedAt = new Date().toISOString();
  const body = [
    REPORT_MARKER,
    `Train: ${train}`,
    `Station: ${station}`,
    `Category: ${category}`,
    `Source: ${source}`,
    `Delay minutes: ${delay}`,
    `Observed at: ${observedAt}`,
    '',
    'Details:',
    details || '(none)',
    '',
    '_Submitted from the rider report form. Please do not add personally identifying information._'
  ].join('\n');
  const title = `[rider report] Train ${train} — ${station}`;
  const query = new URLSearchParams({ title, body });
  return `https://github.com/${REPORT_REPO}/issues/new?${query.toString()}`;
}
async function load() {
  try {
    const [officialResponse, reportResponse] = await Promise.all([fetch(DATA_URL, { cache: 'no-store' }), fetch(REPORTS_URL, { cache: 'no-store' })]);
    if (!officialResponse.ok) throw new Error(`official feed returned ${officialResponse.status}`);
    data = await officialResponse.json();
    if (reportResponse.ok) reports = await reportResponse.json();
    populateStations();
    if (data.mode !== 'live') {
      notice.hidden = false;
      notice.textContent = 'Official live data is unavailable, so the site is showing fallback data. Rider reports may still be current.';
    }
    render();
  } catch (error) {
    notice.hidden = false;
    notice.textContent = `Could not load the latest delay feed: ${error.message}`;
    render();
  }
}
$('#train-search').addEventListener('input', render);
$('#direction-filter').addEventListener('change', render);
$('#report-top').addEventListener('click', () => { $('#report-panel').scrollIntoView({ behavior: 'smooth', block: 'start' }); $('#report-train').focus({ preventScroll: true }); });
$('#report-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const train = String(form.get('train') || '').trim();
  const station = String(form.get('station') || '').trim();
  const category = String(form.get('category') || '');
  const source = String(form.get('source') || '');
  if (!/^\d{1,6}$/.test(train)) { $('#form-status').textContent = 'Enter the train number shown in the schedule or on the train.'; return; }
  if (!station || !category || !source) { $('#form-status').textContent = 'Train, station, cause, and evidence source are required.'; return; }
  const url = issueUrl(form);
  const opened = window.open(url, '_blank', 'noopener,noreferrer');
  if (!opened) window.location.href = url;
  $('#form-status').textContent = 'GitHub opened with your report pre-filled. Submit it there to publish it.';
});
load();
