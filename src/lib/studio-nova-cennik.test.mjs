import assert from "node:assert/strict";
import test from "node:test";
import { pobierzCennikUslug } from "./studio-nova-cennik.ts";

test("returns only confirmed consultation details from the local price file", () => {
  assert.deepEqual(pobierzCennikUslug({ usluga: "konsultacja online" }), {
    usluga: "konsultacja online",
    czasTrwania: "45 minut",
    cena: "150 zł brutto",
  });
});

test("rejects unconfirmed services and additional tool parameters", () => {
  assert.throws(() => pobierzCennikUslug({ usluga: "inna usługa" }));
  assert.throws(() => pobierzCennikUslug({ usluga: "konsultacja online", rabat: true }));
});
