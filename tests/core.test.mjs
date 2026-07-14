import test from "node:test";
import assert from "node:assert/strict";
import { matchingTrips, minutesLate, relevantAlerts, tripServesRoute } from "../public/core.mjs";

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
