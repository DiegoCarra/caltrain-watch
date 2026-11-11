import test from "node:test";
import assert from "node:assert/strict";
import {
  matchingTrips,
  minutesLate,
  preferredTripForDeparture,
  relevantAlerts,
  routeTrips,
  serviceDateAt,
  snapshotForDisplay,
  snapshotHealth,
  tripServesRoute,
  weekdayCommutePreference
} from "../public/core.mjs";

const trip = {
  id: "T1", routeId: "R1", cancelled: false,
  stops: [
    { id: "A", departureEpoch: 1000, realtimeDepartureEpoch: 1300 },
    { id: "B", arrivalEpoch: 1600, departureEpoch: 1610 },
    { id: "C", arrivalEpoch: 2200, departureEpoch: 2210 }
  ]
};

test("tripServesRoute requires forward stop order", () => {
  assert.equal(tripServesRoute(trip, "A", "C"), true);
  assert.equal(tripServesRoute(trip, "C", "A"), false);
  assert.equal(tripServesRoute(trip, "A", "A"), false);
});

test("matchingTrips uses realtime departure and sorts", () => {
  const later = structuredClone(trip);
  later.id = "T2";
  later.stops[0].realtimeDepartureEpoch = 1500;
  assert.deepEqual(matchingTrips({ trips: [later, trip] }, "A", "C", 900).map((item) => item.id), ["T1", "T2"]);
});

test("routeTrips includes scheduled and realtime endpoint times", () => {
  const [mapped] = routeTrips({ trips: [trip] }, "A", "C");
  assert.equal(mapped.originTime, 1300);
  assert.equal(mapped.scheduledOriginTime, 1000);
  assert.equal(mapped.scheduledDestinationTime, 2200);
});

test("weekday commute chooses morning and afternoon directions", () => {
  assert.deepEqual(weekdayCommutePreference(new Date("2026-07-15T08:00:00-07:00")), {
    period: "morning", originName: "Millbrae", destinationName: "Hillsdale", targetMinutes: 487, targetLabel: "8:07 AM"
  });
  assert.deepEqual(weekdayCommutePreference(new Date("2026-07-15T16:00:00-07:00")), {
    period: "evening", originName: "Hillsdale", destinationName: "Millbrae", targetMinutes: 1016, targetLabel: "4:56 PM"
  });
  assert.equal(weekdayCommutePreference(new Date("2026-07-18T08:00:00-07:00")), null);
});

test("preferred trip selects the exact scheduled departure", () => {
  const epoch = (value) => Date.parse(value) / 1000;
  const trips = [
    { id: "early", stops: [{ id: "M", departureEpoch: epoch("2026-07-15T08:02:00-07:00") }] },
    { id: "preferred", stops: [{ id: "M", departureEpoch: epoch("2026-07-15T08:07:00-07:00") }] }
  ];
  assert.equal(preferredTripForDeparture(trips, "M", 487)?.id, "preferred");
});

test("minutesLate rounds delay", () => assert.equal(minutesLate(trip, "A"), 5));

const snapshot = {
  mode: "live", generatedAt: "2026-11-10T16:00:00-08:00", serviceDate: "2026-11-10",
  trips: [{ ...trip, cancelled: true }], alerts: [{ id: "old-alert" }]
};

test("freshness uses Pacific dates even across UTC midnight", () => {
  const at = new Date("2026-11-11T00:05:00Z");
  assert.equal(serviceDateAt(at), "2026-11-10");
  assert.equal(snapshotHealth(snapshot, at).realtime, true);
  assert.equal(snapshotForDisplay(snapshot, at), snapshot);
});

test("same-day stale snapshots keep schedule but remove live status", () => {
  const at = new Date("2026-11-10T16:16:00-08:00");
  const health = snapshotHealth(snapshot, at);
  assert.equal(health.stale, true);
  assert.equal(health.realtime, false);
  const display = snapshotForDisplay(snapshot, at);
  assert.equal(display.trips[0].cancelled, false);
  assert.equal(display.trips[0].stops[0].realtimeDepartureEpoch, null);
  assert.equal(display.trips[0].stops[0].departureEpoch, 1000);
  assert.deepEqual(display.alerts, []);
  assert.equal(snapshot.trips[0].cancelled, true, "source is unchanged");
});

test("old service dates cannot display historical preferred trains", () => {
  const at = new Date("2026-11-11T08:00:00-08:00");
  const display = snapshotForDisplay(snapshot, at);
  assert.deepEqual(display.trips, []);
  assert.deepEqual(display.alerts, []);
  assert.match(snapshotHealth(snapshot, at).notice, /earlier service date/);
});

test("a date rollover marks even a recently generated snapshot stale", () => {
  const nearMidnight = { ...snapshot, generatedAt: "2026-11-10T23:59:00-08:00" };
  assert.equal(snapshotHealth(nearMidnight, new Date("2026-11-11T00:01:00-08:00")).stale, true);
});

test("schedule-only data never claims live status", () => {
  const health = snapshotHealth({ ...snapshot, mode: "schedule" }, new Date("2026-11-10T16:05:00-08:00"));
  assert.equal(health.realtime, false);
  assert.equal(health.label, "Schedule only");
});

test("invalid or future generation timestamps cannot claim to be live", () => {
  const at = new Date("2026-11-10T16:05:00-08:00");
  assert.equal(snapshotHealth({ ...snapshot, generatedAt: "bad" }, at).realtime, false);
  assert.equal(snapshotHealth({ ...snapshot, generatedAt: "2026-11-10T17:00:00-08:00" }, at).realtime, false);
});

test("relevantAlerts matches stop, route, or systemwide alerts", () => {
  const data = { alerts: [
    { id: "stop", stopIds: ["A"], tripIds: [], routeIds: [] },
    { id: "route", stopIds: [], tripIds: [], routeIds: ["R1"] },
    { id: "other", stopIds: ["Z"], tripIds: [], routeIds: [] },
    { id: "all", stopIds: [], tripIds: [], routeIds: [] }
  ] };
  assert.deepEqual(relevantAlerts(data, "A", "C", [trip]).map((alert) => alert.id), ["stop", "route", "all"]);
});
