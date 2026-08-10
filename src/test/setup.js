import { mock } from "bun:test";

mock.module("https://esm.sh/bitecs@0.4.0", () => {
  let eids = 1;
  return {
    createWorld: () => ({}),
    addEntity: () => eids++,
    removeEntity: () => {},
    addComponent: () => {},
    observe: () => {},
    onRemove: () => {},
    query: () => [],
  };
});
