# Node-agent client redirect boundary

`NodeAgentClient` treats the configured `baseUrl` as the complete endpoint trust boundary. Requests use Fetch's `redirect: "manual"` mode and reject every HTTP 3xx response with the stable `node_agent_redirect` error before response-body parsing.

This applies to health, descriptor, and invoke requests. In particular, an invoke POST body is never automatically replayed to a redirect target, including a different origin. Redirect rejection preserves the existing per-request timeout, response-byte ceiling, request serialization limit, transport-error normalization, and outbound concurrency bound.

Callers that intend to move a node agent to a different endpoint must explicitly construct/configure the client with that endpoint rather than relying on server-driven redirects.
