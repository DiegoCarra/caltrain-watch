export function stopIndex(trip, stopId) {
  return trip.stops.findIndex((stop) => stop.id === stopId);
}

export function tripServesRoute(trip, originId, destinationId) {
  if (!originId || !destinationId || originId === destinationId) return false;
  const originIndex = stopIndex(trip, originId);
  const destinationIndex = stopIndex(trip, destinationId);
  return originIndex >= 0 && destinationIndex > originIndex;
}

export function tripTimeAtStop(trip, stopId, kind = "departure") {
  const stop = trip.stops.find((candidate) => candidate.id === stopId);
  if (!stop) return null;
  const realtimeKey = kind === "arrival" ? "realtimeArrivalEpoch" : "realtimeDepartureEpoch";
  const scheduledKey = kind === "arrival" ? "arrivalEpoch" : "departureEpoch";
  return stop[realtimeKey] ?? stop[scheduledKey] ?? null;
}

export function matchingTrips(data, originId, destinationId, nowEpoch = Date.now() / 1000) {
  return data.trips
    .filter((trip) => tripServesRoute(trip, originId, destinationId))
    .map((trip) => ({
      ...trip,
      originTime: tripTimeAtStop(trip, originId, "departure"),
      destinationTime: tripTimeAtStop(trip, destinationId, "arrival")
    }))
    .filter((trip) => trip.originTime && trip.originTime >= nowEpoch - 300)
    .sort((a, b) => a.originTime - b.originTime);
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
