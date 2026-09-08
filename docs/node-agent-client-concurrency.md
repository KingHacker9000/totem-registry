# Node-agent client concurrency boundary

`NodeAgentClient` bounds aggregate outbound request fan-out with `maxConcurrentRequests`.

- The default limit is 8 concurrent requests per client instance.
- The option must be a positive safe integer.
- Admission is fail-fast: when all slots are in use, the request is rejected before `fetch` with code `node_agent_overloaded` and the stable message `node agent client request limit reached`.
- A slot covers the full fetch plus bounded response-body read/parse path, not only connection establishment.
- Capacity is released in a `finally` path after success, structured remote failure, transport failure, response validation failure, or timeout.
- The existing per-request timeout and response-byte limit remain independent controls; concurrency bounds aggregate fan-out while those limits bound each admitted request.

This is a local resource-safety boundary, not authorization. Callers must still apply Totem's capability and permission policy before invoking a remote node.
