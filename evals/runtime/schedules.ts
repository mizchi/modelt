export const enumerateSchedules = (
  operations: number,
  maxDepth: number,
  maxNodes: number,
): {
  readonly orders: readonly (readonly number[])[];
  readonly nodes: number;
  readonly bounded: boolean;
} => {
  if (
    !Number.isSafeInteger(operations) ||
    operations < 1 ||
    !Number.isSafeInteger(maxDepth) ||
    maxDepth < 0 ||
    !Number.isSafeInteger(maxNodes) ||
    maxNodes < 1
  )
    throw new RangeError("Invalid schedule bounds");
  const orders: number[][] = [];
  let nodes = 0;
  let bounded = false;
  const visit = (
    progress: readonly number[],
    ids: readonly number[],
    nextId: number,
    order: readonly number[],
  ) => {
    if (nodes === maxNodes) {
      bounded = true;
      return;
    }
    nodes++;
    if (order.length === operations * 2) {
      orders.push([...order]);
      return;
    }
    if (order.length === maxDepth) {
      bounded = true;
      return;
    }
    for (let operation = 0; operation < operations; operation++) {
      const phase = progress[operation];
      const id = ids[operation];
      if (phase === undefined || id === undefined || phase === 2) continue;
      const updated = [...progress];
      updated[operation] = phase + 1;
      const updatedIds = [...ids];
      if (phase === 0) updatedIds[operation] = nextId;
      visit(updated, updatedIds, phase === 0 ? nextId + 1 : nextId, [
        ...order,
        id,
      ]);
    }
  };
  visit(
    Array.from({ length: operations }, () => 0),
    Array.from({ length: operations }, (_, index) => index + 1),
    operations + 1,
    [],
  );
  return { orders, nodes, bounded };
};
