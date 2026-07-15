export const CALTRAIN_TIME_ZONE = "America/Los_Angeles";

export function stopIndex(trip, stopId) {
  return trip.stops.findIndex((stop) => stop.id === stopId);
}

export function tripServesRoute(trip, originId, destinationId) {
  if (!originId || !destinationId || originId === destinationId) return false;
  const originIndex = stopIndex(trip, originId);
  const destinationIndex = stopIndex(trip, destinationId);
  return originIndex >= 0 && destinationIndex > originIndex;
}

export function tripTimeAtStop(trip, stopId, kind = "departure", realtime = true) {
  const stop = trip.stops.find((candidate) => candidate.id === stopId);
  if (!stop) return null;
  const realtimeKey = kind === "arrival" ? "realtimeArrivalEpoch" : "realtimeDepartureEpoch";
  const scheduledKey = kind === "arrival" ? "arrivalEpoch" : "departureEpoch";
  return realtime ? (stop[realtimeKey] ?? stop[scheduledKey] ?? null) : (stop[scheduledKey] ?? null);
}

export function routeTrips(data, originId, destinationId) {
  return data.trips
    .filter((trip) => tripServesRoute(trip, originId, destinationId))
    .map((trip) => ({
      ...trip,
      originTime: tripTimeAtStop(trip, originId, "departure"),
      destinationTime: tripTimeAtStop(trip, destinationId, "arrival"),
      scheduledOriginTime: tripTimeAtStop(trip, originId, "departure", false),
      scheduledDestinationTime: tripTimeAtStop(trip, destinationId, "arrival", false)
    }))
    .sort((a, b) => a.scheduledOriginTime - b.scheduledOriginTime);
}

export function matchingTrips(data, originId, destinationId, nowEpoch = Date.now() / 1000) {
  return routeTrips(data, originId, destinationId)
    .filter((trip) => trip.originTime && trip.originTime >= nowEpoch - 300)
    .sort((a, b) => a.originTime - b.originTime);
}

function zonedClockParts(at, timeZone = CALTRAIN_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(at);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

export function weekdayCommutePreference(at = new Date(), timeZone = CALTRAIN_TIME_ZONE) {
  const parts = zonedClockParts(at, timeZone);
  if (parts.weekday === "Sat" || parts.weekday === "Sun") return null;
  const morning = Number(parts.hour) < 12;
  return morning
    ? {
        period: "morning",
        originName: "Millbrae",
        destinationName: "Hillsdale",
        targetMinutes: 8 * 60 + 7,
        targetLabel: "8:07 AM"
      }
    : {
        period: "evening",
        originName: "Hillsdale",
        destinationName: "Millbrae",
        targetMinutes: 16 * 60 + 56,
        targetLabel: "4:56 PM"
      };
}

export function scheduledMinutesAtStop(trip, stopId, timeZone = CALTRAIN_TIME_ZONE) {
  const epoch = tripTimeAtStop(trip, stopId, "departure", false);
  if (!epoch) return null;
  const parts = zonedClockParts(new Date(epoch * 1000), timeZone);
  return Number(parts.hour) * 60 + Number(parts.minute);
}

export function preferredTripForDeparture(trips, originId, targetMinutes, timeZone = CALTRAIN_TIME_ZONE) {
  return trips.find((trip) => scheduledMinutesAtStop(trip, originId, timeZone) === targetMinutes) ?? null;
}

export function relevantAlerts(data, originId, destinationId, trips) {
  const selectedStops = new Set([originId, destinationId].filter(Boolean));
  const tripIds = new Set(trips.map((trip) => trip.id));
  return data.alerts.filter((alert) => {
    const noTarget = !alert.stopIds.length && !alert.tripIds.length && !alert.routeIds.length;
    const stopMatch = alert.stopIds.some((id) => selectedStops.has(id));
    const tripMatch = alert.tripIds.some((id) => tripIds.has(id));
    const routeMatch = alert.routeIds.some((id) => trips.some((trip) => trip.routeId === id));
    return noTarget || stopMatch || tripMatch || routeMatch;
  });
}

export function minutesLate(trip, originId) {
  const stop = trip.stops.find((candidate) => candidate.id === originId);
  if (!stop) return 0;
  const scheduled = stop.departureEpoch;
  const realtime = stop.realtimeDepartureEpoch ?? scheduled;
  return Math.round((realtime - scheduled) / 60);
}
