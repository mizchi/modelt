import type { SimulationHost } from "../../src/contracts.js";

export const exerciseHost = (host: SimulationHost) => {
  host.write("counter", 1);
  host.persist();
  host.write("counter", 2);
  const nonce = host.choose("nonce", ["x", "y"]);
  host.send("a", "b", { value: 1, nonce });
  host.send("b", "a", { value: 2, nonce });
  const delivery = host.deliver(host.choose("delivery", [0, 1]));
  host.drop(0);
  host.advance(10);
  host.crash();
  host.restart();
  const snapshot = {
    clock: host.now(),
    durable: host.read("counter"),
    pending: host.pending(),
    delivery,
  };
  host.finish();
  return snapshot;
};
