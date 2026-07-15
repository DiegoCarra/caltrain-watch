import test from "node:test";
import assert from "node:assert/strict";
import {
  matchingTrips,
  minutesLate,
  preferredTripForDeparture,
  relevantAlerts,
  routeTrips,
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

test("relevantAlerts matches stop, route, or systemwide alerts", () => {
  const data = { alerts: [
    { id: "stop", stopIds: ["A"], tripIds: [], routeIds: [] },
    { id: "route", stopIds: [], tripIds: [], routeIds: ["R1"] },
    { id: "other", stopIds: ["Z"], tripIds: [], routeIds: [] },
    { id: "all", stopIds: [], tripIds: [], routeIds: [] }
  ] };
  assert.deepEqual(relevantAlerts(data, "A", "C", [trip]).map((alert) => alert.id), ["stop", "route", "all"]);
});
