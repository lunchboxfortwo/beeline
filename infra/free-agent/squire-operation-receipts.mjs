// Runs inside the one host broker. Receipts belong to that broker process;
// reconnecting a facade reads them and never starts another browser.
const operations = new Map();
export async function ownedSquireCall(agentId, request, invoke) {
  const operationId = request.params?._meta?.beelineOperationId;
  const read = request.params?.name === 'beeline_read_operation';
  const id = read ? request.params?.arguments?.operationId : operationId;
  if (typeof agentId !== 'string' || typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) {
    if (read) return receipt({ outcome: 'unknown', accepted: null, completed: false });
    return invoke();
  }
  const key = JSON.stringify([agentId, id]);
  const existing = operations.get(key);
  if (read) {
    if (!existing)
      return receipt({ operationId: id, outcome: 'unknown', accepted: null, completed: false });
    return receipt(await existing);
  }
  if (existing) return (await existing).result;
  let finish;
  const result = new Promise((resolve) => {
    finish = resolve;
  });
  operations.set(key, result); // acceptance precedes invocation, including a synchronous throw
  try {
    const value = await invoke();
    finish({
      operationId: id,
      outcome: 'completed',
      accepted: true,
      completed: true,
      result: value,
    });
    return value;
  } catch {
    finish({
      operationId: id,
      outcome: 'unknown',
      accepted: true,
      completed: false,
      cause: 'broker-operation-lost',
    });
    throw new Error('Squire operation outcome is unknown; read its receipt, do not repeat it');
  }
}
function receipt(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}
